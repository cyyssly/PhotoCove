/* platform/api.js — 文件访问适配层的契约
 *
 * 目的：业务代码（scanner / app / views）不再直接调用 File System Access API，
 * 也不直接持有目录句柄。所有「选目录、枚举、读文件、问权限」都从这里过一手。
 *
 * 为什么要这一层：
 *   浏览器只给目录句柄，不给绝对路径，权限还跟着浏览器进程走；
 *   本地桌面壳（Electron / Tauri）能直接拿到绝对路径、直接读盘、无需授权。
 *   两者的差异集中在这里，换成桌面壳时只替换实现，其余代码一行不用改。
 *
 * 实现方在加载时调用 PLATFORM.register(impl)，先注册者生效：
 *   js/platform/web.js     浏览器实现（当前默认）
 *   js/platform/desktop.js 桌面壳实现（预加载脚本注入后先注册）
 *
 * impl 需要提供：
 *   kind                  'web' | 'desktop'
 *   isDesktop             boolean
 *   isSupported           boolean，是否具备选目录 + 读文件的能力
 *   pickDirectory()       => { name, token } | null     用户取消时返回 null
 *   newDirRecord(picked)  => 可直接写进 DB 的目录记录
 *   isSameDir(dir, picked)=> boolean                    用于添加时去重
 *   queryPermission(dir)  => 'granted' | 'prompt' | 'denied'
 *   requestPermission(dir)=> { ok, broken }             必须在用户手势内同步发起
 *   walk(dir, onEntry)    => Promise<void>              onEntry({ relPath, name, size, lastModified, getFile })
 *   resolveFile(dir, rel) => { name, size, getFile }    找不到时抛错，带 stage 字段
 *   openFile(dir, rel)    => File                       完整内容，供解码使用
 *   imageUrl(dir, rel)    => string | null   可选。能直接给 URL 的实现（桌面端）返回它，
 *                                            可省掉把整张大图读进 JS 堆这一步
 *   launchGpsStamp(folder)=> Promise<void>
 *   ensurePersistentStorage() => boolean | null          存储保护是否开启
 *
 * 关于 walk 的 size / lastModified：增量比对靠它，**必须**是文件的真实大小与修改时间，
 * 不能是"读到的字节数"——桌面端扫描只读文件开头一小段，两者并不相等。
 */
'use strict';

const PLATFORM = (() => {
  let _impl = null;

  function register(impl) {
    if (!impl || !impl.kind) throw new Error('PLATFORM.register: 实现缺少 kind');
    if (_impl) {
      // 桌面壳会先注册，网页版后加载时不应该把它顶掉
      if (_impl.kind !== impl.kind) console.debug('[platform] 已有实现「' + _impl.kind + '」，忽略「' + impl.kind + '」');
      return;
    }
    _impl = impl;
  }

  function impl() {
    if (!_impl) throw new Error('PLATFORM 尚未注册实现，检查 index.html 里 js/platform/*.js 的加载顺序');
    return _impl;
  }

  return {
    register,
    get kind() { return _impl ? _impl.kind : 'unknown'; },
    get isDesktop() { return !!(_impl && _impl.isDesktop); },
    get isSupported() { return !!(_impl && _impl.isSupported); },

    pickDirectory() { return impl().pickDirectory(); },
    newDirRecord(picked) { return impl().newDirRecord(picked); },
    isSameDir(dir, picked) { return impl().isSameDir(dir, picked); },
    queryPermission(dir) { return impl().queryPermission(dir); },
    requestPermission(dir) { return impl().requestPermission(dir); },
    walk(dir, onEntry) { return impl().walk(dir, onEntry); },
    resolveFile(dir, relPath) { return impl().resolveFile(dir, relPath); },
    openFile(dir, relPath) { return impl().openFile(dir, relPath); },
    imageUrl(dir, relPath) {
      const f = _impl && _impl.imageUrl;
      return f ? f(dir, relPath) : null;   // 可选能力：没有则走 openFile + Blob URL
    },
    launchGpsStamp(folder) { return impl().launchGpsStamp(folder); },
    ensurePersistentStorage() { return impl().ensurePersistentStorage(); },
  };
})();
