/* electron/selftest.renderer.js — 在真实页面里跑一遍完整链路
 *
 * 由 main.js 用 executeJavaScript 注入执行：(async function (dir) {…})("F:\\…")
 * 只在 --selftest 时使用，不参与正常运行。
 */
async function (dir) {
  const failed = [];
  const info = {};
  const check = (name, cond, extra) => {
    if (!cond) failed.push(name + (extra ? ' :: ' + extra : ''));
  };
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  let dirId = null;
  try {
    if (!dir) return { ok: false, error: '没有传 --dir <文件夹>' };

    // 等 boot 把自己的活干完，避免两边同时开库
    for (let i = 0; i < 60; i++) {
      const t = document.querySelector('#dir-perm-text');
      if (t && t.textContent.indexOf('正在检查') < 0) break;
      await wait(50);
    }

    // 磁盘访问层就绪 + 引导层没有误判（上一版这里查的是 PLATFORM.kind/isDesktop，
    // 那两个字段随网页版一起删掉了）
    const api = ['pickDirectory', 'newDirRecord', 'isSameDir', 'queryPermission',
      'walk', 'resolveFile', 'openFile', 'imageUrl', 'launchGpsStamp'];
    const missing = api.filter(k => typeof PLATFORM[k] !== 'function');
    check('磁盘访问层方法齐全', missing.length === 0, '缺 ' + missing.join(', '));
    check('未落入浏览器引导层', !document.body.classList.contains('gated'));
    info.info = await window.__COVE_DESKTOP.info();

    // ---- 1. 建目录记录（桌面端直接带绝对路径） ----
    dirId = await DB.addDir({ name: '__selftest__', path: dir, addedAt: Date.now() });
    check('目录记录带 path', !!(await DB.listDirs()).find(d => d.id === dirId).path);

    // ---- 2. 首次扫描 ----
    const t0 = Date.now();
    const rep = await SCAN.scanAll({ dirId });
    info.scanMs = Date.now() - t0;
    info.report = { added: rep.added, updated: rep.updated, removed: rep.removed, error: rep.error ? String(rep.error) : null };
    check('扫描无异常', !rep.error, info.report.error);
    check('扫到了照片', rep.added > 0, 'added=' + rep.added);

    const photos = (await DB.allPhotos()).filter(p => p.dirId === dirId);
    check('索引里的照片数与报告一致', photos.length === rep.added, photos.length + ' vs ' + rep.added);

    if (!photos.length) return { ok: false, failed, info };

    // ---- 3. 元数据：大小 / mtime / 尺寸 / EXIF ----
    const noSize = photos.filter(p => !(p.size > 0));
    check('每张都有真实大小', noSize.length === 0, noSize.length + ' 张缺 size');
    const noMtime = photos.filter(p => !(p.mtime > 0));
    check('每张都有 mtime', noMtime.length === 0, noMtime.length + ' 张缺 mtime');

    const jpgs = photos.filter(p => !p.isRaw);
    const noDims = jpgs.filter(p => !(p.width > 0 && p.height > 0));
    info.dims = {
      total: jpgs.length,
      missing: noDims.length,
      sample: jpgs[0] ? { name: jpgs[0].name, w: jpgs[0].width, h: jpgs[0].height } : null,
    };
    check('JPEG 都解析出尺寸', noDims.length === 0, noDims.slice(0, 3).map(p => p.name).join(', '));

    const withExif = jpgs.filter(p => p.model || p.date);
    info.exif = {
      withMeta: withExif.length,
      of: jpgs.length,
      withModel: jpgs.filter(p => p.model).length,
      withGps: jpgs.filter(p => p.gps && p.gps.lat != null).length,
    };
    check('至少一张读到 EXIF', withExif.length > 0);
    // 这两条是「EXIF 静默失败」的哨兵：桌面端曾把伪 Blob 交给 exifr，
    // exifr 只认真 Blob，结果全部解析失败、拍摄时间退化用文件 mtime，界面看起来却有数据。
    check('EXIF 读到器材型号', jpgs.some(p => p.model), 'model 全为空');
    check('拍摄时间来自 EXIF 而非文件时间',
      jpgs.some(p => p.date && p.mtime && Math.abs(p.date - p.mtime) > 1000),
      '所有照片的拍摄时间都等于 mtime');

    // ---- 4. 缩略图：解码 + 编码 + 落库 ----
    const p0 = jpgs[0] || photos[0];
    const a = await SCAN.ensureAssets(p0, 'thumb');
    info.thumb = {
      name: p0.name,
      ok: !!(a && a.thumb),
      bytes: a && a.thumb ? a.thumb.size : 0,
      error: a && a.error ? a.error : null,
    };
    check('生成缩略图', !!(a && a.thumb), JSON.stringify(info.thumb));
    if (a && a.thumb) {
      check('缩略图非空', a.thumb.size > 0);
      const back = await DB.getAssets(p0.id);
      check('缩略图落库', !!(back && back.thumb));
    }

    // ---- 5. 原图：covefile:// 直读，长度应与磁盘一致 ----
    const url = await SCAN.originalUrl(p0);
    info.originalUrl = url ? url.slice(0, 60) : null;
    check('原图给的是 covefile://', !!(url && url.indexOf('covefile://') === 0), String(url).slice(0, 80));
    if (url && url.indexOf('covefile://') === 0) {
      const resp = await fetch(url);
      const buf = await resp.arrayBuffer();
      check('covefile 响应成功', resp.ok, 'status=' + resp.status);
      check('covefile 字节数与磁盘一致', buf.byteLength === p0.size, buf.byteLength + ' vs ' + p0.size);
    }

    // ---- 6. 子目录里的文件也能按相对路径打开 ----
    const nested = photos.find(p => p.relPath.indexOf('/') >= 0);
    if (nested) {
      const f = await PLATFORM.openFile({ path: dir }, nested.relPath).catch(e => null);
      check('子目录文件可读', !!(f && f.size === nested.size), nested.relPath);
      info.nested = nested.relPath;
    }

    // ---- 7. 再扫一次：应当完全无变化（增量比对依赖 size + mtime） ----
    const rep2 = await SCAN.scanAll({ dirId });
    info.rescan = { added: rep2.added, updated: rep2.updated, removed: rep2.removed };
    check('二次扫描无新增', rep2.added === 0, 'added=' + rep2.added);
    check('二次扫描无更新', rep2.updated === 0, 'updated=' + rep2.updated);

    // ---- 8. 地图页要用到的 GPS 字段 ----
    const gpsOnes = photos.filter(p => p.gps && p.gps.lat != null);
    info.gps = { count: gpsOnes.length, sample: gpsOnes[0] ? gpsOnes[0].gps : null };

    return { ok: failed.length === 0, failed, info };
  } catch (e) {
    return { ok: false, failed, info, error: (e && e.stack) || String(e) };
  } finally {
    // 自测数据不留在用户库里；顺带扫掉以前被中断（超时/崩溃）留下的同类残留，
    // 否则设置页会多出几个名字奇怪的目录行。
    try {
      const dirs = await DB.listDirs();
      for (const d of dirs) {
        if (d.id !== dirId && !/^__(selftest|shot)__/.test(d.name || '')) continue;
        const ps = (await DB.allPhotos()).filter(p => p.dirId === d.id);
        for (const p of ps) {
          try { await DB.deleteAssets(p.id); } catch (e) { /* ignore */ }
          try { await DB.deletePhoto(p.id); } catch (e) { /* ignore */ }
        }
        await DB.removeDir(d.id);
      }
      await wait(50);
    } catch (e) { /* ignore */ }
  }
}
