/* js/map-view.js — 地图视图（Leaflet + MarkerCluster）
 *
 * 与 views.js 平级：views.js 管作品集/时间轴/相册集，这里只管地图。
 * 进入视图时 show() 渲染 marker，离开时 hide() 保留地图实例（不销毁重建）。
 * 数据来源：VIEWS.state.filtered（已应用年份/器材/相册筛选）。
 *
 * v14（M2）：悬停气泡内嵌缩略图；提供 focus() 供「照片 → 地图」定位；
 *           无 GPS 照片从"消失"变为可点开的独立列表。
 * v15：无 GPS 列表改为分组聚合（起初按文件夹，v21 起改为按相册，粒度跟随设置页的「相册识别」）。
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

  /* 选点（MAPPICK）走独立图层：render() 只清空照片点，
   * 否则每次刷新索引就会顺手把用户刚选的位置抹掉。 */
  let _pickLayer = null;
  let _pickMarker = null;

  const _markers = new Map();   // photo.id -> marker，供 focus() 定位
  const _tipUrls = new Map();   // photo.id -> objectURL（悬停气泡里的缩略图）
  let _albums = [];             // 无 GPS 面板当前展示的相册

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
  /* 相册名按中文拼音 + 数字自然顺序排，与相册集「顺序」一致 */
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

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

    _map = L.map(el, { worldCopyJump: true, maxZoom: 19, zoomControl: false }).setView([32, 108], 3);
    // 缩放按钮是搜索框右边那对自绘按钮（index.html / style.css）：
    // 不用 Leaflet 自带控件——它只会竖排、钉在四角，排不进左上角这条工具行
    bindZoomBtns();

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

    _pickLayer = L.layerGroup().addTo(_map);
    // 点空白处移动选点；没有选点时 MAPPICK 自己不接管，不会干扰普通浏览
    _map.on('click', e => {
      if (typeof MAPPICK === 'undefined' || !MAPPICK || typeof MAPPICK.onMapClick !== 'function') return;
      MAPPICK.onMapClick({ lat: e.latlng.lat, lng: e.latlng.lng });
    });

    // 无 GPS 面板的开关（只绑一次）
    const chip = $('#map-nogps');
    const closeBtn = $('#map-nogps-close');
    if (chip) chip.addEventListener('click', toggleNoGps);
    if (closeBtn) closeBtn.addEventListener('click', () => closeNoGps(true));

    return _map;
  }

  /* 左上角工具行里的自绘缩放按钮：点击 zoomIn/zoomOut，zoomend 时同步禁用态 */
  function bindZoomBtns() {
    const zin = $('#map-zoom-in');
    const zout = $('#map-zoom-out');
    if (!zin || !zout) return;
    zin.addEventListener('click', () => _map.zoomIn());
    zout.addEventListener('click', () => _map.zoomOut());
    const paint = () => {
      const z = _map.getZoom();
      zin.disabled = z >= _map.getMaxZoom();
      zout.disabled = z <= _map.getMinZoom();
    };
    _map.on('zoomend', paint);
    paint();
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

  /* ---------- 选点标记（与照片点互不影响） ---------- */
  /* opts.zoom > 0 时把视野拉到该级别（搜索地名用）；否则点已在视野内就不动。 */
  function pickPoint(lat, lng, opts) {
    const map = ensureMap();
    if (!map || !isFinite(lat) || !isFinite(lng)) return false;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;

    const ll = [lat, lng];
    if (!_pickMarker) {
      const icon = L.divIcon({
        className: '',
        html: '<div class="map-pick-marker"><span></span></div>',
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });
      _pickMarker = L.marker(ll, {
        icon, draggable: true, zIndexOffset: 1000, bubblingMouseEvents: false,
        keyboard: false, title: '选点：可拖动微调',
      }).addTo(_pickLayer);
      _pickMarker.on('dragend', () => {
        const p = _pickMarker.getLatLng();
        if (typeof MAPPICK !== 'undefined' && MAPPICK && typeof MAPPICK.onMarkerDrag === 'function') {
          MAPPICK.onMarkerDrag({ lat: p.lat, lng: p.lng });
        }
      });
    } else {
      _pickMarker.setLatLng(ll);
    }

    const zoom = (opts && opts.zoom) || 0;
    // 搜索定位固定用给定级别：跟着当前缩放走的话，从 17 级搜另一个城市会很别扭
    if (zoom) map.setView(ll, zoom, { animate: true });
    else if (!map.getBounds().contains(ll)) map.setView(ll, Math.max(map.getZoom(), 13));
    return true;
  }

  function clearPick() {
    if (_pickMarker) {
      try { _pickLayer.removeLayer(_pickMarker); } catch (e) { /* ignore */ }
      _pickMarker = null;
    }
  }

  /* 把视野移到某处但不落标记：补位置工作台进入时用来给个大致方向
   * （同一批照片通常在同一片区域，比每次从全国视图开始找有用）。 */
  function viewTo(lat, lng, zoom) {
    const map = ensureMap();
    if (!map || !isFinite(lat) || !isFinite(lng)) return false;
    map.setView([lat, lng], zoom || 12, { animate: true });
    return true;
  }

  /* 当前筛选结果中带合法经纬度的照片 */
  function geoPhotos() {
    const list = (typeof VIEWS !== 'undefined' && VIEWS.state && VIEWS.state.filtered) || [];
    return list.filter(validGps);
  }

  /* 当前筛选结果中缺少位置信息的部分（地图右上角入口的数据源） */
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
      // 阻止点击冒泡到地图：选点状态下点照片是为了看大图，
      // 不该顺带把标记挪到这张照片的位置。
      const m = L.marker(latlng, { icon, title: p.name || '', bubblingMouseEvents: false });
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

  /* ---------- 无 GPS 入口：按相册聚合，点击打开应用内补位置工作台 ---------- */
  function toast(msg) {
    if (typeof APP !== 'undefined' && APP && typeof APP.toast === 'function') APP.toast(msg);
    else console.log('[map]', msg);
  }

  /* 相册键与相册集共用同一套粒度规则（VIEWS.albumKeyOf），两边分组才对得上 */
  function albumOf(p) {
    if (typeof VIEWS !== 'undefined' && typeof VIEWS.albumKeyOf === 'function') {
      const k = VIEWS.albumKeyOf(p);
      if (k) return k;
    }
    return '未分类';
  }

  /* 把无 GPS 的照片按相册归堆，相册按名字顺序排列（不提供自定义排序） */
  function noGeoAlbums() {
    const groups = new Map();
    noGeoPhotos().forEach(p => {
      const album = albumOf(p);
      let g = groups.get(album);
      if (!g) {
        g = { album, count: 0, latest: 0, sample: p, photos: [] };
        groups.set(album, g);
      }
      g.count++;
      g.photos.push(p);
      const t = p.date || 0;
      if (t >= g.latest) { g.latest = t; g.sample = p; }
    });
    return Array.from(groups.values()).sort((a, b) => collator.compare(a.album, b.album));
  }

  function renderNoGps() {
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
    if (panel && !panel.classList.contains('hidden')) renderAlbumList(noGeoAlbums(), photos.length);
  }

  function renderAlbumList(albums, photoCount) {
    // 相册再多也不至于像照片那样成千上万，但仍给个上限
    const MAX_ALBUMS = 120;
    const shown = albums.slice(0, MAX_ALBUMS);
    _albums = shown;

    const title = $('#map-nogps-title');
    if (title) {
      title.textContent = albums.length > MAX_ALBUMS
        ? `无位置信息：${albums.length} 个相册（仅列前 ${MAX_ALBUMS} 个）`
        : `无位置信息：${albums.length} 个相册 / ${photoCount} 张照片`;
    }
    const box = $('#map-nogps-list');
    if (!box) return;
    box.innerHTML = '';

    shown.forEach(g => {
      // 行用 div + role=button 而不是原生 button：保持原有键盘处理
      // （Enter / 空格触发），行为与旧版一致
      const item = document.createElement('div');
      item.className = 'nogps-item nogps-folder';
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      const label = g.album.replace(/\//g, ' / ');
      item.title = label + ' · ' + g.count + ' 张';

      const th = document.createElement('span');
      th.className = 'nogps-thumb';
      const nm = document.createElement('span');
      nm.className = 'nogps-name';
      nm.textContent = label;
      const ct = document.createElement('span');
      ct.className = 'nogps-count';
      ct.textContent = g.count + ' 张';

      item.appendChild(th);
      item.appendChild(nm);
      item.appendChild(ct);

      if (typeof VIEWS !== 'undefined' && typeof VIEWS.thumbInto === 'function') VIEWS.thumbInto(th, g.sample);
      item.addEventListener('click', () => { openAlbum(g); });
      item.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAlbum(g); }
      });
      box.appendChild(item);
    });
  }

  /* 点相册：在应用内的大地图上开工（右栏列出该相册缺 GPS 的照片） */
  async function openAlbum(g) {
    if (typeof MAPPICK === 'undefined' || !MAPPICK || typeof MAPPICK.openFolder !== 'function') {
      toast('工作台还没加载完，请稍后再试');
      return;
    }
    closeNoGps();
    try {
      await MAPPICK.openFolder(g);
    } catch (e) {
      toast('打开补位置工作台失败：' + (e && e.message ? e.message : e), true);
    }
  }

  /* 展开：面板顶替右上角那一行胶囊。
   * 补位置工作台占的是同一块位置，先收掉它（选点保留，方便回头继续）。
   * 单独导出：工作台里的「← 返回」要用它把这张列表原样展开回来。 */
  function openNoGps() {
    const panel = $('#map-nogps-panel');
    const chip = $('#map-nogps');
    if (!panel || !panel.classList.contains('hidden')) return;
    if (typeof MAPPICK !== 'undefined' && MAPPICK && typeof MAPPICK.isOpen === 'function' && MAPPICK.isOpen()) {
      if (typeof MAPPICK.closePanel === 'function') MAPPICK.closePanel();
      else MAPPICK.exitPick();
    }
    panel.classList.remove('hidden');
    if (chip) { chip.classList.add('open'); chip.setAttribute('aria-expanded', 'true'); }
    renderNoGps();
  }

  function toggleNoGps() {
    const panel = $('#map-nogps-panel');
    if (!panel) return;
    if (panel.classList.contains('hidden')) openNoGps();
    else closeNoGps();
  }

  /* 收起面板：面板退场，右上角恢复成一行胶囊。
   * refocus 只有点 ▴ 收起时才置真——此时按钮所在的面板即将隐藏，焦点会掉到 body，
   * 顺手还给胶囊；由别处（打开工作台、切视图）触发时不要抢焦点。 */
  function closeNoGps(refocus) {
    const panel = $('#map-nogps-panel');
    if (panel) panel.classList.add('hidden');
    const chip = $('#map-nogps');
    if (chip) { chip.classList.remove('open'); chip.setAttribute('aria-expanded', 'false'); }
    const box = $('#map-nogps-list');
    if (box) box.innerHTML = '';   // 释放列表节点
    _albums = [];
    if (refocus && chip && !chip.classList.contains('hidden')) {
      try { chip.focus({ preventScroll: true }); } catch (e) { /* 旧内核忽略 */ }
    }
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

  /* 进入地图视图：容器刚由 hidden 转为可见，必须先让 Leaflet 重新测量尺寸。
   * 补位置模式开着时不重新自适应视野——用户刚选好的位置不该被一次 fitBounds 冲掉。 */
  function show() {
    const picking = typeof MAPPICK !== 'undefined' && MAPPICK &&
      typeof MAPPICK.isOpen === 'function' && MAPPICK.isOpen();
    _bindBounds = !picking;
    const map = ensureMap();
    if (!map) { render(); return; }
    map.invalidateSize();
    render();
  }

  /* 离开地图视图：收起面板并释放气泡缩略图的 URL；
   * 再次进入时 render() 会重建 marker，不会留下失效的图片链接。
   * 选点标记保留——切去别的视图看两眼再回来，不该丢掉刚选的位置。 */
  function hide() {
    closeNoGps();
    releaseTipUrls();
    if (typeof MAPPICK !== 'undefined' && MAPPICK && typeof MAPPICK.closeResults === 'function') {
      MAPPICK.closeResults();
    }
  }

  return {
    show, hide, render, focus,
    pickPoint, clearPick, viewTo, hasPick: () => !!_pickMarker,
    closeNoGps,          // 补位置工作台打开时要让出右上角
    openNoGps,           // 工作台「← 返回」：把相册列表原样展开回来
  };
})();
