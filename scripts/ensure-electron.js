/**
 * 认平台：把各系统的 Electron 本体**各自放一个目录**，谁也不覆盖谁。
 *
 * 为什么要有这个（真踩出来的，不是假想）：
 * 这个项目目录在 Mac 和 Windows 之间共用，node_modules 也跟着共用。而 Electron
 * 的本体原本只有**一个**固定位置（node_modules/electron/dist），谁后装谁说了算 ——
 * 在 Mac 上装完，dist 里是 `Electron.app/Contents/MacOS/Electron`；回到 Windows，
 * `dist/electron.exe` 根本不存在，启动脚本就以为"依赖没装"，跑一次 npm install：
 * 又慢，断网时还会把好好的 node_modules 弄坏（实测那次：reify 删掉一批包、
 * electron 的 postinstall 下载失败，最后连窗口都起不来）。
 *
 * 所以改成各归各家：
 *
 *   .electron/win32-x64/      ← Windows 那份
 *   .electron/darwin-arm64/   ← Apple 芯片那份
 *   .electron/darwin-x64/     ← Intel Mac 那份
 *   .electron/<平台>-<架构>/    ← 命名规则就这一条：process.platform + process.arch
 *
 * 再把 `node_modules/electron/dist` 做成**指向当前平台那个目录的链接**
 * （Windows 用 junction，不需要管理员权限；Mac/Linux 用符号链接），
 * `path.txt` 写成这个平台该有的可执行文件名。于是：
 *   1. 各系统的文件物理上分开，互相不会覆盖；
 *   2. `require('electron')`、`npm start` 照旧能用（它们只认 dist）；
 *   3. 换平台跑之前，这个脚本自己把链接指对。
 *
 * ── 两条"别让它卡住"的规矩（也是实测出来的）──────────────────────────
 *
 * 1. **先吃本机缓存，能离线就绝不联网。** 缓存里的 zip 已经在手，就直接解它
 *    （顺手核对 sha256），不走 electron 那个安装脚本 —— 那个脚本只要摸到网络，
 *    在断网机器上会挂很久，界面上就是一个不动的窗口。
 * 2. **真要联网时必须走代理。** 这台机器上 HTTP(S) 是出不去的，本机代理在
 *    127.0.0.1:7897。脚本按这个顺序找代理：`--proxy=` 参数 → 环境变量
 *    （HTTPS_PROXY / https_proxy / ALL_PROXY）→ 常见本地端口探一遍。
 *    找不到就直接说清楚，而不是干等。
 *
 * 用法：
 *   node scripts/ensure-electron.js            # 需要时补齐并指对（差什么补什么）
 *   node scripts/ensure-electron.js --check    # 只看不动手（退出码 0 = 本机这份是好的）
 *   node scripts/ensure-electron.js --list     # 列出各个平台目录里现在有什么
 *   node scripts/ensure-electron.js --force    # 忽略缓存，重新取本机这份
 *   node scripts/ensure-electron.js --for=darwin-arm64         # 顺手把另一平台的也备好
 *   node scripts/ensure-electron.js --for=darwin-arm64 --proxy=http://127.0.0.1:7897
 *
 * 平台/架构一律取**跑这个脚本的机器**（process.platform / process.arch），
 * 不读 .npmrc、不认写死的 platform —— 那正是共用一份目录时出错的地方。
 */

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON_DIR = path.join(ROOT, 'node_modules', 'electron');
const BASE = path.join(ROOT, '.electron');
const DIST_LINK = path.join(ELECTRON_DIR, 'dist');
const PATH_TXT = path.join(ELECTRON_DIR, 'path.txt');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
};

const say = (msg) => console.log(`[electron] ${msg}`);

/** 某个平台上，可执行文件在它那份目录里的相对位置（和 electron 自己那套一致） */
function relExe(platform) {
  switch (platform) {
    case 'win32':
      return 'electron.exe';
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron';
    default:
      return 'electron';
  }
}

const slug = (platform, arch) => `${platform}-${arch}`;
const dirOf = (platform, arch) => path.join(BASE, slug(platform, arch));
const zipName = (platform, arch, version) => `electron-v${version}-${slug(platform, arch)}.zip`;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 这份目录装好了没有 */
function inspectDir(dir, platform, version) {
  const want = relExe(platform);
  let inner = '';
  try {
    inner = fs.readFileSync(path.join(dir, 'version'), 'utf8').trim().replace(/^v/, '');
  } catch {
    return { ok: false, why: '还没有（目录里没有 version 文件）', want };
  }
  if (inner !== version) return { ok: false, why: `里面是 ${inner}，包要的是 ${version}`, want };
  if (!fs.existsSync(path.join(dir, want))) return { ok: false, why: `找不到 ${want}`, want };
  return { ok: true, why: '', want, version: inner };
}

/** 现在 node_modules/electron/dist 指向哪儿 */
function linkState() {
  try {
    const st = fs.lstatSync(DIST_LINK);
    if (st.isSymbolicLink()) return { kind: 'link', target: path.resolve(ELECTRON_DIR, fs.readlinkSync(DIST_LINK)) };
    return { kind: 'dir', target: DIST_LINK };
  } catch {
    return { kind: 'none', target: '' };
  }
}

function describeLink() {
  const s = linkState();
  if (s.kind === 'none') return '（没有 dist）';
  if (s.kind === 'link') return `指向 .electron/${path.basename(s.target)}`;
  try {
    const p = fs.readFileSync(PATH_TXT, 'utf8');
    if (p.includes('Electron.app')) return '一份真的 macOS 目录（旧装法留下的）';
    if (p.includes('electron.exe')) return '一份真的 Windows 目录（旧装法留下的）';
  } catch {
    /* 下面统一说 */
  }
  return '一份真的目录（旧装法留下的）';
}

/** 把 dist 指到本机这一份。旧的那种"真目录"要删掉 —— 它多半是另一个系统的 */
function pointAt(dir) {
  const s = linkState();
  if (s.kind === 'link' && s.target === dir) return { ok: true, changed: false };
  if (s.kind !== 'none') {
    try {
      // 链接本身：只摘链接，不动它指向的内容；真目录：旧装法留下的，可以删
      if (s.kind === 'link') fs.rmSync(DIST_LINK);
      else fs.rmSync(DIST_LINK, { recursive: true, force: true });
    } catch (e) {
      return { ok: false, error: `旧的 dist 删不掉（可能有进程正占着它）：${e.message}` };
    }
  }
  try {
    fs.mkdirSync(BASE, { recursive: true });
    fs.symlinkSync(dir, DIST_LINK, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (e) {
    return { ok: false, error: `建链接失败：${e.message}` };
  }
  return { ok: true, changed: true };
}

// ─────────────────────────────────────────── 缓存在哪儿、代理怎么找

/** @electron/get 放缓存的地方（各系统不同），外加环境变量指定的 */
function cacheRoots() {
  const out = [];
  const env = process.env.ELECTRON_CACHE || process.env.electron_config_cache;
  if (env) out.push(env);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    out.push(path.join(process.env.LOCALAPPDATA, 'electron', 'Cache'));
  }
  if (process.platform === 'darwin') out.push(path.join(os.homedir(), 'Library', 'Caches', 'electron'));
  out.push(path.join(os.homedir(), '.cache', 'electron'));
  return out;
}

/**
 * 本机缓存里有没有这个平台的包。
 * 缓存目录是一层哈希目录（哈希算的是下载地址），所以每层都翻一下。
 */
function findCachedZip(platform, arch, version) {
  const name = zipName(platform, arch, version);
  for (const root of cacheRoots()) {
    const direct = path.join(root, name);
    if (fs.existsSync(direct)) return direct;
    let subs = [];
    try {
      subs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }
    for (const s of subs) {
      const p = path.join(root, s, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return '';
}

/** 常见本地代理端口 —— 探到哪个用哪个，免得非让人先配环境变量 */
const PROXY_PORTS = [7897, 7890, 7891, 10809, 10808, 1080, 8888, 20171, 2080];

function canConnect(port, ms = 250) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(ms);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/** --proxy= > 环境变量 > 探常见端口。都没有就返回空（会明确告诉用户） */
async function resolveProxy() {
  const explicit = valueOf('proxy');
  if (explicit) return explicit;
  const env = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  if (env) return env;
  for (const port of PROXY_PORTS) {
    if (await canConnect(port)) return `http://127.0.0.1:${port}`;
  }
  return '';
}

/** 对一下 sha256（electron 自带 checksums.json，缓存里的包也照验，免得解开一个坏包） */
function verifyZip(zip, platform, arch, version) {
  const sums = readJson(path.join(ELECTRON_DIR, 'checksums.json'));
  const want = sums && sums[zipName(platform, arch, version)];
  if (!want) return { ok: true, why: '（没有该平台的校验值，跳过）' };
  try {
    const got = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
    if (got !== want) return { ok: false, why: `sha256 对不上（期望 ${want.slice(0, 12)}…，实际 ${got.slice(0, 12)}…）` };
    return { ok: true, why: '' };
  } catch (e) {
    return { ok: false, why: `读不了 zip：${e.message}` };
  }
}

/** 把一份 zip 解到目标目录（用 electron 自己依赖的 extract-zip，行为一致） */
async function extractInto(zip, dir) {
  const extract = require('extract-zip');
  fs.mkdirSync(dir, { recursive: true });
  await extract(zip, { dir });
}

function writeMeta(dir, platform, arch, version) {
  try {
    fs.writeFileSync(
      path.join(dir, '.ensoul-platform.json'),
      JSON.stringify({ platform, arch, version, installedAt: new Date().toISOString() }, null, 2),
      'utf8',
    );
  } catch {
    /* 记不上不影响使用 */
  }
}

/** 走 electron 自己的安装脚本（联网那条路），并带上代理 */
function fetchViaInstaller(dir, platform, arch, version, proxy, force) {
  const installer = path.join(ELECTRON_DIR, 'install.js');
  if (!fs.existsSync(installer)) return { ok: false, error: 'node_modules/electron 是残缺的（没有 install.js）。先跑 npm install。' };

  say(proxy ? `联网下载（走代理 ${proxy}）` : '联网下载（没有找到代理，直连多半会失败）');
  const r = spawnSync(process.execPath, [installer], {
    cwd: ELECTRON_DIR,
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_OVERRIDE_DIST_PATH: dir,
      npm_config_platform: platform,
      npm_config_arch: arch,
      ...(force ? { force_no_cache: 'true' } : {}),
      ...(proxy
        ? {
            HTTP_PROXY: proxy,
            HTTPS_PROXY: proxy,
            http_proxy: proxy,
            https_proxy: proxy,
            // @electron/get 认这两个（它走 global-agent）
            ELECTRON_GET_USE_PROXY: 'true',
            GLOBAL_AGENT_HTTP_PROXY: proxy,
            GLOBAL_AGENT_HTTPS_PROXY: proxy,
          }
        : {}),
    },
  });
  if (r.status !== 0) return { ok: false, error: '下载/解包失败。' };
  return { ok: true };
}

/** 补齐某个平台的那一份。**先本地缓存，再联网（带代理）** */
async function fetchInto(dir, platform, arch, version, force) {
  if (!force) {
    const zip = findCachedZip(platform, arch, version);
    if (zip) {
      const check = verifyZip(zip, platform, arch, version);
      if (check.ok) {
        say(`用本机缓存里的包，不走网络：${zip}`);
        try {
          await extractInto(zip, dir);
          writeMeta(dir, platform, arch, version);
          return { ok: true, offline: true };
        } catch (e) {
          say(`解包失败：${e.message}（改走 electron 自己的安装脚本）`);
        }
      } else {
        say(`缓存里那份不能用：${check.why}（改走 electron 自己的安装脚本）`);
      }
    }
  }

  const proxy = await resolveProxy();
  const viaInstaller = fetchViaInstaller(dir, platform, arch, version, proxy, force);
  if (!viaInstaller.ok) {
    say(viaInstaller.error);
    if (!proxy) {
      say('这台机器直连出不去。三种办法任选：');
      say('  · 加参数： --proxy=http://127.0.0.1:7897');
      say('  · 设环境变量： set HTTPS_PROXY=http://127.0.0.1:7897');
      say('  · 让另一台能联网的机器把这个文件放到本机缓存：');
    } else {
      say('也可以让另一台能联网的机器把包放到本机缓存：');
    }
    say(`  %LOCALAPPDATA%\\electron\\Cache\\<任意名>\\${zipName(platform, arch, version)}`);
    return { ok: false };
  }
  writeMeta(dir, platform, arch, version);
  return { ok: true };
}

/** 补齐 + 指对 */
async function ensure(platform, arch, force) {
  const pkg = readJson(path.join(ELECTRON_DIR, 'package.json'));
  if (!pkg) {
    // 只打印命令、绝不自己动手装 —— 启动脚本里永远不许跑 npm install（见 启动.sh 顶上那段：
    // 以前它拿"dist 在不在"判断依赖装没装，一个 electron.exe 不见了就重装整个 node_modules，
    // 断网那次直接把构建工具链删了）。但"依赖没装"这件事本身要让人一眼看懂该干什么，
    // 所以给出可以照抄的一行，而不是只丢一句"先跑一次 npm install"。
    say('node_modules/electron 不在 —— 这台机器还没装依赖。');
    say('首次使用请打开根目录的安装.cmd（Windows）或安装.command（macOS）。');
    say('命令行也可以运行 npm run setup，统一安装依赖、准备 Electron 并构建。');
    return 1;
  }
  const version = String(pkg.version || '');
  const dir = dirOf(platform, arch);
  const state = inspectDir(dir, platform, version);

  if (state.ok && !force) {
    say(`.electron/${slug(platform, arch)} 已经就绪（electron ${version}）`);
  } else {
    if (!state.ok) say(`.electron/${slug(platform, arch)} ${state.why}`);
    const got = await fetchInto(dir, platform, arch, version, force);
    if (!got.ok) return 1;
    const after = inspectDir(dir, platform, version);
    if (!after.ok) {
      say(`装完还是不对：${after.why}`);
      return 1;
    }
  }

  const mine = platform === process.platform && arch === process.arch;
  if (!mine) {
    say(`另一个平台的那份已备好：.electron/${slug(platform, arch)}（本机的链接没动）`);
    return 0;
  }

  const pointed = pointAt(dir);
  if (!pointed.ok) {
    say(pointed.error);
    return 1;
  }
  try {
    fs.writeFileSync(PATH_TXT, relExe(platform), 'utf8');
  } catch (e) {
    say(`path.txt 写不了：${e.message}`);
    return 1;
  }
  if (pointed.changed) say(`node_modules/electron/dist 已指向 .electron/${slug(platform, arch)}`);
  say(`本机就绪：electron ${version}（${slug(platform, arch)}）`);
  return 0;
}

function list() {
  const pkg = readJson(path.join(ELECTRON_DIR, 'package.json'));
  const version = pkg ? String(pkg.version || '') : '?';
  say(`node_modules/electron/dist 现在：${describeLink()}`);
  say(`包要求的版本：${version}`);
  let names = [];
  try {
    names = fs.readdirSync(BASE, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    say('还没有 .electron 目录（跑一次 node scripts/ensure-electron.js 就会建）');
    return 0;
  }
  if (!names.length) {
    say('.electron 是空的');
    return 0;
  }
  for (const name of names.sort()) {
    const dir = path.join(BASE, name);
    const meta = readJson(path.join(dir, '.ensoul-platform.json')) || {};
    const st = inspectDir(dir, name.split('-')[0], version);
    const mine = name === slug(process.platform, process.arch) ? '*' : ' ';
    const when = meta.installedAt ? `  装于 ${meta.installedAt.slice(0, 16).replace('T', ' ')}` : '';
    say(`  ${mine} .electron/${name}  ${st.ok ? '完整' : `不完整（${st.why}）`}${when}`);
  }
  say('（* = 本机这个平台）');
  return 0;
}

async function main() {
  if (has('--soft') && process.env.ELECTRON_SKIP_BINARY_DOWNLOAD === '1') {
    say('跳过依赖安装阶段的本体下载；由安装入口统一准备 Electron。');
    return 0;
  }
  if (has('--list')) return list();
  const soft = has('--soft');

  const forWhat = valueOf('for');
  if (forWhat) {
    const m = /^([a-z0-9]+)-([a-z0-9_]+)$/.exec(forWhat);
    if (!m) {
      say('--for 的写法是 <平台>-<架构>，例如 --for=darwin-arm64');
      return 1;
    }
    return ensure(m[1], m[2], false);
  }

  const platform = process.platform;
  const arch = process.arch;
  const pkg = readJson(path.join(ELECTRON_DIR, 'package.json'));
  const version = pkg ? String(pkg.version || '') : '';

  if (has('--check')) {
    const state = inspectDir(dirOf(platform, arch), platform, version);
    const link = linkState();
    const rightLink = link.kind === 'link' && path.basename(link.target) === slug(platform, arch);
    if (state.ok && rightLink) {
      say(`本机正确：electron ${version}（${slug(platform, arch)}），dist 指向 .electron/${slug(platform, arch)}`);
      return 0;
    }
    say(`本机不对：${state.ok ? `本体在，但 dist ${describeLink()}` : state.why}`);
    return 1;
  }

  return ensure(platform, arch, has('--force'));
}

main()
  .then((code) => {
    // --soft：给 npm 的 postinstall 用。
    // 这时候"装不上本机版本"通常只是网络/缓存的问题，不该把整次 npm install 判死 ——
    // 真装不上，启动器每次开都会再试一次，并把人话打出来。硬失败反而会让人
    // 以为"依赖装坏了"，再跑一次 npm install，把 node_modules 越搞越乱。
    if (code !== 0 && process.argv.includes('--soft')) {
      say('（--soft：这次不算安装失败。启动时脚本会再试一次。）');
      return 0;
    }
    return code;
  })
  .then((code) => process.exit(code))
  .catch((e) => {
    say(`脚本自己崩了：${e && e.message}`);
    process.exit(process.argv.includes('--soft') ? 0 : 2);
  });
