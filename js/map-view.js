/* js/map-view.js — 地图视图（Leaflet + MarkerCluster）
 *
 * 与 views.js 平级：views.js 管作品集/时间轴/相册集，这里只管地图。
 * 进入视图时 show() 渲染 marker，离开时 hide() 保留地图实例（不销毁重建）。
 * 数据来源：VIEWS.state.filtered（已应用年份/器材/相册筛选）。
 *
 * v14（M2）：悬停气泡内嵌缩略图；提供 focus() 供「照片 → 地图」定位；
 *           无 GPS 照片从"消失"变为可点开的独立列表。
 * v15：无 GPS 列表改为按文件夹聚合，点文件夹用 gpsstamp:// 唤起 GPSStamp
 *      补坐标（需要该图片库在设置里填过「本机路径」）。
 */
'use strict';

const MAPVIEW = (() => {
  let _map = null;          // Leaflet 地图实例：只创建一次
  let _cluster = null;      // 聚合图层（插件可用时）
  let _layerGroup = null;   // 插件缺失时的降级图层
  let _tiles = null;        // 当前底图图层
  let _srcIndex = 0;        // 当前底图源下标
  let _errCount = 0;        // 当前底图的连续失败瓦片数
  let _tilesDead = false;   // 所有底图源都失败
  let _bindBounds = true;   // 每次进入视图重新自适应视野

  const _markers = new Map();   // photo.id -> marker，供 focus() 定位
  const _tipUrls = new Map();   // photo.id -> objectURL（悬停气泡里的缩略图）
  let _folders = [];            // 无 GPS 面板当前展示的文件夹
  let _dirs = [];               // 图片库记录缓存（要 dir.name / dir.path）
  let _dirsAt = 0;

  /* 免 API Key 的底图源，按顺序自动降级。
   * 均为 OSM 数据（Web 墨卡托 / WGS84），与 EXIF 经纬度一致，不需要坐标纠偏。
   * 不用 CARTO：basemaps.cartocdn.com 已改为返回 "API KEY REQUIRED" 占位图。 */
  const TILE_SOURCES = [
    { url: 'https://tile.openstreetmap.de/{z}/{x}/{y}.png', sub: 'abc', attr: '&copy; OpenStreetMap contributors' },
    { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', sub: 'abc', attr: '&copy; OpenStreetMap contributors' },
    { url: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png', sub: '', attr: '&copy; OpenStreetMap, SRTM | &copy; OpenTopoMap (CC-BY-SA)' },
  ];

  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* 与 views.js 的 hasGps 判定一致：非法坐标不画点 */
  function validGps(p) {
    const g = p && p.gps;
    return !!(g && isFinite(g.lat) && isFinite(g.lng) &&
      g.lat >= -90 && g.lat <= 90 && g.lng >= -180 && g.lng <= 180);
  }

  function ensureMap() {
    if (_map) return _map;
    if (typeof L === 'undefined') return null;
    const el = $('#map');
    if (!el) return null;

    _map = L.map(el, { worldCopyJump: true, maxZoom: 19 }).setView([32, 108], 3);

    if (typeof L.markerClusterGroup === 'function') {
      _cluster = L.markerClusterGroup({
        maxClusterRadius: 55,
        disableClusteringAtZoom: 14,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
      });
      _map.addLayer(_cluster);
    } else {
      _layerGroup = L.layerGroup().addTo(_map);
    }

    // 无 GPS 面板的开关（只绑一次）
    const chip = $('#map-nogps');
    const closeBtn = $('#map-nogps-close');
    if (chip) chip.addEventListener('click', toggleNoGps);
    if (closeBtn) closeBtn.addEventListener('click', closeNoGps);

    return _map;
  }

  /* 挂载/切换底图：某源连续失败 3 张瓦片就降级到下一个源 */
  function mountTiles() {
    if (_tiles) { _map.removeLayer(_tiles); _tiles = null; }
    const src = TILE_SOURCES[_srcIndex];
    _tiles = L.tileLayer(src.url, {
      maxZoom: 19,
      subdomains: src.sub,
      attribution: src.attr,
    }).addTo(_map);
    _errCount = 0;

    _tiles.on('tileerror', () => {
      _errCount++;
      if (_errCount < 3 || !_tiles) return;
      if (_srcIndex < TILE_SOURCES.length - 1) {
        _srcIndex++;
        console.warn('[Map] 底图源不可用，切换到备用源：' + TILE_SOURCES[_srcIndex].url);
        mountTiles();
        render();
      } else {
        _tilesDead = true;
        console.warn('[Map] 所有底图源都加载失败，请检查网络');
        render();
      }
    });
  }

  function releaseTipUrls() {
    _tipUrls.forEach(u => URL.revokeObjectURL(u));
    _tipUrls.clear();
  }

  function clearLayers() {
    releaseTipUrls();     // 气泡里的缩略图 URL 与这批 marker 同寿命
    _markers.clear();
    if (_cluster) _cluster.clearLayers();
    else if (_layerGroup) _layerGroup.clearLayers();
  }

  function addLayer(m) {
    if (_cluster) _cluster.addLayer(m);
    else if (_layerGroup) _layerGroup.addLayer(m);
  }

  /* 当前筛选结果中带合法经纬度的照片 */
  function geoPhotos() {
    const list = (typeof VIEWS !== 'undefined' && VIEWS.state && VIEWS.state.filtered) || [];
    return list.filter(validGps);
  }

  /* 当前筛选结果中缺少位置信息的部分（地图左下角入口的数据源） */
  function noGeoPhotos() {
    const list = (typeof VIEWS !== 'undefined' && VIEWS.state && VIEWS.state.filtered) || [];
    return list.filter(p => !validGps(p)).sort((a, b) => (b.date || 0) - (a.date || 0));
  }

  /* ---------- 悬停气泡（含缩略图） ---------- */
  function popupNode(p) {
    const el = document.createElement('div');
    el.className = 'map-popup';

    const thumb = document.createElement('div');
    thumb.className = 'map-tip-thumb hidden';
    el.appendChild(thumb);
    el._thumb = thumb;

    const h = document.createElement('h4');
    h.textContent = p.name || '未命名';
    el.appendChild(h);

    if (p.date) {
      const d = document.createElement('div');
      d.textContent = new Date(p.date).toLocaleDateString();
      el.appendChild(d);
    }
    const cam = (typeof EXIF !== 'undefined') ? EXIF.fmtCamera(p.make, p.model) : '';
    if (cam) {
      const c = document.createElement('div');
      c.textContent = cam;
      el.appendChild(c);
    }
    const coord = document.createElement('div');
    coord.className = 'map-popup-coord';
    coord.textContent = `${p.gps.lat.toFixed(4)}, ${p.gps.lng.toFixed(4)}`;
    el.appendChild(coord);
    return el;
  }

  /* 把已缓存的缩略图塞进气泡；未缓存则返回 false，由悬停事件触发生成 */
  function fillTipThumb(p, box) {
    if (!box || box.classList.contains('loaded')) return true;
    let url = _tipUrls.get(p.id);
    if (!url) {
      const blob = (typeof SCAN !== 'undefined' && typeof SCAN.thumbSync === 'function')
        ? SCAN.thumbSync(p) : null;
      if (!blob) return false;
      url = URL.createObjectURL(blob);
      _tipUrls.set(p.id, url);
    }
    const img = document.createElement('img');
    img.alt = '';
    img.src = url;
    box.innerHTML = '';
    box.appendChild(img);
    box.classList.remove('hidden');
    box.classList.add('loaded');
    return true;
  }

  /* 气泡缩略图：先吃内存缓存，未缓存就现场生成一次（同图有 inflight 去重） */
  function ensureTipThumb(p, m) {
    const box = m._tipThumb;
    if (fillTipThumb(p, box)) return;
    if (typeof SCAN !== 'undefined' && typeof SCAN.ensureAssets === 'function') {
      try {
        SCAN.ensureAssets(p, 'thumb').then(a => {
          // marker 可能已经因筛选/重绘被移除，避免往废弃节点里塞图
          if (a && a.thumb && _markers.get(p.id) === m) fillTipThumb(p, box);
        }).catch(() => {});
      } catch (e) { /* 忽略 */ }
    }
  }

  function render() {
    const map = ensureMap();
    const statsEl = $('#map-stats');
    const emptyEl = $('#map-empty');
    if (!map) {
      if (emptyEl) emptyEl.classList.remove('hidden');
      if (statsEl) statsEl.classList.add('hidden');
      return;
    }
    if (!_tiles) mountTiles();

    // 所有底图源都失败时，用统计条提示，避免看到空白就以为功能坏了
    const deadTip = '底图加载失败，请检查网络';

    const photos = geoPhotos();
    clearLayers();
    renderNoGps();

    if (!photos.length) {
      if (emptyEl) emptyEl.classList.remove('hidden');
      if (statsEl) {
        if (_tilesDead) { statsEl.textContent = deadTip; statsEl.classList.remove('hidden'); }
        else statsEl.classList.add('hidden');
      }
      return;
    }
    if (emptyEl) emptyEl.classList.add('hidden');

    const points = [];
    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      const latlng = [p.gps.lat, p.gps.lng];
      points.push(latlng);

      const icon = L.divIcon({
        className: '',
        html: '<div class="map-marker"></div>',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
        tooltipAnchor: [0, -11],
      });
      const m = L.marker(latlng, { icon, title: p.name || '' });
      const tip = popupNode(p);
      m._tipThumb = tip._thumb;
      m.bindTooltip(tip, { direction: 'top', offset: [0, -12], opacity: 1, className: 'map-tip' });

      m.on('mouseover', () => {
        ensureTipThumb(p, m);
        if (typeof SCAN !== 'undefined' && typeof SCAN.ensureAssets === 'function') {
          try {
            SCAN.ensureAssets(p, 'preview').catch(() => {});   // 点开大图时基本命中缓存
          } catch (e) { /* 忽略 */ }
        }
      });

      // 点击直接打开大图（复用作品集里的 Lightbox）
      m.on('click', () => {
        if (typeof VIEWS !== 'undefined' && typeof VIEWS.openLightbox === 'function') {
          VIEWS.openLightbox(photos, i);
        }
      });

      _markers.set(p.id, m);
      addLayer(m);
    }

    if (_bindBounds) {
      if (points.length === 1) map.setView(points[0], 11);
      else map.fitBounds(points, { padding: [40, 40], maxZoom: 12 });
      _bindBounds = false;
    }

    if (statsEl) {
      if (_tilesDead) {
        statsEl.textContent = deadTip;
      } else {
        const years = new Set(photos.map(p => (p.date ? new Date(p.date).getFullYear() : null)).filter(Boolean));
        statsEl.innerHTML = `<b>${photos.length}</b> 张带位置 · <b>${years.size}</b> 个年份`;
      }
      statsEl.classList.remove('hidden');
    }
  }

  /* ---------- 无 GPS 入口：按文件夹聚合，点击交给 GPSStamp ---------- */
  function toast(msg) {
    if (typeof APP !== 'undefined' && APP && typeof APP.toast === 'function') APP.toast(msg);
    else console.log('[map]', msg);
  }

  /* 目录记录只在需要时取一次；授权/移除/设置路径后靠 force 或过期刷新 */
  function refreshDirs(force) {
    if (typeof DB === 'undefined') return;
    if (!force && _dirs.length && Date.now() - _dirsAt < 30000) return;
    DB.listDirs().then(list => {
      _dirs = list || [];
      _dirsAt = Date.now();
      const panel = $('#map-nogps-panel');
      if (panel && !panel.classList.contains('hidden')) renderFolderList(_folders, noGeoPhotos().length);
    }).catch(() => { _dirsAt = Date.now(); });
  }

  function dirOf(id) {
    for (let i = 0; i < _dirs.length; i++) {
      if (String(_dirs[i].id) === String(id)) return _dirs[i];
    }
    return null;
  }

  /* 照片所属的库内子目录：relPath 形如 "2024/春季/IMG_0001.jpg" */
  function folderOf(p) {
    const rel = String(p.relPath || '');
    const i = rel.lastIndexOf('/');
    return i >= 0 ? rel.slice(0, i) : '';
  }

  function folderTitle(g) {
    const d = dirOf(g.dirId);
    const base = d ? d.name : ('库 ' + g.dirId);
    return g.folder ? (base + ' / ' + g.folder.replace(/\//g, ' / ')) : (base + '（根目录）');
  }

  /* 把无 GPS 的照片按「库 + 子目录」归堆，最新的文件夹排前面 */
  function noGeoFolders() {
    const groups = new Map();
    noGeoPhotos().forEach(p => {
      const folder = folderOf(p);
      const key = p.dirId + '|' + folder;
      let g = groups.get(key);
      if (!g) {
        g = { key, dirId: p.dirId, folder, count: 0, latest: 0, sample: p };
        groups.set(key, g);
      }
      g.count++;
      const t = p.date || 0;
      if (t >= g.latest) { g.latest = t; g.sample = p; }
    });
    return Array.from(groups.values()).sort((a, b) => b.latest - a.latest);
  }

  function renderNoGps() {
    refreshDirs();
    const chip = $('#map-nogps');
    const panel = $('#map-nogps-panel');
    const photos = noGeoPhotos();

    if (chip) {
      chip.textContent = `${photos.length} 张照片无位置信息`;
      chip.classList.toggle('hidden', !photos.length);
    }
    if (!photos.length) {
      if (panel && !panel.classList.contains('hidden')) closeNoGps();
      return;
    }
    if (panel && !panel.classList.contains('hidden')) renderFolderList(noGeoFolders(), photos.length);
  }

  function renderFolderList(folders, photoCount) {
    // 文件夹再多也不至于像照片那样成千上万，但仍给个上限
    const MAX_FOLDERS = 120;
    const shown = folders.slice(0, MAX_FOLDERS);
    _folders = shown;

    const title = $('#map-nogps-title');
    if (title) {
      title.textContent = folders.length > MAX_FOLDERS
        ? `无位置信息 · ${folders.length} 个文件夹（仅列最近 ${MAX_FOLDERS} 个）`
        : `无位置信息 · ${folders.length} 个文件夹 / ${photoCount} 张`;
    }
    const box = $('#map-nogps-list');
    if (!box) return;
    box.innerHTML = '';

    shown.forEach(g => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'nogps-item nogps-folder';
      const d = dirOf(g.dirId);
      item.title = (d && d.path ? d.path + (g.folder ? '\\' + g.folder.replace(/\//g, '\\') : '') : folderTitle(g))
        + ' · ' + g.count + ' 张';

      const th = document.createElement('span');
      th.className = 'nogps-thumb';
      const nm = document.createElement('span');
      nm.className = 'nogps-name';
      nm.textContent = folderTitle(g);
      const ct = document.createElement('span');
      ct.className = 'nogps-count';
      ct.textContent = g.count + ' 张';

      item.appendChild(th);
      item.appendChild(nm);
      item.appendChild(ct);

      if (typeof VIEWS !== 'undefined' && typeof VIEWS.thumbInto === 'function') VIEWS.thumbInto(th, g.sample);
      item.addEventListener('click', () => { openFolder(g); });
      box.appendChild(item);
    });
  }

  /* 点文件夹：补全本机路径 → 用 gpsstamp:// 唤起 GPSStamp */
  async function openFolder(g) {
    const d = dirOf(g.dirId);
    if (!d) { toast('找不到该图片库记录，请回设置页刷新后重试'); return; }
    if (typeof APP === 'undefined' || !APP) { toast('页面脚本还没就绪，请稍后再试'); return; }

    let base = APP.normDir(d.path);
    if (!base) {
      base = await APP.askDirPath(d);   // 第一次点会问一次，之后记住
      if (!base) return;
    }
    const full = APP.joinPath(base, g.folder);
    APP.launchGpsStamp(full);
  }

  function toggleNoGps() {
    const panel = $('#map-nogps-panel');
    if (!panel) return;
    if (panel.classList.contains('hidden')) {
      panel.classList.remove('hidden');
      refreshDirs(true);     // 可能刚在设置页填过路径，强制取一次
      renderNoGps();
    } else {
      closeNoGps();
    }
  }

  function closeNoGps() {
    const panel = $('#map-nogps-panel');
    if (panel) panel.classList.add('hidden');
    const box = $('#map-nogps-list');
    if (box) box.innerHTML = '';   // 释放列表节点
    _folders = [];
  }

  /* ---------- 对外：定位到某张照片的点位 ---------- */
  /* 由「在地图中查看」调用：展开聚合、居中并把该点位脉冲一下。
   * 返回 false 表示该照片在当前筛选条件下不在图上。 */
  function focus(p) {
    const map = ensureMap();
    if (!map || !p) return false;
    map.invalidateSize();

    const m = _markers.get(p.id);
    if (!m) return false;

    const reveal = () => {
      m.openTooltip();
      // 程序化打开（用户没有悬停动作）时也要补上缩略图
      ensureTipThumb(p, m);
      const dot = m.getElement() && m.getElement().querySelector('.map-marker');
      if (dot) {
        dot.classList.add('pulse');
        setTimeout(() => dot.classList.remove('pulse'), 1500);
      }
    };

    if (_cluster && typeof _cluster.zoomToShowLayer === 'function') {
      _cluster.zoomToShowLayer(m, reveal);
    } else {
      map.setView(m.getLatLng(), Math.max(map.getZoom(), 13));
      reveal();
    }
    return true;
  }

  /* 进入地图视图：容器刚由 hidden 转为可见，必须先让 Leaflet 重新测量尺寸 */
  function show() {
    _bindBounds = true;
    const map = ensureMap();
    if (!map) { render(); return; }
    map.invalidateSize();
    render();
  }

  /* 离开地图视图：收起面板并释放气泡缩略图的 URL；
   * 再次进入时 render() 会重建 marker，不会留下失效的图片链接。 */
  function hide() {
    closeNoGps();
    releaseTipUrls();
  }

  return { show, hide, render, focus };
})();
