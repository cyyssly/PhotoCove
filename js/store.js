/* store.js — IndexedDB 存储层
 *
 * v4 起把「元数据」和「图片二进制」拆成两个 store：
 *   photos  : 纯元数据（路径/时间/EXIF/尺寸/状态），几万条也只有几 MB
 *   assets  : 缩略图与大图 Blob，只在真正显示时才按 id 读取
 *   gpsOverrides : 应用内手动补写的坐标（v6），独立于 photos，清空索引也不删
 * 这样 allPhotos() 不会再把整个图库的二进制搬进内存（旧实现在几万张时会卡死）。
 */
'use strict';

const DB = (() => {
  const DB_NAME = 'photo-gallery';
  const DB_VER = 6; // v6：新增 gpsOverrides（手动补写的坐标，独立于 photos）
  let _db = null;

  /* v5：把「临时失败被写成永久不可用」的记录复位，让它们重新尝试生成。
   * （v3/v4 期间，授权未恢复或解码失败都会把 thumbState 写成 unavailable 并落库，
   *   之后即使授权恢复也不会重试，表现为大量照片永远空白） */
  function healCursor(t) {
    const ps = t.objectStore('photos');
    ps.openCursor().onsuccess = (ev) => {
      const c = ev.target.result;
      if (!c) return;
      const p = c.value;
      // RAW 的 unavailable 是合法状态（未开启 RAW 支持），不动它
      if (p && !p.isRaw && (p.thumbState === 'unavailable' || p.thumbState === 'error')) {
        p.thumbState = 'pending';
        const r = c.update(p);
        if (r) r.onerror = (e) => { e.preventDefault(); };  // 单条失败不中断整个升级
      }
      c.continue();
    };
  }

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        const t = e.target.transaction;
        const from = e.oldVersion || 0;

        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('dirs')) db.createObjectStore('dirs', { keyPath: 'id', autoIncrement: true });

        // v2 曾因畸形日期重建过 photos；这里保持同样的兜底
        if (from < 2 && db.objectStoreNames.contains('photos')) db.deleteObjectStore('photos');
        if (!db.objectStoreNames.contains('photos')) {
          const s = db.createObjectStore('photos', { keyPath: 'id' });
          s.createIndex('dirId', 'dirId');
        }
        if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
        // v6：应用内补写的 GPS 坐标。故意不放进 photos —— 清空索引、RAW 记录重建
        // 都会把 photos 里的记录删掉/覆盖，而 exiftool 给 RAW 写的 GPS 又在文件尾部，
        // 96KB 读头读不回来。单独存一份，扫描时按 id 回填。
        if (!db.objectStoreNames.contains('gpsOverrides')) db.createObjectStore('gpsOverrides', { keyPath: 'id' });

        // v4 迁移：把旧记录里的 thumb/preview 搬到 assets，并从元数据里删掉
        if (from && from < 4) {
          const ps = t.objectStore('photos');
          const as = t.objectStore('assets');
          ps.openCursor().onsuccess = (ev) => {
            const c = ev.target.result;
            if (!c) { if (from < 5) healCursor(t); return; }   // 迁移完再复位状态，避免互相覆盖
            const p = c.value;
            if (p && (p.thumb || p.preview)) {
              let prev = p.preview || null;
              // v2/v3 期间有过「把缩略图当大图缓存」的脏数据，同体积即视为脏
              if (prev && p.thumb && prev.size === p.thumb.size) prev = null;
              const thumb = p.thumb || null;
              const put = as.put({ id: p.id, thumb, preview: prev });
              if (put) put.onerror = (e) => { e.preventDefault(); };  // 个别写入失败（如配额）不中断升级
              p.thumbState = thumb ? 'ready' : (p.thumbState || 'pending');
              p.previewState = prev ? 'ready' : (p.previewState === 'original' ? 'original' : 'pending');
              delete p.thumb;
              delete p.preview;
              const up = c.update(p);
              if (up) up.onerror = (e) => { e.preventDefault(); };
            }
            c.continue();
          };
        } else if (from && from < 5) {
          healCursor(t);
        }
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      const out = fn(s);
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
    }));
  }

  /* ---- kv ---- */
  async function getSetting(key, fallback) {
    const db = await open();
    return new Promise((resolve) => {
      const req = db.transaction('kv').objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.result === undefined ? fallback : req.result);
      req.onerror = () => resolve(fallback);
    });
  }
  function setSetting(key, value) { return tx('kv', 'readwrite', s => s.put(value, key)); }

  /* ---- dirs ---- */
  async function listDirs() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction('dirs').objectStore('dirs').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function addDir(record) { return tx('dirs', 'readwrite', s => s.add(record)); }

  function removeDir(id) {
    return open().then(db => new Promise((resolve, reject) => {
      // 删目录记录 + 该目录下的照片 + 对应的图片资源 + 手动补写的坐标
      const t = db.transaction(['dirs', 'photos', 'assets', 'gpsOverrides'], 'readwrite');
      t.objectStore('dirs').delete(id);
      const ps = t.objectStore('photos');
      const as = t.objectStore('assets');
      const gs = t.objectStore('gpsOverrides');
      const req = ps.index('dirId').openCursor(IDBKeyRange.only(id));
      req.onsuccess = (e) => {
        const c = e.target.result;
        if (!c) return;
        as.delete(c.value.id);
        gs.delete(c.value.id);
        c.delete();
        c.continue();
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    }));
  }

  /* ---- photos（纯元数据） ---- */
  function putPhoto(p) {
    const rec = Object.assign({}, p);
    delete rec.thumb; delete rec.preview;   // 元数据里绝不留 Blob
    return tx('photos', 'readwrite', s => s.put(rec));
  }
  function putPhotos(list) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction('photos', 'readwrite');
      const s = t.objectStore('photos');
      list.forEach(p => {
        const rec = Object.assign({}, p);
        delete rec.thumb; delete rec.preview;
        s.put(rec);
      });
      t.oncomplete = resolve; t.onerror = () => reject(t.error);
    }));
  }
  async function allPhotos() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction('photos').objectStore('photos').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function deletePhoto(id) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(['photos', 'assets'], 'readwrite');
      t.objectStore('photos').delete(id);
      t.objectStore('assets').delete(id);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    }));
  }
  /* 清空索引只清照片记录与图片缓存；gpsOverrides 故意不动，
   * 重建索引时扫描器会把手动补过的坐标原样还回去。 */
  function clearPhotos() {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(['photos', 'assets'], 'readwrite');
      t.objectStore('photos').clear();
      t.objectStore('assets').clear();
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    }));
  }

  /* ---- gpsOverrides（应用内手动补写的坐标） ----
   * id 与 photos 一致（dirId:relPath），只有 { id, lat, lng, at } 四个字段。
   * 写入成功后记一笔；扫描在文件 EXIF 读不到坐标时用它回填。 */
  function allGpsOverrides() {
    return open().then(db => new Promise((resolve, reject) => {
      const req = db.transaction('gpsOverrides').objectStore('gpsOverrides').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    }));
  }
  function putGpsOverrides(list) {
    if (!list || !list.length) return Promise.resolve();
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction('gpsOverrides', 'readwrite');
      const s = t.objectStore('gpsOverrides');
      list.forEach(r => s.put(r));
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    }));
  }

  async function countPhotosByDir() {
    const db = await open();
    const dirs = await listDirs();
    const map = {};
    await Promise.all(dirs.map(d => new Promise(res => {
      const req = db.transaction('photos').objectStore('photos').index('dirId').count(IDBKeyRange.only(d.id));
      req.onsuccess = () => { map[d.id] = req.result; res(); };
      req.onerror = () => res();
    })));
    return map;
  }

  /* ---- assets（缩略图 / 大图 Blob） ---- */
  function getAssets(id) {
    return open().then(db => new Promise((resolve) => {
      const req = db.transaction('assets').objectStore('assets').get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    }));
  }
  function putAssets(id, patch) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction('assets', 'readwrite');
      const s = t.objectStore('assets');
      const g = s.get(id);
      g.onsuccess = () => {
        const cur = g.result || { id };
        if (patch.thumb !== undefined) cur.thumb = patch.thumb;
        if (patch.preview !== undefined) cur.preview = patch.preview;
        s.put(cur);
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    }));
  }
  function deleteAssets(id) {
    return open().then(db => new Promise((resolve) => {
      const t = db.transaction('assets', 'readwrite');
      t.objectStore('assets').delete(id);
      t.oncomplete = () => resolve();
      t.onerror = () => resolve();
    }));
  }

  /* ---- 诊断：统计照片与缩略图缓存的真实状态 ---- */
  function reqP(r) {
    return new Promise((resolve) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(undefined);
    });
  }

  async function stats() {
    const db = await open();
    const total = (await reqP(db.transaction('photos').objectStore('photos').count())) || 0;
    const assets = (await reqP(db.transaction('assets').objectStore('assets').count())) || 0;
    const out = { total, assets, ready: 0, pending: 0, unavailable: 0, error: 0, noState: 0 };
    await new Promise(res => {
      const t = db.transaction('photos');
      const r = t.objectStore('photos').openCursor();
      r.onsuccess = (e) => {
        const c = e.target.result;
        if (!c) return res();
        const s = c.value && c.value.thumbState;
        if (s === 'ready') out.ready++;
        else if (s === 'pending') out.pending++;
        else if (s === 'unavailable') out.unavailable++;
        else if (s === 'error') out.error++;
        else out.noState++;
        c.continue();
      };
      r.onerror = () => res();
    });
    return out;
  }

  /* 存储用量：返回浏览器报的 usage（本站当前占用）；quota 仅内部保留，界面不再展示 */
  async function storageEstimate() {
    try {
      if (!navigator.storage || !navigator.storage.estimate) return null;
      const e = await navigator.storage.estimate();
      return { usage: e.usage || 0, quota: e.quota || 0 };
    } catch (e) { return null; }
  }

  return {
    open, getSetting, setSetting, listDirs, addDir, removeDir,
    putPhoto, putPhotos, allPhotos, deletePhoto, clearPhotos, countPhotosByDir,
    allGpsOverrides, putGpsOverrides,
    getAssets, putAssets, deleteAssets,
    stats, storageEstimate,
  };
})();
