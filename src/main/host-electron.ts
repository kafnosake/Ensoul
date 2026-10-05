import { BrowserWindow, app, dialog, shell } from 'electron';
import type { Host, HostWindow, OpenOptions, OpenResult, SaveOptions, SaveResult } from './host';

/**
 * 宿主能力层的 **Electron 实现** —— 整个后端里，碰窗口与系统对话框的代码只住这一处。
 *
 * 为什么值得单独一个文件：`host.ts` 那层接口是给"没有窗口的进程"留的门，
 * 而这个文件是"门后面那台真机器"。分开之后能一眼看出**到底哪些能力需要宿主**：
 * 就是这里这 9 个方法，不多不少。
 *
 * 反过来也成立：这个文件里没出现的，就是业务不需要 Electron 的地方 —— 那才是大头。
 */

/**
 * 把 BrowserWindow 包成 HostWindow。
 *
 * 为什么包一层而不是直接把 BrowserWindow 交出去：接口一旦漏出原生对象，
 * 业务代码就会开始顺手点它身上那些没被审查过的方法（`win.on(...)`、
 * `win.setBounds(...)`），过几个月又长成一片碰不得的东西。
 * 这里只放业务真用得上的那几个动作。
 */
function wrap(win: BrowserWindow): HostWindow {
  return {
    webContentsId: win.webContents.id,
    raw: win,
    isDestroyed: () => win.isDestroyed(),
    isMaximized: () => win.isMaximized(),
    isResizable: () => win.isResizable(),
    minimize: () => win.minimize(),
    maximize: () => win.maximize(),
    unmaximize: () => win.unmaximize(),
    close: () => win.close(),
  };
}

/** 从事件里那扇窗反查 BrowserWindow —— 拿不到就当没有（远程调用本来就没有） */
function rawFromEvent(event: unknown): BrowserWindow | null {
  const wc = (event as { sender?: unknown } | undefined)?.sender as
    | { id?: number }
    | undefined;
  if (!wc || typeof wc.id !== 'number') return null;
  return BrowserWindow.fromWebContents(wc as never) ?? null;
}

export const electronHost: Host = {
  focusedWindow() {
    const w = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    return w ? wrap(w) : null;
  },

  windowFromEvent(event) {
    const w = rawFromEvent(event);
    return w ? wrap(w) : null;
  },

  allWindows() {
    return BrowserWindow.getAllWindows().map(wrap);
  },

  broadcast(channel, payload) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  },

  async pickSaveFile(opts: SaveOptions): Promise<SaveResult> {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const r = win
      ? await dialog.showSaveDialog(win, opts as never)
      : await dialog.showSaveDialog(opts as never);
    return { canceled: r.canceled, filePath: r.filePath };
  },

  async pickOpenFile(opts: OpenOptions): Promise<OpenResult> {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const r = win
      ? await dialog.showOpenDialog(win, opts as never)
      : await dialog.showOpenDialog(opts as never);
    return { canceled: r.canceled, filePaths: r.filePaths };
  },

  openPath(p) {
    return shell.openPath(p);
  },

  revealInFolder(p) {
    shell.showItemInFolder(p);
  },
};

/** 顺便说明一下：这个文件被 import 的那一刻，就等于"这跑在 Electron 里" */
export function isElectron(): boolean {
  return Boolean(app);
}
