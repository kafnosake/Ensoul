import * as fs from 'fs';
import * as path from 'path';
import { appPath, userDataPath } from './paths';
import { clearStorageRegistrations, migrateRuntimeData, registerProjectStorage, registerWorkspaceStorage, runtimePath } from './storage';
import { environmentDirectory, registerPythonEnvironment } from './environments';
import { assertPanelActive, currentPanelSignal, workspaceRoot, safePath, writeText } from './fsapi';
import { addSkillRoot as regSkillRoot, dropSkillRoots as unregSkillRoots } from './skills';
import { store } from './store';
import * as W from './workspace';
import type {
  ComponentRef,
  LiveTask,
  Panel,
  PanelFloat,
  PanelWidget,
  PluginInfo,
  PluginPanelDecl,
  PluginParamDecl,
  PluginSettingsRef,
  PluginSettingsView,
  PluginSettingsInline,
  PythonEnvironmentRef,
  PluginToolSpec,
} from '../shared/types';
import { MAIN_HOST } from '../shared/types';
import { t } from '../shared/i18n';
import * as i18n from '../shared/i18n';
import type { BuildTarget, BuildResult, BuildScope } from './project-build';
import type { TaskApi } from '../shared/types';
import { fileWrites, type FileWriteHook } from './file-writes';

/**
 * 插件：一个目录里的 `index.js`，CommonJS，导出一个对象。搜索两个根，先出现的赢：
 *
 *   <应用目录>/plugins/<名字>/index.js      —— 跟着软件走的能力
 *   <工作区>/.ensoul/plugins/<名字>/index.js —— 跟着这个项目走的能力
 *
 *   module.exports = {
 *     name: 'file-backup',
 *     description: '写文件前自动留一份备份',
 *     setup(api) {
 *       api.addTool({ name: 'restore_backup', description: '...', parameters: {...} },
 *                   (args) => '...');
 *       api.onBeforeWrite((rel, next) => { ... });
 *     },
 *   };
 *
 * ── 为什么是这几个口子 ────────────────────────────────────────────────
 *
 * 自我进化真正需要的是这几件事，**每一条都对应一个真用上的插件**（见 plugins/）：
 *
 *   addTool(spec, handler)   加工具              todo / jobs / web
 *   onBeforeWrite(fn)        挂在写文件之前      file-backup（改写前留底）
 *   onBeforeTool(fn)         挂在工具执行之前    restart-approval（重启之前先问用户）
 *   onReasoning(fn)          接住模型的思考流    thinking-log（思考链原样落盘）
 *   ask(spec)                请用户点个头才继续   restart-approval
 *   addPrompt(fn)            每轮往提示里加一段   todo（把当前任务清单摆回它面前）
 *   addSummaryNote(fn)       压缩时才问一次的快照   notes（便签要点进摘要；不实现就没有）
 *   state                    一小块持久状态      todo / jobs / web 都在用
 *   param / setParam         插件**自己声明**的可调参数   pomodoro / file-backup（见它们导出的 params）
 *   allParams / setPluginParam  给"让助手调参数"的插件用   plugin-kit
 *
 * 工具处理器和 addPrompt 都会拿到这一刻的 `ctx`（在替哪个面板干活）——
 * 所以没有再单开一个 `api.ctx`：同一件事只留一个入口。
 *
 * 想改界面、加 IPC、动停靠树 —— 那些直接改核心更省事，多开一个口子就多一份
 * 别人绕着你走的复杂度。
 * **没人用的口子不要留**：它看着像能力，其实是"别人绕着你走"的邀请函。
 * 真要加新的（比如"工具调用之后"），写第一个需要它的插件时再加。
 *
 * ── 实例是**留住**的，不是每条消息重新造 ──────────────────────────────
 *
 * 以前每条消息都 `delete require.cache` 再 require 一次，图的是"改了立刻生效"，
 * 代价是插件每次都得从头再来 —— 一个要连外部进程的插件（比如 MCP）会每轮重连一次。
 * 现在实例留着，靠**文件的修改时间**判断要不要重载：改了才重来，没改就接着用。
 * 于是 setup 可以异步做准备，工具准备好了随时 addTool 进来，下一轮就能用。
 *
 * 一个坏插件不能把软件带下水：加载失败只记一条错，其余插件照常加载。
 */

/** 插件目录名 —— 应用目录下那个 */
const DIR = 'plugins';

export interface ToolContext {
  toolCallId?: string;
  /** 这一刻在替哪个面板干活 */
  panelId: string;
  /** 那个面板住在哪个宿主（'main' 或浮窗 id） */
  host: string;
  /** 面板类型（chat 的权限更高） */
  kind: string;
  runId?: string;
  taskId?: string;
  signal?: AbortSignal;
}

export interface PluginTool {
  spec: PluginToolSpec;
  handler: (args: any, ctx: ToolContext | null) => Promise<string> | string;
  plugin: string;
}

/** 一条斜杠命令能过 IPC 的部分 —— 界面只画这些，handler 留在主进程 */
export interface SlashCommandView {
  id: string;
  label?: string;
  hint?: string;
}
/** 注册进来的斜杠命令（完整版，含执行函数） */
export interface SlashCommandReg extends SlashCommandView {
  handler: (args: string, ctx: ToolContext | null) => Promise<string> | string;
  plugin: string;
}
export type BeforeWrite = (rel: string, next: string) => void;
export type PromptFn = (ctx: ToolContext | null) => string;

/**
 * 一条注册进来的提示片段，连同它认不认面板类型。
 *
 * 不写 `scope` = 每块面板都给（老插件一个字不用改）。写了 = 只在这些 kind 上出现。
 * 跟工具的 `scope` 是同一套判断，理由也一样：便签属于"每块面板都有自己的一份"，
 * 而组织花名册、画布现状这类东西只在特定面板上有意义 —— 后者每轮挂在别的面板上，
 * 就是"B 丢下自己的活去干 A 的事"那条来路。
 */
export interface PluginPrompt {
  fn: PromptFn;
  scope?: string[];
}

/** 一个 `{ scope }` 选项读成干净的字符串数组；空数组/没写 = 不限 */
export function readScope(o?: { scope?: string[] }): string[] | undefined {
  const s = o && Array.isArray(o.scope) ? o.scope.filter((x) => typeof x === 'string' && x) : [];
  return s.length ? s : undefined;
}

/**
 * 压缩历史时被问一次的那句话（`api.addSummaryNote`）。
 *
 * 形状跟 PromptFn 一样，区别全在**什么时候被调**：那个每轮都跑，所以只能放小的、
 * 会变的东西；这个一轮压缩里至多调一次，插件尽管现算。
 */
export type SummaryNoteFn = (ctx: ToolContext | null) => string;

/**
 * 压缩那一刻被问一次的那个问题（`api.addCompactPick`）：**这次用哪个模型写纪要？**
 *
 * 形状跟 SummaryNoteFn 一样，答的却是另一件事 —— 那个答"有什么不能丢的"（内容），
 * 这个答"谁来干"（用哪个模型）。时机完全一样：只在真要压缩那一下问一次，所以不占每轮的钱。
 * 返回 `provider::model`，空串 = 谁也没意见，用这块面板自己选的那个。
 */
export type CompactPickFn = (ctx: ToolContext | null) => string;

/** 一次工具调用 —— 插件据此决定放不放行 */
export interface ToolCall {
  toolCallId?: string;
  name: string;
  args: any;
  /** 在替哪个面板干活 */
  ctx: ToolContext | null;
}

/**
 * 挂在工具**执行之前**。返回一句话 = 拦下这次调用，把这句话当作工具结果交给模型；
 * 返回空 = 放行。
 *
 * 和 onBeforeWrite 不是一回事：那个只能看"要写进去的内容"，这个能拦住任何工具 ——
 * 包括跑了就收不回来的那种（把自己这个进程杀掉）。
 */
export type BeforeTool = (call: ToolCall) => Promise<string | void> | string | void;

/** 一次已经跑完的工具调用 —— 结果还没落盘裁剪，插件看到的是原始那一份 */
export interface ToolDone {
  toolCallId?: string;
  name: string;
  args: any;
  ctx: ToolContext | null;
  result: string;
  status?: 'ok' | 'error';
  durationMs?: number;
}

/**
 * 挂在工具**执行之后**、结果交给模型之前。能看，也能改：
 * 返回一句话 = 就用这句话当结果（返回空串也算改，就是"结果清空"）；
 * 返回 undefined / 空 = 原样放行。
 *
 * 为什么要有这一段：只有 before 那一段的话，插件只能"拦"，拦完这件事就没了 ——
 * 统计用了哪些工具、把某次构建输出抄进项目笔记、把一段结果改写成更省字的样子，
 * 这些都得看得见**结果**才做得了。
 */
export type AfterTool = (done: ToolDone) => Promise<string | void> | string | void;

/**
 * 接住模型的**思考流**（`reasoning_content` / `reasoning` / `thinking` 那些 delta）。
 *
 * 为什么要有这一段：思考在核心里是"只过手、不留存"的 —— `chat-core` 把它交给
 * `onReasoning` 之后就撒手了，正文里没有它、发给模型的下一轮历史里没有它、
 * 盘上更没有它。想留住它（落盘、记账、拿去做别的活）就需要一个**看不见正文的
 * 地方**接一手，而不是把"思考要存下来"这件事写回核心。
 *
 * 传的是 delta 不是整段：一段思考有多长事先不知道，攒起来是接的人的事。
 * `panelId` 说明这口思考是谁的 —— 同一刻可能有好几块面板在跑。
 * 一轮里思考**可能来好几段**（写一段正文、又想一段），delta 之间不带边界标记。
 */
export type ReasoningFn = (panelId: string, delta: string) => void;

/**
 * 一个插件能在设置里单开的分区（`PluginHost.addSettingsSection`）。
 *
 * 声明和内容都在这一份里：`view()` 现算（进页面、点完按钮各调一次），
 * 所以插件不必自己缓存界面，也不会给出过期的一份。
 */
export interface SettingsSectionSpec {
  id: string;
  label: string;
  hint?: string;
  placement?: 'more';
  /**
   * 这一页的行会带**行内下拉**（见 PluginSettingsRow.inline / value）。
   * 导航自己不用它，只是把话透给界面：行里要不要给下拉留位置，界面照它决定。
   */
  inline?: PluginSettingsInline;
  /**
   * 这一页想排在哪一页正下方：内置页 id 或 plugin:<插件名>:<分区 id>。
   *
   * 见 PluginSettingsRef.after —— 它跟着这份声明一路签到导航那边。
   */
  after?: string;
  /**
   * 属于**哪一拨**：main 在横线上方，extension 在下方。不填 = main。
   *
   * 见 PluginSettingsRef.group —— 横线以下那拨是"要装上来才有"的东西，
   * 由插件自己声明，渲染层不再拿一张写死的名字表去猜。
   */
  group?: 'main' | 'extension';
  /**
   * 排在**哪个分区正下方**、并缩进一级。可以是任意分区 id（含插件分区）。
   *
   * 用途只有一个但很实在：插件宿主里的子插件经 installSection 各注册一格，
   * 它们本就是「扩展插件」的下一级 —— 声明 parent 就不用跟 MCP 平级排着。
   */
  parent?: string;
  /** 同组的默认次序；用户拖过之后以拖动结果为准 */
  order?: number;
  view: () => PluginSettingsView | Promise<PluginSettingsView>;
  onAction?: (actionId: string, rowId: string) => string | void | Promise<string | void>;
}

/** 一个分区在内存里的样子 —— 连同它归哪个插件（导航上要分组，动作要递回去） */
export interface SettingsSectionReg extends SettingsSectionSpec {
  plugin: string;
}

/**
 * 一条"请用户点头"的请求。插件提出，核心负责那条要点的东西 —— 插件跑在主进程，画不了界面。
 *
 * `then` 是用户点头之后核心要跑的那一次工具调用：用数据而不是回调，因为按钮在
 * 渲染进程那边，函数过不去。跑的时候**不再过 onBeforeTool** —— 请求本来就是它提的，
 * 回头再问一遍就是个死循环。
 */
/** 一个可选答案 —— 跟 dsh 的 AskUserQuestionOption 同形 */
export interface AskQuestionOption {
  /** 给人看的标签 */
  label: string;
  /** 一句话讲清这个选择的代价或后果（认得的界面会渲染出来） */
  description?: string;
}

/**
 * 一道题。跟 dsh 的 AskUserQuestionItem 同形（字段名对齐，多选叫 multiSelect）。
 *
 * 提一批题、拿一批结构化的答案 —— 这是问用户的一般形态；
 * 下面那条 confirm/cancel 的老路只是它的一个退化情形（两个按钮、没有选项）。
 */
export interface AskQuestionItem {
  /** 稳定的题号，答案里原样带回来 */
  id: string;
  /** 要问的那句话 */
  question: string;
  /** 补充说明：渲染在题目上，但不混进选项标签里 */
  detail?: string;
  /** 短标题 / 分组名，如「确认」「选模式」 */
  header?: string;
  /** 可选项；不给就是让用户自由填 */
  options?: AskQuestionOption[];
  /** 允许多选。默认单选 */
  multiSelect?: boolean;
}

/** 一道题的答案：跟 dsh 的 AskUserQuestionAnswerItem 同形 */
export interface AskAnswerItem {
  /** 对应哪道题 */
  id: string;
  /** 选中的选项标签（多选时可能多条） */
  selected: string[];
  /** 自由填的那个「其他」 */
  custom?: string;
}

export interface AskSpec {
  panelId: string;
  text: string;
  confirm?: string;
  cancel?: string;
  /**
   * 第三个按钮：**等所有会话都跑完再做**。
   *
   * 这个口子留在核心是有理由的：它要判"整个软件还有没有会话在跑"，而那份状态
   * 只在主进程内存里（index.ts 的 running），插件没有钩子看得到 ——
   * 插件只能决定"要不要多这一个按钮、按钮上写什么"。
   * 用户点它之后，核心把这次调用记下来，等 running 空了自动执行。
   */
  defer?: { label?: string };
  /**
   * 一批结构化的问题（dsh 的 ask_user_question 同形）。
   *
   * 给了它，界面上画的就是问题表单（翻页 / 单选多选 / 自定义答案 / 跳过），
   * 用户提交之后答案从 then 那条路回到插件手里；不给就还是底下那两个按钮的老样子。
   */
  questions?: AskQuestionItem[];
  then: { tool: string; args?: any };
}

/**
 * 一个"状态部件"：挂在输入框那一排的一小块文字（用量、花费、连接状态……）。
 *
 * 为什么只能是这种形式：插件跑在主进程，画不了界面。让插件直接写 React，
 * 等于又开一套插件体系；所以它的职责缩小成"给我一个面板，我说它该显示什么"，
 * 界面由核心统一渲染 —— 于是插件终于够得着 UI 了，而核心仍然只有一套画法。
 */
export interface StatusItem {
  id: string;
  /**
   * 挂在哪一条上。
   *
   *   `composer`（默认）= 输入框那一排，挨着模型那个 chip；
   *   `head`            = **会话框顶上那一条**，跟「对话 · N 条」同一行。
   *
   * 为什么要有这个位置选择：同样是"这一轮的状态"，有的属于**要发出去的东西**
   * （用量、花费，贴着输入框看），有的属于**这个工作区的处境**（git 分支、改了几个
   * 文件）—— 后者要的是"抬眼就在"，压在输入框边上谁会低头去找。插件跑在主进程
   * 画不了界面，位置只能由核心给，所以开成声明里的一个字段，
   * 而不是让某个插件去改核心的布局。
   */
  slot?: 'composer' | 'head';
  /** 这个面板上显示什么；返回空串就不显示 */
  text(panelId: string, ctx: ToolContext | null): string;
  /** 鼠标悬停时的详细说明，可以多行 */
  title?(panelId: string, ctx: ToolContext | null): string;
}

/**
 * 一个插件的参数快照（声明 + 此刻的值）—— 给"让助手调参数"的插件看（plugins/plugin-kit）。
 * 它跟渲染进程看到的 PluginInfo 是同两份东西，只是这边不掺界面的事。
 */
export interface PluginParamView {
  name: string;
  description: string;
  enabled: boolean;
  /** 这个插件自己声明的可调参数 */
  params: PluginParamDecl[];
  /** 当前生效的值（默认值已填好） */
  values: Record<string, string | number | boolean>;
}

export interface PluginHost {
  environments: {
    directory(name: string): string;
    registerPython(record: PythonEnvironmentRef): void;
  };
  onFileWrite(fn: FileWriteHook): void;
  files: {
    write(path: string, text: string): boolean;
    revision(path: string): string;
    restore(path: string, before: string | null, expectedHash: string): void;
  };
  tasks: TaskApi;
  buildProject(target: BuildTarget, scope?: BuildScope): Promise<BuildResult>;
  /** 注册一个工具，名字会进 agent 的工具清单（重名时核心工具赢） */
  addTool(spec: PluginToolSpec, handler: (args: any, ctx: ToolContext | null) => Promise<string> | string): void;
  /**
   * **在设置里单开一个分区** —— 一份名单、一本台账这类东西该有的家。
   *
   * 为什么要有它：有些东西既不是一块面板（用户不需要它摊在布局里），也不是一个工具
   * （人不通过对话去用它）—— AI 员工的编制正是这种：它是**一份要看得见、能点两下的名单**。
   * 插件跑在主进程、画不了界面，所以照 addStatusItem 那套来：**插件交数据，核心画**。
   *
   * 交的是一行行纯数据 + 每行的几个按钮（见 PluginSettingsRow）：刻意不给写 React 的机会
   * （那等于又开一套插件体系），也不为某一个插件定制界面。
   * `view()` 在进这一页时、点完按钮之后各调一次，现算现给；用户点某一行上的某个动作时，
   * 核心把 `(actionId, rowId)` 递回 `onAction` —— 那句活怎么干是插件自己的事。
   */
  addSettingsSection(spec: SettingsSectionSpec): void;
  /**
   * 插件自报一根技能根 —— 某本技能库落在哪个目录，是**那个插件的知识**，
   * 核心不该写死一份名单（见 skills.ts 顶部那段）。rank 越小越优先，
   * 跟内置那几根同一把尺子；不填就排在通用约定之后、软件自带之前。
   */
  addSkillRoot(dir: string, source: string, rank?: number): void;
  /**
   * 工具跑动中往对话里摆东西：一个进行中的容器（带进度、能带过程预览图），
   * 以及把图挂进这一轮的回答里。**慢活必须用它** —— 生图要十几秒到几分钟，
   * 这期间对话里只有一条"正在跑工具"，用户只能干等，看不出它卡住没有。
   */
  live: LiveSink;
  /** 挂到 write_file / edit 之前；写新文件不会触发，内容没变也不会 */
  onBeforeWrite(fn: BeforeWrite): void;
  /**
   * 挂到**任何工具执行之前**。返回一句话就拦下这次调用（那句话会成为工具结果）。
   * "先问用户、点了才放行"就用它配合下面的 ask()。
   */
  onBeforeTool(fn: BeforeTool): void;
  /**
   * 挂到**任何工具执行之后**、结果交给模型之前。返回一句话就换掉这次的结果。
   * 和 before 那段的分工：那段管"放不放行"，这段管"结果怎么给你看"。
   */
  onAfterTool(fn: AfterTool): void;
  /**
   * 挂到模型**吐出来的思考流**上。只读：不给拦、不给改 —— 思考不是正文，
   * 插件不该有机会动它，能做的只是"接一份走"。
   */
  onReasoning(fn: ReasoningFn): void;
  /**
   * 请用户点头：核心在对话区摆一条带按钮的请求，用户按下确认之后，核心替插件跑掉 `then`。
   * 提请求**不阻塞这一轮** —— 用户点头时这一轮早跑完了，数据也已经落盘。
   */
  ask(spec: AskSpec): void;
  /**
   * 往某个面板发一句话，等这一轮跑完才 resolve（回复正文在 content 里）。
   * 面板正跑着时别发 —— 会叠上第二轮；发之前先看它的 status。
   *
   * `opts.silent` = **进历史、不上屏**：给"插件替系统说的话"用（交付到位了叫发起人接着办）。
   * 用户没说过那句话，它就不该在对话里冒充"我"；但模型得知道这一轮是为什么跑的，
   * 所以它照进历史、只是不画出来。**要人看见就别用它** —— 那是普通 send。
   */
  send(
    panelId: string,
    text: string,
    /** 要一起发过去的图：**磁盘路径**或 data URL 都行（data URL 由核心落盘） */
    images?: string[],
    opts?: { silent?: boolean; steer?: boolean; signal?: AbortSignal },
  ): Promise<{ ok: boolean; content?: string; error?: string }>;
  /**
   * 用模型问一次话（一问一答：不带工具、不进对话历史、不动这个面板的会话）。
   * **不传 pick** = 这个面板自己选中的那个（跟会话区同一个选择器）；**传了 pick** = 软件里
   * 已配的任意一个。画布上"过 LLM 用哪个模型"走后面这条。两种情况下密钥都只在主进程。
   */
  askModel(panelId: string, spec: { system?: string; user: string; maxTokens?: number; pick?: string; signal?: AbortSignal }): Promise<string>;
  /**
   * 软件里已配的模型清单（**脱敏**：提供方、显示名、配没配密钥，没有密钥本身）。
   * 插件想"让用户挑一个别的模型"就得先看得见有哪些 —— 清单在这儿，钥匙不在。
   */
  models(): PluginModel[];
  /**
   * 登记 / 更新一个提供方 —— 插件想把自己那条线路接进模型选择器就走它。
   * 核心负责分流：配置进 providers.json，**密钥进 credentials.json**（不进配置文件明文）。
   * 返回 false 表示核心没收（key 或 baseUrl 缺了）。
   */
  upsertProvider(p: PluginProviderDraft): boolean;
  /**
   * 某个**已配**提供方的密钥，取不到就是空串。
   * 插件别自己再存一份明文（鲸鱼娘原来在参数里存了一份 DeepSeek 钥匙）——
   * 用户在设置里配过一次，这里就能拿到同一把。
   */
  credential(providerKey: string): string;
  /**
   * 把插件自己的钥匙存进核心的凭据库（按 slot 分槽）—— 别落在插件参数里。
   *
   * 插件参数文件（.ensoul/state/plugin-params.json）**不是放密钥的地方**：它是明文的，
   * 还跟着工作区走、会被一起打包。密钥只有凭据库这一个家。
   * 空串表示删掉这一槽。
   */
  saveCredential(slot: string, value: string): void;
  /** 每轮对话开始前调一次，返回的正文拼在**本轮用户消息的末尾**（见 index.ts 的 pluginExtras） */
  addPrompt(fn: PromptFn, opts?: { scope?: string[] }): void;
  /** 在输入框那一排挂一小块文字（用量、花费、连接状态……） */
  addStatusItem(item: StatusItem): void;
  /**
   * 让界面重画一次。
   *
   * 状态部件是**广播的时候现算**的（store.publicState 里调 text()），所以插件这边
   * 数据变了、又没有别的动静，界面上那块字就一直是旧的。广播够不着 webContents
   * （那住在 IPC 层），插件也够不着 —— 所以由核心开这一个口子，插件只管喊一声。
   */
  refresh(): void;
  /**
   * 注册一条斜杠命令（输入框里敲 /xxx）：界面只负责发现和输入，执行走 handler。
   * 执行在主进程直接跑 —— 返回什么就是什么，不经模型转述；handler 拿得到 ctx.panelId。
   */
  addCommand(spec: SlashCommandView, handler: (args: string, ctx: ToolContext | null) => Promise<string> | string): void;
  /**
   * 清空某个面板的会话上下文（消息 + 前情摘要一起清）。返回 false = 没有这个面板。
   * 对话本身是核心的活（消息、摘要、落盘都在里面），插件碰不着 —— 跟 send 一个路子，
   * 本事由核心塞进来，插件只管喊。
   */
  clearChat(panelId: string): boolean;
  /**
   * 把某个面板到现在为止的会话压成一份摘要，摘要之前的原文从此**不再送给模型**。
   * 原文一条都不删 —— 它们还躺在对话里，界面上照样能翻。返回一句话说明结果。
   * 和 clearChat 的区别正在这里：那个连摘要一起清，这个留个话头另起一个分支。
   */
  compressChat(panelId: string): Promise<string>;
  /** 这一刻某个面板能用到的工具（名字 + 一句话说明）—— 工具清单按面板类型分档 */
  tools(panelId: string): { name: string; description: string }[];
  /** 全部已注册的插件工具声明（含 kits 等元数据） */
  allPluginTools?(): PluginToolSpec[];
  /**
   * 压缩历史时问一句："有什么是**进了摘要才不丢**的？"返回的正文拼进摘要请求，
   * 并标成"必须原样保留"。
   *
   * 只在真压缩那一刻调，所以插件可以现算（去读自己的状态、数一遍自己记了什么）——
   * 不占每轮的钱，也动不了缓存前缀。便签要点就是走这个重新进摘要的。
   */
  addSummaryNote(fn: SummaryNoteFn): void;
  /**
   * 压缩时问一句："这次用哪个模型写纪要？"返回 `provider::model`，空串 = 用面板自己那个。
   *
   * 为什么要这个口子：压缩要**额外**问一次模型（把旧对话写成纪要），核心默认拿这块面板
   * 自己选的那个去问 —— 用户为了让聊天聪明往往挑最贵的一档，而写纪要不需要那个智商。
   * 挑谁是**策略**不是道理，所以核心只留"问一句"这个动作，由插件说。
   * 手动 /compress 和自动压缩共用核心那一份实现，所以这里写一次、两条路都生效。
   */
  addCompactPick(fn: CompactPickFn): void;
  /**
   * 当前所有面板，含每一轮的用量账（`chat[].stats`）。
   * 插件要自己算点什么就读它 —— 用量状态条就是靠这个算出 token 和花费的。
   */
  /**
   * 新建一个面板（默认落点：主窗口第一个标签组）—— 手机端「＋」走这个，
   * 建完立刻广播，桌面那边同步看得到。
   */
  createPanel(partial: Partial<Panel>): Panel;
  /** 把面板分离成独立悬浮窗 */
  detachPanel(panelId: string, at?: { x: number; y: number }, size?: { width: number; height: number }): boolean;
  /**
   * 把一块面板**浮成便签**，贴在 `host` 那个窗口的 `anchor` 那块区域上。
   *
   * 为什么插件需要它：浮在别人上面、跟着母体走、母体缩了也不飞出去 —— 这一整套
   * 核心早就有了（见 PanelFloat），但一直只有人能拖出来。插件要做的挂件（时钟、
   * 余额、状态灯）正是这一类，没这个口子就只能占着布局里一格。
   *
   *   host   挂在哪个窗口：`'main'` 或某个浮窗 id（所以挂件天生是多窗口的）
   *   anchor 依附哪一块区域（标签组 id）；给空串就落进那个窗口的第一个区域
   *   box    位置给**比例**（rx/ry：0 贴左/上，1 贴右/下），大小给像素
   *
   * 缺省锁住（桌面歌词那条规矩）：摆好之后就不该再被误碰，要解开由用户点小锁。
   */
  floatPanel(
    panelId: string,
    host: string,
    anchor: string,
    box: { rx?: number; ry?: number; width?: number; height?: number },
  ): boolean;
  /** 挪动/改大小一块便签；`locked` 也走这里 */
  moveFloatPanel(panelId: string, patch: Partial<PanelFloat>): boolean;
  /** 取消悬浮，归位回停靠树（归宿由核心按"原来依附的那块区域还在不在"决定） */
  unfloatPanel(panelId: string): boolean;
  /**
   * 把一块面板变成**挂件窗口**（见 Panel.widget）：无壳、可透明、常驻置顶，
   * 自己就是一扇系统窗口 —— 主窗口关了它还在，压得到别的软件上面。
   *
   * 跟 floatPanel 的分水岭：那个浮在**宿主窗口里**（宿主最小化就没了），这个自己是窗口。
   * 做桌宠、桌面时钟、状态灯这类「全局挂件」要的正是这一个。
   *
   *   box.x / y        窗口摆在屏幕哪个位置（**像素**，不是比例 —— 它不属于任何会缩放的区域）
   *   box.width/height 窗口多大（缺省 280 × 200）
   *   box.transparent  背景透明（形象有轮廓时用）
   *   box.onTop        常驻置顶（**缺省就是置顶**）
   */
  floatWidget(panelId: string, box: Partial<PanelWidget>): boolean;
  /** 挪动/改大小一扇挂件窗口（用户在面板里点按钮安排位置时用） */
  moveWidgetPanel(panelId: string, patch: Partial<PanelWidget>): boolean;
  /** 取消挂件状态，把面板摆回停靠树 */
  unwidgetPanel(panelId: string): boolean;
  /** 这一刻所有的挂件窗口（面板 id + 那扇窗的位置大小） */
  widgetPanels(): { panelId: string; box: PanelWidget }[];
  /**
   * 关掉一块面板 —— 跟界面上那个「×」走的是同一条路。
   *
   * 关掉**不是真删**：声明过的回组件库、没声明的进历史会话，都还捞得回来。
   * 给这个口子，是因为有些面板是"摆在那儿给你看的"（桌面组件就是这种）：用户
   * 看着它不想要了，会想当场拿掉 —— 而不是先收回布局、再找它、再关。
   */
  closePanel(panelId: string): boolean;
  /** 打开收纳区里的一条（同一个面板、同一段对话；已经开着就切过去） */
  openComponent(id: string): Panel | null;
  /**
   * 改一块面板自己的字段（标题、规格、外观……）。
   *
   * 为什么插件需要它：管理面板管的是**别人**那块面板 —— 改一个岗位的行为规范，
   * 得落到那张员工自己的脸上。没这个口子，"编制是唯一真源"就只管到名册，
   * 提示词会跟名册漂开，而且漂了不报错。
   */
  patchPanel(id: string, patch: Partial<Panel>): Panel | null;
  /** 收纳区条目索引 —— 面板被收进组件后，手机端靠它才够得着 */
  /** 给一块面板**钉住模型**（`provider::model`）—— 员工面板的模型来自他的角色卡，不在会话里现挑。面板不存在返回 false */
  setModel(panelId: string, pick: string): boolean;
  modelPick(panelId: string): string;
  /**
   * 设一块面板的**思考水平**：`'off' | 'low' | 'medium' | 'high'`，空串 = 恢复默认。
   *
   * 员工面板靠它把思考关掉 —— 派单、转述、回话这类活不需要想，想只是白等（经理尤其）。
   * 面板不存在就什么都不做。
   */
  setThink(panelId: string, level: string): void;
  componentRefs(): ComponentRef[];
  componentCrafts(): unknown[];
  panels(): Panel[];
  /**
   * **这一块此刻真的在跑吗** —— 只认主进程内存里那张运行表，**不认落盘的 status**。
   *
   * 落盘的 status 会在进程被杀时永久停在 working（收尾那段一次都没跑）。插件拿它当
   * "正在跑"的守卫，用户发的话就被永久静默吞掉（eschat 防叠第二轮就是这么写的）。
   * 运行表是内存态、开机必然空 —— 只有它说的是真话。
   */
  isRunning(panelId: string): boolean;
  /**
   * **排一句队**：面板正跑着时用这个，别直接 send（会叠第二轮），更别静默丢掉。
   * 这一句摆进待发队列，等这一整轮跑完自动接力发出 —— 跟聊天区那个队列是同一份账。
   */
  enqueue(panelId: string, text: string, images?: string[]): { ok: boolean; error?: string };
  /**
   * 把一块面板收进**后台**：不占布局、界面上不显示，但活着 —— 收得到消息、
   * 跑得完这一轮，对话照旧落在它自己的 chat 里。
   *
   * 跟"关掉"的分水岭：关掉是写文件 + 从面板表里摘走，之后就收不到消息了。
   * 员工会话要的正是中间那种状态（见 Panel.hidden）。
   */
  hidePanel(id: string): boolean;
  /** 把后台的面板摆回布局（哪个标签组由核心决定） */
  showPanel(id: string): boolean;
  /**
   * 把一块面板**摆到眼前**：后台的先叫回布局，已经在标签里的切到它。
   * 跟 showPanel 差在最后那一下 —— 摊位摆出来了、用户没看着，那也不算“打开”。
   */
  activatePanel(id: string): boolean;
  log(...args: any[]): void;
  /** 工作区根目录的绝对路径 */
  workspace: string;
  /** 固定应用数据根中的逻辑路径；项目声明按本实例的工作区隔离。 */
  dataPath(rel: string): string;
  /**
   * 一个可调参数的当前值（声明里的默认值已填好）。**setup 时读一次**就够 ——
   * 参数改了核心会让插件重新 setup，所以这不是一件会自己变的东西，别拿它当实时开关。
   */
  param<T = any>(key: string, fallback?: T): T;
  /**
   * 改自己的一个参数（落盘，下一次 setup 起生效）。值先按声明校验：类型不对、
   * 越界、选项里没有，一律退回默认 —— 脏值不该让插件跑在意外的配置上。
   * 和用户在设置面板里改的是同一份值，谁后写谁算。
   */
  setParam(key: string, value: any): void;
  /**
   * 所有插件的可调参数（声明 + 当前值）。给"让助手调参数"这类插件用 ——
   * 见 plugins/plugin-kit：AI 改参数走的就是它。
   */
  allParams(): PluginParamView[];
  /** 改**任意**插件的参数（同一份校验）；value 传 null = 恢复默认 */
  setPluginParam(plugin: string, key: string, value: any | null): { ok: boolean; error?: string };
  /** 插件自己的持久状态默认全局；storage.project 声明的路径按项目隔离。 */
  state: {
    load<T = any>(fallback?: T): T;
    save(value: any): boolean;
  };
}

/** 一次加载的全部产物 */
export interface LoadedPlugins {
  fileWrite: FileWriteHook[];
  tools: PluginTool[];
  beforeWrite: BeforeWrite[];
  beforeTool: BeforeTool[];
  afterTool: AfterTool[];
  prompts: PluginPrompt[];
  /** 压缩时想交一句快照的插件（`addSummaryNote`） */
  summaryNotes: SummaryNoteFn[];
  /** 压缩时想指定用哪个模型的插件（`addCompactPick`） */
  compactPicks: CompactPickFn[];
  /** 插件注册的斜杠命令（输入框敲 / 时的候选）—— handler 不过 IPC，广播里只有 id/label/hint */
  commands: SlashCommandReg[];
  /** 插件挂在输入框那一排的状态部件 */
  status: StatusItem[];
  /** 插件在设置里开的分区（声明 + 取数函数）—— 设置页照着它列导航、画内容 */
  sections: SettingsSectionReg[];
  /** 给设置面板看的清单（无论启用与否都在里面） */
  info: PluginInfo[];
}

interface Instance {
  fileWrite: FileWriteHook[];
  /** 绝对目录 */
  dir: string;
  /** 显示用，形如 plugins/file-backup */
  label: string;
  name: string;
  /** index.js 的修改时间 —— 变了就重载 */
  mtime: number;
  mod: any;
  /** 这个插件注册的斜杠命令 */
  commands: SlashCommandReg[];
  /** 这一刻生效的参数值（声明里的默认值已填好）—— 插件的 setup 读的就是它 */
  paramValues: Record<string, any>;
  /** 压缩时想交一句快照的插件（`addSummaryNote`） */
  summaryNotes: SummaryNoteFn[];
  /** 压缩时想指定用哪个模型的插件（`addCompactPick`） */
  compactPicks: CompactPickFn[];
  /** 这个插件在设置里开的分区（`addSettingsSection`）—— 插件停用/卸载时一起收走 */
  sections: SettingsSectionReg[];
  /** 接思考流的钩子（`onReasoning`）—— 核心不留存，谁要谁自己接 */
  reasoning: ReasoningFn[];
  info: PluginInfo;
  tools: PluginTool[];
  beforeWrite: BeforeWrite[];
  beforeTool: BeforeTool[];
  afterTool: AfterTool[];
  prompts: PluginPrompt[];
  status: StatusItem[];
}

const instances = new Map<string, Instance>();

/**
 * 把一份思考 delta 递给所有接了思考流的插件（`onReasoning`）。
 *
 * 为什么单独开一个函数、而不是并进 `LoadedPlugins`：那份产物是给 agent / 工具管线用的，
 * 而思考属于对话循环本身 —— index.ts 收到 delta 的那一刻顺手递一份。停用的插件不接，
 * 跟别的口子一个规矩；每个钩子单独 try，一个插件的落盘出错不该把这一轮的思考流掐断。
 */
export function emitReasoning(panelId: string, delta: string): void {
  if (!panelId || !delta) return;
  for (const inst of instances.values()) {
    if (!inst.info.enabled || !inst.reasoning || !inst.reasoning.length) continue;
    for (const fn of inst.reasoning) {
      try {
        fn(panelId, delta);
      } catch (e: any) {
        console.error(`[插件 ${inst.name} 的 onReasoning] 出错：`, e?.message ?? e);
      }
    }
  }
}

/**
 * "请用户点头"这件事落在界面上要窗口、要 store —— 那些都在 IPC 层。
 * 所以那边把自己的做法塞进来，这边只负责把插件的请求递过去（同 setExtensions 的思路）。
 */
/**
 * 工具跑动中往对话里摆东西 —— 生图、下载、长构建这类慢活，跑的时候要看得见。
 *
 * 跟 askUser 一个路子：对话区是核心画的（插件跑在主进程，画不了界面），
 * 所以核心把这三个动作塞进来，插件只管喊。三个动作是最小的那一组：
 *   show  摆出/更新一个进行中的容器（同一个 key 覆盖）
 *   hide  收掉它（不是"取消"，是这张活干完了、界面上别再转）
 *   image 把一张图挂进这一轮的回答里（跑完留在那条消息上，用户能直接看）
 *
 * 位置**只认磁盘路径**：图塞进 workspace.json 会让它越滚越大（见 ChatMessage.images）。
 */
export interface LiveSink {
  show(panelId: string, task: LiveTask): void;
  hide(panelId: string, key?: string): void;
  image(panelId: string, file: string): void;
}

let liveSink: LiveSink = { show() {}, hide() {}, image() {} };

export function setLiveSink(fn: LiveSink) {
  liveSink = fn;
}

let askUser: (spec: AskSpec) => void = () => {};

export function setAskHandler(fn: (spec: AskSpec) => void) {
  askUser = fn;
}

/**
 * 把一句**外面来的话**送进某个面板、跑完整整一轮。跟 askUser 一个路子：
 * 对话本身是核心的活（压缩、权限、便签都在里面），插件碰不着，
 * 于是核心把"怎么发"塞进来，插件只管喊 send()。plugins/remote 用它。
 */
let chatSender: (
  panelId: string,
  text: string,
  images?: string[],
  opts?: { silent?: boolean; steer?: boolean; signal?: AbortSignal },
) => Promise<{ ok: boolean; content?: string; error?: string }> =
  async () => ({ ok: false, error: t('对话还没接上') });

/** 清空会话 —— 同上，也是核心才够得着的事（见 PluginHost.clearChat） */
/**
 * "用某个面板选中的模型问一次话" —— 同 chatSender：模型配置（含密钥）住在核心，
 * 插件在主进程但只该看到结果，所以核心把这件事塞进来，插件只管 askModel()。
 */
let modelAsker: (
  panelId: string,
  spec: { system?: string; user: string; maxTokens?: number; pick?: string; signal?: AbortSignal },
) => Promise<string> = async () => {
  throw new Error(t('模型这条路还没接上'));
};

export function setModelAsker(fn: typeof modelAsker) {
  modelAsker = fn;
}

/**
 * 给插件看的模型清单 —— 脱敏那份（提供方配置住在核心，密钥一个字都不出来）。
 * 跟 modelAsker 一个路子：核心把值塞进来，插件只管喊 models()。
 */
export interface PluginModel {
  key: string;
  label: string;
  hasKey: boolean;
  models: { id: string; name: string }[];
}

let modelCatalog: () => PluginModel[] = () => [];

export function setModelCatalog(fn: () => PluginModel[]) {
  modelCatalog = fn;
}

/**
 * 插件要往模型选择器里塞自己那条线路时，交给核心的这个口子。
 *
 * **为什么不让插件自己写 providers.json**（free-model-provider 原来就是这么干的）：
 * 密钥会被它写进配置文件的明文里，而且和主进程互相覆盖。走这里，核心把配置写进
 * providers.json、把密钥转进独立的 credentials.json —— 插件不知道密钥住哪，也不用知道。
 */
export interface PluginProviderDraft {
  key: string;
  label?: string;
  api?: string;
  baseUrl: string;
  models: { id: string; name: string }[];
  /** 一起登记的新密钥。留空 = 别动它现在那把（不是"删掉") */
  apiKey?: string;
}

let providerUpserter: (p: PluginProviderDraft) => boolean = () => false;

export function setProviderUpserter(fn: (p: PluginProviderDraft) => boolean) {
  providerUpserter = fn;
}

/** 读一个已配提供方的密钥（只在主进程用，界面和对话都拿不到） */
let credentialReader: (providerKey: string) => string = () => '';

export function setCredentialReader(fn: (providerKey: string) => string) {
  credentialReader = fn;
}

/** 往凭据库存一把插件自己的钥匙（按 key 分槽，空串 = 删掉） */
let credentialWriter: (slot: string, value: string) => void = () => {};

export function setCredentialWriter(fn: (slot: string, value: string) => void) {
  credentialWriter = fn;
}

let chatClearer: (panelId: string) => boolean = () => false;

export function setChatClearer(fn: typeof chatClearer) {
  chatClearer = fn;
}

/** 手动压一次上下文 —— 同 chatClearer：摘要要用模型、要动 panel.chat，插件够不着 */
let chatCompressor: (panelId: string) => Promise<string> = async () => '这件事还没接上';

export function setChatCompressor(fn: typeof chatCompressor) {
  chatCompressor = fn;
}

/** 这一刻有哪些工具 —— 工具表住在 agent.ts，由 IPC 层注入（见 PluginHost.tools） */
let toolLister: (panelId: string) => { name: string; description: string }[] = () => [];

export function setToolLister(fn: typeof toolLister) {
  toolLister = fn;
}

export function setChatSender(fn: typeof chatSender) {
  chatSender = fn;
}

let projectBuilder: (target: BuildTarget, scope?: BuildScope) => Promise<BuildResult> = async () => ({ ok: false, out: '构建服务还没接上' });
export function setProjectBuilder(fn: typeof projectBuilder): void {
  projectBuilder = fn;
}
let taskApi: TaskApi | undefined;
export function setTaskApi(api: TaskApi): void { taskApi = api; }
function tasks(): TaskApi {
  if (!taskApi) throw new Error('任务服务还没接上');
  return taskApi;
}
/**
 * **排一句队**：这一句先摆着，等面板这一整轮跑完自动接力发出。
 *
 * 为什么给它单开一条：插件想给一个"正在跑"的面板说话时，直接 send 会叠上第二轮，
 * 而静默丢掉又会让用户以为发成功了。排队是第三种、也是唯一正确的处理 ——
 * 跟聊天区那个待发队列**同一份账**（同一处接力、同一处落盘）。
 */
let chatEnqueuer: (
  panelId: string,
  text: string,
  images?: string[],
) => { ok: boolean; error?: string } = () => ({ ok: false, error: t('对话还没接上') });

export function setChatEnqueuer(fn: typeof chatEnqueuer) {
  chatEnqueuer = fn;
}
/**
 * 往面板送**实时状态变更**的那条路 —— 面板在跑就插进那一轮，没在跑就起一轮。
 * 分流为什么归核心：只有核心看得见 running 那张表（见 index.ts 的 setChatSteerer）。
 */
let chatSteerer: (panelId: string, text: string) => Promise<{ ok: boolean; error?: string }> =
  async () => ({ ok: false, error: t('对话还没接上') });

export function setChatSteerer(fn: typeof chatSteerer) {
  chatSteerer = fn;
}
/**
 * **这一块此刻真的在跑吗** —— 核心把答案塞进来（跟 chatSteerer 一个路子）。
 *
 * 为什么必须由核心回答：真实运行态是主进程内存里那张表，**插件压根够不着**。插件只能
 * 读到落盘的 `panel.status`，而那个字段会在进程被杀时永久停在 working —— 拿它当守卫
 * 就会把用户的话静默吞掉（eschat 的谷谷就是这么卡死的）。
 */
let runningProbe: (panelId: string) => boolean = () => false;

export function setRunningProbe(fn: typeof runningProbe) {
  runningProbe = fn;
}

/**
 * 面板和停靠树变了要告诉界面 —— 广播那套住在 IPC 层（只有那边够得着 webContents），
 * 于是同 askUser、chatSender 一个路子：核心把 refresh 塞进来，这边只管喊一声。
 */
let refresher: () => void = () => {};

/** 浮成便签时位置给的是比例：夹到 0~1，脏值一律当 0（贴左上），别让它飘到画外 */
const clamp01 = (n: unknown): number => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
};

/** 某个窗口的第一块区域（标签组）—— anchor 没给时落这儿 */
const firstTabId = (root: any): string => {
  try {
    return W.firstTabGroup(root).id;
  } catch {
    return ''; // 空树（理论上不该有）→ 调用方按失败处理
  }
};

export function setRefresher(fn: () => void) {
  refresher = fn;
}

export function pluginsDir(): string {
  return appPath(DIR);
}

/** 插件根，从高优先级到低优先级 */
function pluginRoots(ws = workspaceRoot()): Array<{ dir: string; source: string }> {
  const out: Array<{ dir: string; source: string }> = [];
  if (ws) out.push({ dir: path.join(ws, '.ensoul', DIR), source: t('工作区') });
  out.push({ dir: userDataPath('.ensoul', DIR), source: t('全局') });
  out.push({ dir: pluginsDir(), source: t('软件自带') });
  return out;
}

const preparedStorage = new Map<string, { stamp: number; mod: any }>();
const preparedWorkspaces = new Map<string, string>();
const migratedWorkspaces = new Set<string>();
registerWorkspaceStorage('plugin-configuration', ['.ensoul/plugin-overrides.json']);

function registerPluginStorage(dir: string, mod: any, workspace = workspaceRoot()): void {
  const declaration = mod?.storage?.project;
  const workspaceDeclaration = mod?.storage?.workspace;
  if (declaration !== undefined && (!Array.isArray(declaration) || declaration.some((value: unknown) => typeof value !== 'string'))) {
    throw new Error('storage.project 必须是逻辑数据路径数组');
  }
  if (workspaceDeclaration !== undefined && (!Array.isArray(workspaceDeclaration) || workspaceDeclaration.some((value: unknown) => typeof value !== 'string'))) {
    throw new Error('storage.workspace 必须是逻辑数据路径数组');
  }
  registerWorkspaceStorage(`plugin:${dir}`, workspaceDeclaration || [], workspace);
  registerProjectStorage(`plugin:${dir}`, declaration || [], workspace);
}

/** 在复制旧数据前只读取插件声明，不执行 setup。 */
export function preparePluginStorage(workspace = workspaceRoot()): void {
  if (typeof (globalThis as any).t !== 'function') {
    (globalThis as any).t = t;
    (globalThis as any).__ensoulI18n = { t, getLang: () => 'zh', onLang: () => () => {} };
  }
  const claimed = new Set<string>();
  const candidates: Array<{ dir: string; file: string; stamp: number; name: string }> = [];
  for (const root of pluginRoots(workspace)) {
    if (!fs.existsSync(root.dir)) continue;
    for (const entry of fs.readdirSync(root.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || claimed.has(entry.name)) continue;
      const dir = path.join(root.dir, entry.name);
      const file = path.join(dir, 'index.js');
      if (!fs.existsSync(file)) continue;
      claimed.add(entry.name);
      const stamp = fs.statSync(file).mtimeMs;
      candidates.push({ dir, file, stamp, name: entry.name });
    }
  }
  const key = workspace ? path.resolve(workspace) : '';
  const signature = JSON.stringify(candidates.map(candidate => [candidate.file, candidate.stamp]));
  if (preparedWorkspaces.get(key) === signature) return;
  clearStorageRegistrations('plugin:', workspace);
  let complete = true;
  for (const { dir, file, stamp, name } of candidates) {
    try {
      let cached = preparedStorage.get(file);
      if (cached?.stamp !== stamp) {
        delete require.cache[require.resolve(file)];
        cached = { stamp, mod: require(file) };
        preparedStorage.set(file, cached);
      }
      registerPluginStorage(dir, cached.mod, workspace);
    } catch (error) {
      complete = false;
      console.error(`[插件 ${name}] 存储声明读取失败：`, (error as Error).message);
    }
  }
  if (complete) preparedWorkspaces.set(key, signature);
}

function stateFile(name: string, root = workspaceRoot()): string {
  const safe = String(name || 'plugin').replace(/[^\w.-]+/g, '_');
  return runtimePath(`.ensoul/state/${safe}.json`, root);
}

/**
 * 插件可以自带一种面板类型：读它的 `panel` 声明，并**当场做形状校验**。
 *
 * 声明是纯数据（要过 IPC，函数过不去），所以这里能做的就是校验它像不像话：
 * kind 必须是字符串、body 必须是核心认识的那几种。脏声明一律当"没有" ——
 * 一个插件的坏声明不该让整个注册表长出个畸形面板。
 */
function readPanelDecl(mod: any): PluginPanelDecl | undefined {
  const d = mod?.panel;
  if (!d || typeof d !== 'object') return undefined;
  const kind = typeof d.kind === 'string' ? d.kind.trim() : '';
  if (!kind) return undefined;
  /*
   * 名字与说明按**当前语言**过一道：面板类型名会出现在新建菜单、设置页、
   * 以及系统提示里那份"现有面板类型"清单上 —— 界面切成英文了，
   * 这几种还叫中文名就露馅了。插件里写的仍然是中文原文（t 拿它当 key）。
   */
  const label = t(typeof d.label === 'string' && d.label.trim() ? d.label.trim() : kind);
  const bodies = ['messages', 'code', 'table', 'form', 'web'];
  return {
    kind,
    aliases: Array.isArray(d.aliases) ? d.aliases.map((x: unknown) => String(x || '').trim()).filter(Boolean) : undefined,
    label,
    hint: typeof d.hint === 'string' ? t(d.hint) : undefined,
    title: typeof d.title === 'string' ? t(d.title) : undefined,
    body: bodies.includes(d.body) ? (d.body as PluginPanelDecl['body']) : undefined,
    text: typeof d.text === 'string' ? d.text : undefined,
    look: d.look && typeof d.look === 'object' ? d.look : undefined,
    floatBare: d.floatBare === true,
  };
}

/**
 * 插件个人参数共用固定应用数据根的 `.ensoul/state/plugin-params.json`，
 * 形如 `{ "pomodoro": { "work": 30 } }`。
 *
 * 为什么一个文件而不是每个插件一份：参数是"人在设置面板里翻着改"的东西，
 * 一整份读出来就能把界面画全；助手改参数也只需要认这一处。顺带，一个修改时间
 * 就代表"所有插件的参数有没有动过"，重载判断因此很便宜。
 */
function paramFile(): string {
  return runtimePath('.ensoul/state/plugin-params.json');
}

/** 参数值的内存副本 + 它是照哪一版文件读的（那一版的修改时间） */
let paramStore: Record<string, Record<string, any>> = {};
let paramStamp = -1;
let projectParamStore: Record<string, Record<string, any>> = {};
let projectParamStamp = -1;

function projectParamFile(): string {
  const workspace = workspaceRoot();
  return workspace ? runtimePath('.ensoul/plugin-overrides.json', workspace) : '';
}

function projectParamMtime(): number {
  try { return fs.statSync(projectParamFile()).mtimeMs; } catch { return 0; }
}

function readProjectParamStore(): void {
  projectParamStamp = projectParamMtime();
  const raw = safeReadJson<unknown>(projectParamFile(), {});
  projectParamStore = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  for (const [plugin, values] of Object.entries(raw)) {
    if (values && typeof values === 'object' && !Array.isArray(values)) {
      projectParamStore[plugin] = Object.fromEntries(Object.entries(values));
    }
  }
}

/**
 * 插件是照**哪一版语言**装的。
 *
 * 为什么需要它：插件声明里的 label / hint、工具描述、以及插件模块**顶层的 t()**
 * （如 pomodoro 的 LABEL、git 的 MARK），都是在 require 那一刻算死的。语言一换，
 * 这些东西全冻在旧语言上 —— 界面重画多少遍都救不回来，值已经从主进程送出去了。
 *
 * 跟 paramStamp 一个路子：变了就 remountAll()，让每个插件重新 require 一遍。
 */
let langStamp: string = String(i18n.getLang());
let workspaceStamp = workspaceRoot();

function paramMtime(): number {
  try {
    return fs.statSync(paramFile()).mtimeMs;
  } catch {
    return 0; // 还没有这个文件
  }
}

/**
 * 安全读取 JSON：若主文件损坏或写入中途中断，自动回退到 .bak 备份尝试恢复，杜绝脏数据导致崩溃
 */
function safeReadJson<T = any>(filePath: string, fallback?: T): T {
  try {
    if (!fs.existsSync(filePath)) return (fallback ?? {}) as T;
    const text = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(text) as T;
  } catch (err) {
    const bak = `${filePath}.bak`;
    try {
      if (fs.existsSync(bak)) {
        const bakText = fs.readFileSync(bak, 'utf8');
        const parsed = JSON.parse(bakText) as T;
        console.warn(`[状态防撕裂] 检测到 ${filePath} 损坏，已成功从备份自动恢复！`);
        try { fs.copyFileSync(bak, filePath); } catch {}
        return parsed;
      }
    } catch {}
    return (fallback ?? {}) as T;
  }
}

/**
 * 原子写入 JSON：
 * 1. 序列化数据
 * 2. 写入带随机后缀的临时文件并同步落盘
 * 3. 成功后先留 .bak 副本，再原子重命名覆盖目标文件
 * 确保即使遇到断电、进程强杀或并发操作，目标文件永远保持完整合法的 JSON 格式。
 */
function atomicWriteJson(filePath: string, value: any): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const text = JSON.stringify(value, null, 2);
  const tmp = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    if (fs.existsSync(filePath)) {
      try {
        fs.copyFileSync(filePath, `${filePath}.bak`);
      } catch {}
    }
    try {
      fs.renameSync(tmp, filePath);
    } catch (renameErr: any) {
      if (renameErr?.code === 'EPERM' || renameErr?.code === 'EBUSY') {
        fs.copyFileSync(tmp, filePath);
        try { fs.unlinkSync(tmp); } catch {}
      } else {
        throw renameErr;
      }
    }
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function readParamStore(): Record<string, Record<string, any>> {
  const at = paramMtime();
  if (at === paramStamp) return paramStore;
  paramStamp = at;
  const raw = safeReadJson<any>(paramFile(), {});
  paramStore = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return paramStore;
}

/**
 * 写一条参数（`value === null` = 删掉这条，回到默认）。
 *
 * **故意不更新 paramStamp**：下一次 loadPlugins 会看到"文件变了"，于是让插件重新 setup
 * 读一遍新值。这是参数生效的唯一路径 —— 插件手里那份永远是 setup 那一刻的快照，
 * 所以"改了要重来"是明说的语义，而不是靠插件到处轮询。
 */
function writeParamValue(plugin: string, key: string, value: any): void {
  const all = { ...readParamStore() };
  const mine = { ...(all[plugin] || {}) };
  if (value === null) delete mine[key];
  else mine[key] = value;
  if (Object.keys(mine).length) all[plugin] = mine;
  else delete all[plugin];
  try {
    atomicWriteJson(paramFile(), all);
  } catch (e: any) {
    console.error('[插件参数] 存不下来：', e?.message ?? e);
  }
  paramStore = all;
}

/** 把外来的值按声明收拾干净：类型不对、越界、选项里没有，一律退回默认 */
function coerce(decl: PluginParamDecl, value: any): string | number | boolean {
  switch (decl.type) {
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) return Number(decl.default) || 0;
      return Math.min(decl.max ?? Infinity, Math.max(decl.min ?? -Infinity, n));
    }
    case 'bool': {
      if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        return !(s === '' || s === '0' || s === 'false' || s === 'no' || s === 'off');
      }
      return !!value;
    }
    case 'select': {
      const v = String(value ?? '');
      // 对 optionsFrom（如 audio-inputs 等动态数据源）：
      // 前端设备列表来自 navigator.mediaDevices，主进程静态 options 无法穷举 WebRTC deviceId。
      // 只要值非空，予以信任并保留；绝不强制回退为 default。
      if ((decl as any).optionsFrom) {
        return v || String(decl.default ?? '');
      }
      return (decl.options || []).some((o) => o.value === v) ? v : String(decl.default ?? '');
    }
    default:
      return String(value ?? '');
  }
}


/**
 * 系统音频输入设备（麦克风）清单 —— **只读缓存，绝不在这个函数里等系统**。
 *
 * ── 为什么这件事是致命的（踩过一次，症状是"点哪都要等半秒"）──────────────
 *
 * 从前这里是 `execSync('powershell ... Win32_SoundDevice')`：**同步**起一个
 * PowerShell，实测 ~320 ms。而它挂在 `readParamDecls` 里，于是**每一个**走
 * `loadPlugins()` 的地方都得付这笔钱 —— 那是这个软件最热的函数：
 *   · 渲染层每次加载（Ctrl+R、刷新）→ `ext:list` → loadPlugins
 *   · 打开设置面板 → `ext:sections` → settingsSections → loadPlugins
 *   · **每一轮对话**（工具表要现算）→ loadPlugins
 *
 * 主进程只有一条事件循环，execSync 期间**所有** IPC 都堵死 —— 表现就是
 * "设置面板要等一秒才开"、"Ctrl+R 不是瞬间了"，而在插件里找不到任何可疑代码。
 *
 * 现在：**同步路径只读缓存**（首次为空列表，几个微秒），真去问系统的那一次
 * 走后台异步，回来了再喊一声重画。设置面板本来就会用 `navigator.mediaDevices`
 * 自己扫一遍设备，所以"等一下才冒出来"这件事对用户没有影响。
 */
let audioInputCache: { value: string; label: string }[] | null = null;
let audioScanning = false;

const AUDIO_DEFAULT: { value: string; label: string }[] = [{ value: 'default', label: t('系统默认麦克风') }];

/** 现在能拿到的设备清单（缓存）。**不含任何阻塞** —— 热路径只许调它 */
function audioInputOptions(): { value: string; label: string }[] {
  if (audioInputCache) return audioInputCache;
  // 还没扫过/it 在扫：先给默认那一条，同时催一次后台扫描
  void scanAudioInputs();
  return AUDIO_DEFAULT;
}

/** 后台扫一次系统音频设备。同一时刻只跑一个；扫完更新缓存并喊界面重画 */
function scanAudioInputs(): Promise<void> {
  if (audioScanning) return Promise.resolve();
  if (process.platform !== 'win32') return Promise.resolve();
  audioScanning = true;
  return new Promise((resolve) => {
    let done = false;
    const finish = (list?: { value: string; label: string }[]) => {
      if (done) return;
      done = true;
      audioScanning = false;
      /*
       * **不论成败都落缓存**：失败（没 PowerShell、超时、机器上没麦克风）也记成"问过了"。
       * 不记的话，热路径每次都会再催一次扫描 —— 而"失败"恰恰是最容易反复发生的那一档，
       * 那就成了每轮对话都在后台起一个 PowerShell，比原来还糟。
       * 设备真变了也不要紧：设置面板那边是渲染层自己用 navigator.mediaDevices 扫的。
       */
      const next = list && list.length > 1 ? list : AUDIO_DEFAULT;
      const grew = (audioInputCache?.length ?? 0) < next.length;
      audioInputCache = next;
      if (grew) {
        // 界面那边此刻可能正画着设置面板：喊一声，让它把新设备接上下拉
        try {
          refresher();
        } catch {
          /* 界面还没起来就算了，下次读缓存一样拿得到 */
        }
      }
      resolve();
    };
    try {
      const { exec } = require('child_process');
      const psCmd = `powershell -NoProfile -Command "Get-CimInstance Win32_SoundDevice | Where-Object { $_.Status -eq 'OK' } | Select-Object -ExpandProperty Name"`;
      exec(psCmd, { encoding: 'utf8', timeout: 5000 }, (err: any, stdout: string) => {
        if (err || !stdout) return finish();
        const lines = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        const unique: string[] = Array.from(
          new Set(lines.filter((name) => !/speaker|扬声器/i.test(name))),
        );
        finish([...AUDIO_DEFAULT, ...unique.map((n) => ({ value: n, label: n }))]);
      });
    } catch {
      finish();
    }
  });
}

/**
 * `optionsFrom: 'models'` 的选项：软件里配好的模型，值就是 `提供方::模型`。
 * 没配密钥的也列出来（只是标一下）—— 挑的时候看得见，比藏起来有用。
 */
function modelOptions(): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  // 目录是外来的（providers.json 多插件一起写）—— 一条脏的只丢它自己，不许连累整份清单
  for (const p of modelCatalog() || []) {
    if (!p || !p.key) continue;
    for (const m of Array.isArray(p.models) ? p.models : []) {
      if (!m || !m.id) continue;
      out.push({ value: `${p.key}::${m.id}`, label: `${m.name || m.id} · ${p.label}${p.hasKey ? '' : t('（没配密钥）')}` });
    }
  }
  return out;
}

/**
 * 读一个插件声明的参数（`module.exports.params`）。
 *
 * 一个声明要么写成 `{ key: {…} }`，要么写成 `[{ key, … }]` —— 两种都收，
 * 因为"改一条要动两处"（键 + 里面的 key）是没必要的啰嗦。
 *
 * 写错的那一条**只忽略它自己**，不整块丢掉：一个手滑的声明不该让这个插件
 * 其余的参数都调不了。形状跟 readPanelDecl 一个路子：外来的东西先校验再信。
 */
function readParamDecls(mod: any): PluginParamDecl[] {
  const raw = mod?.params;
  const items: Array<[string, any]> = Array.isArray(raw)
    ? raw.map((d: any) => [String((d && d.key) || ''), d])
    : raw && typeof raw === 'object'
      ? Object.keys(raw).map((k) => [k, raw[k] && typeof raw[k] === 'object' ? raw[k] : {}] as [string, any])
      : [];
  const out: PluginParamDecl[] = [];
  for (const [name, d] of items) {
    const key = String(d?.key || name || '').trim();
    if (!key || out.some((p) => p.key === key)) continue;
    const def = d?.default;
    const type: PluginParamDecl['type'] =
      d?.type === 'text' || d?.type === 'number' || d?.type === 'bool' || d?.type === 'select'
        ? d.type
        : typeof def === 'boolean'
          ? 'bool'
          : typeof def === 'number'
            ? 'number'
            : 'text';
    const decl: PluginParamDecl = {
      key,
      label: String(d?.label || key),
      type,
      default:
        type === 'number' ? (Number.isFinite(Number(def)) ? Number(def) : 0) : type === 'bool' ? !!def : String(def ?? ''),
    };
    if (typeof d?.hint === 'string' && d.hint) decl.hint = d.hint;
    if (d?.multiline === true) decl.multiline = true;
    if (type === 'number') {
      if (Number.isFinite(Number(d?.min))) decl.min = Number(d.min);
      if (Number.isFinite(Number(d?.max))) decl.max = Number(d.max);
      if (Number.isFinite(Number(d?.step)) && Number(d.step) > 0) decl.step = Number(d.step);
    }
    if (type === 'select') {
      const opts = Array.isArray(d?.options) ? d.options : [];
      decl.options = opts
        .map((o: any) =>
          typeof o === 'string' ? { value: o, label: o } : { value: String(o?.value ?? ''), label: String(o?.label ?? o?.value ?? '') },
        )
        .filter((o: { value: string }) => Boolean(o.value));
    }
    // 选项由核心现填的那一路（`optionsFrom: 'models'`）：静态那几条排在前面
    // （插件自己写的"跟面板走（不单独指定）"就是它），后面接上软件里配好的模型清单。
    if (type === 'select' && d?.optionsFrom === 'audio-inputs') {
      decl.optionsFrom = 'audio-inputs';
      decl.options = [...(decl.options ?? []), ...audioInputOptions()];
    }
    if (type === 'select' && d?.optionsFrom === 'models') {
      decl.optionsFrom = 'models';
      decl.options = [...(decl.options ?? []), ...modelOptions()];
    }
    // 一条选项都没有的 select（声明写歪了、模型也一个没配）留一条兜底，
    // 免得设置面板画出一个空下拉 —— 空控件比一句"没得选"更像坏了。
    if (type === 'select' && !(decl.options ?? []).length) {
      decl.options = [{ value: String(decl.default ?? ''), label: String(decl.default ?? '') }];
    }
    out.push(decl);
  }
  return out;
}

/** 某个插件此刻生效的参数值：设过的用设的（校验过），没设过的用默认 */
function paramValues(name: string, decls: PluginParamDecl[]): Record<string, string | number | boolean> {
  const mine = { ...(readParamStore()[name] || {}), ...(projectParamStore[name] || {}) };
  const out: Record<string, string | number | boolean> = {};
  for (const d of decls) out[d.key] = d.key in mine ? coerce(d, mine[d.key]) : d.default;
  return out;
}

/** 所有插件的参数快照（只有声明了参数的插件在里面）—— plugins/plugin-kit 拿它给助手看 */
export function pluginParamViews(): PluginParamView[] {
  return [...instances.values()]
    .filter((i) => i.info.params.length > 0)
    .map((i) => ({
      name: i.info.name,
      description: i.info.description,
      enabled: i.info.enabled,
      params: i.info.params,
      values: i.info.values,
    }));
}

/**
 * 设置里**有哪些插件分区**（导航用）。
 *
 * 先 loadPlugins 一次：分区是 setup 里现注册的，没装过就没有 —— 插件刚改完、
 * 刚被启用，这里也得当场看得见。loadPlugins 本身很便宜（没变化的插件只 stat 一次）。
 */
export async function settingsSections(): Promise<PluginSettingsRef[]> {
  loadPlugins(store.disabledPlugins());
  const out: PluginSettingsRef[] = [];
  for (const inst of instances.values()) {
    if (!inst.info.enabled) continue;
    for (const s of inst.sections) {
      // 条数顺手现算一个：导航上"员工 4"比光一个名字有用得多。
      // 算不出来不算错 —— 那一页点进去会自己把原因写在正文里，别让导航整片空着。
      let count = 0;
      try {
        const v = await s.view();
        count = Array.isArray(v?.rows) ? v.rows.filter((r) => r?.role !== 'control').length : 0;
      } catch {
        count = 0;
      }
      out.push({
        plugin: inst.name,
        id: s.id,
        label: s.label,
        hint: s.hint,
        placement: s.placement,
        inline: s.inline,
        count,
        after: s.after,
        group: s.group,
        parent: s.parent,
        order: s.order,
      });
    }
  }
  return out;
}

/** 某一页此刻的内容。找不到这个分区就返回 null（插件被关了、改名了） */
export async function settingsSectionView(plugin: string, id: string): Promise<PluginSettingsView | null> {
  const sec = findSection(plugin, id);
  if (!sec) return null;
  try {
    return await sec.view();
  } catch (e: any) {
    return { rows: [], empty: t('这一页读不出来：{e}', { e: e?.message ?? e }) };
  }
}

/** 分区里点了个按钮：把那一下递回插件，回一句回执（插件不返回就回一句"做完了"） */
export async function runSettingsAction(
  plugin: string,
  id: string,
  actionId: string,
  rowId: string,
): Promise<{ ok: boolean; reply?: string; error?: string }> {
  const sec = findSection(plugin, id);
  if (!sec) return { ok: false, error: t('这个分区不在了（插件被停用或删了）') };
  if (typeof sec.onAction !== 'function') return { ok: false, error: t('这一页没有可点的动作') };
  try {
    const reply = await sec.onAction(String(actionId || ''), String(rowId || ''));
    return { ok: true, reply: typeof reply === 'string' ? reply : '' };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

function findSection(plugin: string, id: string): SettingsSectionReg | null {
  loadPlugins(store.disabledPlugins());
  const name = String(plugin || '');
  const sid = String(id || '');
  for (const inst of instances.values()) {
    if (inst.name !== name) continue;
    return inst.sections.find((s) => s.id === sid) ?? null;
  }
  return null;
}

/**
 * 改任意插件的参数 —— 设置面板和助手插件（plugin_params 工具）都走这一份校验。
 * value 传 null = 恢复默认。改完**不立刻重载**：下一次 loadPlugins 看到文件变了会重来一套。
 */
export function setPluginParam(plugin: string, key: string, value: any): { ok: boolean; error?: string } {
  const inst = [...instances.values()].find((i) => i.name === plugin);
  if (!inst) return { ok: false, error: `没有这个插件：${plugin}` };
  const decl = inst.info.params.find((d) => d.key === key);
  if (!decl) return { ok: false, error: `插件 ${plugin} 没有可调参数 ${key}` };

  const personal = readParamStore()[plugin]?.[key];
  const before = personal === undefined ? decl.default : coerce(decl, personal);
  const next = value === null ? decl.default : coerce(decl, value);
  if (next !== before) writeParamValue(plugin, key, value === null ? null : next);
  // 界面立刻看到新值，不用等下一次 loadPlugins 把插件装完
  inst.info.values = paramValues(inst.name, inst.info.params);
  inst.paramValues = inst.info.values;
  return { ok: true };
}

/** 参数动过：每个插件重新装一次（旧的先 dispose）—— 新参数只在新的一份实例里生效 */
function remountAll(): void {
  for (const [dir, inst] of [...instances]) {
    instances.set(dir, mount(dir, inst.label, inst.info.source, inst));
  }
}

function makeHost(inst: Instance): PluginHost {
  const tag = `[插件 ${inst.name}]`;
  const pluginWorkspace = workspaceRoot();
  return {
    environments: {
      directory: environmentDirectory,
      registerPython: record => registerPythonEnvironment(record, pluginWorkspace),
    },
    onFileWrite(fn) { if (typeof fn === 'function') inst.fileWrite.push(fn); },
    files: {
      write: (rel, text) => writeText(rel, text),
      revision: (rel) => fileWrites.revision(safePath(rel)),
      restore: (rel, before, expected) => fileWrites.restore(safePath(rel), before, expected),
    },
    tasks: {
      submit: (request, context) => {
        assertPanelActive();
        if (!store.panel(request.panelId) || !store.panel(context.panelId)) return { ok: false, error: '派单面板不存在' };
        return tasks().submit(request, context);
      },
      get: (id, panelId) => tasks().get(id, panelId),
      request: (id, panelId) => tasks().request(id, panelId),
      list: (panelId) => tasks().list(panelId),
      cancel: (id, panelId) => { assertPanelActive(); return tasks().cancel(id, panelId); },
      cancelCorrelation: (id, panelId) => { assertPanelActive(); return tasks().cancelCorrelation(id, panelId); },
      delivered: (id, panelId, files) => { assertPanelActive(); tasks().delivered(id, panelId, files); },
      accept: (id, panelId, note) => { assertPanelActive(); return tasks().accept(id, panelId, note); },
    },
    buildProject: (target, scope) => projectBuilder(target, scope),
    addTool(spec, handler) {
      if (!spec?.name || typeof handler !== 'function') return;
      if (inst.tools.some((t) => t.spec.name === spec.name)) return; // 自己重名就忽略
      inst.tools.push({ spec, handler, plugin: inst.name });
      // info.tools 是给设置面板看的，登记一次就够
      if (!inst.info.tools.some((t) => t.name === spec.name)) {
        inst.info.tools.push({ name: spec.name, description: spec.description ?? '', kits: Array.isArray(spec.kits) ? spec.kits.map(String).filter(Boolean) : undefined });
      }
    },
    onBeforeWrite(fn) {
      if (typeof fn === 'function') inst.beforeWrite.push(fn);
    },
    onBeforeTool(fn) {
      if (typeof fn === 'function') inst.beforeTool.push(fn);
    },
    onAfterTool(fn) {
      if (typeof fn === 'function') inst.afterTool.push(fn);
    },
    onReasoning(fn) {
      if (typeof fn === 'function') inst.reasoning.push(fn);
    },
    ask(spec) {
      assertPanelActive();
      // 只说"请求谁提的"：核心那边不用认识插件，插件也不用认识界面
      if (!spec?.panelId || !spec?.then?.tool) return;
      // questions 一起带过去：渲染层照着它画问题表单（见 ChatDock.tsx）
      askUser({ ...spec, text: String(spec.text || '') });
    },
    send: (panelId, text, images, opts) => {
      assertPanelActive();
      // 带 steer 且有话要说：交给核心分流（在跑 = 插话，没在跑 = 起一轮）
      return opts && opts.steer && !(images && images.length)
        ? chatSteerer(panelId, text)
        : chatSender(panelId, text, images, { ...opts, signal: opts?.signal ?? currentPanelSignal() });
    },
    // 三个都走 liveSink 转一手：真正干这件事的是 IPC 那边（它才够得着对话和窗口）
    live: {
      show: (panelId, task) => { assertPanelActive(); liveSink.show(panelId, task); },
      hide: (panelId, key) => { assertPanelActive(); liveSink.hide(panelId, key); },
      image: (panelId, file) => { assertPanelActive(); liveSink.image(panelId, file); },
    },
    addPrompt(fn, opts) {
      if (typeof fn === 'function') inst.prompts.push({ fn, scope: readScope(opts) });
    },
    addCommand(spec, handler) {
      const id = String(spec?.id ?? '').trim();
      // id 得是个干净的词：它要当 /xxx 在输入框里认，带空格、斜杠就对不上号
      // 汉字也算干净的字（/工具 这样直接写中文的命令要在输入框里认得出）
      if (!/^[\w\u4e00-\u9fa5-]+$/.test(id) || typeof handler !== 'function') return;
      // 重名不理，先注册的赢 —— 和工具"重名核心赢"一个精神，免得两条命令抢一个 /
      if (inst.commands.some((c) => c.id === id)) return;
      inst.commands.push({ id, label: spec.label, hint: spec.hint, handler, plugin: inst.name });
    },
    askModel: (panelId, spec) =>
      modelAsker(String(panelId || ''), {
        system: String(spec?.system || ''),
        user: String(spec?.user || ''),
        maxTokens: spec?.maxTokens,
        signal: spec?.signal,
        pick: spec?.pick ? String(spec.pick) : '',
      }),
    models: () => modelCatalog(),
    upsertProvider: (p) => providerUpserter(p),
    credential: (providerKey) => credentialReader(String(providerKey || '')),
    saveCredential: (slot, value) => credentialWriter(String(slot || ''), String(value ?? '')),
    clearChat: (panelId) => chatClearer(String(panelId || '')),
    compressChat: (panelId) => chatCompressor(String(panelId || '')),
    tools: (panelId) => toolLister(String(panelId || '')),
    allPluginTools: () => [...instances.values()].flatMap((i) => i.tools.map((t) => t.spec)),
    addStatusItem(item) {
      if (item?.id && typeof item.text === 'function') inst.status.push(item);
    },
    /** 让界面重画一次 —— 状态部件是广播时现算的，插件数据变了得喊一声 */
    refresh: () => refresher(),
    /**
     * 在设置里单开一个分区 —— 声明（名字、说明）留在实例上，界面照着它列导航；
     * **函数不过 IPC**，内容由这边的 `view()` 现算，界面拿到的是当下一刻那份数据。
     * 同一个 id 再注册一次算更新：插件改了声明要能覆盖上去，而不是长出两条。
     */
    addSettingsSection(spec) {
      const id = String((spec && spec.id) || '').trim();
      if (!id || typeof spec?.view !== 'function') return;
      const reg: SettingsSectionReg = {
        id,
        label: String(spec.label || id).trim() || id,
        hint: spec.hint ? String(spec.hint) : undefined,
        placement: spec.placement === 'more' ? 'more' : undefined,
        inline: spec.inline,
        group: spec.group === 'extension' ? 'extension' : spec.group === 'main' ? 'main' : undefined,
        parent: spec.parent ? String(spec.parent) : undefined,
        order: Number.isFinite(spec.order) ? spec.order : undefined,
        // 排在哪一页下面 —— 插件声明的，导航照着摆（不填就在内置页后面收尾）
        after: spec.after ? String(spec.after) : undefined,
        view: spec.view,
        onAction: typeof spec.onAction === 'function' ? spec.onAction : undefined,
        plugin: inst.name,
      };
      const at = inst.sections.findIndex((s) => s.id === id);
      if (at >= 0) inst.sections[at] = reg;
      else inst.sections.push(reg);
    },
    /**
     * 插件自报一根技能根 —— 转手交给 skills.ts 那本账。
     * 来源标签带上插件名，插件停用/卸载时按它整批撤（见 dropSkillRoots）。
     */
    addSkillRoot(dir, source, rank) {
      const d = String(dir || '').trim();
      if (!d) return;
      const label = String(source || '').trim() || `插件 ${inst.name}`;
      regSkillRoot(d, label, typeof rank === 'number' && Number.isFinite(rank) ? rank : 40);
    },
    // 只在压缩那一刻被调，所以它自己不缓存、不记账 —— 现取现给最新的一份
    addSummaryNote(fn) {
      if (typeof fn === 'function') inst.summaryNotes.push(fn);
    },
    addCompactPick(fn) {
      if (typeof fn === 'function') inst.compactPicks.push(fn);
    },
    panels: () =>
      Object.values(store.state.panels).map((p) => {
        // 正在跑的那一轮的账贴在快照上（不进 store、不落盘）：那一轮要到结束才进
        // panel.chat，插件光看消息是看不到它的 —— 用量状态条就是靠这个中途才动得起来。
        const live = store.liveStats(p.id);
        const turn = store.liveTurn(p.id);
        if (!live && !turn) return p;
        return { ...p, ...(live ? { live } : {}), ...(turn ? { liveTurn: turn } : {}) };
      }),
    /** 这一块此刻真的在跑吗（内存态，不是落盘的 status）—— 见接口上那段说明 */
    isRunning: (id) => runningProbe(String(id || '')),
    /** 排队：这一句摆着，等这一轮跑完自动接着发（跟聊天区那个待发队列同一份账） */
    enqueue: (panelId, text, images) => { assertPanelActive(); return chatEnqueuer(panelId, text, images); },
    createPanel: (partial) => {
      assertPanelActive();
      const p = store.createPanel(partial ?? {});
      refresher();
      return p;
    },
    hidePanel: (id) => {
      const ok = store.hidePanel(String(id || ''));
      if (ok) refresher();
      return ok;
    },
    showPanel: (id) => {
      const ok = store.showPanel(String(id || ''));
      if (ok) refresher();
      return ok;
    },
    activatePanel: (id) => {
      const pid = String(id || '');
      if (!store.panel(pid)) return false;
      // store.activate 自己认“后台的先叫回来”，这里不再分一次
      store.activate(pid);
      refresher();
      return true;
    },
    floatPanel: (id, host, anchor, box) => {
      const pid = String(id || '');
      if (!store.panel(pid)) return false;
      const h = String(host || '') || MAIN_HOST;
      const root = h === MAIN_HOST ? store.state.layout : store.state.floating.find((w) => w.id === h)?.root;
      if (!root) return false;
      // anchor 给空串 = 落进那个窗口的第一个区域（不猜一个不存在的区域，那会画不出来）
      const at = String(anchor || '') || firstTabId(root);
      if (!at) return false;
      store.floatPanel(pid, h, at, {
        rx: clamp01(box?.rx),
        ry: clamp01(box?.ry),
        width: Math.max(120, Number(box?.width) || 260),
        height: Math.max(80, Number(box?.height) || 180),
      });
      refresher();
      return true;
    },
    moveFloatPanel: (id, patch) => {
      const pid = String(id || '');
      if (!store.panel(pid)?.float) return false;
      store.moveFloat(pid, patch ?? {});
      refresher();
      return true;
    },
    unfloatPanel: (id) => {
      const pid = String(id || '');
      if (!store.panel(pid)?.float) return false;
      store.unfloatPanel(pid);
      refresher();
      return true;
    },
    floatWidget: (id, box) => {
      const pid = String(id || '');
      if (!store.panel(pid)) return false;
      store.floatWidget(pid, box ?? {});
      refresher();
      return true;
    },
    moveWidgetPanel: (id, patch) => {
      const pid = String(id || '');
      if (!store.panel(pid)?.widget) return false;
      store.moveWidget(pid, patch ?? {});
      refresher();
      return true;
    },
    unwidgetPanel: (id) => {
      const pid = String(id || '');
      if (!store.panel(pid)?.widget) return false;
      store.unwidget(pid);
      refresher();
      return true;
    },
    widgetPanels: () => store.widgetList(),
    /**
     * 关掉一块面板。
     *
     * 为什么插件需要它：桌面组件是一个**摆在那儿的物件** —— 用户看着它、不想要了，
     * 第一反应就是当场删掉，而不是"收回布局、再切到那块面板、再关它"三步走。
     * 没有这个口子，插件只能把它从桌面上摘掉，面板本体还赖在布局里。
     *
     * 走的还是核心那条路（store.closePanel）：声明过的回组件库、没声明的进历史会话，
     * **不是真删** —— 手滑了还捞得回来。这条底线不能因为"插件要删东西"就破。
     */
    closePanel: (id) => {
      const pid = String(id || '');
      if (!store.panel(pid)) return false;
      const ok = store.closePanel(pid);
      if (ok) refresher();
      return ok;
    },
    detachPanel: (id, at, size) => {
      const win = store.detachPanel(String(id || ''), at, size);
      refresher();
      return Boolean(win);
    },
    openComponent: (id) => {
      const p = store.openComponent(id);
      refresher();
      return p ?? null;
    },
    componentRefs: () => store.componentRefs(),
    componentCrafts: () => store.componentCrafts(),
    patchPanel: (id, patch) => {
      assertPanelActive();
      const p = store.patchPanel(String(id || ''), patch ?? {});
      if (p) refresher();
      return p ?? null;
    },
    setModel: (id, pick) => {
      assertPanelActive();
      const pid = String(id || '');
      if (!store.panel(pid)) return false;
      store.setPanelModel(pid, String(pick || '')); // 只钉这一块、不碰 lastPick：那是"用户上次手动选的"，插件给员工换模型把它盖掉，没自己选过模型的面板就全跟着漂
      refresher();
      return true;
    },
    modelPick: (id) => store.panel(String(id || '')) ? store.pickForPanel(String(id)) : '',
    setThink: (id, level) => {
      const pid = String(id || '');
      if (!store.panel(pid)) return;
      store.setThinkFor(pid, String(level || ''));
      refresher();
    },
    log: (...a: any[]) => console.log(tag, ...a),
    param<T = any>(key: string, fallback?: T): T {
      const v = inst.paramValues[String(key)];
      return v === undefined ? (fallback as T) : (v as T);
    },
    setParam(key, value) {
      // 没声明过的 key 不收：声明才是这份值的形状，随手记点东西请用 state
      if (!inst.info.params.some((d) => d.key === String(key))) return;
      setPluginParam(inst.name, String(key), value);
    },
    allParams: () => pluginParamViews(),
    setPluginParam: (plugin, key, value) => setPluginParam(String(plugin || ''), String(key || ''), value),
    get workspace() {
      return pluginWorkspace;
    },
    dataPath: rel => runtimePath(rel, pluginWorkspace),
    state: {
      load<T = any>(fallback?: T): T {
        return safeReadJson<T>(stateFile(inst.name, pluginWorkspace), fallback);
      },
      save(value: any) {
        assertPanelActive();
        try {
          atomicWriteJson(stateFile(inst.name, pluginWorkspace), value);
          return true;
        } catch (e: any) {
          console.error(tag, t('状态原子写入失败：'), e?.message ?? e);
          return false;
        }
      },
    },
  };
}

/** 关掉一个实例：插件可以导出 dispose() 收拾自己的摊子（外部进程、定时器……） */
function dispose(inst: Instance) {
  // 它自报的技能根跟着撤 —— 插件都歇了，它那本技能库不该还挂在清单上
  try {
    unregSkillRoots(`插件 ${inst.name}`);
  } catch {
    /* 撤不掉不算错：下次装载会以同一路径去重 */
  }
  try {
    if (typeof inst.mod?.dispose === 'function') inst.mod.dispose();
  } catch (e: any) {
    console.error(`[插件 ${inst.name}] dispose 出错：`, e?.message ?? e);
  }
}

/** 把一个插件目录装进来（或者因为文件变了重装） */
function mount(dir: string, label: string, source: string, stale?: Instance): Instance {
  const file = path.join(dir, 'index.js');
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    /* 下面 require 会报出来 */
  }

  const info: PluginInfo = {
    name: path.basename(dir),
    description: '',
    dir: label,
    tools: [],
    enabled: true,
    params: [],
    values: {},
    source,
  };
  const inst: Instance = {
    dir,
    label,
    name: info.name,
    mtime,
    mod: null,
    paramValues: {},
    summaryNotes: [],
    compactPicks: [],
    info,
    tools: [],
    beforeWrite: [],
    beforeTool: [],
    afterTool: [],
    fileWrite: [],
    reasoning: [],
    prompts: [],
    status: [],
    commands: [],
    /** 设置分区：setup 里 addSettingsSection 现注册，所以初始是空的 */
    sections: [],
  };

  if (stale) dispose(stale);

  /*
   * 插件里的 t() 取自**全局那一份**（见 lang.ts 的 installForPlugins：插件是外来的
   * CJS，不该自己去 import 核心内部路径）。可"插件什么时候被 require"只由这里决定 ——
   * 所以这份保证放在这儿，而不是指望每个调用点都记得先 loadLang：谁先谁后都成立。
   * 少了这一步，加载早于语言初始化时，顶层就写 t(...) 的插件会当场"t is not defined"，
   * 整份工具静默消失（踩过）。
   */
  if (typeof (globalThis as any).t !== 'function') {
    (globalThis as any).t = t;
    (globalThis as any).__ensoulI18n = { t, getLang: () => 'zh', onLang: () => () => {} };
  }
  try {
    /*
     * 插件自带的词典：`<插件目录>/locales/<lang>.json`。
     *
     * 为什么在这儿读：插件的文案是**它自己的私有文案**，不该摊在核心词典里
     * （核心词典那三行规矩头一条就是"严格限于核心渲染层"）。住自己家里还有
     * 个实打实的好处：插件增删词条不用动核心、也不会跟核心的词条互相盖。
     *
     * 读不到不是错误 —— 没词典的插件照旧跑，取词回落成中文原文。
     */
    try {
      const locFile = path.join(dir, 'locales', 'en.json');
      if (fs.existsSync(locFile)) {
        const dict = JSON.parse(fs.readFileSync(locFile, 'utf8'));
        if (dict && typeof dict === 'object') i18n.registerLocale('en', dict, { keepExisting: true });
      }
    } catch (e: any) {
      console.warn(`[插件 ${info.name}] 词典读不出来（不影响装载）：`, e?.message ?? e);
    }

    // 清掉缓存：改了插件文件就该拿到新代码，不然"改了没反应"又来了
    delete require.cache[require.resolve(file)];
    inst.mod = require(file);
  } catch (err: any) {
    info.enabled = false;
    info.error = `加载失败：${err?.message ?? err}`;
    return inst;
  }

  inst.name = String(inst.mod?.name || path.basename(dir));
  info.name = inst.name;
  info.description = String(inst.mod?.description || '');
  try {
    registerPluginStorage(dir, inst.mod);
  } catch (error) {
    info.enabled = false;
    info.error = `存储声明无效：${(error as Error).message}`;
    return inst;
  }
  // 自带面板：声明纯数据留在 info 里（跟着 ws/ext 的清单一起去渲染进程），
  // 真正的脸在插件目录的 panel.tsx，由渲染层扫。
  info.panel = readPanelDecl(inst.mod);
  // 可调参数：声明来自插件，值来自 plugin-params.json（没设过的用声明里的默认）。
  // 这份快照跟着 info 一起去设置面板，也留在实例上供 setup 里的 api.param() 读。
  info.params = readParamDecls(inst.mod);
  info.values = paramValues(inst.name, info.params);
  inst.paramValues = info.values;

  if (typeof inst.mod?.setup !== 'function') {
    info.enabled = false;
    info.error = t('没有导出 setup 函数');
    return inst;
  }

  try {
    const r = inst.mod.setup(makeHost(inst));
    // setup 可以返回一个 Promise：异步去连外部服务、准备好了再 addTool。
    // 不 await —— 一条消息不该为了插件连接停在那儿；工具准备好了自然会出现。
    if (r && typeof r.then === 'function') {
      r.catch((err: any) => {
        info.error = `setup 异步出错：${err?.message ?? err}`;
        console.error(`[插件 ${inst.name}]`, info.error);
      });
    }
  } catch (err: any) {
    info.enabled = false;
    info.error = `setup 出错：${err?.message ?? err}`;
  }
  return inst;
}

/**
 * 扫一遍两个插件根，需要装的装上、改过的重装、没了的扔掉，然后把产物汇总出来。
 * 每条消息都会调一次，所以它必须是便宜的：没变化的插件只做一次 stat。
 */
export function loadPlugins(disabled: string[] = []): LoadedPlugins {
  const nextWorkspace = workspaceRoot();
  preparePluginStorage(nextWorkspace);
  if (!migratedWorkspaces.has(nextWorkspace)) {
    const migration = migrateRuntimeData(nextWorkspace);
    if (migration.errors.length) console.error('[数据迁移] 部分文件未复制：', migration.errors);
    else migratedWorkspaces.add(nextWorkspace);
  }
  if (nextWorkspace !== workspaceStamp) {
    for (const inst of instances.values()) dispose(inst);
    instances.clear();
    workspaceStamp = nextWorkspace;
    paramStamp = -1;
    projectParamStamp = -1;
  }
  /*
   * 语言变了：插件声明里的 label / hint、工具描述、以及模块顶层的 t() 都是
   * **require 那一刻算死的** —— 界面重画多少遍都救不回来，值早从主进程送出去了。
   * 唯一的办法是让每个插件重新 require 一遍。
   *
   * 为什么必须放在这一层，不能塞进下面那个参数分支里：参数没动过时那个 if 整块不执行，
   * 于是「只切语言、不碰参数」这条最常见路径一次都不重挂 —— 插件描述就永远冻在旧语言上，
   * 表现成「中文界面配英文描述」。判据只是一次字符串比较，这一层每轮都会走到。
   */
  const curLang = String(i18n.getLang());
  if (curLang !== langStamp) {
    langStamp = curLang;
    remountAll();
  }
  // 参数文件动过（用户在设置面板里改，或者助手用 plugin_params 改）→ 每个插件重新装一遍，
  // 让它们读到新值。这是"参数生效"的唯一时机，所以放在扫目录之前：这一轮拿到的就是新配置。
  if (paramMtime() !== paramStamp || projectParamMtime() !== projectParamStamp) {
    readParamStore(); // 顺手把内存里那份换成新的（它内部会把 paramStamp 更新掉）
    readProjectParamStore();
    remountAll();
  }
  const out: LoadedPlugins = { tools: [], beforeWrite: [], beforeTool: [], afterTool: [], fileWrite: [], prompts: [], status: [], commands: [], summaryNotes: [], compactPicks: [], sections: [], info: [] };
  const alive = new Set<string>();
  /**
   * 插件目录名 -> 赢的那个根。**先扫到的赢**，而 pluginRoots 是
   * 工作区在前、软件自带在后 —— 于是「把 plugins/git 复制到 .ensoul/plugins/git 改一改」
   * 就成了不用动源码的覆盖补丁：程序更新不会把你的改动冲掉。
   *
   * 以前这里两个根都收，同名插件的工具会各进一份（工具表里两个同名 schema，
   * 执行时只有先扫到的那份真正被调用）—— 那是个静默的坏状态，一并修掉。
   */
  const claimed = new Set<string>();

  for (const root of pluginRoots()) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue; // 没有这个目录不是错误
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(root.dir, e.name);
      const file = path.join(dir, 'index.js');
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        continue; // 目录里没有 index.js，不算插件
      }
      // 名字已被更高优先级的根占了：这一份整个跳过（连装都不装）——
      // 工作区里的同名插件就是来顶替它的。次序要紧：得先确认这边真是个插件
      // （有 index.js）再占名字，否则工作区里一个空目录就能把自带插件整个顶掉。
      if (claimed.has(e.name)) {
        // 这正是"补丁生效"的那一刻，说出来 —— 静默顶替是最难查的那种怪
        console.log(`[插件] ${root.source} 的 ${e.name} 被更高优先级的同名插件顶替，跳过`);
        continue;
      }
      claimed.add(e.name);
      alive.add(dir);
      const label = `${root.dir === pluginsDir() ? DIR : '.ensoul/plugins'}/${e.name}`;

      const old = instances.get(dir);
      if (!old || old.mtime !== mtime) {
        instances.set(dir, mount(dir, label, root.source, old));
      }
    }
  }

  // 目录没了（被删、被改名，或者换了工作区）就把实例收掉
  for (const [dir, inst] of [...instances]) {
    if (!alive.has(dir)) {
      dispose(inst);
      instances.delete(dir);
    }
  }

  for (const inst of instances.values()) {
    const off = disabled.includes(inst.info.name);
    inst.info.enabled = !off && !inst.info.error;
    // 停用的插件**照样列出来** —— 不然设置面板里就找不到它，也就再也开不回来了
    out.info.push(inst.info);
    // 声明里带 optionsFrom 的那几条：选项是运行时的（模型清单随时会变），每次加载重算一遍 ——
    // 不然用户刚加完提供方，设置里那个下拉还是旧的。
    if (inst.info.params.some((d) => d.optionsFrom)) {
      inst.info.params = readParamDecls(inst.mod);
      // 值也要跟着重算：选项变了之后，原先存的那个可能已经不在清单里了 ——
      // 让 coerce 把它落回默认（"跟面板走"），而不是留一个认不出的 pick 在那儿。
      inst.info.values = paramValues(inst.name, inst.info.params);
      inst.paramValues = inst.info.values;
    }
    // 但它不许再贡献任何东西：工具、钩子、提示、状态部件，一样都不给
    if (off || inst.info.error) continue;
    out.tools.push(...inst.tools);
    out.beforeWrite.push(...inst.beforeWrite);
    out.beforeTool.push(...inst.beforeTool);
    out.afterTool.push(...inst.afterTool);
    out.fileWrite.push(...inst.fileWrite);
    out.prompts.push(...inst.prompts);
    out.status.push(...inst.status);
    out.summaryNotes.push(...inst.summaryNotes);
    out.compactPicks.push(...inst.compactPicks);
    out.commands.push(...inst.commands);
    out.sections.push(...inst.sections);
  }

  out.info.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
