/* js/platform.js — 磁盘访问层（Electron 桌面壳）
 *
 * 业务代码（scanner / app / views / map-view）不直接碰 fs，也不碰 IPC，
 * 只经过这里这几个方法：选目录、枚举、读文件、问"这个目录还能读吗"。
 *
 * 为什么单独一层：Electron 的分层边界（主进程 fs ↔ preload 白名单 ↔ 页面）
 * 需要有人收口，否则每个调用点都要自己拼绝对路径、自己做 IPC 错误映射。
 * 这一层就是那个收口处，preload 暴露的能力（window.__COVE_DESKTOP）
 * 在 electron/preload.js 里是白名单式的，页面拿不到 require。
 *
 * 两处刻意的取舍，都不是随手写的：
 *
 * 1) 扫描阶段只读文件开头 96KB（scanMeta），不整文件读，而且在主进程就地解析，
 *    页面只拿到尺寸/EXIF 这几百字节。两万张照片从「搬 10GB 字节过 IPC」降到
 *    「搬两万个几百字节的对象」，这是扫描提速的主要来源。整文件读更不可行：
 *    同样两万张要搬上百 GB。
 * 2) 真正要解码显示时才读整文件（openFile），而原图大图直接用 covefile://
 *    交给 Chromium 自己流式加载（imageUrl），不进 JS 堆。
 *
 * 关于 walk 的 size / lastModified：增量比对靠它，**必须**是文件的真实大小与修改时间，
 * 不能是"读到的字节数"——扫描只读文件开头一小段，两者并不相等。
 */
'use strict';

const PLATFORM = (() => {
  const D = typeof window !== 'undefined' ? window.__COVE_DESKTOP : null;

  /* 不在桌面壳里（例如有人直接双击 index.html）：返回一组明确报错的空实现。
   * 页面由 index.html 里的 gate 挡住，正常不会走到这里；留着是为了出错时有话说，
   * 而不是抛一个 "Cannot read property of null"。 */
  if (!D) {
    const fail = () => { throw new Error('PhotoCove 需要在桌面窗口里运行'); };
    return new Proxy({}, { get: () => fail });
  }

  /* 扫描只读文件开头 96KB（scanMeta），不整文件读。
   * 为什么是 96KB 而不是更小：JPEG 的 APP1(EXIF) 段上限 65535 字节，加长度域结束于
   * 65538，取 64KB 正好切掉最后两字节，满段 EXIF 就解不出来。96KB 留了余量，
   * 主进程那边还有一次 512KB 的补读兜底（尺寸排在 ICC 之后的情况）。 */
  const HEAD_BYTES = 96 * 1024;

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

  /* 目录可读性：这里没有"授权"这回事，读不到只有两种可能——盘没插 / 被改名删掉了。
   * 统一当作 denied，让界面提示"目录不可用"，而不是让扫描跑到一半抛一堆错。 */
  async function queryPermission(dir) {
    if (!dir || !dir.path) return 'denied';
    try { return (await D.exists(dir.path)) ? 'granted' : 'denied'; }
    catch (e) { return 'denied'; }
  }

  /* 扫描用的句柄。probe() 让主进程读头并就地解析，只回传尺寸/EXIF 这样一个小对象；
   * getFile() 是备用路径（拿真正的 File），现在扫描不用它了——扫码阶段没必要把
   * 上 GB 的字节搬进渲染进程，只为读几个字段。
   *
   * 保留 getFile 的原因：exifr 只认 `input instanceof Blob`，将来若要把解析搬回页面，
   * 这条路径仍然可用；伪对象会直接抛 "Invalid input argument"。 */
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
      /* 元数据探测：{ ok, w, h, make, model, lens, focal, fnum, exposure, iso, date, gps } */
      probe: () => D.scanMeta(abs, HEAD_BYTES),
    };
  }

  return {
    /* 选目录：系统对话框，顺便就拿到绝对路径，直接进目录记录 */
    async pickDirectory() {
      const picked = await D.pickDir();
      if (!picked || !picked.path) return null;
      return { name: picked.name, token: picked.path };
    },

    newDirRecord(picked) {
      return { name: picked.name, path: picked.token };
    },

    isSameDir(dir, picked) {
      const a = norm(dir && dir.path);
      const b = norm(picked && picked.token);
      return !!a && a === b;
    },

    queryPermission,

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

    /* 在资源管理器里显示：文件会选中它本身，目录直接打开 */
    async reveal(absPath) {
      if (!absPath) return { ok: false, error: '没有路径' };
      return D.reveal(absPath);
    },

    /* 把库内相对路径拼成本机绝对路径（写 EXIF、定位文件都要用） */
    joinPath(root, rel) {
      return join(root, rel);
    },

    /* exiftool 探测：返回 { path }，找不到时 path 为 '' */
    async exiftool() {
      try {
        const r = await D.exiftool();
        return (r && r.path) || '';
      } catch (e) { return ''; }
    },

    async pickExiftool() {
      return D.pickExiftool();
    },

    /* 批量写 GPS：files 为绝对路径数组 */
    async writeGps(opts) {
      return D.writeGps(opts);
    },

    /* 监听写入进度，返回取消监听的函数 */
    onGpsProgress(cb) {
      return D.onGpsProgress(cb);
    },

    /* 地名查坐标（主进程代理，避免页面受 CORS 与 UA 限制） */
    async geocode(q) {
      try {
        return await D.geocode(q);
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e), results: [] };
      }
    },
  };
})();
