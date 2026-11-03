/* views.js — 三个展示视图 + 筛选 + Lightbox（缩略图按需生成） */
'use strict';

const VIEWS = (() => {
  const state = {
    photos: [],
    filtered: [],
    dirs: new Map(),
    view: 'portfolio',
    album: null,
    filters: { year: '', camera: '', album: '' },
    lbList: [], lbIndex: 0,
  };
  const _urls = [];

  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- 数据入口 ---------- */
  async function reload() {
    // 扫描中的增量刷新要保住用户当前浏览进度，否则每次刷新都被打回顶部
    const keepCount = _pager ? _pager.count() : 0;
    const keepY = window.scrollY;
    state.photos = await DB.allPhotos();
    const dirs = await DB.listDirs();
    state.dirs = new Map(dirs.map(d => [d.id, d.name]));
    buildFilterOptions();
    applyFilters();
    render();
    if (keepCount > BATCH && _pager && state.view !== 'settings') {
      _pager.loadTo(keepCount);
      window.scrollTo(0, keepY);
    }
  }

  function albumKeyOf(p) {
    const seg = p.relPath.split('/')[0];
    return seg !== p.name ? seg : (state.dirs.get(p.dirId) || '未分类');
  }

  /* ---------- 筛选 ---------- */
  function buildFilterOptions() {
    const years = new Set(), cams = new Set(), albums = new Set();
    for (const p of state.photos) {
      if (p.date) years.add(new Date(p.date).getFullYear());
      const cam = EXIF.fmtCamera(p.make, p.model);
      if (cam) cams.add(cam);
      albums.add(albumKeyOf(p));
    }
    fillSelect($('#filter-year'), [...years].sort((a, b) => b - a), '全部年份');
    fillSelect($('#filter-camera'), [...cams].sort(), '全部器材');
    fillSelect($('#filter-album'), [...albums].sort(), '全部相册');
    $('#filter-year').value = state.filters.year;
    $('#filter-camera').value = state.filters.camera;
    $('#filter-album').value = state.filters.album;
  }
  function fillSelect(sel, values, label) {
    const cur = sel.value;
    sel.innerHTML = `<option value="">${label}</option>` + values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    if (values.includes(cur)) sel.value = cur;
  }

  function applyFilters() {
    const { year, camera, album } = state.filters;
    state.filtered = state.photos.filter(p => {
      if (year && String(p.date ? new Date(p.date).getFullYear() : '') !== year) return false;
      if (camera && EXIF.fmtCamera(p.make, p.model) !== camera) return false;
      if (album && albumKeyOf(p) !== album) return false;
      return true;
    });
    $('#filter-count').textContent = state.filtered.length ? `${state.filtered.length} 张照片` : '';
  }

  /* ---------- 渲染 ---------- */
  function render() {
    $('#filter-bar').classList.toggle('hidden', state.view === 'settings');
    ['portfolio', 'timeline', 'albums', 'map', 'settings'].forEach(v =>
      $('#view-' + v).classList.toggle('hidden', v !== state.view));
    revokeUrls();
    if (state.view === 'portfolio') renderPortfolio();
    else if (state.view === 'timeline') renderTimeline();
    else if (state.view === 'albums') state.album ? renderAlbumDetail() : renderAlbums();
    else if (state.view === 'map') {
      if (typeof MAPVIEW !== 'undefined') MAPVIEW.show();
    } else if (typeof MAPVIEW !== 'undefined') {
      MAPVIEW.hide();
    }
  }

  /* 图片/占位：有缩略图立即显示，没有则占位并在进入视口时按需生成
   * failReason：已知的失败原因（由懒加载回调传入），有值时直接渲染提示，不再排队重试。
   * 之前这里会把授权失败的元素重新塞回观察队列，元素本来就可见 → 立刻再次触发 →
   * 无限循环，把主线程和 IndexedDB 读请求全占满，表现为"只出来几张，其余永远空白"。 */
  function fillMedia(el, p, cover, failReason) {
    const old = el.querySelector('img, .ph');
    if (old) old.remove();

    // 内存里已缓存 → 同步出图，不用等异步，滚动时不会闪占位
    const cached = SCAN.thumbSync(p);
    if (cached) { showedImg(el, cached); return; }

    const ph = document.createElement('div');
    ph.className = 'ph';
    if (!cover) ph.style.aspectRatio = (p.width && p.height) ? `${p.width} / ${p.height}` : '3 / 2';

    // 永久不可用：RAW 支持未开启
    if (p.isRaw && p.thumbState === 'unavailable') {
      ph.textContent = 'RAW';
      el.appendChild(ph);
      return;
    }

    // 已知失败原因（授权缺失 / 解码失败 / 超时 / 文件缺失）：给出可点击重试的占位
    const fail = failReason || (SCAN.isFailed(p.id) ? SCAN.failedReason(p.id) : null);
    if (fail) {
      ph.classList.add('ph-fail');
      ph.textContent = fail === 'permission' || fail === 'no-handle'
        ? '需要目录授权'
        : (fail === 'timeout' ? '加载超时 · 点击重试' : '加载失败 · 点击重试');
      el.appendChild(ph);
      if (fail !== 'permission' && fail !== 'no-handle') {
        ph.addEventListener('click', (e) => {
          e.stopPropagation();
          SCAN.retry(p);
          ph.textContent = '…';
          el.removeChild(ph);
          fillMedia(el, p, cover);
        });
      }
      return;
    }

    el.appendChild(ph);
    lazyQueue.push(el, p, cover);
  }

  function showedImg(el, blob) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    const url = URL.createObjectURL(blob);
    _urls.push(url);
    img.src = url;
    img.onload = () => img.classList.add('loaded');
    el.appendChild(img);
  }

  /* 懒生成队列：元素进入视口时请求缩略图 */
  const lazyWaiters = new WeakMap();
  const lazyQueue = {
    push(el, p, cover) { lazyWaiters.set(el, { p, cover }); lazyIO.observe(el); },
  };
  const lazyIO = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const rec = lazyWaiters.get(en.target);
      if (!rec) continue;
      lazyIO.unobserve(en.target);
      lazyWaiters.delete(en.target);
      const { p, cover } = rec;
      // 失败时也要回到 fillMedia，由它渲染「点击重试 / 需要授权」占位，
      // 否则元素会停在一个没有任何反馈的空占位上
      SCAN.ensureAssets(p, 'thumb')
        .catch(() => null)
        .then(res => {
          if (!en.target.isConnected) return;
          let reason = null;
          if (res && res.error) reason = res.error;
          else if (!res || !res.thumb) reason = SCAN.failedReason(p.id) || 'decode';
          // 只有真的拿到图才重新排队；有 reason 时 fillMedia 会直接渲染提示，不会再次 observe
          if (reason && !(res && res.thumb)) fillMedia(en.target, p, cover, reason);
          else fillMedia(en.target, p, cover);
        });
    }
  }, { rootMargin: '300px' });

  function photoItem(p, cls, onClick) {
    const el = document.createElement('div');
    el.className = cls + (p.isRaw ? ' is-raw' : '');
    // 供瀑布流估算高度（没有分辨率信息时按 3:2 横图估）
    el.dataset.ratio = (p.width && p.height) ? (p.height / p.width).toFixed(3) : '0.667';
    fillMedia(el, p, cls === 'tl-item');
    if (p.isRaw) {
      const tag = document.createElement('span');
      tag.className = 'item-raw-tag';
      tag.textContent = p.ext.toUpperCase();
      el.appendChild(tag);
    }
    const d = document.createElement('span');
    d.className = 'item-date';
    d.textContent = p.date ? fmtDate(p.date) : p.name;
    el.appendChild(d);
    el.addEventListener('click', () => onClick(p));
    // 悬停 220ms 后预取大图预览：光标停留多半意味着要打开这张，提前解码省掉等待
    let hoverTimer = null;
    el.addEventListener('mouseenter', () => {
      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        try { SCAN.ensureAssets(p, 'preview').catch(() => {}); } catch (e) { /* 忽略 */ }
      }, 220);
    });
    el.addEventListener('mouseleave', () => {
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    });
    return el;
  }

  /* ---------- 分批加载基础设施 ----------
   * 几万张照片一次性建 DOM 会直接把页面拖死，所以每批只建 BATCH 个节点：
   * 页脚哨兵进入视口（或点「加载更多」）时再追加下一批。 */
  const BATCH = 36;             // 每批渲染的照片数（约 7 行瀑布流，够填满一屏）
  let _pagers = [];
  let _activeMasonry = null;
  let _pager = null;            // 当前视图的分页器（供 reload 保留进度）

  function clearPagers() {
    _pagers.forEach(p => p.destroy());
    _pagers = [];
    _activeMasonry = null;
    _pager = null;
    document.querySelectorAll('.page-foot').forEach(el => el.remove());
  }

  function makeFooter() {
    const f = document.createElement('div');
    f.className = 'page-foot';
    f.innerHTML = '<span class="page-note"></span><button class="btn btn-small btn-ghost page-more" type="button">加载更多</button>';
    return f;
  }

  function setupPager({ footer, total, render, batch = BATCH }) {
    let i = 0;
    let io = null;
    let destroyed = false;
    const note = footer.querySelector('.page-note');
    const btn = footer.querySelector('.page-more');

    function update() {
      if (i >= total) {
        note.textContent = total ? `已显示全部 ${total} 张` : '';
        btn.classList.add('hidden');
        if (io) { io.disconnect(); io = null; }
      } else {
        note.textContent = `已加载 ${i} / ${total} 张`;
        btn.classList.remove('hidden');
      }
    }

    function more() {
      if (destroyed || i >= total) return;
      loadTo(i + batch);
      // 内容不足以撑满一屏时继续补，避免出现「空屏 + 页脚」
      if (i < total) {
        requestAnimationFrame(() => {
          if (destroyed || i >= total) return;
          if (footer.getBoundingClientRect().top < window.innerHeight + 600) more();
        });
      }
    }

    // 一次补到指定数量（用于 reload 恢复已加载进度）
    function loadTo(n) {
      if (destroyed) return;
      while (i < total && i < n) {
        const end = Math.min(total, i + batch);
        render(i, end);
        i = end;
      }
      update();
    }

    io = new IntersectionObserver(es => {
      if (es.some(e => e.isIntersecting)) more();
    }, { rootMargin: '700px' });
    io.observe(footer);
    btn.addEventListener('click', more);

    _pagers.push({
      destroy() {
        destroyed = true;
        if (io) { io.disconnect(); io = null; }
        btn.removeEventListener('click', more);
      },
    });
    _pager = { count: () => i, loadTo };
    more();
  }

  /* 瀑布流列：JS 维护若干等宽列，把新项放进当前估计最矮的一列。
   * 不用 CSS column-count 是因为它每次追加都会重新平衡所有列，已显示的照片会跳位。 */
  function masonryColumnCount() {
    const w = window.innerWidth;
    if (w <= 760) return 2;
    if (w <= 1100) return 3;
    if (w <= 1400) return 4;
    return 5;
  }

  function setupMasonry(grid) {
    const GAP = 10;
    const cols = [];
    const heights = [];
    let colW = 1;

    function build(n) {
      grid.innerHTML = '';
      cols.length = 0; heights.length = 0;
      for (let i = 0; i < n; i++) {
        const c = document.createElement('div');
        c.className = 'masonry-col';
        grid.appendChild(c);
        cols.push(c); heights.push(0);
      }
      colW = Math.max(60, (grid.clientWidth - (n - 1) * GAP) / n);
    }
    function place(el) {
      let k = 0;
      for (let i = 1; i < heights.length; i++) if (heights[i] < heights[k] - 0.5) k = i;
      cols[k].appendChild(el);
      heights[k] += colW * (parseFloat(el.dataset.ratio) || 0.667) + GAP;
    }

    build(masonryColumnCount());

    const api = {
      add: place,
      // 窗口尺寸变化：按新列数重新分配已加载的项，避免列宽突变后布局错乱
      relayout() {
        const items = [...grid.querySelectorAll('.masonry-item')];
        build(masonryColumnCount());
        items.forEach(place);
      },
    };
    _activeMasonry = api;
    return api;
  }

  /* ---- 作品集 ---- */
  function renderPortfolio() {
    clearPagers();
    const grid = $('#portfolio-grid');
    const list = sortedByDate(state.filtered);
    $('#portfolio-empty').classList.toggle('hidden', state.photos.length > 0);

    const masonry = setupMasonry(grid);
    const footer = makeFooter();
    grid.after(footer);

    setupPager({
      footer, total: list.length,
      render: (from, to) => {
        for (let i = from; i < to; i++) {
          masonry.add(photoItem(list[i], 'masonry-item', openLightboxFrom(list, list[i])));
        }
      },
    });
  }

  /* ---- 时间轴 ---- */
  function renderTimeline() {
    clearPagers();
    const wrap = $('#timeline');
    wrap.innerHTML = '';
    const list = sortedByDate(state.filtered).filter(p => p.date);
    $('#timeline-empty').classList.toggle('hidden', list.length > 0);

    // 月份计数：用于「X 月 · N 张」标签（分组头可能在后续批次才出现）
    const monthCount = new Map();
    for (const p of list) {
      const d = new Date(p.date);
      const k = d.getFullYear() + '-' + d.getMonth();
      monthCount.set(k, (monthCount.get(k) || 0) + 1);
    }

    const footer = makeFooter();
    wrap.appendChild(footer);

    let lastYear = null, lastMonth = null, grid = null;

    setupPager({
      footer, total: list.length,
      render: (from, to) => {
        const frag = document.createDocumentFragment();
        for (let i = from; i < to; i++) {
          const p = list[i];
          const d = new Date(p.date);
          const y = d.getFullYear();
          const k = y + '-' + d.getMonth();
          if (y !== lastYear) {
            const yEl = document.createElement('div');
            yEl.className = 'timeline-year';
            yEl.textContent = y + ' 年';
            frag.appendChild(yEl);
            lastYear = y; lastMonth = null; grid = null;
          }
          if (k !== lastMonth) {
            const mEl = document.createElement('div');
            mEl.className = 'timeline-month';
            mEl.textContent = (d.getMonth() + 1) + ' 月 · ' + (monthCount.get(k) || 0) + ' 张';
            frag.appendChild(mEl);
            grid = document.createElement('div');
            grid.className = 'tl-grid';
            frag.appendChild(grid);
            lastMonth = k;
          }
          grid.appendChild(photoItem(p, 'tl-item', openLightboxFrom(list, p)));
        }
        wrap.insertBefore(frag, footer);
      },
    });
  }

  /* ---- 相册集 ---- */
  function renderAlbums() {
    clearPagers();
    const grid = $('#albums-grid');
    grid.innerHTML = '';
    $('#album-detail').classList.add('hidden');
    $('#albums-grid').classList.remove('hidden');
    const map = new Map();
    for (const p of state.filtered) {
      const k = albumKeyOf(p);
      if (!map.has(k)) map.set(k, { name: k, items: [], cover: null });
      const a = map.get(k);
      a.items.push(p);
      if (!a.cover && (SCAN.thumbSync(p) || p.width)) a.cover = p;
    }
    const albums = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
    albums.forEach(a => {
      const card = document.createElement('div');
      card.className = 'album-card';
      card.innerHTML = `
        <div class="album-cover"><span class="album-count">${a.items.length} 张</span></div>
        <div class="album-meta"><div class="album-name">${esc(a.name)}</div>
        <div class="album-sub">${a.items[0] && a.items[0].date ? fmtDate(a.items[0].date) : ''}</div></div>`;
      const coverEl = card.querySelector('.album-cover');
      if (a.cover) fillMedia(coverEl, a.cover, false);
      // 封面优先复用它，点击进相册
      card.addEventListener('click', () => { state.album = a.name; renderAlbumDetail(); });
      grid.appendChild(card);
    });
    $('#albums-empty').classList.toggle('hidden', state.photos.length > 0);
  }

  function renderAlbumDetail() {
    clearPagers();
    $('#albums-grid').classList.add('hidden');
    const detail = $('#album-detail');
    detail.classList.remove('hidden');
    const list = sortedByDate(state.filtered.filter(p => albumKeyOf(p) === state.album));
    $('#album-title').textContent = `${state.album}（${list.length} 张）`;

    const grid = $('#album-grid');
    const masonry = setupMasonry(grid);
    const footer = makeFooter();
    grid.after(footer);

    setupPager({
      footer, total: list.length,
      render: (from, to) => {
        for (let i = from; i < to; i++) {
          masonry.add(photoItem(list[i], 'masonry-item', openLightboxFrom(list, list[i])));
        }
      },
    });
  }

  /* ---- 排序与日期 ---- */
  function sortedByDate(list) {
    return [...list].sort((a, b) => (b.date || 0) - (a.date || 0));
  }
  function fmtDate(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /* ---------- Lightbox ---------- */
  /* 大图专用 URL 缓存：同一个 Blob 只创建一次 blob URL，
   * 否则每次切换都新建 URL，浏览器会把它当成新资源、重新解码一遍大图。 */
  const _lbUrls = new Map();   // 'id|kind' -> objectURL
  function lbUrl(blob, key) {
    if (!blob) return null;
    let u = _lbUrls.get(key);
    if (u) return u;
    u = URL.createObjectURL(blob);
    _lbUrls.set(key, u);
    return u;
  }
  function releaseLbUrls() {
    _lbUrls.forEach(u => URL.revokeObjectURL(u));
    _lbUrls.clear();
  }

  function openLightboxFrom(list, p) {
    return () => {
      const i = list.indexOf(p);
      if (i < 0) return;
      state.lbList = list;
      state.lbIndex = i;
      showLb();
    };
  }

  /* 供其他视图（地图）直接打开：指定列表与下标 */
  function openLightbox(list, index) {
    if (!list || !list.length) return;
    state.lbList = list;
    state.lbIndex = Math.max(0, Math.min(index || 0, list.length - 1));
    showLb();
  }

  function showLb() {
    $('#lightbox').classList.remove('hidden');
    renderLb();
  }

  let _lbToken = 0;
  async function renderLb() {
    const p = state.lbList[state.lbIndex];
    if (!p) return;
    const token = ++_lbToken;
    const img = $('#lb-img');
    const spinner = $('#lb-spinner');

    // 先显示已缓存的缩略图（如有），避免空白
    const thumbBlob = SCAN.thumbSync(p);
    if (thumbBlob) {
      img.src = lbUrl(thumbBlob, p.id + '|thumb');
      img.style.visibility = 'visible';
      spinner.classList.add('hidden');
    } else {
      img.style.visibility = 'hidden';
      spinner.classList.remove('hidden');
    }

    // 高清显示：不超过屏幕分辨率的照片直接吃原图；超过的用按屏幕长边生成的降采样预览
    const assets = await SCAN.ensureAssets(p, 'preview');
    if (token !== _lbToken) return; // 已切到别的照片

    let url = null;
    let cached = false;
    if (assets && assets.preview) {
      // 同一张照片重复打开时复用同一个 blob URL，浏览器可直接命中解码缓存
      url = lbUrl(assets.preview, p.id + '|preview');
      cached = true;
    } else if (!p.isRaw || (assets && assets.useOriginal)) {
      // useOriginal，或解码失败（assets 为 null）时退回原图一试
      url = await SCAN.originalUrl(p).catch(() => null);
      if (token !== _lbToken) { if (url) URL.revokeObjectURL(url); return; }
    }

    if (url) {
      if (!cached) _urls.push(url);
      const tmp = new Image();
      tmp.onload = () => {
        if (token !== _lbToken) return;
        img.src = url;
        img.style.visibility = 'visible';
        spinner.classList.add('hidden');
      };
      tmp.onerror = () => { if (token === _lbToken && !thumbBlob) spinner.classList.add('hidden'); };
      tmp.src = url;
    } else if (!thumbBlob) {
      spinner.classList.add('hidden');
    }

    // 信息条
    const parts = [`<b>${esc(p.name)}</b>`];
    const cam = EXIF.fmtCamera(p.make, p.model);
    if (cam) parts.push(esc(cam));
    if (p.lens) parts.push(`<span class="exif-dim">${esc(p.lens)}</span>`);
    const ex = [
      p.focal ? EXIF.fmtFocal(p.focal) : '',
      p.fnum ? EXIF.fmtFnum(p.fnum) : '',
      p.exposure ? EXIF.fmtExposure(p.exposure) : '',
      p.iso ? EXIF.fmtIso(p.iso) : '',
    ].filter(Boolean).join(' · ');
    if (ex) parts.push(ex);
    if (p.date) parts.push(fmtDate(p.date));
    if (p.width && p.height) parts.push(`<span class="exif-dim">${p.width}×${p.height}</span>`);
    if (!p.isRaw && assets && assets.useOriginal) parts.push('<span class="exif-dim">原图直出</span>');
    if (assets && assets.error === 'permission') parts.push('<span class="exif-dim">需要目录授权</span>');
    else if (assets && assets.error && assets.error !== 'raw-off') parts.push('<span class="exif-dim">预览生成失败</span>');
    if (p.isRaw) parts.push(`<span class="exif-dim">RAW·机内预览</span>`);
    $('#lb-info').innerHTML = parts.filter(Boolean).join('<span class="exif-dim"> ｜ </span>');

    renderStrip();

    // 预取左右相邻各一张的预览：浏览器空闲时生成，
    // 之后按 ← / → 或滚轮切换就能直接命中内存缓存，不用再等解码。
    prefetchNeighbors();
  }

  let _prefetchToken = 0;
  function prefetchNeighbors() {
    const list = state.lbList;
    const n = list.length;
    if (n < 2) return;
    const cur = list[state.lbIndex];
    const targets = [
      list[(state.lbIndex + 1) % n],
      list[(state.lbIndex - 1 + n) % n],
    ].filter(q => q && q !== cur);
    if (!targets.length) return;

    const token = ++_prefetchToken;
    const run = () => {
      if (token !== _prefetchToken) return;   // 已经切到别处，放弃这次预取
      targets.forEach(q => {
        try { SCAN.ensureAssets(q, 'preview').catch(() => {}); } catch (e) { /* 忽略 */ }
      });
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2000 });
    else setTimeout(run, 300);
  }

  function renderStrip() {
    const strip = $('#lb-strip');
    strip.innerHTML = '';
    const n = state.lbList.length;
    // 只渲染当前附近的项，避免上千张时创建海量节点
    const from = Math.max(0, state.lbIndex - 20), to = Math.min(n, state.lbIndex + 21);
    for (let i = from; i < to; i++) {
      const q = state.lbList[i];
      const qb = SCAN.thumbSync(q);
      let t;
      if (qb) {
        t = document.createElement('img');
        t.src = lbUrl(qb, q.id + '|thumb');
      } else {
        t = document.createElement('div');
        t.className = 'strip-ph';
      }
      if (i === state.lbIndex) t.classList.add('active');
      t.addEventListener('click', () => { state.lbIndex = i; renderLb(); });
      strip.appendChild(t);
    }
    strip.querySelector('.active')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  function lbStep(d) {
    const n = state.lbList.length;
    if (!n) return;
    state.lbIndex = (state.lbIndex + d + n) % n;
    renderLb();
  }
  /* 全屏浏览：点击图片进入浏览器全屏，再次点击退出 */
  function toggleLbFullscreen() {
    const lb = $('#lightbox');
    if (document.fullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
      return;
    }
    if (lb.requestFullscreen) lb.requestFullscreen().catch(() => {});
  }

  function closeLb() {
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    $('#lightbox').classList.add('hidden');
    $('#lb-img').removeAttribute('src');
    releaseLbUrls();
    _lbToken++;
  }

  function revokeUrls() {
    const olds = _urls.splice(0);
    setTimeout(() => olds.forEach(u => URL.revokeObjectURL(u)), 30000);
  }

  /* ---------- 事件 ---------- */
  function init() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.view = btn.dataset.view;
        if (state.view !== 'albums') state.album = null;
        render();
      });
    });
    document.querySelectorAll('[data-goto]').forEach(a => {
      a.addEventListener('click', e => { e.preventDefault(); document.querySelector(`.nav-btn[data-view="${a.dataset.goto}"]`).click(); });
    });
    $('#filter-year').addEventListener('change', e => { state.filters.year = e.target.value; applyFilters(); render(); });
    $('#filter-camera').addEventListener('change', e => { state.filters.camera = e.target.value; applyFilters(); render(); });
    $('#filter-album').addEventListener('change', e => { state.filters.album = e.target.value; applyFilters(); render(); });
    $('#album-back').addEventListener('click', () => { state.album = null; renderAlbums(); });
    $('#lb-close').addEventListener('click', closeLb);
    $('#lb-prev').addEventListener('click', () => lbStep(-1));
    $('#lb-next').addEventListener('click', () => lbStep(1));
    document.addEventListener('keydown', e => {
      if ($('#lightbox').classList.contains('hidden')) return;
      if (e.key === 'Escape') closeLb();
      else if (e.key === 'ArrowLeft') lbStep(-1);
      else if (e.key === 'ArrowRight') lbStep(1);
    });
    let touchX = null;
    $('#lightbox').addEventListener('touchstart', e => { touchX = e.touches[0].clientX; }, { passive: true });
    $('#lightbox').addEventListener('touchend', e => {
      if (touchX === null) return;
      const dx = e.changedTouches[0].clientX - touchX;
      if (Math.abs(dx) > 60) lbStep(dx > 0 ? -1 : 1);
      touchX = null;
    }, { passive: true });
    // 滚轮切换：260ms 冷却，避免触控板一次滑动连翻好几张
    let wheelLock = 0;
    $('#lightbox').addEventListener('wheel', e => {
      if ($('#lightbox').classList.contains('hidden')) return;
      e.preventDefault();
      const now = Date.now();
      if (now - wheelLock < 260) return;
      wheelLock = now;
      lbStep(e.deltaY > 0 ? 1 : -1);
    }, { passive: false });

    // 点击图片区域进入/退出全屏；点击黑边关闭
    $('#lightbox').addEventListener('click', e => {
      if (e.target.id === 'lightbox') { closeLb(); return; }
      if (e.target.closest('.lb-stage')) toggleLbFullscreen();
    });

    // 窗口尺寸变化：重排已加载的瀑布流（只动已加载的节点，不重新分页）
    let rszTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(rszTimer);
      rszTimer = setTimeout(() => { if (_activeMasonry) _activeMasonry.relayout(); }, 180);
    });
  }

  return { init, reload, render, state, openLightbox };
})();
