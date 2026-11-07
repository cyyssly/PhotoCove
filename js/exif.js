/* exif.js — EXIF 字段格式化 + 页面侧解析（备用）
 *
 * 扫描已经改由主进程完成（electron/scan-meta.js）：那边读文件头就地解析，
 * 只把尺寸/EXIF 回传，页面不再经手照片字节。这里的 parse() / thumbnail()
 * 保留作为备用路径（例如将来要把解析搬回页面），当前扫描不调用。 */
'use strict';

const EXIF = (() => {
  /* 解析一张图片，返回统一结构的元数据 */
  async function parse(fileOrBlob) {
    const out = {
      make: '', model: '', lens: '',
      focal: null, fnum: null, exposure: null, iso: null,
      date: null,        // 拍摄时间 (Date)
      gps: null,
      width: null, height: null,
      thumb: null,       // exifr 内嵌缩略图 Blob（备用）
    };
    if (typeof exifr === 'undefined') return out;
    try {
      const d = await exifr.parse(fileOrBlob, {
        tiff: true, exif: true, gps: true, ifd0: true, iptc: false, xmp: false,
        translateValues: false, reviveValues: true, mergeOutput: true,
      });
      if (!d) return out;
      out.make = d.Make || '';
      out.model = d.Model || '';
      out.lens = d.LensModel || d.LensMake || '';
      out.focal = d.FocalLength ?? null;
      out.fnum = d.FNumber ?? null;
      out.exposure = d.ExposureTime ?? null;
      out.iso = d.ISO ?? d.ISOSpeedRatings ?? null;
      out.date = d.DateTimeOriginal || d.CreateDate || d.ModifyDate || null;
      if (d.latitude != null && d.longitude != null) out.gps = { lat: d.latitude, lng: d.longitude };
    } catch (e) { /* 非 JPEG/无 EXIF，忽略 */ }
    return out;
  }

  /* exifr 自带的缩略图提取（小图，仅 RAW 兜底时可能用到） */
  async function thumbnail(fileOrBlob) {
    try { return await exifr.thumbnail(fileOrBlob); } catch (e) { return null; }
  }

  /* 格式化工具 */
  function fmtFocal(v) { return v ? `${Math.round(v)}mm` : ''; }
  function fmtFnum(v) { return v ? `ƒ/${(+v).toFixed(1).replace(/\.0$/, '')}` : ''; }
  function fmtExposure(v) {
    if (!v) return '';
    return v >= 1 ? `${+v.toFixed(1)}s` : `1/${Math.round(1 / v)}s`;
  }
  function fmtIso(v) { return v ? `ISO ${v}` : ''; }
  function fmtCamera(make, model) {
    let m = (make || '').trim(), mo = (model || '').trim();
    if (!m && !mo) return '';
    // 去掉 model 里重复的品牌前缀
    if (m && mo && mo.toUpperCase().startsWith(m.toUpperCase())) mo = mo.slice(m.length).trim();
    return [m, mo].filter(Boolean).join(' ');
  }

  return { parse, thumbnail, fmtFocal, fmtFnum, fmtExposure, fmtIso, fmtCamera };
})();
