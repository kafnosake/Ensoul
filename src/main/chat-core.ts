import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage, ModelConfig, Panel, PanelMode } from '../shared/types';
import { BUILTIN_KINDS } from '../shared/types';
import { skillDigest } from './skills';
import { getLang } from './lang';
import { localeTag, t } from '../shared/i18n';

/**
 * 对话内核 —— 每个浮窗的"大脑"。
 *
 * 浮窗要和用户聊两件事：
 *   1. 普通问答；
 *   2. "把这个浮窗改成……" —— 这时模型要输出一份编辑提案，
 *      提案被落写到存储，于是这个浮窗的外观与功能被真的改写并保存下来。
 *
 * 提案用带标记的 JSON 表达，比工具调用更宽容：任何兼容 OpenAI 协议的
 * 模型都能产出，不要求服务端支持 function calling。
 */

export const EDIT_OPEN = '<<<FLOAT_EDIT>>>';
export const EDIT_CLOSE = '<<<END_FLOAT_EDIT>>>';
/**
 * 「用哪种语言回答」—— 跟着界面语言走，不写死在提示里。
 *
 * 放**系统提示第一行**：它是每轮都发的硬指令，越靠前越不容易被后面的大段规矩淹掉。
 * 代价是切一次语言系统提示就变一个字、缓存前缀从这儿断开重算一遍 —— 切语言是极低频动作，可以接受。
 *
 * 英文下多说一句「下面的规矩是中文写的」：提示词目前仍是中文（正在翻），不点破的话，
 * 模型看到满屏中文、末尾又混着「说简体中文」这类残留，很容易跟着中文走。
 */
function langDirective(): string {
  if (getLang() !== 'en') return t('用简体中文回答（界面与助手同一语言）。代码、路径、工具名、字段名与命令输出保持原样，不要翻译用户内容。');
  return (
    'Reply in English. The panel UI is currently English and the user reads English. ' +
    'Write every user-visible sentence — answers, questions back to the user, progress notes, error explanations — in English, ' +
    'even though the instructions below are written in Chinese. ' +
    'Keep code, paths, tool names, JSON field names and command output exactly as they are. Do not translate content the user wrote.'
  );
}

/**
 * 四种工作模式各一段规矩 —— **切模式只增提示词，不动工具表**（模式之间工具目录保持一致）。
 *
 * 谁来拼：**doSend**（index.ts）把它拼在**本轮用户消息的头部**，跟【运行时快照】同一段。
 * 为什么不放系统提示里：它是会变的东西 —— 放在系统提示，每切一次模式，
 * 从那一句往后的**整段历史**都要重算（缓存按前缀命中，前缀一断后面全废）；
 * 拼在本轮尾部就只重算那一小段。
 * 工具表一个字不动：按模式增删工具会让前缀全废，也兑现不了「用户要求时可以查」这类承诺。
 *
 * auto（自主）**一个字都不加** —— 它就是编辑器原本的行为，老面板与默认会话完全不受影响。
 */
export function modeSection(mode?: PanelMode): string {
  if (mode === 'guess')
    return [
      t('【工作模式：推测】'),
      t('· 这一轮只做了解与推理，==不动手==：不改文件、不跑命令、不写代码、不建面板。'),
      t('· 输出结构：先说你怎么理解这个问题，再把可能的原因**按可能性从高到低排列**，每条带一句依据。'),
      t('· 为了把问题看清楚，允许读少量文件和 web_search —— 读到的只用来支撑判断。'),
      t('· 落地等用户点头：给出最可能那一条的建议，但不要自己动手改。'),
    ].join('\n');
  if (mode === 'chat')
    return [
      t('【工作模式：问答】'),
      t('· 只对话：**默认不读文件、不调工具**，凭已有知识和上下文回答。'),
      t('· 只有用户明确要求时才去查：可读文件、可 web_search；查完照旧只是回答，不动手改任何东西。'),
      t('· 不铺工程步骤、不提方案、不写代码 —— 用户要的是话，不是活。'),
    ].join('\n');
  if (mode === 'exec')
    return [
      t('【工作模式：执行】'),
      t('· 按给定要求照做，==不过多思考==、不铺背景、不提方案、不问要不要我做某事。'),
      t('· 只报结果与卡点：做完给一句结论加上改了哪些文件；卡住了就说卡在哪，不要发散。'),
      t('· 要求含糊时挑最直接的那个理解做掉，不要展开成方案讨论。'),
    ].join('\n');
  return '';
}

/** 读文本并剥掉 BOM：记事本或 PowerShell 存过的 JSON 常带 BOM，直接解析会失败 */
export function readTextFile(file: string): string {
  const raw = fs.readFileSync(file);
  return raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? raw.subarray(3).toString('utf8') : raw.toString('utf8');
}

/** 把"这个面板是什么、现在在哪"完整交代给模型 */
/**
 * 插件自带面板的声明（`plugins/<名>/index.js` 的 `panel` 字段），核心只要这三样。
 * 不从 plugins.ts 引类型 —— 提示模块不该为了一个形状反向依赖插件系统。
 */
export interface PanelKindDecl {
  kind: string;
  label?: string;
  hint?: string;
}

/**
 * 把"这个面板是什么、现在在哪"完整交代给模型。
 *
 * 这里只留**指令**（六条规矩、体系、提案格式、技能目录）。关于面板的**事实**
 * （标题、种类、位置、外观、规格）全部搬去了 buildPanelSnapshot —— 上面那句
 * 「把这个面板是什么、现在在哪完整交代给模型」现在只对了一半，事实的那一半归快照。
 *
 * `pluginPanels` 由调用点现取（index.ts 的 doSend），面板类型清单**不在这儿手写**。
 * 手写过一次：插件新加的面板类型漏在外面，还不报错，模型为了知道有哪些面板
 * 只能去翻源码 —— 正好是这一版要消灭的成本。
 */
export function buildSystemPrompt(
  panel: Panel,
  disabledSkills: string[] = [],
  pluginPanels: PanelKindDecl[] = [],
  extraSection?: string,
): string {
  // 员工工作面（dispatch 开的）走 agent 底座 —— 见下面的 buildAgentSystemPrompt。
  // 普通面板走原路：下面这个数组一个字节不动，前缀不变，缓存才留得住。
  if (panel.noWorkspacePrompt) return buildAgentSystemPrompt(panel, disabledSkills, extraSection);
  return [
    /**
     * 第一行就是语言硬指令。
     *
     * 这一行曾经**漏接**：langDirective() 定义在上面却没人调用，于是切到英文也不会有人
     * 告诉模型「说英文」—— 而下面整段规矩又都是中文（英文词典只覆盖了一部分），模型看到
     * 满屏中文，很自然就用中文回话。越靠前越不容易被后面的大段规矩淹掉，所以放第一位。
     */
    langDirective(),
    '',
    t('你运行在一个组件化、可自我进化的 Agent 编辑器运行时（Ensoul）中。'),
    t('你所在的面板本身既是交互工作台，也是一个可被重构的功能组件单元。'),
    t('面板此刻的实时状态每轮作为【运行时快照】附加在用户消息头部，动手操作前请先查阅快照。'),
    ...(panel.spec.systemPrompt ? ['', t('【本面板专属要求】'), panel.spec.systemPrompt] : []),
    '',
    t('【核心工作准则】'),
    t('1. 提问直接解答；具体操作任务直接调用工具执行，不进行推诿或空谈。'),
    t('2. 按变更范围验证：同一批改动只请求一次必要构建；主进程、preload、shared 改动构建后重启；纯界面改动构建后刷新；插件入口改动在下一轮重新加载，先做针对性检查。构建通过和运行时已生效分开报告。'),
    t('3. 精准高效读写：避免全盘扫描或全文倾倒，读文件使用 read_file（按需设置 offset/limit），搜索文件限定 path 子路径；改动代码优先使用 edit 局部替换。'),
    t('4. 结果实事求是：执行状态、数据、生成文件与图样一律以本轮工具的真实成功调用为唯一真源，严禁捏造虚假进度。'),
    t('5. 关键重点突出：结论、核心决定或用户硬性要求，输出时用 ==两个等号== 标注强调。'),
    t('6. 架构解耦与插件优先：新功能优先通过插件机制实现（plugins/<名>/），状态持久化落盘至 .ensoul/state/<名>.json；核心 src/ 仅保留基础调度与视图渲染。'),
    '',
    t('【系统体系与工具纪律】'),
    t('· 面板即功能单位：面板由类型（kind）与规格（spec）定义，能用现有类型表达的，无需重复开发渲染。'),
    t('· 工具与技能：可用工具以请求上下文中的 tools 列表为准；各领域扩展专业知识通过 use_skill 按需拉取。'),
    t('· 界面与环境感知：改动界面或定位窗口前，先调用 describe_layout 获取实际停靠树；项目事实参见 AGENTS.md / CLAUDE.md。'),
    t('· 排版呈现：全面使用 Markdown 标题、列表、表格清晰排版，禁止退化为难以阅读的纯文本。'),
    '',
    t('【面板改写与演进协议】'),
    t('当需要调整或重塑当前面板（包括标题、外观、正文形态、操作按钮、功能类型）时，在回答末尾附带合法 JSON 格式的改写提案：'),
    EDIT_OPEN,
    t('{"kind":"可选：换一种面板类型","title":"可选的新标题","keywords":["2到3个主题关键词"],"look":{"accent":"#5b8cff","density":"compact|normal|roomy","showChat":true},"spec":{"body":"messages|code|table|form|web","text":"具体内容","systemPrompt":"...","actions":[{"id":"a1","label":"按钮名","prompt":"点击后注入的指令"}],"fields":[{"key":"k","label":"字段名","type":"text|number|bool"}]},"rationale":"改动理由"}'),
    EDIT_CLOSE,
    t('· 命名规则：若当前面板快照中标题仍为「新面板」，首轮对话请在回答末尾附带提案更新 title（仅改名只需形如 {"title":"简明贴切的标题","keywords":["插件","调试"]}）。'),
    t('· 关键词：随首轮标题一并给出 **2~3 个中文主题词**（每个 2~4 字，说清"这块面板在干什么"，如 ["头像","出图"]、【"派单","调度"】），系统会拿它挑面板头像。**只说主题，不要写颜色/风格/形容词**；想不到就不给，留空即可，不会因此报错。'),
    t('· 功能重塑：若要将面板转变为特定功能，必须显式声明 kind。'),
    t('现有面板类型（内置）：') + BUILTIN_KINDS.join('、'),
    ...(pluginPanels.length
      ? [
          t('现有面板类型（插件自带）：') + `${pluginPanels
            .map((p) => (p.label && p.label !== p.kind ? `${p.kind}（${p.label}）` : p.kind))
            .join('、')}`,
        ]
      : []),
    ...(skillDigest(disabledSkills)
      ? [
          '',
          t('【技能清单】（按需使用 use_skill 拉取正文）：'),
          skillDigest(disabledSkills),
        ]
      : []),
    ...(extraSection ? ['', extraSection] : []),
  ].join('\n');
}

/**
 * **员工工作面**的系统提示 —— 和编辑器那份是两回事，各是各的前缀。
 *
 * 编辑器那份讲的是"怎么改这个软件"：build→restart、六条规矩里的开发纪律、
 * 面板体系、编辑提案格式……对岗位员工全是噪声 —— 他不改源码、不改界面，
 * 连自己的面板都不该改（改卡走调度中心）。他只干活、交活。
 *
 * 所以员工只留**干活必需**的：岗位（角色卡那份专属提示词，插在最前面）、
 * 怎么用工具、不许虚报、排版、技能按需取。约 700 字 vs 3200 字，
 * 而这钱是**每轮都付**的。
 *
 * 用 `noWorkspacePrompt` 认员工：那是 dispatch 开工作面时打的标（见 types.ts）——
 * 该字段本来就是"我是员工面板"的意思：agents-md 用它扣下工作区全局说明，
 * 这里用它把编辑器底座换成 agent 底座。两边互不认识，只认这个标。
 *
 * 缓存纪律（prompt-protocol）：普通面板走原数组一字未动；员工面板这份前缀
 * 对同一块面板每轮恒定，可缓存。分流只在函数开头一次 if，不做运行时拼接。
 */
function buildAgentSystemPrompt(panel: Panel, disabledSkills: string[], extraSection?: string): string {
  // 提示词正文是**调度中心合成好的**（基础+部门简介+部门提示词+简介+职位提示词，
  // 见 dispatch 的 composePrompt），落在 spec.systemPrompt 里 —— 这里一个字都不再加工，
  // 只补技能目录（动态清单按 prompt-protocol 由运行时从真源列，不写死）。
  const own = String(panel.spec.systemPrompt || '').trim();
  const dig = skillDigest(disabledSkills);
  if (!own)
    return [
      langDirective(),
      '',
      t('你是这家 AI 游戏公司的一名员工，这块面板是你的工作面。'),
      ...(dig ? ['', t('【技能】'), dig] : []),
    ].join('\n');
  return [
    langDirective(),
    '',
    own,
    ...(extraSection ? ['', extraSection] : []),
    ...(dig
      ? [
          '',
          t('【技能】下面这些是按需取用的说明，正文不在提示里。需要哪一条就用 use_skill 取出来，不要凭名字猜内容：'),
          t('接活再久也照样先取技能再动手 —— 凭记忆写的工作流名、命令参数多半是错的。'),
          dig,
        ]
      : []),
  ].join('\n');
}

/**
 * 面板此刻的样子 —— **运行时事实，不是提示词**。
 *
 * 为什么不跟 buildSystemPrompt 放一起：那份是系统提示，位于整段请求的最前面，
 * 是缓存前缀的起点；它变一个字，从那儿往后的全部缓存当场作废。而这个函数的
 * 产物每轮都可能变（换个标题、拖一下位置、改一次规格），所以它只能待在消息的
 * 末尾 —— 由调用点拼在本轮用户消息前面（index.ts 的 doSend）。
 *
 * 快照只报事实，不讲规矩；规矩留在系统提示里。两处混着放，改一头忘一头。
 */
/**
 * 快照里正文（spec.text）的上限。
 *
 * `spec.text` 是面板的**正文内容** —— editor 面板里就是整个文件。而这份快照
 * **每一轮都拼在本轮用户消息前面**发出去，所以一个开着两万字文档的面板，
 * 就等于每轮两万字固定开销（真量过：20K 的 text 让快照从 146 字涨到 20121 字）。
 * 超过这个数就只印开头一段，并写清楚怎么读全。
 */
const SNAPSHOT_TEXT_MAX = 1200;

/**
 * 空值不进快照：空字符串 / 空数组 / 空对象都占着整整一行，却什么也没说。
 *
 * 这份快照**每一轮都发**，而它待在消息末尾、不碰缓存前缀 —— 所以把它缩短
 * 是净赚（没有"改了缓存前缀导致全额重算"的代价）。20K 的 text 那种要砍，
 * 这几个恒为零的字段同样该砍：不是怕爆，是白烧。
 */
function isEmptySpecValue(v: any): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

export function buildPanelSnapshot(panel: Panel, place: string): string {
  const raw: any = (panel as any).spec ?? {};
  const text = String(raw.text ?? '');
  const cut = text.length > SNAPSHOT_TEXT_MAX;
  const spec: any = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!isEmptySpecValue(v)) spec[k] = v;
  }
  if (cut) {
    const tail = panel.file
      ? ' ' + t('要看全用 read_file 读') + ' ' + panel.file + t('（面板里没保存的改动不在文件里）')
      : ' ' + t('要看全得让用户贴出来，或打开对应文件');
    spec.text = text.slice(0, SNAPSHOT_TEXT_MAX) + '…' + t('（只印了开头，全文共 {n} 字。）', { n: text.length }) + tail;
  }
  // systemPrompt 已经单独抄在系统提示的【本面板的额外要求】里，这儿再发一遍纯属重复。
  if (raw.systemPrompt) spec.systemPrompt = t('（{n} 字，已列在系统提示里，不在这儿重复）', { n: String(raw.systemPrompt).length });

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  /*
   * 星期几交给 Intl，不手工拼「星期 + 日名」—— 英文下会拼出「星期Tue」这种东西。
   * 中文下它照样给「星期二」，跟从前一字不差；英文下给 Tuesday。
   */
  const dd = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const timeStr = `${dd} ${now.toLocaleDateString(localeTag(), { weekday: 'long' })}`;

  return [
    t('【运行时环境】系统时间：') + timeStr,
    t('【当前面板】此刻的真实状态（每轮重新生成）'),
    `ID: ${panel.id}`,
    t('标题：') + panel.title,
    t('种类：') + panel.kind,
    ...(panel.component ? [t('组件：') + panel.component] : []),
    ...(panel.file ? [t('绑定文件：') + panel.file] : []),
    t('位置：') + place + t('（由停靠树决定）'),
    /**
     * 外观里 `avatarKey` **不给模型看**：它跟"配色、密度"不是一类东西 ——
     * 那是留给用户改的（甚至干脆是插件自报的），模型看见了只会学着往
     * 提案的 look 里塞一个，把一个本该稳定的字段搞成每轮都可能变的。
     */
    ...(() => {
      if (!panel.look) return [];
      const { avatarKey: _hidden, ...visible } = panel.look as unknown as Record<string, unknown>;
      return Object.keys(visible).length ? [t('外观：') + JSON.stringify(visible)] : [];
    })(),
    t('规格：'),
    '```json',
    JSON.stringify(spec, null, 2),
    '```',
  ].join('\n');
}

/**
 * 从模型回复里剥离编辑提案。
 *
 * 标记按"两个以上的 < / >"来认，不搞逐字符精确匹配 —— 真出过事：模型把结束标记
 * 少打了一个 `>`，`indexOf(EDIT_CLOSE)` 找不到，于是整份提案作废、面板根本没被改，
 * 标记原文还原样挂在消息里给用户看。一个字符不该决定整份提案的生死。
 */
const OPEN_RE = /<{2,}\s*FLOAT_EDIT\s*>{2,}/;
const CLOSE_RE = /<{2,}\s*END_FLOAT_EDIT\s*>{2,}/;

export function extractEditProposal(text: string): { clean: string; proposal: any | null } {
  const mo = OPEN_RE.exec(text);
  if (!mo) return { clean: text, proposal: null };

  const rest = text.slice(mo.index + mo[0].length);
  const mc = CLOSE_RE.exec(rest);
  // 没找到结束标记 = 回复大概率被截断在提案中间，那截 JSON 反正解析不出来，
  // 一样剥掉 —— 不能让半截标记继续挂在消息里。
  const raw = (mc ? rest.slice(0, mc.index) : rest).trim();
  const tail = mc ? rest.slice(mc.index + mc[0].length) : '';
  const clean = (text.slice(0, mo.index) + tail).trim();
  const jsonText = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return { clean, proposal: JSON.parse(jsonText) };
  } catch {
    return { clean, proposal: null };
  }
}

export interface StreamHandlers {
  onDelta(text: string): void;
  onDone(full: string): void;
  onError(err: string): void;
}

// ---------------------------------------------------------------- agent 循环

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface ApiMessage {
  role: string;
  /**
   * 字符串是常态。**带图的那条是 content parts 数组**（文本 + image_url），
   * 只有"看一眼工具刚出的图"那一条会这样 —— 见 takeSeePaths 那段注释。
   */
  content?: string | null | any[];
  tool_calls?: any[];
  tool_call_id?: string;
}

/**
 * 用户半路插进来的一句话。
 *
 * 它和「排队」是两条不同的边界，**别混成一条**：
 *   · 排队（next-turn）：等这一整轮跑完，再当成新的一轮发出去；
 *   · 插话（next-step）：在**步骤边界**领走，直接喂进正在跑的这一轮 ——
 *     模型下一步就读到它，不用等整轮结束。用户要的"它做完手头这一步、
 *     还没说出最后那句话的时候被插进来"，就是后者。
 */
export interface SteerItem {
  id: string;
  text: string;
  /** 已经落过盘的图（磁盘路径）—— 用户的截图跟着插话一起进去 */
  images?: string[];
  /**
   * 插件注入的**状态变更**，不是用户说的话。
   *
   * 跟用户插话的区别只有一个，但很要紧：用户那句话**丢了是事故**（他明明说了），
   * 系统状态变更**丢了也是事故、重投反而无害** —— 两边的幂等方向是反的。
   * 所以收尾那句「没送进去就作废」对它不成立（见 index.ts 收尾那处）。
   */
  system?: boolean;
}

export interface AgentEvents {
  onText(delta: string): void;
  /**
   * 到了步骤边界，把用户插进来的话取走。两个领取点，缺一不可：
   *   1. 每一轮模型调用**之前**；
   *   2. 模型本来要收工的那一刻（它这一步没再要工具）—— 后者才是
   *      用户说的"结束单次任务、但还没结束会话"那个缝。
   */
  takeSteering?(): SteerItem[];
  /** 一条插话已经喂进这一轮了：落进对话，让用户看见它真被接住了 */
  onSteering?(item: SteerItem): void;
  /**
   * 思维链。DeepSeek 这类模型在吐正文之前会先吐 `reasoning_content`。
   *
   * 不接的话，它思考的那十几秒里界面上一片空白，然后正文哗一下全出来 ——
   * 用户完全不知道它在干什么，只觉得"卡住了、不说话"。这就是接它的全部理由。
   */
  onReasoning?(delta: string): void;
  /**
   * 断了，正在重连。
   *
   * 为什么非报不可：重连要退避等待（最长 10 秒），那期间接口那边一个字都不会来，
   * 界面上看着就是"卡住了"。把它摆出来，用户才知道是网络在抽风、它正在自己接回来。
   * 同时它**作废掉上一次的草稿**（失败分片绝不进入派生消息），
   * 所以上层要按 discardText / discardThink 把已经显示的那段撤回去。
   */
  onRetry?(info: RetryInfo): void;
  onTool(name: string, args: any, result: string): void;
  /**
   * 每完成一次模型调用就报一次**这一轮到目前为止的累计**用量。
   *
   * 为什么非得有它：以前用量只在 runAgent 正常返回时才交出去，于是"这一轮没跑完"
   * （用户按停、接口断流、超时）＝ 前面已经花掉的 token 一起消失，界面上那条用量
   * 直接归零。可一轮里可能已经来回调了十几次模型，账不该因为最后一步没跑完就抹掉。
   * 报的是累计值，收的人直接覆盖即可，不用自己加。
   */
  onUsage?(usage: AgentUsage): void;
}

export interface AgentUsage {
  prompt: number;
  completion: number;
  total: number;
  /** 输入里命中上下文缓存的那部分 —— 计费按命中价算，所以要单独收着 */
  cacheHit: number;
}

export interface AgentResult {
  text: string;
  usage: AgentUsage;
  /** 这一轮里 agent 写过的文件 */
  files: string[];
  /** 为什么收工：done = 模型自己说完了；limit = 撞到动作上限 */
  ended: 'done' | 'limit';
}

/**
 * 一轮对话里最多让模型动手这么多次。**0 = 不设上限（默认）。**
 *
 * 它原来是 30（"防跑飞的安全绳"），但撞到上限的次数远多于真跑飞的次数：
 * 长活（大重构、批量改文件、边读边改的排查）30 步根本不够，
 * 用户拿到的却是一条戛然而止的回复，只能说「继续」。
 * 30 已废弃，别再调回去，也别做成设置项 —— 真被卡住时，用户要的是
 * "这一轮把活干完"，不是"跑到第 N 步被拦下来"。
 *
 * 什么时候收工，现在只由两件事决定：模型自己不再要工具，或者用户按停（AbortSignal）。
 * 跑飞的风险没消失，所以真要临时收着跑（排查一个疑似跑飞的循环），
 * 把 MAX_ROUNDS 临时改成正数即可 —— 撞到上限时下面会明说"第 N 步停了"，不装成正常结束。
 */
const MAX_ROUNDS = 0;

/**
 * 从接口回的 usage 里抠出用量。
 *
 * 缓存命中数各家写法不一样：OpenAI 协议放在 `prompt_tokens_details.cached_tokens`，
 * DeepSeek 另外给了 `prompt_cache_hit_tokens`（还配一个 `prompt_cache_miss_tokens`）。
 * 两个都认，认不到就当 0（也就是全价），不猜。
 */
function readUsage(u: any): AgentUsage {
  const prompt = u.prompt_tokens ?? 0;
  const cached =
    u.prompt_tokens_details?.cached_tokens ??
    u.prompt_cache_hit_tokens ??
    (u.prompt_cache_miss_tokens != null ? Math.max(0, prompt - u.prompt_cache_miss_tokens) : 0) ??
    0;
  return {
    prompt,
    completion: u.completion_tokens ?? 0,
    total: u.total_tokens ?? 0,
    cacheHit: Math.max(0, Math.min(cached, prompt)),
  };
}

/**
 * 工具结果的**中间修剪** —— 默认值：
 * 超过 8192 字符就换成「前 4096 + 标记 + 后 1024」。
 *
 * 为什么头和尾都留：报错、结论、最终输出几乎都在尾部，只砍尾巴最亏；
 * 开头则带着命令本身和上下文。中间那一大坨对下一步通常没用。
 *
 * 纯语法、确定性、**不花一分钱** —— 所以它永远排在摘要前面：
 * 能不花钱解决的事，不要花钱。
 */
const PRUNE_AT = 8_192;
const PRUNE_HEAD = 4_096;
const PRUNE_TAIL = 1_024;
const PRUNE_MARK = '\n\n[... 工具结果的中间部分已修剪 ...]\n\n';

/**
 * 这几种工具的输出"整份给"：技能正文是**指令**（掐中间等于给半套流程），
 * 目录和布局是结构化清单。它们和 agent.ts 的 NO_SPILL 是同一份清单的两处落点 ——
 * 那边管落地，这边管修剪，改一个记得改另一个。
 *
 * 代价说清楚：一份 14KB 的技能取进上下文就是每轮约 5k token，砍掉一半当然更省，
 * 但那是**把说明弄坏换来的省** —— 模型照着半套流程做事，返工比省下的贵。
 */
const KEEP_WHOLE = new Set(['use_skill', 'list_dir', 'describe_layout']);

export function pruneToolText(text: string): string {
  const s = String(text ?? '');
  if (s.length <= PRUNE_AT) return s;
  return s.slice(0, PRUNE_HEAD) + PRUNE_MARK + s.slice(-PRUNE_TAIL);
}

/**
 * 「看一眼这张图」的通道 —— 工具结果里单独一行写 `[[see: <文件路径>]]`。
 *
 * 为什么要有它：工具结果本来就只是**一个字符串**，插件没别的地方能把像素交给模型；
 * 而助手消息上挂的图是"给用户看的"、**故意不回灌**（见 index.ts 里那段注释，理由是不该
 * 每轮重发一张几十万字符的 base64）。可"出图"这件事偏偏需要模型真的看到成品，
 * 否则它只能对着一句"出图完成"自说自话。
 *
 * 划清界限的三条：
 *   · **只在当轮**：附上去的那条消息拼进的是这一轮正在跑的 msgs，从不落进 panel.chat，
 *     所以下一轮请求里它一个字都不占 —— 代价只有那一轮的几百 token。
 *   · **只认小图**：路径必须是**插件已经压过**的图（comfyui 那边用 nativeImage 压到长边几百像素）。
 *     原图一张 1MB 转 base64 就是几十万字符，那种东西放进 agent 循环是灾难，这里再兜一道上限。
 *   · 标记行从正文里摘掉 —— 它对读的人（和之后的轮次）都没意义。
 */
const SEE_RE = /^[ \t]*\[\[see:[ \t]*([^\]]+?)[ \t]*\]\][ \t]*$/gm;
/** 一次最多附几张（真出图一次就一张，留点余量而已） */
const SEE_MAX = 4;
/** 单张上限：压过之后正常几十 KB，超过这个数说明没压，宁可不看 */
const SEE_LIMIT = 4 * 1024 * 1024;

/** 从工具结果里把 `[[see: 路径]]` 摘出来。摘不掉的（文件不在、太大）留一句话说明，别让模型猜 */
export function takeSeePaths(text: string): { text: string; files: string[]; missing: string[] } {
  const files: string[] = [];
  const missing: string[] = [];
  const body = String(text ?? '').replace(SEE_RE, (_whole, raw) => {
    const f = String(raw).trim().replace(/^["']|["']$/g, '');
    if (!f) return '';
    if (files.length >= SEE_MAX) {
      missing.push(f);
      return '';
    }
    if (!fs.existsSync(f)) {
      missing.push(f);
      return '';
    }
    files.push(f);
    return '';
  });
  return { text: body.replace(/\n{3,}/g, '\n\n').trim(), files, missing };
}

/** 磁盘上的小图读成模型要的形态；读不动就返回 null（一张图不许把整轮打死） */
function seePart(file: string): any | null {
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : `image/${ext || 'png'}`;
  try {
    if (fs.statSync(file).size > SEE_LIMIT) return null;
    return { type: 'image_url', image_url: { url: `data:${mime};base64,${fs.readFileSync(file).toString('base64')}` } };
  } catch {
    return null;
  }
}

/**
 * 把一段旧对话压成摘要 —— 压力真的到了才做，
 * 一次额外的模型请求，只保留它返回的摘要文本。
 *
 * 提示词里特意写死"丢掉的就是真的丢了"，是因为压缩之后那些原文确实不再送来 ——
 * 这一段摘要就是它们留下的全部痕迹，写漏了就没了。
 */
export function conversationForSummary(messages: readonly ChatMessage[]): string {
  return messages.filter((message) => message.role !== 'tool').map((message) => {
    const evidence = (message.toolCalls || []).map((call) =>
      `工具 ${call.name}\n参数：${call.args}\n结果：${call.result}`,
    ).join('\n\n');
    const role = message.role === 'user' ? '用户' : message.role === 'system' ? '系统' : '助手';
    return [evidence, `${role}：${message.content}`].filter(Boolean).join('\n\n');
  }).join('\n\n');
}

export async function summarizeSession(
  older: string,
  previous: string,
  cfg: ModelConfig,
  signal?: AbortSignal,
  /**
   * 插件交上来的快照（便签要点这类）。它们是"用户定过的事"，不是待压缩的对话本身，
   * 所以在提示里单独标成"必须原样保留"，不许被揉进概括里。
   */
  notes?: string,
): Promise<string> {
  const sys = [
    t('把下面这段编码对话压缩成一份摘要，供之后的轮次继续使用。'),
    t('压缩之后，原始对话不会再送来了，所以**你丢掉的就是真的丢了**。必须留住：'),
    t('· 用户明确要求过什么、否决过什么'),
    t('· 做过的决定，以及为什么这么做'),
    t('· 现在进行到哪一步、还剩什么没做完'),
    t('· 踩过的坑和结论'),
    t('不要复述代码，不要客套，不要"好的""总结如下"这类废话。摘要必须用**界面当前的语言**写，不要用别的语言。'),
  ].join('\n');

  const body = [
    previous ? `${t('【已有的摘要，接着往下写、不要重复】')}\n${previous}\n` : '',
    notes ? `${t('【必须原样保留的事实 —— 一条都不许丢、不许改写】')}\n${notes}\n` : '',
    t('【需要压缩的对话】'),
    older,
  ]
    .filter(Boolean)
    .join('\n');

  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      stream: false,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: body },
      ],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`摘要请求返回 ${res.status}`);
  const j: any = await res.json();
  return String(j.choices?.[0]?.message?.content ?? '').trim();
}

/**
 * 用某一个模型配置问一次话：一问一答、不带工具、不进对话历史。
 *
 * 给**插件**用的（见 PluginHost.askModel）：插件想让模型看一眼、出个结果就走这里。
 * 用的是调用方指定的那份 cfg —— 也就是**某个面板自己选中的那个模型**，
 * 跟会话区是同一个选择器、同一份密钥。密钥只在主进程里流转，插件永远拿不到。
 */
export async function askOnce(
  cfg: ModelConfig,
  system: string,
  user: string,
  opts?: { maxTokens?: number; signal?: AbortSignal },
): Promise<string> {
  if (!cfg.apiKey || !cfg.baseUrl) throw new Error(t('这个面板还没选模型（点对话框右下角那个模型 chip 选一个）'));
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      stream: false,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: user },
      ],
      ...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    }),
    signal: opts?.signal ?? AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`模型接口返回 ${res.status}：${(await res.text().catch(() => '')).slice(0, 200)}`);
  const j: any = await res.json();
  const out = j?.choices?.[0]?.message?.content;
  if (typeof out !== 'string') throw new Error(t('模型没回内容'));
  return out.trim();
}

/** 多久没吐一个字就认定它卡住了。接口挂在那儿不动时，不能让整轮对话跟着一起挂 */
const IDLE_MS = 180_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * ── 断了就自己重连 ────────────────────────────────────────────────────────
 *
 * 断了就自己重连的那一套，三条规矩：
 *
 *   1. **先分类，再决定接不接**。可重连的只有五类 —— 限流、服务端错、超时、
 *      传输中断、空回复。认证错、配额、请求本身不合法**一次都不重试**：
 *      重发一万次还是同一个结果，只会把等待和账单一起拉长。
 *   2. **有上限的退避**。最多 5 次，500ms 起翻倍到 10 秒封顶，带 10% 抖动
 *      （抖动是必要的：不然一堆会话会在同一毫秒一起回头打接口）。
 *   3. **重连要把上一次的草稿作废**。一次尝试吐了一半断掉，那段字必须撤掉重来 ——
 *      不撤的话，重连后的内容会接在半句话后面，用户看到的是一段谁也读不通的东西。
 *      这是「失败分片绝不进入派生消息」在这里的落法。
 */
export type FailCode =
  | 'RATE_LIMIT'
  | 'SERVER'
  | 'TIMEOUT'
  | 'TRANSPORT'
  | 'EMPTY_RESPONSE'
  /** 认证错（401/403）—— 密钥不对，重连没有意义 */
  | 'AUTH'
  /** 请求本身不合法（其它 4xx）—— 换个时间发还是同一句话 */
  | 'REQUEST'
  /** 认不出的一类，不重连 */
  | 'OTHER';

/** 可重连的那几类 —— 只有这些值得再试一次 */
const RETRY_CODES = new Set<FailCode>(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE']);
const RETRY_MAX = 5;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 10_000;
const RETRY_JITTER = 0.1;

/** 第 n 次重连之前等多久（n 从 1 起）—— 指数退避 + 抖动，10 秒封顶 */
function backoffMs(n: number): number {
  const exp = Math.min(RETRY_BASE_MS * 2 ** (n - 1), RETRY_MAX_MS);
  const jitter = 1 - RETRY_JITTER + 2 * RETRY_JITTER * Math.random();
  return Math.min(Math.round(exp * jitter), RETRY_MAX_MS);
}

/** 服务端说「让等多久」（Retry-After：秒数或日期两种写法都认）—— 有就听它的 */
function retryAfterMs(res: Response): number | null {
  const h = res.headers.get('retry-after');
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs) && secs > 0) return Math.round(secs * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function classifyStatus(status: number): FailCode {
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'SERVER';
  if (status === 401 || status === 403) return 'AUTH';
  if (status >= 400) return 'REQUEST';
  return 'OTHER';
}

/** 一次带分类的失败：上层靠 code 决定接不接，靠 retryAfterMs 决定等多久 */
class Fail extends Error {
  code: FailCode;
  retryAfterMs: number | null;
  constructor(code: FailCode, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/** 失败分类翻成人话 —— 界面那条「重连 3/5」得说清是为什么断的 */
export function failLabel(code: FailCode): string {
  switch (code) {
    case 'RATE_LIMIT': return t('接口在限流');
    case 'SERVER': return t('接口那边出错了');
    case 'TIMEOUT': return t('接口一直没有响应');
    case 'TRANSPORT': return t('连接断了');
    case 'EMPTY_RESPONSE': return t('接口没回内容');
    case 'AUTH': return t('密钥不对');
    case 'REQUEST': return t('请求被接口拒绝');
    default: return t('接口不通');
  }
}

/** 正在重连：交给界面，让它把「第几次 / 为什么 / 还有多少字要作废」摆出来 */
export interface RetryInfo {
  /** 这是第几次重连（从 1 起） */
  attempt: number;
  /** 最多几次 */
  max: number;
  /** 哪一类失败 */
  code: FailCode;
  /** 这一次要等多久（毫秒） */
  delayMs: number;
  /**
   * 上一次尝试已经吐出来的**正文**长度 —— 这段草稿作废，上层要照它把界面上的内容撤回去。
   * 为什么不接着往下写：接口普遍不支持 assistant 前缀续写，接上去就是半句话 + 半句话。
   */
  discardText: number;
  /** 同上，思维链那一份（它也是"过程"，作废时一起撤，不然两段接不上） */
  discardThink: number;
}

export interface CallResult {
  content: string;
  toolCalls: any[];
  usage: AgentUsage | null;
  /** 服务端给的收尾原因：stop / tool_calls / length / … */
  finishReason: string;
}

/**
 * 思考水平 → 请求体里要带的那一段字段。**各家字段名不一样**，这里按提供方归类：
 *   · 通义 dashscope：`enable_thinking` + `thinking_budget`（单位是 token）
 *   · anthropic 系（baseUrl 里带 anthropic / claude）：`thinking.budget_tokens`
 *   · 其余（openai、deepseek、以及各种 openai 兼容中转）：`reasoning_effort`
 *
 * 返回的是一个**候选串**，按"最可能被认的"排前面：接口回 400 说这个字段不认，
 * 就拿下一个再发一次；一串都试完就干脆一个参数都不发（让接口自己决定）——
 * 少思考一轮没关系，为一个旋钮把整轮对话打死才是事故。
 *
 * 空数组 = 不限制（一个字节都不多发）。这也是默认档：
 * **"不设"和"关掉"是两件事**，前者随接口自身的默认行为，后者是明确要求它别想。
 */
function thinkVariants(provider: string | undefined, baseUrl: string | undefined, level?: string): Record<string, unknown>[] {
  if (!level) return [];
  const where = `${provider ?? ''} ${baseUrl ?? ''}`.toLowerCase();
  const isAnthropic = where.includes('anthropic') || where.includes('claude');
  const isDash = where.includes('dashscope') || where.includes('qwen') || where.includes('tongyi');
  const budget = level === 'low' ? 2048 : level === 'high' ? 16384 : 8192;

  if (level === 'off') {
    // anthropic 不发 thinking 就是"关"，硬发 {type:'disabled'} 反而 400
    if (isAnthropic) return [];
    // 关闭思考没有统一字段，按最可能认的顺序排队试。
    // `reasoning_effort: 'none'` 是新版 openai 那套；`enable_thinking` 是通义那套，
    // 很多中转也照抄；`chat_template_kwargs` 是 vLLM 派自己起的服务认的写法。
    const out: Record<string, unknown>[] = [];
    const add = (c: Record<string, unknown>) => {
      if (!out.some((x) => JSON.stringify(x) === JSON.stringify(c))) out.push(c);
    };
    if (isDash) add({ enable_thinking: false });
    add({ reasoning_effort: 'none' });
    add({ enable_thinking: false });
    add({ chat_template_kwargs: { enable_thinking: false } });
    // 实在都认不了，至少退到"最轻"那一档 —— 它还是思考，但比放开好
    add({ reasoning_effort: 'minimal' });
    return out;
  }

  // 开了思考的那几档：主字段 + 一个换家认的备选
  const effort = level === 'high' ? 'high' : level === 'low' ? 'low' : 'medium';
  if (isAnthropic) return [{ thinking: { type: 'enabled', budget_tokens: Math.max(1024, budget) } }, { reasoning_effort: effort }];
  if (isDash) return [{ enable_thinking: true, thinking_budget: budget }, { reasoning_effort: effort }];
  return [{ reasoning_effort: effort }, { enable_thinking: true, thinking_budget: budget }];
}

/** 退避等待：等的时候用户按了停就立刻收场，不让他白等这几秒 */
function waitRetry(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * **重连是对整次尝试的包裹，不散在里面。**
 *
 * 为什么非得包在外面：一次尝试的边界是「发请求 → 读完整条流」。失败可能发生在
 * 任何一处（连接建不起来、HTTP 头是 429、流读到一半断掉、吐了几个字就没动静了），
 * 而处理它们的规矩**是同一套**：分类 → 合格就退避重发 → 上限到了才认输并说清。
 * 把这几步散进请求函数里，就成了每一处各写各的，次数和提示必然对不上。
 *
 * 它唯一要向上说的额外一件事：**这次尝试吐出来的草稿得作废多少**（见 RetryInfo）。
 * 归它是刻意的 —— 只有它知道"这是一次作废的尝试"，内层只管老实往外吐字。
 */
async function callModel(
  msgs: ApiMessage[],
  cfg: ModelConfig,
  tools: ToolSpec[],
  signal: AbortSignal | undefined,
  onText: (d: string) => void,
  onReasoning?: (d: string) => void,
  onRetry?: (info: RetryInfo) => void,
): Promise<CallResult> {
  for (let attempt = 1; ; attempt += 1) {
    // 这一次尝试吐了多少 —— 重连时上层要照它把草稿撤回去，不能接着往下写
    let text = 0;
    let think = 0;
    try {
      return await callModelOnce(
        msgs,
        cfg,
        tools,
        signal,
        (d) => { text += d.length; onText(d); },
        onReasoning ? (d) => { think += d.length; onReasoning(d); } : undefined,
      );
    } catch (e: any) {
      // 用户按停 / 窗口关了：**一次都不接**。他按的那个停止必须立刻算数，
      // 不然界面上就成了"我明明停了它还在自己重连"。
      if (signal?.aborted) throw e;
      const fail = e instanceof Fail ? e : new Fail('TRANSPORT', String(e?.message ?? e));
      // 不在合格集合里（认证错、配额、请求本身不合法）—— 重发还是同一句话
      if (!RETRY_CODES.has(fail.code)) throw e;
      // 上限到了：**认输，但把话说清**（重连过几次、为什么断），别装成没发生过
      if (attempt > RETRY_MAX) {
        // 空回复是个例外：它本来就不该把整轮打死（以前是交给上层去说"没带工具名"），
        // 所以重连都失败时照旧把这份空的还回去，不升级成异常。
        if (fail.code === 'EMPTY_RESPONSE') return { content: '', toolCalls: [], usage: null, finishReason: '' };
        throw new Error(`${fail.message}（已自动重连 ${RETRY_MAX} 次仍不通）`);
      }
      // 服务端说了让等多久就听它的；但它要等得比我们的上限还久，normal mode 就放弃
      // （这条指令不该把一个本来能很快跑完的轮次拖成一小时）
      let delay: number | null = null;
      if (fail.retryAfterMs !== null && Number.isFinite(fail.retryAfterMs) && fail.retryAfterMs > 0) {
        delay = fail.retryAfterMs > RETRY_MAX_MS ? null : fail.retryAfterMs;
      } else {
        delay = backoffMs(attempt);
      }
      if (delay === null) throw e;
      onRetry?.({ attempt, max: RETRY_MAX, code: fail.code, delayMs: delay, discardText: text, discardThink: think });
      await waitRetry(delay, signal);
      if (signal?.aborted) throw e;
    }
  }
}

/**
 * **一次**尝试：发一次请求，流式收文本，把 tool_calls 的分片拼起来。
 *
 * 它自己不重连（重连由上面的 callModel 统一管），只管把这一趟跑完、
 * 在失败时**说清是哪一类失败**（Fail.code）—— 接不接、等多久，那是上面的判断。
 *
 * 里面另有一道独立的闸：**闲时断开**。接口长时间一个字都不吐（网络僵在那里、
 * 服务端卡住），以前就无限期挂着 —— 界面上就是"跑到一半不动了，永远不结束"。
 * 它断掉之后归到 TIMEOUT 一类，照样会被重连接住。
 * （只看"还在不在吐字"，不设总时长上限 —— 只要还在输出，长任务跑多久都不杀。）
 *
 * 还有一道是兼容闸：**不认 stream_options / 思考字段的接口**。用量那点诉求和
 * 一个旋钮不该把整轮对话打死，报错里点到它就去掉它再来一次。
 */
async function callModelOnce(
  msgs: ApiMessage[],
  cfg: ModelConfig,
  tools: ToolSpec[],
  signal: AbortSignal | undefined,
  onText: (d: string) => void,
  onReasoning?: (d: string) => void,
): Promise<CallResult> {
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;

  // 外部信号（用户点停止 / 窗口关了）和下面这道闲时超时并到同一个控制器上，
  // 这样无论谁先动手，都在同一条路上收场，错误信息也说得清是谁干的。
  const ctrl = new AbortController();
  const stop = (why: string) => {
    if (!ctrl.signal.aborted) ctrl.abort(new Error(why));
  };
  const onOuter = () => stop(t('已经停止这一轮（用户点了停止，或者窗口关了）'));
  if (signal) {
    if (signal.aborted) onOuter();
    else signal.addEventListener('abort', onOuter, { once: true });
  }
  const why = () => String((ctrl.signal.reason as any)?.message ?? t('这一轮被中断了'));
  const dead = () => ctrl.signal.aborted;

  let idle: NodeJS.Timeout | null = null;
  const poke = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => stop(`接口 ${Math.round(IDLE_MS / 1000)} 秒没有吐任何数据，先断开`), IDLE_MS);
  };

  // 思考水平：候选串按"最可能被认的"排队。没设档时这里是空的 —— 一个字节都不多发。
  const variants = thinkVariants(cfg.provider, cfg.baseUrl, cfg.think);
  /** 现在发第几个候选；越界 = 一个思考字段都不发了 */
  let vi = 0;
  const curThink = (): Record<string, unknown> | null => variants[vi] ?? null;
  /** 用量那一档：接口不认 stream_options 就关掉，之后不再发 */
  let usageOn = true;

  const body = (withUsage: boolean, think: Record<string, unknown> | null) =>
    JSON.stringify({
      model: cfg.model,
      stream: true,
      // 让接口在最后一块把用量报给我们（用量监控就靠它）
      ...(withUsage ? { stream_options: { include_usage: true } } : {}),
      ...(think ?? {}),
      messages: msgs,
      ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
    });

  /**
   * 只发一次，**自己不重试** —— 连不上、被拒绝这类归到 Fail 往上抛，
   * 由 callModel 按统一策略重连（以前这里自带一次 1.2 秒的重试，和上面那层
   * 凑起来次数对不上，界面上就说不清"到底重连了几次"）。
   */
  const post = async (withUsage: boolean = usageOn, think: Record<string, unknown> | null = curThink()): Promise<Response> => {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: body(withUsage, think),
        signal: ctrl.signal,
      });
    } catch (e: any) {
      if (dead()) throw new Error(why());
      throw new Fail('TRANSPORT', `连不上模型接口（${cfg.baseUrl}）：${e?.message ?? e}`);
    }
  };

  try {
    poke();
    let res = await post(true);
    // 429 / 5xx 只在这里判一次，**不再自己等 1.5 秒重发** ——
    // 退避和次数都交给上面那层，这样"第几次"才是同一个数。
    //
    // 400 不在这里抛：它多半是"这家不认某个字段"，得先让下面那个兼容循环
    // 把它摘掉重发一次（那是这一层自己的事，跟重连不是一回事）。
    if (!res.ok) {
      const code = classifyStatus(res.status);
      if (code === 'RATE_LIMIT' || code === 'SERVER') {
        throw new Fail(code, `模型接口返回 ${res.status}`, retryAfterMs(res));
      }
      // 认证错跟字段无关，摘什么都没用：按原话抛出去（密钥没配好这一类）
      if (code === 'AUTH') {
        throw new Fail(code, `模型接口返回 ${res.status}：${(await res.text().catch(() => '')).slice(0, 400)}`);
      }
    }
    // 400 可能连着来几个（这家不认第一个候选字段，也不认第二个……），
    // 每摘掉一个再试一次。guard 兜住次数，不会在这里转不完。
    for (let guard = variants.length + 2; res.status === 400 && guard > 0; guard -= 1) {
      const t = await res.text().catch(() => '');
      if (usageOn && /stream_options|include_usage/i.test(t)) {
        // 这家不认用量字段 —— 摘掉它再发一次
        usageOn = false;
        res = await post(false);
      } else if (curThink() && !/stream_options|include_usage/i.test(t)) {
        // 这家不认这个思考字段 —— 换下一个候选。一条串都试完（curThink() 变成 null）
        // 就一个思考参数都不发，让接口自己决定。少思考一轮没关系，
        // 为一个旋钮把整轮对话打死才是事故。
        //
        // **不要求报错里点名字段**：不少接口只说"invalid request"，
        // 按名字筛就永远试不到下一个候选，档位看起来"没被应用"。
        // 真出错也不会被吃掉：候选试完后最后一次是不带思考参数发的，
        // 那次还 400 才会抛出来，报错信息反而更干净。
        vi += 1;
        res = await post();
      } else {
        // 400 摘完了还是不认：这是请求本身的问题，不重连，原样报给用户
        throw new Fail('REQUEST', `模型接口返回 400：${t.slice(0, 400)}`);
      }
    }
    if (!res.ok || !res.body) {
      throw new Fail(classifyStatus(res.status), `模型接口返回 ${res.status}：${(await res.text().catch(() => '')).slice(0, 400)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let content = '';
    let usage: AgentUsage | null = null;
    let finishReason = '';
    const calls: any[] = [];

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      poke();
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]') continue;
        let j: any;
        try {
          j = JSON.parse(data);
        } catch {
          continue;
        }
        if (j.usage) usage = readUsage(j.usage);
        const choice = j.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = String(choice.finish_reason);
        const delta = choice.delta;
        if (!delta) continue;
        // 思维链先到、正文后到，两个都要接。各家字段名不一样，能认的都认一下。
        const think = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
        if (typeof think === 'string' && think) onReasoning?.(think);
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          onText(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const i = tc.index ?? 0;
          calls[i] = calls[i] ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) calls[i].id = tc.id;
          if (tc.function?.name) calls[i].function.name = tc.function.name;
          if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
        }
      }
    }

    /**
     * **流读完了，但它是不是真说完了？** 这一判不能省。
     *
     * OpenAI 兼容的流**末尾必有一块 finish_reason**（stop / tool_calls / length …）。
     * 连接被拦腰截断时，reader.read() 给的是 done —— 长得跟正常收尾一模一样，
     * 不判就成了一次静默的截断：用户拿到半句话，界面上没有任何异常。
     * （这正是以前那一档事故：断了不报、字也只剩半截。）
     *
     * 分两种：吐了字的当传输中断，交给重连接住；一个字都没吐的就是空回复，
     * 也是可重连的那一类。
     */
    if (!finishReason && !dead()) {
      throw new Fail(
        content || calls.filter(Boolean).length ? 'TRANSPORT' : 'EMPTY_RESPONSE',
        content
          ? t('模型接口的流被拦腰断了（收到一半就没有收尾标记）')
          : t('模型接口没有回任何内容（流开到一半就断了）'),
      );
    }

    return { content, toolCalls: calls.filter(Boolean), usage, finishReason };
  } catch (e: any) {
    // 被我们自己断开时，fetch 抛的是没有信息量的 "This operation was aborted"。
    // 换成"是谁、为什么断的"：闲时超时归 TIMEOUT（能被重连接住），
    // 用户按停那条异常则原样往上走（上面按 signal.aborted 认它，一次都不重连）。
    if (dead()) {
      const msg = why();
      if (/秒没有吐任何数据/.test(msg)) throw new Fail('TIMEOUT', msg);
      throw new Error(msg);
    }
    throw e instanceof Fail ? e : new Fail('TRANSPORT', String(e?.message ?? e));
  } finally {
    if (idle) clearTimeout(idle);
    signal?.removeEventListener('abort', onOuter);
  }
}

/**
 * agent 主循环：模型想调工具就执行，把结果喂回去，直到它不再要工具。
 * 「能干活」就是靠这里 —— 一轮 = 一次思考 + 一组动作。
 * 顺便把各轮的用量加起来，界面上那条统计就是它。
 */
export async function runAgent(
  history: ApiMessage[],
  cfg: ModelConfig,
  tools: ToolSpec[],
  run: (name: string, args: any) => Promise<string>,
  events: AgentEvents,
  signal?: AbortSignal,
): Promise<AgentResult> {
  const msgs = [...history];
  let text = '';
  const usage: AgentUsage = { prompt: 0, completion: 0, total: 0, cacheHit: 0 };
  const files = new Set<string>();
  let ended: 'done' | 'limit' = 'done';

  /** 一句话直接写进回复里，用户和模型都看得见 */
  const say = (note: string) => {
    text += note;
    events.onText(note);
  };

  /**
   * 到边界了：把用户插进来的话领走，拼进**正在跑的这份 msgs** 里。
   *
   * 领走的是消息本身（回调返回即清空），所以同一句话不会被喂两遍。
   * 位置有讲究：排在已有的 assistant / tool 之后、下一次请求之前 ——
   * 这是 OpenAI 协议下唯一合法的落点（夹在 assistant(tool_calls) 和它的 tool 回执
   * 中间会被接口 400）。
   *
   * 返回领到了几条。领到就说一句"用户在你干活的时候插了话"—— 不点明的话，
   * 模型会把这条突然出现的用户消息当成新一轮的开场白，从头问一遍"你想让我做什么"。
   */
  const takeSteering = (): number => {
    const items = events.takeSteering?.() ?? [];
    if (!items.length) return 0;
    for (const it of items) {
      const shots = (it.images ?? []).map(seePart).filter(Boolean) as any[];
      const hint = t('（上面那条是用户在你干活的中途插进来的话 —— 先把眼前这一步收住，然后照他说的调整。')
        + t('不要说"收到""好的"，直接接着做。）');
      const body = [it.text, hint].filter(Boolean).join('\n\n');
      msgs.push(
        shots.length
          ? { role: 'user', content: [{ type: 'text', text: body }, ...shots] }
          : { role: 'user', content: body },
      );
      events.onSteering?.(it);
    }
    return items.length;
  };

  // MAX_ROUNDS 为 0 就是"一直做，直到模型自己不再要工具，或者用户按停"
  for (let round = 0; MAX_ROUNDS <= 0 || round < MAX_ROUNDS; round += 1) {
    signal?.throwIfAborted();
    // 边界一号：每一步开跑之前。上一轮的工具刚回执完、下一轮还没发出去 ——
    // 这时候插进来的话会跟着这一步一起进请求。
    takeSteering();
    const r = await callModel(msgs, cfg, tools, signal, events.onText, events.onReasoning, events.onRetry);
    signal?.throwIfAborted();
    // 每一轮之间空一行。以前是直接首尾相接，模型十几轮的旁白糊成一整段
    // （"我先看看……现在确认……再确认一下……"），读的人分不出哪句是结论。
    if (r.content) text += (text ? '\n\n' : '') + r.content;
    if (r.usage) {
      usage.prompt += r.usage.prompt;
      usage.completion += r.usage.completion;
      usage.total += r.usage.total;
      usage.cacheHit += r.usage.cacheHit;
    }
    // 立刻报一次：**这一轮的账从这里开始就看得见了**。放心的位置是在"这一轮已经
    // 拿到 usage"之后 —— 接口只在流的最后一块报用量，所以中途按停时拿不到正在飞的
    // 那一次，但前面每一次都已经记上了。
    events.onUsage?.({ ...usage });
    // 先验一遍这批调用的身：有些接口/模型会先发"占位分片"（只有 index、没有
    // function.name），名字没发全就收尾，会留下空壳调用。空壳一旦 push 进 msgs，
    // 同一次运行的下一次请求就是 400（tool_calls[n] is missing a function name），
    // 整轮任务当场死掉。没名字的丢掉；没 id 的现在补上（下面 tool 回执按它配对）。
    const valid: any[] = [];
    let dropped = 0;
    let seq = 0;
    for (const tc of r.toolCalls) {
      if (!String(tc?.function?.name ?? '').trim()) { dropped += 1; continue; }
      seq += 1;
      if (!tc.id) tc.id = `call_${round}_${seq}`;
      valid.push(tc);
    }
    if (!valid.length) {
      /**
       * 边界二号 —— 就是用户说的"结束单次任务、但还没结束会话"的那个缝。
       *
       * 到这儿模型已经把手头这一步做完了（没再要工具），本来该收工。但如果用户
       * 正是在这几秒里插了话，就不能收：把插话喂进去，让这一轮**继续**跑下去。
       * 少了这个领取点，插话只能干等到整轮结束 —— 那它和"排队"就没有区别了。
       *
       * 领取是**一次性**的：喂进去之后再判一次，没有新的插话才真的收工，
       * 所以不存在"插话把这一轮拖成死循环"。
       */
      if (takeSteering() > 0) continue;
      // 输出被长度上限截断：这时回复是**半句话**，不说清楚的话用户会以为模型就这水平
      if (r.finishReason === 'length') say('\n\n⚠ 这次回复被输出长度上限截断了，还没说完。说「继续」我把剩下的补完。');
      else if (dropped && !r.content) say('\n\n⚠ 接口发来的工具调用没带工具名，没法执行，这一步空了。说「重试」再来一次。');
      break;
    }

    msgs.push({ role: 'assistant', content: r.content || null, tool_calls: valid });
    let n = 0;
    for (const tc of valid) {
      signal?.throwIfAborted();
      n += 1;
      // 有些兼容接口不发 id / 发空 id。少了它，下一轮的 tool 消息就是非法的，
      // 接口会直接 400 —— 整个任务在第二步就死掉，而且报错很难看懂。
      const callId = tc.id || `call_${round}_${n}`;
      const name = String(tc.function?.name ?? '');
      let args: any = {};
      let bad = '';
      try {
        args = JSON.parse(tc.function?.arguments || '{}');
      } catch (e: any) {
        bad = String(e?.message ?? e);
      }
      if (bad) {
        // 以前这里静默当成 {}，于是 write_file 拿着空路径去写、报一句莫名其妙的错，
        // 模型对着"工具执行失败"发呆。现在把真正的原因告诉它。
        const why = r.finishReason === 'length'
          ? t('这次回复是被输出长度上限截断的，参数 JSON 只写了一半')
          : t('参数不是合法 JSON');
        const msg = `工具 ${name} 没有执行：${why}（${bad}）。把要写的内容拆小一点、分几次发，或者换一个更小的改动再来一次。`;
        events.onTool(name, {}, msg);
        msgs.push({ role: 'tool', tool_call_id: callId, content: msg });
        continue;
      }
      if (name === 'write_file' && args?.path) files.add(String(args.path));
      const out = await run(name, args);
      signal?.throwIfAborted();
      // 工具结果里可能夹着一行 `[[see: 路径]]`（出图那类工具用它把成品递给模型看一眼）：
      // 先摘出来 —— 给人看的那条记录和交给模型的正文里都不该留那行标记。
      const seen = takeSeePaths(String(out));
      events.onTool(name, args, seen.missing.length ? `${seen.text}\n（附带的图没能附上：${seen.missing.join('、')}）` : seen.text);
      // 单个工具结果最多带这么多回去。这是 agent 循环里**每一轮都要重发**的部分，
      // 上限开大了，一次消息的输入量就会成倍滚起来
      // "整份看"的那几种不修剪（见 KEEP_WHOLE）；其余的都过修剪 —— 不过经过落地闸之后，
      // 还长到需要修剪的已经没有了，这道修剪是兜底
      msgs.push({
        role: 'tool',
        tool_call_id: callId,
        content: KEEP_WHOLE.has(name) ? seen.text : pruneToolText(seen.text),
      });
      // 附给模型的图**单独走一条 user 消息**，不塞进 tool 那条的 content 数组：tool 消息
      // 带图片块不是每个兼容接口都认，而"user 消息带图"这条路是现成的（用户自己贴的截图
      // 就是这么发出去的）。它只活在当前这一轮的 msgs 里 —— 下一轮不会重发。
      if (seen.files.length) {
        const shots = seen.files.map(seePart).filter(Boolean);
        if (shots.length) {
          msgs.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text: t('（上面那一步的图在这儿，长边已经压过。看一眼再说话：')
                  + t('明显崩坏／糊／空白／不是要的东西，就改提示词或换 seed 重画；没问题就别折腾。）'),
              },
              ...shots,
            ],
          });
        }
      }
    }
    if (dropped) {
      // 模型以为自己那条也执行了 —— 不说一声，它下一轮会对着"少了一步"发呆。
      // 位置有讲究：必须排在全部 tool 回执**之后**（夹在 assistant(tool_calls) 和
      // tool 消息中间会被接口 400），所以放在 for 循环收尾这里。
      msgs.push({ role: 'user', content: `（刚才有 ${dropped} 条工具调用没带工具名，接口不认、没有执行；要干这件事就重新调一次。）` });
    }
    // 最后一步刚做完、结果还没给模型看过 —— 那就是预算用完了，得说明白
    if (MAX_ROUNDS > 0 && round === MAX_ROUNDS - 1) ended = 'limit';
  }

  if (ended === 'limit') {
    say(`\n\n⚠ 这一轮做到第 ${MAX_ROUNDS} 步就停了，上面还有活没干完（刚才那几步的结果我自己也还没看过）。说「继续」我就接着做，不用你重新交代。`);
  }

  return { text, usage, files: [...files], ended };
}

/** 流式调用（OpenAI 兼容协议），逐字回调。cfg 由调用方按"这个窗口用哪个模型"给 */
export async function streamChat(
  messages: ChatMessage[],
  handlers: StreamHandlers,
  signal: AbortSignal | undefined,
  cfg: ModelConfig,
): Promise<string> {
  if (!cfg.apiKey) {
    handlers.onError(t('这个窗口还没有配置模型密钥。在它自己的标题栏「模型」里填一个。'));
    return '';
  }

  let full = '';
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        stream: true,
        messages: messages.map((m) => ({
          role: m.role === 'tool' ? 'user' : m.role,
          content: m.content,
        })),
      }),
      signal,
    });

    if (!res.ok || !res.body) {
      handlers.onError(`模型接口返回 ${res.status}：${await res.text().catch(() => '')}`);
      return '';
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const delta: string = JSON.parse(data).choices?.[0]?.delta?.content ?? '';
          if (delta) {
            full += delta;
            handlers.onDelta(delta);
          }
        } catch {}
      }
    }
    handlers.onDone(full);
    return full;
  } catch (e: any) {
    handlers.onError(String(e?.message ?? e));
    return full;
  }
}
