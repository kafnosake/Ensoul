import { t } from './i18n';
/**
 * CSP（Clip Studio Paint）那套可停靠面板系统的数据模型。
 *
 * 三条铁律，整个运行时都建立在它们之上：
 *
 *   1. **面板与位置分离。** Panel 只描述"我是什么"，绝不知道自己在哪里；
 *      位置由停靠树（DockNode）唯一决定。所以面板可以在主窗口的标签里、
 *      在切分出来的栏里、在某个浮窗里，位置随便换，面板本身不用重建。
 *
 *   2. **Dock 区域是一棵树。** 叶子是标签组（TabGroup），内部节点是切分
 *      （DockSplit）。主窗口是一棵树，**每个浮窗自己也是一棵树** ——
 *      所以浮窗里照样能有多个面板、能叠标签、能切分，而不是只能放一个东西。
 *
 *   3. **浮窗不是特殊面板。** 面板从停靠树里摘出来、放进一个浮窗的树里，
 *      就是"浮出来"；反过来放回主树，就是"停靠回去"。同一套结构，两个宿主。
 */

/**
 * 面板类型名。
 * 内置几种，但**类型本身是开放的** —— 新的面板类型由渲染层的注册表提供
 * （`src/renderer/panel/registry.tsx`），加一种面板只需要注册，不动核心代码。
 */
export type PanelKind = string;

/**
 * 四种工作模式 —— 会话框上方那四格。**只改提示词，不改工具表**（见 chat-core 的 WORK_MODE_RULES）。
 *
 * 为什么工具表不跟着切：① 工具表摆在请求最前面，它一变这块面板的 KV 缓存全废；
 * ② 「问答」模式本身就写着「用户要求时可以查看文件和 web search」—— 工具从表里删了，
 * 那句话当场兑现不了。（模式之间工具目录保持一致，就是为了这个。）
 */
export type PanelMode = 'auto' | 'guess' | 'chat' | 'exec';

/** 四格的顺序、名字、一句话说明 —— 界面按这个顺序画，别处不许再手写一份 */
export const WORK_MODES: { id: PanelMode; name: string; desc: string }[] = [
  { id: 'auto', name: t('自主'), desc: t('自己判断自己拍板：能做的直接做完') },
  { id: 'guess', name: t('推测'), desc: t('只了解与推理，按可能性排列，不动手') },
  { id: 'chat', name: t('问答'), desc: t('闲聊，默认不读文件不跑工具') },
  { id: 'exec', name: t('执行'), desc: t('按给定要求执行，不发散、不提方案') },
];

/**
 * 核心**自己画**的那几种面板。
 *
 * 插件的面板声明撞上这些一律不生效（内置赢）—— 一个插件不该把"对话"变成别的东西。
 * 后三种（files / pomodoro / todo）的原生版本：files 一直由核心画；
 * pomodoro 和 todo 的脸已经搬进各自的插件目录（plugins/<名>/panel.tsx），
 * kind 沿用旧名字，用户已经开着的那种面板才不会变成空白。
 */
export const BUILTIN_KINDS = ['chat', 'files', 'editor', 'table', 'form', 'web'] as const;

/**
 * 是不是**组件** —— 判据有两条，缺一不可：**面板上有组件声明**（`Panel.component`），
 * 而且它**不是员工工作面**（`Panel.noWorkspacePrompt`）。
 *
 * **类型不算数**：表格、番茄钟、网页面板没声明就还是普通面板，关上一样落进「历史会话」；
 * 声明过的那块，家就在**组件库**（设置 → 组件）—— 关不关都在里面，只有用户点删除才会没。
 * 分家的两处按它走：关闭面板时回存、组件库里列条目。
 * "进没进顶上那条收纳区"是**另一件事**，看 `pinned` —— 声明不等于钉住。
 *
 * ── 员工为什么不算组件（这条是补上的）─────────────────────────────────
 *
 * 一个 AI 员工是**一个人**，不是一份可复用的做法：他的身份、岗位提示词、固定模型都在
 * 他的角色卡（`.ensoul/state/agents/<id>.json`）里，那块面板只是他**此刻的工作面**。
 * 把它列进组件库会同时坏两件事：一是名册和组件库成了两份"谁是谁"，
 * 二是"克隆一个"这种动作对一个人根本没有意义（克隆出来的不是第二个他）。
 * 所以员工工作面在自己的分区里管（设置 → 员工，由 dispatch 插件供数据），
 * 关掉时和其它没声明的面板一样落进「历史会话」—— 员工本人的名册照旧在。
 */
export function isComponentPanel(p: { component?: string; noWorkspacePrompt?: boolean }): boolean {
  if (p.noWorkspacePrompt) return false;
  return !!(p.component && p.component.trim());
}


export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 工具跑动中挂在对话里的一个"进行中"容器（生图、下载、长构建这类慢活）。
 *
 * 为什么不落盘、也不挂在 ChatMessage 上：它只在这一轮跑的时候有意义 ——
 * 存下来的话，重启之后界面上会挂着一个假的"生成中 3/28"永远转下去。
 * 跑完的图另走一条路（挂到那条助手消息的 images 上），那才是要留住的东西。
 */
export interface LiveTask {
  /** 同一个 key 覆盖更新：一次出图从头到尾就用一个 key */
  key: string;
  /** 一行字说清在干什么 */
  label: string;
  /** 细节那一行：`采样 7/28 · 已等 12 秒` */
  note?: string;
  /** 0-100；null / 不给 = 不确定（画一条来回滚的条，别编一个百分比出来） */
  percent?: number | null;
  /** 过程预览图（磁盘绝对路径）—— 有就摆在容器里，就是生成中那张草稿 */
  preview?: string;
}

/**
 * 断了正在重连（交给界面显示「重连 3/5 · 连接断了」）。
 *
 * 为什么它住在这里而不是消息上：重连是**这一轮正在发生的事**，跑完就没了；
 * 而它又不是"一条回复的内容"——它讲的是一次临时故障。落盘只会留下一个永远转不完的
 * "正在重连"（跟 LiveTask 同一个理由）。
 */
export interface RetryView {
  /** 这是第几次重连（从 1 起） */
  attempt: number;
  /** 最多几次 —— 摆出 "3/5" 才有"它还在努力"的感觉，只写"正在重连"像卡住了 */
  max: number;
  /** 为什么断的（已经翻成人话，如"连接断了"） */
  label: string;
  /** 这次要等多久（毫秒） */
  delayMs: number;
}

/** 一次推给界面的"此刻进行中的东西"—— 整份快照，不是增量（就这么点数据） */
export interface LiveView {
  tasks: LiveTask[];
  /** 这一轮已经送进对话的图（磁盘路径） */
  images: string[];
  /** 此刻在不在重连（null = 没有） */
  retry?: RetryView | null;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  edited?: boolean;
  createdAt: number;
  streaming?: boolean;
  /**
   * 这条消息带的图，存的是**磁盘绝对路径**而不是 base64。
   * 截图塞进 workspace.json 会让这个文件越滚越大，读一次全量 JSON 就卡一次。
   */
  images?: string[];
  /** 这条回复的账：用量、速度、用时、动了哪些文件、评分、花了多少钱 */
  stats?: ChatStats;
  /**
   * 这一轮助手做过的动作，一行一条（工具 + 参数摘要 + 结果的第一句）。
   *
   * 两个用处：界面上让用户一眼看到它到底干了啥；以及下一轮把它附在历史里
   * 重新发给模型 —— 不给的话模型对上一轮是全盲的，会把同样的文件从头再读一遍。
   */
  actions?: string[];
  /**
   * 这一轮真实发出的工具调用，结构化存档 —— 下一轮按 OpenAI 的 tool_calls / tool
   * 消息格式原样回放。模型认的是这个结构：文字骨架它分不出真假，看着看着就学会
   * 用文字画一个"调用记录"交差（生图轮报了动作却没提交任务，就是这么来的）。
   * args 是模型当时写的 JSON 原文；result 存的时候已截断（noteTool 里截到前 1200 字）。
   */
  toolCalls?: { id: string; name: string; args: string; result: string }[];
  /**
   * 这条用户消息是**插话**（跑到一半插进去的），不是开场那一轮。
   *
   * 界面上据此换个说法（"插话"而不是"我"）；下一轮拼历史时它和普通用户消息
   * 一样进请求 —— 模型确实读过它，历史里就必须有它。
   */
  steer?: boolean;
  /**
   * **进历史、不上屏**的一条用户消息 —— 插件注入的机器触发语（"某某交活了，接着办"）。
   *
   * 为什么不干脆不进对话：模型干完活回头一看，得知道**自己为什么跑这一轮**。
   * 历史里没有它，下一轮就是一段"它自己忽然动起来"的空白。
   * 那为什么不干脆显示：那不是人说的话 —— 用户没说过，凭什么在他的对话里冒充"我"。
   * 所以两样都要：进历史（模型看得见）、不上屏（用户看不见）。
   */
  silent?: boolean;
  /**
   * 这一轮是**怎么收场的** —— 三者必须分得开，插件靠它决定能不能自动恢复：
   *   · done     正常跑完
   *   · stopped  用户按了停止 —— 那是意图，谁都不许把它重新叫起来
   *   · failed   上游断了（传输中断 / 超时 / 空回复）—— 这才是事故
   *
   * 判据本来就是现成的（ctrl.signal.aborted），以前只是被丢掉了：收尾那处把
   * 「失败」和「用户按停」合并成同一个 failed，插件那侧也就分不出来。
   */
  endReason?: 'done' | 'stopped' | 'failed';
  /** endReason = failed 时是哪一类断的（FailCode 原样，认不出来就是空） */
  failCode?: string;
}

/**
 * 一条**还没发出去**的话：用户趁它在跑的时候敲的那句。
 *
 * 两种去处，语义完全不同：
 *   · `queue`  —— 排队：等这一整轮跑完，当成新的一轮发出去；
 *   · `steer`  —— 插话：在**步骤边界**领走，直接喂进正在跑的这一轮。
 *     用户按下去的那一刻它还没跑完、但手头这一步做完的时候，插话就介入了。
 *
 * 存**磁盘路径**不存 data URL：这份东西跟着面板落进 workspace.json，
 * 塞几张 base64 进去，之后每次全量读写都要序列化几 MB（和 shots 同一个理由）。
 *
 * 队列落在面板上（`Panel.outbox`）—— 它是"这个面板还有话要说"，重启也该还在；
 * 插话盒子只在内存（见 index.ts），因为它针对的那一轮重启之后就没了。
 */
export interface OutboxItem {
  id: string;
  text: string;
  images?: string[];
  at: number;
  taskId?: string;
  taskWorkspace?: string;
}

export type TaskStatus = 'queued' | 'running' | 'cancelling' | 'cancelled' | 'completed' | 'failed' | 'interrupted';
export interface TaskRequest {
  panelId: string;
  text: string;
  title: string;
  requestId: string;
  correlationId?: string;
}
export interface TaskRecord extends TaskRequest {
  id: string;
  workspace: string;
  originPanelId: string;
  parentTaskId?: string;
  parentRunId?: string;
  runId?: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  endedAt?: number;
  result?: string;
  error?: string;
  tokens?: number;
  delivery?: { files: string[]; at: number };
  acceptance?: { at: number; note: string };
}
export interface TaskContext { panelId: string; runId?: string; taskId?: string; }
export interface TaskApi {
  submit(request: TaskRequest, context: TaskContext): { ok: boolean; task?: TaskRecord; reused?: boolean; error?: string };
  get(id: string, panelId?: string): TaskRecord | undefined;
  request(requestId: string, panelId: string): TaskRecord | undefined;
  list(panelId?: string): TaskRecord[];
  cancel(id: string, panelId?: string): { ok: boolean; error?: string };
  cancelCorrelation(id: string, panelId: string): { ok: boolean; error?: string };
  delivered(id: string, panelId: string, files: string[]): void;
  accept(id: string, panelId: string, note?: string): { ok: boolean; error?: string };
}

/**
 * 单价一律是**元 / 百万 token** —— 下面 PriceTier 与 TokenPrice 都用这个单位。
 *
 * 输入分两档是因为现在各家都按"命中上下文缓存"打折：命中价通常只有
 * 非命中价的十分之一；输出另算一档。要算钱就必须知道这三档分别是多少。
 */
/**
 * 峰谷价里的一段：在这段时间内改用这组单价。
 *
 * 时间写 `HH:MM`，按**本机时区**算 —— 各家公布的峰谷时段时区不一样，
 * 这一层不替用户换算，配置里写几点就是本机几点。
 * 起点含、终点不含；跨零点就把终点写得比起点小（如 22:00 → 02:00）。
 */
export interface PriceTier {
  from: string;
  to: string;
  hit: number;
  miss: number;
  out: number;
}

/** 某时刻生效的三档单价；配了 `tiers` 就按时刻挑段（见 providers.ts 的 resolvePrice） */
export interface TokenPrice {
  /** 命中缓存的输入 */
  hit: number;
  /** 没命中的输入 */
  miss: number;
  /**
   * 分时价（峰谷）：按消息发生的时刻挑**第一条**命中的段。
   * 没命中任何段、或者根本没配 tiers，就落回上面那三个数 ——
   * 所以不分时的模型照旧只写 hit/miss/out，老配置一个字都不用改。
   */
  tiers?: PriceTier[];
  /** 输出 */
  out: number;
}

/** 一轮（或一条会话累计）实际花的钱，按三档分开记，加起来是实价 */
export interface ChatCost {
  hit: number;
  miss: number;
  out: number;
  /** 实际总价 = hit + miss + out */
  total: number;
}

export interface ChatStats {
  tokensIn?: number;
  tokensOut?: number;
  total?: number;
  /** 输入里命中上下文缓存的那部分（按命中价算钱） */
  cacheHit?: number;
  /** 输入里没命中的那部分（按非命中价算钱）—— 等于 tokensIn - cacheHit */
  cacheMiss?: number;
  /**
   * 这一轮是哪个模型（`provider::model`，就是会话区那个选择器的值）。
   *
   * 为什么要记下来：钱是按**模型**算的（各家价不同、还有免费模型），
   * 而一条账里只有三个 token 数时分不出它是哪一笔 —— 光看 `price` 也不行，
   * 单价是当时那一刻的快照，事后换过模型就对不回名字了。
   * 旧记录里没有这个字段，当空串看。
   */
  pick?: string;
  /**
   * 这一轮用的单价快照：钱是按当时的价算的，之后换模型不该把旧账算歪。
   *
   * 三种取值要分清，显示端全靠它区分"没记录"和"真没有"：
   *   undefined → 这条是旧版本留下的记录，当时还没有单价这回事
   *   null      → 这一轮查过单价，但这个模型没配
   *   TokenPrice→ 正常
   */
  price?: TokenPrice | null;
  /** 这一轮实际花的钱 */
  cost?: ChatCost;
  /** 用时（毫秒） */
  ms?: number;
  /** 结束时的时间戳 */
  at?: number;
  /** 这一轮改了哪些文件 */
  files?: string[];
  rating?: 'up' | 'down' | null;
}

/** 面板的渲染规格：声明式，因此可持久化、可回退、可被对话改写 */
export interface PanelSpec {
  body: 'messages' | 'code' | 'table' | 'form' | 'web';
  systemPrompt: string;
  actions: { id: string; label: string; prompt: string }[];
  fields: { key: string; label: string; type: 'text' | 'number' | 'bool' }[];
  text: string;
  ptcMode?: boolean;
}

export interface PanelLook {
  accent: string;
  density: 'compact' | 'normal' | 'roomy';
  showChat: boolean;
  /**
   * 预设头像的**家族键**（dev / monitor / art …，见 shared/panel-avatars.ts）。
   *
   * 只存"定下来的那个家族"，**不存第几张** —— 家族内 6 选 1 由面板 id 哈希现算，
   * 存了反而要多养一份会过期的状态。定了之后就不再重算：改标题、再给关键词
   * 都不会让列表里的脸跳一下。
   *
   * 缺省（老面板）= 渲染层按 kind / 标题现算兜底。
   */
  avatarKey?: string;
}

/**
 * 面板：内容单元。**它自己就是一个对话框**（chat 是它和用户的对话史，
 * 用来改写它自己）。这里没有任何关于位置的字段 —— 那是停靠树的事。
 */
/**
 * 悬浮面板的位置与大小。
 *
 * **位置存的是比例，不是像素。** rx / ry 是"可移动范围"（区域尺寸减自身尺寸）
 * 的比例：0 = 贴左/上，1 = 贴右/下。
 *
 * 为什么不能存绝对像素：区域是会缩的（窗口拉小、并排的另一半变大、整棵树重排），
 * 而存在 (594, 332) 的挂件不会知道这件事 —— 它照旧待在 594 那儿，
 * 而那块区域可能只剩 400 宽了，于是挂件被甩到画面外，用户再也够不着它。
 * 换算成比例之后，母体一缩它就按同一个相对位置贴回去，永远在框里。
 *
 * 大小仍是像素（一块钟不该因为窗口变小就缩成邮票），只在渲染时夹进区域里。
 */
/**
 * **挂件窗口**的状态（见 Panel.widget）。
 *
 * 它自己是一扇系统窗口，所以这里只有"窗口该怎么摆、长什么样"——
 * 没有宿主、没有区域：它不是嵌在谁身上，它是独立的一扇。
 *
 * 位置用**像素**（跟 PanelFloat 的比例相反）。为什么这次可以写死像素：
 * 它不属于任何一块会缩放的区域，没有"母体缩了它得按比例跟着缩"这件事；
 * 它就在屏幕上那个位置，用户拖到哪儿就是哪儿。
 */
export interface PanelWidget {
  /** 窗口位置与大小（屏幕 DIP 像素） */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 背景透明（挂件的形象本身不是方盒子时用；缺省不透明） */
  transparent?: boolean;
  /**
   * 常驻置顶 —— **缺省就是置顶**（挂件本来就是"压在上面看"的东西）。
   * 想让它能被别的窗口盖住就显式写 false。
   */
  onTop?: boolean;
  /** 跳过任务栏（挂件不该在任务栏里占一格）。缺省 true */
  skipTaskbar?: boolean;
  /**
   * 铺一层**近黑卡面** —— 桌面组件（桌面上摆着的那块小卡片）用它。
   *
   * 为什么不能靠"不透明窗口"顶上：圆角得靠**窗口透明**才铰得出来。窗口一旦不透明，
   * 四角就是方的、网页那圈圆角会被窗口底色填成直角，看着就是"外面还套着一个黑矩形"
   * （见 docs/desktop-and-theme-plan.md 的外观一节）。所以声明 card 的挂件窗口一律透明，
   * 底色与圆角由页面里那层卡面自己画。
   *
   * 跟 transparent 的分界：那个是"形象有轮廓、整扇窗都可以透"（桌宠那类），
   * 这个是"要一张有边有角的卡"。两者只挑一个用。
   */
  card?: boolean;
}

export interface PanelFloat {
  /** 属于哪个窗口：`'main'` 或浮窗 id */
  host: string;
  /** 依附在哪一块区域（标签组 id）—— 它的归属，渲染也渲染在那块区域里面 */
  anchor: string;
  /** 横向位置：可移动范围的比例 */
  rx: number;
  /** 纵向位置：可移动范围的比例 */
  ry: number;
  width: number;
  height: number;
  /**
   * 锁住（**缺省就是锁住**）。
   *
   * 挂件摆好之后就只是一块内容，不该再被误碰 —— 桌面歌词那条规矩：
   * 锁着的时候拖动带、改大小、解除**全都不存在**（不是盖住而是根本没渲染），
   * 鼠标贴上去只露出一个小锁按钮；点开它才进入"可以摆弄"的状态。
   *
   * 只有 `false` 是解开。旧数据没有这个字段 = 锁住，与新版默认一致。
   */
  locked?: boolean;
  /** @deprecated 旧版存的是相对区域左上角的绝对像素；读到就折算成 rx / ry，之后只写比例 */
  x?: number;
  y?: number;
}

/**
 * 把一个像素落点折算成**比例**（0 = 贴左/上，1 = 贴右/下）。
 *
 * 分母取"可移动范围"而不是区域尺寸：这样贴边的挂件缩放后还贴边，
 * 居中的还居中 —— 按区域尺寸算的话，区域一变宽，原本靠右的挂件会往中间跑。
 */
export function floatRatio(pos: number, region: number, size: number): number {
  const slack = Math.max(1, region - size);
  return Math.round(Math.min(1, Math.max(0, (pos || 0) / slack)) * 10000) / 10000;
}

/**
 * 一张便签：用户说的那一句，下面挂着它下一轮回答里标出来的信息。
 *
 * **它不进模型上下文，也不参与历史裁剪** —— 这正是它的全部意义：
 * 那是给用户回头翻的记录，不是对话的一部分。历史会被裁掉、压成摘要，便签不会。
 *
 * 便签由 `plugins/notes` 从对话里剪出来、写进 `.ensoul/state/notes.json`，
 * 界面只是读那个文件显示 —— **核心不认识便签**，所以这里只有数据形状。
 */
export interface PanelNote {
  at: number;
  /** 用户开口说的那句（已经剪短，能一眼看完） */
  text: string;
  /** 紧接着那轮回答里用 ==…== 标出来的几条 */
  marks: string[];
}

/**
 * 面板的**工作情况** —— 标签名边上那个点点的颜色就是它。
 *
 *   idle    没在工作（灰）
 *   working 正在跑这一轮（蓝，固定状态色 --busy，不跟强调色走）
 *   done    这一轮干完了（绿）
 *   error   这一轮失败了、或者被用户按了停止（红）
 *   confirm 干完了，但回复最后是个问句 —— 它在等用户回话（黄）
 *
 * 为什么住在核心而不是插件：什么时候"开始工作 / 干完 / 出错"只有主进程的
 * `chat:send` 知道，插件拿不到这个生命周期（没有这种钩子），轮询也看不出来 ——
 * 一轮跑起来时助手那条消息要到结束才会进 panel.chat，中途面板上一个字都不多。
 * 所以状态由核心在对话的几个节点上写，点点只负责把它画出来。
 */
export type PanelStatus = 'idle' | 'working' | 'done' | 'error' | 'confirm';

export interface PanelRevision {
  at: number;
  kind?: PanelKind;
  title: string;
  look: PanelLook;
  spec: PanelSpec;
  note: string;
}

export interface Panel {
  id: string;
  title: string;
  kind: PanelKind;
  /**
   * **组件声明** —— 值就是声明里那个名字。
   *
   * 面板**不被声明就不是组件**，跟它是什么类型没关系：表格、番茄钟、网页面板关上一样
   * 落进「历史会话」。声明过的那块，家就在组件区 —— 关不关都在架子上，
   * 本体存 `components/<id>.json`，只有用户在 设置 → 组件 里点删除才会没。
   */
  component?: string;
  /**
   * **收进收纳区**（顶上那条）—— 钉住这个组件实例，条上就有它的入口。
   *
   * 跟 `component` 是两件事：声明 = 它进组件库、被永久保存（关不关都在）；
   * 钉住 = 它同时占着顶上一格。**声明不会自动钉住** —— 存为组件之后顶上那条不会多一条，
   * 想挂上去得自己把面板拖进那段（或者去 设置 → 组件 点「收进收纳区」）。
   * 撤下来叫**释放**：条目从顶栏消失，本体一个字节不动，库里那一条照旧在。
   */
  pinned?: boolean;
  /** 正在编辑的文件（相对工作区根）—— 只有文本面板会用 */
  file?: string;
  look: PanelLook;
  spec: PanelSpec;
  /** 工作情况（点点的颜色）；没写过当 idle 看 —— 老面板不用补数据 */
  status?: PanelStatus;
  /**
   * 会话列的宽度（px）—— 会话区左右那两条几乎看不见的边拖出来的结果
   * （见 `src/renderer/panel/chat/useSessionWidth.ts`）。
   *
   * 为什么存在面板上：宽度是**这个面板**的会话区有多宽，重启一次、换台机器都该还在。
   * 它**不是**便签的东西 —— 便签是右边缘那条宽度为 0 的刻度，住在这一列的留白里，
   * 两者只是住得近，谁也不读谁。
   */
  chatW?: number;
  /**
   * 这块面板自己的缩放（Ctrl + 滚轮调的那一个）。缺省 = 1。
   *
   * 跟**全局**缩放是两件事：全局动的是整个界面（所有窗口、所有面板一起），
   * 真源在主进程的 zoom.ts，走 Electron 原生缩放；这一个只放大这一块面板的内容
   * （Ctrl+滚轮指着它就调它），落在面板自己身上、跟着面板走。
   *
   * 为什么不放进 look：look 是「这块面板的做法」的一部分 —— store 靠
   * “look 里还有没有键”判断做法搬过家没有（见 hasCraft）。缩放是运行期的显示偏好，
   * 塞进去会让“空做法”重新变得非空，搬家判定当场错乱。chatW 当初也是这个道理。
   */
  uiZoom?: number;
  /**
   * 输入框里**还没发出去**的那段话 —— 切标签、换窗口、重启之后都还在
   * （存法见 `src/renderer/panel/chat/drafts.ts`）。
   *
   * 为什么存在面板上：它是**这个面板**的草稿，不是某个组件的临时状态。
   * 标签组里切来切去时那个组件会卸载重挂（DockTree 上是 key={active.id}），
   * 挂在组件里就会没。粘进草稿的图**不在这儿** —— data URL 太大，只留内存。
   */
  draft?: string;
  /**
   * 完全权限：**这一个会话**能不能读写工作区之外的路径。
   *
   * 默认关 —— 工作区就是边界。它**按会话算**：一块面板开着，别的面板照样夹在工作区里。
   * 为什么住在面板上：一个面板就是一个会话，权限该跟它自己走 ——
   * 以前这是整个工作区一个开关，在任何一块面板上点一下，所有会话一起变成了完全权限。
   */
  fullAccess?: boolean;
  /**
   * **这一个会话的工作模式**（会话框上方那四格）。不写 = auto（自主）—— 老面板一个字不用改。
   *
   * 四种模式**共用同一张工具表**，差别只在系统提示末尾那一段（见 chat-core 的
   * WORK_MODE_RULES）：切模式不动工具表，请求前缀才不废。
   *
   * 为什么住在面板上：模式是**这个会话**此刻的规矩，跟权限（fullAccess）同一个道理 ——
   * 一块面板切了，别的会话照旧。
   */
  mode?: PanelMode;
  /**
   * **这块面板只给这几个工具**（工具名清单，见 `toolsFor` 的 `allow`）。
   *
   * 不写 = 全给（老面板一个字不用改）。给员工配的那一套"工具套件"最终就落在这儿 ——
   * 一个岗位该有哪些手脚，是**这个岗位的属性**，该跟着面板走。
   *
   * 为什么不每轮现算：工具表摆在请求最前面，**它一变，这块面板的 KV 缓存全废**。
   * 所以清单只在建面板（或用户明确改）时写一次，之后每轮都一样。
   */
  tools?: string[];
  /**
   * **模型锁定**：这块面板用角色卡上指定的那个模型，会话区不再让换。
   *
   * 为员工面板而设 —— 一个岗位用什么模型是**这个岗位的属性**（写在他的角色卡里），
   * 不该是每次对话随手能改的东西。锁上之后输入框那颗模型按钮只读。
   * 落点跟手动选模型是同一份（`panelModels`），只是不给界面换的入口。
   */
  lockedModel?: boolean;
  /**
   * **我是员工面板** —— dispatch 开工作面时打的标（建面板的插件打，读它的两处互不认识，只认这个字段）：
   *   · agents-md：工作区根下那份 AGENTS.md / CLAUDE.md（全局提示词）不发给这块面板；
   *   · chat-core：系统提示走 **agent 底座**（buildAgentSystemPrompt，约 700 字），不发编辑器那 3200 字
   *     —— 员工只干活不改软件，build/restart、面板体系、编辑提案那些纪律对他全是噪声。
   *
   * 于是员工的提示词 = agent 通用底座 + 他角色卡上那份专属提示词（【你的岗位】），
   * 全局说明和编辑器说明都不在里面。
   */
  noWorkspacePrompt?: boolean;
  /**
   * **待发队列**：趁它还在跑的时候先敲好、排在后面等着的那些话。
   *
   * 这一整轮一结束，队首那条自动发出去，成为新的一轮 —— 用户可以一口气把
   * 接下来几件事都先摆上，不用盯着它什么时候停下。队列落在面板上，重启也还在。
   *
   * 跟**插话**是两条路：插话不在这儿（它只在内存里，见 index.ts），因为它针对的是
   * 此刻正在跑的那一轮，一旦那一轮结束就没有意义了。
   */
  outbox?: OutboxItem[];
  chat: ChatMessage[];
  /**
   * 跑着的那一轮的**实时账**（进行中的累计用量）。
   *
   * 它**不落盘、也不进界面** —— 只由 `plugins()` 在交给插件看的那份快照里临时
   * 贴上来（见 store.setLiveStats），让用量状态条在整轮跑完之前就能一轮轮往上涨，
   * 中途按停也不会把这一局显示成 0。已经跑完的那部分在消息自己的 `stats` 里，
   * 两者不会同时为真 —— 结尾时实时账就被清掉、换成正式的那条。
   */
  live?: ChatStats;
  /**
   * 正在跑的那一轮的**正文**（那条还没进 `chat` 的助手消息），跟 `live` 一样只贴在
   * 交给插件看的快照里 —— 不落盘、不进界面。
   *
   * 为什么要有：助手那条消息要到整轮跑完才进 `chat`，插件光看 chat 就永远是
   * "跑完了才吐出来"。想做流式（eschat 的员工对话"有多少转多少"）就得看得见它。
   * 注意它只带正文 —— 思维链走的是另一条通道，从来不在 `content` 里。
   */
  liveTurn?: ChatMessage;
  revisions: PanelRevision[];
  /** 回退反悔栈（重做）：回退出来的版本暂存在这里，支持双向恢复，防止用户点错 */
  redoRevisions?: PanelRevision[];
  /**
   * 悬浮：有值就**脱离停靠树**，绝对定位浮在宿主窗口的工作区上方。
   *
   * 拖到某块区域的**正中**就是这样 —— 像一张贴在界面上的便签：不占布局空间，
   * 旁边面板的大小不受影响，它自己还能拖、能拉大小。拖到标签栏上即归位。
   */
  float?: PanelFloat;
  /**
   * **挂件窗口**：这块面板不住在任何窗口的停靠树里，而是**自己是一扇系统窗口** ——
   * 无边框、可透明、常驻置顶，压在所有程序上面（桌宠、桌面时钟、状态灯这一类）。
   *
   * 跟 `float` 的分水岭（两个都叫"浮"，但差着一层）：
   *   · `float`  浮在**宿主窗口里**的一块便签。宿主最小化它就没了，也出不了 ensoul 的窗。
   *   · `widget` 自己就是**一扇窗口**。主窗口关了它还在，能压到别的软件上面。
   *
   * 代价跟着来：它不占布局、也就不会被停靠树带着走，位置得自己记（存的是**像素**，
   * 因为它不属于任何一块会缩放的区域 —— `float` 那套比例在此地没有母体可依）。
   *
   * 清理逻辑（store.cleanup）本来会把不在树里的面板当孤儿收回主标签组，
   * `float` 和 `hidden` 是被放过的两个 —— `widget` 是第三个。
   */
  widget?: PanelWidget;
  /** 收回挂件时保存的桌面位置，用于撤销收回。 */
  widgetReturn?: PanelWidget & { returnedAt: number };
  /**
   * 后台面板：**活在面板表里，但不在任何停靠树上** —— 不占布局、界面上一个字都不显示，
   * 却照样收得到消息、照样把这一轮跑完，对话照旧落在自己的 chat 里。
   *
   * 为什么必须有这个概念：AI 员工的会话是"开着但不该占地方"的。
   *   · 关掉（closed/）→ 收不到消息了，那是"结束"，不是"在后台"
   *   · 浮成便签（float）→ 还在界面上飘着，也不叫后台
   * 而清理逻辑（store.cleanup）本来会把不在树里的面板当孤儿收回主标签组，
   * `float` 是它唯一放过的 —— `hidden` 是第二个豁免。
   *
   * 谁在用：plugins/eschat（eschat）—— 员工平时就这么待着，面板只负责显示。
   */
  hidden?: boolean;
  /**
 * 压缩记录。
   *
   * 历史涨到模型上下文窗口的 80% 时，把最旧的那一段交给模型摘要，
   * **逐字保留最近的 16%**。原文**一条都不删**：它还在 chat 里，界面上照样能翻，
   * 只是被摘要覆盖到的那一段不再原样送出去。摘要累积在这里。
   */
  compact?: {
    summary: string;
    /** 摘要覆盖到 chat 的第几条 —— 这之前的原文不进请求，但一条没丢 */
    upTo: number;
    at: number;
    /**
     * `/<压缩>` 这类"另起一个分支"的压缩留下的原本上下文：从对话区挪到这里隐性保存，不在界面上显示。
     * 这是它和 /clear 的分水岭 —— /clear 连这份存档一起清掉，这里留着，翻得回来。
     */
    archive?: ChatMessage[];
  };
  /**
   * **广播里的摘要素描** —— 只有 publicState() 发出去的那一份带它，主进程内存里和
   * panel:body 拉回来的那一份都没有。
   *
   * 为什么要有它：广播是"只要有改动就发给每个窗口"的，而面板正文（chat / compact /
   * revisions）十几 MB。骨架 + 这几个数字发出去，侧栏照样画得出未读和最后一句，
   * 一次广播从 14 MB 掉到几十 KB。渲染层靠"有没有 summary"判断这份是不是摘要版。
   */
  summary?: {
    count: number;
    lastText?: string;
    lastUserText?: string;
    lastImage?: string;
    assistantIds?: string[];
    replyAt?: number;
    askingAt?: number;
  };
  /**
   * 提示词合并器与增量生效状态：
   * activeBase: 当前冻结在 systemPrompt / 前缀里的基底（只在压缩或新建会话时更新）。
   * pendingDeltas: 热会话期间修改规则产生的增量变更（发 1 次后标记已消费，并在下次压缩时收敛进 activeBase）。
   */
  promptState?: {
    activeBase?: string;
    pendingDeltas?: Array<{
      id: string;
      title?: string;
      text: string;
      createdAt: number;
      appliedOnce?: boolean;
    }>;
  };
  origin: 'user' | 'ai';
  createdAt: number;
  updatedAt: number;
  /** 被关掉的时间。关掉的面板收在 closed 里，不是真删 —— 手滑还能捞回来 */
  closedAt?: number;
}

/** 标签组：一个停靠位置的若干面板叠成标签 */
export interface TabGroup {
  type: 'tabs';
  id: string;
  panels: string[];
  active: string | null;
}

/** 切分：左右（row）或上下（column）并排两个 Dock 区域 */
export interface DockSplit {
  type: 'split';
  id: string;
  direction: 'row' | 'column';
  ratio: number;
  children: [DockNode, DockNode];
}

export type DockNode = TabGroup | DockSplit;

/** 浮窗：自己也是一棵停靠树，所以它里面还能放面板、叠标签、切分 */
export interface FloatingWindow {
  id: string;
  rect: Rect;
  root: DockNode;
  /**
   * 附属在谁身上：`'main'` 或另一个浮窗的 id。没有 = 独立窗口。
   *
   * 把浮窗拖到另一个窗口的**正中间**就会挂上去，像把文件放进文件夹：
   * 宿主挪它就跟着挪，从宿主那儿拖走就解除。悬浮小窗就是这么摆出来的 ——
   * 宿主是大窗口，附属是贴在它上面的那块小的。
   */
  parent?: string;
}

/**
 * 模型接口配置 —— **只存在后台**（`%APPDATA%\ensoul\model.json` 或环境变量）。
 * 前台永远看不到密钥，也没有地方填它。
 */
export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  /** 默认模型 */
  model: string;
  /** 后台指定的可选模型名单；留空就去问接口要 /v1/models */
  models?: string[];
  /** 提供方 key —— 决定思考水平用哪套字段名（见 chat-core 的 thinkParams） */
  provider?: string;
  /**
   * 这个会话的思考水平：空串 = **不发任何思考参数**（跟没这个功能时一模一样），
   * 另外四档是 off / low / medium / high。
   */
  think?: string;
}

/**
 * 下发给窗口的东西：只够显示和选择，没有任何密钥。
 * 模型本身来自 harness 的提供方配置（`settings.yaml` + `.credentials.yaml`）。
 */
export interface ModelInfo {
  /** 当前模型的显示名 */
  model: string;
  /** 当前选中项，形如 `provider::model`；空串表示还没选过 */
  pick: string;
  hasKey: boolean;
}

/**
 * 编辑器里一共两种窗口：主窗口和浮窗。
 * **每一个窗口都可以用自己的一套模型 api** —— 键是宿主标识：
 * `'main'` 或浮窗的 id；没有配就继承全局默认（model.json / 环境变量）。
 *
 * 这是**窗口级**的兜底。面板自己选的模型比它更优先 —— 见 `panelModels`：
 * 同一个窗口里的两个会话可以各用各的模型，互不牵连。
 */
export type HostKey = string;
export const MAIN_HOST: HostKey = 'main';

/** 整个工作区：面板表 + 主窗口的树 + 浮窗列表 + 每个窗口的模型 api */
export interface Workspace {
  panels: Record<string, Panel>;
  layout: DockNode;
  floating: FloatingWindow[];
  /**
   * 挂件窗口（见 Panel.widget）—— 面板被摆成独立小窗的那几块。
   * 索引：面板 id + 那扇窗的位置大小。窗口层靠它开窗，渲染层靠它知道"这一块在哪扇窗里"。
   */
  widgets?: { panelId: string; box: PanelWidget }[];
  /**
   * 每个**会话**（面板）此刻用哪个模型 —— 键是面板 id。
   * 浮窗的宿主 id 也在里面，那是"这个窗口里没单独选过的面板"的兜底。
   */
  models: Record<HostKey, ModelInfo>;
  /** 工作区根目录 —— 一个工作区就是一个长期项目目录，在左上角切换，不在设置里 */
  workspace: string;
  /** 最近开过的工作区目录，新的在前 */
  recentWorkspaces?: string[];
  /** 插件挂的状态部件（按面板分好，渲染层直接画）。`slot` 说它挂哪一条：composer = 输入框那排，head = 会话框顶上 */
  status?: Record<string, { id: string; slot: 'composer' | 'head'; text: string; title?: string }[]>;
  /**
   * 插件注册的斜杠命令（输入框敲 / 时的候选弹层）。
   * 只有能过 IPC 的那几个字段 —— handler 留在主进程，执行从来不经过界面。
   */
  commands?: { id: string; label?: string; hint?: string }[];
  /**
   * 收纳区（编辑器顶上那一条）的入口 —— **只有索引，不带本体**。
   * 面板可能正开着，条目照旧在（入口是持久的，打开不消费）。
   * 一个面板可能带着十几万字的对话，进广播就是每次都拖着它走，
   * 所以这里跟"最近关闭"一个套路：广播里只放够画一条入口的字段。
   *
   * 这份索引**不落盘**：主进程启动时、以及每次收纳/关闭回存/删除之后，
   * 扫一遍 `components/` 目录重建它 —— 目录才是真相，
   * 索引写进 workspace.json 早晚会和文件对不上（恢复备份时就撞过）。
   */
  componentRefs?: ComponentRef[];
  /** 收纳区最多摆几个，超出的收进右边的「»」下拉 */
  componentBarMax?: number;
  /** 收纳区/组件的手动排序顺序（组件 id 列表，支持手动拖拽排序且使用/释放后不自动重排） */
  componentOrder?: string[];
}

/**
 * 收纳区里的一条 —— **只是索引**。
 *
 * 本体（**整个面板**：对话、草稿、修订、状态）单独存在 `components/<id>.json` 里，
 * 和「最近关闭」的 `closed/<id>.json` 同一个套路。
 * 面板 id 收起来时不变，所以打开它就是把**同一个面板**放回去，不是照它复制一个。
 *
 * 条目是**持久入口**（快捷方式）：打开不消费它，文件一直留着；
 * 面板开着时入口点亮，关闭时状态回存进这份文件。少一条只能是用户在设置里手动删的。
 *
 * 这张表是**组件库全表**（`pinned` 标出谁同时挂在顶栏）——
 * 顶上那条只画 `pinned` 的：声明 ≠ 钉住，存为组件不等于收进收纳区。
 */
export interface ComponentRef {
  id: string;
  name: string;
  kind: PanelKind;
  /** 组件声明里那个名字 —— 没有声明的东西进不了这张表（`isComponentPanel` 只认它） */
  component?: string;
  /** 有没有钉在顶上那条收纳区 —— 没钉的只在 设置 → 组件 里躺着，条上不占格 */
  pinned?: boolean;
  /** 收进来的时间（= 本体文件的 mtime） */
  savedAt: number;
  /** 本体有多大 —— 列表里给个直观的量，不用把文件打开 */
  bytes: number;
  /** 本体文件名 */
  file: string;
  /**
   * **这台机器上还没有它的本体** —— 它只存于工作区里那份做法（`.ensoul/library/components/`）。
   *
   * 什么时候出现：换台机器 clone 下来。做法跟着仓库走、对话留在原来那台机器上，
   * 所以那台机器上这一页照样列着它；点「打开」就照做法站起来一块，对话从零开始。
   */
  craftOnly?: boolean;
  /** 做法那份文件的文件名（`craftOnly` 时有）—— 界面用它说清"这份是从哪来的" */
  craftFile?: string;
}

/** 收纳区默认摆几个 —— 没人改过就用这个 */
export const DEFAULT_COMPONENT_BAR_MAX = 8;

/**
 * 老版本存的**面板组件**：一份模板，只有 kind + look + spec，**没有对话**。
 *
 * 收藏夹改成按运行时收纳面板之后，"模板"这条路就没了 —— 这个类型只剩升级时
 * 被读一次的用途：`Store.migrateLegacyComponents()` 把每条模板摊成收纳区里
 * 一个还没聊过的面板，老收藏一条都不丢。
 */
export interface PanelComponent {
  id: string;
  name: string;
  kind: PanelKind;
  look: PanelLook;
  spec: PanelSpec;
  /** 从哪个面板存下来的（只是让人好认，不建立依赖） */
  from?: string;
  createdAt: number;
}

/**
 * 「最近关闭」里的一条 —— **只是索引**。
 *
 * 面板本体单独存在 `closed/<id>.json` 里，不进 workspace.json：
 * 一个面板可能带着十几万字的对话，混进主状态文件会让"启动全量读、保存全量写"
 * 变成灾难。所以主文件里只留够列表显示的几个字段。
 */
export interface ClosedRef {
  id: string;
  title: string;
  kind: PanelKind;
  closedAt: number;
  /** 本体有多大 —— 列表里给个直观的量，不用把文件打开 */
  bytes: number;
  /** 本体文件名 */
  file: string;
}

/** 主进程内部用的完整形态：模型选择分**会话级**和**窗口级**两层，密钥不在这里 */
export interface WorkspaceFull extends Omit<Workspace, 'models'> {
  /**
   * 窗口级：键是宿主（'main' 或浮窗 id），值是那个窗口选的模型名。
   *
   * 现在选模型只落在**会话**上（`panelModels`），这一层是老的兜底数据 ——
   * 只在"上一次手动选过的"（`lastPick`）也没有时才用得上。
   */
  windowModels: Record<HostKey, string>;
  /**
   * **会话级**：键是面板 id，值是 `provider::model`。面板自己选过就自己用，
   * 没选过的落到 `lastPick`（上一次手动选过的），再没有才是老的窗口级 / 内置默认。
   * 换个模型不连累别的会话，靠的就是这一层。
   */
  panelModels?: Record<string, string>;
  /**
   * **上一次手动选过的模型**（`provider::model`）。
   *
   * 新开的窗口 / 新面板自己没选过时先落在这儿，而不是直接掉回预设的默认 ——
   * 用户上一次挑的那个，才是他下次最可能想要的。落点已经不存在了（提供方被删、
   * 模型被去掉）就跳过它，退到内置默认。
   */
  lastPick?: string;
  /**
   * 思考水平：键跟 `panelModels` 同一套（面板 id 或宿主 key），值是 off / low / medium / high。
   * **没存就是不发参数** —— 老工作区因此一个字节都不用迁移，行为也不会变。
   */
  thinks?: Record<string, string>;
  /** 被关掉的技能名 —— 默认全开，所以新写一个技能不用登记就能用 */
  disabledSkills?: string[];
  /** 被关掉的插件名 */
  disabledPlugins?: string[];
  /** 老版本的模板组件 —— 迁移失败的条目才留在这儿，迁移成功后是空的 */
  components?: PanelComponent[];
}

/**
 * 一个技能：某个技能根里的一份 `SKILL.md`（或根上的一个 `.md`）。
 * 系统提示只带 name 和 description，正文由 use_skill 按需取。
 *
 * 技能根有多个（工作区 `.ensoul/skills`、`.agents/skills`、
 * 插件自带的、用户级的、软件自带的），所以这里带上 "它从哪来"。
 */
export interface SkillInfo {
  name: string;
  description: string;
  /** 什么时候该用 —— 写进系统提示那一行，帮模型判断要不要取正文 */
  whenToUse?: string;
  /** 在它那个根里的相对位置，形如 comfyui-draw */
  dir: string;
  /** 正文文件的**绝对**路径 */
  file: string;
  bytes: number;
  enabled: boolean;
  /** 来源标签，形如「工作区 .ensoul」 */
  source: string;
  /** 来自哪个根（绝对路径） */
  root: string;
}

/**
 * 插件自带的**一种面板类型**。
 *
 * 为什么是纯数据：它要经过 IPC 给到渲染进程，函数过不去（也不能过去）。
 * 所以插件只说"我要一种叫 pomodoro 的面板、菜单里叫番茄钟、新建时正文长这样"，
 * 拼出一个面板（标题、外观、spec 的默认值）由渲染层照这份声明做。
 *
 * 脸（React 组件）住在插件目录的 `panel.tsx` 里，由渲染层扫 `plugins/<名字>/panel.tsx`
 * 自动收走 —— **加一种插件面板不用再回来改核心的 registry**。这就是这一整套的意义。
 */
export interface PluginPanelDecl {
  /** 类型名，存进 `Panel.kind`。别撞内置的那几种（撞了内置赢，插件那条会被忽略） */
  kind: string;
  /**
   * 同一个脸还认哪些旧 kind（如便签插件同时认 `notes` 和 `sticker`）。
   *
   * 为什么放在插件这边：老存档里存的是 kind 名，改名就得让旧名继续能开；
   * 而"哪些旧名还算数"是**这个插件**的知识，核心不该替它记一份。
   */
  aliases?: string[];
  /** 新建菜单里显示的名字 */
  label: string;
  /** 菜单里的一句说明 */
  hint?: string;
  /** 新建时的默认标题；不写就用 label */
  title?: string;
  /** 正文形态，默认 messages */
  body?: PanelSpec['body'];
  /** 初始正文 */
  text?: string;
  /** 覆盖外观（默认跟内置工具面板一样：不带会话栏） */
  look?: Partial<PanelLook>;
  /**
   * 浮起来时壳上不画底（见 PluginPanelDecl.floatBare）：只有自己带底的挂件才声明它。
   * 不声明 = 照旧要底，会话/文件/编辑器浮起来照样是实心一块。
   *
   * 同时它还管**鼠标穿透**：声明了它的挂件，矩形里透明的地方不吃鼠标（漏给底下的
   * 面板），要自己那块实心件写 pointer-events:auto 才点得着 —— 见 core 的 float.css。
   */
  floatBare?: boolean;
}

/**
 * 插件面板的"脸"能拿到的东西 —— 一张脸只被允许碰这四样：
 * 自己是哪个面板、改自己的正文、改自己的其它字段、读写工作区里的文件。
 *
 * 刻意不给全量 api：脸跑在渲染进程，核心内部（停靠树、对话、持久化）不该被一张
 * 插件脸绕过去。要给脸更多能力时，先问"这是不是又一个别人绕着你走的邀请函"。
 */
export interface PanelFaceProps {
  panel: Panel;
  setText(text: string): void;
  /** 改自己的其它字段（标题、外观……） */
  patch(patch: Partial<Panel>): void;
  /** 读写工作区里的文件，相对路径；跟对话里那些工具走的是同一道门 */
  fs: {
    read(rel: string): Promise<string>;
    readJson(rel: string): Promise<import('./json-snapshot').JsonSnapshot>;
    write(rel: string, text: string): Promise<{ ok: boolean; error?: string }>;
    /**
     * 列一个目录（含每个文件的大小）。**给脸一个"先看大小再读"的口子** ——
     * 快照文件可能被撑过 fs:read 的 300KB 上限，那时 read 回来的是一句占位文字，
     * 喂进 JSON.parse 就是白屏一次（头像内联撑爆快照那次就是这么来的）。
     */
    list(rel: string): Promise<{ name: string; dir: boolean; path: string; size: number }[]>;
  };
}

/**
 * 插件声明的一个**可调参数**。
 *
 * 为什么参数要有"声明"这一层：插件跑在主进程，得有个地方让**用户和助手**同时看见
 * "这个插件能调什么、现在是多少"。声明在这儿（纯数据，能过 IPC 到设置面板），
 * 值统一存在 `.ensoul/state/plugin-params.json` —— 设置面板照着声明画控件、
 * 助手走 `plugin_params` 工具改同一份值（见 plugins/plugin-kit），两边不各搞一套。
 *
 * 只有**真需要调**的东西才该声明成参数：每多一条，设置面板和助手的上下文都得为它付一份钱。
 */
export interface PluginParamDecl {
  key: string;
  /** 设置面板里显示的名字 */
  label: string;
  type: 'text' | 'number' | 'bool' | 'select';
  /** 没设过、或者恢复默认时用这个 */
  default: string | number | boolean;
  /** 一句说明：这个参数影响什么 */
  hint?: string;
  /** type=number：上下限与步长（超出会被夹回去） */
  min?: number;
  max?: number;
  step?: number;
  /** type=select 的选项 */
  options?: { value: string; label: string }[];
  /**
   * 选项**不在声明里写死**、由核心现填：`'models'` = 软件里配好的模型清单。
   *
   * 为什么要有它：模型清单是运行时的（用户随时加提供方、删模型），而声明是插件装进来那一刻
   * 就读走的静态数据 —— 光靠 `options` 表达不了。值就是 `提供方::模型`（会话区那个 pick）。
   */
  optionsFrom?: 'models' | 'audio-inputs';
  /** 要写一整段话的（提示词片段之类），设置面板给多行输入 */
  multiline?: boolean;
}

/**
 * 插件能在设置里**单开一个分区**（`api.addSettingsSection`）。
 *
 * 为什么要有这个口子：有些东西既不是"一块面板"也不是"一个工具" ——
 * AI 员工的编制就是这种。它是**一份名单**（谁在岗、谁睡着、什么岗位、哪个模型），
 * 该在设置里有自己的一页；可插件跑在主进程，画不了界面。
 * 于是分工照旧：**插件交数据，核心画**。
 *
 * 交的数据刻意只有"一列行 + 每行的几个按钮"这一种形状 ——
 * 不给插件写 React 的机会（那等于又开一套插件体系），也不为某一个插件定制界面。
 * 行是纯数据（要过 IPC）；点按钮时核心把 `(actionId, rowId)` 递回插件，插件自己干活。
 */
export interface PluginSettingsAction {
  id: string;
  label: string;
  /** 鼠标指上去的一句解释 */
  hint?: string;
}

/** 一页里能就地调的东西 —— 目前只有「挑个模型」这一种 */
/**
 * 一页里能就地调的东西。
 *
 *   models  挑个模型（下拉，选项来自本软件的模型清单）
 *   text    填一句话（文本框）—— 「装个新插件」这种事：包名 / 仓库地址 / 本地路径
 *           没法做成几个固定选项，用户得自己打字，所以要有这一格。
 *   switch  一个开/关（滑动小扣子）—— 有些东西不是一个"值"，是一个**状态**：
 *           开着就一直在，关掉才撤。这种用按钮表达不了（按一下只是"做一次"，
 *           而这里要的是"一直开着"），桌面覆盖层就是这种。
 */
export type PluginSettingsInline = 'models' | 'text' | 'switch';

/**
 * 这一行是**一条记录**还是**一个操作**。
 *
 * 为什么非分不可（踩过）：以前只有"一行"这一种形状，于是"装个新插件""插件根部"
 * 这类**控件**也混在记录里 —— 结果两件坏事一起来：导航上的数字把它们算成了插件
 * （4 个真插件显示成 6），界面上又照插件的样子画出来（一个控制插件的东西，
 * 自己长得像一个插件）。控件不是记录，得在数据里就说清楚。
 */
export type PluginSettingsRowRole = 'item' | 'control';

/** 分区里的一行 —— 一条记录 + 它能干的那几下 */
export interface PluginSettingsRow {
  id: string;
  /**
   * 默认 'item'（一条记录，会进导航计数）。
   * 'control' = 这一行是个操作入口（装新的、指到某个目录）：**不算记录**，
   * 界面上也走另一套排版 —— 它控制的东西不该长得像它控制的对象。
   */
  role?: PluginSettingsRowRole;
  /** 主要那一列（员工就是姓名） */
  title: string;
  /** 第二列：解释性的一句话 */
  desc?: string;
  /** 行尾那一小块（状态、时间这类短标记） */
  meta?: string;
  /**
   * 这一行要**就地调**的东西。声明了它就多画一个控件 —— 有些值别处再也放不下
   * （员工卡上的模型：它的家在看板上，可调它的手却在设置里）。
   */
  inline?: PluginSettingsInline;
  /** 上面那个控件此刻的值（inline = models 时就是 提供方::模型，空串 = 没指定） */
  value?: string;
  /** inline = text 时框里那行灰字：告诉用户该往里填什么 */
  placeholder?: string;
  actions?: PluginSettingsAction[];
}

/** 一个分区此刻的内容 —— 插件现算，核心照着画 */
export interface PluginSettingsView {
  /** 分区顶上的一段说明（可以写多段，按行拼） */
  note?: string;
  /** 顶上那行回执（上一次点按钮的结果）；空串就不显示 */
  reply?: string;
  rows: PluginSettingsRow[];
  /** 没行的时候显示什么 */
  empty?: string;
}

/** 侧栏导航里的一条：哪个插件开的、叫什么、有几条（列表本身不带 rows，点进去才拉） */
export interface PluginSettingsRef {
  plugin: string;
  id: string;
  label: string;
  hint?: string;
  /** 这一页的行会给行内控件留位置（`PluginSettingsRow.inline`）—— 界面照它决定列怎么排 */
  inline?: PluginSettingsInline;
  count: number;
  /**
   * 想排在哪一页**正下方**（内置页 id，如 'model'）。不填 = 排在所有内置页之后。
   *
   * 为什么要有它：插件分区原来一律坠在内置页末尾，那是"没意见"时的默认。
   * 可有些分区跟某一页本就是同一件事 —— 桌面组件这个开关和"模型"都属于
   * **进设置第一眼要调的东西**，隔着好几页才找得到就白摆了。声明锚点，它贴着那一页站。
   */
  after?: string;
  /**
   * 这一页属于**哪一拨**：'main' 挂在横线上方，'extension' 挂在下方。
   *
   * 为什么由声明说了算：以前这条线谁在下面、按什么次序，是渲染层一张写死的
   * 插件名表（EXTERNAL_ORDER）说了算 —— 那意味着"要下载才有"这件事
   * 只有改源码才能改，而它本该跟着插件自己的声明走。不填 = 'main'。
   */
  group?: 'main' | 'extension';
  /**
   * 排在**哪一页的正下方**，并且缩进一级 —— 可以是任意分区 id，不再只认内置页。
   *
   * 为什么要放开：插件宿主里的子插件（image-gen / cny-cost 这类）经
   * `installSection` 注册成自己的分区，它们本就属于「扩展插件」这一家；
   * 以前锚点只认内置页 id，于是这些子分区只能跟 MCP、扩展插件**平级**排着，
   * 看上去像三件互不相干的东西。
   */
  parent?: string;
  /** 同组的默认次序（用户拖动排序之前的那一份默认；拖动结果另存，见 navOrder） */
  order?: number;
}

/**
 * 一个插件注册进来的工具。设置面板要逐条显示它 ——
 * 光有名字的话，"这个工具到底干什么"在界面上就没地方看见。
 */
export interface PluginToolInfo {
  name: string;
  /** 注册时给模型看的那句说明，原样带出来 */
  description: string;
  /** 所属的套件组列表（如果声明了） */
  kits?: string[];
}

/** 一个插件：某个插件根里的 `plugins/<名字>/index.js` */
export interface PluginInfo {
  name: string;
  description: string;
  /** 相对所在根，形如 plugins/file-backup 或 .ensoul/plugins/xxx */
  dir: string;
  /** 它注册进来的工具名 */
  tools: PluginToolInfo[];
  /** 它自带的面板类型（没有就是纯后台插件） */
  panel?: PluginPanelDecl;
  enabled: boolean;
  /** 来自哪个根：「软件自带」还是「工作区」 */
  source: string;
  /** 加载或 setup 出错时的原因 —— 有错的插件照样列出来，不然用户找不到 */
  error?: string;
  /** 它声明的可调参数（没有就是没参数可调）—— 设置面板照着这份声明画控件 */
  params: PluginParamDecl[];
  /** 这些参数**此刻生效的值**（声明里的默认值已填好）；改过哪些，跟 default 比一下就知道 */
  values: Record<string, string | number | boolean>;
}

/**
 * 插件注册工具时给的声明。形状跟 agent 的 ToolSpec.function 一致，
 * 但不从 agent.ts 引类型 —— 插件是外部的，不该依赖主进程内部结构。
 */
export interface PluginToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * 这个工具至少要哪一档权限才给模型看见。
   * 不写就是 `full`（最保守）—— 只有「工作区对话」那种高权限面板能用。
   * 纯读的或者只是记事的插件工具（联网查资料、写任务清单）可以自己降到
   * read / write，这样编辑器面板里的小对话也能用上。
   */
  level?: 'read' | 'write' | 'full';
  /**
   * 只在这些**面板类型**（kind）上出现。不写 = 每块面板都给。
   *
   * 权限（level）管"这块面板有没有资格用"，这个管"这块面板上用它有没有意义" ——
   * 两回事。画布那两个工具就是前者够、后者不够：别的面板上根本没有画布，
   * 给了它也只能回一句"不知道是哪块画布"，却照样每轮占着一份 schema 的钱。
   */
  scope?: string[];
  /** 声明所属的员工套件组池（如 ['art', 'media']） */
  kits?: string[];
  /** 单次调用允许的最长毫秒数，超时则统一熔断并返回 TOOL_TIMEOUT 错误码 */
  timeoutMs?: number;
}

/**
 * 拖放落点，三分：
 *   · `tabs`   → 顶部标签栏，并进那一组标签
 *   · `center` → 正中，脱离布局浮在工作区上方（小窗）
 *   · 四边     → 在那旁边切分出新的停靠区
 */
export type DropMode = 'tabs' | 'center' | 'left' | 'right' | 'top' | 'bottom';

/**
 * 落点指向哪个宿主里的哪个标签组。
 *
 * `root: true` 是四边落点的另一种解读：不是「在这一块旁边」，而是
 * 「在**整棵树的最外层**分一块」—— 侧窗要的是这个，它和窗口里原来分了
 * 几块无关，总是把整扇窗口一分为二。两种都由落点判定给出来，不是用户选的。
 */
export type DockTarget =
  | { where: 'main'; tabId: string; mode: DropMode; root?: boolean }
  | { where: 'floating'; windowId: string; tabId: string; mode: DropMode; root?: boolean };

export const isTabGroup = (n: DockNode): n is TabGroup => n.type === 'tabs';
export const isSplit = (n: DockNode): n is DockSplit => n.type === 'split';

/**
 * 布局切片里的一块面板 —— 只记**长什么样**，不记**是哪一个**。
 *
 * 为什么带 id：切片记的是**这一批面板各自的摆法**。切回来时按 id 找**原来那一块**，
 * 绝不按类型去猜（猜就会张冠李戴），更不会凭空开出一块新的来补位（那就是克隆）。
 * id 和 kind 都是开放的，不认任何名单：新插件的面板照样存得进、摆得回；面板没了就空着。
 */
export interface SketchSlot {
  /** 是**哪一块**面板 —— sketchLayout 当时记下的那个 id */
  id?: string;
  kind: PanelKind;
  title: string;
  look: PanelLook;
  spec: PanelSpec;
  /** 正在编辑的文件（相对工作区根）；只有文本面板会带 */
  file?: string;
}

/**
 * 一份布局的**骨架**：跟 DockNode 同构，只是叶子从 panelId 换成了槽位。
 *
 * 隐藏面板（后台会话）和悬浮便签不进骨架 —— 它们本来就不占布局。
 */
export type SketchNode =
  | { type: 'tabs'; slots: SketchSlot[]; active: number }
  | { type: 'split'; direction: 'row' | 'column'; ratio: number; children: [SketchNode, SketchNode] };

/**
 * 一份存下来的布局切片。
 *
 * 存哪儿由**用它的人**决定（界面把它写成 .ensoul/state/layout-presets.json）：
 * 核心只认上面那个 SketchNode 的形状，不认识这个包装。
 */
export interface LayoutPreset {
  id: string;
  name: string;
  at: number;
  sketch: SketchNode;
  /**
   * 原生全景快照能力：
   * 1. 浮窗树与坐标（多窗口布局与位置）
   * 2. 嵌入挂件/桌面小窗列表与尺寸
   * 3. 侧边监视台显隐状态
   * 4. 全局视距缩放倍率
   */
  floating?: FloatingWindow[];
  widgets?: { panelId: string; box: PanelWidget }[];
  sidebar?: boolean;
  zoom?: number;
}

export function defaultSpec(kind: PanelKind): PanelSpec {
  return { body: kind === 'editor' ? 'code' : 'messages', systemPrompt: '', actions: [], fields: [], text: '' };
}

export function defaultLook(): PanelLook {
  return { accent: '#5b8cff', density: 'normal', showChat: true };
}

export const emptyRect = (): Rect => ({ x: 0, y: 0, width: 780, height: 620 });
