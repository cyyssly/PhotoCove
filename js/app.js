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

  /* ============ 环境检测 ============
   * 只认桌面壳：preload 注入的 window.__COVE_DESKTOP 在，磁盘访问层才有实现。
   * 浏览器里打开的情况已由 index.html 的引导层挡下，这里再兜一次底。 */
  function checkCompat() {
    return !!window.__COVE_DESKTOP && !!window.indexedDB;
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

  /* ============ 页内确认框 ============
   * 用页面内对话框替代 window.confirm：样式跟随主题、内容可排版，
   * 也不会在窗口失焦等情况下被静默忽略。确定返回 true，取消返回 false。 */
  function confirmDialog(opts = {}) {
    const {
      title = '确认操作', message = '', okText = '确定', cancelText = '取消', danger = true,
    } = opts;
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
          done(document.activeElement !== cancel);
        }
      };
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
      overlay.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey, true);
      cancel.focus();
    });
  }

  /* ============ 路径工具 ============
   * 地图页要把「图片库根路径 + 相对子目录」拼成本机绝对路径交给 GPSStamp，
   * 这里是那两处共用的拼接与规范化。 */
  function normDir(p) {
    return String(p == null ? '' : p).trim()
      .replace(/^["']+|["']+$/g, '')   // 粘贴时常常带引号
      .replace(/[\\/]+$/, '');          // 去掉结尾斜杠
  }
  function joinPath(base, rel) {
    const b = normDir(base);
    const r = String(rel || '').replace(/^[\\/]+/, '').replace(/\//g, '\\');
    return r ? b + '\\' + r : b;
  }

  /* 唤起本机 GPSStamp：直接起进程，带 --missing-only，只载入缺 GPS 的照片。 */
  function launchGpsStamp(folder) {
    let pr = null;
    try {
      pr = PLATFORM.launchGpsStamp(folder);
    } catch (e) {
      toast('无法启动 GPSStamp：' + (e && e.message || e), true);
      return;
    }
    if (pr && typeof pr.then === 'function') {
      pr.then(r => {
        if (r && r.ok === false) { toast('无法启动 GPSStamp：' + (r.error || '未知原因'), true); return; }
        toast('已打开 GPSStamp，只载入了该文件夹里没有 GPS 的照片');
      }).catch(e => toast('无法启动 GPSStamp：' + (e && e.message || e), true));
    }
  }

  /* ============ 目录可读性 ============
   * 桌面端没有"授权"这回事，这里回答的是"这个目录现在还能不能读"——
   * 外接盘被拔掉、文件夹被改名或挪走，都会让目录变成不可读。
   *
   * 状态按目录 id 记在 readableMap 里，不按对象引用比对：
   * DB.listDirs() 每次都返回全新的对象，`includes` 永远 false（v7 踩过这个坑）。 */
  let readableMap = new Map();    // dirId -> true | false
  let _dirsCache = [];            // 当前目录列表，供按钮在回调里取用

  function isReadable(id) { return readableMap.get(id) === true; }
  function unreadableDirs() { return _dirsCache.filter(d => !isReadable(d.id)); }

  async function refreshReadable(dirs) {
    let list = dirs;
    if (!list) { try { list = await DB.listDirs(); } catch (e) { list = []; } }
    _dirsCache = list;
    const next = new Map();
    for (const d of list) {
      let ok = false;
      try { ok = (await SCAN.dirPermission(d)) === 'granted'; } catch (e) { ok = false; }
      next.set(d.id, ok);
    }
    readableMap = next;
    paintDirState();
    return unreadableDirs().length === 0;
  }

  /* 设置页状态条 + 设置标签上的红点，两处同步 */
  function paintDirState() {
    const pending = unreadableDirs().length;
    const text = $('#dir-perm-text');
    if (text) {
      if (!_dirsCache.length) {
        text.textContent = '还没有添加图片库目录';
        text.className = 'dir-perm-text';
      } else if (pending) {
        text.innerHTML = `有 <b>${pending}</b> 个目录当前读不到：盘没连接，或文件夹被改名/移动了`;
        text.className = 'dir-perm-text warn';
      } else {
        text.innerHTML = `${_dirsCache.length} 个目录可正常读取`;
        text.className = 'dir-perm-text ok';
      }
    }
    // 设置页导航加标记，避免用户在当前页面找不到入口
    const nav = document.querySelector('.nav-btn[data-view="settings"]');
    if (nav) {
      nav.classList.toggle('has-alert', pending > 0);
      nav.title = pending > 0 ? `${pending} 个目录读不到` : '';
    }
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
      paintDirState();
      return;
    }
    dirs.forEach(d => {
      const readable = isReadable(d.id);
      const li = document.createElement('li');
      li.className = 'dir-row' + (readable ? '' : ' dir-row-warn');

      const main = document.createElement('div');
      main.className = 'dir-main';
      const line = document.createElement('div');
      line.className = 'dir-line';
      const name = document.createElement('span');
      name.className = 'dir-name';
      name.textContent = d.name;
      name.title = d.name;
      const badge = document.createElement('span');
      badge.className = 'dir-badge ' + (readable ? 'ok' : 'warn');
      badge.textContent = readable ? '可读取' : '不可用';
      line.appendChild(name);
      line.appendChild(badge);
      main.appendChild(line);

      const pathEl = document.createElement('span');
      pathEl.className = 'dir-path' + (d.path ? '' : ' unset');
      pathEl.textContent = d.path || '记录里没有本机路径，请「移除」后重新添加该目录';
      pathEl.title = d.path || '';
      main.appendChild(pathEl);

      const actions = document.createElement('div');
      actions.className = 'dir-actions';
      const stats = document.createElement('span');
      stats.className = 'dir-stats';
      stats.textContent = `${counts[d.id] || 0} 张`;
      actions.appendChild(stats);

      const scan = document.createElement('button');
      scan.className = 'btn btn-small dir-scan' + (readable ? '' : ' btn-ghost');
      scan.textContent = '扫描';
      scan.disabled = _scanning;
      if (!readable) scan.title = '该文件夹当前读不到：盘未连接、或被改名/移动了';
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
        await refreshReadable();
        await renderDirList();
        await VIEWS.reload();
      });

      actions.appendChild(scan);
      actions.appendChild(del);
      li.appendChild(main);
      li.appendChild(actions);
      ul.appendChild(li);
    });
    paintDirState();
  }

  /* 扫描期间禁用所有扫描相关按钮，结束后恢复 */
  function setScanBusy(busy) {
    document.querySelectorAll('.dir-scan').forEach(b => { b.disabled = busy; });
    const all = $('#rescan-all');
    if (all) all.disabled = busy;
    const raw = $('#rescan-raw');
    if (raw && !raw.classList.contains('hidden')) raw.disabled = busy;
  }

  /* 添加图片库：系统目录对话框，选完顺带就拿到绝对路径。 */
  async function addDirectory() {
    try {
      const picked = await PLATFORM.pickDirectory();
      if (!picked) return;                      // 用户取消
      const existing = await DB.listDirs();
      if (existing.some(d => PLATFORM.isSameDir(d, picked))) {
        toast(`目录「${picked.name}」已在列表中`);
        return;
      }
      const rec = Object.assign(PLATFORM.newDirRecord(picked), { addedAt: Date.now() });
      const newId = await DB.addDir(rec);
      // 刚选完的目录一定是可读的，但仍要刷新一次状态表，否则目录行会先闪一下「不可用」
      await refreshReadable();
      await renderDirList();
      toast(`已添加「${picked.name}」，开始扫描…`);
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
    const dirs = await DB.listDirs();
    if (!dirs.length) { setStatus(''); return; }
    const targets = opts.dirId != null ? dirs.filter(d => d.id === opts.dirId) : dirs;
    if (!targets.length) return;

    // 只要求本次目标目录当前可读（按 id 判断，不能按对象引用）
    await refreshReadable(dirs);
    const blocked = targets.filter(t => !isReadable(t.id));
    if (blocked.length) {
      const names = blocked.map(d => `「${d.name}」`).join('');
      setStatus('目录不可用');
      toast(`${names}当前读不到：盘未连接，或文件夹被改名/移动了。插回盘后点「重新检查」即可`, true);
      const nav = document.querySelector('.nav-btn[data-view="settings"]');
      if (nav && !nav.classList.contains('active')) nav.click();
      await renderDirList();
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
      await refreshReadable();
      sw.detail('部分目录读不到：盘未连接，或文件夹被改名/移动了');
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

  /* 存储状态：只报当前占用（浏览器配额不显示，避免被当成"本站设的上限"） */
  async function renderStorageInfo() {
    const el = $('#storage-info');
    if (!el) return;
    try {
      const st = await DB.stats();
      const dirs = await DB.listDirs();
      if (readableMap.size !== dirs.length) await refreshReadable(dirs).catch(() => {});
      const readable = dirs.filter(d => isReadable(d.id)).length;
      const fmt = n => (n || 0).toLocaleString('zh-CN');
      const lines = [
        `照片记录 <b>${fmt(st.total)}</b> · 缩略图缓存 <b>${fmt(st.assets)}</b>`,
        `待生成 ${fmt(st.pending)} · 失败 ${fmt(st.error)} · 不可用 ${fmt(st.unavailable)}`,
        `目录可读取 ${readable}/${dirs.length}`,
      ];

      const se = await DB.storageEstimate();
      if (se) lines.push(`当前占用 <b>${fmtBytes(se.usage)}</b>`);
      lines.push('数据位置 <b>程序目录的 data\\</b> <span class="diag-dim">随文件夹一起搬走</span>');
      if (SCAN.storageError()) lines.push('<span class="diag-warn">最近一次缩略图写库失败，多半是磁盘空间不足</span>');
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

    // 重新检查：插拔过外接盘、或在资源管理器里改过文件夹名之后，手动核对一次
    let _rechecking = false;
    $('#perm-recheck').addEventListener('click', async () => {
      if (_rechecking) return;
      _rechecking = true;
      const btn = $('#perm-recheck');
      if (btn) { btn.disabled = true; btn.textContent = '检查中…'; }
      try {
        await refreshReadable();
        await renderDirList();
        renderStorageInfo().catch(() => {});
        SCAN.clearMem();
        SCAN.clearFailed();
        await VIEWS.reload().catch(() => {});
        const n = unreadableDirs().length;
        toast(n === 0
          ? `已重新核对：${_dirsCache.length} 个目录均可正常读取`
          : `重新核对完成：仍有 ${n} 个目录读不到，插回盘或恢复文件夹后即可`);
      } catch (e) {
        toast('重新检查失败：' + (e && e.message || e));
      } finally {
        _rechecking = false;
        if (btn) { btn.disabled = false; btn.textContent = '重新检查'; }
      }
    });
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
    VIEWS.init();
    applyTheme().catch(() => {});
    // 必须先确认目录是否可读再渲染：读不到的目录会让每张缩略图解码立即失败。
    await refreshReadable().catch(() => {});
    try {
      await VIEWS.reload();          // 直接渲染上次扫描结果，秒开
    } catch (e) {
      showFatal(e);
    }
    renderDirList().catch(() => {});
    bindSettings();
    renderStorageInfo().catch(() => {});
  }

  /* 供地图页等其他模块复用：路径拼接、唤起 GPSStamp、提示条 */
  window.APP = {
    toast, confirmDialog,
    launchGpsStamp, normDir, joinPath,
  };

  document.addEventListener('DOMContentLoaded', boot);
})();
