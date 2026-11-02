/* raw.js — RAW 文件内嵌 JPEG 预览提取器（纯 JS，无依赖）
 *
 * 原理：相机拍 RAW 时会同时生成 1~3 张内嵌 JPEG（缩略图/预览/全尺寸预览），
 * 直接从文件字节流中剥离最大的那张 JPEG 作为预览图。
 * 这是 Lightroom / FastRawViewer 快速浏览的通用做法，无需解码传感器数据。
 * 支持 TIFF 系（CR2/ARW/NEF/ORF/RAF/DNG/RW2...）与 CR3（ISO-BMFF 容器）。
 */
'use strict';

const RAW = (() => {
  const RAW_EXTS = new Set(['cr2', 'cr3', 'arw', 'nef', 'nrw', 'orf', 'raf', 'rw2', 'dng', 'pef', 'srw', 'x3f']);
  const MIN_PREVIEW_BYTES = 20000; // 小于 20KB 的 JPEG 视为图标，跳过
  const MAX_SCAN = 96 * 1024 * 1024; // 超过 96MB 的文件只扫前段，防卡顿

  function isRawName(name) {
    const i = name.lastIndexOf('.');
    if (i < 0) return false;
    return RAW_EXTS.has(name.slice(i + 1).toLowerCase());
  }
  function extOf(name) {
    const i = name.lastIndexOf('.');
    return i < 0 ? '' : name.slice(i + 1).toLowerCase();
  }

  /* 在字节流中找出所有 JPEG 流，返回最大的一个 {start,end} */
  function findLargestJpeg(u8) {
    const n = Math.min(u8.length, MAX_SCAN);
    let best = null;
    let i = 0;
    while (i < n - 3) {
      // JPEG SOI: FF D8，后跟段标记 FF xx
      if (u8[i] === 0xFF && u8[i + 1] === 0xD8 && u8[i + 2] === 0xFF) {
        // 找 EOI: FF D9（熵编码内 FF 会转义为 FF00，不会误命中）
        let end = -1;
        for (let j = i + 2; j < n - 1; j++) {
          if (u8[j] === 0xFF && u8[j + 1] === 0xD9) { end = j + 2; break; }
        }
        if (end > 0 && end - i > MIN_PREVIEW_BYTES && (!best || end - i > best.end - best.start)) {
          best = { start: i, end };
          i = end; // 最大的预览通常在文件后段，跳过本段继续找更大的
        } else {
          i += 2;
        }
      } else {
        i++;
      }
    }
    return best;
  }

  /* 输入 File/Blob，输出预览 Blob（JPEG）；失败返回 null */
  async function extractPreview(blob) {
    try {
      const buf = await blob.slice(0, MAX_SCAN).arrayBuffer();
      const u8 = new Uint8Array(buf);
      const hit = findLargestJpeg(u8);
      if (!hit) return null;
      return blob.slice(hit.start, hit.end, 'image/jpeg');
    } catch (e) {
      console.warn('RAW preview extract failed:', e);
      return null;
    }
  }

  return { isRawName, extOf, extractPreview };
})();
