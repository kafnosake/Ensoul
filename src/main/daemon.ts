import { Menu, Tray, app, nativeImage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { appDir } from './paths';
import { t } from '../shared/i18n';

/**
 * 常驻 + 系统托盘 —— 让「后端的命」不再挂在窗口上。
 *
 * ── 两种内存，别混为一谈 ───────────────────────────────────────────────
 *
 * Electron 吃内存的不是"Electron 这个壳"，是它肚子里那个 Chromium：
 *
 *   主进程（Node 那一半）   几十兆   ← 业务、插件、Agent、落盘，全在这儿
 *   渲染进程（Chromium）    几百兆   ← 只是"把这堆状态画出来"
 *
 * 实测本机这一份：四个 electron.exe 里最小的那个 58MB 就是主进程，
 * 最大的 562MB 是窗口的渲染进程。
 *
 * 所以「只在调出界面的时候才是 Electron」这句话，落地下来只需要一件事：
 * **关掉最后一扇窗时别退出**。窗口和它的渲染进程一起销毁（几百兆当场还回去），
 * 主进程留在后台继续跑 —— 面板状态、插件、正在跑的会话，一样都不丢。
 * 再点一下托盘，窗口建回来，接上同一份 store。
 *
 * ── 和"纯 Node daemon"差在哪 ──────────────────────────────────────────
 *
 * 真正彻底的形态是 `ELECTRON_RUN_AS_NODE=1`：同一个 exe，连主进程这层壳都不要，
 * 跑成纯 Node 服务，界面从 HTTP/WS 连过来。那一步要先动传输层（现在 src/ 里一行
 * 网络代码都没有），是下一件事。
 *
 * 这一层先把**行为**做出来，而且不挡那一步：`paths.ts` 已经把七个业务文件从
 * Electron 上摘下来了，剩下要搬的就是窗口那 1141 行。
 *
 * ── 关得掉的开关 ──────────────────────────────────────────────────────
 *
 *   ENSOUL_DAEMON=0    或    启动参数 --no-daemon
 *
 * 关掉就退回老行为：关窗即退出。托盘建不起来时也自动退回（见 daemonActive）。
 */

let tray: Tray | null = null;
let quitting = false;
let active = false;

/** 用户的意图：要不要常驻（默认要） */
export function daemonEnabled(): boolean {
  const raw = String(process.env.ENSOUL_DAEMON ?? '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false;
  if (process.argv.includes('--no-daemon')) return false;
  return true;
}

/**
 * 真正生效了没有 —— 意图 + 托盘真的建起来了。
 *
 * 为什么必须带上后半句：常驻的前提是"有个地方能把它叫回来"。托盘没建成的
 * 情况下还常驻，等于把窗口关掉之后**再也打不开**（进程活着但没有任何入口），
 * 那比直接退出糟糕得多。所以托盘失败就整个退回老行为。
 */
export function daemonActive(): boolean {
  return active;
}

export function markQuitting() {
  quitting = true;
}

/**
 * 用 Electron 自带的那一手重启：relaunch() 先把"下一份自己"排进队列，exit()才真的走。
 *
 * 为什么不再用 taskkill + cmd 脚本（2026-10-03 那次「关得掉、起不来」的两个死因）：
 *   · taskkill /T 收的是当前进程的**整棵子树**，而执行脚本的 cmd 正是它的子进程 ——
 *     脚本把自己也杀了，后面那行 start 从来没执行过；
 *   · 就算脚本活着，还得靠 cmd 的引号规则拼路径，拼错只留下一句静默的
 *     「文件名、目录名或卷标语法不正确」。
 * 这条路不认 pid、不写脚本、不开命令行窗口，argv / cwd / userData 由 Electron
 * 按当前实例原样排一遍，两个平台同一份代码。
 *
 * 一件必须自己兜的事：exit() 不是 quit() —— before-quit / will-quit 都不触发
 * （2026-10-03 实测，日志里只有 quit），所以「落盘 + 收托盘」不能指望主进程里那个
 * will-quit，得在这儿做完再退。落盘归上层，用 onBeforeRelaunch 注册进来。
 */
const cleanups: Array<() => void> = [];
let restarting = false;

export function onBeforeRelaunch(fn: () => void) {
  cleanups.push(fn);
}

export function relaunchApp(): boolean {
  if (restarting) return true;
  if (process.env.ENSOUL_NO_RELAUNCH === "1") return false;
  try {
    app.relaunch();
  } catch (e) {
    console.error("[relaunch]", (e as Error)?.message ?? e);
    return false;
  }
  restarting = true;
  for (const fn of cleanups) {
    try {
      fn();
    } catch (e) {
      console.error("[relaunch] cleanup", (e as Error)?.message ?? e);
    }
  }
  destroyTray();
  markQuitting();
  setTimeout(() => app.exit(0), 400);
  return true;
}


export function isQuitting(): boolean {
  return quitting;
}

/** 托盘图标：优先 tray.png，退到 icon.png，都没有给空串 */
export function trayIconPath(): string {
  // macOS 菜单栏是**单色模板图**：系统按当前是浅色还是深色菜单栏自己上色，
  // 所以那张图必须是"只有形状、没有颜色"的版本（黑形状 + 透明底）。
  // Windows 的带底板应用图标不适合作为菜单栏模板。
  // 找图的顺序在 mac 上反过来：模板图优先。
  const names =
    process.platform === 'darwin'
      ? ['trayTemplate.png', 'tray.png', 'icon.png']
      : ['tray.png', 'icon.png'];
  for (const name of names) {
    const p = path.join(appDir(), 'assets', name);
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 继续找 */
    }
  }
  return '';
}

export interface TrayHandlers {
  /** 点托盘 —— 把界面摆出来 */
  show(): void;
  /** 菜单里的「退出」—— 真的要走了 */
  quit(): void;
}

/**
 * 建托盘。返回"常驻模式生效了没有"。
 *
 * 菜单只有两项，故意的：一个入口（打开）+ 一个出口（退出）。
 * 中间那些「暂停后台任务」之类的东西，等真有人要了再加。
 */
export function setupTray(handlers: TrayHandlers): boolean {
  if (!daemonEnabled()) {
    console.log('[常驻] 已关闭（ENSOUL_DAEMON=0 或 --no-daemon）——关掉窗口就退出');
    return false;
  }
  if (tray) return active;

  const iconFile = trayIconPath();
  if (!iconFile) {
    console.error('[常驻] 找不到托盘图标（assets/tray.png），退回"关窗即退出"');
    return false;
  }

  try {
    const img = nativeImage.createFromPath(iconFile);
    if (img.isEmpty()) throw new Error(`图标读不出内容：${iconFile}`);
    /*
     * 两条平台规矩，都收在这一个地方：
     *
     *   Windows —— 托盘是 16px 的格子，大图会被硬缩，自己缩一下更清楚。
     *   macOS   —— 菜单栏图标得标成"模板图"：系统才知道该按浅色/深色菜单栏
     *              反过来给形状上色。不标的话，深浅主题切换时图标就是错的颜色。
     */
    let trayImg = img;
    if (process.platform === 'win32') {
      trayImg = img.resize({ width: 16, height: 16 });
    } else if (process.platform === 'darwin') {
      trayImg.setTemplateImage(true);
    }
    tray = new Tray(trayImg);
    tray.setToolTip(t('Ensoul —— 在后台运行'));
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: t('打开 Ensoul'), click: () => handlers.show() },
        { type: 'separator' },
        { label: t('退出'), click: () => handlers.quit() },
      ]),
    );
    // 单击 / 双击都当"打开"：Windows 习惯单击，mac 习惯双击
    tray.on('click', () => handlers.show());
    tray.on('double-click', () => handlers.show());
    active = true;
    console.log('[常驻] 已开启 —— 关掉窗口后仍留在托盘，点托盘可重新打开');
    return true;
  } catch (e: any) {
    console.error('[常驻] 托盘建不起来，退回"关窗即退出"：', e?.message ?? e);
    tray = null;
    active = false;
    return false;
  }
}

/** 真退出之前把托盘收掉，别在系统栏里留个僵尸图标 */
export function destroyTray() {
  try {
    tray?.destroy();
  } catch {
    /* 已经没了 */
  }
  tray = null;
  active = false;
}

/**
 * 挂载件的窗口在"所有空间都可见"这条能力上，macOS 与 Windows 差一层抽象 —— 见
 * windows.ts 的 widgetTop()。这里只放「应用级」的那一件：Dock 图标。
 */

/**
 * macOS 上「只在菜单栏留个图标、Dock 里不出现」。
 *
 * 为什么 mac 需要单独一句：Windows 那边"不占任务栏"是**每个窗口**的属性
 * （`skipTaskbar`），而 mac 的任务栏是 Dock，它是**整个应用**级的 ——
 * 没有"这扇窗不进 Dock"这种说法。
 *
 * 什么时候才该藏 Dock：
 *   · 真有挂件窗口活着（`hasWidget`）—— 这时它的定位是"桌面上的一个小东西"，
 *     不该在 Dock 里再占一格；
 *   · 而且常驻已生效（托盘在）—— 否则藏了 Dock 又没托盘，用户就**找不到这个应用**了，
 *     那是比不藏糟糕得多的事故。
 *
 * 反过来，用户把挂件收掉、或者从托盘打开正式界面时，Dock 图标要还回来（'regular'）。
 * 所以这个函数是**按需调用、可反复调**的，不是启动时设一次。
 *
 * Windows 上整段是空操作。
 */
export function syncDockWithWidgets(hasWidget: boolean) {
  if (process.platform !== 'darwin') return;
  try {
    // 没有托盘入口的时候一律不藏 —— 藏了就叫不回来了
    if (!active) {
      app.setActivationPolicy('regular');
      return;
    }
    app.setActivationPolicy(hasWidget ? 'accessory' : 'regular');
  } catch (e: any) {
    console.error('[常驻] 切换 Dock 显示失败（不影响使用）：', e?.message ?? e);
  }
}

/** 退出时统一走这里 —— 收托盘、标状态，再让 Electron 走它的流程 */
export function quitApp() {
  markQuitting();
  destroyTray();
  app.quit();
}
