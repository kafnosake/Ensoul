import { t } from '../shared/i18n';
/**
 * 宿主能力层 —— 业务代码跟"窗口 / 对话框 / 文件管理器"之间**唯一**的接口。
 *
 * ── 为什么要有这一层 ────────────────────────────────────────────────────
 *
 * registerIpc 那 2800 行里有 19 处直接碰 Electron：弹保存框、弹打开框、在资源
 * 管理器里高亮文件、找出"发消息的是哪扇窗"。它们散在 100 条能力中间，每一条都
 * 是一根把业务钉死在 Electron 上的钉子 —— 想把这些能力搬到"没有窗口的进程"里跑，
 * 就得先拔掉这 19 根。
 *
 * 拔法不是删掉它们，而是**换个问法**：
 *   以前：`BrowserWindow.getFocusedWindow()`  ← 直接向 Electron 要窗口
 *   现在：`host.focusedWindow()`               ← 向"宿主"要窗口
 * 谁当宿主由启动方决定：Electron 里是 host-electron.ts，没有窗口的进程里
 * 就是下面这份空实现（要窗口没有、要广播没人听，但业务照跑）。
 *
 * ── 这个文件为什么一行 electron 都不 import ──────────────────────────────
 *
 * 因为它要能被**纯 node** 加载。只要这里出现 `import ... from 'electron'`，
 * 整条链（host ← rpc ← server ← boot）在裸 node 里就加载不起来 —— 那正是
 * "后端脱离 Electron"这件事唯一的卡点。
 */

/** 一扇窗 —— 只暴露业务真正用到的那几个动作，不把整个 BrowserWindow 漏出去 */
export interface HostWindow {
  /** 主进程里给这扇窗编的号，用来认"是主窗口还是哪个浮窗" */
  readonly webContentsId: number;
  /** 原生窗口本体。只有真正摸窗口那几处（windows.ts）才需要，业务不该碰 */
  readonly raw: unknown;
  isDestroyed(): boolean;
  isMaximized(): boolean;
  isResizable(): boolean;
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  close(): void;
}

/** 保存对话框的结果 —— 跟 Electron 的返回形状一致，免得调用处还要转一道 */
export interface SaveResult {
  canceled: boolean;
  filePath?: string;
}

export interface OpenResult {
  canceled: boolean;
  filePaths: string[];
}

export interface OpenOptions {
  title?: string;
  properties?: string[];
  filters?: { name: string; extensions: string[] }[];
  defaultPath?: string;
}

export interface SaveOptions {
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

/**
 * 宿主能力。**每一条都可能返回"没有"** —— 这不是异常，是常态：
 * 在浏览器或裸 node 里本来就没有窗口可控制、没有系统对话框可弹。
 * 所以调用方一律按"拿不到就放弃"处理，不要抛错。
 */
export interface Host {
  /** 此刻有焦点的窗口；没有就 null（远程调用、无窗口进程都是 null） */
  focusedWindow(): HostWindow | null;
  /** 消息是哪扇窗发来的；远程调用时 null —— 于是"控制窗口"这类能力自然失效 */
  windowFromEvent(event: unknown): HostWindow | null;
  /** 现在开着几扇窗 */
  allWindows(): HostWindow[];
  /** 推给所有窗口。没有窗口时静默丢弃（不是错误） */
  broadcast(channel: string, payload?: unknown): void;
  /** 弹"另存为" */
  pickSaveFile(opts: SaveOptions): Promise<SaveResult>;
  /** 弹"打开" —— 可多选 */
  pickOpenFile(opts: OpenOptions): Promise<OpenResult>;
  /** 用系统默认程序打开一个文件 / 目录，返回空串表示成功、否则是错误说明 */
  openPath(p: string): Promise<string>;
  /** 在资源管理器 / 访达里高亮这个文件 */
  revealInFolder(p: string): void;
}

/**
 * 没有宿主时的默认实现 —— **不是报错，是安静地"这事办不了"**。
 *
 * 裸 node 后端用的就是这一份：它照常存面板、跑插件、调模型，
 * 只是没人给它弹对话框、也没人听它广播。等哪天真接上界面，
 * 由界面那一侧 setHost() 换成真的。
 */
const headlessHost: Host = {
  focusedWindow: () => null,
  windowFromEvent: () => null,
  allWindows: () => [],
  broadcast: () => {},
  pickSaveFile: async () => ({ canceled: true }),
  pickOpenFile: async () => ({ canceled: true, filePaths: [] }),
  openPath: async () => t('当前没有窗口，打不开文件'),
  revealInFolder: () => {},
};

let current: Host = headlessHost;

/** 由启动方装上真正的宿主实现（Electron 里装 host-electron，裸 node 里不装） */
export function setHost(h: Host): void {
  current = h;
}

/** 当前宿主。业务代码只认这个，不认 Electron */
export const host: Host = new Proxy({} as Host, {
  get(_t, key: string) {
    const v = (current as unknown as Record<string, unknown>)[key];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(current) : v;
  },
});

/** 现在装的是不是那份空实现 —— 诊断用 */
export function isHeadlessHost(): boolean {
  return current === headlessHost;
}
