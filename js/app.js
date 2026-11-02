/* app.js — 启动、设置页、后台扫描编排 */
'use strict';

(() => {
  const $ = s => document.querySelector(s);

  /* ============ 主题 ============ */
  async function applyTheme() {
    const t = await DB.getSetting('theme', 'dark');
    document.documentElement.dataset.theme = t;
    document.querySelectorAll('#theme-group .seg-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.theme === t);
    });
  }

  /* ============ 兼容性检测 ============ */
  function checkCompat() {
    if (!window.showDirectoryPicker || !window.indexedDB) {
      $('#compat-banner').classList.remove('hidden');
      return false;
    }
    return true;
  }

  /* ============ 全局提示条 ============ */
  let toastTimer = null;
  function toast(msg, sticky) {
    const el = $('#toast');
    if (!el) { console.log('[toast]', msg); return; }   // 元素缺失时不能让异常中断调用方
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => el.classList.add('hidden'), 3800);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    const el = $('#toast');
    if (el) el.classList.add('hidden');
  }

  /* ============ 未捕获错误可见化 ============
   * 之前任何脚本异常都只在控制台里躺着，界面表现为"点了没反应"，
   * 完全无法排查。这里把它顶到页面上，用户一眼能看到发生了什么。 */
  const _shownErrors = new Set();
  function showErrorBanner(msg) {
    const text = String(msg || '').slice(0, 300);
    if (!text || _shownErrors.has(text) || _shownErrors.size >= 3) return;
    _shownErrors.add(text);
    const el = document.createElement('div');
    el.className = 'banner banner-warn';
    el.style.position = 'relative';
    el.innerHTML = `<b>页面脚本出错：</b>${text.replace(/[<>]/g, '')}`
      + '<button class="btn btn-small btn-ghost" style="margin-left:12px">关闭</button>';
    el.querySelector('button').addEventListener('click', () => el.remove());
    document.body.insertBefore(el, document.body.firstChild);
  }
  window.addEventListener('error', e => showErrorBanner(e.message || (e.error && e.error.message)));
  window.addEventListener('unhandledrejection', e => {
    const r = e.reason;
    showErrorBanner((r && r.message) || r || '未知的异步错误');
  });

  const sw = {
    show() { $('#scan-widget').classList.remove('hidden'); },
    hide() { $('#scan-widget').classList.add('hidden'); },
    head(t) { $('#sw-title').textContent = t; },
    dir(t) { $('#sw-dir').textContent = t || ''; },
    bar(ratio) { $('#sw-fill').style.width = Math.round(Math.min(1, Math.max(0, ratio)) * 100) + '%'; },
    detail(t) { $('#sw-detail').textContent = t || ''; },
  };
  function setStatus(msg) { $('#scan-status').textContent = msg || ''; }

  /* ============ 确认对话框 ============
   * 用页面内对话框替代 window.confirm：样式跟随主题、内容可排版，
   * 也不会在某些内嵌/应用模式（PWA）下被浏览器静默忽略。 */
  function confirmDialog(opts = {}) {
    const { title = '确认操作', message = '', okText = '确定', cancelText = '取消', danger = true } = opts;
    const overlay = $('#confirm-overlay');
    const ok = $('#confirm-ok');
    const cancel = $('#confirm-cancel');

    $('#confirm-title').textContent = title;
    $('#confirm-msg').textContent = message;
    ok.textContent = okText;
    cancel.textContent = cancelText;
    ok.className = 'btn' + (danger ? ' btn-danger' : '');
    overlay.classList.remove('hidden');
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return new Promise(resolve => {
      const done = (val) => {
        overlay.classList.add('hidden');
        document.body.style.overflow = prevOverflow;
        document.removeEventListener('keydown', onKey, true);
        overlay.removeEventListener('click', onBackdrop);
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        resolve(val);
      };
      const onOk = () => done(true);
      const onCancel = () => done(false);
      const onBackdrop = (e) => { if (e.target === overlay) done(false); };
      const onKey = (e) => {
        if (overlay.classList.contains('hidden')) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
        else if (e.key === 'Enter') {
          e.preventDefault(); e.stopPropagation();
          done(document.activeElement === cancel ? false : true);
        }
      };
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
      overlay.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey, true);
      cancel.focus();
    });
  }

  /* ============ 目录授权 ============
   * 授权状态按目录 id 记在 permMap 里。
   * 旧实现用对象引用比较（needsPermDirs.includes(t)），而 DB.listDirs() 每次都返回
   * 全新的对象，includes 永远 false —— 未授权目录从没被拦下，扫描于是全部读文件失败。
   * 另外浏览器每个会话都可能收回读权限，所以授权入口必须常驻在设置页，不能只靠顶部横幅。 */
  let permMap = new Map();        // dirId -> 'granted' | 'prompt' | 'denied'
  let _dirsCache = [];            // 当前目录列表（含句柄），供按钮在用户手势内同步取用

  function permOf(id) { return permMap.get(id) || 'denied'; }
  function isGranted(id) { return permOf(id) === 'granted'; }
  function ungrantedDirs() { return _dirsCache.filter(d => !isGranted(d.id)); }

  async function refreshPermissions(dirs) {
    let list = dirs;
    if (!list) { try { list = await DB.listDirs(); } catch (e) { list = []; } }
    _dirsCache = list;
    const next = new Map();
    for (const d of list) {
      let perm = 'denied';
      try { perm = await SCAN.dirPermission(d.handle); } catch (e) { perm = 'denied'; }
      next.set(d.id, perm === 'granted' ? 'granted' : perm);
    }
    permMap = next;
    paintPermUI();
    return ungrantedDirs().length === 0;
  }

  /* 顶部横幅 + 设置页授权条 + 导航红点，三处同步 */
  function paintPermUI() {
    const pending = ungrantedDirs().length;
    const banner = $('#perm-banner');
    if (banner) banner.classList.toggle('hidden', pending === 0);

    const text = $('#dir-perm-text');
    const btn = $('#grant-all');
    if (text) {
      if (!_dirsCache.length) {
        text.textContent = '还没有添加图片库目录';
        text.className = 'dir-perm-text';
      } else if (pending) {
        text.innerHTML = `有 <b>${pending}</b> 个目录未授权，照片无法读取（浏览器<b>完全退出</b>后会收回权限，按 F5 刷新不影响）`;
        text.className = 'dir-perm-text warn';
      } else {
        text.innerHTML = `全部 ${_dirsCache.length} 个目录已授权，可以正常读取照片`;
        text.className = 'dir-perm-text ok';
      }
    }
    if (btn) btn.classList.toggle('hidden', pending === 0);

    // 设置页导航加未授权标记，避免用户在当前页面找不到入口
    const nav = document.querySelector('.nav-btn[data-view="settings"]');
    if (nav) {
      nav.classList.toggle('has-alert', pending > 0);
      nav.title = pending > 0 ? `${pending} 个图片库目录需要授权` : '';
    }
  }

  /* 兼容旧调用：只回答"是否全部已授权" */
  async function checkPermissions() {
    return refreshPermissions();
  }

  /* 在用户手势内请求授权。必须第一句就调 requestPermission，
   * 中间不能 await IndexedDB，否则浏览器会认为不是用户主动操作而直接拒绝。
   * 返回 { ok, broken }：broken 表示句柄本身已失效（改名/移动/清过站点数据），
   * 这种情况下点多少次都不会弹询问框，只能移除后重新添加目录。 */
  async function requestDirPermission(handle) {
    if (!handle || typeof handle.requestPermission !== 'function') return { ok: false, broken: true };
    try {
      const p = await handle.requestPermission({ mode: 'read' });
      return { ok: p === 'granted', broken: false };
    } catch (e) {
      return { ok: false, broken: true };
    }
  }

  async function grantOne(dir) {
    const r = await requestDirPermission(dir.handle);
    await refreshPermissions();
    await renderDirList();
    await renderStorageInfo().catch(() => {});
    if (r.ok) {
      SCAN.clearMem();
      SCAN.clearFailed();
      await VIEWS.reload().catch(() => {});
      toast(`「${dir.name}」已授权，正在重新加载照片`);
    } else if (r.broken) {
      toast(`「${dir.name}」的目录句柄已失效（目录被改名/移动，或清理过浏览器数据）。请点该目录的「移除」后重新添加`, true);
    } else {
      toast(`「${dir.name}」未获得授权。若没弹出询问框，点浏览器地址栏左侧的图标，把文件访问权限改为允许后重试`, true);
    }
    return r.ok;
  }

  async function grantAll() {
    const pending = ungrantedDirs();
    if (!pending.length) { toast('所有目录已授权'); return; }
    const btn = $('#grant-all');
    if (btn) { btn.disabled = true; btn.textContent = '授权中…'; }
    let okCount = 0, brokenCount = 0;
    try {
      // 浏览器会逐个弹询问框，必须按顺序来
      for (const d of pending) {
        const r = await requestDirPermission(d.handle);
        if (r.ok) okCount++;
        else if (r.broken) brokenCount++;
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '授权全部目录'; }
      await refreshPermissions();
      await renderDirList();
      await renderStorageInfo().catch(() => {});
      SCAN.clearMem();
      SCAN.clearFailed();
      await VIEWS.reload().catch(() => {});
    }
    const left = ungrantedDirs().length;
    if (left === 0) toast(`已授权 ${okCount} 个目录，正在重新加载照片`);
    else if (brokenCount === left) toast(`${brokenCount} 个目录的句柄已失效（改名/移动/清过浏览器数据），请逐个「移除」后重新添加`, true);
    else toast(`已授权 ${okCount} 个，仍有 ${left} 个未授权。可在每个目录右侧单独点「授权」重试`, true);
  }

  /* ============ 设置页：目录管理 ============ */
  async function renderDirList() {
    const dirs = await DB.listDirs();
    _dirsCache = dirs;
    const counts = await DB.countPhotosByDir();
    const ul = $('#dir-list');
    ul.innerHTML = '';
    if (!dirs.length) {
      ul.innerHTML = '<li><span class="dir-stats" style="text-align:left;">尚未添加任何图片库</span></li>';
      paintPermUI();
      return;
    }
    dirs.forEach(d => {
      const granted = isGranted(d.id);
      const li = document.createElement('li');
      li.className = 'dir-row' + (granted ? '' : ' dir-row-warn');

      const main = document.createElement('div');
      main.className = 'dir-main';
      const name = document.createElement('span');
      name.className = 'dir-name';
      name.textContent = d.name;
      name.title = d.name;
      const badge = document.createElement('span');
      badge.className = 'dir-badge ' + (granted ? 'ok' : 'warn');
      badge.textContent = granted ? '已授权' : '未授权';
      main.appendChild(name);
      main.appendChild(badge);

      const actions = document.createElement('div');
      actions.className = 'dir-actions';
      const stats = document.createElement('span');
      stats.className = 'dir-stats';
      stats.textContent = `${counts[d.id] || 0} 张`;
      actions.appendChild(stats);

      if (!granted) {
        const grant = document.createElement('button');
        grant.className = 'btn btn-small dir-grant';
        grant.textContent = '授权';
        grant.disabled = _scanning;
        grant.addEventListener('click', () => { grantOne(d).catch(e => toast('授权失败：' + (e && e.message || e))); });
        actions.appendChild(grant);
      }

      const scan = document.createElement('button');
      scan.className = 'btn btn-small dir-scan' + (granted ? '' : ' btn-ghost');
      scan.textContent = '扫描';
      scan.disabled = _scanning;
      if (!granted) scan.title = '该目录尚未授权，点「授权」后才能读取照片';
      scan.addEventListener('click', () => { runScan({ dirId: d.id }); });

      const del = document.createElement('button');
      del.className = 'btn btn-small btn-ghost';
      del.textContent = '移除';
      del.disabled = _scanning;
      del.addEventListener('click', async () => {
        const n = counts[d.id] || 0;
        const ok = await confirmDialog({
          title: '移除图片库',
          message: `确定要移除「${d.name}」吗？\n\n会删除本站为该目录建立的索引和缩略图${n ? `（共 ${n} 张）` : ''}。\n原文件夹及里面的照片不会被修改或删除，之后重新添加该目录即可再次扫描。`,
          okText: '移除',
        });
        if (!ok) return;
        await DB.removeDir(d.id);
        SCAN.resetDirCache();
        await refreshPermissions();
        await renderDirList();
        await VIEWS.reload();
      });

      actions.appendChild(scan);
      actions.appendChild(del);
      li.appendChild(main);
      li.appendChild(actions);
      ul.appendChild(li);
    });
    paintPermUI();
  }

  /* 扫描期间禁用所有扫描相关按钮，结束后恢复 */
  function setScanBusy(busy) {
    document.querySelectorAll('.dir-scan').forEach(b => { b.disabled = busy; });
    document.querySelectorAll('.dir-grant').forEach(b => { b.disabled = busy; });
    const all = $('#rescan-all');
    if (all) all.disabled = busy;
    const grantAllBtn = $('#grant-all');
    if (grantAllBtn) grantAllBtn.disabled = busy;
    const raw = $('#rescan-raw');
    if (raw && !raw.classList.contains('hidden')) raw.disabled = busy;
  }

  async function addDirectory() {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' });
      const existing = await DB.listDirs();
      const dup = existing.find(d => d.handle.name === handle.name && d.handle.kind === 'directory');
      if (dup) { toast(`目录「${handle.name}」已在列表中`); return; }
      const newId = await DB.addDir({ name: handle.name, handle, addedAt: Date.now() });
      // 刚添加的目录自带读权限，先刷新授权表，否则会误显示「未授权」
      await refreshPermissions();
      await renderDirList();
      toast(`已添加「${handle.name}」，开始扫描…`);
      runScan({ dirId: newId });
    } catch (e) {
      if (e && e.name !== 'AbortError') console.warn(e);
    }
  }

  /* ============ 后台扫描编排 ============ */
  let abortFlag = false;
  let _scanning = false;
  let _reloadQueued = false;
  async function incrementalReload() {
    // 防抖：扫描期间每 1.5s 最多刷新一次视图，让照片边扫边出现
    if (_reloadQueued) return;
    _reloadQueued = true;
    setTimeout(async () => {
      _reloadQueued = false;
      await VIEWS.reload();
    }, 1500);
  }

  async function runScan(opts = {}) {
    if (window.showDirectoryPicker === undefined) return;
    const dirs = await DB.listDirs();
    if (!dirs.length) { setStatus(''); return; }
    const targets = opts.dirId != null ? dirs.filter(d => d.id === opts.dirId) : dirs;
    if (!targets.length) return;

    // 权限：只要求本次目标目录已授权（按 id 判断，不能按对象引用）
    await refreshPermissions(dirs);
    const blocked = targets.filter(t => !isGranted(t.id));
    if (blocked.length) {
      setStatus('等待授权');
      const names = blocked.map(d => `「${d.name}」`).join('');
      toast(`${names}未授权，扫描读不到文件。已切到设置页，点「授权全部目录」即可`, true);
      const nav = document.querySelector('.nav-btn[data-view="settings"]');
      if (nav && !nav.classList.contains('active')) nav.click();
      await renderDirList();          // 让每个未授权目录行立刻出现「授权」按钮
      const bar = $('#dir-perm-bar');
      if (bar) {
        bar.classList.add('flash');
        setTimeout(() => bar.classList.remove('flash'), 1600);
        if (typeof bar.scrollIntoView === 'function') bar.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      return;
    }

    abortFlag = false;
    _scanning = true;
    setScanBusy(true);
    setStatus('扫描中…');
    sw.show();
    sw.head('正在扫描');
    sw.dir(targets.length === 1 ? targets[0].name : `共 ${targets.length} 个图片库`);
    sw.bar(0);
    sw.detail('准备中…');

    let report;
    try {
      report = await SCAN.scanAll({
        dirId: opts.dirId,
        shouldAbort: () => abortFlag,
        onProgress: (dirName, done, total, rep) => {
          setStatus(`扫描中… ${done}/${total}（${dirName}）`);
          sw.dir(dirName);
          sw.bar(done / Math.max(1, total));
          sw.detail(`已登记 ${rep.added + rep.updated} 张新/变更照片`);
        },
        onBatch: () => incrementalReload(),
      });
    } finally {
      _scanning = false;
      setScanBusy(false);
      await renderDirList();   // 无论完成/取消/出错，都刷新目录张数
    }

    sw.bar(1);
    const changed = report.added + report.updated + report.removed;
    if (report.error) {
      sw.head('扫描出错');
      sw.dir('');
      sw.detail(String(report.error && report.error.message || report.error));
      setTimeout(() => sw.hide(), 5000);
    } else if (report.aborted) {
      sw.head('已取消');
      sw.dir('');
      sw.detail(changed > 0 ? `已入库部分结果：新增 ${report.added} · 更新 ${report.updated}` : '未处理任何新照片');
      setStatus('');
      setTimeout(() => sw.hide(), 4000);
    } else if (changed > 0) {
      await VIEWS.reload();
      sw.head('扫描完成');
      sw.dir('');
      sw.detail(`新增 ${report.added} · 更新 ${report.updated} · 移除 ${report.removed}`);
      setStatus('已就绪');
      setTimeout(() => sw.hide(), 4000);
    } else {
      sw.head('扫描完成');
      sw.dir('');
      sw.detail('没有发现变化');
      setStatus('已就绪');
      setTimeout(() => sw.hide(), 2500);
    }
    if (report.skippedDirs && report.skippedDirs.length) {
      await checkPermissions();
      sw.detail('部分目录等待授权：到「设置 → 图片库目录」点「授权全部目录」');
    }
  }

  /* ============ 设置页：存储诊断 ============ */
  function fmtBytes(n) {
    if (!n) return '0';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i];
  }

  /* 浏览器是否已把本站存储标记为「持久化」。null = 尚未查明 */
  let _persisted = null;

  /* 存储状态：只报当前占用（浏览器配额不显示，避免被当成"本站设的上限"） */
  async function renderStorageInfo() {
    const el = $('#storage-info');
    if (!el) return;
    try {
      const st = await DB.stats();
      const dirs = await DB.listDirs();
      if (permMap.size !== dirs.length) await refreshPermissions(dirs).catch(() => {});
      const granted = dirs.filter(d => isGranted(d.id)).length;
      const fmt = n => (n || 0).toLocaleString('zh-CN');
      const lines = [
        `照片记录 <b>${fmt(st.total)}</b> · 缩略图缓存 <b>${fmt(st.assets)}</b>`,
        `待生成 ${fmt(st.pending)} · 失败 ${fmt(st.error)} · 不可用 ${fmt(st.unavailable)}`,
        `目录授权 ${granted}/${dirs.length}`,
      ];

      const se = await DB.storageEstimate();
      if (se) lines.push(`当前占用 <b>${fmtBytes(se.usage)}</b>`);
      if (_persisted === true) {
        lines.push('存储保护 <b>已开启</b> <span class="diag-dim">浏览器不会自动清理本站缓存</span>');
      } else if (_persisted === false) {
        lines.push('存储保护 <b>未开启</b> <span class="diag-dim">磁盘紧张时可能被清理</span>');
      }
      if (SCAN.storageError()) lines.push('<span class="diag-warn">最近一次缩略图写库失败，多半是磁盘空间不足或浏览器清理了本站数据</span>');
      el.innerHTML = lines.join('<br>');
    } catch (e) {
      el.textContent = '无法读取存储状态：' + (e && e.message || e);
    }
  }

  /* ============ 设置页其余控件 ============ */
  function bindSettings() {
    $('#add-dir').addEventListener('click', addDirectory);

    // 扫描浮卡：取消按钮
    $('#sw-cancel').addEventListener('click', () => {
      abortFlag = true;
      sw.head('正在取消…');
      sw.detail('等待当前文件处理完毕');
    });

    // 主题
    document.querySelectorAll('#theme-group .seg-btn').forEach(b => {
      b.addEventListener('click', async () => {
        await DB.setSetting('theme', b.dataset.theme);
        applyTheme();
      });
    });

    // RAW 开关
    DB.getSetting('rawEnabled', false).then(v => {
      $('#raw-toggle').checked = !!v;
      $('#rescan-raw').classList.toggle('hidden', !v);
      SCAN.setRawEnabled(v);
    }).catch(() => {});
    $('#raw-toggle').addEventListener('change', async e => {
      await DB.setSetting('rawEnabled', e.target.checked);
      SCAN.setRawEnabled(e.target.checked);
      $('#rescan-raw').classList.toggle('hidden', !e.target.checked);
      if (e.target.checked) toast('RAW 支持已开启，点击「重建 RAW 索引」处理已有的 RAW 文件');
    });
    $('#rescan-raw').addEventListener('click', async () => {
      if (_scanning) return;
      const photos = await DB.allPhotos();
      const hasRaw = photos.some(p => p.isRaw);
      if (!hasRaw) { toast('当前图片库里没有 RAW 文件'); return; }
      toast('正在重建 RAW 索引…', true);
      const rep = await SCAN.rescanRaw({});
      await VIEWS.reload();
      await renderDirList();
      hideToast();
      toast(`RAW 索引重建完成：登记 ${rep.processed} 个文件，打开照片时按需生成预览`);
    });

    // 维护
    $('#rescan-all').addEventListener('click', () => runScan());
    $('#clear-db').addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '清空本地索引',
        message: '确定清空本地索引？\n\n所有缩略图、预览和照片记录都会被删除，图片库目录列表会保留。\n原图不受影响，之后点各目录的「扫描」即可重建。',
        okText: '清空',
      });
      if (!ok) return;
      await DB.clearPhotos();
      await VIEWS.reload();
      await renderDirList();
      toast('本地索引已清空');
    });

    // 重新检查：刷新页面不会重置权限（权限跟着浏览器进程走），
    // 但用户可能在地址栏改过权限、或插拔过外接盘，这里给一个手动核对入口。
    let _rechecking = false;
    $('#perm-recheck').addEventListener('click', async () => {
      if (_rechecking) return;
      _rechecking = true;
      const btn = $('#perm-recheck');
      if (btn) { btn.disabled = true; btn.textContent = '检查中…'; }
      try {
        await refreshPermissions();
        await renderDirList();
        renderStorageInfo().catch(() => {});
        SCAN.clearMem();
        SCAN.clearFailed();
        await VIEWS.reload().catch(() => {});
        const n = ungrantedDirs().length;
        toast(n === 0
          ? `已重新核对：${_dirsCache.length} 个目录均可正常读取`
          : `重新核对完成：仍有 ${n} 个目录未授权，点「授权全部目录」处理`);
      } catch (e) {
        toast('重新检查失败：' + (e && e.message || e));
      } finally {
        _rechecking = false;
        if (btn) { btn.disabled = false; btn.textContent = '重新检查'; }
      }
    });

    // 授权：设置页常驻按钮 + 顶部横幅按钮，都走同一套逻辑（只恢复权限，不触发扫描）
    const onGrant = () => { grantAll().catch(e => toast('授权失败：' + (e && e.message || e))); };
    $('#grant-all').addEventListener('click', onGrant);
    $('#perm-grant').addEventListener('click', onGrant);
  }

  /* ============ 启动 ============ */
  function showFatal(e) {
    console.error(e);
    const el = document.createElement('div');
    el.className = 'banner banner-warn';
    el.innerHTML = '本地索引打开失败（可能是索引版本升级、存储空间不足，或另一个标签页正占用着本页面）。'
      + '请关闭其他标签页后刷新；仍不行就到「设置 → 维护 → 清空本地索引」，再对各目录重新扫描。'
      + `<br><span style="opacity:.7;font-size:12px">${String(e && e.message || e)}</span>`;
    document.body.insertBefore(el, document.body.firstChild);
  }

  async function boot() {
    if (!checkCompat()) return;
    // 申请持久化存储：否则浏览器在磁盘紧张时可能直接回收我们的缩略图库，
    // 表现就是"某天打开突然全空白"。是否批准由浏览器决定（装成应用/加书签后更容易批）。
    // 结果记到 _persisted，供「存储状态」显示，让用户知道缓存受不受保护。
    (async () => {
      try {
        if (!navigator.storage) { _persisted = false; return; }
        if (navigator.storage.persisted) _persisted = !!(await navigator.storage.persisted());
        if (!_persisted && navigator.storage.persist) {
          await navigator.storage.persist();
          if (navigator.storage.persisted) _persisted = !!(await navigator.storage.persisted());
        }
      } catch (e) {
        _persisted = false;
      } finally {
        // 稍等一下再渲染：让 boot 先把数据库打开，避免并发 open 与"检查中"闪现
        setTimeout(() => { renderStorageInfo().catch(() => {}); }, 300);
      }
    })();
    VIEWS.init();
    applyTheme().catch(() => {});
    // 必须先确认授权状态再渲染：未授权时渲染会让每张缩略图解码立即失败，
    // 旧版本正是在这里把状态写成「不可用」并落库，导致照片永远空白。
    await checkPermissions().catch(() => {});
    try {
      await VIEWS.reload();          // 直接渲染上次扫描结果，秒开
    } catch (e) {
      showFatal(e);
    }
    renderDirList().catch(() => {});
    bindSettings();
    renderStorageInfo().catch(() => {});
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
