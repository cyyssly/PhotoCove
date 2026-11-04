/* platform/desktop.js — 桌面壳（Electron）实现
 *
 * 与 web.js 的差别只有来源：
 *   浏览器：目录句柄 + 每次启动重新授权，拿不到绝对路径；
 *   桌面壳：绝对路径 + 直接读盘，没有授权概念。
 *
 * 这里有两处刻意的取舍，都不是随手写的：
 *
 * 1) 扫描阶段只读文件开头 512KB（readHead），不整文件读。
 *    exifr 是按需切片读的，256KB 足够覆盖 JPEG 的 APP1（规范上限 64KB）
 *    与绝大多数 HEIC/TIFF 的 IFD0。整文件读的话，两万张照片的首轮扫描
 *    要搬上百 GB 数据过 IPC，直接不可用。
 * 2) 真正要解码显示时才读整文件（openFile），而原图大图直接用 covefile://
 *    交给 Chromium 自己流式加载（imageUrl），不进 JS 堆。
 */
'use strict';

(() => {
  const D = typeof window !== 'undefined' ? window.__COVE_DESKTOP : null;
  if (!D) return;                       // 浏览器环境：什么都不做，等 web.js 注册

  // 供 CSS 区分平台文案（使用须知里浏览器版与桌面版说的不是一回事）
  try { document.documentElement.classList.add('is-desktop'); } catch (e) { /* ignore */ }

  const HEAD_BYTES = 512 * 1024;

  /* Windows 路径拼接：库里 relPath 一律用 / 分隔，磁盘上用 \ */
  function join(root, rel) {
    const base = String(root == null ? '' : root).replace(/[\\/]+$/, '');
    const r = String(rel == null ? '' : rel).replace(/^[\\/]+/, '').replace(/\//g, '\\');
    return r ? base + '\\' + r : base;
  }
  function norm(p) {
    return String(p == null ? '' : p).trim().replace(/[\\/]+$/, '').toLowerCase();
  }
  function fileNameOf(rel) {
    const parts = String(rel || '').split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  const MIME_BY_EXT = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', jfif: 'image/jpeg',
    png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
    avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
    tif: 'image/tiff', tiff: 'image/tiff',
  };
  function mimeOf(name) {
    const i = String(name || '').lastIndexOf('.');
    const ext = i >= 0 ? name.slice(i + 1).toLowerCase() : '';
    return MIME_BY_EXT[ext] || '';
  }

  /* 目录存在性：桌面端没有「授权」这回事，目录读不到就只有两种可能——
   * 盘没插 / 被改名删掉了。统一当作 denied，让界面提示"目录不可用"，
   * 而不是让扫描跑到一半抛一堆错。 */
  async function queryPermission(dir) {
    if (!dir || !dir.path) return 'denied';
    try { return (await D.exists(dir.path)) ? 'granted' : 'denied'; }
    catch (e) { return 'denied'; }
  }

  /* 扫描用的句柄：第一次取用时才读文件开头一段，构造**真正的 File**。
   *
   * 这里必须是真的 File，不能是自己捏一个带 slice/arrayBuffer 的对象：
   * exifr 内部判断的是 `input instanceof Blob`，伪对象会直接抛
   * "Invalid input argument"，被上层 try/catch 吞掉后表现为「照片都没有 EXIF」。
   * 实测截断到 64KB 仍能正确解析出 GPS 与机型（EXIF 的 APP1 段规范上限就是 64KB），
   * 所以只读开头不会丢元数据。 */
  function headProvider(absPath, name, size, lastModified) {
    let cached = null;
    return {
      name,
      size,
      lastModified,
      type: mimeOf(name),
      truncated: size > HEAD_BYTES,
      async getFile() {
        if (cached) return cached;
        const n = Math.min(size, HEAD_BYTES);
        const u8 = await D.readHead(absPath, n);
        cached = new File([u8], name, { type: mimeOf(name), lastModified });
        return cached;
      },
    };
  }

  function entryFor(dir, relPath, size, lastModified) {
    const abs = join(dir.path, relPath);
    const name = fileNameOf(relPath);
    const provider = headProvider(abs, name, size, lastModified);
    return {
      relPath,
      name,
      size,
      lastModified,
      absPath: abs,
      getFile: () => provider.getFile(),
    };
  }

  PLATFORM.register({
    kind: 'desktop',
    isDesktop: true,
    isSupported: true,

    async pickDirectory() {
      const picked = await D.pickDir();
      if (!picked || !picked.path) return null;
      return { name: picked.name, token: picked.path };
    },

    /* 桌面端顺手就把绝对路径存进目录记录了，
     * 网页版要用户手填的那一步（askDirPath）在这里不再需要。 */
    newDirRecord(picked) {
      return { name: picked.name, path: picked.token };
    },

    isSameDir(dir, picked) {
      const a = norm(dir && dir.path);
      const b = norm(picked && picked.token);
      return !!a && a === b;
    },

    queryPermission,

    async requestPermission(dir) {
      const p = await queryPermission(dir);
      return { ok: p === 'granted', broken: p !== 'granted' };
    },

    async walk(dir, onEntry) {
      if (!dir || !dir.path) throw new Error('目录记录里没有本机路径');
      const r = await D.walk(dir.path);
      if (!r || r.ok === false) throw new Error((r && r.error) || '目录无法读取');
      const list = r.entries || [];
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        await onEntry(entryFor(dir, e.rel, e.size, e.mtimeMs));
      }
    },

    /* 按相对路径取「元数据句柄」，不需要先枚举整棵树 */
    async resolveFile(dir, relPath) {
      const name = fileNameOf(relPath);
      if (!name) throw new Error('路径为空');
      const abs = join(dir.path, relPath);
      const st = await D.stat(abs);
      if (!st || !st.ok) {
        const err = new Error(`文件「${name}」不存在（可能已被删除或移动）`);
        err.stage = 'file';
        throw err;
      }
      return headProvider(abs, name, st.size, st.mtimeMs);
    },

    /* 真正要解码时读整文件，返回标准 File（createImageBitmap / exifr 都认） */
    async openFile(dir, relPath) {
      const abs = join(dir.path, relPath);
      const name = fileNameOf(relPath);
      let u8;
      try { u8 = await D.readFile(abs); } catch (e) {
        const err = new Error(`文件「${name}」读不到（可能已被删除或移动）`);
        err.stage = 'file';
        throw err;
      }
      return new File([u8], name, { type: mimeOf(name) });
    },

    /* 原图/大图直接给 covefile://，由 Chromium 流式加载，不经过 JS 堆。
     * 调用方仍可能对这个字符串调 URL.revokeObjectURL，那是无害的空操作。 */
    imageUrl(dir, relPath) {
      if (!dir || !dir.path) return null;
      return 'covefile://local/?p=' + encodeURIComponent(join(dir.path, relPath));
    },

    /* 桌面端直接起进程，不需要 gpsstamp:// 协议，也不会有「是否打开」的二次确认 */
    async launchGpsStamp(folder) {
      return D.launchGpsStamp(folder);
    },

    /* 桌面壳的数据在程序自己的目录里，不存在被浏览器回收的问题 */
    async ensurePersistentStorage() { return true; },
  });
})();
