import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import appIdentity from '../shared/app-identity.json';

/**
 * 路径层 —— 全软件**唯一**一处问「我们住哪」。
 *
 * ── 为什么要有这个文件 ─────────────────────────────────────────────────
 *
 * 业务层真正需要的路径只有四样：userData 在哪、应用目录在哪、用户主目录在哪、
 * 版本号多少。以前这四样散在七个文件里各写各的 `app.getPath(...)` ——
 * 十三个调用点，等于把整条业务链缝死在 Electron 上：想把这些代码放进一个
 * **没有 Electron 的进程**（纯 Node 的 daemon），得先改七处 import。
 *
 * 收拢到这儿之后，那七个文件一个 Electron 符号都不认识；而"以后要不要换宿主"
 * 这件事只剩下这一个文件需要考虑。
 *
 * ── 两种取值，必须一致 ────────────────────────────────────────────────
 *
 * 拿得到 Electron 就用它问（**那才是权威答案**：打包之后 app.getAppPath()
 * 指向 asar 里的路径，不是源码树）。拿不到就按各平台的规矩自己推一份 ——
 * 推出来的必须和 Electron 给的**逐字节相同**，否则同一份数据会在两个目录之间
 * 分叉。所以下面三个推导都跟着 Electron 自己的规矩写：
 *
 *   userData  win    %APPDATA%\<name>
 *             mac    ~/Library/Application Support/<name>
 *             linux  $XDG_CONFIG_HOME/<name> 或 ~/.config/<name>
 *   appDir    源码树根 —— dist/main/paths.js 往上两级
 *   home      os.homedir()
 *
 * 名字只能有一个来源：package.json 的 `name`。它变了，三边的路径会一起变，
 * 不会只有一边动（migrate.ts 里那套搬家逻辑正是为改名的历史收尾的）。
 */

/** 这份软件的名字 —— package.json 里的 name，也是 userData 的目录名 */
export const APP_NAME = 'ensoul';

/** 从 Electron 借来的那一份 app（纯 Node 下是 null） */
interface ElectronAppLike {
  getPath(name: string): string;
  getAppPath(): string;
  getVersion(): string;
}

let appLike: ElectronAppLike | null = null;
try {
  // 只在 Electron 主进程里成立。纯 Node 下 require('electron') 给的是个路径字符串
  // （npm 包那个 index.js 的行为），所以这里认的是"有没有 app.getPath"。
  const el: any = require('electron');
  if (el && typeof el === 'object' && el.app && typeof el.app.getPath === 'function') {
    appLike = el.app as ElectronAppLike;
  }
} catch {
  appLike = null;
}

/** 此刻是有 Electron 壳（还是纯 Node）—— 给排查用 */
export function hasElectronApp(): boolean {
  return appLike !== null;
}

/** 用户主目录。拿不到返回空串，调用方自己决定是跳过还是报错 */
export function homeDir(): string {
  if (appLike) {
    try {
      const d = appLike.getPath('home');
      if (d) return d;
    } catch {
      /* 掉下去自己推 */
    }
  }
  try {
    return os.homedir();
  } catch {
    return '';
  }
}

/**
 * 应用数据目录 —— workspace.json、providers.json、components/、shots/、
 * crash/、plugin-state/ 全都在它底下。
 */
export function userDataDir(): string {
  if (appLike) {
    try {
      const d = appLike.getPath('userData');
      if (d) return d;
    } catch {
      /* 掉下去自己推 */
    }
  }
  const home = homeDir();
  if (!home) return '';
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_NAME);
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', APP_NAME);
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_NAME);
  }
}

/**
 * 这份代码所在的目录（源码树根，打包后是 asar 根）。
 * 里面住着 package.json / plugins/ / skills/ / assets/ / index.html。
 */
export function appDir(): string {
  const sourceRoot = process.env[appIdentity.sourceRootEnv];
  if (sourceRoot) return path.resolve(sourceRoot);
  if (appLike) {
    try {
      const d = appLike.getAppPath();
      if (d) return d;
    } catch {
      /* 掉下去自己推 */
    }
  }
  // dist/main/paths.js → 上两级就是源码树根（app.getAppPath() 给的也是它）
  return path.resolve(__dirname, '..', '..');
}

/** 版本号。拿不到读 package.json，再拿不到就 0.0.0 —— 崩溃报告里不该出现 undefined */
export function appVersion(): string {
  if (appLike) {
    try {
      const v = appLike.getVersion();
      if (v) return v;
    } catch {
      /* 掉下去自己读 */
    }
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appDir(), 'package.json'), 'utf8'));
    if (pkg && typeof pkg.version === 'string' && pkg.version) return pkg.version;
  } catch {
    /* 读不动就算了 */
  }
  return '0.0.0';
}

/** 常用拼法 —— 省得每个落点都自己 path.join */
export const userDataPath = (...parts: string[]): string => path.join(userDataDir(), ...parts);
export const appPath = (...parts: string[]): string => path.join(appDir(), ...parts);
