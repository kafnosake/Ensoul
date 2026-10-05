import { t } from '../shared/i18n';
/**
 * RPC 路由表 —— 把「这软件有哪些能力」从 Electron 手里抄一份出来。
 *
 * ── 为什么要有这一层 ────────────────────────────────────────────────────
 *
 * 现在 100 条 `ipcMain.handle(...)` 是**焊在 Electron 上**的：函数体都在，名字也在，
 * 但除了 Electron 那条 IPC 通道，世上没有第二个地方知道"有这些能力、分别叫什么"。
 * 于是"后端能不能脱离 Electron 跑"这件事，卡点根本不在业务逻辑 ——
 * 而在**没有一张清单**。
 *
 * 这一层只干一件事：拦在 ipcMain 前面，每条 handle **顺手抄一份进表**。
 * 键是通道名，值是原来那个函数 —— **一字不改，行为零变化**。
 * 有了表，接 HTTP / WebSocket 就只剩"查表 + 用假 event 调一下"。
 *
 * ── 为什么保留 (event, ...args) 的原签名 ───────────────────────────────
 *
 * 因为这样 100 条 handler 一行都不用改。真要用 event 的只有 4 条（都跟窗口有关），
 * 给它们一个带 sender 的假 event 即可；其余 96 条根本不碰第一个参数。
 *
 * ── 这张表是"后端"，不是"界面" ────────────────────────────────────────
 *
 * 表里不该出现 `float:dragMove`、`win:tearTick` 这类东西 —— 它们是**窗口硬件的
 * 私事**（鼠标拖到哪、窗口撕了几像素），离开 Electron 就没有意义。所以 `on`
 * 一律透传、不登记：能力清单只收 handle。
 */

/** 一条能力：原样是 ipcMain.handle 的签名 */
export type RpcFn = (event: any, ...args: any[]) => any;

/** 通道名 → 能力实现 */
const table = new Map<string, RpcFn>();

/** 这张表此刻有多少条、都叫什么 —— 就是「这软件能干什么」的完整清单 */
export function rpcChannels(): string[] {
  return [...table.keys()].sort();
}

export function rpcCount(): number {
  return table.size;
}

/** 按通道名取出能力；没有返回 undefined */
export function rpcPick(channel: string): RpcFn | undefined {
  return table.get(channel);
}

/**
 * 远程调用一个能力。
 *
 * `event` 是给那 4 条碰窗口的 handler 留的位子 —— 远程调用时传 null，
 * 它们本来也不该被远程调到（谁想从浏览器里拖 Electron 的窗口呢）。
 */
export async function rpcCall(channel: string, args: any[], event: any = null): Promise<any> {
  const fn = table.get(channel);
  if (!fn) throw new Error(`没有这条能力：${channel}`);
  return await fn(event, ...args);
}

/**
 * 把真的 ipcMain 包一层。
 *
 * 返回的是一模一样的对象（同一个接口、同样的行为），只是每次 `handle` 时
 * 多抄一行进表。**任何现有代码换成它之后，行为一个字节都不变** ——
 * 这也是这一步敢先做的全部理由。
 */
export interface RpcIpcMain {
  handle(channel: string, fn: (event: any, ...args: any[]) => any): RpcIpcMain;
  handleOnce(channel: string, fn: (event: any, ...args: any[]) => any): RpcIpcMain;
  removeHandler(channel: string): RpcIpcMain;
  on(channel: string, fn: (...args: any[]) => void): RpcIpcMain;
  once(channel: string, fn: (...args: any[]) => void): RpcIpcMain;
}

/**
 * 签名必须写死成上面的接口，**不能返回 `any`**。
 *
 * 因为那 100 条 handler 长这样：`(_e, id: string) => ...` —— 它们靠 `handle`
 * 的参数类型来推 `_e`。返回 `any` 等于把上下文类型抹掉，tsc 会当场报 100 条
 * TS7006（`_e` 隐式 any），编译直接挂。这不是风格问题，是能不能编过的问题。
 */
export function wrapIpcMain(real: any): RpcIpcMain {
  if (!real || typeof real.handle !== 'function') {
    throw new Error(t('wrapIpcMain 拿到的东西不像 ipcMain —— 检查 electron 版本或 import'));
  }

  const wrapped: RpcIpcMain = {
    /** 登记 + 转发：这一条是整层的核心，其余都是照抄原样 */
    handle(channel: string, fn: RpcFn) {
      table.set(channel, fn);
      real.handle(channel, fn);
      return wrapped;
    },

    handleOnce(channel: string, fn: RpcFn) {
      table.set(channel, fn);
      real.handleOnce(channel, fn);
      return wrapped;
    },

    removeHandler(channel: string) {
      table.delete(channel);
      real.removeHandler(channel);
      return wrapped;
    },

    /**
     * 单向通道**只透传、不登记**：它们无一例外是窗口硬件的私事
     * （拖拽、撕窗、落点探测）。放进能力清单只会让人以为可以远程调。
     */
    on(channel: string, fn: RpcFn) {
      real.on(channel, fn);
      return wrapped;
    },

    once(channel: string, fn: (...args: any[]) => void) {
      real.once(channel, fn);
      return wrapped;
    },
  };

  // 剩下的方法一律照抄，不改行为 —— 用不到，但缺了会让替换变成"悄悄少了个功能"
  for (const name of ['off', 'addListener', 'removeListener', 'removeAllListeners', 'prependListener', 'prependOnceListener', 'emit', 'listenerCount', 'listeners', 'eventNames', 'setMaxListeners', 'getMaxListeners']) {
    const original = real[name];
    if (typeof original !== 'function') continue;
    (wrapped as any)[name] = (...args: any[]) => {
      const r = original.apply(real, args);
      // EventEmitter 那些链式方法返回 this，得还回包装后的对象
      return r === real ? wrapped : r;
    };
  }

  return wrapped;
}
