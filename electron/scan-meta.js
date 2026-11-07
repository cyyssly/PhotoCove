/* electron/scan-meta.js — 扫描阶段的元数据解析（主进程侧）
 *
 * 为什么放在主进程：早期是在页面里解析的，流程是「主进程读 512KB → IPC 把字节搬到
 * 渲染进程 → 构造成 File → exifr 解析」。两万张照片意味着 10GB 级的跨进程拷贝与
 * 堆分配，只为算出几百字节的元数据。现在改成主进程读文件头、就地解析，IPC 只回传
 * 一个小对象。
 *
 * 读多少：96KB。这个数是实测出来的——JPEG 的 APP1(EXIF) 段规范上限就是 65535 字节，
 * 加两字节长度域后结束于 65538，取 64KB 会正好切掉最后两个字节，exifr 直接解不出来
 * （本机 BB 001.jpg 就是这种满段 EXIF）。96KB 留出余量，40 张样本与整文件解析结果一致。
 * 尺寸（SOF）偶尔排在 ICC 等大段之后、超出 96KB，调用方会退回一次 512KB 重试。
 * RAW 是例外：头部是 TIFF/厂商私有结构，本来就没有可解析的「尺寸」字段，
 * 且 exiftool 补写的 GPS 常被追加到文件尾部（NEF 9MB、RW2 11MB 处），
 * 512KB 补读既读不到又会让上万张 RAW 多读几 GB，所以调用方对 RAW 一律不补读。
 *
 * 这里只做纯解析，不碰 fs：读文件由 main.js 的 IPC 负责，它已经处理过 \\?\ 长路径。
 */
'use strict';

const path = require('path');

const HEAD_BYTES = 96 * 1024;      // 首次读取量
const RETRY_BYTES = 512 * 1024;    // 尺寸/EXIF 缺失时的补读量（仅非 RAW）

/* 与 js/raw.js 的 RAW_EXTS 保持一致。主进程不加载页面脚本，只能自带一份。 */
const RAW_EXTS = new Set(['cr2', 'cr3', 'arw', 'nef', 'nrw', 'orf', 'raf', 'rw2', 'dng', 'pef', 'srw', 'x3f']);
function isRawExt(ext) { return RAW_EXTS.has(String(ext || '').toLowerCase()); }

let _exifr;                        // undefined = 还没加载，null = 加载失败
function exifrLib() {
  if (_exifr !== undefined) return _exifr;
  try {
    // 浏览器版的 UMD 包，Node 下 require 可直接用；打包后在 app.asar 内，require 依然有效
    _exifr = require(path.join(__dirname, '..', 'assets', 'vendor', 'exifr.full.js'));
  } catch (e) {
    console.warn('[cove] exifr 加载失败，扫描将读不到 EXIF：', e && e.message);
    _exifr = null;
  }
  return _exifr;
}

/* ---------- 尺寸：只读文件头，不解码像素 ---------- */
function dimsFromJpeg(u8) {
  let i = 2;
  const n = u8.length;
  while (i < n - 9) {
    if (u8[i] !== 0xFF) { i++; continue; }
    const m = u8[i + 1];
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
    const len = (u8[i + 2] << 8) | u8[i + 3];
    const isSOF = (m >= 0xC0 && m <= 0xC3) || (m >= 0xC5 && m <= 0xC7) ||
                  (m >= 0xC9 && m <= 0xCB) || (m >= 0xCD && m <= 0xCF);
    if (isSOF) {
      const h = (u8[i + 5] << 8) | u8[i + 6];
      const w = (u8[i + 7] << 8) | u8[i + 8];
      return (w && h) ? { w, h } : null;
    }
    i += 2 + len;
  }
  return null;
}

function dimsFromHead(u8, ext) {
  try {
    if (ext === 'png' && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) {
      const dv = new DataView(u8.buffer, u8.byteOffset);
      return { w: dv.getUint32(16), h: dv.getUint32(20) };
    }
    if (ext === 'gif') {
      return { w: u8[6] | (u8[7] << 8), h: u8[8] | (u8[9] << 8) };
    }
    if (ext === 'bmp') {
      const dv = new DataView(u8.buffer, u8.byteOffset);
      return { w: dv.getInt32(18, true), h: Math.abs(dv.getInt32(22, true)) };
    }
    if (ext === 'webp') {
      const tag = String.fromCharCode(u8[12], u8[13], u8[14], u8[15]);
      if (tag === 'VP8X') {
        const w = 1 + (u8[24] | (u8[25] << 8) | (u8[26] << 16));
        const h = 1 + (u8[27] | (u8[28] << 8) | (u8[29] << 16));
        return { w, h };
      }
      if (tag === 'VP8 ') {
        const w = (u8[26] | (u8[27] << 8)) & 0x3FFF;
        const h = (u8[28] | (u8[29] << 8)) & 0x3FFF;
        return { w, h };
      }
      return null;
    }
    if (ext === 'jpg' || ext === 'jpeg') return dimsFromJpeg(u8);
  } catch (e) { /* 头部不完整或格式异常，交给调用方重试 */ }
  return null;
}

/* ---------- EXIF：与 js/exif.js 的 EXIF.parse 保持同一套字段 ---------- */
const EXIF_OPTS = {
  tiff: true, exif: true, gps: true, ifd0: true,
  iptc: false, xmp: false,
  translateValues: false, reviveValues: true, mergeOutput: true,
};

async function exifFrom(u8) {
  const lib = exifrLib();
  if (!lib || typeof lib.parse !== 'function') return null;
  let d;
  try { d = await lib.parse(u8, EXIF_OPTS); } catch (e) { return null; }
  if (!d || (d.errors && Object.keys(d).length === 1)) return null;
  const out = {
    make: d.Make || '',
    model: d.Model || '',
    lens: d.LensModel || d.LensMake || '',
    focal: d.FocalLength ?? null,
    fnum: d.FNumber ?? null,
    exposure: d.ExposureTime ?? null,
    iso: d.ISO ?? d.ISOSpeedRatings ?? null,
    date: null,
    gps: null,
  };
  const dt = d.DateTimeOriginal || d.CreateDate || d.ModifyDate || null;
  if (dt) {
    const t = (dt instanceof Date) ? dt.getTime() : +new Date(dt);
    if (Number.isFinite(t)) out.date = t;
  }
  if (d.latitude != null && d.longitude != null) out.gps = { lat: d.latitude, lng: d.longitude };
  return out;
}

/* 解析一段文件头。返回可直接跨 IPC 传的纯对象（Date 一律转成毫秒数）。 */
async function describe(u8, ext) {
  const dims = dimsFromHead(u8, ext);
  const ex = await exifFrom(u8);
  return {
    w: (dims && dims.w) || null,
    h: (dims && dims.h) || null,
    make: (ex && ex.make) || '',
    model: (ex && ex.model) || '',
    lens: (ex && ex.lens) || '',
    focal: (ex && ex.focal) ?? null,
    fnum: (ex && ex.fnum) ?? null,
    exposure: (ex && ex.exposure) ?? null,
    iso: (ex && ex.iso) ?? null,
    date: (ex && ex.date) || null,
    gps: (ex && ex.gps) || null,
  };
}

module.exports = { describe, dimsFromHead, isRawExt, HEAD_BYTES, RETRY_BYTES };
