/* scanner.js — 目录枚举 + 增量比对（只读元数据）+ 按需生成缩略图
 *
 * 扫描策略：只读文件信息 + 尺寸（解析文件头，不解码像素），秒级完成。
 * 缩略图/大图按需生成：视图滚动到该图、或打开 Lightbox 时才解码，生成后入库缓存。
 *
 * v4：元数据与 Blob 分离存储（photos / assets），并加了内存 LRU，
 *     避免每次重绘都去 IndexedDB 取一遍缩略图。
 */
'use strict';

const SCAN = (() => {
  const IMG_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'heic', 'heif', 'tif', 'tiff']);
  const THUMB_MAX = 640;      // 缩略图长边（网格用）
  const THUMB_QUAL = 0.8;
  const PREVIEW_QUAL = 0.86;
  const PREVIEW_MIN_LONG = 1280;  // 预览长边下限（低分屏也不至于生成过小的图）
  const PREVIEW_HARD_LONG = 6144; // 安全阀：8K 级屏幕也不生成超大图，避免解码/编码与内存失控
  const LAZY_CONCURRENCY = 3;     // 同时解码的图片数
  const MEM_MAX = 400;            // 内存里最多留多少张的 Blob

  let _rawEnabled = false;

  function setRawEnabled(v) { _rawEnabled = !!v; }

  /* dirId -> 目录记录。扫描开始、目录增删、可读性变化时失效。
   * 缓存的是整条记录：里面有本机路径，拼绝对路径和查目录都要用它。 */
  let _dirCache = null;
  function resetDirCache() { _dirCache = null; }

  /* ---- 内存 LRU：最近用过的缩略图/大图，避免重绘时反复读库 ---- */
  const _mem = new Map();   // id -> { thumb, preview }
  function memGet(id) {
    const v = _mem.get(id);
    if (!v) return null;
    _mem.delete(id); _mem.set(id, v);   // 提到末尾 = 最近使用
    return v;
  }
  function memSet(id, v) {
    if (_mem.has(id)) _mem.delete(id);
    _mem.set(id, v);
    while (_mem.size > MEM_MAX) {
      const k = _mem.keys().next().value;
      _mem.delete(k);
    }
  }
  /* 同步取已缓存的缩略图：视图首帧能直接显示，不必等异步 */
  function thumbSync(p) {
    const v = _mem.get(p.id);
    return v && v.thumb ? v.thumb : null;
  }
  function previewSync(p) {
    const v = _mem.get(p.id);
    return v && v.preview ? v.preview : null;
  }
  /* 清空内存缓存：修复/重建后必须清，否则视图仍拿旧结论认为"已缓存" */
  function clearMem() { _mem.clear(); }

  /* 最近一次落库失败（最常见是存储配额耗尽）。
   * 以前这里被静默吞掉，导致「内存里有图、库里没有、记录却写着 ready」，
   * 刷新后照片永久空白且无人知晓。 */
  let _storageError = null;
  function storageError() { return _storageError; }
  function clearStorageError() { _storageError = null; }

  /* ---- 预览目标尺寸：按当前屏幕的物理分辨率决定 ----
   * 逻辑：长边超过屏幕物理长边的照片才需要降采样预览；不超过的直接显示原图。
   * 屏幕物理长边 = screen 的 CSS 像素 × devicePixelRatio。
   * 预览长边上限不再固定为 4096，而是直接跟随屏幕（例如 3440×1440 屏幕 → 3440），
   * 既保证全屏 1:1 清晰，又不为用不到的像素多付出一次大图解码。 */
  let _previewLong = 0;
  function previewTargetLong() {
    if (_previewLong) return _previewLong;
    try {
      const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
      const scr = window.screen || {};
      const sw = scr.width || 1920, sh = scr.height || 1080;
      const screenLong = Math.round(Math.max(sw, sh) * dpr);   // 屏幕物理长边
      _previewLong = Math.min(Math.max(screenLong, PREVIEW_MIN_LONG), PREVIEW_HARD_LONG);
    } catch (e) {
      _previewLong = 1920;
    }
    return _previewLong;
  }

  /* ---- 磁盘访问一律走 js/platform.js ----
   * 本文件不直接碰 fs/IPC，也不拼绝对路径：
   * 选目录、枚举、读文件、查目录是否可读，全部由那一层收口。 */
  async function dirPermission(dir) {
    try { return await PLATFORM.queryPermission(dir); }
    catch (e) { return 'denied'; }
  }

  function resolveFile(dir, relPath) {
    return PLATFORM.resolveFile(dir, relPath);
  }

  async function dirRecord(id) {
    if (!_dirCache) {
      const ds = await DB.listDirs();
      _dirCache = new Map(ds.map(d => [d.id, d]));
    }
    return _dirCache.get(id) || null;
  }

  /* ============ 轻量尺寸解析（读文件头，不解码） ============ */
  const HEAD_BYTES = 256 * 1024;

  function dimsFromJpeg(u8) {
    let i = 2;
    const n = u8.length;
    while (i < n - 9) {
      if (u8[i] !== 0xFF) { i++; continue; }
      const m = u8[i + 1];
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
      const len = (u8[i + 2] << 8) | u8[i + 3];
      const isSOF = (m >= 0xC0 && m <= 0xC3) || (m >= 0xC5 && m <= 0xC7) ||
                    (m >= 0xC9 && m <= 0xCB) || (m >= 0xCD && m <= 0xCF);
      if (isSOF) {
        const h = (u8[i + 5] << 8) | u8[i + 6];
        const w = (u8[i + 7] << 8) | u8[i + 8];
        return (w && h) ? { w, h } : null;
      }
      i += 2 + len;
    }
    return null;
  }

  function dimsFromHead(u8, ext) {
    try {
      if (ext === 'png' && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) {
        const dv = new DataView(u8.buffer, u8.byteOffset);
        return { w: dv.getUint32(16), h: dv.getUint32(20) };
      }
      if (ext === 'gif') {
        return { w: u8[6] | (u8[7] << 8), h: u8[8] | (u8[9] << 8) };
      }
      if (ext === 'bmp') {
        const dv = new DataView(u8.buffer, u8.byteOffset);
        return { w: dv.getInt32(18, true), h: Math.abs(dv.getInt32(22, true)) };
      }
      if (ext === 'webp') {
        const tag = String.fromCharCode(u8[12], u8[13], u8[14], u8[15]);
        if (tag === 'VP8X') {
          const w = 1 + (u8[24] | (u8[25] << 8) | (u8[26] << 16));
          const h = 1 + (u8[27] | (u8[28] << 8) | (u8[29] << 16));
          return { w, h };
        }
        if (tag === 'VP8 ') {
          const w = (u8[26] | (u8[27] << 8)) & 0x3FFF;
          const h = (u8[28] | (u8[29] << 8)) & 0x3FFF;
          return { w, h };
        }
        return null;
      }
      if (ext === 'jpg' || ext === 'jpeg') return dimsFromJpeg(u8);
    } catch (e) { /* ignore */ }
    return null;
  }

  /* 日期合理性：拒绝 1899 之类的零值时间戳，只接受 1990 后、不超明天 */
  function plausibleDate(ts) {
    return Number.isFinite(ts) && ts > Date.UTC(1990, 0, 1) && ts < Date.now() + 86400000;
  }

  /* ============ 扫描阶段：只读元数据 ============
   * blob 可能只是文件开头一小段（桌面端为了不整盘读，只取前 512KB），
   * 所以名字/大小/修改时间一律以 meta 为准，不能从 blob 上取。 */
  async function processFile(dirId, relPath, blob, old, meta) {
    const name = (meta && meta.name) || blob.name;
    const size = (meta && meta.size != null) ? meta.size : blob.size;
    const mtime = (meta && meta.mtime != null) ? meta.mtime : blob.lastModified;

    const ext = RAW.extOf(name);
    const isImage = IMG_EXTS.has(ext);
    const isRaw = RAW.isRawName(name);
    if (!isImage && !isRaw) return null;

    const rec = {
      id: dirId + ':' + relPath,
      dirId, relPath, name, ext, isRaw,
      size,
      mtime,
      addedAt: old ? old.addedAt : Date.now(),
      width: null, height: null,
      make: '', model: '', lens: '', focal: null, fnum: null, exposure: null, iso: null,
      date: null,
      // 文件已变化（processFile 只在 changed 时调用），旧缩略图作废，等显示时重新生成
      thumbState: 'pending',      // pending | ready | unavailable
      previewState: 'pending',    // pending | ready | original
    };

    // 1) 尺寸：读文件头解析，不解码像素（RAW 跳过，留给按需解码）
    if (!isRaw) {
      try {
        const head = await blob.slice(0, HEAD_BYTES).arrayBuffer();
        const dims = dimsFromHead(new Uint8Array(head), ext);
        if (dims && dims.w > 0 && dims.h > 0) { rec.width = dims.w; rec.height = dims.h; }
      } catch (e) { /* ignore */ }
    }

    // 2) EXIF（exifr 只读元数据段，速度很快；RAW 跳过以避免整块扫描）
    if (!isRaw) {
      const ex = await EXIF.parse(blob);
      Object.assign(rec, {
        make: ex.make, model: ex.model, lens: ex.lens,
        focal: ex.focal, fnum: ex.fnum, exposure: ex.exposure, iso: ex.iso,
        gps: ex.gps || null,   // 经纬度，供地图视图点亮使用
      });
      if (!rec.width && ex.width) { rec.width = ex.width; rec.height = ex.height; }
      if (ex.date) {
        const t = +new Date(ex.date);
        if (plausibleDate(t)) rec.date = t;
      }
    }

    // 3) 拍摄时间兜底：EXIF 合理时间 → 合理 mtime → null
    if (!plausibleDate(rec.date) && plausibleDate(mtime)) rec.date = mtime;
    if (!plausibleDate(rec.date)) rec.date = null;

    if (isRaw && !_rawEnabled) rec.thumbState = 'unavailable';
    return rec;
  }

  /* ---- 主入口：比对图片库 ----
   * opts: { dirId, onProgress(dirName, done, total, report), onBatch(report), shouldAbort() } */
  let _queueTail = Promise.resolve();
  function scanAll(opts = {}) {
    const run = _queueTail.then(() => _scanAll(opts));
    _queueTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async function _scanAll(opts = {}) {
    const report = { added: 0, updated: 0, removed: 0, processed: 0, skippedDirs: [], aborted: false };
    try {
      resetDirCache();
      let dirs = await DB.listDirs();
      if (opts.dirId != null) dirs = dirs.filter(d => d.id === opts.dirId);
      const oldPhotos = await DB.allPhotos();
      const byId = new Map(oldPhotos.map(p => [p.id, p]));
      const batch = [];
      const flush = async () => {
        if (!batch.length) return;
        await DB.putPhotos(batch.splice(0));
      };

      for (const dir of dirs) {
        if (opts.shouldAbort && opts.shouldAbort()) { report.aborted = true; break; }
        const perm = await dirPermission(dir);
        if (perm !== 'granted') { report.skippedDirs.push(dir.name); continue; }

        const files = [];
        await PLATFORM.walk(dir, e => { files.push(e); });
        const imgFiles = files.filter(f => IMG_EXTS.has(RAW.extOf(f.name)) || RAW.isRawName(f.name));

        let done = 0;
        for (const f of imgFiles) {
          if (opts.shouldAbort && opts.shouldAbort()) { report.aborted = true; break; }
          const id = dir.id + ':' + f.relPath;
          const old = byId.get(id);
          // 大小与 mtime 由枚举阶段直接给出（浏览器是 File 的元数据，桌面端是 fs.stat），
          // 因此「没变」的文件无需打开，桌面端也就不会把整盘照片读一遍。
          const size = (f.size != null) ? f.size : null;
          const mtime = (f.lastModified != null) ? f.lastModified : null;
          const changed = !old || size == null || mtime == null
            || old.mtime !== mtime || old.size !== size;
          if (!changed) { done++; continue; }

          let blob;
          try { blob = await f.getFile(); } catch (e) { done++; continue; }

          // 文件变了 → 旧缩略图/大图已过期，删掉
          if (old) {
            _mem.delete(id);
            try { await DB.deleteAssets(id); } catch (e) { /* ignore */ }
          }

          const rec = await processFile(dir.id, f.relPath, blob, old,
            { name: f.name, size, mtime });
          done++;
          if (!rec) { if (old) { await DB.deletePhoto(id); report.removed++; } continue; }
          report[old ? 'updated' : 'added']++;
          report.processed++;
          batch.push(rec);
          if (batch.length >= 20) {
            await flush();
            if (opts.onBatch) opts.onBatch(report);
            await new Promise(r => setTimeout(r, 0));
          }
          if (opts.onProgress) opts.onProgress(dir.name, done, imgFiles.length, report);
        }
        if (report.aborted) break;
        const validIds = new Set(imgFiles.map(f => dir.id + ':' + f.relPath));
        for (const p of oldPhotos) {
          if (p.dirId === dir.id && !validIds.has(p.id)) {
            _mem.delete(p.id);
            await DB.deletePhoto(p.id); report.removed++;
          }
        }
        await flush();
        if (opts.onProgress) opts.onProgress(dir.name, imgFiles.length, imgFiles.length, report);
      }
      await flush();
      return report;
    } catch (e) {
      report.error = e;
      return report;
    }
  }

  /* ============ 按需缩略图/预览生成 ============ */
  const _queue = [];
  const _inflight = new Map();
  let _active = 0;

  function pump() {
    while (_active < LAZY_CONCURRENCY && _queue.length) {
      const job = _queue.shift();
      _active++;
      let pr;
      try { pr = job.fn(); } catch (e) { pr = Promise.reject(e); }
      Promise.resolve(pr).then(job.resolve, job.reject).finally(() => { _active--; pump(); });
    }
  }
  function enqueue(fn) {
    return new Promise((resolve, reject) => { _queue.push({ fn, resolve, reject }); pump(); });
  }

  /* 给解码任务加超时：个别文件（损坏的 HEIC、超大 TIFF）可能让 createImageBitmap
   * 长时间不返回，占死并发槽位后整个缩略图队列会停摆。超时后按失败处理并让位。 */
  const DECODE_TIMEOUT = 20000;
  function withTimeout(pr, ms) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve({ __timeout: true }); } }, ms);
      Promise.resolve(pr).then(
        v => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
        e => { if (!done) { done = true; clearTimeout(timer); resolve({ __error: e }); } }
      );
    });
  }

  /* 解码并同时缩放到指定尺寸。
   * createImageBitmap 的 resize* 选项让浏览器在解码阶段就降采样（JPEG 走 DCT 缩放），
   * 比「全尺寸解码 → drawImage 缩放」快数倍，内存占用也低一个量级。 */
  async function decodeScaled(src, w, h) {
    if (w && h) {
      try {
        return await createImageBitmap(src, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' });
      } catch (e) { /* 不支持选项时退化为全解码 */ }
    }
    try { return await createImageBitmap(src); } catch (e) { return null; }
  }

  async function toWebp(bmp, limit, q) {
    const maxSide = Math.max(bmp.width, bmp.height) || 1;
    const s = Math.min(1, limit / maxSide);
    const w = Math.max(1, Math.round(bmp.width * s));
    const h = Math.max(1, Math.round(bmp.height * s));
    const cnv = document.createElement('canvas');
    cnv.width = w; cnv.height = h;
    const ctx = cnv.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    return await new Promise(res => cnv.toBlob(res, 'image/webp', q));
  }

  /* 解码一次，产出缩略图（wantPreview 时产出大图）
   * 成功：{ ok:true, thumb, preview, needPreview, width, height }
   * 失败：{ ok:false, error:'permission'|'raw-off'|'missing-file'|'no-handle'|'decode'|'timeout' }
   *   其中只有 'raw-off' 是永久性的；permission/decode/timeout 都应允许重试。 */
  async function loadSource(p) {
    const dir = await dirRecord(p.dirId);
    if (!dir) return { error: 'no-handle' };
    if ((await dirPermission(dir)) !== 'granted') return { error: 'permission' };

    let file;
    try { file = await PLATFORM.openFile(dir, p.relPath); } catch (e) { return { error: 'missing-file' }; }

    if (!p.isRaw) return { file };
    try {
      const emb = await RAW.extractPreview(file);
      return emb ? { file: emb } : { error: 'decode' };
    } catch (e) { return { error: 'decode' }; }
  }

  async function buildAssets(p, wantPreview) {
    const knownW = p.width, knownH = p.height;
    const known = !!(knownW && knownH);
    const target = previewTargetLong();

    // 已知尺寸且不超过屏幕 → 不需要生成任何东西，直接让调用方用原图
    if (wantPreview && known && Math.max(knownW, knownH) <= target) {
      return { ok: true, thumb: null, preview: null, needPreview: false, width: knownW, height: knownH };
    }
    if (p.isRaw && !_rawEnabled) return { ok: false, error: 'raw-off' };

    const src = await loadSource(p);
    if (src.error) return { ok: false, error: src.error };

    // 解码目标尺寸：缩略图按 640 长边；大图按屏幕长边
    const limit = wantPreview ? target : THUMB_MAX;
    let rw = 0, rh = 0;
    if (known) {
      const s = Math.min(1, limit / Math.max(knownW, knownH));
      rw = Math.max(1, Math.round(knownW * s));
      rh = Math.max(1, Math.round(knownH * s));
    }

    const bmp = await decodeScaled(src.file, rw, rh);
    if (!bmp) return { ok: false, error: 'decode' };

    try {
      // 已知尺寸时用记录的原始尺寸判断（bmp 可能是已缩放的，尺寸会骗人）
      const fullW = known ? knownW : bmp.width;
      const fullH = known ? knownH : bmp.height;
      const needPreview = Math.max(fullW, fullH) > target;

      if (wantPreview) {
        if (!needPreview) return { ok: true, thumb: null, preview: null, needPreview: false, width: fullW, height: fullH };
        const preview = await toWebp(bmp, target, PREVIEW_QUAL);
        if (!preview) return { ok: false, error: 'decode' };
        return { ok: true, thumb: null, preview, needPreview: true, width: fullW, height: fullH };
      }
      const thumb = await toWebp(bmp, THUMB_MAX, THUMB_QUAL);
      if (!thumb) return { ok: false, error: 'decode' };   // canvas.toBlob 可能返回 null（超大图/内存不足）
      return { ok: true, thumb, preview: null, needPreview, width: fullW, height: fullH };
    } finally {
      if (bmp && bmp.close) bmp.close();
    }
  }

  /* 取原图（RAW 取其内嵌 JPEG 预览）的 URL，由调用方负责 revoke。
   * 桌面壳能直接给出 covefile:// 地址，那就交给 Chromium 自己流式加载，
   * 不必把几十 MB 的原图先读进 JS 堆再转 Blob URL。 */
  async function originalUrl(p) {
    const dir = await dirRecord(p.dirId);
    if (!dir) return null;
    if ((await dirPermission(dir)) !== 'granted') return null;
    if (!p.isRaw) {
      const direct = PLATFORM.imageUrl(dir, p.relPath);
      if (direct) return direct;
    }
    let file;
    try { file = await PLATFORM.openFile(dir, p.relPath); } catch (e) { return null; }
    if (!p.isRaw) return URL.createObjectURL(file);
    if (!_rawEnabled) return null;
    try {
      const emb = await RAW.extractPreview(file);
      return emb ? URL.createObjectURL(emb) : null;
    } catch (e) { return null; }
  }

  /* 失败记录（仅内存，不落库）：
   * 解码失败/超时/文件缺失都是临时性的，绝不能写成永久状态——
   * 一旦落库成 unavailable，目录恢复可读或文件修好后也不会再重试，照片就永远空白。 */
  const _failed = new Map();   // id -> { at, error }
  function isFailed(id) { return _failed.has(id); }
  function failedReason(id) { const v = _failed.get(id); return v ? v.error : null; }
  function clearFailed() { _failed.clear(); }
  function retry(p) {
    _failed.delete(p.id);
    if (!p.isRaw && (p.thumbState === 'unavailable' || p.thumbState === 'error')) p.thumbState = 'pending';
  }
  function markFail(p, error) {
    if (error === 'raw-off') {
      // 唯一合法的永久状态：RAW 支持未开启
      if (p.isRaw) p.thumbState = 'unavailable';
      return { error: 'raw-off', retryable: false };
    }
    _failed.set(p.id, { at: Date.now(), error });
    return { error, retryable: true };
  }

  /* 确保某张照片的缩略图（kind='thumb'）或大图（kind='preview'）可用
   * 取用顺序：内存 LRU → IndexedDB assets → 现解码并回写
   * 成功：{ thumb, preview, useOriginal, width, height }
   * 失败：{ error, retryable } ／ null
   *   error='permission' 表示目录当前读不到（盘没插、或被改名移动），属临时状态，调用方应提示重试 */
  function ensureAssets(p, kind = 'thumb') {
    const wantPreview = kind === 'preview';

    if (wantPreview) {
      const m = memGet(p.id);
      if (m && m.preview) return Promise.resolve({ thumb: m.thumb || null, preview: m.preview, useOriginal: false, width: p.width, height: p.height });
      if (p.previewState === 'original') return Promise.resolve({ thumb: (m && m.thumb) || null, preview: null, useOriginal: true, width: p.width, height: p.height });
    } else {
      const t = thumbSync(p);
      if (t) { memGet(p.id); return Promise.resolve({ thumb: t, preview: null, useOriginal: false, width: p.width, height: p.height }); }
    }
    if (p.thumbState === 'unavailable' && p.isRaw && !_rawEnabled) return Promise.resolve({ error: 'raw-off' });

    const key = p.id + ':' + kind;
    if (_inflight.has(key)) return _inflight.get(key);

    // 查库是纯读操作，放在限流队列外并行跑；只有真正要解码才排队，
    // 否则一堆「其实已缓存」的照片会在队列里排队，白白拖慢首屏。
    const task = (async () => {
      // 1) 先查库里的缓存（同一张图可能在别的批次里已生成过）
      let cur = memGet(p.id) || null;
      if (!cur || (!cur.thumb && !wantPreview) || (!cur.preview && wantPreview)) {
        const stored = await DB.getAssets(p.id).catch(() => null);
        if (stored) {
          cur = cur || {};
          if (!cur.thumb && stored.thumb) cur.thumb = stored.thumb;
          if (!cur.preview && stored.preview) cur.preview = stored.preview;
          if (cur.thumb || cur.preview) memSet(p.id, cur);
        }
      }
      if (!wantPreview && cur && cur.thumb) {
        return { thumb: cur.thumb, preview: null, useOriginal: false, width: p.width, height: p.height };
      }
      if (wantPreview) {
        if (cur && cur.preview) {
          p.previewState = 'ready';
          return { thumb: cur.thumb || null, preview: cur.preview, useOriginal: false, width: p.width, height: p.height };
        }
        if (p.previewState === 'original') {
          return { thumb: (cur && cur.thumb) || null, preview: null, useOriginal: true, width: p.width, height: p.height };
        }
      }

      // 2) 现解码生成（受限并发，避免同时解码太多把主线程压死）
      return await enqueue(async () => {
        // 排队期间可能已被别的路径生成好了
        const now = memGet(p.id) || {};
        if (!wantPreview && now.thumb) {
          return { thumb: now.thumb, preview: null, useOriginal: false, width: p.width, height: p.height };
        }
        if (wantPreview && now.preview) {
          p.previewState = 'ready';
          return { thumb: now.thumb || null, preview: now.preview, useOriginal: false, width: p.width, height: p.height };
        }

        const out = await withTimeout(buildAssets(p, wantPreview), DECODE_TIMEOUT);

        if (!out || out.__error) return markFail(p, 'decode');
        if (out.__timeout) return markFail(p, 'timeout');
        if (out.ok === false) {
          if (out.error === 'permission' || out.error === 'no-handle') {
            // 目录仍读不到：不写任何状态、不落库，恢复后自动重试
            return { error: 'permission', retryable: true };
          }
          if (out.error === 'raw-off') return markFail(p, 'raw-off');
          return markFail(p, out.error || 'decode');
        }

        p.width = out.width; p.height = out.height;
        if (wantPreview) {
          if (out.preview) { p.previewState = 'ready'; }
          else { p.previewState = 'original'; }
        } else {
          p.thumbState = 'ready';
          if (p.previewState !== 'ready') p.previewState = out.needPreview ? 'pending' : 'original';
        }
        _failed.delete(p.id);

        // 3) 回写：Blob 进 assets，状态进 photos
        const patch = {};
        if (out.thumb) patch.thumb = out.thumb;
        if (out.preview) patch.preview = out.preview;
        let persisted = true;
        if (Object.keys(patch).length) {
          memSet(p.id, Object.assign(memGet(p.id) || {}, patch));
          try {
            await DB.putAssets(p.id, patch);
            _storageError = null;
          } catch (e) {
            persisted = false;
            _storageError = e;
            console.warn('[assets] 缩略图写入本地库失败（通常是存储空间不足）：', p.name, e);
          }
        }
        // 没写进库就绝不能标成 ready：否则下次打开会认为"已有缩略图"而永远不再生成
        if (!persisted) {
          if (wantPreview) p.previewState = 'pending';
          else p.thumbState = 'pending';
        }
        DB.putPhoto(p).catch(() => {});

        return {
          thumb: out.thumb || (memGet(p.id) || {}).thumb || null,
          preview: out.preview || null,
          useOriginal: wantPreview && !out.preview,
          width: out.width, height: out.height,
        };
      });
    })().catch(e => {
      console.warn('[assets]', p.name, e);
      return markFail(p, 'decode');
    }).finally(() => _inflight.delete(key));

    _inflight.set(key, task);
    return task;
  }

  /* RAW 开关切换后：清掉旧 RAW 记录重新扫描 */
  async function rescanRaw(opts = {}) {
    const photos = await DB.allPhotos();
    const rawIds = photos.filter(p => p.isRaw).map(p => p.id);
    for (const id of rawIds) { _mem.delete(id); await DB.deletePhoto(id); }
    return scanAll(opts);
  }

  return {
    scanAll, rescanRaw, setRawEnabled, dirPermission, ensureAssets, originalUrl,
    previewTargetLong, resetDirCache, thumbSync, previewSync, clearMem,
    isFailed, failedReason, clearFailed, retry, storageError, clearStorageError,
    resolveFile,
  };
})();
