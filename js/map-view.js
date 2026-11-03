/* js/map-view.js — 地图视图（Leaflet + MarkerCluster）
 *
 * 与 views.js 平级：views.js 管作品集/时间轴/相册集，这里只管地图。
 * 进入视图时 show() 渲染 marker，离开时 hide() 保留地图实例（不销毁重建）。
 * 数据来源：VIEWS.state.filtered（已应用年份/器材/相册筛选）。
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

  function clearLayers() {
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
    return list.filter(p => {
      const g = p && p.gps;
      return g && isFinite(g.lat) && isFinite(g.lng) &&
        g.lat >= -90 && g.lat <= 90 && g.lng >= -180 && g.lng <= 180;
    });
  }

  function popupHtml(p) {
    const date = p.date ? new Date(p.date).toLocaleDateString() : '';
    const parts = [`<div class="map-popup"><h4>${esc(p.name || '未命名')}</h4>`];
    if (date) parts.push(`<div>${esc(date)}</div>`);
    const cam = (typeof EXIF !== 'undefined') ? EXIF.fmtCamera(p.make, p.model) : '';
    if (cam) parts.push(`<div>${esc(cam)}</div>`);
    parts.push(`<div class="map-popup-coord">${p.gps.lat.toFixed(4)}, ${p.gps.lng.toFixed(4)}</div>`);
    parts.push('</div>');
    return parts.join('');
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

      // 悬停显示照片信息；点击直接打开大图（复用作品集里的 Lightbox）
      m.bindTooltip(popupHtml(p), { direction: 'top', offset: [0, -12], opacity: 1, className: 'map-tip' });
      // 悬停即开始预生成大图预览，点开时基本命中缓存，减少等待
      m.on('mouseover', () => {
        if (typeof SCAN !== 'undefined' && typeof SCAN.ensureAssets === 'function') {
          try { SCAN.ensureAssets(p, 'preview').catch(() => {}); } catch (e) { /* 忽略 */ }
        }
      });
      m.on('click', () => {
        if (typeof VIEWS !== 'undefined' && typeof VIEWS.openLightbox === 'function') {
          VIEWS.openLightbox(photos, i);
        }
      });
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

  /* 进入地图视图：容器刚由 hidden 转为可见，必须先让 Leaflet 重新测量尺寸 */
  function show() {
    _bindBounds = true;
    const map = ensureMap();
    if (!map) { render(); return; }
    map.invalidateSize();
    render();
  }

  /* 离开地图视图：保留实例与图层，仅用于停止后续刷新 */
  function hide() {}

  return { show, hide, render };
})();
