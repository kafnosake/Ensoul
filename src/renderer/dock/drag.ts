import { floatRatio, type DockTarget, type DropMode, type Rect } from '../../shared/types';
import { api } from '../core/api';
import { t } from '../core/i18n';

/**
 * 拖拽的落点判定 —— CSP 那套手感的关键就在这里。
 *
 * 拖的时候每动一下都做一次命中：落在哪个标签组、落在它的哪个方位。
 *   · 中央  → 并入那个标签组（叠成标签）
 *   · 四边  → 在那旁边**自然分成新的一块**（没有"切分"这个命令，分块是拖出来的结果）
 *   · 标签栏外 → **当场撕下来**，拖动途中就有一块真窗口跟着光标走；掠过别的标签组就并进去
 *   · 窗口外   → 同上（这一路本来就这么办的）
 *
 * 可以拖的粒度有两种：单个面板，或者**整个标签组**。
 */

/** 这棵树属于谁 */
export type Host = { kind: 'main' } | { kind: 'floating'; windowId: string };

export interface DockHit {
  tabId: string;
  mode: DropMode;
  /** 插在第几个位置（并进标签组时按它排） */
  index?: number;
  /** 命中标签组的矩形（视口坐标），画预览用 */
  rect: Rect;
}

/**
 * 落在**顶上那条收纳区**上：松手就是把这扇窗里的面板收起来。
 *
 * 它不算"落在某一块面板上"，所以没有 tabId / mode —— 单独立一类，不硬塞进 DockHit：
 * 塞进去就得把 tabId 改成可选，所有读 `hit.tabId` 的地方都跟着变成"可能没有"。
 */
export interface BarHit {
  bar: true;
  /** 插在收纳区第几格 */
  barIndex?: number;
  /** 收纳区那一条的矩形（视口坐标），画提示框用 */
  rect: Rect;
}

/** 落点探测的答案：要么落在某块面板上，要么落在顶上那条收纳区上 */
export type ProbeHit = DockHit | BarHit;

export const isBarHit = (h: ProbeHit | null | undefined): h is BarHit => Boolean(h && 'bar' in h);

/**
 * 这一拖落在收纳区上没有 —— 三条来源，命中哪条算哪条。
 *
 *   · d.bar         本窗口自己判的（拖着面板从标签栏挪到顶栏，还没撕开那一段）；
 *   · d.hit         被问的那扇窗答的（面板已经撕成浮窗，落点由光标底下那扇窗给）；
 *   · d.foreign.hit 指针在**别的窗口**里时问到的（从浮窗里拖到主窗口的顶栏上）。
 *
 * 第三条最容易漏：那种情况本窗口的 DOM 根本看不见主窗口的顶栏，手快一点、
 * 还没撕开就松手，就会走成"拿出来立户" —— 明明压在收纳区上。
 */
export function barHitOf(d: Pick<DragState, 'bar' | 'hit' | 'foreign'>): BarHit | null {
  if (d.bar) return d.bar;
  if (isBarHit(d.hit)) return d.hit;
  return isBarHit(d.foreign?.hit) ? d.foreign!.hit : null;
}

/**
 * 落点里"落在某一块面板上"的那一半 —— 落在收纳区上时给 null。
 *
 * 收纳区不是一块面板：它没有 tabId、也没有方位。所有拿 tabId / mode / index 说话的地方
 * 都得先过这一道，不然一拖到收纳区上就会读到 undefined（并组、让位、排序全乱）。
 */
export const dockHitOf = (h: ProbeHit | null | undefined): DockHit | null =>
  h && !isBarHit(h) ? h : null;

export type DragSource =
  | { kind: 'panel'; panelId: string; tabId: string }
  | { kind: 'tabs'; tabId: string }
  /** 收纳区入口指向的面板：没开就在松手的地方打开；已经开着 = 把它挪过去（不开第二份） */
  | { kind: 'component'; componentId: string; name: string }
  /**
   * 监视台成员列表里的一行（只限带面板的）：语义同收纳区入口 ——
   * 没开就在松手的地方打开（closed/ 先捞回来），开着就直接挪过去，绝不开第二份。
   * state 三态：visible = 布局里看得见；hidden = 后台挂着（要先 activate 出来）；closed = 收在 closed/ 里。
   * accent / avatar 是头像那点信息 —— 跟手影子照着它们画，见 MainShell 的 DragOverlay。
   */
  | { kind: 'monitor'; panelId: string; name: string; state: 'visible' | 'hidden' | 'closed'; accent?: string; avatar?: string };

export interface DragState {
  source: DragSource;
  from: Host;
  x: number;
  y: number;
  /** 落在某一块面板上（并组 / 分栏 / 挂件）。落在收纳区上时这里是 null */
  hit: DockHit | null;
  /**
   * 落在**顶上那条收纳区**上 —— 松手就是把它收起来（对话、状态一起收走）。
   *
   * 和 hit 并列，不塞进 hit 里：收纳区不是一块面板，没有 tabId、也没有方位。
   * 硬塞进去就得把 tabId 改成可选，所有拿它说话的地方（并组、让位、排序）
   * 都要跟着变成"可能没有" —— 一处漏判就是一次乱插位。
   */
  bar?: BarHit | null;
  outside: boolean;
  /**
   * 已经离开**原来那条标签栏**（往下拖进工作区就算）。
   * 浏览器那种手感靠的就是它：松手时它自己变成一块悬浮窗，而不是"放回原处"。
   */
  outOfBar?: boolean;
  /**
   * 指针已经跑出本窗口时，问到的"底下是谁、它说落在哪"。
   *
   * 这一步是**异步**的（要问主进程、再问光标底下那扇窗），所以它和 hit 分开存：
   * 一到手就得让提示语跟上 —— 拖着一块浮窗压在主窗口的收纳区上时，
   * 说"变成一块浮窗"就是在撒谎（那儿松手是收进收纳区）。
   */
  foreign?: { target: string; hit: ProbeHit | null; own?: boolean } | null;
}

/** 把落点翻译成主进程认的目标 */
export function targetOf(host: Host, hit: DockHit): DockTarget {
  return host.kind === 'main'
    ? { where: 'main', tabId: hit.tabId, mode: hit.mode }
    : { where: 'floating', windowId: host.windowId, tabId: hit.tabId, mode: hit.mode };
}

/**
 * 指针落在哪个标签组、哪个方位。
 *
 * 只有**贴到那块的边上**才算落点。带宽取 40px 与该边长五分之一的较小值 ——
 * 按比例给不行：宽屏上一条几十像素的带子会摊成两三百像素，"中间"就没有了。
 * 正中什么都不做：落点表里没有"缩成小窗贴在这儿"这一类。
 */
export function hitDock(x: number, y: number, edgePx = 40, allowCenter = false): DockHit | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const group = el?.closest('[data-tab-id]') as HTMLElement | null;
  // 落在两块面板之间那道缝上：缝不属于任何一块，按它在缝的哪一半归属到相邻那块
  if (!group) return gutterSide(el, x, y);
  const tabId = group.dataset.tabId;
  if (!tabId) return null;

  const r = group.getBoundingClientRect();
  const rect: Rect = { x: r.left, y: r.top, width: r.width, height: r.height };
  const index = insertIndexAt(el, group, x);

  // 顶上那条标签栏：落到这儿就是"并进这组标签"—— 一个明确、不用瞄准的动作
  if (el?.closest('.tabstrip')) return { tabId, mode: 'tabs', index, rect };

  // 方位一律相对**内容区**算：标签栏那一条不该被算进"上下"的判定里
  const body = (group.querySelector('.tabs-body') as HTMLElement | null)?.getBoundingClientRect() ?? r;
  const dLeft = x - body.left;
  const dRight = body.right - x;
  const dTop = y - body.top;
  const dBottom = body.bottom - y;
  const near = Math.min(dLeft, dRight, dTop, dBottom);
  const band = Math.min(edgePx, Math.min(body.width, body.height) / 5);
  if (near > band) {
    /*
     * 离四条边都够远。这里**只有一处**算落点：正中那块小框（嵌成挂件）。
     *
     * 以前是"离四边够远就算中央" —— 那面积占了整块的大部分，于是"面板内随便哪儿
     * 松手都嵌入"，而显示的框只有中间一小块：判的和画的完全不是一回事，
     * 看着像框没对准，其实是判定压根不是围着这个框做的。
     *
     * 现在两者共用 centerRect：**框在哪儿，落点就在哪儿**。框外一律没有落点，
     * 意思是"就停在这儿"（浮窗留在原位），不去猜一个归宿。
     *
     * 拖**面板**时（allowCenter = false）仍然一处落点都不给：面板丢在主体上的本意
     * 是"拿出来立户"，给它落点就等于替它决定归宿。
     */
    if (!allowCenter) return null;
    const box = centerRect(rect);
    const inside = x >= box.left && x <= box.left + box.width && y >= box.top && y <= box.top + box.height;
    return inside ? { tabId, mode: 'center', rect } : null;
  }

  const mode: DropMode =
    near === dLeft ? 'left' : near === dRight ? 'right' : near === dTop ? 'top' : 'bottom';

  return { tabId, mode, index, rect };
}

/**
 * 光标落在**两块面板之间那道缝**上时算哪一边。
 *
 * 缝本身不属于任何一块，但贴着缝就是明确要分一块的意思。按光标在缝的哪一半，
 * 算成相邻那一块的对应边（缝左边那块 → 贴它的右边）—— 和直接拖到那条边上
 * 得到的是同一个落点，缝上缝下不会半路"没有落点"。
 */
function gutterSide(el: HTMLElement | null, x: number, y: number): DockHit | null {
  const gutter = el?.closest('.dock-gutter') as HTMLElement | null;
  if (!gutter) return null;
  const gr = gutter.getBoundingClientRect();
  const vertical = gutter.classList.contains('gutter-row');
  const before = vertical ? x < gr.left + gr.width / 2 : y < gr.top + gr.height / 2;
  const cell = (before ? gutter.previousElementSibling : gutter.nextElementSibling) as HTMLElement | null;
  const group = cell?.querySelector('[data-tab-id]') as HTMLElement | null;
  const tabId = group?.dataset.tabId;
  if (!group || !tabId) return null;
  const r = group.getBoundingClientRect();
  return {
    tabId,
    mode: vertical ? (before ? 'right' : 'left') : before ? 'bottom' : 'top',
    rect: { x: r.left, y: r.top, width: r.width, height: r.height },
  };
}

/** 并进某组标签时插在第几个位置 */
function insertIndexAt(_el: HTMLElement | null, group: HTMLElement, x: number): number | undefined {
  const tabs = Array.from(group.querySelectorAll<HTMLElement>('.tab'));
  if (!tabs.length) return undefined;
  // 同组拖拽排序：排除正在被拖动的 tab，使左右中线判定完全对称且 slot 不抖动
  const draggingTab = tabs.find((t) => t.classList.contains('is-dragging'));
  const candidateTabs = draggingTab ? tabs.filter((t) => t !== draggingTab) : tabs;
  let i = 0;
  for (const t of candidateTabs) {
    const r = t.getBoundingClientRect();
    if (x > r.left + r.width / 2) i++;
  }
  return i;
}

/** 落在收纳区时，计算插在收纳区第几个位置 */
export function insertBarIndexAt(barEl: HTMLElement, x: number, draggingId?: string): number {
  const items = Array.from(barEl.querySelectorAll<HTMLElement>('.cmpfav-item'));
  if (!items.length) return 0;
  const filtered = draggingId
    ? items.filter((el) => el.getAttribute('data-cmp-id') !== draggingId && !el.classList.contains('is-dragging'))
    : items;
  let i = 0;
  for (const it of filtered) {
    const r = it.getBoundingClientRect();
    if (x > r.left + r.width / 2) i++;
  }
  return i;
}

/**
 * 落点预览在视口里的矩形。
 * 预览是**全局一层**（fixed 定位），不在各个标签组里各画一份 ——
 * 跨组移动时它才能连续地滑过去，而不是这边消失那边冒出来。
 */
export function previewRect(hit: DockHit): { left: number; top: number; width: number; height: number } {
  const pad = 6;
  const inner = {
    left: hit.rect.x + pad,
    top: hit.rect.y + pad,
    width: Math.max(0, hit.rect.width - pad * 2),
    height: Math.max(0, hit.rect.height - pad * 2),
  };
  const f = 0.46;
  switch (hit.mode) {
    case 'center':
      // 和 hitDock 判定用的是同一块矩形（centerRect）—— 画的和判的必须是同一个
      return centerRect(hit.rect);
    case 'left':
      return { left: inner.left, top: inner.top, width: inner.width * f, height: inner.height };
    case 'right':
      return { left: inner.left + inner.width * (1 - f), top: inner.top, width: inner.width * f, height: inner.height };
    case 'top':
      return { left: inner.left, top: inner.top, width: inner.width, height: inner.height * f };
    case 'bottom':
      return { left: inner.left, top: inner.top + inner.height * (1 - f), width: inner.width, height: inner.height * f };
    case 'tabs':
      // 标签栏那一条
      return { left: inner.left, top: inner.top, width: inner.width, height: Math.min(34, inner.height) };
    default:
      return inner;
  }
}

/**
 * 「嵌成挂件」那块落点矩形 —— **判定和预览共用它**。
 *
 * 以前这两件事各写各的：判定是"离四边够远"（面积很大），预览画的是中间一小块。
 * 于是面板内随便哪儿松手都算嵌入，而看到的框只在中间，像是框没对准 ——
 * 其实是判定根本没围着这个框做。现在只留这一处定义，画的和判的必然一致。
 */
export function centerRect(rect: { x: number; y: number; width: number; height: number }) {
  const w = Math.min(rect.width * 0.62, 460);
  const h = Math.min(rect.height * 0.58, 340);
  return {
    left: rect.x + (rect.width - w) / 2,
    top: rect.y + (rect.height - h) / 2,
    width: w,
    height: h,
  };
}

/**
 * 被问「光标底下松手会落到哪」时用的三个入口 —— 拖**一整块浮窗**时主进程来问。
 *
 * 拖浮窗是主进程直接 setPosition 移真窗口，渲染层手上既没有落点也没有命中信息；
 * 所以主进程只把光标点（换算成本窗口坐标）发过来问一句，由**光标底下这扇窗**用 DOM
 * 当场算、顺手画上、再把答案回给主进程。
 *
 * 因为和面板拖拽共用 hitDock / previewRect，画出来的那个框和松手真正发生的事
 * 必然是同一个判定，不存在两套逻辑各说各的。
 */
export const probeAt = (x: number, y: number, whole = false): ProbeHit | null => {
  // 光标贴着边沿、甚至探出去一点，也算"贴着这条边"：夹回窗口里再按内容区算边缘带
  const cx = Math.min(Math.max(x, 1), Math.max(1, window.innerWidth - 2));
  const cy = Math.min(Math.max(y, 1), Math.max(1, window.innerHeight - 2));
  /*
   * 顶上那条收纳区排在最前：它长在菜单栏里，底下没有任何标签组，
   * 所以"先问它"不会抢走任何一块面板的落点，只会把原来答不出来的那块地方补上。
   */
  const bar = barHitAt(cx, cy);
  if (bar) return bar;
  // whole = 被问的是"一整块浮窗落哪"：这种才认正中的「嵌成挂件」
  return hitDock(cx, cy, 40, whole);
};

/**
 * 光标是不是落在**顶上那条收纳区**上 —— 全软件就这一处判定。
 *
 * 这条路以前是不通的：面板一离开标签栏就当场撕成一块浮窗，之后整场拖动都由
 * 光标底下那扇窗答题，而它只答得出标签栏和四条边 —— 收纳区就在它头顶上，
 * 却谁也答不出来。于是"变成浮窗之后就再也收不进去了"，只能靠手快在撕开之前松手。
 *
 * 量的是**顶栏中间那一段**（见下面），不是入口本身那点宽度：
 * 拖着一块浮窗从别处过来时，那一段才是个瞄得中的目标。
 */
export function barHitAt(x: number, y: number, draggingComponentId?: string): BarHit | null {
  /*
   * 量的是**顶栏中间整段**（.cmpfav-slot），不是入口那个小方块。
   *
   * 里面那个 .cmpfav 只在**本窗口自己开始拖**时才撑满（is-active），别的时候只有
   * 内容那么宽 —— 从别处拖过来时它可能还没有一个图标宽，那是"得手快才拖得进去"的另一半。
   * 而且从别处拖过来时本窗口根本不进入拖拽状态，它永远撑不满。整条本来也空着，
   * 拿它当落点，才有个瞄得中的目标。
   *
   * 上下一并取**顶栏那一条的高度**（slot 是撑满顶栏的，量它自己就够），
   * 再各放宽 3px —— 它本来只有 30px 上下，贴着边拖的人不该被判成"没落着"。
   * 顶栏别处不许算进来：那是窗口拖拽区，多给几像素就等于把"挪窗口"吞掉。
   */
  const slot = document.querySelector<HTMLElement>('.cmpfav-slot');
  if (!slot) return null;
  const r = slot.getBoundingClientRect();
  if (x < r.left || x > r.right || y < r.top - 3 || y > r.bottom + 3) return null;
  /*
   * 排第几格要问**里面那个 .cmpfav**（barRef），不能问外面这一段：
   * 那一段里还塞着一个离屏测量容器，里面的条目跟屏幕上摆着的一一对应，
   * 拿它数出来的位置会整段偏掉。
   */
  const items = slot.querySelector<HTMLElement>('.cmpfav') ?? slot;
  return {
    bar: true,
    barIndex: insertBarIndexAt(items, x, draggingComponentId),
    rect: { x: r.left, y: r.top, width: r.width, height: r.height },
  };
}

export const probeRect = (hit: ProbeHit): { left: number; top: number; width: number; height: number } =>
  isBarHit(hit)
    ? { left: hit.rect.x, top: hit.rect.y, width: hit.rect.width, height: hit.rect.height }
    : previewRect(hit);

/**
 * 落点说的是**整块窗口**的归宿，所以措辞和拖面板那套不一样：
 * 正中不是"便签"，是"挂到这块上"的小窗。
 */
export function probeLabel(hit: ProbeHit): string {
  if (isBarHit(hit)) return t('收进收纳区');
  if (hit.mode === 'tabs') return t('并入这组标签');
  if (hit.mode === 'center') return t('嵌成挂件 · 浮在这块上');
  return t('侧置 · 并排');
}

/**
 * 「光标底下是谁、它说落在哪」—— 拖到**别的窗口**上时靠它（限流 70ms）。
 *
 * 本窗口的 DOM 看不见别的窗口里有什么，所以只能问主进程；主进程再转问
 * 光标底下那扇窗（那边用 probeAt 答）。上一问没回来之前不重复发问 ——
 * 拖动中每帧都发一次会把 IPC 塞满。被限流时返回 null，调用方当"这次没问到"。
 */
/*
 * 限流状态放在**模块级**，不在函数里 —— 这是"卡死"最要紧的一处。
 *
 * 这里原来每次调用都新建一份 last/busy（都是初始值），而调用方是每帧调一次，
 * 于是限流等于没有：光标一离开窗口，就是每秒几十条 probeCursor 出去，
 * 主进程再一条条转问光标底下那扇窗，而那扇窗往往就是主窗口自己 ——
 * 请求堆起来、界面就卡在那儿不动了。
 */
let askLast = 0;
let askBusy = false;

export function askForeignThrottled(gap = 120) {
  const now = Date.now();
  if (askBusy || now - askLast < gap) return null;
  askLast = now;
  askBusy = true;
  return api.window
    .probeCursor()
    .then((r) => (r && r.target ? { target: r.target, hit: r.hit, own: r.own } : null))
    .catch(() => null)
    .finally(() => {
      askBusy = false;
    });
}

const groupEl = (tabId?: string): HTMLElement | null =>
  tabId ? document.querySelector<HTMLElement>(`[data-tab-id="${tabId}"]`) : null;

/**
 * 拖出原来那条标签栏了没有。
 *
 * 它只回答"指针还在不在出发那条标签栏里"，不直接决定任何事 ——
 * 松手怎么落由 willDetach 和底下的命中一起判（见那个函数上面的说明）。
 */
export function leftTabstrip(tabId: string | undefined, x: number, y: number, pad = 12): boolean {
  const strip = groupEl(tabId)?.querySelector('.tabstrip');
  if (!strip) return false;
  const r = strip.getBoundingClientRect();
  // 留一点余量：手指抖一下正好压在线上的，不该算"拿出来了"
  return x < r.left - pad || x > r.right + pad || y < r.top - pad || y > r.bottom + pad;
}

/**
 * 松手会不会"拿出来"（立户成一块浮窗）。
 *
 * 两种算：指针出了这块窗口；停在窗口里的空处（底下没压着任何标签组）。
 * 压着标签组的一律不算 —— 那些是就地动作：并进去 / 分一块，
 * 全靠面板还留在布局里才判得出来，一拿出来就没得判了。
 *
 * 自己那一组同样算"就地"：拖到它某条边上 = 分成两块，拖到中间／上沿 = 不动。
 * 拖到顶上那条收纳区是"存成组件"，也不是拿出来。
 */
export function willDetach(d: DragState): boolean {
  if (d.source.kind === 'component' || d.source.kind === 'monitor') return false;
  if (d.bar) return false;
  if (d.outside) return true;
  return Boolean(d.outOfBar && !d.hit);
}

/**
 * 出发那一组标签的尺寸 —— 拖出去的新窗口照它开，别一出来就是个默认大小。
 *
 * 给了指针位置就顺便带上**压在块里的哪一点**（dx/dy）：新窗口照着它摆，
 * 指针才会停在原来那个位置（不然窗口和指针会错开一截，看着像"脱手了"）。
 */
export function groupBox(
  tabId?: string,
): { width: number; height: number } {
  const r = groupEl(tabId)?.getBoundingClientRect();
  return { width: Math.round(r?.width ?? 640), height: Math.round(r?.height ?? 640) };
}

/*
 * 新浮窗的**固定锚点**：光标压在它那个标签的**中心**。
 *
 * 为什么不是"标签栏的中点"：新窗口里通常只有你拖出来的那一个标签，标签栏左端还有
 * 把手和图标，栏中点离标签本身能有近百像素 —— 出来就和手错开一截。
 *
 * 关键是这个偏移**是个常数**，不在窗口上屏时现算。以前是"上屏那一刻用当前光标
 * 减去请求位置"反推偏移，而请求位置是按**撕出来那一刻**的光标算的：中间这几百毫秒
 * 光标挪了多少，偏差就永久留在里面 —— 拖得慢看不出来，拖快了就偏，正是这个来源。
 */
const STRIP_MID = 17; // 标签栏高 34 的一半

/** 新浮窗标签栏的左内边距（见 float.css 的 .floating-shell .tabstrip） */
const FLOAT_STRIP_PAD = 18;

export function tabAnchor(tabId?: string, panelId?: string): { dx: number; dy: number } {
  const group = groupEl(tabId);
  const tab =
    (panelId ? group?.querySelector<HTMLElement>(`[data-panel-id="${panelId}"]`) : null) ??
    group?.querySelector<HTMLElement>('.tab');
  const w = tab?.getBoundingClientRect().width ?? 120;
  /*
   * 只量**标签有多宽**，不量它在原窗口里排第几个。
   *
   * 新浮窗里那个标签永远紧挨着左端（就那一个内边距），而原窗口里它可能排在第三第四个 ——
   * 把"在原窗口里的横向位置"也算进来，光标就会落到新窗口标签栏的中段，
   * 而且拖第几个标签就偏多少，看着毫无规律。
   */
  const dx = FLOAT_STRIP_PAD + Math.round(w / 2);
  return { dx, dy: STRIP_MID };
}

/**
 * 这个落点**等于没落** —— 不该画框，也不该给整块罩蓝边。
 *
 * 三种都不算"要并到别处去"：
 *   · 拖**整组**落在它自己身上   → 搬自己到自己身上，没有意义；
 *   · 拖面板落在自己那组的标签栏 → 就地重排，标签让位已经把"插在第几个"说清楚了；
 *   · 拖面板落在自己那组的上沿   → "放回原处"，什么都不做。
 *
 * 以前只压掉了第一种里的 mode === 'tabs'：光标稍微往下偏一点就从"标签栏"变成
 * "上边缘带"，整块面板当场被罩上蓝边 —— 这就是"在标签栏里挪一格，中间突兀冒出一个框"。
 * 落在左 / 右 / 下三条边上仍然要显示：那是真的"分成两块"。
 */
export function isNoop(d: DragState): boolean {
  const { source, hit } = d;
  // 收纳区不是"某一块面板"，无所谓"等于没落"：收起来就是收起来
  if (!hit) return false;
  if (source.kind === 'component' || source.kind === 'monitor' || hit.tabId !== source.tabId) return false;
  if (source.kind === 'tabs') return true;
  return hit.mode === 'tabs' || hit.mode === 'top';
}

/**
 * 松手会怎样 —— 一句话。**和真正执行的判定共用 willDetach**，
 * 所以提示里说的和松手之后发生的一定是同一件事，不会各说各的。
 */
export function dragHint(d: DragState): string {
  // 监视台列表里拖出来的：只认落点，不会立户成浮窗 —— 提示不能照抄面板那套
  if (d.source.kind === 'monitor') {
    if (barHitOf(d)) return t('松开 → 收进收纳区');
    if (d.outside) return t('松开 → 这儿没有落点');
    if (!d.hit) return t('松开 → 不挪动');
  }
  // 窗口外问到的落点也算数：压在主窗口的收纳区上时，松手是"收进去"而不是"立户"
  if (barHitOf(d)) {
    if (d.source.kind === 'component') return t('松开 → 调整收纳区顺序');
    if (d.source.kind === 'tabs') return t('松开 → 这一组整个收进收纳区');
    return t('松开 → 收进收纳区');
  }
  if (d.outside) return t('松手 → 变成一块浮窗，就放在这儿');
  if (barHitOf(d)) {
    if (d.source.kind === 'panel') return t('松开 → 收进收纳区');
    if (d.source.kind === 'component') return t('松开 → 调整收纳区顺序');
    // 整组：组里每个面板各收一件（一组没有"本体"，收的是一件件具体的东西）
    return t('松开 → 这一组整个收进收纳区');
  }
  if (willDetach(d)) return t('松开 → 拿出来，变成一块浮窗');
  if (!d.hit) return t('松开 → 放回原处');
  // 拖回自己那一组的上沿什么都不做（把自己并在自己身上没有意义），
  // 只有左 / 右 / 下三条边才是"分成两块"。提示得跟真正会发生的事一致。
  if (
    d.source.kind === 'panel' &&
    d.hit.tabId === d.source.tabId &&
    d.hit.mode === 'top'
  ) {
    return t('松开 → 放回原处');
  }
  if (d.hit.mode === 'tabs') return t('松开 → 并入这组标签');
  if (d.hit.mode === 'center') return t('松开 → 嵌成挂件，贴在这块面板上');
  return t('松开 → 在这里分成新的一块');
}

/** 指针已经跑出本窗口的内容区 */
export const isOutside = (x: number, y: number) => x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight;

/**
 * 落点探测的答案，外加一层"哪些落点在这扇窗里算数"的过滤。
 *
 * 收纳区（bar）必须原样放行：面板一离开标签栏就撕成了浮窗，之后整场拖动都由
 * **光标底下那扇窗**答题，而浮窗自己只有一条标签栏、没有顶栏 —— 收纳区却在
 * 主窗口的顶栏上。去掉它，从浮窗里把面板拖到收纳区上就再也收不进去（见 barHitAt）。
 */
export function filterForWindow(hit: ProbeHit | null, floating: boolean): ProbeHit | null {
  return floating ? onlyTabs(hit) : hit;
}

/**
 * 浮窗里的落点**只有一处：标签栏**。
 *
 * 浮窗是"临时拎出来看的一块"：里面不分栏、也没有别的容器，落在它身上只有一种意思 ——
 * 并进它那一组标签（合并 / 重排），而那件事只有**标签栏**说得出来。
 *
 * 四边和主体一律返回 null，**不许降级成 tabs**：主体不是标签栏，压在主体上松手的意思是
 * "就在这儿立户"，也就是拖出去。上一版把四边降级成 tabs、又给主体兜了个"整扇窗算并进去"，
 * 于是浮窗里的标签根本撕不出来，拖到主体上还被并回去。
 */
export function onlyTabs(hit: ProbeHit | null): ProbeHit | null {
  if (!hit) return null;
  // 收纳区不在这一层管：它认的是"收起来"，和标签栏那点事无关，原样放行
  if (isBarHit(hit)) return hit;
  return hit.mode === 'tabs' ? hit : null;
}

/** 松手：把这一拖的结果交给主进程。整组和单个面板走的是不同通道。 */
export function placeDrag(d: DragState) {
  const fromWindowId = d.from.kind === 'floating' ? d.from.windowId : undefined;

  // 顶上那条收纳区：松在这儿 = 把它收进收纳区，或在收纳区内拖拽排序（见 barHitOf）
  const barHit = barHitOf(d);
  if (barHit) {
    const barIndex = barHit.barIndex;
    if (d.source.kind === 'panel') {
      void api.components.save(d.source.panelId, '', barIndex);
    } else if (d.source.kind === 'tabs') {
      // 整组：组里每个面板各收一件（一组没有"本体"，见 store 的 stowTabGroup）
      void api.components.saveGroup(d.source.tabId, fromWindowId, barIndex);
    } else if (d.source.kind === 'monitor') {
      // 监视台里**开着**的面板拖到收纳区 = 收成组件；还没打开的先不收（本体还在 closed/ 里）
      if (d.source.state !== 'closed') void api.components.save(d.source.panelId, d.source.name, barIndex);
    } else if (d.source.kind === 'component' && typeof barIndex === 'number') {
      void api.components.list().then((all) => {
        const pinned = all.filter((c) => c.pinned).map((c) => c.id);
        const selfId = d.source.kind === 'component' ? d.source.componentId : '';
        if (!selfId) return;
        const filtered = pinned.filter((id) => id !== selfId);
        const at = Math.max(0, Math.min(barIndex ?? filtered.length, filtered.length));
        filtered.splice(at, 0, selfId);
        if (filtered.some((id, idx) => pinned[idx] !== id) || filtered.length !== pinned.length) {
          void api.components.reorder(filtered);
        }
      });
    }
    return;
  }

  // 监视台成员列表里拖出来的面板：同样只认落点 ——
  // 没开（closed/）就先捞回来、后台挂着就先叫出来，然后**精确落在松手的地方**；开着就直接挪过去。
  // 绝不开第二份：整个过程动的始终是同一块面板。
  if (d.source.kind === 'monitor') {
    if (!d.outside && d.hit) {
      const pId = d.source.panelId;
      const target = targetOf(d.from, d.hit);
      const idx = d.hit.index;
      const place = () => void api.dock.drop(pId, target, idx);
      if (d.source.state === 'visible') place();
      else if (d.source.state === 'hidden') void api.panel.activate(pId).then(place, place);
      else void api.panel.reopen(pId).then(place, place);
    }
    return;
  }

  // 收纳区入口拖出来的面板：只认落点 —— 中间 → 并进那组标签，边上 → 在那儿分出新的一块。
  // 没命中任何标签组（松在菜单栏、窗口外）就什么都不做：入口一直在，想开随时再点。
  // 主进程分两种情况：没开 → 打开到落点；开着 → 把同一个面板挪过去。
  if (d.source.kind === 'component') {
    if (!d.outside && d.hit) {
      void api.components.create(d.source.componentId, targetOf(d.from, d.hit), d.hit.index);
    }
    return;
  }

  // 离开标签栏、底下也没有别的标签组接着 → 它自己立户，变成一块悬浮窗。
  // fromWindowId 必须带下去：主进程要看光标底下是不是**别的**窗口，
  // 不排除它原来待的那个，光标还没走远时会被当成"拖回来了"。
  if (willDetach(d)) {
    const box = { ...groupBox(d.source.tabId), ...tabAnchor(d.source.tabId, d.source.kind === 'panel' ? d.source.panelId : undefined) };
    if (d.source.kind === 'panel') void api.panel.detach(d.source.panelId, fromWindowId, box);
    else void api.dock.detachTabs(d.source.tabId, fromWindowId, box);
    return;
  }
  if (!d.hit) return;

  // 落下这件事交给主进程。整组落在**它自己那一组**上等于没落：什么都不发 ——
  // 发过去主进程也只是原样搬一遍，active 还会被改成最后那个（视角莫名跳走）。
  if (d.source.kind === 'tabs' && d.hit.tabId === d.source.tabId) return;

  const target = targetOf(d.from, d.hit);
  if (d.source.kind === 'panel') void api.dock.drop(d.source.panelId, target, d.hit.index);
  else void api.dock.dropTab(d.source.tabId, target, fromWindowId);
}
