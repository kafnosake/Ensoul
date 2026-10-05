import type { DockNode, DockSplit, DockTarget, TabGroup, WorkspaceFull } from '../shared/types';
import { isSplit, isTabGroup } from '../shared/types';

/**
 * 停靠树的纯函数层。
 *
 * 所有操作都返回新树（结构共享），不碰窗口、不碰磁盘。
 * "拖到某处"在数据上只有两种结果：
 *   · mode = center        → 面板加进那个标签组
 *   · mode = 四边之一      → 在那个标签组旁边切出一个新的标签组，面板放进去
 */

let seq = 0;
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export const makeTabGroup = (id = newId('tabs'), panels: string[] = []): TabGroup => ({
  type: 'tabs',
  id,
  panels,
  active: panels[panels.length - 1] ?? null,
});

/** 按先序取出所有标签组 */
export function tabGroupsOf(node: DockNode): TabGroup[] {
  if (isTabGroup(node)) return [node];
  return [...tabGroupsOf(node.children[0]), ...tabGroupsOf(node.children[1])];
}

export function tabById(node: DockNode, tabId: string): TabGroup | null {
  return tabGroupsOf(node).find((t) => t.id === tabId) ?? null;
}

export function firstTabGroup(node: DockNode): TabGroup {
  return tabGroupsOf(node)[0];
}

/** 面板落在哪个标签组里 */
export function tabOfPanel(node: DockNode, panelId: string): TabGroup | null {
  return tabGroupsOf(node).find((t) => t.panels.includes(panelId)) ?? null;
}

function mapTabs(node: DockNode, fn: (t: TabGroup) => TabGroup): DockNode {
  if (isTabGroup(node)) return fn(node);
  return { ...node, children: [mapTabs(node.children[0], fn), mapTabs(node.children[1], fn)] };
}

/** 组的 active 要跟着面板的来去走 */
function withActive(t: TabGroup, panels: string[], prefer?: string): TabGroup {
  const active =
    prefer && panels.includes(prefer)
      ? prefer
      : t.active && panels.includes(t.active)
        ? t.active
        : (panels[panels.length - 1] ?? null);
  return { ...t, panels, active };
}

export function insertPanel(node: DockNode, tabId: string, panelId: string, index?: number): DockNode {
  return mapTabs(node, (t) => {
    if (t.id !== tabId) return t;
    const panels = t.panels.filter((p) => p !== panelId);
    const at = index === undefined ? panels.length : Math.max(0, Math.min(index, panels.length));
    panels.splice(at, 0, panelId);
    return withActive(t, panels, panelId);
  });
}

export function removePanel(node: DockNode, panelId: string): DockNode {
  return mapTabs(node, (t) => (t.panels.includes(panelId) ? withActive(t, t.panels.filter((p) => p !== panelId)) : t));
}

/** 同组内往后挪时，索引要补掉自己占的那一格 */
export function movePanel(node: DockNode, panelId: string, tabId: string, index?: number): DockNode {
  let at = index;
  if (at !== undefined) {
    const from = tabOfPanel(node, panelId);
    const self = from?.panels.indexOf(panelId) ?? -1;
    if (from?.id === tabId && self >= 0 && self < at) at -= 1;
  }
  return insertPanel(removePanel(node, panelId), tabId, panelId, at);
}

/** 在某个标签组旁边切出一块新区域（新区域的标签组 id 由调用方给，便于随后放入面板） */
export function splitTabGroup(
  node: DockNode,
  tabId: string,
  side: Exclude<DockTarget['mode'], 'center' | 'tabs'>,
  newTabId = newId('tabs'),
): DockNode {
  const direction: DockSplit['direction'] = side === 'left' || side === 'right' ? 'row' : 'column';
  const before = side === 'left' || side === 'top';
  const walk = (n: DockNode): DockNode => {
    if (isTabGroup(n)) {
      if (n.id !== tabId) return n;
      const fresh = makeTabGroup(newTabId);
      return {
        type: 'split',
        id: newId('split'),
        direction,
        ratio: 0.5,
        children: before ? [fresh, n] : [n, fresh],
      };
    }
    return { ...n, children: [walk(n.children[0]), walk(n.children[1])] };
  };
  return walk(node);
}

/**
 * 在**整棵树的最外层**并一块 —— 这就是「侧窗」。
 *
 * 和 insertNodeBeside 的区别：那个是「在某一块旁边」，树里已经分了几块
 * 就在那一块上再切一刀；这个不管里面长什么样，直接在根上把整扇窗口一分为二。
 * ratio 0.5 = 和窗口里原有的面板**均等**分隔 —— 这正是侧窗要的形状。
 */
export function insertRootBeside(
  node: DockNode,
  side: Exclude<DockTarget['mode'], 'center' | 'tabs'>,
  moving: DockNode,
): DockNode {
  const direction: DockSplit['direction'] = side === 'left' || side === 'right' ? 'row' : 'column';
  const before = side === 'left' || side === 'top';
  return {
    type: 'split',
    id: newId('split'),
    direction,
    ratio: 0.5,
    children: before ? [moving, node] : [node, moving],
  };
}

export function setRatio(node: DockNode, splitId: string, ratio: number): DockNode {
  if (isTabGroup(node)) return node;
  if (node.id === splitId) return { ...node, ratio: Math.max(0.08, Math.min(0.92, ratio)) };
  return { ...node, children: [setRatio(node.children[0], splitId, ratio), setRatio(node.children[1], splitId, ratio)] };
}

/** 关掉一个标签组：父切分折叠成兄弟。根组不消失，只清空 */
export function closeTabGroup(node: DockNode, tabId: string): DockNode {
  if (isTabGroup(node)) return node.id === tabId ? makeTabGroup(node.id) : node;
  const [a, b] = node.children;
  if (isTabGroup(a) && a.id === tabId) return b;
  if (isTabGroup(b) && b.id === tabId) return a;
  return { ...node, children: [closeTabGroup(a, tabId), closeTabGroup(b, tabId)] };
}

/**
 * 收掉空标签组：面板被移走 / 关掉之后，空壳不该留在屏幕上占地方。
 * 整棵树都空时保留一个空组，主窗口才不至于没有落脚点。
 */
export function pruneEmptyTabs(node: DockNode): DockNode {
  const walk = (n: DockNode): { node: DockNode; empty: boolean } => {
    if (isTabGroup(n)) return { node: n, empty: n.panels.length === 0 };
    const a = walk(n.children[0]);
    const b = walk(n.children[1]);
    if (a.empty && b.empty) return { node: a.node, empty: true };
    if (a.empty) return { node: b.node, empty: false };
    if (b.empty) return { node: a.node, empty: false };
    return { node: { ...n, children: [a.node, b.node] }, empty: false };
  };
  return walk(node).node;
}

// ---------------------------------------------------------------- 跨宿主（主窗口 ↔ 浮窗）

export function findPanel(ws: WorkspaceFull, panelId: string): { where: 'main'; tab: TabGroup } | { where: 'floating'; windowId: string; tab: TabGroup } | null {
  const inMain = tabOfPanel(ws.layout, panelId);
  if (inMain) return { where: 'main', tab: inMain };
  for (const win of ws.floating) {
    const tab = tabOfPanel(win.root, panelId);
    if (tab) return { where: 'floating', windowId: win.id, tab };
  }
  return null;
}

/** 把一个面板摘出它所在的树 */
export function removeEverywhere(ws: WorkspaceFull, panelId: string): WorkspaceFull {
  return {
    ...ws,
    layout: removePanel(ws.layout, panelId),
    floating: ws.floating.map((w) => ({ ...w, root: removePanel(w.root, panelId) })),
  };
}

/** 就地把面板放进某个宿主的某个标签组（tabs/center 都是并入，四边是切分） */
export function dockPanel(ws: WorkspaceFull, panelId: string, target: DockTarget, index?: number): WorkspaceFull {
  const root = target.where === 'main' ? ws.layout : (ws.floating.find((w) => w.id === target.windowId)?.root ?? null);
  if (!root) return ws;

  let next: DockNode;
  if (target.mode === 'center' || target.mode === 'tabs') {
    next = insertPanel(root, target.tabId, panelId, index);
  } else if (target.root) {
    // 根上的侧窗：不看树里已经分了几块，直接在最外层一分为二
    const freshId = newId('tabs');
    next = insertPanel(insertRootBeside(root, target.mode, makeTabGroup(freshId)), freshId, panelId);
  } else {
    const freshId = newId('tabs');
    const split = splitTabGroup(root, target.tabId, target.mode, freshId);
    next = insertPanel(split, freshId, panelId);
  }

  if (target.where === 'main') return { ...ws, layout: next };
  return { ...ws, floating: ws.floating.map((w) => (w.id === target.windowId ? { ...w, root: next } : w)) };
}

/** 面板表里所有面板的去处，用于找出孤儿（不在任何树里） */
export function placedPanelIds(ws: WorkspaceFull): Set<string> {
  const ids = new Set<string>();
  const collect = (n: DockNode) => {
    tabGroupsOf(n).forEach((t) => t.panels.forEach((p) => ids.add(p)));
  };
  collect(ws.layout);
  ws.floating.forEach((w) => collect(w.root));
  return ids;
}

/** 清掉孤儿面板引用（面板表里有、但没有任何树引用它） */
export function orphanPanelIds(ws: WorkspaceFull): string[] {
  const placed = placedPanelIds(ws);
  return Object.keys(ws.panels).filter((id) => !placed.has(id));
}

/**
 * 把一个整节点拍平成**一个标签组**：里面所有面板按先序排成一组标签。
 *
 * 浮窗用它：浮窗是"临时拎出来看的一块"，里面再切成左右两栏就成了主窗口的缩小版，
 * 又挤又没意义。所以浮窗里只有一层标签 —— 想并进来的都并成标签。
 */
export function flattenTabs(node: DockNode): DockNode {
  if (isTabGroup(node)) return node;
  const groups = tabGroupsOf(node);
  const panels = groups.flatMap((t) => t.panels);
  const first = groups[0];
  return withActive(first, panels, first.active ?? undefined);
}

/** 把一个整节点从树里摘掉，返回剩下的树（摘空了返回 null） */export function removeNode(node: DockNode, nodeId: string): DockNode | null {
  if (isTabGroup(node)) return node.id === nodeId ? null : node;
  if (node.id === nodeId) return null;
  const a = removeNode(node.children[0], nodeId);
  const b = removeNode(node.children[1], nodeId);
  if (!a && !b) return null;
  if (!a) return b as DockNode;
  if (!b) return a as DockNode;
  return { ...node, children: [a, b] };
}

/** 把一个整节点放到某个标签组旁边（四边落点）—— 拖动整个标签组就是靠它 */
export function insertNodeBeside(
  node: DockNode,
  tabId: string,
  side: Exclude<DockTarget['mode'], 'center' | 'tabs'>,
  moving: DockNode,
): DockNode {
  const direction: DockSplit['direction'] = side === 'left' || side === 'right' ? 'row' : 'column';
  const before = side === 'left' || side === 'top';
  const walk = (n: DockNode): DockNode => {
    if (isTabGroup(n)) {
      if (n.id !== tabId) return n;
      return {
        type: 'split',
        id: newId('split'),
        direction,
        ratio: 0.5,
        children: before ? [moving, n] : [n, moving],
      };
    }
    return { ...n, children: [walk(n.children[0]), walk(n.children[1])] };
  };
  return walk(node);
}
