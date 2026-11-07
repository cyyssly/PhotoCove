/* electron/main.js — PhotoCove 桌面壳（Electron）
 *
 * 职责只有四件事：
 *   1. 起一个窗口，把同一份 index.html 加载进来（app:// 协议，而不是 file://）
 *   2. 提供「选目录 / 枚举 / 读文件」的 IPC
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
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const os = require('os');

const execFileAsync = promisify(execFile);
const SCAN_META = require('./scan-meta');

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
 * data\ 与 backup\ 都放在这里，不能放 asar 里（asar 是只读归档，写不进去）。
 * 放 exe 旁边还有个好处：整个文件夹拷走，索引、缩略图和备份跟着走（保持绿色）。 */
const EXE_DIR = app.isPackaged ? path.dirname(process.execPath) : APP_DIR;
const DATA_DIR = path.join(EXE_DIR, 'data');
/* 原图备份单独放程序根目录的 backup\，一眼能找到；不放 data\ 里跟索引、缩略图混在一起。
 * 程序目录不可写时（Program Files 之类）才退回 AppData，见 setupUserData。 */
let BACKUP_DIR = path.join(EXE_DIR, 'backup');
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

/* ============ 6. exiftool：写 GPS 与地名查询 ============
 * 写入沿用早期外部工具已验证过的那套调用方式，参数一个都不改：
 *   - 参数文件（-@）而不是命令行：中文路径直接当命令行参数会触发
 *     "FileName encoding must be specified"，且路径里的空格会被当成分隔符。
 *   - -charset filename=utf8：让 exiftool 按 UTF-8 解析参数文件里的路径。
 *   - -m：忽略 MakerNotes 轻微损坏（手机转发过的图常见），否则整张图放弃写入。
 *   - -GPSPosition=lat,lon：一次写全 GPSLatitude/Longitude 与两个 Ref 标签。
 *   - 每批 40 张：exiftool 是 Perl 打包的单进程，一次上千个文件会吃掉大量内存。
 */
let _exiftool = '';

/* 早期外部工具把「它找到的 exiftool 在哪」写进了自己的 settings.ini。
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

  // 从旧工具的配置里捡现成的（它一定已经把路径找好了），文件不在就跳过
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

/* 备份放到程序根目录的 backup\ 下，镜像原路径
 * （F:\a\b.jpg → backup\F\a\b.jpg；dev 下即项目根\backup\F\a\b.jpg）。
 * 不用 exiftool 自带的 "_original" 同目录备份：那会在照片文件夹里多出
 * xxx_original.jpg，下次扫描会当成新照片索引进来，作品集里凭空多一倍重复图。 */
function gpsBackupPathOf(abs) {
  const rel = String(abs).replace(/^([a-zA-Z]):[\\/]/, '$1/').replace(/[:*?"<>|]/g, '_');
  return path.join(BACKUP_DIR, rel);
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

/* ---- 地名搜索 ----
 * 中文查询先走百度地图 POI，再退回 Nominatim/OSM。原因很直接：
 * OSM 的中文 POI 常常只收官方名，「广州国际会议展览中心」在 OSM 里叫
 * 「中国进出口商品交易会展馆」、别名只登记了「广交会展馆」，按常用名
 * 根本搜不到；Nominatim 搜不到时还会给一条毫不相干的结果（实测是合肥
 * 「湖光路」）。百度的中文名称和别名覆盖是 OSM 比不了的，所以它排第一。
 * 百度不可用时才走 Nominatim 的三步（相关性过滤 / 城市边界内二次检索 /
 * 场馆分类检索），保证断网或接口变更时还有一路能用。 */
const NOMINATIM_UA = 'PhotoCove/18.0 (local photo library; desktop)';
const _cityCache = new Map();
const _geoCache = new Map();          // 同一个地名搜两次不必再打一次网络
const GEO_CACHE_MAX = 40;

async function nominatimSearch(params) {
  const url = 'https://nominatim.openstreetmap.org/search?' + params.toString();
  const r = await net.fetch(url, {
    headers: { 'User-Agent': NOMINATIM_UA, 'Accept': 'application/json' },
  });
  if (!r.ok) throw new Error('地名服务返回 ' + r.status);
  const arr = await r.json();
  return Array.isArray(arr) ? arr : [];
}

/* 查询与结果名的字面相关性：按空格/逗号拆词，任一词命中即可。
 * 中文整串往往很长，取 3 字滑窗比对；2 字以内的词整串比对。
 * 这样「广州白云机场」能命中「广州白云国际机场」，
 * 而「广州国际会议展览中心」不会命中合肥的「湖光路」。 */
function relatedToQuery(it, query) {
  const text = (String(it.name || '') + ' ' + String(it.display_name || '')).toLowerCase();
  const tokens = String(query).toLowerCase().split(/[\s,，、]+/).filter(t => t.length >= 2);
  return tokens.some(t => {
    if (t.length < 3) return text.includes(t);
    for (let i = 0; i + 3 <= t.length; i++) {
      if (text.includes(t.slice(i, i + 3))) return true;
    }
    return false;
  });
}

/* 从查询开头猜城市：2/3/4 字前缀，用 Nominatim 的 city 类型校验同名。
 * 结果缓存住，同一个城市不必反复请求。 */
async function cityOfQuery(query) {
  if (/[a-z]/.test(query)) return null;
  for (const len of [2, 3, 4]) {
    if (query.length < len + 2) continue;
    const prefix = query.slice(0, len);
    if (_cityCache.has(prefix)) {
      const v = _cityCache.get(prefix);
      if (v) return { name: prefix, ...v };
      continue;
    }
    let hit = null;
    try {
      const arr = await nominatimSearch(new URLSearchParams({
        format: 'jsonv2', limit: '1', featureType: 'city',
        'accept-language': 'zh-CN,zh', q: prefix,
      }));
      const it = arr[0];
      const strip = s => String(s || '').replace(/[市区县州盟旗]$/, '');
      if (it && Array.isArray(it.boundingbox) && strip(it.name) === strip(prefix)) {
        const bb = it.boundingbox.map(Number);   // [南, 北, 西, 东]
        hit = { viewbox: `${bb[2]},${bb[1]},${bb[3]},${bb[0]}`, display: String(it.display_name || '') };
      }
    } catch (e) { /* 猜不出城市就当没有 */ }
    _cityCache.set(prefix, hit);
    if (hit) return { name: prefix, ...hit };
  }
  return null;
}

/* 场馆类型词 → OSM 分类：名字对不上时按类型找，是中文 POI 的另一条路 */
const PLACE_TAGS = [
  { re: /会展|展览|博览|展馆|会议展览|会议中心/, tag: ['amenity', 'conference_centre'] },
  { re: /机场/, tag: ['aeroway', 'aerodrome'] },
  { re: /火车站|高铁站/, tag: ['railway', 'station'] },
  { re: /医院/, tag: ['amenity', 'hospital'] },
  { re: /大学|学院/, tag: ['amenity', 'university'] },
  { re: /博物馆/, tag: ['tourism', 'museum'] },
  { re: /图书馆/, tag: ['amenity', 'library'] },
  { re: /体育馆|体育场|球场/, tag: ['leisure', 'sports_centre'] },
];

function tagOfQuery(query) {
  const hit = PLACE_TAGS.find(x => x.re.test(query));
  return hit ? hit.tag : null;
}

function toGeocodeResults(arr) {
  return (Array.isArray(arr) ? arr : []).slice(0, 8).map(it => {
    const lat = Number(it.lat);
    const lng = Number(it.lon);
    const dn = String(it.display_name || '');
    const first = String(it.name || dn.split(',')[0] || '').trim();
    return { lat, lng, label: first, detail: dn.split(',').slice(1).join(',').trim() };
  }).filter(x => isFinite(x.lat) && isFinite(x.lng));
}

/* ---------- 百度 POI 检索 ----------
 * 网页端自己用的 /?qt=s 接口，不需要 Key。返回的坐标是 BD-09 墨卡托（米），
 * 必须换算成 WGS-84 才能和照片 EXIF、OSM 底图对齐。换算精度实测在十几米内
 * （天安门 39.907372,116.391347 对 OSM 39.907359,116.391263；
 *   广州塔 23.108885,113.319112 对 OSM 23.109015,113.319148）。 */
const BAIDU_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const PI = 3.1415926535897932384626;
const X_PI = PI * 3000 / 180;
const ELL_A = 6378245.0;
const ELL_EE = 0.00669342162296594323;

/* 百度墨卡托 → BD-09 经纬度：按纬度分带的拟合系数（官方投影的逆运算） */
const MC_BAND = [12890594.86, 8362377.87, 5591021, 3481989.83, 1678043.12, 0];
const MC_LL = [
  [1.410526172116255e-8, 0.00000898305509648872, -1.9939833816331, 200.9824383106796, -187.2403703815547, 91.6087516669843, -23.38765649603339, 2.57121317296198, -0.03801003308653, 17337981.2],
  [-7.435856389565537e-9, 0.000008983055097726239, -0.78625201886289, 96.32687599759846, -1.85204757529826, -59.36935905485877, 47.40033549296737, -16.50741931063887, 2.28786674699375, 10260144.86],
  [-3.030883460898826e-8, 0.00000898305509983578, 0.30071316287616, 59.74293618442277, 7.357984074871, -25.38371002664745, 13.45380521110908, -3.29883767235584, 0.32710905363475, 6856817.37],
  [-1.981981304930552e-8, 0.000008983055099779535, 0.03278182852591, 40.31678527705744, 0.65659298677277, -4.44255534477492, 0.85341911805263, 0.12923347998204, -0.04625736007561, 4482777.06],
  [3.09191371068437e-9, 0.000008983055096812155, 0.00006995724062, 23.10934304144901, -0.00023663490511, -0.6321817810242, -0.00663494467273, 0.03430082397953, -0.00466043876332, 2555164.4],
  [2.890871144776878e-9, 0.000008983055095805407, -3.068298e-8, 7.47137025468032, -0.00000353937994, -0.02145144861037, -0.00001234426596, 0.00010322952773, -0.00000323890364, 826088.5],
];

function bdMcToLngLat(x, y) {
  let cF = MC_LL[MC_LL.length - 1];
  for (let i = 0; i < MC_BAND.length; i++) {
    if (y >= MC_BAND[i]) { cF = MC_LL[i]; break; }
  }
  const lng = cF[0] + cF[1] * x;
  const c = y / cF[9];
  let lat = cF[2];
  let p = c;
  for (let i = 3; i <= 8; i++) { lat += cF[i] * p; p *= c; }
  return [lng, lat];
}

function bd09ToGcj02(lng, lat) {
  const x = lng - 0.0065;
  const y = lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
  return [z * Math.cos(theta), z * Math.sin(theta)];
}

function transformLat(lng, lat) {
  let r = -100 + 2 * lng + 3 * lat + 0.2 * lat * lat + 0.1 * lng * lat + 0.2 * Math.sqrt(Math.abs(lng));
  r += (20 * Math.sin(6 * lng * PI) + 20 * Math.sin(2 * lng * PI)) * 2 / 3;
  r += (20 * Math.sin(lat * PI) + 40 * Math.sin(lat / 3 * PI)) * 2 / 3;
  r += (160 * Math.sin(lat / 12 * PI) + 320 * Math.sin(lat * PI / 30)) * 2 / 3;
  return r;
}

function transformLng(lng, lat) {
  let r = 300 + lng + 2 * lat + 0.1 * lng * lng + 0.1 * lng * lat + 0.1 * Math.sqrt(Math.abs(lng));
  r += (20 * Math.sin(6 * lng * PI) + 20 * Math.sin(2 * lng * PI)) * 2 / 3;
  r += (20 * Math.sin(lng * PI) + 40 * Math.sin(lng / 3 * PI)) * 2 / 3;
  r += (150 * Math.sin(lng / 12 * PI) + 300 * Math.sin(lng / 30 * PI)) * 2 / 3;
  return r;
}

/* GCJ-02 → WGS-84：用正变换的偏差反推一次，误差在 1 米量级 */
function gcj02ToWgs84(lng, lat) {
  const dLat = transformLat(lng - 105, lat - 35);
  const dLng = transformLng(lng - 105, lat - 35);
  const radLat = lat / 180 * PI;
  let magic = Math.sin(radLat);
  magic = 1 - ELL_EE * magic * magic;
  const sm = Math.sqrt(magic);
  const mgLat = lat + (dLat * 180) / ((ELL_A * (1 - ELL_EE)) / (magic * sm) * PI);
  const mgLng = lng + (dLng * 180) / (ELL_A / sm * Math.cos(radLat) * PI);
  return [lng * 2 - mgLng, lat * 2 - mgLat];
}

/* 百度 geo 字段形如 "1|12620391.87,2627769.46;..."，前面还有可能是经纬度而不是墨卡托，
 * 按数值范围判断。返回 null 表示这条记录没有可用坐标。 */
function baiduGeoToWgs84(geo) {
  const parts = String(geo || '').split('|');
  const pair = (parts[1] || parts[0] || '').split(';')[0].split(',');
  let lng = Number(pair[0]);
  let lat = Number(pair[1]);
  if (!isFinite(lng) || !isFinite(lat)) return null;
  if (Math.abs(lng) > 180 || Math.abs(lat) > 90) [lng, lat] = bdMcToLngLat(lng, lat);
  const g = bd09ToGcj02(lng, lat);
  const w = gcj02ToWgs84(g[0], g[1]);
  if (Math.abs(w[1]) > 90 || Math.abs(w[0]) > 180) return null;
  return { lat: w[1], lng: w[0] };
}

/* 名字与查询词的贴合度：整串命中 > 包含 > 前缀 > 完全不沾。
 * 百度按自己的热度排序，「国际会展中心」这种只沾一半的会排在
 * 「广州国际会议展览中心-5号门」前面，必须按贴合度重排。 */
function matchScore(name, query) {
  const a = String(name || '').toLowerCase().replace(/\s+/g, '');
  if (!a) return 0;
  let best = 0;
  for (const raw of String(query).toLowerCase().split(/[\s,，、]+/)) {
    const t = raw.replace(/\s+/g, '');
    if (!t) continue;
    let s = 0;
    if (a === t) s = 1000;
    else if (a.includes(t)) s = 900;
    else if (t.includes(a) && a.length >= 2) s = 700;
    else {
      let i = 0;
      while (i < a.length && i < t.length && a[i] === t[i]) i++;
      s = i >= 3 ? i * 20 : 0;
    }
    if (s > best) best = s;
  }
  return best;
}

async function baiduPoiSearch(query) {
  const url = 'https://map.baidu.com/?qt=s&wd=' + encodeURIComponent(query) +
    '&rn=12&ie=utf-8&oue=1&fromproduct=jsapi&res=api';
  const r = await net.fetch(url, {
    headers: {
      'User-Agent': BAIDU_UA,
      'Referer': 'https://map.baidu.com/',
      'Accept': 'application/json',
    },
  });
  if (!r.ok) throw new Error('百度地名服务返回 ' + r.status);
  const j = await r.json();
  const list = Array.isArray(j && j.content) ? j.content : [];
  return list.map(it => {
    const ll = baiduGeoToWgs84(it.geo);
    if (!ll || !it.name) return null;
    return {
      name: String(it.name).trim(),
      addr: String(it.addr || '').trim(),
      lat: ll.lat,
      lng: ll.lng,
      score: matchScore(it.name, query),
    };
  }).filter(x => x && x.score > 0).sort((a, b) => b.score - a.score);
}

/* 返回 { list, note }：note 是给界面看的一句话（例如百度不可用），没有就是空串。
 * note 跟结果一起进缓存，同一个词再搜一次也能拿到同样的提示。 */
async function geocodeQuery(query) {
  if (_geoCache.has(query)) return _geoCache.get(query);
  const keep = (list, note) => {
    if (_geoCache.size >= GEO_CACHE_MAX) _geoCache.delete(_geoCache.keys().next().value);
    const hit = { list: list || [], note: note || '' };
    _geoCache.set(query, hit);
    return hit;
  };

  // 百度不通（断网 / 接口变更 / 被拦）时记一条提示一路带到界面，不再静默退回 OSM：
  // 静默的结果是界面看不出「这批结果其实来自次优来源」，出问题也无从查起。
  let note = '';

  // 1. 具体地名的中文查询先走百度 POI：中文名称与别名覆盖是 OSM 比不了的。
  //    2~3 字多半是城市/区县这类行政地名，OSM 的行政区数据更靠谱，仍走 Nominatim。
  if (/[\u4e00-\u9fff]/.test(query) && query.length >= 4) {
    try {
      const baidu = await baiduPoiSearch(query);
      if (baidu.length) {
        const exact = baidu.filter(x => x.score >= 900);
        const use = (exact.length ? exact : baidu).slice(0, 8);
        return keep(use.map(x => ({ lat: x.lat, lng: x.lng, label: x.name, detail: x.addr })));
      }
    } catch (e) {
      note = '百度地名服务不可用，已改为 OpenStreetMap 检索。';
    }
  }

  // 2. 自由文本：只留与查询词有字面交集的条目
  const raw = await nominatimSearch(new URLSearchParams({
    format: 'jsonv2', limit: '8', addressdetails: '1',
    'accept-language': 'zh-CN,zh', q: query,
  }));
  const picked = raw.filter(it => relatedToQuery(it, query));
  if (picked.length) return keep(toGeocodeResults(picked), note);

  // 2. 开头是城市名：在城市边界内再搜剩下的部分
  const city = await cityOfQuery(query);
  if (!city) return keep([], note);
  const rest = query.slice(city.name.length).replace(/^[市\s,，、]+/, '');
  if (rest.length >= 2) {
    const bounded = await nominatimSearch(new URLSearchParams({
      format: 'jsonv2', limit: '8', addressdetails: '1',
      'accept-language': 'zh-CN,zh', q: rest, viewbox: city.viewbox, bounded: '1',
    }));
    const good = bounded.filter(it => relatedToQuery(it, rest));
    if (good.length) return keep(toGeocodeResults(good), note);
  }

  // 3. 按场馆分类找：OSM 里名字对不上的场馆靠这一步能捞回来
  const tag = tagOfQuery(rest || query);
  if (tag) {
    const params = new URLSearchParams({
      format: 'jsonv2', limit: '8', addressdetails: '1',
      'accept-language': 'zh-CN,zh', viewbox: city.viewbox, bounded: '1',
    });
    params.set(tag[0], tag[1]);
    const byTag = await nominatimSearch(params);
    if (byTag.length) return keep(toGeocodeResults(byTag), note);
  }

  return keep([], note);
}

function registerIpc() {
  ipcMain.handle('cove:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    appDir: APP_DIR,
    exeDir: EXE_DIR,
    dataDir: DATA_DIR,
    backupDir: BACKUP_DIR,
    userData: app.getPath('userData'),
    packaged: app.isPackaged,
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

  /* 扫描用的元数据：读文件头 → 主进程解析 → 只回传尺寸/EXIF。
   * 页面不再拿到原始字节，也就没有「512KB × 两万张」的跨进程拷贝。
   * 返回值一律是纯对象（Date 已转成毫秒数），可直接跨 IPC。 */
  ipcMain.handle('cove:scanMeta', async (_e, p, bytes) => {
    const ext = path.extname(String(p || '')).slice(1).toLowerCase();
    const raw = SCAN_META.isRawExt(ext);
    const first = Math.max(4096, Math.min(Number(bytes) || SCAN_META.HEAD_BYTES, 4 * 1024 * 1024));
    let fh;
    try {
      const st = await fsp.stat(toFsPath(p));
      fh = await fsp.open(toFsPath(p), 'r');
      const readAt = async (n) => {
        const size = Math.min(st.size, n);
        const buf = Buffer.allocUnsafe(size);
        const { bytesRead } = await fh.read(buf, 0, size, 0);
        return { buf, bytesRead };
      };
      let { buf, bytesRead } = await readAt(first);
      let meta = await SCAN_META.describe(buf.subarray(0, bytesRead), ext);
      // 尺寸或 EXIF 没解出来、而文件还有更多内容：多半是 ICC/大段 APP 排在前面，
      // 退回一次更大的窗口重试。只对这类文件多读，正常照片一次就够。
      // RAW 不参与：它本来就解析不出尺寸，若用「没有宽高」当补读条件，
      // 上万张 RAW 会每张多读 512KB；而 exiftool 写进 RAW 的 GPS 在文件尾部，
      // 512KB 同样够不着。补写坐标改由索引里的 gpsOverrides 兜住。
      if (!raw && (!meta.w || (!meta.make && !meta.date && !meta.gps)) && st.size > bytesRead) {
        const retry = await readAt(Math.max(SCAN_META.RETRY_BYTES, first));
        if (retry.bytesRead > bytesRead) {
          meta = await SCAN_META.describe(retry.buf.subarray(0, retry.bytesRead), ext);
        }
      }
      return { ok: true, size: st.size, ...meta };
    } catch (e) {
      return { ok: false, error: (e && e.message) ? e.message : String(e) };
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
   * 中文具体地名先走百度 POI（名称/别名覆盖），不通再退回 OpenStreetMap 的 Nominatim；
   * 两条路都返回 WGS-84，与照片 EXIF 和底图同一坐标系，不需要再做 GCJ-02/BD-09 纠偏。
   * note 是给界面的来源提示（例如「百度不可用，已改用 OSM」），正常为空串。 */
  ipcMain.handle('cove:geocode', async (_e, q) => {
    const query = String(q || '').trim();
    if (!query) return { ok: false, error: '请输入地名' };
    if (query.length > 120) return { ok: false, error: '地名太长了' };
    try {
      const r = await geocodeQuery(query);
      return { ok: true, results: r.list, note: r.note };
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
    // 备份目录启动时就建好，不用等到第一次写入才出现，方便直接找到
    try { if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch (e) { /* 不影响索引 */ }
    return true;
  } catch (e) {
    console.warn('[cove] 程序目录不可写，改用系统 AppData：', e && e.message);
    // 连程序根都写不进去时，备份也只能跟着退到 AppData
    BACKUP_DIR = path.join(app.getPath('userData'), 'backup');
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
/* 单实例锁按 userData 判定，而 userData 要到 whenReady 才改成程序目录，
 * 所以开发时主程序开着的情况下，再起一个实例会静默退出（exit 0、无输出），
 * 截图/自测都没法跑。开发态给一个逃生口：COVE_NO_LOCK=1 时跳过锁。 */
const NO_LOCK = !app.isPackaged && process.env.COVE_NO_LOCK === '1';
if (!NO_LOCK && !app.requestSingleInstanceLock()) {
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
          } catch (e) {
            console.log('SHOT_SCAN_FAIL ' + (e && e.message));
          }
        }
        // 切视图不依赖 --dir：只想看设置页/帮助页时不必真扫一遍照片
        if (SHOT_VIEW) {
          try {
            await mainWin.webContents.executeJavaScript(
              `(document.querySelector('.nav-btn[data-view="${SHOT_VIEW}"]') || {}).click?.()`, true);
            await wait(SELFTEST_DIR ? 2500 : 1200);
          } catch (e) { console.log('SHOT_VIEW_FAIL ' + (e && e.message)); }
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
