/* js/gps-write.js — 写 GPS 的核心（GPSWRITE）
 *
 * 谁在用：地图上的补位置工作台（map-pick.js）和旧的面板式编辑器（gps-editor.js）。
 * 两处都要「把某几张照片的绝对路径凑出来 → 调 exiftool → 把索引里的坐标改掉并
 * 单独持久化 → 刷新视图」，只有界面不同。抽在这里，免得两份实现慢慢长歪。
 *
 * 写入本身仍然交给主进程的 exiftool：它保留 MakerNotes、维持文件结构、支持各家 RAW，
 * 自己改 JPEG 的 EXIF 二进制一旦偏移算错就是毁照片。
 *
 * 返回值的语义：
 *   ok:false      —— 压根没写（坐标不合法 / 没有路径 / 找不到 exiftool）
 *   ok:true        —— exiftool 跑过了，updated/failed 是它自己报的数字
 *   wrote          —— 索引里已经标上坐标的那批记录（界面据此把它们移出待处理列表）
 *   noPath         —— 目录记录缺失、拼不出本机路径的照片
 */
'use strict';

const GPSWRITE = (() => {
  let _dirs = [];
  let _dirsAt = 0;

  /* 目录记录：30 秒内复用，设置页增删目录后不至于一直用旧表 */
  async function dirs(force) {
    if (!force && _dirs.length && Date.now() - _dirsAt < 30000) return _dirs;
    try { _dirs = await DB.listDirs(); } catch (e) { _dirs = []; }
    _dirsAt = Date.now();
    return _dirs;
  }

  function dirOf(id) {
    for (let i = 0; i < _dirs.length; i++) {
      if (String(_dirs[i].id) === String(id)) return _dirs[i];
    }
    return null;
  }

  function absOf(p) {
    const d = dirOf(p && p.dirId);
    if (!d || !d.path || !p || !p.relPath) return '';
    return PLATFORM.joinPath(d.path, p.relPath);
  }

  function validCoord(c) {
    if (!c) return false;
    const lat = Number(c.lat);
    const lng = Number(c.lng);
    if (!isFinite(lat) || !isFinite(lng)) return false;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
    return !(lat === 0 && lng === 0);        // 几内亚湾，基本是误填
  }

  /* exiftool 的位置：先问主进程（内置 / 自动找到的），再回退到用户上次指定的 */
  async function exiftool() {
    let p = '';
    try { p = await PLATFORM.exiftool(); } catch (e) { /* ignore */ }
    if (!p) {
      try { p = await DB.getSetting('exiftoolPath', ''); } catch (e) { /* ignore */ }
    }
    return p || '';
  }

  async function write(photos, coord, opts) {
    const o = opts || {};
    if (!validCoord(coord)) return { ok: false, error: '坐标不合法' };

    const list = (photos || []).filter(p => p && p.relPath);
    if (!list.length) return { ok: false, error: '没有选中照片' };

    await dirs();
    const files = [];
    const kept = [];
    const noPath = [];
    for (const p of list) {
      const a = absOf(p);
      if (a) { files.push(a); kept.push(p); } else { noPath.push(p); }
    }
    if (!files.length) {
      return { ok: false, error: '选中的照片都取不到本机路径，请到设置页检查目录记录。', noPath };
    }

    const exe = o.exiftool || await exiftool();
    if (!exe) return { ok: false, error: '没有找到 exiftool.exe，无法写入。', noPath };

    let r;
    try {
      r = await PLATFORM.writeGps({
        files, lat: coord.lat, lng: coord.lng, backup: o.backup !== false, exiftool: exe,
      });
    } catch (e) {
      r = { ok: false, error: e && e.message ? e.message : String(e) };
    }
    if (!r || r.ok === false) return { ok: false, error: (r && r.error) || '写入失败', noPath };

    /* 索引里的坐标要跟着改，否则地图上还是看不到这些照片。
     * exiftool 只回聚合数字、不区分具体哪一张失败，所以只要确实写成了，
     * 就把这批记录整体标上坐标（与原编辑器行为一致）。 */
    const wrote = [];
    if ((r.updated || 0) > 0) {
      const lat = Number(coord.lat), lng = Number(coord.lng), at = Date.now();
      const overrides = [];
      for (const p of kept) {
        p.gps = { lat, lng };
        overrides.push({ id: p.id, lat, lng, at });
        wrote.push(p);
        try { await DB.putPhoto(p); } catch (e) { /* 单条失败不影响其它 */ }
      }
      /* 坐标再单独存一份（gpsOverrides）：exiftool 改文件会变更 mtime → 下次扫描
       * 重建这条记录；而它给 RAW 写的 GPS 追加在文件尾部，96KB 读头读不到，
       * 只写在 photos 里的话，重新扫描甚至清空索引之后坐标就没了。 */
      try { await DB.putGpsOverrides(overrides); }
      catch (e) { console.warn('[gps] 手动坐标持久化失败：', e); }
    }

    try { await VIEWS.reload(); } catch (e) { /* ignore */ }
    if (typeof MAPVIEW !== 'undefined' && MAPVIEW) {
      try { MAPVIEW.render(); } catch (e) { /* 不在地图视图时无所谓 */ }
    }

    return {
      ok: true,
      updated: r.updated || 0,
      failed: r.failed || 0,
      backupFailed: r.backupFailed || 0,
      errors: r.errors || [],
      noPath,
      wrote,
    };
  }

  return { write, dirs, absOf, exiftool, validCoord };
})();
