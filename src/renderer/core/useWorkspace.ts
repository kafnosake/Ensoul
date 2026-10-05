import React from 'react';
import type { Workspace } from '../../shared/types';
import { api } from './api';

/**
 * 唯一真源在主进程：这里只是订阅它。
 * 任何改动都不用本地推演，改完等广播回来即可 —— 多窗口才不会各说各话。
 *
 * 另外接上 `chat:message`：主进程每往对话里塞一条（用户那句、agent 的每一步工具、
 * 最后那条回复）就立即并进来。**以前没人接这个频道**，于是整轮跑完之前界面上
 * 只有流式正文 —— 用户看不到自己刚发的话，也看不到 agent 读写了哪些文件，
 * 只能盯着一段越来越长的文字猜它到底在干什么。
 *
 * ── 为什么是模块级那一份，而不是每个组件各持一份 ─────────────────────────
 *
 * 以前每调一次这个 hook，就**各自**开一份 state + 各自发一次 `workspace.get()`。
 * 于是切一次标签（DockTree 按活动面板 id 换 key，组件是卸载重挂的）新面板就要
 * 重新把整份工作区状态要一遍；状态到达之前 `ws` 是 null，模型那一行就先画成
 * "没配模型"，回来再重画一遍 —— 用户看到的就是**每次切面板都闪一下**。
 *
 * 可这份数据本来就不是某个面板的私产（MainShell 早就拿在手上），而且同一时刻
 * 有好几个消费点（Composer / ChatDock / FileTree / 两个壳）。所以收敛成模块级
 * 一份：**监听只接一次，状态只存一份，谁调用都只是订阅**。
 * 缓存命中的那一刻，`getSnapshot()` 同步就返回它 —— 新挂载的组件首帧拿到的
 * 就是真值，那一帧空档从根上没有。
 *
 * 单向依赖：这里不写回主进程。所有改动都走 IPC，等广播回来。
 */

/** 整个渲染进程共用的那一份（主窗口与浮窗是两个渲染进程，各自一份，各拉各的） */
let cache: Workspace | null = null;
/** 订阅者只做一件事：被叫醒后重读快照 */
const subs = new Set<() => void>();
/** 两条推送只接一次 —— 与订阅者有几个人无关 */
let wired = false;

/** 挨个叫醒。**先拷一份**：回调里可能又增删订阅，别在迭代中改这个集合 */
function emit() {
  for (const cb of [...subs]) cb();
}

function wire() {
  if (wired) return;
  wired = true;

  /*
   * 首拉：光等广播太被动 —— 有些改动不一定当场广播。
   * 注意这一次是**异步**的，所以第一帧仍可能是 null（应用刚起来那一瞬），
   * 但那之后 cache 就一直在了：后面任何面板重新挂载都是同步命中。
   */
  void api.workspace.get().then((s) => {
    cache = mergeIncoming(s);
    emit();
  });

  /**
   * 正常路径：主进程改完就推一份过来（**骨架 + 摘要**，正文不在里面 —— 见 store.publicState）。
   *
   * 关键的一步：**已经补过正文的面板，别被这一份摘要冲掉**。
   * 不保的话，补好正文的下一刻来一次广播，panel.chat 又变回 undefined ——
   * 那块面板一眨眼退成空对话，ChatDock 只好再拉一次几 MB。广播本来就频繁
   * （每次保存 / 每次点布局都会来一次），那就成了"每几秒重下一遍全文"。
   * 保了之后：正文留在 cache 里，广播只更新骨架 / 状态 / 摘要那几个字段。
   */
  api.workspace.onState((s) => {
    cache = mergeIncoming(s);
    emit();
  });

  /*
   * 对话里的增量：一条一条并进来，别等整轮跑完。
   * 合并出的仍是**新对象**（React 认引用），所以订阅者会重渲染 —— 这是要的效果。
   *
   * 注意 `chat` 可能**不在**这份面板里：广播出去的面板是摘要版（只有骨架 + summary，
   * 见 store.publicState），正文要等 ChatDock 自己按需拉。那种情况**一个字都不碰** ——
   * 硬往摘要上拼一条，会得到一份"半截对话"，ChatDock 拿去渲染就只剩最新那一条。
   * 反正那一轮跑完广播回来时，summary 会带上最新内容，摘要这条路自己会更新。
   */
  api.chat.onMessage(({ panelId, message }) => {
    const s = cache;
    const p = s?.panels?.[panelId];
    if (!s || !p) return;
    if (!isRealBody(p)) return; // 摘要版（正文没拉下来 / 还没 hydrate）—— 不动它
    // 广播回来的完整状态里已经有它了，别叠成两条
    if (p.chat.some((m) => m.id === message.id)) return;
    cache = { ...s, panels: { ...s.panels, [panelId]: { ...p, chat: [...p.chat, message] } } };
    emit();
  });
}

/** 订阅入口。第一个订阅者出现时才接线；都走了也不拆 —— 壳是常驻的，拆了只会来回抖 */
function subscribe(cb: () => void): () => void {
  wire();
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

/** 快照必须稳定：cache 只在赋值时换引用，否则 useSyncExternalStore 会转不出来 */
const snapshot = () => cache;

export function useWorkspace(): Workspace | null {
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * 哪些面板的正文已经被我们补全过（模块级，只活在这个渲染进程里）。
 *
 * 为什么要记这一笔：广播回来的是**摘要版**面板（正文十几 MB，每广播一次就拖着它走，
 * 那正是卡顿的根）。主进程认不出"这份摘要里那点占位 chat 是渲染层自己填的"，
 * 所以只能由这边记名 —— 有名字的，广播回来时把正文保下来（见 mergeIncoming）。
 */
const hydratedIds = new Set<string>();

/**
 * 同一块面板的补正文**只发一次请求**。
 *
 * ChatDock 里有两处（可见那道门 + 切到前台那个 observer）会同时喊 hydratePanel，
 * 没有这层去重就是同一份几 MB 的正文拖两遍 —— 对话回不来那段空白就是这么被拉长的。
 */
const inflight = new Map<string, Promise<Workspace | null>>();

/**
 * 这份面板里的 `chat` 是不是**真正文**（而不是广播里那个空占位）。
 * 判据取 summary 的条数：有摘要 = 这是广播那份；条数对不上 = 还没补。
 */
function isRealBody(p: any): boolean {
  if (!p || !Array.isArray(p.chat)) return false;
  const n = p.summary?.count;
  return typeof n !== "number" || p.chat.length >= n;
}

/**
 * 把主进程推来的这份状态并进 cache —— **已经补过正文的面板保住正文**。
 *
 * 不保的话，补好正文的下一刻来一次广播（每次保存、每次点布局都会来），
 * panel.chat 又变回空数组，那块面板一眨眼退成空对话、ChatDock 只好再拉几 MB。
 * 广播本来就频繁，那就成了"每几秒重下一遍全文"。
 *
 * 字段来源分两处，别搞反：**骨架 / 状态 / 摘要以广播那份为准**（主进程才是真源），
 * **正文四个键用本地补好的那份**（广播里根本没有）。
 */
const BODY_KEYS = ["chat", "compact", "revisions", "redoRevisions"] as const;

function mergeIncoming(s: Workspace): Workspace {
  const prev = cache;
  if (!prev || hydratedIds.size === 0) return s;
  let touched = false;
  const panels: Record<string, any> = { ...s.panels };
  for (const id of hydratedIds) {
    const older = prev.panels?.[id];
    const fresh = s.panels?.[id];
    if (!older || !fresh || !isRealBody(older)) continue;
    const merged: Record<string, any> = { ...older, ...fresh };
    for (const k of BODY_KEYS) merged[k] = (older as any)[k];
    panels[id] = merged;
    touched = true;
  }
  return touched ? { ...s, panels } : s;
}

/**
 * 把一块面板的**正文补进 cache**（对话 / 压缩存档 / 修订）。
 *
 * 广播里发的是摘要版（正文十几 MB，每广播一次就拖一遍 —— 那正是卡顿的根），
 * 所以真正要画对话的那块面板（ChatDock）要画的时候拉一次 `panel:body`，
 * 拉回来用这个函数并回 cache —— 之后所有消费点（ChatDock / 侧栏 / 别的）看到的
 * 就是"和以前一模一样的完整面板"，谁也不用手上多留一份。
 *
 * 补过就记名（hydratedIds），广播回来时靠它保住正文，不必反复拉。
 */
export async function hydratePanel(panelId: string): Promise<Workspace | null> {
  if (hydratedIds.has(panelId) && isRealBody(cache?.panels?.[panelId])) return cache;
  const busy = inflight.get(panelId);
  if (busy) return busy;
  const run = (async () => {
    try {
      const full = await api.panel.body(panelId);
      if (!full) return cache;
      // 期间 cache 可能被整份换掉了（广播先到）—— 以**最新**那份为底，只把正文并进去
      const base = cache;
      if (!base) return cache;
      const prev = base.panels?.[panelId] ?? {};
      cache = { ...base, panels: { ...base.panels, [panelId]: { ...prev, ...full } } };
      // 记名要落在**并进去之后**：早一步记名而正文没进 cache，这块面板就会被
      // 当成「补过了」，再也没人来要它 —— 那正是刷新后对话一直空着的一种走法。
      hydratedIds.add(panelId);
      emit();
      return cache;
    } catch {
      return cache;
    }
  })().finally(() => inflight.delete(panelId));
  inflight.set(panelId, run);
  return run;
}

/**
 * 忘掉"这块面板补过正文"的记名 —— 对话被**整体换掉**（清空 / 压缩）时由 ChatDock 调，
 * 让它重新拉一次。平时不用动它。
 */
export function forgetHydrated(panelId: string): void {
  hydratedIds.delete(panelId);
}
