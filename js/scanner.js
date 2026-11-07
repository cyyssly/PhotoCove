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

  /* 扫描调度参数 */
  const BATCH_SIZE = 300;   // 每个事务写多少条记录（原 20 条 → 2,389 次事务，现在是 160 次）
  const PROGRESS_MS = 100;  // 进度回调的最小间隔，避免每张照片都写一次 DOM
  /* 同时进行中的读头请求数。1 = 完全串行（一次只有一个 IPC 在飞）。
   * 读头是「IPC 往返 + 随机读 96KB」，瓶颈在延迟而不是 CPU，所以把等待重叠起来就有收益。
   * 实测全库 4.7 万张（空库、全部要读头）：1 路 31.0s、2 路 22.5s、4 路 16.9s，
   * 三者的元数据结果完全一致。取 2 是折中：单张 96KB 的临时缓冲，峰值只多几十 KB，
   * 机械盘上也只多一路寻道，几乎无风险；再往上收益递减。 */
  const PROBE_WINDOW = 2;

  /* 记录里元数据的版本。v5 及以前的 RAW 记录压根没解析过 EXIF，
   * 而增量扫描只比对 size/mtime，这些记录永远不会自己补上。
   * 给 RAW 一个一次性强制重读：扫过一次之后 metaVersion 就是 2，
   * 之后继续走「stat 相同就跳过」的快路径。 */
  const META_VERSION = 2;

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

  /* ============ 尺寸与 EXIF：已搬进主进程 ============
   * 见 electron/scan-meta.js。页面这侧不再读文件头、也不再调 exifr：
   * 扫描要的只是「宽高 + 机型 + 时间 + GPS」这几个字段，让主进程读完就地解析，
   * 回传一个小对象比搬 96KB 字节省得多（两万张就是 10GB 级的差别）。 */

  /* 日期合理性：拒绝 1899 之类的零值时间戳，只接受 1990 后、不超明天 */
  function plausibleDate(ts) {
    return Number.isFinite(ts) && ts > Date.UTC(1990, 0, 1) && ts < Date.now() + 86400000;
  }

  /* ============ 扫描阶段：只读元数据 ============
   * info 是主进程返回的 { ok, w, h, make, model, … }，照片本身一个字节都不进页面。
   * v6 起 RAW 也读 96KB 头：以前整类跳过，机型/拍摄时间/光圈/GPS 全丢，
   * 日期退回文件 mtime，还一律被判成「无位置信息」。RAW 解析不出宽高
   * （缩略图仍走内嵌 JPEG 预览），但头部 TIFF 里的 EXIF 是实打实读得到的。 */
  async function processFile(dirId, relPath, info, old, meta, overrides) {
    const name = (meta && meta.name) || '';
    const size = (meta && meta.size != null) ? meta.size : null;
    const mtime = (meta && meta.mtime != null) ? meta.mtime : null;

    const ext = RAW.extOf(name);
    const isImage = IMG_EXTS.has(ext);
    const isRaw = RAW.isRawName(name);
    if (!isImage && !isRaw) return null;

    const rec = {
      id: dirId + ':' + relPath,
      dirId, relPath, name, ext, isRaw,
      size,
      mtime,
      metaVersion: META_VERSION,
      addedAt: old ? old.addedAt : Date.now(),
      width: null, height: null,
      make: '', model: '', lens: '', focal: null, fnum: null, exposure: null, iso: null,
      date: null,
      // 文件已变化（processFile 只在 changed 时调用），旧缩略图作废，等显示时重新生成
      thumbState: 'pending',      // pending | ready | unavailable
      previewState: 'pending',    // pending | ready | original
    };

    // 尺寸与 EXIF：主进程读文件头就地解析后回传（RAW 同样读 96KB 头）
    if (info && info.ok) {
      if (info.w > 0 && info.h > 0) { rec.width = info.w; rec.height = info.h; }
      rec.make = info.make || '';
      rec.model = info.model || '';
      rec.lens = info.lens || '';
      rec.focal = info.focal ?? null;
      rec.fnum = info.fnum ?? null;
      rec.exposure = info.exposure ?? null;
      rec.iso = info.iso ?? null;
      rec.gps = info.gps || null;   // 经纬度，供地图视图点亮使用
      if (info.date && plausibleDate(+info.date)) rec.date = +info.date;
    }

    // 拍摄时间兜底：EXIF 合理时间 → 合理 mtime → null
    if (!plausibleDate(rec.date) && plausibleDate(mtime)) rec.date = mtime;
    if (!plausibleDate(rec.date)) rec.date = null;

    /* 坐标优先级：文件里的 EXIF → 应用内补写过并单独持久化的 → 旧记录。
     * 后两级不能省：exiftool 改文件会变更 mtime，下次扫描就要重建这条记录；
     * 而它给 RAW 写 GPS 时把 GPS IFD 追加到文件尾部（NEF ~9MB、RW2 ~11MB），
     * 96KB 头根本够不着，重建一次坐标就凭空消失，地图上的点过一阵子又没了。
     * 第三级是给「旧版本写入过、还没有 override 记录」的那些照片兜底。 */
    if (!rec.gps) {
      const ov = overrides && overrides.get(rec.id);
      if (ov && Number.isFinite(+ov.lat) && Number.isFinite(+ov.lng)) {
        rec.gps = { lat: +ov.lat, lng: +ov.lng };
      } else if (old && old.gps && Number.isFinite(+old.gps.lat) && Number.isFinite(+old.gps.lng)) {
        rec.gps = { lat: +old.gps.lat, lng: +old.gps.lng };
      }
    }

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
      /* 手动补写的坐标单独存一张表：清空索引、重建 RAW 记录之后都要还回去。
       * 一次性读进内存 Map，别让每张照片都查一次库。 */
      let gpsOverrides = new Map();
      try {
        const rows = await DB.allGpsOverrides();
        gpsOverrides = new Map(rows.map(r => [r.id, r]));
      } catch (e) { /* 旧库或读取失败：退到 old.gps 兜底 */ }
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
        const total = imgFiles.length;
        /* 进度回调节流：以前每张照片都调一次，4.7 万张就是 4.7 万次 DOM 写入。
         * 更重要的是——跳过（未变化）的文件以前**根本不回调**，于是「已索引部分」
         * 在进度条上表现为一条纹丝不动的线，越过它之后才开始动，看起来就像
         * 「前面飞快、后面变慢」。现在所有文件都计入进度，只是限制频率。 */
        let lastTick = 0;
        const tick = (force) => {
          if (!opts.onProgress) return;
          const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
          if (!force && now - lastTick < PROGRESS_MS) return;
          lastTick = now;
          opts.onProgress(dir.name, done, total, report);
        };

        /* 按 PROBE_WINDOW 分窗：先把这一窗里需要读头的文件并发探测，再按原顺序落库。
         * 顺序不变 → 写入顺序、增量计数、进度语义都和串行时一致。 */
        for (let start = 0; start < total; start += PROBE_WINDOW) {
          if (opts.shouldAbort && opts.shouldAbort()) { report.aborted = true; break; }
          const win = imgFiles.slice(start, start + PROBE_WINDOW).map(f => {
            const id = dir.id + ':' + f.relPath;
            const old = byId.get(id);
            // 大小与 mtime 由枚举阶段直接给出（浏览器是 File 的元数据，桌面端是 fs.stat），
            // 因此「没变」的文件无需打开，桌面端也就不会把整盘照片读一遍。
            const size = (f.size != null) ? f.size : null;
            const mtime = (f.lastModified != null) ? f.lastModified : null;
            const isRaw = RAW.isRawName(f.name);
            const changed = !old || size == null || mtime == null
              || old.mtime !== mtime || old.size !== size
              || (isRaw && old && old.metaVersion !== META_VERSION);
            // v6 起 RAW 也读 96KB 头：EXIF 里的机型/时间/光圈/GPS 就在头部 TIFF 中，
            // 以前整类跳过，白丢一半元数据，还让所有 RAW 都被判成「无位置信息」。
            return { f, id, old, size, mtime, changed, isRaw, info: null };
          });

          const needProbe = win.filter(j => j.changed);
          if (needProbe.length > 1) {
            const infos = await Promise.all(needProbe.map(j => j.f.probe().catch(() => null)));
            needProbe.forEach((j, k) => { j.info = infos[k]; });
          } else if (needProbe.length === 1) {
            const j = needProbe[0];
            try { j.info = await j.f.probe(); } catch (e) { j.info = null; }
          }

          for (const j of win) {
            if (opts.shouldAbort && opts.shouldAbort()) { report.aborted = true; break; }
            if (!j.changed) { done++; tick(); continue; }
            // 读不到（刚被删、被独占锁定）：保持旧记录不动，和以前的处理一致
            if (!j.isRaw && (!j.info || !j.info.ok)) { done++; tick(); continue; }

            // 文件变了 → 旧缩略图/大图已过期，删掉
            if (j.old) {
              _mem.delete(j.id);
              try { await DB.deleteAssets(j.id); } catch (e) { /* ignore */ }
            }

            const rec = await processFile(dir.id, j.f.relPath, j.info, j.old,
              { name: j.f.name, size: j.size, mtime: j.mtime }, gpsOverrides);
            done++;
            if (!rec) {
              if (j.old) { await DB.deletePhoto(j.id); report.removed++; }
              tick();
              continue;
            }
            report[j.old ? 'updated' : 'added']++;
            report.processed++;
            batch.push(rec);
            if (batch.length >= BATCH_SIZE) {
              await flush();
              if (opts.onBatch) opts.onBatch(report);
              // 让出主线程：写库是同步起的 IndexedDB 事务，一口气跑完界面会卡住
              await new Promise(r => setTimeout(r, 0));
            }
            tick();
          }
          if (report.aborted) break;
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
        tick(true);   // 目录收尾：强制把进度推到 100%，不受节流限制
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
