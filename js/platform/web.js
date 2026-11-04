/* platform/web.js — 浏览器实现（File System Access API + IndexedDB）
 *
 * 这段代码原本散在 scanner.js 和 app.js 里，现在集中到这里，
 * 逻辑逐行保持不变——包括那些踩过坑的地方（权限会被浏览器收回、句柄要逐级下钻）。
 */
'use strict';

(() => {
  /* 目录记录里的句柄字段；桌面端会换成本机路径，所以业务代码不要直接读它 */
  function handleOf(dir) { return dir ? dir.handle : null; }

  /* 权限查询。句柄失效（换浏览器版本 / 清理过站点数据）时不能抛出去，一律当作未授权。
   * 绝对「单段名字」限制：getFileHandle 不接受 "2024/春季/a.jpg" 这种整串路径。 */
  async function queryPermission(dir) {
    const h = handleOf(dir);
    if (!h || typeof h.queryPermission !== 'function') return 'denied';
    try { return (await h.queryPermission({ mode: 'read' })) || 'denied'; }
    catch (e) { return 'denied'; }
  }

  /* 按相对路径取文件句柄：逐级 getDirectoryHandle 下钻，最后再取文件。
   * 早期版本把整串路径塞进 getFileHandle，子目录里的照片全部读不出来，
   * 表现为「照片大量空白」、诊断显示「文件路径不存在」。 */
  async function resolveFile(dir, relPath) {
    const root = handleOf(dir);
    if (!root) throw new Error('目录句柄已失效（请移除后重新添加该目录）');
    const parts = String(relPath || '').split(/[\\/]+/).filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) throw new Error('路径为空');
    let cur = root;
    for (const seg of parts) {
      try {
        cur = await cur.getDirectoryHandle(seg);
      } catch (e) {
        const err = new Error(`子目录「${seg}」不存在（可能已改名或移动，重新扫描该目录即可修正）`);
        err.stage = 'dir';
        throw err;
      }
    }
    try {
      return await cur.getFileHandle(fileName);
    } catch (e) {
      const err = new Error(`文件「${fileName}」不存在（可能已被删除或移动）`);
      err.stage = 'file';
      throw err;
    }
  }

  /* 递归枚举。relPath 用 / 分隔，与库里的记录保持一致。
   * 这里先取一次 File：File 对象本身是懒的，不会真的读内容，
   * 但能顺手把 size / lastModified 交给增量比对，避免后面重复取。 */
  async function collect(dirHandle, prefix, onEntry) {
    for await (const entry of dirHandle.values()) {
      if (entry.kind === 'file') {
        let f;
        try { f = await entry.getFile(); } catch (e) { continue; }
        await onEntry({
          relPath: prefix + entry.name,
          name: entry.name,
          size: f.size,
          lastModified: f.lastModified,
          getFile: () => entry.getFile(),
        });
      } else if (entry.kind === 'directory') {
        await collect(entry, prefix + entry.name + '/', onEntry);
      }
    }
  }

  PLATFORM.register({
    kind: 'web',
    isDesktop: false,
    isSupported: !!(typeof window !== 'undefined' && window.showDirectoryPicker),

    async pickDirectory() {
      try {
        const handle = await window.showDirectoryPicker({ mode: 'read' });
        if (!handle) return null;
        return { name: handle.name, token: handle };
      } catch (e) {
        if (e && e.name === 'AbortError') return null;   // 用户取消
        throw e;
      }
    },

    newDirRecord(picked) {
      return { name: picked.name, handle: picked.token };
    },

    isSameDir(dir, picked) {
      const h = handleOf(dir);
      if (!h) return false;
      return h.name === picked.name && h.kind === 'directory';
    },

    queryPermission,

    /* 必须在用户手势内第一句就调 requestPermission，中间不能 await 别的东西，
     * 否则浏览器会认为不是用户主动操作而直接拒绝。
     * broken 表示句柄本身已失效（改名 / 移动 / 清过站点数据），点多少次都不会弹框。 */
    async requestPermission(dir) {
      const h = handleOf(dir);
      if (!h || typeof h.requestPermission !== 'function') return { ok: false, broken: true };
      try {
        const p = await h.requestPermission({ mode: 'read' });
        return { ok: p === 'granted', broken: false };
      } catch (e) {
        return { ok: false, broken: true };
      }
    },

    async walk(dir, onEntry) {
      const root = handleOf(dir);
      if (!root) throw new Error('目录句柄已失效');
      await collect(root, '', onEntry);
    },

    resolveFile,

    async openFile(dir, relPath) {
      const fh = await resolveFile(dir, relPath);
      return fh.getFile();
    },

    /* 网页只能靠自定义协议唤起本机程序，还需要用户先运行一次「注册联动.bat」 */
    async launchGpsStamp(folder) {
      const uri = 'gpsstamp://open/?dir=' + encodeURIComponent(folder);
      const a = document.createElement('a');
      a.href = uri;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
    },

    /* 请求持久化存储：否则浏览器在磁盘紧张时可能直接回收缩略图库，
     * 表现就是「某天打开突然全空白」。批不批准由浏览器决定。 */
    async ensurePersistentStorage() {
      try {
        if (!navigator.storage) return null;
        let ok = false;
        if (navigator.storage.persisted) ok = !!(await navigator.storage.persisted());
        if (!ok && navigator.storage.persist) {
          await navigator.storage.persist();
          if (navigator.storage.persisted) ok = !!(await navigator.storage.persisted());
        }
        return ok;
      } catch (e) {
        return false;
      }
    },
  });
})();
