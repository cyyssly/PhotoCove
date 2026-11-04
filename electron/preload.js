/* electron/preload.js — 渲染进程与主进程之间唯一的一道门
 *
 * 只暴露下面这些白名单方法，页面拿不到 require、拿不到 ipcRenderer、
 * 也没有任意文件访问能力（只能读页面自己传进来的路径）。
 * 页面侧由 js/platform.js 包装成磁盘访问层。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__COVE_DESKTOP', {
  bridge: 1,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  info: () => ipcRenderer.invoke('cove:info'),
  pickDir: () => ipcRenderer.invoke('cove:pickDir'),
  exists: (p) => ipcRenderer.invoke('cove:exists', p),
  walk: (root) => ipcRenderer.invoke('cove:walk', root),
  stat: (p) => ipcRenderer.invoke('cove:stat', p),
  readHead: (p, bytes) => ipcRenderer.invoke('cove:readHead', p, bytes),
  readFile: (p) => ipcRenderer.invoke('cove:file', p),
  launchGpsStamp: (folder) => ipcRenderer.invoke('cove:gpsstamp', folder, true),
  reveal: (p) => ipcRenderer.invoke('cove:reveal', p),

  /* GPS 编辑：写 EXIF 由主进程调 exiftool，页面碰不到 fs */
  exiftool: () => ipcRenderer.invoke('cove:exiftool'),
  pickExiftool: () => ipcRenderer.invoke('cove:pickExiftool'),
  writeGps: (opts) => ipcRenderer.invoke('cove:writeGps', opts),
  geocode: (q) => ipcRenderer.invoke('cove:geocode', q),
  onGpsProgress: (cb) => {
    const fn = (_e, d) => { try { cb(d); } catch (err) { /* ignore */ } };
    ipcRenderer.on('cove:gpsProgress', fn);
    return () => ipcRenderer.removeListener('cove:gpsProgress', fn);
  },
});
