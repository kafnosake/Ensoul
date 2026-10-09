import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { appDir, userDataPath } from './paths';
import { workspaceRoot } from './fsapi';
import { windows } from './windows';
import { store } from './store';
import { onBeforeRelaunch, relaunchApp } from './daemon';
import { t } from '../shared/i18n';
import { BuildCoordinator, buildInput, buildOutput, type BuildTarget } from './project-build';
import { killProcessTree } from './process-control';

/**
 * 项目的运行控制 —— 工作区里那个项目，能被启动、停止、重建、重启，也能看到它的输出。
 *
 * agent 干完活之后要验证，就得能把它跑起来；所以这套能力同时也是给 agent 的工具
 * （restart_project / read_logs），不只是界面上一个按钮。
 *
 * 工作区是唯一的（fsapi 里那个根），这里不切目录，只在这个根下跑。
 *
 * 三个坑，都是实测踩出来的，改这里之前先读一遍：
 *
 * 1. 启动脚本（启动.cmd）用 `start` 拉起 electron 之后自己就 exit 了。于是我们手里
 *    那个 child 句柄是一具 cmd 的尸体：`stop()` 拿到 pid 再 taskkill，杀的是早就
 *    退出的 shell，真正的 electron 一个都没死。所以这里默认直接起 electron 本体。
 * 2. 启动脚本只在 `dist\main\index.js` 不存在时才 build。改完 src 再走一遍启动脚本，
 *    跑的还是旧产物，而且一声不吭。所以"要不要构建"得由这里判断，不能指望脚本。
 * 3. 如果工作区就是 ensoul 自己，那么"杀掉旧进程"杀的就是当前这个进程 ——
 *    工具调用还没返回，承载它的窗口已经没了。所以自重启必须交给外部脚本延迟执行。
 */

let child: ChildProcess | null = null;
let command = '';
let log: string[] = [];
let startedAt = 0;
let listeners: Array<(line: string) => void> = [];

const MAX_LOG = 400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 工作区里 electron 的本体位置 —— 存在的话就绕开启动脚本直接用。
 *
 * 三个平台的排布不一样。写死 electron.exe 的话 mac 上这个路径根本不存在，
 * 于是 launch() 里那条"直连 electron"的快路永远走不到，只能退回启动脚本 ——
 * 而启动脚本会把进程甩出我们的句柄，stop() 之后就再也杀不动它了。
 * 所以按平台分开，Windows 那一条一个字没动。
 */
function electronExe(): string {
  const root = workspaceRoot();
  const rel =
    process.platform === 'win32'
      ? 'electron.exe'
      : process.platform === 'darwin'
        ? 'Electron.app/Contents/MacOS/Electron'
        : 'electron';
  const local = path.join(root, '.electron', `${process.platform}-${process.arch}`, rel);
  if (fs.existsSync(local)) return local;
  // 退路：.electron 还没备好时（首次跑、ensure-electron 尚未执行）仍然指到能用的那份
  const dist = path.join(root, 'node_modules', 'electron', 'dist');
  if (process.platform === 'win32') return path.join(dist, 'electron.exe');
  if (process.platform === 'darwin') {
    return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  }
  return path.join(dist, 'electron'); // linux
}

/** 探测这个项目该怎么起：优先项目自己的启动脚本，其次 package.json */
export function detectCommand(): string {
  const root = workspaceRoot();
  const has = (f: string) => fs.existsSync(path.join(root, f));
  if (has(t('启动.cmd'))) return t('启动.cmd');
  if (has('start.cmd')) return 'start.cmd';
  // mac / linux 的对等物，排在 .cmd 之后 —— Windows 上有 .cmd 时就轮不到它们，
  // 两条路互不干扰。前缀 `sh ` 是因为它们未必带可执行位。
  if (has(t('启动.sh'))) return t('sh 启动.sh');
  if (has('start.sh')) return 'sh start.sh';
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      if (pkg?.scripts?.dev) return 'npm run dev';
      if (pkg?.scripts?.start) return 'npm start';
    } catch {
      /* 读不了就当没有 */
    }
  }
  return '';
}

export function currentCommand(): string {
  return command || detectCommand();
}

export function setCommand(cmd: string) {
  command = cmd.trim();
  return currentCommand();
}

function push(line: string) {
  const text = line.replace(/\r?\n$/, '');
  if (!text) return;
  log.push(text);
  if (log.length > MAX_LOG) log = log.slice(-MAX_LOG);
  for (const l of listeners) l(text);
}

export function onLog(fn: (line: string) => void) {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((x) => x !== fn);
  };
}

export function status() {
  return {
    // 自管理的工作区里，跑着的这个进程本身就是实例（设计上 child 恒为 null，
    // runningMainIsStale 的注释也是这么假设的）。只看 child 会谎报"没在跑" ——
    // 谁信了这句谎报去调 start，就会拉出一个孪生窗口：两份实例抢同一份 .ensoul/state。
    running: Boolean(child) || selfManaged(),
    command: currentCommand(),
    startedAt,
    workspace: buildRoot(),
    log: log.slice(-200),
  };
}

/** src 下最新的一个文件的修改时间 */
function newestSource(dir: string, depth = 0, pluginRoot = ''): number {
  if (depth > 8) return 0;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let newest = 0;
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      newest = Math.max(newest, newestSource(full, depth + 1, pluginRoot));
      continue;
    }
    if (pluginRoot && /^plugins\/[^/]+\/index\.js$/.test('plugins/' + path.relative(pluginRoot, full).split(path.sep).join('/'))) continue;
    try {
      newest = Math.max(newest, fs.statSync(full).mtimeMs);
    } catch {
      /* 读不到就跳过 */
    }
  }
  return newest;
}

/**
 * 产物是不是落后于源码。
 * 启动脚本只看 `dist` 在不在，改了 src 它会照样跑旧产物 —— 这个判断只能放在这儿。
 */
export function needsBuild(): boolean {
  const root = buildRoot();
  const stamp = (rel: string) => {
    try {
      return fs.statSync(path.join(root, rel)).mtimeMs;
    } catch {
      return 0;
    }
  };
  const out = Math.min(
    stamp(path.join('dist', 'main', 'index.js')),
    stamp(path.join('dist', 'renderer', 'index.html')),
  );
  if (!out) return true; // 产物不全，必须构建
  return Math.max(newestSource(path.join(root, 'src')), newestSource(path.join(root, 'plugins'), 0, path.join(root, 'plugins')),
    ...['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.main.json', 'vite.config.ts', 'index.html'].map(stamp)) > out;
}

/** 跑一条构建命令。返回退出码与完整输出，构建失败时不往下走。 */
function runBuild(use: string, root: string, fallback = false): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    push(`$ ${use}`);
    let out = '';
    const eat = (b: Buffer | string) => {
      const s = String(b);
      out += s;
      push(s);
    };
    let p: ChildProcess;
    try {
      p = spawn(use, {
        cwd: root,
        shell: true,
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: { ...process.env, FORCE_COLOR: '0', ...(fallback ? { PATH: `C:\\Program Files\\nodejs;${process.env.PATH || ''}` } : {}) },
      });
    } catch (e: any) {
      const msg = `构建起不来：${e?.message ?? e}`;
      push(msg);
      resolve({ ok: false, out: msg });
      return;
    }
    const timer = setTimeout(() => { eat('\n构建超过 5 分钟，已停止。'); killProcessTree(p); }, 300_000);
    p.stdout?.on('data', eat);
    p.stderr?.on('data', eat);
    p.on('error', (e) => {
      clearTimeout(timer);
      push(`构建失败：${e.message}`);
      resolve({ ok: false, out: `${out}\n${e.message}` });
    });
    p.on('close', async (code) => {
      clearTimeout(timer);
      push(`（构建结束，退出码 ${code ?? '?'}）`);
      if (code !== 0 && !fallback && process.platform === 'win32' && /Could not determine Node\.js install directory/.test(out)) {
        const node = 'C:\\Program Files\\nodejs\\node.exe';
        const npm = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
        if (fs.existsSync(node) && fs.existsSync(npm)) {
          const command = use.replace(/(^|&&\s*)node /g, `$1"${node}" `)
            .replace(/(^|&&\s*)npm /g, `$1"${node}" "${npm}" `);
          resolve(await runBuild(command, root, true));
          return;
        }
      }
      resolve({ ok: code === 0, out });
    });
  });
}

const builds = new Map<string, BuildCoordinator>();
function buildAt(root: string, target: BuildTarget): Promise<{ ok: boolean; out: string }> {
  if (!root) return Promise.resolve({ ok: false, out: '还没选工作区' });
  const key = path.resolve(root);
  let coordinator = builds.get(key);
  if (!coordinator) {
    coordinator = new BuildCoordinator(
      (target) => buildInput(key, target),
      (target) => buildOutput(key, target),
      (target) => runBuild(target === 'full' ? 'npm run build' : 'node scripts/check-types.js && npm run build:renderer', key),
    );
    builds.set(key, coordinator);
  }
  return coordinator.run(target);
}

export function buildApp(target: BuildTarget): Promise<{ ok: boolean; out: string }> {
  return buildAt(appDir(), target);
}

/** 构建全部：主进程 + 界面；同一工作区的构建串行，成功版本可复用。 */
export function build(): Promise<{ ok: boolean; out: string }> {
  return buildAt(buildRoot(), 'full');
}

/** 只构建界面。改渲染层走这条最快，之后只要刷新窗口就行 */
export function buildRenderer(): Promise<{ ok: boolean; out: string }> {
  return buildAt(buildRoot(), 'renderer');
}

/**
 * 主进程的产物落后了吗 —— **只有它落后才必须真重启**。
 *
 * 界面产物落后不算数：重建界面 + 刷新窗口就够了，应用完全不用重启，
 * 窗口位置、面板布局、对话记录全都留着。主进程的代码已经跑在内存里，
 * 没有任何办法热替换，那是唯一躲不掉重启的情况。
 */
export function mainNeedsBuild(): boolean {
  let out = 0;
  try {
    out = fs.statSync(path.join(buildRoot(), 'dist', 'main', 'index.js')).mtimeMs;
  } catch {
    return true; // 主进程产物都不在，当然得构建
  }
  const root = buildRoot();
  const stamp = (file: string) => fs.existsSync(path.join(root, file)) ? fs.statSync(path.join(root, file)).mtimeMs : 0;
  return Math.max(...['main', 'preload', 'shared'].map((dir) => newestSource(path.join(root, 'src', dir))),
    ...['package.json', 'package-lock.json', 'tsconfig.main.json'].map(stamp)) > out;
}

/**
 * 跑着的这个实例，用的是不是最新的主进程产物？
 *
 * 为什么非要有这一条：`build_project` 会先把 dist/main 刷成最新，于是
 * `mainNeedsBuild()` 就变成 false —— 重启于是走了"只刷新界面"的快路，
 * 而内存里跑的还是旧的主进程代码：界面上一个字都不会变，而且**不会报任何错**。
 * 这正是"改了没反应"里最贵的那一种（规矩第 1 条要求先 build 再 restart，
 * 结果恰恰是这个顺序把它踩响）。
 *
 * 判据很直接：产物比这个实例起得还晚，说明它吃进去的是旧代码。
 */
function runningMainIsStale(): boolean {
  // 内存里那份主进程代码是什么时候的？分两种情形取时刻：
  //  - 这个实例是我们自己 launch 起来的 → 用记录的 startedAt；
  //  - 工作区就是 ensoul 自己（自管理）→ child 恒为 null、startedAt 恒为 0，
  //    这时"跑着的代码"就是**当前这个进程**，用 uptime 反推它的出生时刻。
  //
  // 少了第二条兜底，自管理场景下这个函数恒返回 false：build_project 刚把产物
  // 刷成最新，mainNeedsBuild() 也成了 false，于是重启走"只刷新界面"的快路，
  // 主进程的改动一声不吭地不生效 —— 正是注释里描述的那种"改了没反应"。
  const born = startedAt || Date.now() - process.uptime() * 1000;
  if (!born) return false;
  let out = 0;
  try {
    out = fs.statSync(path.join(buildRoot(), 'dist', 'main', 'index.js')).mtimeMs;
  } catch {
    return true; // 产物都不在了，那现在跑的更不可能是对的
  }
  return out > born;
}

/** 拉起一个实例。这里拿到的 child 就是真进程，stop() 才杀得动。 */
function launch(): string {
  const root = workspaceRoot();
  const exe = electronExe();
  try {
    if (fs.existsSync(exe)) {
      // 绕开启动脚本：它的 `start` 会让 electron 脱离我们的句柄，之后就管不住它了
      // 非 Windows 上加 detached：让 child 自己当进程组组长，stop() 才能用
      // kill(-pid) 一次收掉整组。Windows 那条路原样不动，它靠 taskkill /T。
      child = spawn(exe, ['.'], {
        cwd: root,
        env: { ...process.env, FORCE_COLOR: '0' },
        detached: process.platform !== 'win32',
      });
      command = `${path.relative(root, exe)} .`;
    } else {
      const use = currentCommand();
      if (!use) return t('没有可用的启动命令：在这个工作区里放一个 启动.cmd，或者有 package.json 的 start 脚本。');
      child = spawn(use, {
        cwd: root,
        shell: true,
        windowsHide: true,
        env: { ...process.env, FORCE_COLOR: '0' },
        // 同上：非 Windows 要自成一个进程组，否则停不掉它拉起来的子进程
        detached: process.platform !== 'win32',
      });
      command = use;
    }
  } catch (e: any) {
    child = null;
    return `启动失败：${e?.message ?? e}`;
  }
  startedAt = Date.now();
  child.stdout?.on('data', (b) => push(String(b)));
  child.stderr?.on('data', (b) => push(String(b)));
  child.on('exit', (code) => {
    push(`（进程结束，退出码 ${code ?? '?'}）`);
    child = null;
  });
  child.on('error', (err) => {
    push(`启动失败：${err.message}`);
    child = null;
  });
  return '';
}

export function stop(): ReturnType<typeof status> {
  // 杀之前先把挂着的改动落盘：taskkill /F 不给退出钩子机会，防抖 timer 一丢就是静默丢数据。
  store.flushNow();
  if (child?.pid) {
    const pid = child.pid;
    if (process.platform === 'win32') {
      try {
        // 整棵进程树一起收，不然 shell 底下的子进程会留下来占端口
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      } catch {
        try {
          child.kill();
        } catch {
          /* 已经没了 */
        }
      }
    } else {
      // 负号 pid = 整个进程组。launch() 在非 Windows 上用了 detached，
      // 所以 pid 就是组长，一条信号收掉 electron 主进程和它下面的渲染/GPU 进程。
      // 万一这个实例不是我们起（比如用户自己在终端跑的），没有组可收，
      // 退回单杀。注意 mac 上不接受 SIGKILL 之外的偷懒写法，SIGTERM 够用。
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          child.kill();
        } catch {
          /* 已经没了 */
        }
      }
    }
    child = null;
    push(t('（已停止）'));
  } else if (selfManaged()) {
    push(t('（自管理：跑着的就是当前这个进程，stop 收不掉自己 —— 要退出就关窗口）'));
  }
  return status();
}

/** 现在这个进程是不是就跑在工作区里 —— 是的话，「重启」等于重启自己 */
function isSelf(): boolean {
  const exe = process.execPath.toLowerCase();
  const root = workspaceRoot().toLowerCase();
  return exe === root || exe.startsWith(root + path.sep);
}

/**
 * 这个进程是从**源码树**里跑起来的吗 —— 开发实例跑的是自己那份 checkout。
 *
 * 为什么要单独问这一句：工作区（workspaceRoot）和源码树（appDir）可以是两个地方 ——
 * 用户把工作区设成自己的项目、而这份应用是从源码里跑起来的，就是这种局面。
 */
function runsFromSource(): boolean {
  let app = '';
  try {
    app = appDir().toLowerCase();
  } catch {
    return false;
  }
  if (!app) return false;
  const exe = process.execPath.toLowerCase();
  return exe === app || exe.startsWith(app + path.sep);
}

/** 工作区里有没有一个真能构建的项目 —— 判据和 detectCommand 同一套 */
function workspaceHasProject(): boolean {
  const root = workspaceRoot();
  if (!root) return false;
  const has = (f: string) => {
    try {
      return fs.existsSync(path.join(root, f));
    } catch {
      return false;
    }
  };
  return has('package.json') || has(t('启动.cmd')) || has('start.cmd') || has(t('启动.sh')) || has('start.sh');
}

/**
 * 自管理：跑着的这个实例就是「要重启的那个项目」。
 *
 * 两条来路 —— 工作区本来就是源码树自己；或者工作区里根本没有能构建的项目，
 * 而进程又是从源码树里跑起来的（这时「重启项目」只可能是在重启这份应用自己）。
 *
 * 少了第二条，就是 2026-10-09 那个「关掉后没重启」：工作区是个空目录，
 * restart 在它里面跑 npm run build 直接 ENOENT，built=false，一声不吭地停在原地 ——
 * 界面上那条确认请求点了也没用，窗口既不关也不换。
 */
function selfManaged(): boolean {
  return isSelf() || (runsFromSource() && !workspaceHasProject());
}

/** 该构建哪个根：自管理时构建源码树自己，否则构建工作区里的项目 */
function buildRoot(): string {
  return runsFromSource() && !workspaceHasProject() ? appDir() : workspaceRoot();
}

export async function start(cmd?: string): Promise<ReturnType<typeof status>> {
  if (child) return status();
  // 自管理：当前进程就是这个实例，再 launch 一份只会多开一个窗口 —— 两份实例
  // 抢同一份 .ensoul/state，谁把谁覆盖了都看不出来。让改动生效是 restart 的活
  // （外部脚本先确认杀旧、再起新，窗口只换不叠）。
  if (selfManaged()) {
    push(t('（自管理：当前进程就是这个实例，不再另起一份 —— 改动生效请用 restart_project）'));
    return status();
  }
  if (cmd) setCommand(cmd);
  log = [];
  // 改完 src 直接启动，脚本一定会跑旧产物 —— 所以先看要不要构建
  if (needsBuild()) {
    const r = await build();
    if (!r.ok) {
      push(t('构建没过，先不启动。'));
      return status();
    }
  }
  const err = launch();
  if (err) push(err);
  return status();
}

export type RestartResult = {
  status: ReturnType<typeof status>;
  built: boolean;
  selfRestart: boolean;
  /** 只刷新了窗口，没有重启应用（改的只是界面代码） */
  reloaded: boolean;
  out: string;
};

/**
 * 重启。先在这里把构建做完 —— 这一步留在当前进程里，构建失败还能回到对话里说一声；
 * 等构建过了再动进程。
 *
 * 如果工作区就是这个项目自己，那"杀掉旧实例"杀的是当前进程：直接把返回值送回去的
 * 路都没了，对话会僵在半句上。所以那一下交给一个脱离的脚本，延迟两秒动手 ——
 * 先把话说完，再换新实例。
 */
export async function restart(cmd?: string): Promise<RestartResult> {
  if (cmd) setCommand(cmd);

  // 只改了界面代码的话，没必要惊动整个应用：重建界面 + 刷新窗口就够了。
  // 主进程改了才必须真重启 —— 它的代码已经在内存里跑着，热替换不了。
  // 注意第二个条件：构建可能已经在 build_project 那一步做完了（那时 mainNeedsBuild()
  // 已经是 false），但内存里跑的还是旧代码 —— 那也必须真重启（见 runningMainIsStale）。
  if (!mainNeedsBuild() && !runningMainIsStale()) {
    const rr = await buildRenderer();
    if (!rr.ok) {
      return { status: status(), built: false, selfRestart: false, reloaded: false, out: rr.out };
    }
    windows.reloadAll();
    push(t('（只改了界面代码：已重建界面并刷新窗口，没有重启应用）'));
    return { status: status(), built: true, selfRestart: false, reloaded: true, out: rr.out };
  }

  const r = await build();
  if (!r.ok) {
    return { status: status(), built: false, selfRestart: false, reloaded: false, out: r.out };
  }

  // 往下每一步都要杀掉当前进程（Windows 是 taskkill /F，一步到位；mac 先发 SIGTERM，
  // 再轮询等它退、不退就 SIGKILL —— 脚本里那几行就是 taskkill /F 在 mac 上的对应物）：
  // 先把挂着的防抖改动同步落盘，否则最后 250ms 里的改动会随进程一起没了。
  store.flushNow();

  const root = selfManaged() ? appDir() : workspaceRoot();

  if (selfManaged()) {
    // 工作区就是 ensoul 自己 —— 要走的就是当前这个进程。
    //
    // 这一支以前交给「外部脚本里 taskkill 自己 + start」：它能成的前提是脚本比被杀的进程活得久，
    // 而 taskkill /T 收掉的正是脚本所依附的那棵 cmd 树 —— 2026-10-03 的「关得掉、起不来」就是这么来的：
    // 脚本自杀在 taskkill 那一行，start 一次都没跑到。换成 Electron 自带的 relaunch 之后，没有 pid、没有 cmd、没有引号拼接。
    if (relaunchApp()) {
      push(t('（已交给 Electron 自己重启：约半秒后这个窗口关掉，新实例自动接上）'));
      return { status: status(), built: true, selfRestart: true, reloaded: false, out: r.out };
    }
    push(t('（Electron 自带的重启没起来，改用外部脚本兜底）'));
  } else {
    stop();
    await sleep(800); // 给 taskkill 一点时间，别让新旧实例撞上
    const err = launch();
    if (err) push(err);
    return { status: status(), built: true, selfRestart: false, reloaded: false, out: r.out };
  }

  // 走到这儿 = relaunch 起不来（极端环境），下面改由外部脚本接手。

  const exe = electronExe();
  const isWin = process.platform === 'win32';
  const target = fs.existsSync(exe)
    ? `"${exe}" "${root}"`
    : currentCommand() || (isWin ? t('启动.cmd') : t('sh 启动.sh'));

  // 把重启脚本**写成一个真正的脚本文件**再执行，而不是用 & 拼成一长串命令。
  //
  // 为什么非改不可：拼字符串在 cmd 的引号规则下极容易出错 —— 今天就吃了这个亏，
  // 日志里只有一句"文件名、目录名或卷标语法不正确"：taskkill 把软件杀了，
  // 后面的 start 根本没执行，于是"关得掉、起不来"。写成文件之后引号和换行都正常，
  // 而且出错时那个文件还在，打开就能看见是哪一条。
  //
  // 内容必须 **ASCII-only**：cmd.exe 按 OEM 代码页读 .cmd，中文注释会把解析器搞坏
  // （启动.cmd 上踩过一次）。所以注释一律用英文 —— .sh 那边照同一个规矩来，
  // 省得以后再想一遍。
  //
  // 两个平台的差别只有三处：等待改 sleep、杀进程改 kill、拉起新实例改 nohup。
  // 逻辑一一对应，Windows 那份脚本连字符都没变。
  //
  // 但"杀进程"这一步两边必须达到同一个效果 —— **确认它已经死了**：taskkill /F 返回即死，
  // SIGTERM 只是敲门。所以 mac 那份要自己补轮询 + SIGKILL 兜底，否则旧实例退干净之前
  // 新实例就被 nohup 拉起来了：两个窗口，抢同一份 state。
  const logFile = userDataPath('restart.log');
  const script = userDataPath(isWin ? 'restart.cmd' : 'restart.sh');
  const body = isWin
    ? [
        '@echo off',
        'rem Written by ensoul itself. Keep ASCII-only.',
        // 先让脚本把自己甩进一个新的 cmd（relay），再回来杀进程。
        // 不这么做：taskkill /T 收的是当前进程的整棵子树，而执行脚本的 cmd 正是它的子进程。
        // 脚本会把自己一起收掉 —— 后面的 start 永远不执行，症状就是关得掉、起不来。
        'if not "%~1"=="relay" (',
        '  start "" /min cmd /c "%~f0" relay',
        '  exit /b',
        ')',
        'ping -n 3 127.0.0.1 >nul',
        `taskkill /PID ${process.pid} /T /F`,
        'ping -n 2 127.0.0.1 >nul',
        `cd /d "${root}"`,
        `start "" ${target}`,
      ].join('\r\n')
    : [
        '#!/bin/sh',
        '# Written by ensoul itself. Keep ASCII-only.',
        '# ping is not portable, sleep is.',
        'sleep 2',
        `kill -TERM ${process.pid} 2>/dev/null || true`,
        '# taskkill /F comes back only after the process is gone. SIGTERM is only a',
        '# request, so poll until it is really dead, then force it.',
        'i=0',
        `while kill -0 ${process.pid} 2>/dev/null && [ "$i" -lt 20 ]; do sleep 0.25; i=$((i + 1)); done`,
        `kill -KILL ${process.pid} 2>/dev/null || true`,
        'sleep 1',
        `cd "${root}" || exit 1`,
        '# nohup + & : this script exits right away, the new instance must not die with it.',
        `nohup ${target} >>"${logFile}" 2>&1 &`,
      ].join('\n');

  try {
    fs.writeFileSync(script, body, 'utf8');
    if (!isWin) {
      // 我们是用 /bin/sh 显式执行的，可执行位不是必须 —— 但留着方便手动跑一遍看看
      try {
        fs.chmodSync(script, 0o755);
      } catch {
        /* 无所谓 */
      }
    }
    const sink = fs.openSync(logFile, 'a');
    // 把脚本本身也记进日志：下次再失败，一眼就能看出是哪一条命令
    fs.writeSync(sink, `\r\n--- ${new Date().toISOString()} ---\r\n${body}\r\n`);
    const helper = isWin
      ? spawn('cmd', ['/c', script], {
          detached: true,
          stdio: ['ignore', sink, sink],
          windowsHide: true,
        })
      : spawn('/bin/sh', [script], {
          detached: true,
          stdio: ['ignore', sink, sink],
        });
    helper.unref();
    push(t('（已交给外部脚本：约两秒后收掉旧进程，再用新产物拉起实例）'));
  } catch (e: any) {
    return {
      status: status(),
      built: true,
      selfRestart: false,
      reloaded: false,
      out: `${r.out}\n外部脚本没起来：${e?.message ?? e}`,
    };
  }

  return { status: status(), built: true, selfRestart: true, reloaded: false, out: r.out };
}

/** 给 agent 看的：最近的项目输出 */
export function tail(lines = 80): string {
  return log.length ? log.slice(-lines).join('\n') : t('（还没有输出）');
}
