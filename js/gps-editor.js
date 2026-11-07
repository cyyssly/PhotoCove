/* js/gps-editor.js — 旧面板式 GPS 编辑器
 *
 * 历史角色：GPSStamp 是浏览器沙箱时代的产物——网页版拿不到绝对路径、起不了进程，
 * 只能外挂一个独立工具去写 EXIF。桌面版这两条限制都没了，这个面板曾是应用内
 * 的主路径（挑照片 → 选位置 → 写 GPSPosition）。
 *
 * 现状：补位置已整体搬到大地图上的工作台（map-pick.js），写入逻辑抽到 gps-write.js
 * 共享。本模块暂无入口（面板与 init 保留），待确认稳定后可整体移除。
 *
 * 写入本身仍交给 exiftool（主进程调用），不自己解析 JPEG/HEIC 的 EXIF 二进制：
 * exiftool 会保留 MakerNotes、维持文件结构、支持所有相机格式，
 * 自己写偏移量出错就是毁照片。这里只负责「选哪些、写什么值、写完怎么更新索引」。
 *
 * 与 GPSStamp 的行为差异（都是刻意的）：
 * 1) 备份进程序根目录的 backup\，不在照片文件夹里留 _original 副本——
 *    否则下次扫描会把副本当成新照片索引进来，作品集里凭空多一倍。
 * 2) 地图选点与地名搜索在地图上完成，不用记经纬度。
 */
'use strict';

const GPSEDIT = (() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const MAX_LIST = 500;      // 列表上限：再多也选不动，且缩略图请求会打满队列

  let _photos = [];          // 本次待处理的照片（完整记录）
  let _sel = new Set();      // 已勾选的 photo.id
  let _dirs = [];
  let _exiftool = '';
  let _busy = false;
  let _isOpen = false;
  let _offProgress = null;

  let _map = null;
  let _marker = null;
  let _cur = null;           // { lat, lng }

  let _observer = null;      // 缩略图懒加载
  const _urls = [];          // 需要回收的 objectURL

  const TILE = 'https://tile.openstreetmap.de/{z}/{x}/{y}.png';

  /* ---------- 基础 ---------- */
  function dirOf(id) {
    for (let i = 0; i < _dirs.length; i++) {
      if (String(_dirs[i].id) === String(id)) return _dirs[i];
    }
    return null;
  }

  function folderLabel(p) {
    const d = dirOf(p.dirId);
    const base = d ? d.name : ('库 ' + p.dirId);
    const rel = String(p.relPath || '');
    const i = rel.lastIndexOf('/');
    const folder = i >= 0 ? rel.slice(0, i) : '';
    return folder ? base + ' / ' + folder.replace(/\//g, ' / ') : base + '（根目录）';
  }

  function log(msg, kind) {
    const box = $('#gps-log');
    if (!box) return;
    const line = document.createElement('div');
    line.className = 'gps-log-line' + (kind ? ' ' + kind : '');
    line.textContent = msg;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  function clearLog() {
    const box = $('#gps-log');
    if (box) box.innerHTML = '';
  }

  /* ---------- 列表 ---------- */
  function visible() {
    return _photos.length > MAX_LIST ? _photos.slice(0, MAX_LIST) : _photos;
  }

  function updateCount() {
    const el = $('#gps-count');
    if (el) el.textContent = `${_sel.size} / ${visible().length}`;
    const all = $('#gps-all');
    if (all) {
      const n = visible().length;
      all.checked = n > 0 && _sel.size >= n;
      all.indeterminate = _sel.size > 0 && _sel.size < n;
    }
    const btn = $('#gps-write');
    if (btn) btn.textContent = _sel.size ? `写入 ${_sel.size} 张` : '写入';
  }

  function renderList() {
    const box = $('#gps-list');
    if (!box) return;
    box.innerHTML = '';
    const list = visible();

    if (_observer) { _observer.disconnect(); _observer = null; }
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

    if (!list.length) {
      box.innerHTML = '<div class="gps-empty">这里没有需要处理的照片。</div>';
      updateCount();
      return;
    }

    list.forEach(p => {
      const row = document.createElement('label');
      row.className = 'gps-item' + (_sel.has(p.id) ? ' on' : '');
      row.dataset.pid = p.id;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = _sel.has(p.id);

      const th = document.createElement('span');
      th.className = 'gps-thumb';
      th.dataset.pid = p.id;
      if (_observer) _observer.observe(th);

      const meta = document.createElement('span');
      meta.className = 'gps-meta';
      const nm = document.createElement('span');
      nm.className = 'gps-name';
      nm.textContent = p.name || '';
      nm.title = p.name || '';
      const fd = document.createElement('span');
      fd.className = 'gps-folder';
      fd.textContent = folderLabel(p);
      fd.title = fd.textContent;
      meta.appendChild(nm);
      meta.appendChild(fd);

      row.appendChild(cb);
      row.appendChild(th);
      row.appendChild(meta);

      cb.addEventListener('change', () => {
        if (cb.checked) _sel.add(p.id); else _sel.delete(p.id);
        row.classList.toggle('on', cb.checked);
        updateCount();
      });

      box.appendChild(row);
    });

    const note = $('#gps-list-note');
    if (note) {
      note.textContent = _photos.length > MAX_LIST
        ? `共 ${_photos.length} 张，列表只显示前 ${MAX_LIST} 张（用文件夹入口分批处理更快）`
        : '';
    }
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

  /* ---------- 地图 ---------- */
  function ensureMap() {
    if (_map) return _map;
    if (typeof L === 'undefined') return null;
    const el = $('#gps-map');
    if (!el) return null;
    _map = L.map(el, { worldCopyJump: true, maxZoom: 19 }).setView([32, 108], 3);
    L.tileLayer(TILE, { maxZoom: 19, subdomains: 'abc', attribution: '&copy; OpenStreetMap' }).addTo(_map);
    _map.on('click', e => setPoint(e.latlng.lat, e.latlng.lng, 'map'));
    return _map;
  }

  /* source: map / marker / search / input / init —— 只有非 input 才回写输入框 */
  function setPoint(lat, lng, source) {
    if (!isFinite(lat) || !isFinite(lng)) return;
    _cur = { lat, lng };

    if (source !== 'input') {
      $('#gps-lat').value = lat.toFixed(6);
      $('#gps-lng').value = lng.toFixed(6);
    }

    const map = ensureMap();
    if (!map) return;
    if (!_marker) {
      _marker = L.marker([lat, lng], { draggable: true }).addTo(map);
      _marker.on('dragend', () => {
        const ll = _marker.getLatLng();
        setPoint(ll.lat, ll.lng, 'marker');
      });
    } else {
      _marker.setLatLng([lat, lng]);
    }
    if (source === 'map' || source === 'marker') return;   // 自己点的，视野已经对
    if (!map.getBounds().contains([lat, lng])) map.setView([lat, lng], 13);
  }

  function readCoord() {
    const lat = Number(String($('#gps-lat').value).trim());
    const lng = Number(String($('#gps-lng').value).trim());
    if (!isFinite(lat) || !isFinite(lng)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    if (lat === 0 && lng === 0) return null;           // 几内亚湾，基本是误填
    return { lat, lng };
  }

  /* ---------- 地名搜索 ---------- */
  /* 来源提示（例如「百度不可用，已改用 OpenStreetMap」）：放在候选上方一行灰字 */
  function noteRow(text) {
    const d = document.createElement('div');
    d.className = 'gps-result-hint';
    d.textContent = text;
    return d;
  }

  async function doSearch() {
    const q = String($('#gps-q').value || '').trim();
    const box = $('#gps-results');
    if (!q) { box.classList.add('hidden'); return; }

    box.classList.remove('hidden');
    box.innerHTML = '<div class="gps-result-hint">查询中…</div>';
    const r = await PLATFORM.geocode(q);
    if (!r || r.ok === false) {
      box.innerHTML = `<div class="gps-result-hint">${esc((r && r.error) || '查询失败')}</div>`;
      return;
    }
    if (!r.results || !r.results.length) {
      box.innerHTML = '<div class="gps-result-hint">没找到这个地名。加上城市名（如「武汉 东湖」）通常更准。</div>';
      if (r.note) box.insertBefore(noteRow(r.note), box.firstChild);
      return;
    }
    box.innerHTML = '';
    if (r.note) box.appendChild(noteRow(r.note));
    r.results.forEach(it => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'gps-result';
      const l = document.createElement('span');
      l.className = 'gps-result-label';
      l.textContent = it.label || '未命名';
      const d = document.createElement('span');
      d.className = 'gps-result-detail';
      d.textContent = it.detail || '';
      b.appendChild(l);
      b.appendChild(d);
      b.addEventListener('click', () => {
        setPoint(it.lat, it.lng, 'search');
        const map = ensureMap();
        if (map) map.setView([it.lat, it.lng], 15);
        box.classList.add('hidden');
        log(`已定位到「${it.label || q}」，确认无误后点「写入」。`);
      });
      box.appendChild(b);
    });
  }

  /* ---------- 写入 ----------
   * 真正的写盘、索引更新、视图刷新都在 GPSWRITE 里（地图上的补位置工作台共用同一份），
   * 这里只负责「读表单 → 确认 → 把结果写进日志」。 */
  async function doWrite() {
    if (_busy) return;

    const coord = readCoord();
    if (!coord) { log('先填一个有效坐标，或在图上点一下。', 'warn'); return; }

    const chosen = _photos.filter(p => _sel.has(p.id));
    if (!chosen.length) { log('左侧至少勾选一张照片。', 'warn'); return; }

    if (!_exiftool) { log('没有找到 exiftool.exe，无法写入。点「指定 exiftool」选一次即可。', 'warn'); return; }

    const backup = $('#gps-backup').checked;
    const ok = await APP.confirmDialog({
      title: '写入 GPS',
      message: `把坐标 ${coord.lat.toFixed(6)}, ${coord.lng.toFixed(6)} 写入 ${chosen.length} 张照片的 EXIF？\n\n`
        + (backup
          ? '原图会先备份到程序根目录的 backup\\，出问题可以还原。'
          : '当前未开启备份，原文件将被直接改写。'),
      okText: '写入',
      danger: false,
    });
    if (!ok) return;

    _busy = true;
    setBusy(true);
    clearLog();
    log(`准备写入 ${chosen.length} 张…`);

    const off = PLATFORM.onGpsProgress(d => {
      const btn = $('#gps-write');
      if (btn) btn.textContent = `写入中 ${d.done}/${d.total}`;
    });

    let r;
    try {
      r = await GPSWRITE.write(chosen, coord, { backup, exiftool: _exiftool });
    } catch (e) {
      r = { ok: false, error: e && e.message ? e.message : String(e) };
    } finally {
      if (off) off();
    }

    if (!r || r.ok === false) {
      log('写入失败：' + ((r && r.error) || '未知原因'), 'err');
      _busy = false;
      setBusy(false);
      return;
    }

    log(`完成：成功 ${r.updated} 张，失败 ${r.failed} 张。`, r.failed ? 'warn' : 'ok');
    if (r.backupFailed) log(`有 ${r.backupFailed} 张备份失败（可能是磁盘写入权限），但已照常写入。`, 'warn');
    (r.errors || []).forEach(e => log(e, 'err'));
    if (r.noPath && r.noPath.length) log(`有 ${r.noPath.length} 张记不到路径，已跳过。`, 'warn');

    APP.toast(`已写入 ${r.updated} 张照片的位置信息`);
    _busy = false;
    setBusy(false);
    setTimeout(close, 900);
  }

  function setBusy(busy) {
    const btn = $('#gps-write');
    if (btn) { btn.disabled = busy; if (busy) btn.textContent = '写入中…'; }
    const closeBtn = $('#gps-close');
    if (closeBtn) closeBtn.disabled = busy;
    if (!busy) updateCount();
  }

  /* ---------- 开关 ---------- */
  async function loadDirs() {
    try { _dirs = await DB.listDirs(); } catch (e) { _dirs = []; }
  }

  async function loadExiftool() {
    _exiftool = '';
    try { _exiftool = await PLATFORM.exiftool(); } catch (e) { /* ignore */ }
    if (!_exiftool) {
      try {
        const saved = await DB.getSetting('exiftoolPath', '');
        if (saved) _exiftool = saved;
      } catch (e) { /* ignore */ }
    }
    const pick = $('#gps-pick-exe');
    if (pick) pick.classList.toggle('hidden', !!_exiftool);
  }

  async function open(photos, title) {
    if (_isOpen) return;
    await loadDirs();
    await loadExiftool();

    _photos = (photos || []).filter(p => p && p.relPath);
    _sel = new Set(_photos.map(p => p.id));

    const t = $('#gps-title');
    if (t) t.textContent = title || '标记 GPS 位置';
    const sub = $('#gps-sub');
    if (sub) sub.textContent = _photos.length ? `${_photos.length} 张待处理` : '';

    clearLog();
    const backupEl = $('#gps-backup');
    if (backupEl) {
      DB.getSetting('gpsBackup', true).then(v => { backupEl.checked = v !== false; }).catch(() => {});
    }

    renderList();
    if (!_exiftool) log('没找到 exiftool.exe：写入 EXIF 需要它。点下方「指定 exiftool」选一次，之后会记住。', 'warn');

    const overlay = $('#gps-overlay');
    overlay.classList.remove('hidden');
    document.body.classList.add('modal-open');
    _isOpen = true;

    // 已有坐标就带出来，省得重复查
    const first = _photos.find(p => p && p.gps && isFinite(p.gps.lat) && isFinite(p.gps.lng));
    setTimeout(() => {
      const map = ensureMap();
      if (map) map.invalidateSize();
      if (first) {
        setPoint(first.gps.lat, first.gps.lng, 'init');
        if (map) map.setView([first.gps.lat, first.gps.lng], 13);
      }
    }, 40);

    if (_offProgress) _offProgress();
    _offProgress = PLATFORM.onGpsProgress(d => {
      if (!_busy) return;
      const btn = $('#gps-write');
      if (btn) btn.textContent = `写入中 ${d.done}/${d.total}`;
    });
  }

  function close() {
    if (_busy) return;
    const overlay = $('#gps-overlay');
    if (overlay) overlay.classList.add('hidden');
    document.body.classList.remove('modal-open');
    _isOpen = false;

    if (_observer) { _observer.disconnect(); _observer = null; }
    _urls.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } });
    _urls.length = 0;
    const box = $('#gps-list');
    if (box) box.innerHTML = '';
    const res = $('#gps-results');
    if (res) { res.classList.add('hidden'); res.innerHTML = ''; }
    _photos = [];
    _sel.clear();
    if (_offProgress) { _offProgress(); _offProgress = null; }
  }

  /* ---------- 数据来源 ---------- */
  const hasGps = p => !!(p && p.gps && isFinite(p.gps.lat) && isFinite(p.gps.lng));

  /* 某个目录（可再限定子文件夹）里缺 GPS 的照片 */
  async function openFolder(dirId, folder) {
    await loadDirs();
    let all = [];
    try { all = await DB.allPhotos(); } catch (e) { all = []; }
    const prefix = folder ? String(folder).replace(/[\\/]+$/, '') + '/' : '';
    const list = all.filter(p => {
      if (String(p.dirId) !== String(dirId)) return false;
      if (hasGps(p)) return false;
      if (!prefix) return true;
      return String(p.relPath || '').startsWith(prefix);
    });
    const d = dirOf(dirId);
    const label = folder ? `${d ? d.name : '库'} / ${String(folder).replace(/\//g, ' / ')}` : `${d ? d.name : '库'}（根目录）`;
    await open(list, '标记 GPS · ' + label);
  }

  /* 所有缺 GPS 的照片 */
  async function openMissing() {
    await loadDirs();
    let all = [];
    try { all = await DB.allPhotos(); } catch (e) { all = []; }
    await open(all.filter(p => !hasGps(p)), '标记 GPS · 全部无位置照片');
  }

  /* 单张 / 指定几张 */
  async function openPhotos(photos, title) {
    await open(photos, title || '标记 GPS');
  }

  /* ---------- 事件 ---------- */
  function init() {
    const closeBtn = $('#gps-close');
    if (closeBtn) closeBtn.addEventListener('click', close);

    const all = $('#gps-all');
    if (all) {
      all.addEventListener('change', () => {
        const list = visible();
        if (all.checked) list.forEach(p => _sel.add(p.id));
        else _sel.clear();
        document.querySelectorAll('#gps-list .gps-item').forEach(row => {
          const on = _sel.has(Number(row.dataset.pid)) || _sel.has(row.dataset.pid);
          row.classList.toggle('on', on);
          const cb = row.querySelector('input[type=checkbox]');
          if (cb) cb.checked = on;
        });
        updateCount();
      });
    }

    const q = $('#gps-q');
    if (q) {
      q.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
      });
    }
    const sBtn = $('#gps-search-btn');
    if (sBtn) sBtn.addEventListener('click', doSearch);

    ['#gps-lat', '#gps-lng'].forEach(sel => {
      const el = $(sel);
      if (!el) return;
      el.addEventListener('change', () => {
        const c = readCoord();
        if (c) setPoint(c.lat, c.lng, 'input');
      });
    });

    const bk = $('#gps-backup');
    if (bk) bk.addEventListener('change', () => { DB.setSetting('gpsBackup', bk.checked).catch(() => {}); });

    const writeBtn = $('#gps-write');
    if (writeBtn) writeBtn.addEventListener('click', () => { doWrite(); });

    const pick = $('#gps-pick-exe');
    if (pick) {
      pick.addEventListener('click', async () => {
        const r = await PLATFORM.pickExiftool();
        if (r && r.path) {
          _exiftool = r.path;
          try { await DB.setSetting('exiftoolPath', r.path); } catch (e) { /* ignore */ }
          pick.classList.add('hidden');
          log('已指定 exiftool：' + r.path, 'ok');
        } else if (r && r.error) {
          log(r.error, 'err');
        }
      });
    }

    document.addEventListener('keydown', e => {
      if (!_isOpen || e.key !== 'Escape') return;
      // 编辑框里按 Esc 先关下拉，不直接关面板
      const res = $('#gps-results');
      if (res && !res.classList.contains('hidden')) { res.classList.add('hidden'); return; }
      e.preventDefault();
      close();
    });
  }

  return { init, open: openPhotos, openFolder, openMissing, close, isOpen: () => _isOpen };
})();
