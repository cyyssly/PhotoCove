/* electron/main.js — PhotoCove 桌面壳（Electron）
 *
 * 职责只有四件事：
 *   1. 起一个窗口，把同一份 index.html 加载进来（app:// 协议，而不是 file://）
 *   2. 提供「选目录 / 枚举 / 读文件 / 启动 GPSStamp」的 IPC
 *   3. 用 covefile:// 协议直接流式读原图，避免把几十 MB 的照片搬进 JS 堆
 *   4. 把用户数据（IndexedDB）放在程序目录的 data\ 下，保持绿色便携
 *
 * 页面本身一行都不用为此改写：所有平台差异都在 js/platform/desktop.js 里吸收。
 */
'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, protocol, shell } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Readable } = require('stream');
const { spawn } = require('child_process');

/* 被当成普通 Node 进程时（环境里存在 ELECTRON_RUN_AS_NODE=1），
 * require('electron') 拿到的是路径字符串而不是 API，报错会非常难懂。
 * 这里直接说清原因。 */
if (!app || typeof app.whenReady !== 'function') {
  console.error('[cove] 当前不是以 Electron 方式启动的。请确认环境变量 ELECTRON_RUN_AS_NODE 未被设置。');
  process.exit(1);
}

/* 站点根目录 = electron/ 的上一层 */
const APP_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(APP_DIR, 'data');
const IS_WIN = process.platform === 'win32';

/* dev 下 argv = [electron.exe, '.', ...自定义参数]；打包后 argv = [PhotoCove.exe, ...自定义参数] */
const ARGV = process.argv.slice(app.isPackaged ? 1 : 2);
const SELFTEST = ARGV.includes('--selftest');
const SHOT = (() => {
  const i = ARGV.indexOf('--shot');
  return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : '';
})();
const SELFTEST_DIR = (() => {
  const i = ARGV.indexOf('--dir');
  return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : '';
})();
const SHOT_VIEW = (() => {
  const i = ARGV.indexOf('--view');
  return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : '';
})();

/* ============ 1. 自定义协议（必须在 ready 之前声明） ============
 * app://      承载网页本身。不用 file:// 的原因：
 *             没有稳定 origin，IndexedDB / 相对路径 / 各类 web API 都会被限制。
 * covefile:// 承载磁盘上的原图，按路径流式返回。 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
  {
    scheme: 'covefile',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

/* ============ 2. 长路径 ============
 * Windows 的 MAX_PATH 是 260，Node 的 fs 也一样。超过就必须加 \\?\ 前缀，
 * 它同时还关闭了路径规范化（. / .. / 正斜杠），所以只能用在已解析的绝对路径上。 */
function toFsPath(p) {
  if (!IS_WIN || typeof p !== 'string' || !p) return p;
  const abs = path.resolve(p);
  if (abs.length < 248) return abs;
  if (/^\\\\\?\\/.test(abs)) return abs;
  if (/^\\\\/.test(abs)) return '\\\\?\\UNC\\' + abs.slice(2);
  return '\\\\?\\' + abs;
}

/* ============ 3. MIME ============ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};
function mimeOf(p) { return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream'; }

/* ============ 4. 文件响应（流式，不整块读进内存） ============ */
async function serveFile(absPath) {
  let target = absPath;
  let st;
  try {
    st = await fsp.stat(toFsPath(target));
    if (st.isDirectory()) {
      target = path.join(target, 'index.html');
      st = await fsp.stat(toFsPath(target));
    }
  } catch (e) {
    return new Response('Not Found: ' + path.basename(target), {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  const headers = {
    'content-type': mimeOf(target),
    'content-length': String(st.size),
    // 页面和脚本不强缓存：改了文件刷新就能看到，省掉一堆"为什么没生效"
    'cache-control': 'no-cache',
  };
  if (!st.size) return new Response('', { status: 200, headers });
  const stream = Readable.toWeb(fs.createReadStream(toFsPath(target)));
  return new Response(stream, { status: 200, headers });
}

function registerProtocols() {
  /* app://cove/<相对路径> */
  protocol.handle('app', async (req) => {
    let pathname = '/';
    try { pathname = new URL(req.url).pathname; } catch (e) { /* 保持默认 */ }
    let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    if (!rel) rel = 'index.html';
    const abs = path.resolve(APP_DIR, rel);
    // 不允许跳出站点根目录
    if (abs !== APP_DIR && !abs.startsWith(APP_DIR + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    return serveFile(abs);
  });

  /* covefile://local/?p=<encodeURIComponent(绝对路径)>
   * 用查询参数而不是路径段：文件名里的 #  ?  %  都不会把 URL 拆坏。 */
  protocol.handle('covefile', async (req) => {
    let raw = '';
    try { raw = new URL(req.url).searchParams.get('p') || ''; } catch (e) { /* ignore */ }
    if (!raw) return new Response('Missing ?p=', { status: 400 });
    return serveFile(raw);
  });
}

/* ============ 5. 目录枚举 ============
 * 一次性在主线程序递归完，返回扁平列表，而不是让渲染层一层层发 IPC：
 * 一个两万张照片的库有上千个子目录，逐个往返会慢到不可用。 */
async function walkDir(root) {
  const out = [];
  const stack = [{ dir: root, prefix: '' }];
  while (stack.length) {
    const { dir, prefix } = stack.pop();
    let ents;
    try {
      ents = await fsp.readdir(toFsPath(dir), { withFileTypes: true });
    } catch (e) {
      continue;   // 无权限 / 被占用 / 已被删除：跳过这一层，不影响其余
    }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push({ dir: full, prefix: prefix + ent.name + '/' });
      } else if (ent.isFile()) {
        let st;
        try { st = await fsp.stat(toFsPath(full)); } catch (e) { continue; }
        out.push({
          rel: prefix + ent.name,
          name: ent.name,
          size: st.size,
          mtimeMs: Math.round(st.mtimeMs),
        });
      }
      // 符号链接不跟进：避免目录成环，也避免把网盘挂载点整个扫一遍
    }
  }
  return out;
}

/* ============ 6. GPSStamp ============ */
function findGpsStamp() {
  const cands = [
    path.join(APP_DIR, 'GPSStamp', 'GPSStamp.bat'),
    path.join(path.dirname(APP_DIR), 'GPSStamp', 'GPSStamp.bat'),
  ];
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* ignore */ }
  }
  return '';
}

function launchGpsStamp(folder, missingOnly) {
  const bat = findGpsStamp();
  if (!bat) return { ok: false, error: '没有找到 GPSStamp\\GPSStamp.bat' };
  if (folder) {
    try {
      if (!fs.statSync(toFsPath(folder)).isDirectory()) {
        return { ok: false, error: '不是一个文件夹：' + folder };
      }
    } catch (e) {
      return { ok: false, error: '文件夹不存在：' + folder };
    }
  }
  // --missing-only：只载入没有 GPS 的照片。少了这个参数就会全量载入，
  // 一按写入就把这些照片原本的坐标全部覆盖成同一个点。
  const args = ['/c', 'start', '', bat];
  if (folder) args.push('--missing-only', folder);
  try {
    spawn('cmd.exe', args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return { ok: true, bat };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/* ============ 7. IPC ============ */
function registerIpc() {
  ipcMain.handle('cove:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    appDir: APP_DIR,
    userData: app.getPath('userData'),
    packaged: app.isPackaged,
    gpsstamp: findGpsStamp(),
  }));

  ipcMain.handle('cove:pickDir', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const r = await dialog.showOpenDialog(win, {
      title: '选择图片库目录',
      properties: ['openDirectory', 'dontAddToRecent'],
      buttonLabel: '加入图片库',
    });
    if (r.canceled || !r.filePaths.length) return null;
    const p = r.filePaths[0];
    return { name: path.basename(p) || p, path: p };
  });

  ipcMain.handle('cove:exists', async (_e, p) => {
    try { return (await fsp.stat(toFsPath(p))).isDirectory(); } catch (e) { return false; }
  });

  ipcMain.handle('cove:walk', async (_e, root) => {
    try {
      return { ok: true, entries: await walkDir(root) };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });

  ipcMain.handle('cove:stat', async (_e, p) => {
    try {
      const st = await fsp.stat(toFsPath(p));
      return { ok: true, size: st.size, mtimeMs: Math.round(st.mtimeMs), dir: st.isDirectory() };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });

  /* 只读文件开头若干字节：扫描阶段解析尺寸和 EXIF 用，不必整文件读 */
  ipcMain.handle('cove:readHead', async (_e, p, bytes) => {
    const n = Math.max(4096, Math.min(Number(bytes) || 512 * 1024, 16 * 1024 * 1024));
    let fh;
    try {
      fh = await fsp.open(toFsPath(p), 'r');
      const buf = Buffer.allocUnsafe(n);
      const { bytesRead } = await fh.read(buf, 0, n, 0);
      return new Uint8Array(buf.subarray(0, bytesRead));
    } catch (e) {
      throw new Error('读取失败：' + (e && e.message ? e.message : e));
    } finally {
      if (fh) { try { await fh.close(); } catch (e) { /* ignore */ } }
    }
  });

  /* 整文件读取：只在真正要解码显示时才用 */
  ipcMain.handle('cove:file', async (_e, p) => {
    try {
      const buf = await fsp.readFile(toFsPath(p));
      return new Uint8Array(buf);
    } catch (e) {
      throw new Error('读取失败：' + (e && e.message ? e.message : e));
    }
  });

  ipcMain.handle('cove:gpsstamp', async (_e, folder, missingOnly) => launchGpsStamp(folder, missingOnly !== false));

  ipcMain.handle('cove:reveal', async (_e, p) => {
    try {
      if (!fs.existsSync(toFsPath(p))) return { ok: false, error: '路径不存在' };
      const st = await fsp.stat(toFsPath(p));
      if (st.isDirectory()) await shell.openPath(p);
      else shell.showItemInFolder(p);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });
}

/* ============ 8. 用户数据目录 ============
 * 保持绿色：IndexedDB（索引 + 缩略图）落在程序目录的 data\ 里，
 * 整个文件夹拷走就带着走。放不下（只读位置）才退回系统的 AppData。 */
function setupUserData() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const probe = path.join(DATA_DIR, '.writable');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    app.setPath('userData', DATA_DIR);
    return true;
  } catch (e) {
    console.warn('[cove] 程序目录不可写，改用系统 AppData：', e && e.message);
    return false;
  }
}

/* ============ 9. 窗口 ============ */
let mainWin = null;

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#14171a' : '#f4f1ec',
    autoHideMenuBar: true,
    title: 'PhotoCove',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,          // preload 里要用到 require('electron')
      spellcheck: false,
      backgroundThrottling: false,   // 后台也要能继续生成缩略图
    },
  });

  mainWin.once('ready-to-show', () => { if (!SELFTEST && !SHOT) mainWin.show(); });
  mainWin.on('closed', () => { mainWin = null; });

  // 不给页面开新窗口的机会；外链一律交给系统浏览器
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWin.loadURL('app://cove/index.html');
}

function buildMenu() {
  const template = [
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '数据存放在哪里',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: '数据位置',
              message: '索引与缩略图',
              detail: app.getPath('userData') + '\n\n照片原图不在这里，始终留在你自己指定的目录中。',
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ============ 10. 自测 ============
 * electron . --selftest --dir "F:\01照片\某目录"
 * 隐藏窗口跑完整链路：注册适配层 → 建目录记录 → 扫描 → 生成缩略图 → 取原图，
 * 结果打到 stdout 并以退出码表示成败。 */
async function runSelftest() {
  const script = fs.readFileSync(path.join(__dirname, 'selftest.renderer.js'), 'utf8');
  let result;
  try {
    result = await mainWin.webContents.executeJavaScript(
      '(' + script + ')(' + JSON.stringify(SELFTEST_DIR) + ')',
      true
    );
  } catch (e) {
    result = { ok: false, error: 'executeJavaScript 失败：' + (e && e.message ? e.message : e) };
  }
  console.log('SELFTEST_RESULT ' + JSON.stringify(result, null, 2));
  const failed = !result || !result.ok;
  if (result && result.failed && result.failed.length) {
    console.log('SELFTEST_FAILED ' + JSON.stringify(result.failed));
  }
  setTimeout(() => app.exit(failed ? 1 : 0), 200);
}

/* ============ 11. 生命周期 ============ */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });

  setupUserData();
  app.whenReady().then(() => {
    registerProtocols();
    registerIpc();
    if (!SELFTEST) buildMenu();
    createWindow();

    if (SELFTEST) {
      mainWin.webContents.once('did-finish-load', () => { runSelftest(); });
      mainWin.webContents.once('did-fail-load', (_e, code, desc) => {
        console.log('SELFTEST_RESULT ' + JSON.stringify({ ok: false, error: 'did-fail-load ' + code + ' ' + desc }));
        app.exit(3);
      });
      // 卡住不返回时别永久挂起
      setTimeout(() => { console.log('SELFTEST_TIMEOUT'); app.exit(4); }, 120000).unref();
    }

    if (SHOT) {
      // 截图模式：用来核对桌面壳里的真实排版（网页版截图看不出壳的问题）
      // 带 --dir 时先真扫一个目录，截出来的才是"有照片"的样子
      mainWin.webContents.on('console-message', (_e, level, msg) => {
        console.log('[renderer:' + level + '] ' + msg);
      });
      mainWin.webContents.once('did-finish-load', async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        await wait(800);
        if (SELFTEST_DIR) {
          try {
            const r = await mainWin.webContents.executeJavaScript(`(async () => {
              const dir = ${JSON.stringify(SELFTEST_DIR)};
              const id = await DB.addDir({ name: '__shot__', path: dir, addedAt: Date.now() });
              const rep = await SCAN.scanAll({ dirId: id });
              await VIEWS.reload();
              return { added: rep.added, error: rep.error ? String(rep.error) : null };
            })()`, true);
            console.log('SHOT_SCAN ' + JSON.stringify(r));
            await wait(4500);   // 让缩略图先出一批（每张都要解码 + 编码，串行度 3）
            if (SHOT_VIEW) {
              await mainWin.webContents.executeJavaScript(
                `(document.querySelector('.nav-btn[data-view="${SHOT_VIEW}"]') || {}).click?.()`, true);
              await wait(2500);
            }
          } catch (e) {
            console.log('SHOT_SCAN_FAIL ' + (e && e.message));
          }
        }
        try {
          const img = await mainWin.webContents.capturePage();
          fs.writeFileSync(SHOT, img.toPNG());
          console.log('SHOT_OK ' + SHOT);
        } catch (e) {
          console.log('SHOT_FAIL ' + (e && e.message));
        }
        if (SELFTEST_DIR) {
          // 截图用的临时目录记录留在库里会碍事，清掉
          try {
            await mainWin.webContents.executeJavaScript(`(async () => {
              const ds = await DB.listDirs();
              for (const d of ds) {
                if (d.name !== '__shot__') continue;
                const ps = (await DB.allPhotos()).filter(p => p.dirId === d.id);
                for (const p of ps) { try { await DB.deleteAssets(p.id); } catch (e) {} try { await DB.deletePhoto(p.id); } catch (e) {} }
                await DB.removeDir(d.id);
              }
            })()`, true);
          } catch (e) { /* ignore */ }
        }
        app.exit(0);
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
