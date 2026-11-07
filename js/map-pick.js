/* js/map-pick.js — 大地图上的补位置工作台（MAPPICK）
 *
 * 为什么单独一个模块：地图视图（map-view.js）负责「把已有坐标画出来」，
 * 这里负责「给一批没有坐标的照片找一个新坐标并写进去」。两者生命周期不同——
 * 地图实例只创建一次，工作台状态可以随时清空，混在一起会让 render() 的语义变糊。
 *
 * 第 1 阶段是「搜到地方、看到位置」；第 2 阶段把原来独立面板里的
 * 待处理照片列表与写入按钮搬到这里，形成一条没有模态的动线：
 * 点文件夹 → 右栏勾照片 → 搜地名/点地图 → 写入 → 新位置立刻出现在地图上。
 *
 * 坐标口径：Nominatim 返回 WGS-84，与照片 EXIF 里的 GPS、OSM 底图完全一致，
 * 不需要 GCJ-02 之类的纠偏——这一点在高德/百度底图上才是个问题。
 */
'use strict';

const MAPPICK = (() => {
  const $ = s => document.querySelector(s);
  /* 照片名按中文拼音 + 数字自然顺序排（与作品集「顺序」一致） */
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

  let _cur = null;        // { lat, lng } 当前选点，null 表示没有
  let _label = '';        // 选点的地名（手动点地图时会清掉）
  let _results = [];      // 当前下拉里的候选
  let _rows = [];         // 候选对应的按钮节点，顺序与 _results 一致（来源提示那类灰字不算）
  let _hi = -1;           // 键盘高亮下标，-1 表示没有
  let _busy = false;      // 查询进行中，避免重复发请求
  let _seq = 0;           // 查询序号：下拉被关掉/又搜了新词时，丢弃在途请求的结果
  let _q = '';            // 当前下拉里的候选是针对哪个词查的（空 = 没有有效候选）

  /* ---- 待标记照片（右栏） ---- */
  const MAX_LIST = 500;   // 列表上限：再多也勾不动，缩略图请求还会打满队列
  let _photos = [];       // 当前待处理的照片（完整记录）
  let _sel = new Set();   // 已勾选的 photo.id
  let _open = false;      // 右栏是否打开 = 是否处于「补位置」模式
  let _title = '';
  let _fromList = false;  // 是不是从「无位置信息」列表点进来的（决定「返回」图标出不出现）
  let _viewMode = 'list'; // 右栏显示样式：list 列表 / grid 缩略图
  let _writing = false;   // 写入进行中：与 _busy（地名查询）分开，避免互相解锁
  let _exiftool = '';
  let _observer = null;   // 缩略图懒加载
  const _urls = [];       // 需要回收的 objectURL

  /* ---------- DOM 小工具 ---------- */
  function bar() { return $('#map-pick-bar'); }
  function input() { return $('#map-q'); }
  function resultsBox() { return $('#map-results'); }
  function panel() { return $('#map-pick-panel'); }

  function toast(msg, isErr) {
    if (typeof APP !== 'undefined' && APP && typeof APP.toast === 'function') APP.toast(msg, isErr);
    else console.log('[pick]', msg);
  }

  /* 地图视图是否可见：Esc 之类的全局按键只在看地图时生效，
   * 否则在设置页按 Esc 会悄悄清掉后台留着的选点。 */
  function onMapView() {
    const v = document.querySelector('#view-map');
    return !!(v && !v.classList.contains('hidden'));
  }

  function openResults() {
    const box = resultsBox();
    if (box) box.classList.remove('hidden');
  }

  function closeResults() {
    const box = resultsBox();
    if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
    _results = [];
    _rows = [];
    _hi = -1;
    _q = '';
    _seq++;                 // 关掉下拉后，在途查询的结果不再补开列表
  }

  function hint(text) {
    const box = resultsBox();
    if (!box) return;
    const d = document.createElement('div');
    d.className = 'map-result-hint';
    d.textContent = text;
    box.innerHTML = '';
    box.appendChild(d);
    // 提示文本不是候选项：必须把上一轮的候选清掉，
    // 否则在这种情况下按 Enter 会选中一个用户已经看不到的旧条目。
    _results = [];
    _rows = [];
    _hi = -1;
    _q = '';
    openResults();
  }

  /* 底部坐标条：有选点才显示 */
  function paintBar() {
    const el = bar();
    if (!el) return;
    if (!_cur) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    const coord = $('#map-pick-coord');
    if (coord) coord.textContent = `${_cur.lat.toFixed(6)}, ${_cur.lng.toFixed(6)}`;
  }

  /* ---------- 选点 ---------- */
  /* source: search | map | marker —— 只有 search 才认地名，手动移动后名字作废 */
  function setPoint(lat, lng, opts) {
    const o = opts || {};
    if (!isFinite(lat) || !isFinite(lng)) return false;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
    if (typeof MAPVIEW === 'undefined' || !MAPVIEW || typeof MAPVIEW.pickPoint !== 'function') return false;

    const ok = MAPVIEW.pickPoint(lat, lng, { zoom: o.zoom || 0 });
    if (!ok) return false;

    _cur = { lat, lng };
    _label = o.source === 'search' ? String(o.label || '') : '';
    paintBar();
    paintWriteBtn();
    if (!_writing) refreshNote();
    return true;
  }

  function clear() {
    _cur = null;
    _label = '';
    if (typeof MAPVIEW !== 'undefined' && MAPVIEW && typeof MAPVIEW.clearPick === 'function') {
      try { MAPVIEW.clearPick(); } catch (e) { /* ignore */ }
    }
    paintBar();
    paintWriteBtn();
    refreshNote();
  }

  /* 地图上点一下 / 拖动标记：由 map-view 回调进来。
   * 没有选点也不在补位置模式时不接管——普通浏览地图时点空白应该什么都不发生；
   * 但进了工作台（右栏开着）就必须能直接点出一个点，否则第一步无从下手。 */
  function onMapClick(latlng) {
    if (!_cur && !_open) return;
    setPoint(latlng.lat, latlng.lng, { source: 'map' });
    closeResults();
  }

  function onMarkerDrag(latlng) {
    setPoint(latlng.lat, latlng.lng, { source: 'marker' });
  }

  /* ================= 待标记照片（右栏） =================
   * 这里的照片「没有坐标」是前提，所以不存在「已有坐标就带出来」这回事；
   * 初始视野改用同相册里已有 GPS 的照片的质心（见 hintView）。 */

  function hasGps(p) {
    const g = p && p.gps;
    return !!(g && isFinite(g.lat) && isFinite(g.lng) &&
      g.lat >= -90 && g.lat <= 90 && g.lng >= -180 && g.lng <= 180);
  }

  function folderOf(p) {
    const rel = String((p && p.relPath) || '');
    const i = rel.lastIndexOf('/');
    return i >= 0 ? rel.slice(0, i) : '';
  }

  function visible() {
    return _photos.length > MAX_LIST ? _photos.slice(0, MAX_LIST) : _photos;
  }

  /* 面板底部的一行说明：缺 exiftool、还没选点、写入结果都走这里 */
  function setNote(text, kind) {
    const el = $('#map-pick-note');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'pick-note' + (kind ? ' ' + kind : '') + (text ? '' : ' hidden');
  }

  /* 底部那行说明跟着状态走：缺 exiftool > 还没选点 > 无提示。
   * 写完之后的那句「完成：成功 N 张」由 writeSelected 直接写，不经过这里。 */
  function refreshNote() {
    if (!_open) { setNote(''); return; }
    if (!_exiftool) { setNote('没找到 exiftool.exe，写入前需要指定一次。', 'warn'); return; }
    if (!_cur) { setNote('在地图上点一下，或搜索地名。'); return; }
    setNote('');
  }

  function updateCount() {
    const n = visible().length;
    const c = $('#map-pick-count');
    if (c) c.textContent = `${_sel.size} / ${n}`;
    const all = $('#map-pick-all');
    if (all) {
      all.checked = n > 0 && _sel.size >= n;
      all.indeterminate = _sel.size > 0 && _sel.size < n;
    }
    paintWriteBtn();
  }

  /* 面板占着右栏时，右上角胶囊让到它左边（规则在 style.css 里）。
   * 右下角坐标条不动：工作台面板的底边停在它上方，坐标条位置越稳越好找。 */
  function paintPanelMode(on) {
    const el = $('#map');
    if (el) el.classList.toggle('pick-open', !!on);
  }

  function paintWriteBtn() {
    const b = $('#map-pick-write');
    if (!b) return;
    if (_writing) { b.disabled = true; return; }
    b.disabled = !_sel.size || !_cur;
    b.textContent = _sel.size ? `写入 ${_sel.size} 张` : '写入';
    b.title = !_cur ? '先在地图上选一个位置' : (!_sel.size ? '至少勾选一张照片' : '');
  }

  /* 工具行右端的图标按钮：只负责列表 / 缩略图这组互斥高亮。
   * 返回图标的显隐由 openPhotos / closePanel 单独管，不参与这里的状态。 */
  function paintViewBtns() {
    document.querySelectorAll('#map-pick-panel .pick-icon[data-view]').forEach(b => {
      const on = b.dataset.view === _viewMode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function setView(mode) {
    const m = mode === 'grid' ? 'grid' : 'list';
    if (m === _viewMode) return;
    _viewMode = m;
    paintViewBtns();
    renderList();
    DB.setSetting('pickView', m).catch(() => {});
  }

  function renderList() {
    const box = $('#map-pick-list');
    if (!box) return;

    const grid = _viewMode === 'grid';
    box.classList.toggle('grid', grid);

    // 上一批行的缩略图 URL 跟着这些行一起作废
    _urls.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } });
    _urls.length = 0;
    box.innerHTML = '';
    if (_observer) { _observer.disconnect(); _observer = null; }

    const list = visible();
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'pick-empty';
      empty.textContent = '都处理完了。';
      box.appendChild(empty);
      updateCount();
      return;
    }

    if (typeof IntersectionObserver === 'function') {
      _observer = new IntersectionObserver(entries => {
        entries.forEach(en => {
          if (!en.isIntersecting) return;
          const el = en.target;
          _observer.unobserve(el);
          const p = _photos.find(x => String(x.id) === el.dataset.pid);
          if (p) loadThumb(el, p);
        });
      }, { root: box, rootMargin: '120px' });
    }

    list.forEach(p => {
      const row = document.createElement('label');
      row.className = 'pick-item' + (_sel.has(p.id) ? ' on' : '');
      row.dataset.pid = p.id;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = _sel.has(p.id);

      const th = document.createElement('span');
      th.className = 'pick-thumb';
      th.dataset.pid = p.id;
      if (_observer) _observer.observe(th);

      row.appendChild(cb);
      row.appendChild(th);

      // 缩略图模式一格只放一张方图，文件名退到 title 里；列表模式照旧两行文字
      if (grid) {
        row.title = p.name || '';
      } else {
        const meta = document.createElement('span');
        meta.className = 'pick-meta';
        const nm = document.createElement('span');
        nm.className = 'pick-name';
        nm.textContent = p.name || '';
        nm.title = p.name || '';
        const fd = document.createElement('span');
        fd.className = 'pick-folder';
        fd.textContent = folderOf(p) || '根目录';
        fd.title = fd.textContent;
        meta.appendChild(nm);
        meta.appendChild(fd);
        row.appendChild(meta);
      }

      cb.addEventListener('change', () => {
        if (cb.checked) _sel.add(p.id); else _sel.delete(p.id);
        row.classList.toggle('on', cb.checked);
        updateCount();
      });

      box.appendChild(row);
    });

    updateCount();
  }

  async function loadThumb(el, p) {
    try {
      if (typeof SCAN === 'undefined') return;
      const a = await SCAN.ensureAssets(p, 'thumb');
      if (!a || !a.thumb) return;
      const url = URL.createObjectURL(a.thumb);
      _urls.push(url);
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      el.innerHTML = '';
      el.appendChild(img);
    } catch (e) { /* 缩略图失败不影响选择 */ }
  }

  /* 这批照片没有坐标，初始视野取同相册里已有 GPS 照片的质心：同一批照片通常在同一片区域。
   * 相册里没有就退到同文件夹；不再退到「同目录」——一个图片库目录可能横跨全国，
   * 质心会落在毫不相干的地方，打开本身没有任何 GPS 的老相册（如 20041128广州车展）时地图会乱跳。
   * 相册和文件夹里都没有 GPS 照片时保持当前视野不动。 */
  function hintView(p) {
    if (!p || typeof MAPVIEW === 'undefined' || !MAPVIEW || typeof MAPVIEW.viewTo !== 'function') return;
    const pool = (typeof VIEWS !== 'undefined' && VIEWS.state && VIEWS.state.filtered) || [];
    const folder = folderOf(p);
    const album = (typeof VIEWS !== 'undefined' && typeof VIEWS.albumKeyOf === 'function')
      ? VIEWS.albumKeyOf(p) : '';

    const centroid = mode => {
      let n = 0, sx = 0, sy = 0;
      for (const q of pool) {
        if (q === p || !hasGps(q)) continue;
        if (String(q.dirId) !== String(p.dirId)) continue;
        if (mode === 'album' && (!album || VIEWS.albumKeyOf(q) !== album)) continue;
        if (mode === 'folder' && folderOf(q) !== folder) continue;
        n++; sx += q.gps.lat; sy += q.gps.lng;
      }
      return n ? { lat: sx / n, lng: sy / n } : null;
    };

    const c = centroid('album') || centroid('folder');
    if (c) MAPVIEW.viewTo(c.lat, c.lng, 12);
  }

  async function ensureExiftool() {
    _exiftool = '';
    if (typeof GPSWRITE !== 'undefined') {
      try { _exiftool = await GPSWRITE.exiftool(); } catch (e) { /* ignore */ }
    }
    const btn = $('#map-pick-exe');
    if (btn) btn.classList.toggle('hidden', !!_exiftool);
    paintWriteBtn();
  }

  /* 打开工作台：photos 就是要补位置的那批（顺序即列表顺序）
   * opts.fromList=true 表示来自「无位置信息」列表，此时给一个「← 返回」退回那张列表。 */
  async function openPhotos(photos, title, opts) {
    const list = (photos || []).filter(p => p && p.relPath);
    if (!list.length) { toast('这里没有需要处理的照片'); return; }

    // 从大图 / 作品集点 G 过来时人不在图上，先把视图切过来
    if (!onMapView()) {
      const nav = document.querySelector('.nav-btn[data-view="map"]');
      if (nav) nav.click();
    }

    // 两个面板都占右上角，先收起「无位置信息」那张列表
    if (typeof MAPVIEW !== 'undefined' && MAPVIEW && typeof MAPVIEW.closeNoGps === 'function') {
      try { MAPVIEW.closeNoGps(); } catch (e) { /* ignore */ }
    }

    _photos = list;
    _sel = new Set(list.map(p => p.id));
    _title = title || '待标记';
    _open = true;
    _fromList = !!(opts && opts.fromList);

    const t = $('#map-pick-title');
    if (t) { t.textContent = _title; t.title = _title; }
    const back = $('#map-pick-back');
    if (back) back.classList.toggle('hidden', !_fromList);
    const p = panel();
    if (p) p.classList.remove('hidden');
    paintPanelMode(true);

    // 备份开关沿用上次的选择
    const bk = $('#map-pick-backup');
    if (bk) {
      DB.getSetting('gpsBackup', true).then(v => { bk.checked = v !== false; }).catch(() => {});
    }

    paintViewBtns();
    renderList();
    await ensureExiftool();
    refreshNote();
    if (!_cur) hintView(list[0]);
    paintWriteBtn();
  }

  function closePanel() {
    _open = false;
    _fromList = false;
    const p = panel();
    if (p) p.classList.add('hidden');
    const back = $('#map-pick-back');
    if (back) back.classList.add('hidden');
    paintPanelMode(false);
    if (_observer) { _observer.disconnect(); _observer = null; }
    _urls.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } });
    _urls.length = 0;
    const box = $('#map-pick-list');
    if (box) box.innerHTML = '';
    _photos = [];
    _sel.clear();
    setNote('');
    paintWriteBtn();
  }

  /* Esc / ×：退出补位置。连选点一起收掉，一键回到普通浏览。
   * 「清除」按钮只清坐标、照片列表留着，便于同一个相册换个位置再写一批。 */
  function exitPick() {
    closePanel();
    clear();
  }

  /* ← 返回：只收右栏，把「无位置信息」那张列表在原位置重新展开，接着挑下一个相册。
   * 与 Esc / × 的区别是不清选点——换相册补位置时，常常还是同一片地方。 */
  function backToNoGps() {
    if (_writing) return;                 // 写入进行中先别走，免得进度提示跟丢
    closePanel();
    if (typeof MAPVIEW !== 'undefined' && MAPVIEW && typeof MAPVIEW.openNoGps === 'function') {
      try { MAPVIEW.openNoGps(); } catch (e) { /* ignore */ }
    }
  }

  /* 地图右上角「无位置信息」下拉里点相册 → 直接在这里开工。
   * 相册分组与相册集一致（VIEWS.albumKeyOf），张数与列表显示对得上。 */
  async function openFolder(g) {
    if (!g) return;
    const pool = (typeof VIEWS !== 'undefined' && VIEWS.state && VIEWS.state.filtered) || [];
    const sameAlbum = p => {
      const k = (typeof VIEWS !== 'undefined' && typeof VIEWS.albumKeyOf === 'function')
        ? VIEWS.albumKeyOf(p) : '';
      return (k || '未分类') === (g.album || '未分类');
    };
    // 优先用列表里已归好的那批；兜底按相册键重新筛选，保证张数一致
    const list = (g.photos && g.photos.length)
      ? g.photos.filter(p => !hasGps(p))
      : pool.filter(p => sameAlbum(p) && !hasGps(p));

    if (!list.length) { toast('这个相册里的照片都有位置了'); return; }
    // 相册内照片按文件名顺序排列（同名再按相对路径兜底），不提供自定义排序
    list.sort((a, b) => collator.compare(a.name || '', b.name || '') ||
      collator.compare(a.relPath || '', b.relPath || ''));

    const name = String(g.album || '未分类').replace(/\//g, ' / ');
    await openPhotos(list, `${name} · 无位置`, { fromList: true });
  }

  /* 写入：先确认，再把活交给 GPSWRITE（地图与旧面板共用同一份实现） */
  async function writeSelected() {
    if (_writing) return;
    if (typeof GPSWRITE === 'undefined') { toast('写入模块还没加载完，请稍后再试', true); return; }
    if (!_cur) { setNote('先在地图上点一下，或搜索地名，再写入。', 'warn'); return; }

    const chosen = _photos.filter(p => _sel.has(p.id));
    if (!chosen.length) { setNote('至少勾选一张照片。', 'warn'); return; }

    const bk = $('#map-pick-backup');
    const backup = bk ? !!bk.checked : true;
    const ok = await APP.confirmDialog({
      title: '写入 GPS',
      message: `把坐标 ${_cur.lat.toFixed(6)}, ${_cur.lng.toFixed(6)} 写入 ${chosen.length} 张照片的 EXIF？\n\n`
        + (backup
          ? '原图会先备份到程序根目录的 backup\\，出问题可以还原。'
          : '当前未开启备份，原文件将被直接改写。'),
      okText: '写入',
      danger: false,
    });
    if (!ok) return;

    _writing = true;
    paintWriteBtn();
    const btn = $('#map-pick-write');
    if (btn) btn.textContent = `写入中 0/${chosen.length}`;
    setNote(`正在写入 ${chosen.length} 张…`);

    const off = PLATFORM.onGpsProgress(d => {
      const b = $('#map-pick-write');
      if (b && _writing) b.textContent = `写入中 ${d.done}/${d.total}`;
    });

    let r;
    try {
      r = await GPSWRITE.write(chosen, _cur, { backup, exiftool: _exiftool });
    } catch (e) {
      r = { ok: false, error: e && e.message ? e.message : String(e) };
    } finally {
      if (off) off();
    }

    _writing = false;

    if (!r || r.ok === false) {
      const msg = '写入失败：' + ((r && r.error) || '未知原因');
      setNote(msg, 'err');
      toast(msg, true);
      paintWriteBtn();
      return;
    }

    // 已写入的照片从待处理列表里移走；它们此刻已经变成地图上的实心点
    const done = new Set((r.wrote || []).map(p => p.id));
    if (done.size) {
      _photos = _photos.filter(p => !done.has(p.id));
      done.forEach(id => _sel.delete(id));
    }

    toast(`已写入 ${r.updated} 张照片的位置信息`);
    (r.errors || []).slice(0, 2).forEach(e => console.warn('[gps]', e));

    if (!_photos.length) {
      // 先把列表清成「都处理完了」再关面板，否则会留下几行刚写过、已经过期的行
      renderList();
      setNote(`完成：成功 ${r.updated} 张` + (r.failed ? `，失败 ${r.failed} 张` : ''),
        r.failed ? 'warn' : 'ok');
      paintWriteBtn();
      // 选点保留：地图上能看到刚写入的点就在刚才选的位置，比一句「成功」直观
      setTimeout(() => { if (!_photos.length && !_writing) closePanel(); }, 1400);
      return;
    }

    renderList();
    setNote(`完成：成功 ${r.updated} 张` + (r.failed ? `，失败 ${r.failed} 张` : ''),
      r.failed ? 'warn' : 'ok');
    paintWriteBtn();
  }

  /* ---------- 搜索 ---------- */
  /* note：来源提示（例如「百度不可用，已改用 OpenStreetMap」）。
   * 它作为一行灰字放在候选上方，但不是候选项——键盘高亮只走 _rows。 */
  function renderResults(list, note) {
    const box = resultsBox();
    if (!box) return;
    box.innerHTML = '';
    _results = list;
    _rows = [];
    _hi = 0;

    if (note) {
      const n = document.createElement('div');
      n.className = 'map-result-hint';
      n.textContent = note;
      box.appendChild(n);
    }

    list.forEach((it, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'map-result' + (i === _hi ? ' on' : '');
      b.dataset.i = String(i);
      b.setAttribute('role', 'option');

      const l = document.createElement('span');
      l.className = 'map-result-label';
      l.textContent = it.label || '未命名';

      const d = document.createElement('span');
      d.className = 'map-result-detail';
      d.textContent = it.detail || '';

      b.appendChild(l);
      if (it.detail) b.appendChild(d);
      b.addEventListener('mouseenter', () => highlight(i));
      b.addEventListener('click', () => choose(i));
      _rows.push(b);
      box.appendChild(b);
    });
    openResults();
  }

  function highlight(i) {
    const box = resultsBox();
    if (!box || !_results.length) return;
    const n = _results.length;
    _hi = ((i % n) + n) % n;         // 上下循环
    _rows.forEach((el, k) => {
      el.classList.toggle('on', k === _hi);
    });
    const cur = _rows[_hi];
    if (cur && typeof cur.scrollIntoView === 'function') cur.scrollIntoView({ block: 'nearest' });
  }

  function choose(i) {
    const it = _results[i];
    if (!it) return;
    const ok = setPoint(it.lat, it.lng, { zoom: 15, source: 'search', label: it.label || '' });
    if (!ok) { hint('地图还没准备好，请稍后重试。'); return; }
    const q = input();
    if (q && it.label) q.value = it.label;
    closeResults();
    // 不发 toast：地图已经飞过去、右下角也写着坐标，
    // 再弹一条只会压在底部中央的「N 张带位置」统计条上。
  }

  async function search() {
    const qEl = input();
    if (!qEl || _busy) return;
    const q = String(qEl.value || '').trim();
    if (!q) { hint('输入地名再搜索，例如「广州塔」。'); qEl.focus(); return; }

    _busy = true;
    const my = ++_seq;
    const btn = $('#map-q-btn');
    if (btn) { btn.disabled = true; btn.textContent = '查询中'; }
    hint('查询中…');

    let r;
    try {
      r = await PLATFORM.geocode(q);
    } catch (e) {
      r = { ok: false, error: e && e.message ? e.message : String(e) };
    }
    _busy = false;
    if (btn) { btn.disabled = false; btn.textContent = '搜索'; }

    // 等待期间用户关掉了下拉、或又搜了别的词：这条结果已经过时，别再弹出来
    if (my !== _seq) return;

    if (!r || r.ok === false) {
      hint((r && r.error) || '查询失败，请稍后再试。');
      return;
    }
    if (!r.results || !r.results.length) {
      hint((r.note ? r.note : '') +
        '没找到这个地名。换用更通用的叫法，或加上城市名（如「武汉 东湖」）通常更准。');
      return;
    }
    _q = q;
    renderResults(r.results, r.note);
  }

  /* ---------- 事件 ---------- */
  function init() {
    const qEl = input();
    if (qEl) {
      qEl.addEventListener('keydown', e => {
        // 输入法组词期间的回车/方向键属于输入法：不拦住就轮到我们处理，
        // preventDefault 会把刚打的字连同候选一起取消，表现就是「回车后文字变回输入前」
        if (e.isComposing || e.keyCode === 229) return;
        const box = resultsBox();
        const open = box && !box.classList.contains('hidden');
        if (e.key === 'Enter') {
          e.preventDefault();
          // 只有候选确实对应输入框里现在这个词时才直接选，否则重新搜
          const q = String(qEl.value || '').trim();
          if (open && _hi >= 0 && _results[_hi] && _q === q) choose(_hi);
          else search();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          if (!open) return;
          e.preventDefault();
          highlight(_hi + (e.key === 'ArrowDown' ? 1 : -1));
        } else if (e.key === 'Escape') {
          if (open) { e.preventDefault(); e.stopPropagation(); closeResults(); }
          else if (_open) { e.preventDefault(); e.stopPropagation(); exitPick(); }
          else if (_cur) { e.preventDefault(); e.stopPropagation(); clear(); }
        }
      });

      // 候选只对查询时那个词有效：一改字就收起来，
      // 免得回车命中一条和输入框已经对不上的旧候选
      qEl.addEventListener('input', () => {
        const box = resultsBox();
        if (!box || box.classList.contains('hidden')) return;
        if (_q !== String(qEl.value || '').trim()) closeResults();
      });
    }

    const btn = $('#map-q-btn');
    if (btn) btn.addEventListener('click', () => { search(); });

    const clearBtn = $('#map-pick-clear');
    if (clearBtn) clearBtn.addEventListener('click', () => clear());

    /* ---- 右栏（待标记照片） ---- */
    const panelClose = $('#map-pick-close');
    if (panelClose) panelClose.addEventListener('click', exitPick);

    const backBtn = $('#map-pick-back');
    if (backBtn) backBtn.addEventListener('click', backToNoGps);

    /* 列表 / 缩略图：点击即重绘（懒加载观察者会跟着重建），
     * 选择存进设置，下次打开工作台沿用同一种样式。 */
    document.querySelectorAll('#map-pick-panel .pick-icon[data-view]').forEach(b => {
      b.addEventListener('click', () => setView(b.dataset.view));
    });
    DB.getSetting('pickView', 'list').then(v => {
      const m = v === 'grid' ? 'grid' : 'list';
      if (m === _viewMode) { paintViewBtns(); return; }
      _viewMode = m;
      paintViewBtns();
      if (_open) renderList();
    }).catch(() => {});

    const allBtn = $('#map-pick-all');
    if (allBtn) {
      allBtn.addEventListener('change', () => {
        const list = visible();
        if (allBtn.checked) list.forEach(p => _sel.add(p.id));
        else _sel.clear();
        document.querySelectorAll('#map-pick-list .pick-item').forEach(row => {
          const on = _sel.has(row.dataset.pid);
          row.classList.toggle('on', on);
          const cb = row.querySelector('input[type=checkbox]');
          if (cb) cb.checked = on;
        });
        updateCount();
      });
    }

    const bk = $('#map-pick-backup');
    if (bk) bk.addEventListener('change', () => { DB.setSetting('gpsBackup', bk.checked).catch(() => {}); });

    const writeBtn = $('#map-pick-write');
    if (writeBtn) writeBtn.addEventListener('click', () => { writeSelected(); });

    const pickExe = $('#map-pick-exe');
    if (pickExe) {
      pickExe.addEventListener('click', async () => {
        const r = await PLATFORM.pickExiftool();
        if (r && r.path) {
          _exiftool = r.path;
          try { await DB.setSetting('exiftoolPath', r.path); } catch (e) { /* ignore */ }
          pickExe.classList.add('hidden');
          refreshNote();
          paintWriteBtn();
        } else if (r && r.error) {
          toast(r.error, true);
        }
      });
    }

    // 点下拉以外的地方收起（输入框本身不算外部）
    document.addEventListener('mousedown', e => {
      const box = resultsBox();
      if (!box || box.classList.contains('hidden')) return;
      const t = e.target;
      if (box.contains(t)) return;
      if (qEl && (qEl === t || qEl.contains(t))) return;
      if (btn && (btn === t || btn.contains(t))) return;
      closeResults();
    });

    /* 全局 Esc：焦点不在搜索框时也要能用。
     * 用捕获阶段——大图（views.js）和 GPS 编辑器也监听 Esc，而它们是冒泡阶段：
     * 如果在冒泡阶段判断，大图已经先被关掉了，这里就会误以为「大图没开」而顺手清掉选点。 */
    document.addEventListener('keydown', e => {
      if (e.isComposing || e.keyCode === 229) return;   // 输入法组词中：Esc 是取消候选，别抢
      if (e.key !== 'Escape') return;
      if (!onMapView()) return;

      // 搜索框有自己的 Esc 语义（先收下拉、再清选点），交给它自己处理
      const qEl = input();
      if (qEl && (e.target === qEl || qEl.contains(e.target))) return;

      const box = resultsBox();
      if (box && !box.classList.contains('hidden')) { closeResults(); return; }

      const lb = $('#lightbox');
      if (lb && !lb.classList.contains('hidden')) return;
      if (typeof GPSEDIT !== 'undefined' && GPSEDIT && typeof GPSEDIT.isOpen === 'function' && GPSEDIT.isOpen()) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;   // 别抢正在输入的地方

      // 补位置模式下 Esc 是「退出工作台」，连坐标一起收掉
      if (_open) { exitPick(); return; }
      if (!_cur) return;
      clear();
    }, true);
  }

  return {
    init,
    search,
    clear,
    setPoint,          // 供外部（编辑器/测试）直接给一组坐标
    onMapClick,
    onMarkerDrag,
    openFolder,        // 地图右上角下拉里的相册行 → 在此开工
    openPhotos,        // 大图 / 作品集里的 G → 指定几张
    closePanel,        // 只收右栏，保留选点
    exitPick,
    isOpen: () => _open,
    hasPick: () => !!_cur,
    current: () => (_cur ? { lat: _cur.lat, lng: _cur.lng, label: _label } : null),
    closeResults,
  };
})();
