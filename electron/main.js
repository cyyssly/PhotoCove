/* electron/main.js — PhotoCove 桌面壳（Electron）
 *
 * 职责只有四件事：
 *   1. 起一个窗口，把同一份 index.html 加载进来（app:// 协议，而不是 file://）
 *   2. 提供「选目录 / 枚举 / 读文件 / 启动 GPSStamp」的 IPC
 *   3. 用 covefile:// 协议直接流式读原图，避免把几十 MB 的照片搬进 JS 堆
 *   4. 把用户数据（IndexedDB）放在程序目录的 data\ 下，保持绿色便携
 *
 * 页面本身一行都不用为此改写：所有磁盘访问差异都在 js/platform.js 里吸收。
 */
'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, net, protocol, shell } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Readable } = require('stream');
const { spawn, execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const os = require('os');

const execFileAsync = promisify(execFile);

/* 被当成普通 Node 进程时（环境里存在 ELECTRON_RUN_AS_NODE=1），
 * require('electron') 拿到的是路径字符串而不是 API，报错会非常难懂。
 * 这里直接说清原因。 */
if (!app || typeof app.whenReady !== 'function') {
  console.error('[cove] 当前不是以 Electron 方式启动的。请确认环境变量 ELECTRON_RUN_AS_NODE 未被设置。');
  process.exit(1);
}

/* 站点根目录 = electron/ 的上一层。打包后它位于 app.asar 内，
 * 只用来读网页资源（Electron 的 fs 补丁能透明读取 asar），不能当工作目录。 */
const APP_DIR = path.resolve(__dirname, '..');

/* 程序根目录 = PhotoCove.exe 所在目录（dev 下就是项目根）。
 * data\ 和 GPSStamp\ 必须放在这里，不能放 asar 里：
 *   1. asar 是只读归档，IndexedDB 写不进去；
 *   2. 也不能把 asar 内的 .bat 路径交给 cmd.exe，它打不开归档文件。
 * 放 exe 旁边还有个好处：整个文件夹拷走，索引和缩略图跟着走（保持绿色）。 */
const EXE_DIR = app.isPackaged ? path.dirname(process.execPath) : APP_DIR;
const DATA_DIR = path.join(EXE_DIR, 'data');
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
/* 截整页长图（默认只截可视区），用来核对帮助文档这类长页面 */
const SHOT_FULL = ARGV.includes('--full');
/* 开发用：--eval <文件> 在真实页面里跑一段脚本并打印结果。
 * 用来驱动界面做端到端验证（点按钮、开面板、截图），打包后不生效。 */
const EVAL = (() => {
  const i = ARGV.indexOf('--eval');
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
  // asar 内的路径绝不能加 \\?\：Electron 靠识别路径里的 app.asar 段把它重定向到归档，
  // 加了前缀就退化成普通文件路径，读出来的都是 ENOENT。
  if (abs.includes('.asar' + path.sep) || abs.endsWith('.asar')) return abs;
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

/* ============ 6. GPSStamp ============
 * 依次在「exe 旁边 → 上一级 → 站点根」找。打包后 GPSStamp\ 由 electron-builder
 * 的 extraFiles 放到 exe 同级；dev 下就在项目根。 */
function findGpsStamp() {
  const cands = [
    path.join(EXE_DIR, 'GPSStamp', 'GPSStamp.bat'),
    path.join(path.dirname(EXE_DIR), 'GPSStamp', 'GPSStamp.bat'),
    path.join(APP_DIR, 'GPSStamp', 'GPSStamp.bat'),
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

/* ============ 6.5 exiftool：写 GPS 与地名查询 ============
 * 写入沿用 GPSStamp 已经验证过的那套调用方式，参数一个都不改：
 *   - 参数文件（-@）而不是命令行：中文路径直接当命令行参数会触发
 *     "FileName encoding must be specified"，且路径里的空格会被当成分隔符。
 *   - -charset filename=utf8：让 exiftool 按 UTF-8 解析参数文件里的路径。
 *   - -m：忽略 MakerNotes 轻微损坏（手机转发过的图常见），否则整张图放弃写入。
 *   - -GPSPosition=lat,lon：一次写全 GPSLatitude/Longitude 与两个 Ref 标签。
 *   - 每批 40 张：exiftool 是 Perl 打包的单进程，一次上千个文件会吃掉大量内存。
 */
let _exiftool = '';

/* GPSStamp 早就把「它找到的 exiftool 在哪」写进了自己的 settings.ini。
 * 同一台机器上没必要让用户再选一次，直接拿来用；文件读不到就算了。 */
function exiftoolFromGpsStamp(baseDir) {
  try {
    const ini = path.join(baseDir, 'GPSStamp', 'settings.ini');
    if (!fs.existsSync(ini)) return '';
    const txt = fs.readFileSync(ini, 'utf8').replace(/^\uFEFF/, '');
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*exiftool\s*=\s*(.+)$/i.exec(line);
      if (m) {
        const p = m[1].trim();
        if (p && fs.existsSync(p)) return p;
      }
    }
  } catch (e) { /* ignore */ }
  return '';
}

function findExifTool() {
  if (_exiftool && fs.existsSync(_exiftool)) return _exiftool;
  _exiftool = '';

  const cands = [
    path.join(EXE_DIR, 'exiftool.exe'),
    path.join(EXE_DIR, 'ExifToolGUI', 'exiftool.exe'),
    path.join(EXE_DIR, 'GPSStamp', 'exiftool.exe'),
    path.join(path.dirname(EXE_DIR), 'exiftool.exe'),
    path.join(path.dirname(EXE_DIR), 'ExifToolGUI', 'exiftool.exe'),
    path.join(String(process.env.ProgramFiles || ''), 'ExifTool', 'exiftool.exe'),
    path.join(String(process.env['ProgramFiles(x86)'] || ''), 'ExifTool', 'exiftool.exe'),
    path.join(os.homedir(), 'exiftool.exe'),
  ];
  for (const c of cands) {
    try { if (c && fs.existsSync(c)) { _exiftool = c; return c; } } catch (e) { /* ignore */ }
  }

  // 从 GPSStamp 的配置里捡现成的（它一定已经把路径找好了）
  const fromStamp = exiftoolFromGpsStamp(EXE_DIR) || exiftoolFromGpsStamp(APP_DIR);
  if (fromStamp) { _exiftool = fromStamp; return fromStamp; }

  // PATH 里找
  try {
    const r = execFileSync('where', ['exiftool.exe'], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = String(r || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) { _exiftool = first; return first; }
  } catch (e) { /* 没装 */ }
  return '';
}

/* 备份放到 data\gps-backup\ 下，镜像原路径（F:\a\b.jpg → data\gps-backup\F\a\b.jpg）。
 * 不用 exiftool 自带的 "_original" 同目录备份：那会在照片文件夹里多出
 * xxx_original.jpg，下次扫描会当成新照片索引进来，作品集里凭空多一倍重复图。 */
function gpsBackupPathOf(abs) {
  const rel = String(abs).replace(/^([a-zA-Z]):[\\/]/, '$1/').replace(/[:*?"<>|]/g, '_');
  return path.join(DATA_DIR, 'gps-backup', rel);
}

function writeArgFile(lines) {
  const p = path.join(os.tmpdir(), 'cove_gps_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.txt');
  fs.writeFileSync(p, lines.join('\r\n'), { encoding: 'utf8' });   // 不能带 BOM
  return p;
}

async function runExifTool(exe, argFile) {
  try {
    const { stdout, stderr } = await execFileAsync(
      exe, ['-charset', 'filename=utf8', '-@', argFile],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
    );
    return { status: 0, stdout: stdout || '', stderr: stderr || '' };
  } catch (e) {
    // 单个文件失败会让退出码非零，但其余文件可能都成功了——交给调用方看统计
    return {
      status: e && e.code != null ? e.code : -1,
      stdout: (e && e.stdout) || '',
      stderr: (e && e.stderr) || '',
      error: e && e.message ? e.message : String(e),
    };
  }
}

/* exiftool 在 Windows 上会输出 perl 的 locale 警告，与写入结果无关，滤掉 */
const EXIFTOOL_NOISE = [
  'perl: warning', 'locale settings', 'Falling back to the standard locale',
  'LC_ALL', 'LANG =', 'installed on your system', 'Please check that your locale',
];
function cleanExifToolLines(text) {
  return String(text || '').split(/\r?\n/)
    .map(s => s.trim())
    .filter(s => s && !EXIFTOOL_NOISE.some(n => s.includes(n)));
}

/* ============ 7. IPC ============ */
function registerIpc() {
  ipcMain.handle('cove:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    appDir: APP_DIR,
    exeDir: EXE_DIR,
    dataDir: DATA_DIR,
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

  /* ---- GPS 编辑：exiftool 探测 / 手动指定 ---- */
  ipcMain.handle('cove:exiftool', () => {
    const p = findExifTool();
    return { path: p, dir: p ? path.dirname(p) : '' };
  });

  ipcMain.handle('cove:pickExiftool', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const r = await dialog.showOpenDialog(win, {
      title: '选择 exiftool.exe',
      properties: ['openFile', 'dontAddToRecent'],
      filters: [{ name: '可执行文件', extensions: ['exe'] }, { name: '所有文件', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths.length) return { path: '' };
    const p = r.filePaths[0];
    if (path.basename(p).toLowerCase() !== 'exiftool.exe') {
      return { path: '', error: '请选择 exiftool.exe 本体' };
    }
    _exiftool = p;
    return { path: p };
  });

  /* ---- GPS 编辑：批量写入 ----
   * opts = { files: 绝对路径[], lat, lng, backup, exiftool? }
   * 返回 { ok, updated, failed, total, errors[] }；进度通过 cove:gpsProgress 推送。 */
  ipcMain.handle('cove:writeGps', async (event, opts) => {
    const o = opts || {};
    const exe = String(o.exiftool || '') || findExifTool();
    if (!exe) return { ok: false, error: '没有找到 exiftool.exe' };
    if (!fs.existsSync(exe)) return { ok: false, error: 'exiftool.exe 不存在：' + exe };

    const lat = Number(o.lat);
    const lng = Number(o.lng);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return { ok: false, error: '坐标不合法' };
    }

    const files = Array.isArray(o.files) ? o.files.filter(f => typeof f === 'string' && f) : [];
    if (!files.length) return { ok: false, error: '没有选中照片' };

    // 先筛掉不存在的，别让 exiftool 把整批都报错
    const valid = [];
    let failed = 0;
    for (const f of files) {
      try {
        if (fs.statSync(toFsPath(f)).isFile()) valid.push(f);
        else failed++;
      } catch (e) { failed++; }
    }

    const coord = lat.toFixed(6) + ',' + lng.toFixed(6);
    const backup = o.backup !== false;
    const CHUNK = 40;
    const total = valid.length;
    let updated = 0;
    const errors = [];
    let backupFailed = 0;

    for (let i = 0; i < total; i += CHUNK) {
      const chunk = valid.slice(i, i + CHUNK);

      if (backup) {
        for (const f of chunk) {
          try {
            const b = gpsBackupPathOf(f);
            if (!fs.existsSync(b)) {
              await fsp.mkdir(path.dirname(b), { recursive: true });
              await fsp.copyFile(f, b);
            }
          } catch (e) { backupFailed++; }
        }
      }

      const lines = ['-GPSPosition=' + coord, '-m', '-overwrite_original'];
      for (const f of chunk) lines.push(f);
      const argFile = writeArgFile(lines);
      let r;
      try {
        r = await runExifTool(exe, argFile);
      } finally {
        try { fs.unlinkSync(argFile); } catch (e) { /* ignore */ }
      }

      // 以 exiftool 自己的统计为准：一个坏文件就会让退出码非零，但其余的都成功了
      let u = 0, f2 = 0;
      for (const m of String(r.stdout).matchAll(/(\d+)\s+image files? updated/g)) u += Number(m[1]);
      for (const m of String(r.stdout).matchAll(/(\d+)\s+files? weren't updated/g)) f2 += Number(m[1]);
      if (!u && !f2) { if (r.status === 0) u = chunk.length; else f2 = chunk.length; }
      updated += u;
      failed += f2;

      for (const line of cleanExifToolLines(r.stderr)) {
        if (line.includes('Error:') && !line.includes('[minor]')) errors.push(line);
      }
      if (!updated && !failed && r.error) errors.push(r.error);

      try {
        event.sender.send('cove:gpsProgress', { done: Math.min(i + chunk.length, total), total });
      } catch (e) { /* 窗口已关 */ }
    }

    return { ok: true, updated, failed, total, backupFailed, errors: errors.slice(0, 8), coord };
  });

  /* ---- 地名 → 坐标 ----
   * 用 OpenStreetMap 的 Nominatim：免 Key，返回 WGS-84，
   * 与照片 EXIF 和底图同一坐标系，不需要 GCJ-02/BD-09 那套纠偏。
   * 使用条款要求带可识别的 User-Agent，且不要高频请求（这里由用户手动触发）。 */
  ipcMain.handle('cove:geocode', async (_e, q) => {
    const query = String(q || '').trim();
    if (!query) return { ok: false, error: '请输入地名' };
    if (query.length > 120) return { ok: false, error: '地名太长了' };
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&addressdetails=1'
      + '&accept-language=zh-CN,zh&q=' + encodeURIComponent(query);
    try {
      const r = await net.fetch(url, {
        headers: { 'User-Agent': 'PhotoCove/18.0 (local photo library; desktop)', 'Accept': 'application/json' },
      });
      if (!r.ok) return { ok: false, error: '地名服务返回 ' + r.status };
      const arr = await r.json();
      const results = (Array.isArray(arr) ? arr : []).slice(0, 8).map(it => {
        const lat = Number(it.lat);
        const lng = Number(it.lon);
        const dn = String(it.display_name || '');
        const first = String(it.name || dn.split(',')[0] || '').trim();
        return { lat, lng, label: first, detail: dn.split(',').slice(1).join(',').trim() };
      }).filter(x => isFinite(x.lat) && isFinite(x.lng));
      return { ok: true, results };
    } catch (e) {
      return { ok: false, error: '联网失败：' + (e && e.message ? e.message : String(e)) };
    }
  });

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

  mainWin.once('ready-to-show', () => {
    if (!SELFTEST && !SHOT) mainWin.show();
    // 截图模式也必须真的显示出来：show:false 的窗口不产生新合成帧，
    // capturePage 只会返回旧画面（改动过的 DOM 反映不出来），
    // 而 Page.captureScreenshot 会一直等不到帧、把进程挂住。
    else if (SHOT) mainWin.showInactive();
  });
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
async function runSelftest() {  const script = fs.readFileSync(path.join(__dirname, 'selftest.renderer.js'), 'utf8');
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

/* ============ 10.5 开发用 --eval ============
 * electron . --eval tests/xxx.js
 * 文件内容被包进一个 async 函数在页面里执行，可以 await、可以 return 结果。
 * 只在未打包时可用：打包后的程序不接受这个参数。 */
async function runEval(file) {
  let result;
  try {
    const script = fs.readFileSync(file, 'utf8');
    result = await mainWin.webContents.executeJavaScript(
      '(async () => {' + script + '\n})()', true
    );
  } catch (e) {
    result = { ok: false, error: 'executeJavaScript 失败：' + (e && e.message ? e.message : e) };
  }
  console.log('EVAL_RESULT ' + JSON.stringify(result, null, 2));
  if (SHOT) await shootPage(SHOT);
  setTimeout(() => app.exit(result && result.ok ? 0 : 1), 150);
}

/* 截图。优先走 DevTools 协议的 Page.captureScreenshot：
 * capturePage() 返回的是「最后一次合成帧」，窗口在后台（或刚滚动过、刚改过 DOM）
 * 时拿到的还是改动前的画面——实测滚动到底和 display:none 都反映不出来，
 * 很容易对着旧图误判。走 debugger 会按当前 DOM 重新渲染。
 * --full 时连可视区外的部分一起截，便于核对长页面。 */
async function shootPage(file, fullPage) {
  const wc = mainWin.webContents;
  let attachedHere = false;
  try {
    if (!wc.debugger.isAttached()) { wc.debugger.attach('1.3'); attachedHere = true; }
    const params = { format: 'png', fromSurface: true };
    if (fullPage === undefined ? SHOT_FULL : fullPage) params.captureBeyondViewport = true;
    // 窗口没有新帧时这条命令不会返回，必须自带超时，否则整个进程挂死
    const data = await Promise.race([
      wc.debugger.sendCommand('Page.captureScreenshot', params).then(r => r && r.data),
      new Promise((_, rej) => setTimeout(() => rej(new Error('captureScreenshot 超时')), 5000).unref()),
    ]);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    if (attachedHere) wc.debugger.detach();
    console.log('SHOT_OK ' + file);
    return true;
  } catch (e) {
    console.log('SHOT_DEBUGGER_FAIL ' + (e && e.message));
    try {
      const img = await wc.capturePage();
      fs.writeFileSync(file, img.toPNG());
      console.log('SHOT_OK ' + file + ' (capturePage 回退)');
      return true;
    } catch (e2) {
      console.log('SHOT_FAIL ' + (e2 && e2.message));
      return false;
    }
  }
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

    if (EVAL && !app.isPackaged) {
      mainWin.webContents.on('console-message', (_e, level, msg) => {
        console.log('[renderer:' + level + '] ' + msg);
      });
      mainWin.webContents.once('did-finish-load', () => { runEval(EVAL); });
      setTimeout(() => { console.log('EVAL_TIMEOUT'); app.exit(5); }, 120000).unref();
    }

    if (SHOT && !EVAL) {
      // 截图模式：用来核对桌面壳里的真实排版
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
          await shootPage(SHOT);
        } catch (e) { console.log('SHOT_FAIL ' + (e && e.message)); }
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
