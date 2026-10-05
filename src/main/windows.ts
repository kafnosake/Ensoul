import { BrowserWindow, screen, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { store } from './store';
import { WIDGET_EDIT_REQUEST, type WidgetEditRequest } from '../shared/widget-editor';
import { noteRecent } from './crash';
import { applyTo, getZoom } from './zoom';
import { appDir } from './paths';

/**
 * 窗口层：主窗口一个，浮窗若干个。
 *
 * 关键点：**浮窗承载的不是一个面板，而是一整棵停靠树** ——
 * 所以浮窗里照样能放多个面板、能叠标签、能继续分块，和主窗口是同一套东西。
 *
 * 这里只管窗口，不管布局；布局由 store 说了算，sync() 负责把两边对齐。
 */

/**
 * 落点分区。前三个是「落在某一块面板上」，后四个是「落在窗口的一边」——
 * 后者在这边表现为「整扇窗一分为二」，也就是侧窗。
 */
export type DropZone = 'tabs' | 'center' | 'left' | 'right' | 'top' | 'bottom';

/**
 * 渲染层给的落点答案（形状和 renderer 的 DropProbe 一致，这边只需要认识它）。
 *   · { tabId, mode } → 落在某一块面板上：tabs 并进去 / center 做它的挂件 / 四边在旁边分栏
 *   · { side }        → 落在窗口的一边上：在根上分一块（侧窗，和窗口里原有的均等分隔）
 *   · { bar: true }   → 落在**顶上那条收纳区**上：这一拖里的面板收起来
 *   · null            → 哪儿都没落着，松手就留在原地
 *
 * 收纳区那个落点是**主窗口顶栏**上的一段，既不属于哪块面板、也不是窗口的哪条边，
 * 所以单开一类。没有它的话，面板一旦撕成浮窗就再也收不回去（见 landWindow）。
 */
export interface DropHit {
  tabId?: string;
  mode?: DropZone;
  side?: 'left' | 'right' | 'top' | 'bottom';
  bar?: boolean;
  barIndex?: number;
  index?: number;
}

/** 一次落点探测的结果：落到哪扇窗，以及那扇窗自己说「落在哪」 */
export interface DropResult {
  target: string;
  hit: DropHit | null;
}

const PRELOAD = path.join(__dirname, '..', 'preload', 'index.js');
const RENDERER = path.join(__dirname, '..', 'renderer', 'index.html');
const DEV_URL = process.env.ENSOUL_DEV_URL;

/**
 * 加载界面。首次加载偶尔会失败（上一个实例刚退出时 Chromium 缓存目录还被占着，
 * 表现为一个标题是 Error 的空窗口），所以失败后自动重试一次。
 */
const keyGuarded = new WeakSet<BrowserWindow>();

/**
 * Ctrl/⌘ + W 是**关当前会话**，不是关整扇窗。
 *
 * 这个键 Chromium 自己就认（直接关窗口），渲染层一个事件都收不到 —— 只能在主进程
 * 按住它，再叫界面去关当前那块面板。主窗口和浮窗走同一条路，规则一致。
 * 界面那边没有面板可关时（空窗口）它自己会放行，窗口照常关，不会变成"按了没反应"。
 *
 * 用 WeakSet 去重：load() 在首次加载失败时会重试一次，不去重就会挂两遍监听。
 */
function guardKeys(win: BrowserWindow) {
  if (keyGuarded.has(win)) return;
  keyGuarded.add(win);
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (!(input.control || input.meta) || input.shift || input.alt) return;
    if ((input.key || '').toLowerCase() !== 'w') return;
    e.preventDefault();
    win.webContents.send('ui:closePanel');
  });
}

function load(win: BrowserWindow, query: Record<string, string>, retried = false) {
  if (!retried) {
    win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      console.error('[窗口] 首次加载失败，重试一次：', code, desc);
      setTimeout(() => load(win, query, true), 500);
    });
  }
  if (DEV_URL) {
    void win.loadURL(`${DEV_URL}?${new URLSearchParams(query).toString()}`);
  } else {
    void win.loadFile(RENDERER, { query });
  }
  /*
   * 每换一次页面都要重新套一遍乘区。
   *
   * 原生缩放是**按文档**记的，loadFile / loadURL 一上来先给 1，晚一步才轮到我们设 ——
   * 不补这一下，新开的浮窗会是 100%，而主窗口还是用户调的那个倍数。
   * 幂等，重复设没有代价。
   */
  win.webContents.on('did-finish-load', () => applyTo(win));
  applyTo(win);
  guardKeys(win);
}

const webPreferences = {
  preload: PRELOAD,
  contextIsolation: true,
  nodeIntegration: false,
  webviewTag: true,
  // 显式写出来：Electron 20 起这本来就是默认值，写明是为了不被人无心地关掉
  sandbox: true,
};

/**
 * 这个地址是不是我们自己的界面。
 *
 * 打包后是 file://（自己的 dist/renderer 那一份），开发时是 vite 那个地址。
 * 判据只有一条：**不是自己人就不许导航过去** —— 对话里的 markdown、插件面板、
 * 网页面板里出来的链接，都不是我们写的代码，不能让它把整个工作台导走
 * （同一个窗口，导走了连后退都回不到停靠树）。
 *
 * file: 不能一律放行：那样一个 [x](file:///C:/...) 的链接就能把界面顶掉。
 */
const OWN_DIR = path.dirname(RENDERER).replace(/\\/g, '/').replace(/^\/+/, '');

function isOwnUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') {
      const p = decodeURIComponent(u.pathname).replace(/\\/g, '/').replace(/^\/+/, '');
      return p.startsWith(OWN_DIR + '/');
    }
    return Boolean(DEV_URL) && u.origin === new URL(DEV_URL!).origin;
  } catch {
    return false;
  }
}

/**
 * 窗口硬化：只做"关门"的事，不改变任何现有行为。
 *
 * - 外部链接一律交给系统浏览器。以前点了 markdown 里的外链，是**整个界面被导走**；
 *   `target=_blank` 则开一个没有 preload 的裸窗口。
 * - 只允许导航回自己的地址；同页锚点（只有 #hash 变了）放行，否则长文里的目录跳转会被挡。
 * - webview（网页面板）只许拿网页能力，不许带 preload、更不许开 nodeIntegration。
 *
 * 注：sandbox 本来就默认开着（Electron 20 起），这里只是写明，免得被人无心地关掉。
 */
function harden(win: BrowserWindow) {
  const wc = win.webContents;

  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  wc.on('will-navigate', (e, url) => {
    if (isOwnUrl(url)) return;
    const now = wc.getURL();
    // 只差一个 hash：同页跳转，放行（长文目录、面板锚点都靠它）
    if (now && url.split('#')[0] === now.split('#')[0]) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });

  wc.on('will-attach-webview', (_e, prefs) => {
    delete (prefs as { preload?: string }).preload;
    (prefs as { nodeIntegration?: boolean }).nodeIntegration = false;
  });

  // 崩的时候要能看见出事前最后那句 —— 渲染层的输出主进程只有这一条路能拿到
  wc.on('console-message', (_e, level, message) => {
    if (level >= 2) noteRecent(`${message}`);
  });
}

/**
 * 挂件窗口的「常驻置顶」—— 两个平台要的东西不一样，收在一处。
 *
 * Windows：`screen-saver` 这一档就够。普通 alwaysOnTop 压不过全屏应用和某些浮层，
 * 而挂件的存在意义就是"抬眼就在"，所以一直是提一档。
 *
 * macOS：**光提层级看不见**。mac 有"空间（Spaces）"这一层抽象 —— 别人的全屏 App
 * 占的是**另一个空间**，不是"更靠上的窗口"，层级再高也在那个空间里。所以要额外
 * `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`，让这扇窗在所有
 * 空间都可见、且能压在别人的全屏之上。这正是"桌面挂件"在 mac 上该有的样子。
 *
 * `skipTransformProcessType` 那个参数**必须传**，不然会闪：官方注释写着，
 * 这个方法默认会把进程类型在 UIElementApplication / ForegroundApplication 之间
 * 来回换一次以保证行为正确 —— 代价是每次调用"窗口和 Dock 消失一瞬间"。而挂件在
 * sync() 里会被反复调，不关掉这个转换就是反复闪。
 *
 * 这个 API 在 Windows 上是明写的 no-op（官方注释：This API does nothing on Windows），
 * 所以不需要分支判断"要不要调"，直接调、由系统自己忽略。
 */
function widgetTop(win: BrowserWindow, on: boolean) {
  if (win.isDestroyed()) return;
  try {
    win.setAlwaysOnTop(on, 'screen-saver');
  } catch {
    /* 窗口正在销毁 */
  }
  try {
    win.setVisibleOnAllWorkspaces(on, { visibleOnFullScreen: on, skipTransformProcessType: true });
  } catch {
    /* 老版本 Electron 不认这个参数：退回"只提层级"，Windows 上本来就是这么工作的 */
  }
}

class Windows {
  main: BrowserWindow | null = null;
  /** windowId → 承载它的系统窗口 */
  private floating = new Map<string, BrowserWindow>();
  /**
   * 挂件窗口：面板 id → 那扇独立小窗（见 Panel.widget）。
   * 键用**面板 id** 而不是窗口 id —— 挂件就是"这块面板自己是一扇窗"，一一对应，
   * 不需要再发明一层 id 去关联。
   */
  private widgets = new Map<string, BrowserWindow>();
  private shuttingDown = new Set<string>();
  /** 合并窗口期挂着的那个定时器（见 broadcast） */
  private broadcastTimer: NodeJS.Timeout | null = null;
  /**
   * 拖动会话：dx/dy 是指针在窗口里的偏移，w/h 是**按下那一刻的尺寸**。
   *
   * 尺寸为什么存成会话常数：拖动中窗口会持续派发新的 pointermove（窗口挪了，
   * 指针在窗口里的相对位置就变了），moveGrab 会被一帧接一帧叫醒，跟使用者有没有
   * 动鼠标无关。若每次都以上一次的尺寸为基准重设窗口，Windows 在带缩放的显示器上
   * 的舍入就会一轮轮累积 —— 表现就是"一边抖一边变大"。从常数出发，偏差永不累积。
   */
  private grab = new Map<string, { dx: number; dy: number; w: number; h: number }>();
  /**
   * 拖动途中被撕下来的窗口：源窗口 key（main 或浮窗 id）→ 撕出来的那块窗口。
   * 松手之前它一直挂在光标下，松手才判定落到哪。
   */
  private live = new Map<string, string>();
  /**
   * 正处于"刚撕下来"状态的窗口。它**不许抢焦点** —— 一抢焦点，源窗口那边正按着的
   * 鼠标捕获当场就断了，整个拖拽会半路死掉；任务栏也先不占。
   */
  private liveWindows = new Set<string>();
  /**
   * 被我置顶过（拖拽期间挂在最上层）的窗口。
   *
   * 置顶是让跟手那块盖在主体之上；撤置顶只发生在 finishLive 里。可这一拖一旦
   * 没收尾（会话丢了、源窗口先死），撤置顶就永远不会发生 —— 那块窗口从此钉在
   * 所有东西上面，界面全被它盖住，看着就是"卡死、点不动、关不掉"。
   * 所以另外找人盯着：没有会话还挂着置顶的，一律当场撤掉。
   */
  private topPinned = new Set<string>();
  private topTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * 清掉"孤儿状态"：没有会话了，却还挂着置顶、任务栏里也藏着的浮窗。
   *
   * 拖动期间会把跟手那一块置顶、并从任务栏藏起来，收尾时恢复。可收尾一旦没发生
   * （松手信号丢了、源窗口先没了），这块窗口就永远钉在所有东西上面、任务栏里也找不到它 ——
   * 界面上就是"全被一块窗口盖住，关不掉"。这就是那个"层级问题"的机械形态。
   *
   * 不看信号，只看事实：没有会话还挂着置顶的，就是孤儿，当场恢复。
   */
  private unpinStray() {
    for (const id of [...this.topPinned]) {
      if (this.liveWindows.has(id)) continue;
      this.topPinned.delete(id);
      const win = this.floating.get(id);
      if (win && !win.isDestroyed()) {
        try {
          win.setAlwaysOnTop(false);
          win.setSkipTaskbar(false);
          win.moveTop();
        } catch {
          /* 窗口正在销毁 */
        }
      }
    }
  }

  /** 盯着置顶名单，别等下一次界面刷新 */
  private armUnpin() {
    if (this.topTimer) return;
    this.topTimer = setInterval(() => {
      this.unpinStray();
      if (!this.topPinned.size && this.topTimer) {
        clearInterval(this.topTimer);
        this.topTimer = null;
      }
    }, 400);
  }
  /** 拖动会话的看门狗：光标停住、又没有"还按着"的证据，多久算这一拖已经结束了（宽限容差，避免瞄准落点时误结算） */
  private liveIdleMs = 12000;
  /** 上一次给"光标底下那扇窗"发落点提示的时刻（提示必须限流） */
  private lastProbe = 0;
  /** 会话钥匙 → 最后一次看见光标动过的时间（看门狗拿它和 liveBeat 里较新的那个比） */
  private liveSeen = new Map<string, { at: number; x: number; y: number }>();
  /**
   * 会话钥匙 → 最后一次收到"还按着"的**证据**。
   *
   * 证据只能来自指针事件（拖动中收到 pointermove，且按钮是按下的），不能来自定时器。
   * 定时器是一句自己说自己的承诺，它永远不会停：松手信号一旦收不到（指针跑到撕出来那块
   * 窗口上、捕获被系统收走），它还在响，这一拖就永远收不了尾 —— 跟手的窗口定在半路、
   * 源窗口留着一个空壳，界面上就是"卡死"。心跳必须有来源，来源一断看门狗才收得了尾。
   */
  private liveBeat = new Map<string, number>();
  private liveTimer: ReturnType<typeof setInterval> | 0 = 0;
  /**
   * 这一拖没人来收尾时（松手信号丢了），看门狗就地收尾，然后通知上层一声：
   * 上层拿着 windowId 去问落点，和正常松手走的是同一段。
   */
  onLiveStale: ((windowId: string) => void) | null = null;
  /** 上次位置：宿主挪动时靠它算位移，好带着附属一起走 */
  private lastPos = new Map<string, { x: number; y: number }>();
  /** 已经落到系统上的原生父子关系，避免每次 sync 都重设一遍 */
  private appliedParent = new Map<string, string>();
  /** 正在等答复的落点探测：id → 拿到答复时该唤醒谁 */
  private asking = new Map<number, (r: { answered: boolean; hit: unknown }) => void>();
  private askSeq = 0;
  private resizing = new Map<string, { x: number; y: number; w: number; h: number }>();
  /**
   * 我们自己要把它放大的那几次（最大化、侧置吸附）—— 打个短标记，
   * 看门狗在这段时间里不管它，免得刚放大就被自己缩回去。
   */
  private allowed = new Map<string, number>();
  /** 正在把窗口缩回原尺寸：那次 setSize 触发的 resize 不该再被当成"别人在推它" */
  private reverting = new Set<string>();
  /** 每個窗口被看门狗拦下的次数 —— 反复被推大就别再顶了，免得两边来回拉锯 */
  private reverts = new Map<string, number>();

  /** 用户直接关掉浮窗：交给上层（默认是归一化回主窗口，不是删除） */
  onCloseRequest: ((windowId: string) => void) | null = null;
  /** 用户关掉一扇挂件窗口：交给上层（默认是取消挂件状态、摆回停靠树） */
  onWidgetClose: ((panelId: string) => void) | null = null;

  createMainWindow(): BrowserWindow {
    // 按工作区大小收一下：显示器缩放比大时，写死 1360x880 会顶出屏幕外面去
    const wa = screen.getPrimaryDisplay().workArea;
    const width = Math.min(1360, Math.max(760, wa.width - 100));
    const height = Math.min(880, Math.max(500, wa.height - 100));
    const win = new BrowserWindow({
      icon: path.join(appDir(), 'assets', 'icon.png'),
      width,
      height,
      x: wa.x + Math.round((wa.width - width) / 2),
      y: wa.y + Math.round((wa.height - height) / 2),
      minWidth: 640,
      minHeight: 420,
      frame: false,
      backgroundColor: '#0e1014',
      show: false,
      webPreferences,
    });
    win.on('ready-to-show', () => win.show());
    harden(win);
    /*
     * 界面一准备好就把最新状态推给它。
     *
     * 必须走 broadcastNow（不等合并窗口）：窗口刚立起来时渲染层手上什么都没有，
     * 这是它的**首份**状态 —— 让它多等 24 ms 合并窗口纯属白等。
     * （首拉那条路本来就异步，这里补一份同步的，第一帧就拿得到真值。）
     */
    win.webContents.on('dom-ready', () => this.broadcastNow());
    win.on('closed', () => {
      this.main = null;
    });
    // 主窗口自己挪动时也要带着挂在它下面的浮窗
    win.on('moved', () => {
      if (win.isDestroyed()) return;
      const [x, y] = win.getPosition();
      const prev = this.lastPos.get('main');
      if (prev && (prev.x !== x || prev.y !== y)) this.moveChildren('main', x - prev.x, y - prev.y);
      this.lastPos.set('main', { x, y });
    });
    // 原生子窗口本来就会跟着父窗口最小化，这里再兜一层：
    // 万一哪次 setParentWindow 没落上，小窗也不至于孤零零飘在桌面上
    win.on('minimize', () => this.setChildrenVisible('main', false));
    win.on('restore', () => this.setChildrenVisible('main', true));
    this.main = win;
    const [mx, my] = win.getPosition();
    this.lastPos.set('main', { x: mx, y: my });
    load(win, { mode: 'main' });
    return win;
  }

  openFloating(windowId: string): BrowserWindow | null {
    const floating = store.state.floating.find((w) => w.id === windowId);
    if (!floating) return null;
    const existing = this.floating.get(windowId);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return existing;
    }

    const r = floating.rect;
    const wa = screen.getDisplayNearestPoint({ x: Math.round(r.x), y: Math.round(r.y) }).workArea;
    const win = new BrowserWindow({
      icon: path.join(appDir(), 'assets', 'icon.png'),
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.min(Math.round(r.width), Math.max(360, wa.width - 60)),
      height: Math.min(Math.round(r.height), Math.max(260, wa.height - 60)),
      minWidth: 320,
      minHeight: 220,
      frame: false,
      thickFrame: true,
      resizable: true,
      backgroundColor: '#0e1014',
      show: false,
      webPreferences,
    });

    win.on('ready-to-show', () => {
      if (win.isDestroyed()) return;
      // 拖动途中撕下来的那块**不能**用 show()：激活它就等于把源窗口的鼠标捕获抢走，
      // 拖拽当场断在半路。无声地出来，松手之后再换回一个正常窗口。
      if (this.liveWindows.has(windowId)) {
        /*
         * 撕下来的那一块**不许抢焦点**：一激活就等于把源窗口的鼠标捕获抢走，这一拖当场断。
         *
         * 但 showInactive 在 Windows 上会把它排到前台窗口**下面**：跟手的块被主体遮住，
         * 而且被系统判成"看不见的窗口"之后 Chromium 干脆不再重绘它 —— 那就是一块白板。
         * 所以这里置顶：只提层级、不激活，两件事一起满足。松手时在 finishLive 里撤掉。
         */
        win.setAlwaysOnTop(true, 'screen-saver');
        win.showInactive();
        win.moveTop();
        win.setSkipTaskbar(true);
        this.topPinned.add(windowId);
        this.armUnpin();
      } else win.show();
      harden(win);
      /*
       * 一开出来就把它掰回请求的尺寸。
       *
       * 不校正的话，这个偏差会跟着"存 → 开"一轮轮累加：resize 事件里存进 store 的是
       * getSize() 的值，下次创建又用它当 width/height，每开一次就再长一点。
       */
      const want = { width: Math.round(r.width), height: Math.round(r.height) };
      const [w0, h0] = win.getSize();
      if (w0 !== want.width || h0 !== want.height) {
        win.setBounds({ x: Math.round(r.x), y: Math.round(r.y), width: want.width, height: want.height });
      }
    });
    win.on('close', () => {
      if (this.shuttingDown.has(windowId)) return;
      this.onCloseRequest?.(windowId);
    });
    // 浮窗也要在界面就绪时拿到第一份状态（同主窗口，见 createMainWindow）
    win.webContents.on('dom-ready', () => this.broadcastNow());
    win.on('closed', () => {
      this.floating.delete(windowId);
      this.shuttingDown.delete(windowId);
      this.appliedParent.delete(windowId);
      this.lastPos.delete(windowId);
      // 手势会话也一并清掉，免得下次开同一个窗口时残留的锚点还在
      this.grab.delete(windowId);
      this.resizing.delete(windowId);
      this.liveWindows.delete(windowId);
      /*
       * 只收**和这扇窗有关**的那几条会话。
       *
       * 这里原来是"这扇窗一关 → 把所有会话一起收掉"，于是一块浮窗被关掉，
       * 另一拖（跟它毫无关系）也被连坐结算：那一拖的跟手当场停住、
       * 面板丢在半路 —— 又一个"卡死"的来源。
       */
      for (const [key, id] of [...this.live]) {
        if (id === windowId) this.endLive(key);
      }
      // 这扇窗**自己**当源窗口的那一条（live 的键是它的 id）
      if (this.live.has(windowId)) this.endLive(windowId);
    });
    win.on('moved', () => {
      if (win.isDestroyed()) return;
      const [x, y] = win.getPosition();
      const [width, height] = win.getSize();
      const prev = this.lastPos.get(windowId);
      if (prev && (prev.x !== x || prev.y !== y)) this.moveChildren(windowId, x - prev.x, y - prev.y);
      this.lastPos.set(windowId, { x, y });
      store.setWindowRect(windowId, { x, y, width, height });
    });
    win.on('resize', () => {
      if (win.isDestroyed()) return;
      const [x, y] = win.getPosition();
      let [width, height] = win.getSize();
      const heldGrab = this.grab.get(windowId);
      if (heldGrab) {
        width = heldGrab.w;
        height = heldGrab.h;
      }
      store.setWindowRect(windowId, { x, y, width, height });
    });

    this.floating.set(windowId, win);
    this.lastPos.set(windowId, { x: Math.round(r.x), y: Math.round(r.y) });
    load(win, { mode: 'floating', window: windowId });
    return win;
  }

  closeFloating(windowId: string) {
    const win = this.floating.get(windowId);
    if (!win || win.isDestroyed()) return;
    this.shuttingDown.add(windowId);
    win.close();
  }

  /**
   * 开一扇**挂件窗口**（见 Panel.widget）。
   *
   * 跟浮窗差三处，恰好就是"挂件"这个词的全部意思：
   *   · frame: false + transparent —— 没有窗口壳，形象自己就是全部
   *   · alwaysOnTop —— **常驻**置顶（浮窗只在拖拽途中临时置顶，松手就撤）
   *   · 不挂父窗口 —— 主窗口最小化了它照样在（浮窗是挂上去的，会跟着一起没）
   *
   * 于是它压得到别的软件上面、活得过主窗口 —— 这才是"全局挂件"要的那类窗口，
   * 也是它跟"浮在宿主窗口里的便签"（float）真正的分水岭。
   */
  openWidget(panelId: string): BrowserWindow | null {
    const box = store.state.panels[panelId]?.widget;
    if (!box) return null;
    const existing = this.widgets.get(panelId);
    if (existing && !existing.isDestroyed()) return existing;

    const wa = screen.getDisplayNearestPoint({ x: Math.round(box.x), y: Math.round(box.y) }).workArea;
    const width = Math.min(Math.round(box.width), Math.max(60, wa.width));
    const height = Math.min(Math.round(box.height), Math.max(40, wa.height));
    const win = new BrowserWindow({
      icon: path.join(appDir(), 'assets', 'icon.png'),
      x: Math.round(box.x),
      y: Math.round(box.y),
      width,
      height,
      frame: false,
      // 透明是挂件的命：形象有轮廓（鲸鱼、小人），背景必须是"没有"
      // 卡面同理：圆角要靠窗口透明才铰得出来（见 PanelWidget.card）
      transparent: box.transparent === true || box.card === true,
      hasShadow: box.transparent !== true && box.card !== true,
      resizable: true,
      skipTaskbar: box.skipTaskbar !== false,
      alwaysOnTop: box.onTop !== false,
      show: false,
      webPreferences,
    });

    win.on('ready-to-show', () => {
      if (win.isDestroyed()) return;
      // 层级用 screen-saver 这一档（同拖拽期间的用法）：普通 alwaysOnTop 压不过
      // 全屏应用和某些浮层，而挂件的存在意义就是"抬眼就在"。
      // mac 上还要额外"所有空间可见 + 压得过全屏"，见 widgetTop。
      if (box.onTop !== false) widgetTop(win, true);
      win.show();
      harden(win);
    });

    const remember = () => {
      if (win.isDestroyed()) return;
      const [x, y] = win.getPosition();
      const [w, h] = win.getSize();
      store.moveWidget(panelId, { x, y, width: w, height: h });
    };
    win.on('moved', remember);
    win.on('resize', remember);
    win.on('close', () => {
      if (this.shuttingDown.has('w:' + panelId)) return;
      // 用户直接点了挂件的关闭（无壳窗口上一般是别处的"关掉挂件"）——
      // 交给上层决定：默认是取消挂件状态、摆回停靠树，而不是删面板。
      this.onWidgetClose?.(panelId);
    });
    win.webContents.on('dom-ready', () => this.broadcastNow());
    win.on('closed', () => {
      this.widgets.delete(panelId);
      this.shuttingDown.delete('w:' + panelId);
    });

    this.widgets.set(panelId, win);
    load(win, { mode: 'widget', panel: panelId });
    return win;
  }

  moveWidget(panelId: string, patch: { x?: number; y?: number; width?: number; height?: number }) {
    const win = this.widgets.get(panelId);
    if (!win || win.isDestroyed()) return;
    win.setBounds({ ...win.getBounds(), ...patch });
  }

  openWidgetEditor(panelId: string) {
    const win = this.widgets.get(panelId);
    if (!store.panel(panelId)?.widget || !win || win.isDestroyed()) return;
    const request: WidgetEditRequest = { panelId };
    win.webContents.send(WIDGET_EDIT_REQUEST, request);
  }

  /** 关掉一扇挂件窗口（只是关窗，不碰面板的 widget 字段 —— 那是 store 的事） */
  closeWidget(panelId: string) {
    const win = this.widgets.get(panelId);
    if (!win || win.isDestroyed()) return;
    this.shuttingDown.add('w:' + panelId);
    win.close();
  }

  /**
   * 除挂件之外还开着几扇窗（主窗口 + 浮窗，都算）。
   *
   * 为什么需要它：macOS 上的 Dock 是**应用级**的，藏不藏是"这个应用要不要露面"。
   * 而露面的判据就是这里 —— 只挂着几个桌面小东西时该藏（那时托盘才是入口），
   * 只要有正儿八经的界面开着就该露面。所以这个数要能当场问出来。
   */
  frameWindowCount(): number {
    let n = 0;
    if (this.main && !this.main.isDestroyed()) n++;
    for (const w of this.floating.values()) if (!w.isDestroyed()) n++;
    return n;
  }

  /**
   * 此刻**真开着**的挂件窗口有几扇。
   *
   * 跟 store.widgetList() 只差一层但很关键：那个列的是"面板上声明了要挂"的记录，
   * 这个是"桌面上真有这么一扇窗"。sync() 刚建窗的那一刻、或者建窗失败的时刻，
   * 两边会对不上 —— 而 Dock 该不该藏，判的是**用户抬眼能不能看见东西**，
   * 所以要问这一边。
   */
  widgetCount(): number {
    let n = 0;
    for (const w of this.widgets.values()) if (!w.isDestroyed()) n++;
    return n;
  }
  /** 让窗口集合与 store 对齐：该开的开，该关的关 */
  sync() {
    // 每刷新一次顺手清一遍孤儿状态：用户点任何东西都可能把卡死的那块窗口救回来
    this.unpinStray();
    const wanted = new Set(store.state.floating.map((w) => w.id));
    for (const id of wanted) {
      const win = this.floating.get(id);
      if (!win || win.isDestroyed()) this.openFloating(id);
      this.applyParent(id); // 让系统窗口的归属关系跟上 store
    }
    for (const [id, win] of [...this.floating]) {
      if (!wanted.has(id) && !win.isDestroyed()) {
        const [x, y] = win.getPosition();
        const [width, height] = win.getSize();
        store.setWindowRect(id, { x, y, width, height });
        this.closeFloating(id);
      }
    }

    /*
     * 挂件窗口：与 store 对齐。
     *
     * 它的位置由窗口自己上报（moved/resize → store.moveWidget），这里只对「开不开」，
     * 不每次回写位置 —— 回写会把用户正拖着的那只手甩开（同浮窗 resize 的教训）。
     */
    const wantW = new Set(store.widgetList().map((w) => w.panelId));
    for (const pid of wantW) {
      const win = this.widgets.get(pid);
      if (!win || win.isDestroyed()) this.openWidget(pid);
      else {
        // 置顶 / 跳任务栏这类开关会在设置里被改，当场跟上（不然要重启才生效）
        const box = store.state.panels[pid]?.widget;
        if (box) {
          widgetTop(win, box.onTop !== false);
          try {
            win.setSkipTaskbar(box.skipTaskbar !== false);
          } catch {
            /* 窗口正在销毁 */
          }
        }
      }
    }
    for (const [pid, win] of [...this.widgets]) {
      if (!wantW.has(pid) && !win.isDestroyed()) this.closeWidget(pid);
    }
  }

  broadcast() {
    /*
     * 合并同一批改动：一次点击、一次拖拽常常连着触发好几次 refresh()，
     * 而每次都要把整份 publicState 算出来再发给每个窗口。合并到一帧后
     * 只算一次、只发一次 —— 省下的不只是序列化，还有渲染进程那一头的反序列化
     * 和整棵停靠树的 diff。
     *
     * 时序也是对的：同一批改动本来就该一起上屏，中间态没人需要看见。
     */
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.broadcastNow();
    }, 24);
  }

  /** 不等合并，立刻推一版（窗口刚建好、要马上接到状态时用） */
  broadcastNow() {
    const state = store.publicState();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('ws:state', state);
    }
  }

  /**
   * 刷新所有窗口的界面。界面产物（dist/renderer）重建之后走这条就够了 ——
   * 窗口本身、面板布局、对话记录全都留着，比重启整个应用快得多也稳得多。
   *
   * 注意只对**渲染层**有效：主进程的代码已经跑在内存里，改它只能重启。
   */
  reloadAll() {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.reload();
    }
  }

  windowIdOf(webContentsId: number): string | null {
    for (const [id, win] of this.floating) if (win.webContents.id === webContentsId) return id;
    return null;
  }

  isMain(webContentsId: number) {
    return this.main?.webContents.id === webContentsId;
  }

  /** 某个窗口在屏幕上的位置和大小 —— 布局报告要用 */
  boundsOf(windowId: string): { x: number; y: number; width: number; height: number } | null {
    const win = windowId === 'main' ? this.main : this.floating.get(windowId);
    if (!win || win.isDestroyed()) return null;
    const b = win.getBounds();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }

  /** 主窗口是否盖住了这个屏幕点：浮窗拖回来的判定靠它 */
  mainCovers(point: { x: number; y: number }): boolean {
    const m = this.main;
    if (!m || m.isDestroyed() || !m.isVisible()) return false;
    const b = m.getBounds();
    return point.x >= b.x && point.x <= b.x + b.width && point.y >= b.y && point.y <= b.y + b.height;
  }

  /** 光标还在不在某个窗口的范围里 —— 用来区分"微调位置"和"拖走脱离" */
  cursorInside(windowId: string): boolean {
    const win = windowId === 'main' ? this.main : this.floating.get(windowId);
    if (!win || win.isDestroyed() || !win.isVisible()) return false;
    const b = win.getBounds();
    const p = screen.getCursorScreenPoint();
    return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
  }

  /** 光标此刻落在哪个窗口上：面板被拖出窗口时，要靠它决定并回哪里 */
  windowAt(point: { x: number; y: number }): { kind: 'main' } | { kind: 'floating'; windowId: string } | null {
    const inside = (b: Electron.Rectangle) =>
      point.x >= b.x && point.x <= b.x + b.width && point.y >= b.y && point.y <= b.y + b.height;

    const m = this.main;
    if (m && !m.isDestroyed() && m.isVisible() && inside(m.getBounds())) return { kind: 'main' };
    for (const [id, win] of this.floating) {
      if (!win.isDestroyed() && win.isVisible() && inside(win.getBounds())) return { kind: 'floating', windowId: id };
    }
    return null;
  }

  /**
   * 开始拖标题栏。
   *
   * 指针坐标**全部由主进程自己取**（`screen.getCursorScreenPoint()`，DIP）：
   * 渲染层只负责"按下 / 移动 / 松开"三个信号。screenX 在各平台可能是 CSS 像素、
   * 也可能是物理像素，还会随显示器缩放变 —— 从渲染层传坐标再换算，迟早把位置算飞。
   */
  beginGrab(windowId: string) {
    const win = this.floating.get(windowId);
    if (!win || win.isDestroyed()) return;
    const c = screen.getCursorScreenPoint();
    const [x, y] = win.getPosition();
    const [w, h] = win.getSize();
    // 记"指针在窗口里的偏移"，移动时 窗口位置 = 指针 - 偏移，1:1 跟手；
    // 同时把**按下那一刻的尺寸**记成会话常数 —— 拖动全程只认它，见 moveGrab
    this.grab.set(windowId, { dx: c.x - x, dy: c.y - y, w, h });
  }

  /**
   * 浮窗右下角拉大小：按下时记一次起始指针与起始尺寸，松手由 endResize 销毁。
   * 会话**必须**有始有终 —— 残留的旧锚点会让后来按住别处划过把手的拖拽按老锚点暴涨。
   */
  beginResize(windowId: string) {
    const win = this.floating.get(windowId);
    if (!win || win.isDestroyed()) return;
    const c = screen.getCursorScreenPoint();
    const [w, h] = win.getSize();
    this.resizing.set(windowId, { x: c.x, y: c.y, w, h });
  }

  /** 松手/取消：没有活动会话时，任何 resizeMove 都是空操作 */
  endResize(windowId: string) {
    this.resizing.delete(windowId);
  }

  resizeMove(windowId: string) {
    const s = this.resizing.get(windowId);
    const win = this.floating.get(windowId);
    if (!s || !win || win.isDestroyed()) return;
    // 指针和窗口尺寸都是 DIP，直接相减即可，不需要再除缩放比
    const c = screen.getCursorScreenPoint();
    const wantW = Math.max(320, Math.round(s.w + (c.x - s.x)));
    const wantH = Math.max(220, Math.round(s.h + (c.y - s.y)));
    // 已经是这个尺寸就什么都别做 —— 和 moveGrab 同一个道理：反复 setSize 会跟
    // 系统对尺寸的重算互相顶，顶出抖动，也让偏差一轮轮累加。
    // 注意 wantW/wantH 永远由"按下时的常数 s.w/s.h + 当前光标位移"算出来，
    // 不以任何一次的结果为基准，所以本身不会累积。
    const [cw2, ch2] = win.getSize();
    if (cw2 === wantW && ch2 === wantH) return;
    win.setSize(wantW, wantH);
    // 请求多少、实际拿到多少。对不上就是有第三方在推这扇窗 —— 日志里会直接看到差多少
    const [aw, ah] = win.getSize();
    if (aw !== wantW || ah !== wantH) {
      /* 请求的尺寸和实际拿到的对不上：说明还有别的手在推这扇窗 */
    }
  }

  private traceStep(_windowId: string, _msg: string) {
    /* 占位：尺寸日志已随排查脚手架移除 */
  }

  /** 最大化之前的位置，还原用 —— 键是系统窗口 id */
  private maxed = new Map<number, Electron.Rectangle>();

  /** 系统窗口 → 我们的 windowId（看门狗打放行标记要用它） */
  private keyOfWindow(win: BrowserWindow): string | null {
    if (this.main && !this.main.isDestroyed() && this.main.id === win.id) return 'main';
    for (const [id, w] of this.floating) if (w.id === win.id) return id;
    return null;
  }

  /**
   * 浮窗是 resizable: false 的（为了关掉那圈系统缩放边框），
   * 系统最大化在那种窗口上会被忽略 —— 自己改 bounds，再按一下还原。
   */
  toggleMaximize(win: BrowserWindow) {
    if (win.isDestroyed()) return;
    const key = this.keyOfWindow(win);
    const prev = this.maxed.get(win.id);
    if (prev) {
      this.maxed.delete(win.id);
      if (key) this.allowed.set(key, Date.now() + 2000);
      win.setBounds(prev);
      return;
    }
    const b = win.getBounds();
    const wa = screen.getDisplayNearestPoint({
      x: b.x + Math.round(b.width / 2),
      y: b.y + Math.round(b.height / 2),
    }).workArea;
    this.maxed.set(win.id, b);
    if (key) this.allowed.set(key, Date.now() + 2000);
    win.setBounds(wa);
  }

  /**
   * 撕下来那块窗口自己报上来的跟手锚点（它在窗口里的标签中心）。
   *
   * 两件事一起做：把会话里的偏移换成这个真值，**并当场把窗口挪到位** ——
   * 窗口是按"源窗口推出来的近似位置"建的，报上来之前那一两帧本来就是偏的;
   * 这里一改，指针立刻落回标签中心，后面整场拖动都稳。
   */
  setAnchor(windowId: string, dx: number, dy: number) {
    const g = this.grab.get(windowId);
    if (!g || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    g.dx = dx;
    g.dy = dy;
    this.moveTo(windowId);
  }

  /**
   * 拖动浮窗：只动窗口，落点在松开时判定；提示由光标底下那扇窗自己画 */
  moveGrab(windowId: string) {
    const c = this.moveTo(windowId);
    // whole = true：拖的是**一整块浮窗**，所以正中算落点（嵌成挂件，见 landWindow）
    if (c) void this.probeAt(c, windowId, true, true);
  }

  /**
   * 把窗口挪到光标下 —— 拖标题栏和"拖动途中撕下来"共用这一段。
   * 只认按下那一刻记下的偏移和尺寸，绝不以上一次的结果为基准（理由见下面那段注释）。
   * 返回当前光标点；没在拖就返回 null。
   */
  moveTo(windowId: string): { x: number; y: number } | null {
    const g = this.grab.get(windowId);
    const win = this.floating.get(windowId);
    if (!g || !win || win.isDestroyed()) return null;
    const c = screen.getCursorScreenPoint();
    const x = Math.round(c.x - g.dx);
    const y = Math.round(c.y - g.dy);
    const [cx, cy] = win.getPosition();
    const [cw, ch] = win.getSize();

    /*
     * 已经在位、尺寸也还等于按下那一刻的常数：**一个窗口操作都不做**。
     *
     * 这一步是故意留的空转，它正是"鼠标一动就自己变大"的解药。
     * 拖动中窗口会持续派发新的 pointermove（窗口挪动，指针在窗口里的相对位置就变了），
     * 所以 moveGrab 会被一帧接一帧叫醒 —— 跟使用者有没有动鼠标无关。
     * 原来是每叫醒一次就 setPosition 一次，而 Windows 在带缩放的显示器上重算尺寸
     * 时会舍入；舍入出的新尺寸又喂出下一轮 pointermove，闭环自己转起来，越转越大。
     * 位置没变就一个操作都不发，闭环在源头断开。
     */
    if (cx === x && cy === y && cw === g.w && ch === g.h) return c;

    // 尺寸被系统带偏了：用**一次** setBounds 把位置和尺寸一起钉回会话常数。
    // 关键是每次都从按下那一刻的常数出发，绝不以上一次的结果为基准 —— 不会累积。
    if (cw !== g.w || ch !== g.h) {
      win.setBounds({ x, y, width: g.w, height: g.h });
    } else {
      win.setPosition(x, y);
    }
    return c;
  }

  // -------------------------------------------- 落点探测：问**光标底下那扇窗**要答案
  //
  // 为什么不在主进程自己算：主进程只看得见窗口的矩形，看不见窗口**里面**。
  // 原来那套是按「整扇窗的矩形」切块猜的（zoneAt），猜出来的「正中」是整扇窗口的
  // 正中，不是光标底下那一块面板的正中 —— 所以「拖到某一块面板上、把它做成自己的
  // 挂件」在这边根本没有对应的说法。落点只有 DOM 知道，那就由 DOM 来答。
  //
  // 这边只做两件事：光标压在哪扇窗上、把那个点换算成那扇窗**自己**的坐标。

  /** 目标窗口回话了（渲染层回的 drop:probe:reply 走到这儿） */
  answerProbe(id: number, hit: unknown) {
    const done = this.asking.get(id);
    if (!done) return;
    this.asking.delete(id);
    done({ answered: true, hit });
  }

  private askWindow(
    winId: string,
    client: { x: number; y: number },
    draw: boolean,
    whole = false,
    timeoutMs = 400,
  ): Promise<{ answered: boolean; hit: unknown }> {
    const win = winId === 'main' ? this.main : this.floating.get(winId);
    if (!win || win.isDestroyed()) return Promise.resolve({ answered: false, hit: null });
    const id = ++this.askSeq;
    return new Promise((resolve) => {
      this.asking.set(id, resolve);
      /*
       * 渲染层要是没应声（正在重载、或者那扇窗刚起来还没挂上监听），超时收场。
       *
       * 「它答了'没有落点'」和「它根本没答」是两件完全不同的事，以前都写成 null，
       * 排查时就只能猜。现在分开报。
       */
      setTimeout(() => {
        if (this.asking.delete(id)) resolve({ answered: false, hit: null });
      }, timeoutMs);
      win.webContents.send('drop:probe', {
        id,
        x: Math.round(client.x),
        y: Math.round(client.y),
        draw,
        // 问的是"一整块浮窗落哪"时，才认正中的「嵌成挂件」（见渲染层 probeAt）
        whole,
      });
    });
  }

  /**
   * 一次落点探测：光标落在哪个窗口的哪个位置。
   * `draw: false` 用在**松手那一刻** —— 结果马上就落地了，不需要再画一个提示框。
   */
  async probeAt(
    point: { x: number; y: number },
    excludeId?: string,
    draw = true,
    whole = false,
  ): Promise<DropResult | null> {
    const under = this.windowUnder(point, excludeId, 24);
    if (!under) return null;
    /*
     * 屏幕点换成「那扇窗页面里的坐标」时要**除掉它自己的乘区**。
     *
     * point / bounds 都是屏幕 DIP，而窗口里的 elementFromPoint 认的是 CSS 像素：
     * 界面缩放到 150% 时，窗口里 100 CSS px 的位置在屏幕上占 150 DIP，不除这一下，
     * 落点框会整个偏出去（而且是越靠右下偏得越多）。
     */
    const target = under.id === 'main' ? this.main : this.floating.get(under.id);
    const f = target && !target.isDestroyed() ? target.webContents.getZoomFactor() : 1;
    const ans = await this.askWindow(
      under.id,
      { x: (point.x - under.bounds.x) / f, y: (point.y - under.bounds.y) / f },
      draw,
      whole,
    );
    return { target: under.id, hit: ans.answered ? (ans.hit as DropHit | null) : null };
  }

  /** 把各窗口上留着的落点提示收掉 */
  clearProbe() {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('drop:probe:end');
    }
  }

  /** 光标底下是哪个窗口（浮窗在上，所以先看浮窗） */
  private windowUnder(
    point: { x: number; y: number },
    excludeId?: string,
    pad = 0,
  ): { id: string; bounds: Electron.Rectangle } | null {
    // pad：贴着边拖的时候，光标常常已经探到窗口外面去了。留一圈容差，
    // 那一圈仍然算作这扇窗 —— 「拖到软件的边上就并入」靠的就是它。
    const inside = (b: Electron.Rectangle) =>
      point.x >= b.x - pad &&
      point.x <= b.x + b.width + pad &&
      point.y >= b.y - pad &&
      point.y <= b.y + b.height + pad;

    for (const [id, win] of this.floating) {
      if (id === excludeId || win.isDestroyed() || !win.isVisible()) continue;
      // 正挂在光标下的那一块（刚撕下来的）不算落点：它就在光标底下、又永远在最上层，
      // 一问就问到它自己 —— 回上来的落点是它自己的标签栏，"拖到侧边并入"于是永远落不进去。
      // 要问的是它**下面**那扇窗。
      if (this.liveWindows.has(id)) continue;
      const b = win.getBounds();
      if (inside(b)) return { id, bounds: b };
    }
    const m = this.main;
    if (m && !m.isDestroyed() && m.isVisible() && inside(m.getBounds())) return { id: 'main', bounds: m.getBounds() };
    return null;
  }



  /**
   * 把 store 里的附属关系落到系统窗口上 —— 这一步才是"悬浮小窗"成立的关键。
   *
   * `setParentWindow` 之后，子窗口**永远显示在父窗口之上**，父窗口最小化时它也藏起来。
   * 只靠自己在 moved 里算位移是不够的：窗口会被宿主盖到底下，使用者一点宿主就看不见它了，
   * 效果等于没做。
   *
   * 注意 Win32 的 owned window **不会**跟着 owner 移动，所以位移仍然由 moveChildren 补，
   * 两件事各管一半，互不重叠。
   */
  private applyParent(windowId: string) {
    const win = this.floating.get(windowId);
    if (!win || win.isDestroyed()) return;

    const parentId = store.state.floating.find((w) => w.id === windowId)?.parent ?? '';
    if ((this.appliedParent.get(windowId) ?? '') === parentId) return;

    const target = !parentId ? null : parentId === 'main' ? this.main : this.floating.get(parentId) ?? null;

    try {
      win.setParentWindow(target && !target.isDestroyed() ? target : null);
      // 挂在别人身上的小窗是"辅助显示的工具"，不该再单独占一格任务栏
      win.setSkipTaskbar(Boolean(parentId));
      this.appliedParent.set(windowId, parentId);
    } catch (e: any) {
      console.error('[窗口] 建立附属关系失败：', e?.message ?? e);
    }
  }

  /** 宿主挪了，挂在它下面的浮窗跟着挪同样的位移 —— 这就是"附属"的全部含意 */
  private moveChildren(parentId: string, dx: number, dy: number) {
    if (!dx && !dy) return;
    for (const child of store.childrenOf(parentId)) {
      const win = this.floating.get(child.id);
      if (!win || win.isDestroyed()) continue;
      const [x, y] = win.getPosition();
      win.setPosition(x + dx, y + dy); // 它自己的 moved 会接着带它下面的，链式传下去
    }
  }

  /** 宿主收起来了，附属也跟着藏；恢复时一起回来 */
  private setChildrenVisible(parentId: string, visible: boolean) {
    for (const child of store.childrenOf(parentId)) {
      const win = this.floating.get(child.id);
      if (!win || win.isDestroyed()) continue;
      if (visible) win.showInactive();
      else win.hide();
    }
  }

  /**
   * 松手：把拖动会话和提示都收掉。
   * **落点不在这里算** —— 它要问光标底下那扇窗（probeAt），是异步的，
   * 由调用方拿到结果之后再决定这个窗口去哪儿。
   */
  endGrab(windowId: string) {
    this.grab.delete(windowId);
    this.clearProbe();
  }

  // ------------------------------------------------- 拖动途中就把标签撕下来
  // 浏览器那套：标签一离开标签栏，当场就是一块真窗口挂在光标下，松手只决定它落到哪。

  /** 撕下来的窗口先登记：建出来时不抢焦点、先不占任务栏 */
  markLive(windowId: string) {
    this.liveWindows.add(windowId);
  }

  /** 这块窗口是不是"刚被撕下来、正挂在光标下"的那一块 */
  isLive(windowId: string) {
    return this.liveWindows.has(windowId);
  }

  /** 它此刻真的在屏幕上吗（没上屏的那块窗口 = 一块丢在空里的面板） */
  isShown(windowId: string) {
    const win = this.floating.get(windowId);
    return Boolean(win && !win.isDestroyed() && win.isVisible());
  }

  /**
   * 撕下来那一刻：把光标在这块窗口里的相对位置钉住，之后它一直挂在这个偏移上。
   *
   * `anchor` 是渲染层量出来的**固定锚点**（光标该压在窗口里的哪一点，通常是它那个
   * 标签的中心）。**必须用这个常数**，不能在这里现算：现算是"当前光标 − 请求位置"，
   * 而请求位置是按**撕出来那一刻**的光标算的 —— 窗口建到上屏这几百毫秒里光标又挪了
   * 多少，偏差就永久留在这场拖动里。表现是拖得慢看着没问题、拖快了才偏。
   */
  beginLive(sourceKey: string, windowId: string, anchor?: { dx?: number; dy?: number }) {
    const win = this.floating.get(windowId);
    if (!win || win.isDestroyed()) return;
    const c = screen.getCursorScreenPoint();
    /*
     * 锚点取**请求的那个位置**（store 里的 rect），不取 getPosition()：
     * 窗口刚建出来还没上屏，系统可能已经按缩放比把它挪了一点，拿那个值当锚点，
     * 整场拖动都会带着这个偏差 —— 表现就是"指针离标签越来越远"。
     */
    const want = store.state.floating.find((w) => w.id === windowId)?.rect;
    const [px, py] = want ? [want.x, want.y] : win.getPosition();
    const [w, h] = win.getSize();
    // 没给锚点就退回"光标此刻在哪儿"，别再拿窗口位置反推（那正是偏移的来源）
    const dx = anchor?.dx ?? c.x - px;
    const dy = anchor?.dy ?? c.y - py;
    this.grab.set(windowId, { dx, dy, w, h });
    this.live.set(sourceKey, windowId);
    this.liveSeen.set(sourceKey, { at: Date.now(), x: c.x, y: c.y });
    this.liveBeat.delete(sourceKey);
    this.watchLive();
  }

  /**
   * 拖动期间的那条环路：**主进程自己读光标、自己挪窗口**，顺手算落点提示、顺带看门狗。
   *
   * 为什么不让源窗口每帧报点：撕下来的那块真窗口就挂在光标底下，指针已经在它身上了，
   * 源窗口那边随时收不到事件（捕获被系统收走）。一断，跟手就停在半路 ——
   * 面板定在那儿不动，看着像脱了手。主进程自己读光标，这条链路一步都不依赖渲染层。
   *
   * 收尾判据：光标停住 **并且** 没有任何"还按着"的证据，超过 liveIdleMs 才算这一拖结束。
   */
  private watchLive() {
    if (this.liveTimer) return;
    this.liveTimer = setInterval(() => {
      const now = Date.now();
      const c = screen.getCursorScreenPoint();
      for (const [key, id] of [...this.live]) {
        const seen = this.liveSeen.get(key);
        if (!seen || c.x !== seen.x || c.y !== seen.y) {
          this.liveSeen.set(key, { at: now, x: c.x, y: c.y });
          const at = this.moveTo(id);
          if (at) this.hintAt(id, at, now);
          continue;
        }
        const beat = this.liveBeat.get(key) ?? 0;
        const quiet = now - Math.max(seen.at, beat);
        if (quiet < this.liveIdleMs) continue;
        /*
         * 兜底收尾：光标停住、又没有任何"还按着"的证据，才认定这一拖结束了。
         * 阈值给得宽 —— 它是保险丝，不是主判据。主判据是松手那一下的真实事件；
         * 给窄了会误伤"按住不动瞄准落点"这个再正常不过的动作。
         */
        const done = this.endLive(key);
        if (done) this.onLiveStale?.(done.windowId);
      }
      if (!this.live.size && this.liveTimer) {
        clearInterval(this.liveTimer);
        this.liveTimer = 0;
      }
    }, 16);
  }

  /** 落点提示：把这个点交给**光标底下那扇窗**算，限流 80ms（每秒十来条，画起来照样连贯） */
  private hintAt(windowId: string, c: { x: number; y: number }, now: number) {
    if (now - this.lastProbe < 80) return;
    this.lastProbe = now;
    // 撕下来的那块本身就是一块浮窗：正中同样算落点（嵌成挂件）
    void this.probeAt(c, windowId, true, true);
  }

  /**
   * 把"发信号的那个窗口"翻译成本次撕下来会话的键。
   *
   * 两头都可能报：源窗口（键就是它自己）和撕下来那块新窗口（它是这一拖的**结果**，
   * 报上来的是它自己的 id）。所以先当键查，查不到再反查值 —— 两条路都认，
   * 哪一边先掉线都还有另一边兜着。
   */
  private liveKey(senderKey: string): string | null {
    if (this.live.has(senderKey)) return senderKey;
    for (const [key, id] of this.live) if (id === senderKey) return key;
    return null;
  }

  /**
   * 撕下来的窗口跟手移动：当渲染层发来指针移动信号时，立即以事件驱动更新窗口位置，
   * 避免低精度轮询产生的跳帧迟滞；同时更新存活心跳与落点提示。
   */
  moveLive(senderKey: string) {
    const key = this.liveKey(senderKey);
    if (!key) return;
    const now = Date.now();
    this.liveBeat.set(key, now);
    const windowId = this.live.get(key);
    if (windowId) {
      const c = screen.getCursorScreenPoint();
      this.liveSeen.set(key, { at: now, x: c.x, y: c.y });
      const at = this.moveTo(windowId);
      if (at) this.hintAt(windowId, at, now);
    }
  }

  /**
   * "还按着"的证据：拖动中收到指针事件（按钮还是按下状态）时报一句。
   *
   * 撕出来那块窗口就挂在光标底下，所以正常情况下是**它**在报 —— 它看得到按钮状态。
   * 光标底下换成别的窗口、或者松手了，它就报不出来了，证据自然枯掉、看门狗收尾。
   */
  tickLive(senderKey: string) {
    const key = this.liveKey(senderKey);
    if (!key) return;
    this.liveBeat.set(key, Date.now());
  }

  /**
   * 松手：这一拖结束、会话收掉，把「是哪块窗口」还给上层 —— 落点由上层去问
   * （要问光标底下那扇窗，是异步的，不能在这儿干等）。
   * 先取走会话再返回：两边同时收到松手时，后到的那个查不到 key，天然只落位一次。
   */
  endLive(senderKey: string): { windowId: string; sourceKey: string } | null {
    const key = this.liveKey(senderKey);
    if (!key) return null;
    const windowId = this.live.get(key)!;
    this.live.delete(key);
    this.liveSeen.delete(key);
    this.liveBeat.delete(key);
    this.finishLive(windowId);
    return { windowId, sourceKey: key };
  }

  /** 只结束会话、不做落点判定（这一拖又在源窗口内部就地停靠了） */
  dropLive(senderKey: string): boolean {
    const key = this.liveKey(senderKey);
    if (!key) return false;
    const windowId = this.live.get(key)!;
    this.live.delete(key);
    this.liveSeen.delete(key);
    this.liveBeat.delete(key);
    this.finishLive(windowId);
    return true;
  }

  /**
   * 新浮窗开多大：**正方形**，不照搬它原来占的那块。
   *
   * 原来照原样开，从一条宽标签栏里拖出来的就是一块宽板子 —— 浮窗是"临时拎出来看"
   * 的容器，宽度越大越没用（屏幕就那么大，宽扁的形状反而放不下内容）。取原来那块
   * **较短的那条边**当边长，出来是方的，往哪儿摆都通用；再夹到工作区六成以内。
   */
  floatSize(size?: { width?: number; height?: number }) {
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const cap = Math.max(360, Math.min(Math.round(area.width * 0.62), Math.round(area.height * 0.62)));
    /*
     * 这里进来的尺寸是**渲染层量的 CSS 像素**，而窗口要的是屏幕上的 DIP ——
     * 缩放开着的时候两者差一个倍数（见 windows.probeAt 的说明）。
     * 不乘这一下，界面放大到 150% 撕出来的浮窗会小一圈。
     */
    const base = Math.min(size?.width ?? 640, size?.height ?? 640) * getZoom();
    const side = Math.min(Math.max(420, Math.round(base)), cap);
    return { width: side, height: side };
  }

  /** 撕下来那块用同一套尺寸（见 floatSize） */
  tearSize(size?: { width?: number; height?: number }) {
    return this.floatSize(size);
  }

  private finishLive(windowId: string) {
    this.grab.delete(windowId);
    this.liveWindows.delete(windowId);
    this.topPinned.delete(windowId);
    const win = this.floating.get(windowId);
    if (win && !win.isDestroyed()) {
      win.setSkipTaskbar(false);
      win.setAlwaysOnTop(false);
      win.moveTop();
    }
    this.clearProbe(); // 提示收掉：别让别的窗口留着一个过期的落点框
    /*
     * 广而告之：这一拖到此为止。
     *
     * 每个渲染层都有一份"我这一拖交出去了"的状态（handedOff），它只能靠别人告诉它才清得掉。
     * 少发这一句，源窗口就永远以为自己还在交棒 —— 之后每一次松手都会被当成"这一拖的松手"
     * 而把动作吞掉，那个窗口也就点不动了。这类状态**必须由主进程统一宣布结束**。
     */
    this.sendAll('drag:end');
  }

  sendAll(channel: string) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel);
    }
  }

  cursorPoint() {
    return screen.getCursorScreenPoint();
  }

  /** 光标在屏幕角落时，新浮窗不能开到屏幕外面去 —— 把它夹进工作区 */
  /**
   * 新窗口开在哪：让**指针底下那一点**在窗口里的相对位置，和它原来在出发那一块里的位置一致。
   * off 不给就是老规矩（窗口左上角往指针的左上各让 60 / 24）。
   */
  clampIntoWorkArea(
    point: { x: number; y: number },
    size = { width: 780, height: 620 },
    off: { dx: number; dy: number } = { dx: 60, dy: 24 },
  ) {
    const area = screen.getDisplayNearestPoint(point).workArea;
    // 传进来的尺寸也夹一道：比工作区还大的窗口，怎么算都会顶出去
    const w = Math.min(Math.round(size.width), Math.max(320, area.width - 16));
    const h = Math.min(Math.round(size.height), Math.max(220, area.height - 16));
    return {
      x: Math.min(Math.max(point.x - off.dx, area.x + 8), Math.max(area.x + 8, area.x + area.width - w - 8)),
      y: Math.min(Math.max(point.y - off.dy, area.y + 8), Math.max(area.y + 8, area.y + area.height - h - 8)),
    };
  }
}

export const windows = new Windows();
