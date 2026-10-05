import * as fs from 'fs';
import * as path from 'path';
import { appPath, userDataPath } from './paths';
import { dropPanelSpace, workspaceRoot } from './fsapi';
import type {
  ChatMessage,
  ChatStats,
  ClosedRef,
  ComponentRef,
  DockNode,
  DockTarget,
  FloatingWindow,
  HostKey,
  ModelConfig,
  ModelInfo,
  Panel,
  SketchNode,
  SketchSlot,
  PanelComponent,
  PanelFloat,  PanelKind,
  PanelMode,
  Rect,
  Workspace,
  WorkspaceFull,
} from '../shared/types';
import { MAIN_HOST, DEFAULT_COMPONENT_BAR_MAX, defaultLook, defaultSpec, emptyRect, isComponentPanel, isTabGroup } from '../shared/types';
import type { PanelWidget } from '../shared/types';
import { readTextFile } from './chat-core';
import { describePick, fallbackPick, resolvePick } from './providers';
import * as W from './workspace';
import { t } from '../shared/i18n';

/**
 * 工作区真源：面板表 + 主窗口停靠树 + 浮窗列表。
 *
 * 磁盘上只有这一份 workspace.json。面板的位置从来不存在面板自己身上，
 * 只存在于树里 —— 所以"拖出去 / 拖回来"改的是树，面板对象本身不动。
 */

const FILE = () => userDataPath('workspace.json');
/** 上一版留一份备胎：主文件真读坏了还能退回来 */
const BAK = () => `${FILE()}.bak`;

/**
 * 老工作区升级时给 `lastPick` 找个起点：随便挑一个已经存在的选择都行
 * （会话级的优先，其次窗口级）—— 它只是"新窗口该落在哪"的兜底，
 * 挑哪个都比掉回预设默认更接近用户上次的意思。
 */
function firstPickOf(raw: any): string {
  const pools = [raw?.panelModels, raw?.windowModels];
  for (const p of pools) {
    if (p && typeof p === 'object') {
      const v = Object.values(p).find((x) => typeof x === 'string' && x);
      if (typeof v === 'string') return v;
    }
  }
  return '';
}

/**
 * 把一块面板补全到**渲染层敢读**的程度。
 *
 * 为什么非要有它：渲染层读的是 `panel.spec.actions.length` / `panel.spec.fields.length`
 * （见 renderer/panel/PanelSurface.tsx、registry.tsx）—— 少一个键就是
 * `Cannot read properties of undefined (reading 'length')`，**整块面板当场裂开**。
 *
 * 而面板能从好几条路进来，每条都得补一次，漏一条就是一个必崩的入口：
 *   · 新建（调用方可能只给自己要的那两个字段，比如"开一块网页"只给 body + text）
 *   · 读正文文件（老存档、别的机器搬过来的）
 *   · 从「历史会话」重开（closed/ 里躺了几个月的那份）
 *
 * 以前只在"做法迁回本体"那条路上补过（withCraft），别的路全裸着 —— 这次一起补齐。
 * 补的是**空值**（defaultSpec 给的就是空串/空数组），不会盖掉面板自己有的东西。
 */
function completePanel(p: Panel): Panel {
  return {
    ...p,
    look: { ...defaultLook(), ...((p.look || {}) as Panel['look']) },
    spec: { ...defaultSpec(p.kind || 'chat'), ...((p.spec || {}) as Panel['spec']) },
  };
}
/** 关掉的面板本体放这儿：一个面板一个文件，不跟主状态混在一起（不设上限，想清理由用户在设置里手动删） */
const closedDir = () => userDataPath('closed');
const closedFile = (id: string) => path.join(closedDir(), `${id}.json`);

/**
 * **开着的**面板本体也放这儿：一个面板一个文件。
 *
 * 为什么连开着的也要分家：`workspace.json` 是**整份重写**的 —— 保存一次就把整个对象
 * 序列化一遍写下去。十几块面板、几千条对话，一份就是 15 MB；而草稿每 1.5 秒自动保存
 * 一次，等于**边打字边每 1.5 秒重写 15 MB**。拆开之后主文件只剩"谁、在哪、什么状态"
 * （几十 KB），打字只改动当前这一个面板文件 —— 画布那块 6 MB 一个字都不用碰。
 *
 * **内存里照旧是完整的**（`this.ws.panels` 一个字段都不少）：拆分只发生在落盘这一步，
 * 渲染层、插件、布局全都读到和以前一模一样的对象。正因为如此，那六十多处
 * 直接改面板的地方（`panel.chat.push(...)` 之类）一行都不用动 —— 少改一处就是少一处丢数据的风险。
 */
const bodyDir = () => userDataPath('panels');
const bodyFile = (id: string) => path.join(bodyDir(), `${id}.json`);

/**
 * 骨架里**不要**的字段：一块面板可能带着十几万字的对话和几 MB 的压缩存档，
 * 这些只该待在自己那个文件里。别的字段（标题、类型、外观、规格、状态、模型……）
 * 都留在骨架里 —— 它们是"这块面板是什么"，不是"它装了多少东西"。
 */
const BODY_KEYS = ['chat', 'compact', 'revisions', 'redoRevisions'] as const;

/**
 * 广播里每个面板最多带几条助手消息 id（数未读用）。
 *
 * 为什么不是"全带"：一块面板上千条对话，全带就是一串几千个 id，白白撑大广播。
 * 为什么不能太小：侧栏靠"上一次看到的那条 id"当锚点算未读，锚点一旦掉出这个窗口，
 * 未读就会归零（表现是"员工明明回了我、侧栏却没提示"）。500 条覆盖了绝大多数情形，
 * 代价只有几十 KB —— 相比正文那十几 MB，仍然可以忽略。
 */
const SUM_IDS_MAX = 500;

/** 把一块面板削成能进骨架的样子（原对象不动） */
function toSkeleton(p: Panel): Partial<Panel> {
  const out: Record<string, unknown> = { ...p };
  for (const k of BODY_KEYS) delete out[k];
  return out as Partial<Panel>;
}

/**
 * 收纳区（顶上那条）收着的面板本体放这儿：也是一个面板一个文件。
 * 存的是**整个面板**（对话、草稿、修订、状态），不是模板 —— 跟 closed 同一个套路：
 * 十几万字的对话混进 workspace.json，会让每次启动的全量读和每次保存的全量写变成灾难。
 */
const stowDir = () => userDataPath('components');
const stowFile = (id: string) => path.join(stowDir(), `${id}.json`);

/**
 * 把一份本体写回 `components/<id>.json` —— 收纳、声明、关闭回存、钉住/释放都走这儿。
 *
 * **`component`、`noWorkspacePrompt` 和 `pinned` 一定写在最前面**：列条目只读文件头 4KB，
 * 而面板可能带着十几万字的对话 —— 这几个字段要是落在文件尾巴上，就等于不存在
 * （条目会当它没声明；而 `noWorkspacePrompt` 是"这是员工工作面、别当组件"的标记，
 * 读不到它，那个人就会被列进 设置 → 组件）。
 * 浮窗位置（float）顺手摘掉：那块区域早没了，留着只会指向一个不存在的地方。
 */
function writeStow(id: string, panel: Panel, pinned: boolean) {
  const rest: Panel = { ...panel };
  delete rest.component;
  delete rest.pinned;
  delete rest.noWorkspacePrompt;
  delete rest.float;
  const head: Partial<Panel> = {
    ...(panel.component ? { component: panel.component } : {}),
    ...(panel.noWorkspacePrompt ? { noWorkspacePrompt: true } : {}),
    pinned,
  };
  const body: Record<string, unknown> = { ...head, ...rest };

  // **注册为组件的面板，做法不进本体**（写不成就不摘 —— 两头都没有是最坏的结果）：
  // 做法（几 KB，要跟着仓库走）落进工作区，本体只留对话和正文（那两样只属于本机）。
  // 顺序不能反：先把做法落到新家，再从本体里摘掉。
  if (isComponentPanel(panel)) {
    if (putCraft(panel)) {
      delete body.look;
      // spec 只留 text（"里面装着什么"），别的都跟着做法文件走
      const text = (body.spec as Record<string, unknown> | undefined)?.text;
      body.spec = (text === undefined ? {} : { text }) as Panel['spec'];
    } else {
      console.error('[做法] 这份没落下来，本体里的先留着：', panel.id);
    }
  }

  fs.mkdirSync(stowDir(), { recursive: true });
  fs.writeFileSync(stowFile(id), JSON.stringify(body, null, 2), 'utf8');
}

/**
 * 做法存哪儿 —— **一个组件一个文件**：`.ensoul/library/components/<面板 id>.json`。
 *
 * 为什么不是所有人挤一份 presets.json（那是我上一版的错，得改）：
 *   · **多人**：两个人都各自发布过组件、又都往同一个文件里加一条 —— git 必冲突，
 *     而且冲突就落在相邻那几行上，手改都不知道该留谁的。
 *   · **单发**：想把一个组件开源出去，得从一大堆条目里抠出那一条，剩下全是同名的。
 *   一件一个文件，这两件事就都成了"拷一个文件 / 删一个文件"。
 *
 * 文件名用**面板 id**，不用名字：
 *   名字是给人看的、随时会改，改一次就连文件名一起搬；
 *   而且不同机器上的同名组件会撞在同一个文件名上，一个把另一个盖掉 —— id 才是身份证。
 *
 * 做法**只住这一份**（本体里那半被摘掉了，见 writeStow）：对话留本机，做法进工作区。
 * 代价说在明处：**这个文件丢了、又没提交，那个组件的做法就没了（对话还在）** ——
 * 只有一个真源本来就是这个意思，所以它才必须跟着仓库走。
 *
 * 别人的文件**一律不碰**：撤销组件只删它自己那一件。
 *   不能拿"本机有没有这块面板"去清理 —— 别人提交的是别的机器上的面板 id，
 *   按本机清一遍会把人家提交的东西全删掉，然后你还把它提交回去了。
 */
const craftDir = () => path.join(workspaceRoot(), '.ensoul', 'library', 'components');
/** 老版本那个"所有人挤一份"的文件：还留着就一起认，核心启动时会把它拆成一件一件 */
const legacyCraftFile = () => path.join(workspaceRoot(), '.ensoul', 'library', 'presets.json');

/** 面板 id 当文件名：只留安全字符，免得一个怪 id 把文件写到目录外去 */
function safeCraftId(id: string): string {
  const s = String(id || '').trim().replace(/[^A-Za-z0-9._-]/g, '_');
  return s && s !== '.' && s !== '..' ? s : 'unnamed';
}

const craftFileOf = (id: string) => path.join(craftDir(), `${safeCraftId(id)}.json`);

/** 老的单文件里那些做法（没这份文件、或者坏了，都当没有，不吵） */
function readLegacyCrafts(file = legacyCraftFile()): any[] {
  try {
    const j = JSON.parse(readTextFile(file));
    return Array.isArray(j?.items) ? j.items : [];
  } catch {
    return [];
  }
}

/**
 * 认一条做法归谁：**面板 id**。
 * 老条目没有 panel 字段时退回它自己的 id —— 老版本恰好是把面板 id 写进 id 的。
 */
const craftOwner = (o: any, fallback = ''): string =>
  String(o?.panel || o?.id || fallback || '').trim();

/** 把工作区里所有可分发做法读出来（一个文件一条；坏的跳过，不拖累别的） */
function readCrafts(): any[] {
  const out: any[] = [];
  const seen = new Set<string>();
  const roots = [
    ...(workspaceRoot() ? [{ dir: craftDir(), legacy: legacyCraftFile(), source: 'ws' }] : []),
    { dir: appPath('.ensoul', 'library', 'components'), legacy: appPath('.ensoul', 'library', 'presets.json'), source: 'app' },
  ];
  for (const root of roots) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(root.dir).filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'));
    } catch {
      /* 目录尚未创建 */
    }
    for (const f of files) {
      try {
        const file = path.join(root.dir, f);
        const j = JSON.parse(readTextFile(file));
        if (!j || typeof j !== 'object') continue;
        const owner = craftOwner(j, f.replace(/\.json$/, ''));
        if (!owner || seen.has(owner)) continue;
        seen.add(owner);
        out.push({ ...j, panel: owner, source: root.source, craftPath: file });
      } catch {
        /* 坏文件跳过 */
      }
    }
    for (const it of readLegacyCrafts(root.legacy)) {
      const owner = craftOwner(it);
      if (!owner || seen.has(owner)) continue;
      seen.add(owner);
      out.push({ ...it, panel: owner, source: root.source, craftPath: root.legacy });
    }
  }
  return out;
}

/** 这一刻这块面板的做法（手上没有就返回 null —— 调用点退回本体里那份） */
function craftOf(id: string): { look?: any; spec?: any } | null {
  const hit = readCrafts().find((i) => i && craftOwner(i) === String(id));
  return hit ? { look: hit.look, spec: hit.spec } : null;
}

/**
 * 做法里那部分 spec —— **text 不算**。
 * text 是"里面此刻装着什么"（浏览器里就是当前地址，翻一页就变一次），
 * 跟着仓库走只会让一份可分发的文件天天脏 diff、还把本机地址捎进去。
 * 所以 text 留在本体里（那本来就在本机），做法文件只装"这块面板是干什么的"。
 */
function craftSpec(panel: Panel): Record<string, unknown> {
  const spec = { ...((panel.spec || {}) as unknown as Record<string, unknown>) };
  delete spec.text;
  return spec;
}

/**
 * 这份面板身上**还有做法吗** —— look 里还有键，或者去掉 text 的 spec 还剩字段。
 *
 * 这是"搬过家了没"的判据，非有不可：搬完家的本体长这样 `spec: { text: "..." }` ——
 * 光看 `!panel.spec` 会把它当成**没搬过**，于是再搬一次；而这一次手上已经没有做法了，
 * 写出来的就是空的 look + 空的 spec —— **把工作区里那份好端端的做法覆盖成空**。
 * 所以判"有没有做法"必须先把 text 摘掉再看。
 */
function hasCraft(panel: { look?: unknown; spec?: unknown }): boolean {
  if (panel.look && typeof panel.look === 'object' && Object.keys(panel.look).length) return true;
  return Object.keys(craftSpec(panel as Panel)).length > 0;
}

/**
 * 把一块面板这一刻的做法写进**它自己那件文件**。
 *
 * 返回值是「**磁盘上现在就是这份做法了吗**」，不是「这次写盘了没」——
 * 一样的时候它不重写（不然每次保存都动一次文件，git 里全是噪声），但那也算对。
 * 调用点靠它决定能不能把本体里那半摘掉：**只有确认真落好了才敢摘**。
 */
function putCraft(panel: Panel): boolean {
  if (!isComponentPanel(panel)) return false;
  // 手上没有做法（本体里摘过了、面板又没开）：什么都不做，
  // 别拿空值把那份好端端的做法覆盖成空的
  if (!hasCraft(panel)) return false;
  const name = String(panel.component || '').trim();
  if (!name || !panel.id || !workspaceRoot()) return false;

  const file = craftFileOf(panel.id);
  const spec = craftSpec(panel);
  let at = Date.now();
  /** 说明是人写的一句话，不是做法的一部分 —— 重写做法时别把它冲掉 */
  let note = '';
  try {
    const cur = JSON.parse(readTextFile(file));
    note = String(cur?.note || '').trim().slice(0, 200);
    const same =
      cur && craftOwner(cur) === panel.id &&
      cur.name === name &&
      cur.kind === panel.kind &&
      cur.title === (panel.title || '') &&
      JSON.stringify(cur.look) === JSON.stringify(panel.look) &&
      JSON.stringify(cur.spec) === JSON.stringify(spec);
    if (same) return true; // 已经是这份了：没写盘，但磁盘上是对的
    at = Number(cur?.at) || at;
  } catch {
    /* 还没这份文件（或者坏了）：往下写就是了 */
  }

  const body = {
    id: panel.id,
    panel: panel.id,
    name,
    kind: panel.kind,
    title: panel.title || '',
    look: panel.look,
    spec,
    ...(note ? { note } : {}),
    at,
  };
  try {
    fs.mkdirSync(craftDir(), { recursive: true });
    // 先写临时文件再改名 —— 同 workspace.json 那条理由：重启是 taskkill /F，半截文件最伤
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    console.error('[做法] 写不下来：', e);
    return false;
  }
}

/** 用户撤销了某个组件：**只删它自己那一件**，别人的文件一个都不碰 */
function dropCraft(id: string): void {
  try {
    const file = craftFileOf(id);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (e) {
    console.error('[做法] 这条没删掉：', e);
  }
  // 老的单文件里还留着同一条的话一起摘掉 —— 别留个残影
  const items = readLegacyCrafts();
  const keep = items.filter((i) => craftOwner(i) !== String(id));
  if (keep.length === items.length) return;
  try {
    const legacy = legacyCraftFile();
    const raw = JSON.parse(readTextFile(legacy));
    fs.writeFileSync(legacy, JSON.stringify({ ...raw, items: keep }, null, 2) + '\n', 'utf8');
  } catch {
    /* 那份文件本来就坏了：不动它 */
  }
}

/**
 * 文件头里那句"这是员工工作面" —— 读得到就说明它不该待在 `components/` 里。
 *
 * 为什么要看 `"noWorkspacePrompt"` 这个**没转义的**名字：里面可能是十几万字对话，
 * 为了一个布尔值把整份对话读成对象图不划算。而对话正文里的同名文字在 JSON 里
 * 一定是 `\"noWorkspacePrompt\"`（前面带反斜杠），这个反向断言正好把它排除掉。
 */
const isAgentHead = (head: string) => /(^|[^\\])"noWorkspacePrompt"\s*:\s*true/.test(head);

/**
 * 只读文件头 4KB —— 列一条只要 id / title / kind，它们在 JSON 最前面几个字段里，
 * 不为了一张表把整段对话读进来。
 */
function readHead(file: string): string {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  }
}

/**
 * 一块面板是不是**空的** —— 建出来之后一个字都没动过。
 *
 * 判据是"它身上有没有东西"，不是看标题叫不叫「新面板」：对话、草稿、修订、
 * 待发队列、打开的文件、规格里写下的正文与字段，只要有一样就算有内容。
 *
 * 空面板关掉时**不留档**（面板照关，只是不写 closed/<id>.json）：
 * 历史会话是回头捞东西的地方，攒一屏从没用过的空壳只会把真东西埋掉。
 */
function isBlankPanel(p: Panel): boolean {
  // 只在**对话面板**上生效：其它类型（表格、编辑器、插件自带的那种）身上可能
  // 一点字段都看不出来，却有自己的状态在别处 —— 那种照旧留档，别替用户做主删掉。
  if (p.kind !== 'chat') return false;
  // 声明过的是组件，回的是组件库那条路，不归这儿管
  if (isComponentPanel(p)) return false;
  if (Array.isArray(p.chat) && p.chat.length) return false;
  if (Array.isArray(p.revisions) && p.revisions.length) return false;
  if (Array.isArray(p.redoRevisions) && p.redoRevisions.length) return false;
  if (Array.isArray(p.outbox) && p.outbox.length) return false;
  if ((p.draft || '').trim()) return false;
  if (p.file) return false;
  if (p.compact) return false;
  const s = p.spec as Panel['spec'] | undefined;
  if (!s) return true;
  if ((s.text || '').trim()) return false;
  if ((s.systemPrompt || '').trim()) return false;
  if (Array.isArray(s.actions) && s.actions.length) return false;
  if (Array.isArray(s.fields) && s.fields.length) return false;
  return true;
}

class Store {
  private ws: WorkspaceFull = {
    panels: {},
    layout: W.makeTabGroup(),
    floating: [],
    windowModels: {},
    panelModels: {},
    thinks: {},
    workspace: process.env.ENSOUL_WORKSPACE || '',
  };
  private timer: NodeJS.Timeout | null = null;
  /**
   * 收纳区索引（内存里的缓存）。
   *
   * 每次刷新都要带它（publicState 里），所以不能每次扫盘 ——
   * 只在启动、收纳、关闭回存、删除之后由 `rebuildStows()` 重建（打开不删文件，不用重建）。
   * 它**不落盘**，所以不存在"索引在、文件不在"那种不同步。
   */
  private stows: ComponentRef[] = [];

  /**
   * 上一次写出去的**面板本体**（id → 那份 JSON 文本）。
   *
   * 落盘时拿它比一比：**内容没变的面板一个字节都不重写**。这是拆分能真正省下 IO 的关键 ——
   * 光把文件分开、每次还是全写一遍，磁盘开销跟原来一模一样。
   *
   * 为什么用"文本比对"而不是在调用点打脏标记：面板对象有六十多处被人**直接改**
   * （`panel.chat.push(...)` 那种，见 main/index.ts），漏掉一处的代价是静默丢数据。
   * 比对慢一点（跟原先"整个 stringify"一个量级），但它不会漏。
   */
  private bodyCache = new Map<string, string>();

  /**
   * 「最近关闭」清单的缓存（见 closedPanels）。
   *
   * 钥匙是 closed/ 目录的 mtime —— 归档文件写进去就不再改，目录 mtime 只在增删时变，
   * 所以 mtime 一样就等于清单一样。不缓存的话，每开一次设置面板都要对 166 个文件
   * 逐个 statSync（7~12 ms），而那点时间正好压在"卡片出场"的关键路径上。
   */
  private closedCache: { key: number; list: ClosedRef[] } | null = null;

  /**
   * 落盘序号：**只有开始得最晚的那一次**才允许把临时文件改成正式文件。
   *
   * 为什么必须有：防抖那条路是**异步**的（见 flushAsync），而退出 / 重启前那条是
   * 同步的（flushSync）。异步那次写完加上改名要几十毫秒，期间同步那次可能已经先落地 ——
   * 不设这道闸，异步手里那份**更旧**的数据反而最后改名，把新的盖回去。
   * 序号大的 = 开始得晚 = 数据更新；它赢了，前面那些就不再改名。
   */
  private writeToken = 0;

  load() {
    let raw: any = null;
    try {
      if (fs.existsSync(FILE())) raw = JSON.parse(readTextFile(FILE()));
    } catch (e) {
      // 主文件读坏了：先试备胎，**不要直接 seed** —— 那等于把整个工作区抹掉，
      // 而且一声不吭。宁可退回上一次保存的状态，也好过整个清空。
      console.error('[工作区] 主文件读取失败，尝试备份：', e);
      try {
        if (fs.existsSync(BAK())) {
          raw = JSON.parse(readTextFile(BAK()));
          console.error('[工作区] 已从备份恢复');
        }
      } catch (e2) {
        console.error('[工作区] 备份也读不出来：', e2);
      }
    }

    if (raw && raw.panels && raw.layout && typeof raw.panels === 'object') {
      // 面板正文**先看它自己那个文件**（拆分后它才是真源），文件不在才退回骨架里那份 ——
      // 老工作区还没搬过来的第一次启动，正文就写在骨架里，读完这一次就会被搬出去。
      const panels: Record<string, Panel> = {};
      for (const [id, skel] of Object.entries(raw.panels as Record<string, Panel>)) {
        panels[id] = this.loadBody(id) ?? skel;
      }
      this.ws = {
        panels,
        layout: raw.layout,
        floating: Array.isArray(raw.floating) ? raw.floating : [],
        windowModels: raw.windowModels && typeof raw.windowModels === 'object' ? raw.windowModels : {},
        panelModels: raw.panelModels && typeof raw.panelModels === 'object' ? raw.panelModels : {},
        // 思考水平必须一起读回来：不读的话下一次 flush 就把用户设的档位抹掉了（同上面那条注释）
        thinks: raw.thinks && typeof raw.thinks === 'object' ? raw.thinks : {},
        workspace: typeof raw.workspace === 'string' ? raw.workspace : process.env.ENSOUL_WORKSPACE || '',
        // "最近开过"必须跟着读回来。不读回来的后果不是"少一条记录"：启动时那次全量
        // flush 会把没有这个字段的状态写回文件，等于当场抹掉 —— 于是左上角那个菜单
        // 永远只剩一条"打开文件夹…"，换过去就再也切不回来，看着就像工作区写死了。
        recentWorkspaces: Array.isArray(raw.recentWorkspaces)
          ? raw.recentWorkspaces.filter((d: unknown): d is string => typeof d === 'string')
          : [],
        // "上一次选过的模型"：老工作区里没这个字段，就从已有的选择里挑一个当起点，
        // 免得升级之后开新窗口又掉回预设默认 —— 用户上次挑的那个显然比预设更贴他。
        lastPick:
          typeof raw.lastPick === 'string' && raw.lastPick
            ? raw.lastPick
            : firstPickOf(raw),
        componentBarMax:
          typeof raw.componentBarMax === 'number' && Number.isFinite(raw.componentBarMax)
            ? raw.componentBarMax
            : undefined,
      };
      // 老工作区里"完全权限"是整个工作区一个开关（raw.fullAccess）。那个字段现在没了，
      // 而权限改成了**按会话**算 —— 迁移的口径：那时开着就相当于所有会话都开着，
      // 于是把这份权限摊到当时那些对话面板上，行为不变。此后各走各的。
      if (raw.fullAccess) {
        for (const p of Object.values(this.ws.panels) as Panel[]) {
          if (p && p.kind === 'chat') p.fullAccess = true;
        }
      }
    } else {
      this.ws = {
        panels: {},
        layout: W.makeTabGroup(),
        floating: [],
        windowModels: {},
        panelModels: {},
        thinks: {},
        workspace: process.env.ENSOUL_WORKSPACE || '',
      };
      this.seed();
    }
    // 上次退出时还在"工作中"的面板：进程都没了，那一轮就是被中断的 ——
    // 留着 working 会让点点永远蓝着呼吸，其实早就没人干活了。
    for (const p of Object.values(this.ws.panels)) {
      if (p.status === 'working') p.status = 'error';
    }
    this.cleanup();
    // 员工工作面曾经被当成组件（eschat 开面板时盖的声明）：先把它从"组件"里摘出来，
    // 再扫目录 —— 不摘的话，库和顶栏上会一直挂着几个"其实是人"的条目。
    this.detachAgentPanels();
    // 老的"模板组件"先摊成收纳区里的面板，再扫目录建索引 —— 收纳条上的内容以磁盘为准
    this.migrateLegacyComponents();
    // 早先关掉、落进历史会话的非对话面板搬回组件区（它们按类型本来就是组件）
    this.pruneUnclaimedStows();
    // 历史会话里攒下的空面板（建出来一个字没动就关掉的）一并清掉
    this.pruneBlankClosed();
    this.rebuildStows();
    this.save();
  }

  /**
   * 第一次打开：直接就是一个像样的工作区 ——
   * 左边文件树，右上正在编辑的文本，右下和面板对话。
   * 三块都是停靠树里的普通节点，随手就能拖开、拖走、拖成浮窗。
   */
  private seed() {
    const files = this.createPanel({ title: t('文件'), kind: 'files', look: { ...defaultLook(), showChat: false } });
    const text = this.createPanel({
      title: t('还没有打开文件'),
      kind: 'editor',
      look: { ...defaultLook(), showChat: false },
      spec: defaultSpec('editor'),
    });
    const chat = this.createPanel({
      title: t('工作区'),
      kind: 'chat',
      spec: {
        ...defaultSpec('chat'),
        text: '',
      },
    });

    const left = W.makeTabGroup(W.newId('tabs'), [files.id]);
    const topRight = W.makeTabGroup(W.newId('tabs'), [text.id]);
    const bottomRight = W.makeTabGroup(W.newId('tabs'), [chat.id]);

    this.ws = {
      panels: this.ws.panels,
      layout: {
        type: 'split',
        id: W.newId('split'),
        direction: 'row',
        ratio: 0.24,
        children: [
          left,
          {
            type: 'split',
            id: W.newId('split'),
            direction: 'column',
            ratio: 0.62,
            children: [topRight, bottomRight],
          },
        ],
      },
      floating: [],
      windowModels: this.ws.windowModels,
      workspace: this.ws.workspace,
    };
  }

  /**
   * 宿主没了（被归一化收回、或者被清空），挂在它下面的浮窗改挂到主窗口上。
   * 不修就会留下指向"已经不存在的窗口"的 parent —— 下次宿主挪动时谁也带不动它，
   * 那个窗口就成了没人管的孤儿。
   */
  private rehomeOrphans() {
    const ids = new Set(this.ws.floating.map((w) => w.id));
    let changed = false;
    const floating = this.ws.floating.map((w) => {
      if (w.parent && w.parent !== 'main' && !ids.has(w.parent)) {
        changed = true;
        return { ...w, parent: 'main' };
      }
      return w;
    });
    if (changed) this.ws = { ...this.ws, floating };
  }

  /**
   * 拖动途中撕下来的那一拖，源窗口即使暂时空了也得留着 —— 它是拿着这一拖的那扇窗。
   * 松手之后由 reapEmptyWindows 把这个记号清掉。
   *
   * 但这个记号**必须自己有寿命**：那一拖要是没收尾（信号丢了），记号就永远指着那块
   * 已经空了的源窗口，它于是永远不被回收 —— 屏幕上留着一块空窗口，白白的、盖着别的
   * 东西、也点不动。所以到点无条件清掉并回收一次，不管有没有人来收尾。
   */
  private keepEmpty: string | null = null;
  private keepTimer: ReturnType<typeof setTimeout> | null = null;

  /** 自我修复：孤儿面板收回主窗口，空标签组收掉，空浮窗关掉，附属重新找家 */
  private cleanup() {
    for (const id of W.orphanPanelIds(this.ws)) {
      // 悬浮面板、后台面板、挂件窗口本来就不在树里 —— 它们不是孤儿，别收回去
      if (this.ws.panels[id]?.float || this.ws.panels[id]?.hidden || this.ws.panels[id]?.widget) continue;
      this.ws.layout = W.insertPanel(this.ws.layout, W.firstTabGroup(this.ws.layout).id, id);
    }
    this.ws.layout = W.pruneEmptyTabs(this.ws.layout);
    this.ws.floating = this.ws.floating
      // 浮窗里只保留一层标签：任何切成两栏的树在这里被拍平（见 flattenTabs）
      .map((w) => ({ ...w, root: W.flattenTabs(W.pruneEmptyTabs(w.root)) }))
      .filter(
        (w) => w.id === this.keepEmpty || W.tabGroupsOf(w.root).some((t) => t.panels.length > 0),
      );
    this.rehomeOrphans();
    this.rehomeFloats();
  }

  /** 这个窗口在树里还有面板吗（空窗口 = 一块白板，留着只会盖住别人） */
  private itHasPanels(windowId: string): boolean {
    const w = this.ws.floating.find((x) => x.id === windowId);
    return Boolean(w && W.tabGroupsOf(w.root).some((t) => t.panels.length > 0));
  }

  /**
   * 挂件的归宿：依附的那块区域还在就留着；区域没了（被剪掉、被关掉）才并回主窗口 ——
   * 面板本身不能因为归属地没了而消失。
   *
   * 这里**不能**无条件把所有 float 拆掉：挂件是正经的一等状态（面板嵌在另一块区域上），
   * 每一轮 cleanup 都拆一遍的话，刚嵌好的挂件下一次广播就没了 —— "嵌入面板的机制
   * 目前还没有实现"看着像没接线，其实是接上了当场被这里拆掉。
   */
  private rehomeFloats() {
    const alive = new Set<string>();
    const collect = (n: DockNode) => {
      if (isTabGroup(n)) alive.add(n.id);
      else n.children.forEach(collect);
    };
    collect(this.ws.layout);
    for (const w of this.ws.floating) collect(w.root);

    let changed = false;
    for (const p of Object.values(this.ws.panels)) {
      if (!p.float) continue;
      // 宿主和依附的那块区域都还在 → 它是正经挂件，原样留着
      if (alive.has(p.float.anchor)) continue;
      const { float: _gone, ...rest } = p;
      this.ws.panels[p.id] = rest;
      this.ws.layout = W.insertPanel(this.ws.layout, W.firstTabGroup(this.ws.layout).id, p.id);
      changed = true;
    }
    if (changed) this.save();
  }

  get state(): WorkspaceFull {
    return this.ws;
  }

  /**
   * 下发给窗口的状态：只带"这个会话用哪个模型"，**密钥一个字都不出去**。
   *
   * ── 为什么 panels 给的是**骨架**（不含 chat / compact / revisions）──────────
   *
   * 这份状态是**广播**出去的：只要有一处改动（点一下布局、切一个标签、跑一步工具），
   * 就发给每一个窗口。而面板正文（对话 + 压缩存档）十几 MB —— 实测 13 块面板
   * 合计 14.47 MB（最大一块 4.76 MB）。每广播一次就 stringify + 跨进程传这一整坨，
   * 渲染进程再反序列化一遍：单程 ≈ 50 ms，叠上写盘就是"点个设置要等一秒"。
   *
   * 而这些正文渲染层几乎不看：12 块面板的 chat 一个字都没人读，只有**当前显示的那块**
   * 由 ChatDock 读、以及侧栏数未读要一个摘要。所以广播只发骨架，
   * 正文按需补：
   *   · 当前打开的那块 ← `panel:body`（ChatDock 挂载时拉一次）
   *   · 增量消息        ← `chat:message`（本来就有，一条一条并进 cache）
   *   · 侧栏未读/排序    ← `panel.summary`（见 summarizedPanel）
   * 插件拿到的是**主进程内存里那个完整对象**（见 plugins.ts 的 api.panels），
   * 所以插件读 `p.chat` 走的是真源，不受这里影响。
   */
  publicState(): Workspace {
    const models: Record<HostKey, ModelInfo> = {};
    // 会话级：**每块面板各带一条**（没自己选过模型的，pickForPanel 会照此刻默认给它钉一条）。
    // 少一条，前台那行就退回宿主的值显示，跟这一轮实际在跑的模型对不上。
    for (const id of Object.keys(this.ws.panels)) {
      const d = describePick(this.pickForPanel(id));
      models[id] = { model: d.name || t('没配模型'), pick: d.pick, hasKey: d.hasKey };
    }
    // 宿主级：'main' 和每个浮窗 —— 窗口里**没单独选过**的面板看这个
    const keys = new Set<HostKey>([MAIN_HOST, ...this.ws.floating.map((w) => w.id), ...Object.keys(this.ws.windowModels)]);
    for (const key of keys) {
      const d = describePick(this.pickFor(key));
      models[key] = { model: d.name || t('没配模型'), pick: d.pick, hasKey: d.hasKey };
    }
    // 面板：骨架 + 未读摘要（正文一个字节都不进广播）
    const panels: Record<string, Panel> = {};
    for (const [id, p] of Object.entries(this.ws.panels) as [string, Panel][]) {
      const s = this.summarizedPanel(p);
      /*
       * 兜底自查：摘要里**绝不能**混进正文。
       *
       * 这几个键一旦漏进去，广播就又开始搬十几 MB，而症状是"界面慢慢变卡" ——
       * 没人会当场发现是哪一行漏的（当初写下这套拆分，就是因为这样吃过亏）。
       * 后台的 AI 员工面板最容易踩：它照样在跑、在涨消息，而没人在看它的对话。
       * 真出现了就当场把那几个键削掉，并在控制台点名 —— 宁可摆手上一刀，不留性能地雷。
       */
      for (const k of BODY_KEYS) {
        if ((s as Record<string, unknown>)[k] === undefined) continue;
        delete (s as Record<string, unknown>)[k];
        console.error(`[状态] 面板 ${id} 的「${k}」漏进了广播 —— 已就地削掉，请查上面的调用点`);
      }
      panels[id] = s as unknown as Panel;
    }
    return {
      panels,
      layout: this.ws.layout,
      floating: this.ws.floating,
      widgets: this.widgetList(),
      models,
      workspace: this.ws.workspace,
      recentWorkspaces: this.ws.recentWorkspaces ?? [],
      status: Object.fromEntries(Object.keys(this.ws.panels).map((id) => [id, this.statusOf(id)])),
      commands: this.commandsOf(),
      componentRefs: this.componentRefs(),
      componentBarMax: this.componentBarMax(),
    };
  }

  /** 挂件窗口清单：给窗口层开窗用（面板 id + 那扇窗的位置大小） */
  widgetList(): { panelId: string; box: PanelWidget }[] {
    return Object.values(this.ws.panels)
      .filter((p) => p.widget)
      .map((p) => ({ panelId: p.id, box: p.widget as PanelWidget }));
  }

  /**
   * 面板摘要：骨架 + 够画一条侧栏 / 数未读的那几个字段，**不带 chat 正文**。
   *
   * 侧栏本来要读整份 chat 才算得出：最后一条助手消息的 id / 时间、未读数、最后说了什么。
   * 这些由主进程现算（它手上就是完整对象），渲染层照单收即可 ——
   * 一次广播从 14 MB 掉到几十 KB，侧栏的行为一个字都不变。
   *
   * `panel.summary` 这个字段名是刻意留的：渲染层靠"它有没有"判断这份面板是不是摘要版，
   * 是摘要版才去补 `panel:body`。主进程和渲染层对同一个判据，不会各说各话。
   */
  private summarizedPanel(p: Panel): Record<string, unknown> {
    const chat = Array.isArray(p.chat) ? p.chat : [];
    let lastAssistant: ChatMessage | null = null;
    let lastUser: ChatMessage | null = null;
    let lastText = '';
    let lastImage = '';
    for (let i = chat.length - 1; i >= 0; i--) {
      const m = chat[i];
      if (!m) continue;
      if (!lastAssistant && m.role === 'assistant') lastAssistant = m;
      if (!lastUser && m.role === 'user') lastUser = m;
      if (!lastText && typeof m.content === 'string' && m.content.trim() && m.role !== 'system') {
        lastText = m.content;
      }
      // 最新一张图（侧栏那一栏缩略图用）—— 只看最近 20 条，找不到就算了
      if (!lastImage && chat.length - i <= 20) {
        if (Array.isArray((m as any).images) && (m as any).images.length) {
          lastImage = String((m as any).images[(m as any).images.length - 1] || '');
        } else {
          const c = typeof m.content === 'string' ? m.content : '';
          const md = c.match(/!\[.*?\]\((.+?)\)/);
          const ht = md ? null : c.match(/<img [^>]*src=["']([^"']+)["']/i);
          if (md && md[1]) lastImage = md[1].trim();
          else if (ht && ht[1]) lastImage = ht[1].trim();
        }
      }
    }
    // 助手消息 id 只留最近 500 条：够数未读，又不至于把广播撑起来。
    // 留太少会真出问题 —— 用户离开一阵、攒了上百条回信时，账本里那个"已读锚点"
    // 会掉出这个窗口，未读就不显示了（看着像"员工回了我却没提示"）。
    const assistantIds: string[] = [];
    for (let i = chat.length - 1; i >= 0 && assistantIds.length < SUM_IDS_MAX; i--) {
      const m = chat[i];
      if (m && m.role === 'assistant') assistantIds.unshift(String(m.id || ''));
    }
    const skeleton = toSkeleton(p);
    return {
      ...skeleton,
      /** 摘要标记 —— 渲染层据此判断"正文得自己去拉" */
      summary: {
        count: chat.length,
        lastText: lastText.slice(0, 400),
        lastUserText: String(lastUser?.content ?? '').slice(0, 400),
        lastImage,
        assistantIds,
        replyAt: Number(lastAssistant?.createdAt ?? 0) || 0,
        askingAt: Number(lastUser?.createdAt ?? 0) || 0,
      },
    };
  }

  /** 一块面板的**完整正文**（对话 / 压缩存档 / 修订）—— ChatDock 要画对话时按需拉一次 */
  panelFull(id: string): Panel | null {
    return this.ws.panels[id] ?? null;
  }

  /**
   * 这个窗口用哪个模型（`provider::model`）。
   *
   * 顺序：**上一次手动选过的** → 窗口级记录 → 内置默认。
   *
   * "上一次手动选过的"必须排在窗口级前面：现在选模型只落在**会话**上，
   * 窗口级那层已经没有入口了，里面躺着的是很早以前写进去的一个值
   * （往往是内置默认那个）—— 让它挡在前面，新窗口就会每次都变回第一个。
   */
  pickFor(hostKey: HostKey): string {
    return this.lastPickAlive() || this.alive(this.ws.windowModels[hostKey]) || fallbackPick() || '';
  }

  /** 落点还在不在 —— 提供方被删、模型被去掉之后，旧记录就不该再算数 */
  private alive(pick: string | undefined): string {
    return pick && resolvePick(pick) ? pick : '';
  }

  /** 上一次手动选过的那个模型（落点已经没了就当没选过） */
  private lastPickAlive(): string {
    return this.alive(this.ws.lastPick);
  }

  /**
   * 这个**会话**（面板）选的模型。
   *
   * 自己没有记录（新建的、从历史恢复的、记录因提供方被删而失效的）就照**此刻**的
   * 默认值给它钉一条下来。不钉的话这块面板每轮都实时去读全局的 lastPick ——
   * 别的地方一选模型它就跟着换，表现就是"切走再回来，模型被换掉了"。
   */
  pickForPanel(panelId: string): string {
    const mine = this.ws.panelModels?.[panelId];
    if (mine && resolvePick(mine)) return mine;
    const born = this.pickFor(this.hostKeyOf(panelId));
    if (born) this.setPanelModel(panelId, born);
    return born;
  }

  /** 前台给的钥匙：是面板 id 就用会话级，是宿主 key 就用窗口级 */
  pickOf(key: string): string {
    return this.panel(key) ? this.pickForPanel(key) : this.pickFor(key);
  }

  /**
   * 这个会话的思考水平：面板自己设过就用它的，否则跟所在窗口走，都没有就是空串 ——
   * 空串在 chat-core 里等于"一个思考参数都不发"，所以没设过 = 跟从前完全一样。
   */
  thinkFor(key: string): string {
    const mine = this.ws.thinks?.[key];
    if (mine !== undefined) return mine;
    if (this.panel(key)) return this.ws.thinks?.[this.hostKeyOf(key)] ?? '';
    return '';
  }

  /** 改思考水平：传空串就是"恢复默认"，顺手把键删掉，不攒死键 */
  setThinkFor(key: string, level: string) {
    const lv = level === 'off' || level === 'low' || level === 'medium' || level === 'high' ? level : '';
    const next = { ...(this.ws.thinks ?? {}) };
    if (lv) next[key] = lv;
    else delete next[key];
    this.ws = { ...this.ws, thinks: next };
    this.save();
  }

  /**
   * 调用要用的东西：提供方、地址、密钥、模型名。
   * 配置全部来自 harness（settings.yaml + .credentials.yaml），这里只做解析。
   */
  modelFor(hostKey: HostKey): ModelConfig {
    const r = resolvePick(this.pickFor(hostKey));
    return r
      ? { baseUrl: r.baseUrl, apiKey: r.apiKey, model: r.model, provider: r.provider, think: this.thinkFor(hostKey) }
      : { baseUrl: '', apiKey: '', model: '' };
  }

  /** 这一轮要用的东西：按**会话**取，面板自己选的优先 */
  modelForPanel(panelId: string): ModelConfig {
    const r = resolvePick(this.pickForPanel(panelId));
    return r
      ? { baseUrl: r.baseUrl, apiKey: r.apiKey, model: r.model, provider: r.provider, think: this.thinkFor(panelId) }
      : { baseUrl: '', apiKey: '', model: '' };
  }

  /** 改模型：传面板 id 就是只改这个会话，传宿主 key 就是改那个窗口的兜底 */
  setModelFor(key: string, pick: string) {
    if (this.panel(key)) this.setPanelModel(key, pick);
    else this.setWindowModel(key, pick);
    // 手动选中的这个记成"上一次选过的" —— 新窗口 / 新面板没自己选过时照它落点，
    // 不用每次都掉回预设默认。传空串（跟默认）不算选择，不动它。
    if (pick) this.ws = { ...this.ws, lastPick: pick };
    this.save();
  }

  /** 只改这个会话的选择；传空串 = 不单独选，退回窗口级 */
  setPanelModel(panelId: string, pick: string) {
    const next = { ...(this.ws.panelModels ?? {}) };
    if (pick) next[panelId] = pick;
    else delete next[panelId];
    this.ws = { ...this.ws, panelModels: next };
    this.save();
  }

  /** 前台唯一能改的东西：这个窗口用哪个模型（窗口里没单独选过的会话用它） */
  setWindowModel(hostKey: HostKey, pick: string) {
    const next = { ...this.ws.windowModels };
    if (pick) next[hostKey] = pick;
    else delete next[hostKey];
    this.ws = { ...this.ws, windowModels: next };
    this.save();
  }

  /**
   * 打开文件：已经开着就切过去；没开就**新开一个文本面板**（不覆盖手上这个）。
   * 新面板放进"已经有文本面板的那一组"，别跑到文件树那一栏里去。
   */
  openFile(rel: string, text: string) {
    const existing = Object.values(this.ws.panels).find((p) => p.kind === 'editor' && p.file === rel);
    if (existing) {
      existing.spec = { ...existing.spec, text };
      existing.updatedAt = Date.now();
      this.save();
      this.activate(existing.id);
      return;
    }

    // 优先复用那个还没打开任何文件的空文本面板，别在标签栏里堆一个空壳
    // **只认真的空壳**：面板换了用途（读文件）时，对话区、草稿、列宽都会跟着过来 ——
    // 于是"读文件"的面板里躺着上一个会话的对话，打开会话区就看见了别人的工作。
    const blank = Object.values(this.ws.panels).find(
      (p) => p.kind === 'editor' && !p.file && !p.chat?.length && !p.draft,
    );
    if (blank) {
      blank.title = rel.split('/').pop() ?? rel;
      blank.file = rel;
      blank.spec = { ...blank.spec, text };
      blank.updatedAt = Date.now();
      this.save();
      this.activate(blank.id);
      return;
    }

    const editorTab = W.tabGroupsOf(this.ws.layout).find((t) =>
      t.panels.some((id) => this.ws.panels[id]?.kind === 'editor'),
    );
    this.createPanel(
      {
        title: rel.split('/').pop() ?? rel,
        kind: 'editor',
        file: rel,
        look: { ...defaultLook(), showChat: false },
        spec: { ...defaultSpec('editor'), text },
      },
      editorTab ? { where: 'main', tabId: editorTab.id, mode: 'center' } : undefined,
    );
  }

  /**
   * 把冻在文本面板里的那句"读取失败"换成重新读到的内容 —— 换工作区、重启恢复根之后调。
   *
   * 为什么要这一步：没有工作区时 `panel:openFile` 把错误**当文件内容写进了面板**，
   * 而面板内容是持久化的。等工作区选上了，那份快照不会自己过期 —— 于是就成了
   * "我明明选了工作区，为什么还说读取失败"。
   *
   * 只动以"读取失败："开头的：人手写的、还没保存的字一个都不碰。
   */
  refreshFailedFiles(read: (rel: string) => string): number {
    let n = 0;
    for (const p of Object.values(this.ws.panels)) {
      if (p.kind !== 'editor' || !p.file) continue;
      if (!p.spec.text?.startsWith(t('读取失败：'))) continue;
      let text: string;
      try {
        text = read(p.file);
      } catch (e: any) {
        text = `读取失败：${e?.message ?? e}`; // 还是读不了：把最新的真原因写上去，别留旧的
      }
      if (text === p.spec.text) continue;
      p.spec = { ...p.spec, text };
      p.updatedAt = Date.now();
      n++;
    }
    if (n) this.save();
    return n;
  }

  // ------------------------------------------------------------ 技能与插件

  disabledSkills(): string[] {
    return this.ws.disabledSkills ?? [];
  }

  disabledPlugins(): string[] {
    return this.ws.disabledPlugins ?? [];
  }

  /**
   * 完全权限：**按会话**算 —— 问的是这一块面板自己开没开。
   *
   * 以前这是整个工作区一个开关（`ws.fullAccess`），在任何一块面板的输入框上点一下，
   * 所有会话一起变成完全权限。现在权限跟着会话走：一个面板开着，别的照样夹在工作区里。
   */
  panelFullAccess(panelId: string): boolean {
    return Boolean(this.ws.panels[panelId]?.fullAccess);
  }

  /**
   * 插件提供的状态部件。广播时按面板算好，渲染层拿到的是纯文本 ——
   * 插件跑在主进程、画不了界面，所以它只说"该显示什么"，画由核心来。
   */
  private statusOf: (panelId: string) => { id: string; slot: 'composer' | 'head'; text: string; title?: string }[] = () => [];

  setStatusSource(fn: (panelId: string) => { id: string; slot: 'composer' | 'head'; text: string; title?: string }[]) {
    this.statusOf = fn;
  }

  /**
   * 插件注册的斜杠命令（输入框敲 / 时的候选）。广播里只有画弹层要用的字段 ——
   * 执行函数过不了 IPC，也轮不到界面：跑这件事的是主进程的 doSend。
   */
  private commandsOf: () => { id: string; label?: string; hint?: string }[] = () => [];

  setCommandSource(fn: () => { id: string; label?: string; hint?: string }[]) {
    this.commandsOf = fn;
  }

  /**
   * 跑着的那一轮的**实时账**（进行中的累计用量）。
   *
   * 为什么不能等结束再算：那一轮的助手消息要到整轮跑完才进 panel.chat ——
   * 中途面板上一个字都不多，用量也一样。账要是只写在"结束时"那一步，
   * 用户按停时前面已经花掉的 token 就一起归零了。
   *
   * 为什么只活在内存里：一是它随时在变，写盘没意义；二是这个进程重启自己是
   * 强杀，落过盘的"进行中"会永远挂在那儿，看着像还在跑。
   */
  private live = new Map<string, ChatStats>();

  setLiveStats(panelId: string, stats: ChatStats | null) {
    if (stats) this.live.set(panelId, stats);
    else this.live.delete(panelId);
  }

  liveStats(panelId: string): ChatStats | null {
    return this.live.get(panelId) ?? null;
  }

  /**
   * 跑着的那一轮的**正文** —— 就是那条还没进 `chat` 的助手消息本身（存引用，内容一直在变）。
   *
   * 跟实时账同一个理由：助手那条要到整轮跑完才进 `panel.chat`，插件光看 chat 就永远
   * 只能"跑完了才拿到全文"。插件要做流式（eschat 的员工对话"有多少转多少"）就得看得见它。
   * 同样只在内存里：随时在变，落盘没意义，而且重启是强杀，落过的"进行中"会永远挂着。
   */
  private liveTurns = new Map<string, ChatMessage>();

  setLiveTurn(panelId: string, msg: ChatMessage | null) {
    if (msg) this.liveTurns.set(panelId, msg);
    else this.liveTurns.delete(panelId);
  }

  liveTurn(panelId: string): ChatMessage | null {
    return this.liveTurns.get(panelId) ?? null;
  }

  /** 工作模式：**按会话**算 —— 不写 = auto（自主），跟完全权限同一个道理 */
  panelMode(panelId: string): PanelMode {
    return this.ws.panels[panelId]?.mode ?? 'auto';
  }

  /** 改**某一个会话**的工作模式 —— 落在面板上、跟着面板走，别的会话照旧 */
  setPanelMode(panelId: string, mode: PanelMode) {
    const p = this.ws.panels[panelId];
    if (!p) return;
    p.mode = mode;
    p.updatedAt = Date.now();
    this.save();
  }

  /** 改**某一个会话**的完全权限 —— 落在这个面板上，不动别的会话 */
  setPanelFullAccess(panelId: string, on: boolean) {
    const p = this.ws.panels[panelId];
    if (!p) return;
    p.fullAccess = Boolean(on);
    p.updatedAt = Date.now();
    this.save();
  }

  /** 开/关一个技能或插件。「开」就是把名字从禁用名单里拿掉。 */
  setDisabled(kind: 'skill' | 'plugin', name: string, on: boolean) {
    const cur = kind === 'skill' ? this.ws.disabledSkills ?? [] : this.ws.disabledPlugins ?? [];
    const next = new Set(cur);
    if (on) next.delete(name);
    else next.add(name);
    const list = [...next];
    this.ws =
      kind === 'skill' ? { ...this.ws, disabledSkills: list } : { ...this.ws, disabledPlugins: list };
    this.save();
  }

  /**
   * 换工作区根目录。顺带记进"最近开过" —— 一个工作区就是一个长期目录，
   * 下次还得能一键切回来，不能只记得最后一个。
   */
  setWorkspaceRoot(dir: string) {
    if (!dir) return;
    const recent = [dir, ...(this.ws.recentWorkspaces ?? []).filter((d) => d !== dir)].slice(0, 8);
    this.ws = { ...this.ws, workspace: dir, recentWorkspaces: recent };
    // 人当场下的一个决定，立刻落盘：save() 排的是 250ms 防抖，而"刚换完就重启"
    // （重启自己那条路是 taskkill /F）正好能落在这个窗口里 —— 改动随进程一起静默
    // 消失，下次打开还是旧目录，表现就是"我明明换了，怎么改都改不过去"。
    // 下面那句 save() 留着无害：250ms 后写的是同一份状态。
    this.flushNow();
    this.save();
  }

  /**
   * 工作区根**真正换好之后**该做的事（fsapi 那个根是外面设的，这儿只是被通知一声）：
   * 老的单文件拆成一件一件、还留在本体里的做法搬出来、开着的组件同步一遍。
   *
   * 为什么不挂在 setWorkspaceRoot 里顺手做：那会儿 fsapi 的根还是**上一个**工作区，
   * 照 workspaceRoot() 拼出来的路径会写进别人家去。启动那条路更干脆 ——
   * store.load() 之后没有任何人调 setWorkspaceRoot，挂在它上面等于这件事永不发生。
   */
  syncCraftFiles() {
    this.migrateLegacyCrafts();
    this.migrateStowCrafts();
    this.syncCrafts();
  }

  /** 面板此刻住在哪个窗口里 —— 决定了它的对话用哪套 api */
  hostKeyOf(panelId: string): HostKey {
    const at = W.findPanel(this.ws, panelId);
    if (!at) return MAIN_HOST;
    return at.where === 'main' ? MAIN_HOST : at.windowId;
  }

  set(next: WorkspaceFull) {
    this.ws = next;
    this.save();
  }

  // ---------------------------------------------------------------- 面板

  // ---------------------------------------------------------------- 收纳区与历史

  /**
   * **组件库全表** —— 索引，启动和每次收纳/关闭回存/删除之后由目录重建（打开不动条目）。
   *
   * **开着的组件也在册**：有声明的那块面板（`Panel.component`）按定义就住在组件区，它这一刻还没关过、
   * 没有本体文件，就按内存里那份生成一条（file 空着，界面认得出这是"开着"）。
   * "组件关不关都在库里"说的就是这件事。
   *
   * 每条带 `pinned`：**顶上那条收纳区只画 `pinned` 的** ——
   * 声明 = 进库、被永久保存；钉住 = 同时占顶上一格。两件事，互不代替。
   */
  /**
   * 设置 → 组件 这一页的**两处来源**：各在哪个目录、各查到几条。
   *
   * 为什么要这个：这一页空着的时候，光说"还没有组件"等于什么都没说 ——
   * 分不清是"本机一份本体都没有"（换台机器刚 clone 下来就是这样），
   * 还是"工作区里那几份做法也没读到"（多半是工作区指错了地方）。
   * 把路径和条数摊在界面上，一眼就看得出来。
   */
  componentDirs(): { bodyDir: string; bodyCount: number; craftDir: string; craftCount: number } {
    let bodyCount = 0;
    try {
      bodyCount = fs.readdirSync(stowDir()).filter((f) => f.endsWith('.json')).length;
    } catch {
      /* 目录还没生出来（一个组件都没声明过）—— 那就是 0 条 */
    }
    return {
      bodyDir: stowDir(),
      bodyCount,
      craftDir: craftDir(),
      craftCount: readCrafts().filter((it) => it.source === 'ws').length,
    };
  }

  componentRefs(): ComponentRef[] {
    const live: ComponentRef[] = Object.values(this.ws.panels)
      .filter((p) => isComponentPanel(p) && !fs.existsSync(stowFile(p.id)))
      .map((p) => ({ id: p.id, name: p.title, kind: p.kind, component: p.component, pinned: !!p.pinned, savedAt: p.updatedAt ?? 0, bytes: 0, file: '' }));
    const base = this.sortRefsByOrder(live.length ? [...this.stows, ...live] : this.stows);

    // 这台机器上没有本体、但工作区里有那份做法的，**也照着列出来** —— 这一页是一张全表，
    // 不该因为"本体只在这台机器上"就在别的机器上显示成空的。做法跟着仓库走，
    // 所以换台机器 clone 下来，这一页照样列着那几套（条目标 `craftOnly`，界面照它换按钮）。
    const haveId = new Set(base.map((c) => String(c.id)));
    const haveName = new Set(base.map((c) => String(c.component || c.name || '')));
    const only: ComponentRef[] = [];
    for (const it of readCrafts()) {
      const id = String(it.panel || '').trim();
      const name = String(it.name || it.title || id).trim();
      if (!id || !name || haveId.has(id) || haveName.has(name)) continue;
      let bytes = 0;
      try {
        bytes = fs.statSync(it.craftPath).size;
      } catch {
        /* 拿不到大小就显示 0，不影响列出来 */
      }
      only.push({
        id,
        name,
        kind: (it.kind || 'chat') as PanelKind,
        component: name,
        pinned: false,
        savedAt: Number(it.at) || 0,
        bytes,
        file: '',
        craftOnly: true,
        craftFile: `${safeCraftId(id)}.json`,
      });
    }

    // **就这两处**。「历史会话」里那几百个关掉的面板**不往这儿倒** ——
    // 那是历史，不是组件，倒上来只会把这一页淹掉（真这么干过，被骂回来了）。要看历史去左边那页。
    return [...base, ...only];
  }

  componentCrafts(): unknown[] {
    return readCrafts().map((it) => {
      const { craftPath, ...craft } = it;
      return { ...craft, id: craftOwner(it) };
    });
  }

  /**
   * 扫一遍 `components/` 目录，重建收纳区索引。
   *
   * 目录本身就是真相 —— 和「最近关闭」同一套理由：索引要是写进 workspace.json，
   * 从备份恢复主文件时就会和文件对不上（这事真撞过一次）。
   *
   * 列条目只需要名字、类型和大小，它们在 JSON 最前面几个字段里（文件最顶上就是 id、title、kind），
   * 所以只读文件头 4KB 去抠 —— 不为一条列表把整段对话读进来。
   */
  private rebuildStows() {
    let files: string[] = [];
    try {
      files = fs.readdirSync(stowDir()).filter((f) => f.endsWith('.json'));
    } catch {
      this.stows = [];
      return;
    }

    const out: ComponentRef[] = [];
    for (const f of files) {
      const full = path.join(stowDir(), f);
      let head = '';
      try {
        const fd = fs.openSync(full, 'r');
        const buf = Buffer.alloc(4096);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        head = buf.subarray(0, n).toString('utf8');
      } catch {
        continue;
      }

      const id = f.replace(/\.json$/, '');
      let name = id;
      let kind = 'chat';
      const tm = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
      if (tm) {
        try {
          name = JSON.parse(`"${tm[1]}"`);
        } catch {
          name = tm[1];
        }
      }
      const km = /"kind"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
      if (km) kind = km[1];

      let savedAt = 0;
      let bytes = 0;
      try {
        const st = fs.statSync(full);
        savedAt = st.mtimeMs;
        bytes = st.size;
      } catch {
        /* 读不到就排最后 */
      }
      // **只收声明过的**，而且是**真组件**：声明（"component"）写在文件最前面，
      // 看文件头就认得出来；员工工作面（"noWorkspacePrompt"）哪怕带着声明也不算 ——
      // 他是个人，该在 设置 → 员工 里管（见 shared/types 的 isComponentPanel）。
      // 没声明的一律不算组件 —— 它们该在「历史会话」里（启动时的 pruneUnclaimedStows 会搬过去）。
      if (!/"component"\s*:\s*"[^"]*"/.test(head)) continue;
      if (isAgentHead(head)) continue;

      const cm = /"component"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
      let component = '';
      if (cm) {
        try {
          component = JSON.parse(`"${cm[1]}"`);
        } catch {
          component = cm[1];
        }
      }

      // 钉在顶上那条没有 —— 写在声明后面几个字段里，同样看文件头就认得出来
      const pinned = /"pinned"\s*:\s*true/.test(head);

      out.push({ id, name, kind: kind as PanelKind, component, pinned, savedAt, bytes, file: f });
    }

    // 依 componentOrder 排序：保持用户手动排序，并且在使用（打开/关闭/聊天）和释放后不会自动乱跳
    this.stows = this.sortRefsByOrder(out);
    this.syncComponentOrderWithStows();
  }

  /** 按 componentOrder 对组件进行排序：已在列表里的按指定顺序，未见过的排在后面 */
  private sortRefsByOrder(list: ComponentRef[]): ComponentRef[] {
    const order = this.ws.componentOrder;
    if (!order || !order.length) {
      return [...list].sort((a, b) => a.savedAt - b.savedAt);
    }
    const map = new Map<string, number>();
    order.forEach((id, idx) => map.set(id, idx));
    return [...list].sort((a, b) => {
      const ia = map.has(a.id) ? map.get(a.id)! : 999999;
      const ib = map.has(b.id) ? map.get(b.id)! : 999999;
      if (ia !== ib) return ia - ib;
      return a.savedAt - b.savedAt;
    });
  }

  /** 确保 componentOrder 包含当前所有组件，且不留死 id */
  private syncComponentOrderWithStows() {
    const current = this.ws.componentOrder ?? [];
    const validIds = new Set(this.stows.map((s) => s.id));
    for (const p of Object.values(this.ws.panels)) {
      if (isComponentPanel(p)) validIds.add(p.id);
    }
    const next: string[] = [];
    for (const id of current) {
      if (validIds.has(id) && !next.includes(id)) {
        next.push(id);
      }
    }
    for (const s of this.stows) {
      if (!next.includes(s.id)) {
        next.push(s.id);
      }
    }
    this.ws = { ...this.ws, componentOrder: next };
  }

  /**
   * 手动对收纳区组件重新排序（支持拖拽排序）
   * @param orderIds 排序后的 id 列表（可以是顶栏 pinned 的列表，也可以是全量列表）
   */
  reorderComponents(orderIds: string[]): boolean {
    if (!Array.isArray(orderIds) || !orderIds.length) return false;
    const current = this.ws.componentOrder ?? this.stows.map((s) => s.id);
    const orderSet = new Set(orderIds);
    let orderIdx = 0;
    const next: string[] = [];
    for (const id of current) {
      if (orderSet.has(id)) {
        if (orderIdx < orderIds.length) {
          next.push(orderIds[orderIdx++]);
        }
      } else {
        next.push(id);
      }
    }
    for (; orderIdx < orderIds.length; orderIdx++) {
      if (!next.includes(orderIds[orderIdx])) {
        next.push(orderIds[orderIdx]);
      }
    }
    this.ws = { ...this.ws, componentOrder: next };
    this.stows = this.sortRefsByOrder(this.stows);
    this.save();
    return true;
  }

  /**
   * 把一个面板**收进**收纳区（顶上那条）。
   *
   * 收的不是"这种做法"，而是**这个面板本身**：对话、草稿、修订、状态整块搬进
   * `components/<id>.json`，布局里把它摘掉。所以之后从收纳区拖出来不是复制一个，
   * 是把同一个面板放回去 —— 那段对话接着往下走（面板 id 也一直没变）。
   *
   * 条目是**持久入口**：打开它不会把条目吃掉（文件一直留着），面板开着时入口点亮，
   * 关闭时状态回存回这份文件 —— 少一条只可能是用户在设置里手动删的。
   *
   * 文件**先写、写成了才动布局**：存档失败就原地不动，宁可收不进去也不能把面板弄丢。
   *
   * 一次收**一批**（见 stowPanels）：一个面板也是"一批里的一件"，
   * 两处的存档与撤出必须走同一段代码 —— 各写一份，早晚会有一边漏掉 prune 或 rebind。
   */
  stowPanels(
    panelIds: string[],
    targetIndex?: number,
    /** 面板 → 它在收纳区里叫什么。不给就用它自己的声明名 / 标题 */
    nameFor?: (p: Panel) => string,
  ): ComponentRef[] {
    const picked: Panel[] = [];
    for (const id of panelIds) {
      const p = this.ws.panels[id];
      if (!p) continue;
      /*
       * 这一轮还在跑的面板**留在布局里**，整批就这么收 —— 半批收走更糟：
       * doSend 手里抓的是这些面板对象，跑完那条消息要写回它，收走了那一轮就丢了。
       * 留下的那些还在原来的窗口里，用户看得见，跑完再拖一次就行。
       */
      if (p.status === 'working') continue;
      picked.push(p);
    }
    if (!picked.length) return [];

    /*
     * 先全部落盘，写成一件算一件。
     *
     * 写道具**只写文件、不动布局**（见 writeStow）—— 这是"存档失败就原地不动"那条规矩的
     * 落点：中途失败时，已经写进组件目录的那几件是**好事**（它们在设置 → 组件里多一条
     * 入口，内容一字没丢），真正不能出的是"文件没写成、布局里却把它摘走了"。
     */
    const saved: Panel[] = [];
    for (const p of picked) {
      // 拖到收纳区 = **声明 + 钉住**（还没声明的按这次给的名字声明）——
      // 声明写在最前面，列条目只读文件头就认得出来。已经有名字的不改名。
      const given = (nameFor?.(p) ?? '').trim();
      const name = given || p.component || p.title;
      const body: Panel = { ...p, title: name, component: p.component || name };
      try {
        writeStow(p.id, body, true);
        saved.push(p);
      } catch (e) {
        console.error('[收纳] 存档失败，这一件留在布局里：', p.id, e);
      }
    }
    if (!saved.length) return [];

    // 存档全成了，才一次性把它们从各处摘掉 —— 跟单个收一样，先删面板再摘布局
    let next = this.ws;
    for (const p of saved) {
      delete next.panels[p.id];
      // 收进收纳区 = 本体已经落到 components/<id>.json，这份正文文件跟着收掉
      this.bodyCache.delete(p.id);
      try {
        fs.unlinkSync(bodyFile(p.id));
      } catch {
        /* 文件本来就不在就算了 */
      }
      next = W.removeEverywhere(next, p.id);
    }
    next.layout = W.pruneEmptyTabs(next.layout);
    next.floating = next.floating
      .map((w) => ({ ...w, root: W.pruneEmptyTabs(w.root) }))
      /*
       * 空浮窗当回收，规则和 cleanup 那条一模一样 —— 但**正在拿着这一拖的那扇源窗口除外**：
       * 面板被拖到收纳区上时，源窗口这会儿正好是空的，把它从状态里抹掉，主进程那边
       * 会顺手把真窗口也销毁，而那条链路上可能还按着指针（见 keepEmpty 那段说明）。
       * 松手之后由 reapEmptyWindows 统一清记号、统一回收。
       */
      .filter((w) => w.id === this.keepEmpty || W.tabGroupsOf(w.root).some((t) => t.panels.length > 0));
    this.ws = next;
    this.rehomeOrphans();
    this.rehomeFloats();
    // panelModels 故意留着：面板 id 没变，它自己选的模型等它回来还跟着它。
    // publicState 只给"在布局里"的面板发模型，所以不会漏出死键。
    this.rebuildStows();
    if (typeof targetIndex === 'number' && Number.isFinite(targetIndex)) {
      const ids = saved.map((p) => p.id);
      const pinned = this.stows.filter((s) => s.pinned).map((s) => s.id).filter((id) => !ids.includes(id));
      const at = Math.max(0, Math.min(targetIndex, pinned.length));
      pinned.splice(at, 0, ...ids);
      this.reorderComponents(pinned);
    }
    this.save();
    const keep = new Set(saved.map((p) => p.id));
    return this.stows.filter((s) => keep.has(s.id));
  }

  /**
   * 把**整个标签组**收进收纳区：组里每个面板各收一件（见 stowPanels）。
   *
   * 一组标签没有"本体"，但那一组里的每个面板都有 —— 逐个收进去就是"整组一起收起来"。
   * 返回真的收了几件（0 = 一件都没收成，界面上别装作收成功了）。
   */
  stowTabGroup(tabId: string, windowId?: string, targetIndex?: number): number {
    const root = windowId
      ? (this.ws.floating.find((w) => w.id === windowId)?.root ?? null)
      : this.ws.layout;
    const tab = root ? W.tabById(root, tabId) : null;
    if (!tab || !tab.panels.length) return 0;
    return this.stowPanels([...tab.panels], targetIndex).length;
  }

  /**
   * 把一个面板收进收纳区 —— 就是"一批"的那一件（见 stowPanels）。
   * 名字和插位都跟着走，返回这一条（收不进去时 null）。
   */
  stowPanel(panelId: string, name?: string, targetIndex?: number): ComponentRef | null {
    const given = (name ?? '').trim();
    const [ref] = this.stowPanels([panelId], targetIndex, () => given);
    return ref ?? null;
  }

  /**
   * 从组件库里删掉一条 —— 这是**真删**：连它那份对话记录一起没，
   * 跟「最近关闭」的"彻底删除"一个性质，所以入口处必须先确认。
   *
   * 这是条目唯一的减少途径，而且只从**设置 → 收纳区**进来（条上不放删除键）——
   * 软件自己永远不会替用户清掉一条入口或一段记录。
   *
   * 删的是**这一条**（它自己的本体，外加面板上那行声明）；克隆出来的别的实例各是各的文件，
   * 不受影响 —— 只想从顶栏把那一条撤下来、不删内容的话，用 `unpinComponent`。
   */
  removeComponent(id: string) {
    // 面板还开着的话，连声明一起撤掉 —— 不然它下次关闭又回存回来，等于删不掉。
    // 钉住的标记也得一起摘：留着它顶上那条还会画一个已经不在库里的入口。
    const live = this.ws.panels[id];
    if (live) {
      delete live.component;
      delete live.pinned;
      live.updatedAt = Date.now();
    }
    this.dropStowFile(id);
    dropCraft(id); // 撤销了组件，那条做法跟着摘掉（只摘这一条，别人提交的一个不动）
    if (this.ws.componentOrder) {
      this.ws.componentOrder = this.ws.componentOrder.filter((x) => x !== id);
    }
    this.rebuildStows();
    // 记录真没了，这个面板只可能再也回不来 → 它私有的临时产物一起收掉。
    // 还开着的就不动：删的是那条入口或那份记录，对话里仍留着指向那些文件的字。
    if (!this.ws.panels[id]) dropPanelSpace(id);
    this.save();
  }

  /**
   * 把一条组件**打成一个文件** —— 带走的是**这块面板的做法**（类型、外观、提示词、按钮）。
   *
   * **对话不进这个文件**：那段对话是这台机器上的工作记录，跟人、跟这个项目绑着，
   * 对方拿去也用不上；真带出去反而是一份不知道从哪儿来的私聊记录躺在别人仓库里。
   * 要送人的组件，送的是"怎么做"，不是"我们聊过什么"。
   * chat / revisions 留在字段里但一律是空的 —— 老版本的导出文件也长这样，
   * 导进去那边照样能读（读到的就是"只有做法"的一版）。
   */
  exportComponent(id: string): { name: string; json: string } | null {
    const body = this.panelBody(id);
    if (!body) return null;
    const full = this.withCraft(body); // 做法合回来（本体里可能只留了 text）
    const name = String(full.component || full.title || '').trim() || t('未命名组件');
    const pack = {
      ensoul: 1,
      kind: 'component',
      exportedAt: Date.now(),
      component: {
        name,
        title: full.title || name,
        panelKind: full.kind,
        look: full.look ?? {},
        spec: full.spec ?? {},
        chat: [],
        revisions: [],
      },
    };
    return { name, json: JSON.stringify(pack, null, 2) + '\n' };
  }

  /**
   * 导入一个组件文件 —— 变成 设置 → 组件 里的一条。
   *
   * 为什么给**新面板 id**、不沿用文件里那个：id 是"这台机器上哪一块面板"的身份证，
   * 同一个文件导两次、沿用原 id，就会两个本体抢一个身份。名字照原样留着 —— 那才是给人认的。
   */
  importComponent(raw: any): ComponentRef | null {
    const c = raw && typeof raw === 'object' ? (raw as { component?: any }).component : null;
    if (!c || typeof c !== 'object') return null;
    const name = String(c.name || c.title || '').trim().slice(0, 60);
    if (!name) return null;
    const kind = String(c.panelKind || c.kind || 'chat') as PanelKind;
    const id = W.newId('panel');
    const now = Date.now();
    const panel = {
      id,
      title: String(c.title || name).slice(0, 80) || name,
      kind,
      look: { ...defaultLook(), ...(c.look && typeof c.look === 'object' ? c.look : {}) },
      spec: { ...defaultSpec(kind), ...(c.spec && typeof c.spec === 'object' ? c.spec : {}) },
      component: name,
      chat: Array.isArray(c.chat) ? c.chat : [],
      revisions: [],
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    } as unknown as Panel;
    try {
      writeStow(id, panel, false); // 顺手把做法写进工作区那份（writeStow 里做的事）
    } catch (e) {
      console.error('[组件] 导入写本体失败：', e);
      return null;
    }
    this.rebuildStows();
    this.save();
    return this.stows.find((s) => s.id === id) ?? null;
  }

  /**
   * 把"这一刻开着的组件"的做法同步进那份可分发文件。
   *
   * 落在 flush 上：做法是面板自己的字段（改提示词、加按钮、换配色都改它），
   * 而每次改动都会排一次保存 —— 同步挂在同一个落盘点，就不用到处埋调用点，
   * 也不会出现"哪儿漏了一处、做法悄悄停在旧版本"。做法没变时它不写盘（putCraft 里判了）。
   */
  private syncCrafts() {
    try {
      if (!workspaceRoot()) return;
      for (const p of Object.values(this.ws.panels)) {
        if (isComponentPanel(p)) putCraft(p);
      }
    } catch (e) {
      console.error('[做法] 同步失败：', e);
    }
  }

  /**
   * 老版本把**所有**做法挤在一份 `.ensoul/library/presets.json` 里 —— 那份文件必须拆开，
   * 不拆的话"两个人各发布一个组件"照样会撞在同一份文件上（这正是要改掉的东西）。
   *
   * 拆的顺序：一件一件写进 `components/`，**全都落下来了才**把老文件改名收起来。
   * 有一件没落地就先别动老文件，下次启动接着拆 —— 老文件只是改名，后悔药留着。
   */
  private migrateLegacyCrafts() {
    if (!workspaceRoot()) return;
    const legacy = legacyCraftFile();
    if (!fs.existsSync(legacy)) return;
    const items = readLegacyCrafts();
    for (const it of items) {
      const owner = craftOwner(it);
      if (!owner || !it.name || (!it.look && !it.spec)) continue;
      putCraft({
        id: owner,
        component: it.name,
        kind: it.kind,
        title: it.title,
        look: it.look,
        spec: it.spec,
      } as Panel);
      if (!fs.existsSync(craftFileOf(owner))) return; // 没落下来：先别动老文件
    }
    try {
      fs.renameSync(legacy, `${legacy}.migrated`);
      console.log(`[做法] 老的单文件已拆成一件一件（${items.length} 件），原文件改名成 presets.json.migrated 留着`);
    } catch (e) {
      console.error('[做法] 老文件收不走（内容已经拆好了）：', e);
    }
  }

  /**
   * 把还留在老的组件本体里的做法搬出来（早期版本做法和对话是装在一个文件里的）。
   *
   * 搬的顺序：先写进它自己那件文件，**确认真落好了才**重写本体把做法摘掉 ——
   * 摘早了、没写成功，那份做法就两头都没有了。
   * putCraft 返回"磁盘上现在是对的"，所以"本来就一样、没重写"也算落好了。
   * 只搬**还带做法**的本体（没有就说明搬过了）：所以这件事一台机器上每个组件只做一次。
   */
  private migrateStowCrafts() {
    if (!workspaceRoot()) return;
    let files: string[] = [];
    try {
      files = fs.readdirSync(stowDir()).filter((f) => f.endsWith('.json'));
    } catch {
      return; // 一个组件都没有：没什么可搬的
    }
    for (const f of files) {
      const full = path.join(stowDir(), f);
      try {
        // 先看文件头：不是组件（普通面板、员工工作面）就别读了 —— 里面可能是十几万字
        if (!/"component"\s*:\s*"[^"]*"/.test(readHead(full))) continue;
        const raw = JSON.parse(readTextFile(full)) as Panel;
        if (!raw || !hasCraft(raw)) continue; // 搬过了（本体里只剩 text）
        if (!isComponentPanel(raw)) continue;
        const id = String(raw.id || f.replace(/\.json$/, ''));
        // 正开着的先跳过：存档里的做法可能比面板上这份旧，别拿旧的把它盖回去
        if (this.ws.panels[id]) continue;
        if (!putCraft({ ...raw, id })) continue; // 没写成，本体原样留着，下次启动接着搬
        writeStow(id, { ...raw, id }, !!raw.pinned); // 这次写进去时做法会被摘掉
        console.log(`[做法] 把「${raw.component}」的做法从本体搬进了可分发文件（本体只剩对话）`);
      } catch (e) {
        console.error('[做法] 搬家失败（本体没动）：', f, e);
      }
    }
  }

  private dropStowFile(id: string) {
    try {
      fs.unlinkSync(stowFile(id));
    } catch {
      /* 文件本来就不在就算了 */
    }
  }

  /**
   * 给一块面板写下**组件声明** —— 面板算不算组件，只看有没有这一下（`isComponentPanel`）。
   *
   * 声明时顺手把本体写一份进 `components/<id>.json`：声明就是这个意思 ——
   * 从这一刻起它**被永久保存**，关不关都在架子上，本体一直在，只有用户在设置里点删除才会没。
   * **面板不从这里消失**（它多半正开着）：声明只是给它安了个家，接着用、接着关都不影响。
   * **也不进顶上那条收纳区** —— 那是 `pinned` 的事，得用户自己拖上去（或点「收进收纳区」）。
   */
  declareComponent(panelId: string, name?: string): ComponentRef | null {
    const live = this.ws.panels[panelId];
    const p = live;
    if (!p) return null;
    // 员工工作面不算组件（他是个人，不是可复用的做法）—— 不给它写声明，
    // 落点也就不在 设置 → 组件 那张架子上。他的名册由 dispatch 在 设置 → 员工 里管。
    if (p.noWorkspacePrompt) return null;

    const id = String(panelId || p.id);
    const declared = (name ?? '').trim().slice(0, 60) || p.component || p.title;
    p.component = declared;
    p.updatedAt = Date.now();

    // 声明写在最前面 —— 列条目只读文件头，认的就是这个字段
    const body: Panel = { ...p, id, component: declared };
    try {
      writeStow(id, body, !!p.pinned);
    } catch (e) {
      console.error('[组件] 声明后写本体失败：', e);
      return null;
    }

    // 声明 = 这份做法从此可分发：顺手写进工作区那份文件（对话不进，它在本体里）
    putCraft({ ...p, id });

    this.rebuildStows();
    this.save();
    return this.stows.find((s) => s.id === id) ?? null;
  }

  /**
   * **给一条组件改名** —— 声明名和面板标题**一起**改。
   *
   * 两处都得落：声明名写在文件头（列条目靠它认"这条是不是组件"），
   * 而设置里那一行显示的是**标题**（`componentRefs` 读的就是它）——
   * 只改一处就成了"清单上是新名字、打开还是旧名字"。
   * 做法文件那半跟着改（writeStow 顺手做）：换台机器 clone 下来看到的就是新名字。
   *
   * 这台机器上没有本体、只有工作区那份做法的（`craftOnly` 那几条），改的就是那一份。
   */
  renameComponent(id: string, name: string): boolean {
    const panelId = String(id || '');
    const next = String(name || '').trim().slice(0, 60);
    if (!panelId || !next) return false;

    const live = this.ws.panels[panelId];
    const file = stowFile(panelId);
    const hasBody = fs.existsSync(file);

    if (live) {
      live.component = next;
      live.title = next;
      live.updatedAt = Date.now();
    }

    if (live || hasBody) {
      let body: Panel;
      try {
        body = live ?? (JSON.parse(readTextFile(file)) as Panel);
      } catch {
        return false;
      }
      try {
        writeStow(panelId, { ...body, component: next, title: next }, !!body.pinned);
      } catch (e) {
        console.error('[组件] 改名写本体失败：', e);
        return false;
      }
    } else {
      const cf = craftFileOf(panelId);
      try {
        const cur = JSON.parse(readTextFile(cf));
        fs.writeFileSync(cf, JSON.stringify({ ...cur, name: next, title: next }, null, 2) + '\n', 'utf8');
      } catch (e) {
        console.error('[组件] 改名写做法失败：', e);
        return false;
      }
    }

    this.rebuildStows();
    this.save();
    return true;
  }

  /**
   * **释放**一条：把它从顶上那条收纳区**撤下来**，别的什么都不动。
   *
   * 跟"删除"是两回事：本体（对话、草稿、状态）一个字不丢，组件库里那一条照旧在、
   * 照样能打开 —— 只是不再占顶上一格。
   * 这就是"收纳区的条目放不掉、只能把组件整个删掉"那个缺口的补法。
   */
  unpinComponent(id: string): boolean {
    const live = this.ws.panels[id];
    if (!live && !fs.existsSync(stowFile(id))) return false;
    if (live) {
      delete live.pinned;
      live.updatedAt = Date.now();
    }
    // 本体文件里也摘掉那个标记：不摘的话下次列条目又把它认成钉住的
    try {
      const raw = JSON.parse(readTextFile(stowFile(id))) as Panel;
      if (raw && raw.pinned) writeStow(id, raw, false);
    } catch {
      /* 没文件（还开着的组件本来就没有）就算了 */
    }
    this.rebuildStows();
    this.save();
    return true;
  }

  /**
   * **收进收纳区**：把库里的一条钉到顶上那条，条上就有它的入口。
   *
   * 跟"打开"不一样：面板开不开都行 —— 关着的就把本体文件里的标记写上，
   * 开着的连内存那份一起标。本体内容一个字不动。
   */
  pinComponent(id: string): boolean {
    const live = this.ws.panels[id];
    if (!live && !fs.existsSync(stowFile(id))) return false;
    if (live) {
      live.pinned = true;
      live.updatedAt = Date.now();
    }
    try {
      const raw = JSON.parse(readTextFile(stowFile(id))) as Panel;
      if (raw && !raw.pinned) writeStow(id, raw, true);
    } catch {
      /* 没文件（还开着的组件本来就没有）就算了 */
    }
    this.rebuildStows();
    this.save();
    return true;
  }

  /**
   * **克隆**一条组件：照它这一刻的样子**再开一块新的**（新 id、新的对话线程），
   * 原件一个字节不动。
   *
   * "组件可以实例化很多个新的出来"说的就是这一步：克隆出来的是同一个案例的**另一个实例**，
   * 带着声明（所以它也在组件库里、也被永久保存），但**不跟着钉住** ——
   * 想让它也挂在顶栏，自己拖上去。两份从此各聊各的。
   */
  cloneComponent(id: string, target?: DockTarget, index?: number): Panel | null {
    const src = this.panelBody(id);
    if (!src) return null;
    const now = Date.now();
    const copy: Panel = {
      ...src,
      id: W.newId('panel'),
      // 对话整份深拷一份：两份从此互不相干，改一边不会动到另一边
      chat: JSON.parse(JSON.stringify(src.chat ?? [])),
      revisions: [],
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    };
    delete copy.float;
    delete copy.pinned; // 钉住是"那一个"的事，克隆出来的自己决定
    this.ws.panels[copy.id] = copy;
    const where: DockTarget = target ?? { where: 'main', tabId: W.firstTabGroup(this.ws.layout).id, mode: 'center' };
    this.ws = W.dockPanel(this.ws, copy.id, where, index);
    this.save();
    return copy;
  }

  /** 取一条组件的本体：开着就用内存里那份，没开就读它的存档（克隆要用） */
  private panelBody(id: string): Panel | null {
    const live = this.ws.panels[id];
    if (live) return live;
    try {
      const raw = JSON.parse(readTextFile(stowFile(id))) as Panel;
      if (raw && Array.isArray(raw.chat)) return this.withCraft({ ...raw, id });
    } catch {
      /* 读不到就当没有 */
    }
    return null;
  }

  /**
   * 把做法合回一份从存档读出来的本体。
   *
   * 做法住在那份可分发文件里（本体只留对话），所以还原时必须合一下 ——
   * 少了这一步，从架子打开一个组件就是一块没有提示词、配色也回默认的空面板，
   * 而且**不报任何错**。两份都缺时退回该类型的默认做法（面板起码能用）。
   */
  private withCraft(raw: Panel): Panel {
    const craft = craftOf(raw.id);
    // 本体里只留了 text（做法搬走时摘掉的），合回来时单独补上
    const kept = ((raw.spec || {}) as unknown as Record<string, unknown>).text;
    const spec: Record<string, unknown> = {
      ...((defaultSpec(raw.kind) || {}) as unknown as Record<string, unknown>),
      ...(((craft?.spec || {}) as unknown) as Record<string, unknown>),
    };
    if (kept !== undefined) spec.text = kept;
    return {
      ...raw,
      look: { ...defaultLook(), ...((craft?.look || raw.look || {}) as Panel['look']) },
      spec: spec as unknown as Panel['spec'],
    };
  }

  /** 收纳区上最多摆几个（超出的收进「»」下拉）。别让人填出 0，最少留 1 个 */
  componentBarMax(): number {
    const n = this.ws.componentBarMax;
    return typeof n === 'number' && Number.isFinite(n) && n >= 1
      ? Math.min(60, Math.round(n))
      : DEFAULT_COMPONENT_BAR_MAX;
  }

  setComponentBarMax(n: number) {
    this.ws = { ...this.ws, componentBarMax: Math.max(1, Math.min(60, Math.round(Number(n) || DEFAULT_COMPONENT_BAR_MAX))) };
    this.save();
  }

  /**
   * 从收纳区**打开**一个面板 —— 入口是**持久的**，打开不消费条目。
   *
   *   · 面板已经开着 → 没给 target 就切到它（activate），给了 target 就把**同一个面板**
   *     挪到那儿。绝不再读一份存档盖上去 —— 那会把正在聊的对话换成旧快照。
   *   · 没开着 → 读 `components/<id>.json` 放回布局。**文件留着**：条目还在，
   *     关闭时（closePanel）状态会回存回这份文件，记录不因"打开过"少一个字。
   *
   * 不是"照它造一个"：id、对话、草稿、修订、模型选择都是原来那份。
   * 给了 target 就放在那儿（条目拖到布局里松手用的就是它）；
   * 没给就还是老路：放进主窗口第一组标签。
   */
  openComponent(id: string, target?: DockTarget, index?: number): Panel | null {
    const live = this.ws.panels[id];
    if (live) {
      if (target) this.dock(id, target, index); // dock 自己会 save
      this.activate(id);
      return live;
    }

    let raw: Panel | null = null;
    try {
      raw = JSON.parse(readTextFile(stowFile(id))) as Panel;
    } catch {
      raw = null;
    }
    // 这台机器上没有它的本体（本体只在这台机器上，做法才跟着仓库走）：
    // 只要工作区里有那份做法，就照它**站起来一块** —— 换台机器点「打开」走的就是这条。
    if (!raw || !Array.isArray(raw.chat)) return this.openCraftAsPanel(id, target, index);

    // 做法不在本体里（本体只留对话），从那份可分发文件取回来合上
    const back: Panel = { ...this.withCraft({ ...raw, id }), id, updatedAt: Date.now() };
    delete back.float; // 收起来之后那块区域早没了（跟「放回来」一个道理）
    if (back.status === 'working') back.status = 'error'; // 收着的时候进程早没了，那一轮不可能还在跑

    this.ws.panels[id] = back;
    const where: DockTarget = target ?? { where: 'main', tabId: W.firstTabGroup(this.ws.layout).id, mode: 'center' };
    this.ws = W.dockPanel(this.ws, id, where, index);
    // **不删文件**：components/<id>.json 就是这个入口的本体，条目要一直留着
    this.save();
    return back;
  }

  /**
   * **这台机器上没有本体，只有工作区里那份做法** —— 照做法站起来一块。
   *
   * 换台机器 clone 下来点「打开」走的就是这条：做法跟着仓库走，所以那台机器上
   * 这块面板能照原样起来（提示词、按钮、配色都在），**对话从零开始** ——
   * 对话留在原来那台机器上，本来就不跟着走。
   *
   * id **就用做法里那个**（不是新造一个）：做法和面板本来就是同一条组件的两半，
   * 认同一个 id 才不会一开就多写一份重复的做法文件出来。
   */
  private openCraftAsPanel(id: string, target?: DockTarget, index?: number): Panel | null {
    const craft = readCrafts().find((i) => craftOwner(i) === String(id));
    if (!craft) return null;
    const kind = (craft.kind || 'chat') as PanelKind;
    const name = String(craft.name || craft.title || id).trim();
    if (!name) return null;
    const now = Date.now();
    const back: Panel = {
      id,
      title: String(craft.title || name).slice(0, 80) || name,
      kind,
      look: { ...defaultLook(), ...((craft.look || {}) as Panel['look']) },
      spec: {
        ...(defaultSpec(kind) as unknown as Record<string, unknown>),
        ...((craft.spec || {}) as Record<string, unknown>),
      } as unknown as Panel['spec'],
      component: name,
      chat: [],
      revisions: [],
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    } as unknown as Panel;
    this.ws.panels[id] = back;
    const where: DockTarget = target ?? { where: 'main', tabId: W.firstTabGroup(this.ws.layout).id, mode: 'center' };
    this.ws = W.dockPanel(this.ws, id, where, index);
    this.save();
    return back;
  }

  /**
   * 老版本存的"组件"是**模板**（只有 kind + look + spec，没有对话），住在 workspace.components 里。
   * 收纳区改成按运行时收纳之后，模板没有对应的实例 —— 给它造一个**还没聊过的面板**存进去：
   * 打开它就得到那种类型的一个干净面板，老收藏一条都不丢，代码里也从此只剩一条路。
   *
   * 写失败的条目**留在原处**，下次启动接着迁（已经落地的按文件存在与否跳过）。
   */
  private migrateLegacyComponents() {
    const list = this.ws.components;
    if (!Array.isArray(list) || list.length === 0) return;

    const failed: PanelComponent[] = [];
    for (const c of list) {
      if (fs.existsSync(stowFile(c.id))) continue; // 上次已经迁过去了
      const now = c.createdAt || Date.now();
      const panel: Panel = {
        id: c.id,
        title: c.name,
        kind: c.kind,
        look: c.look,
        spec: c.spec,
        chat: [],
        revisions: [],
        origin: 'user',
        createdAt: now,
        updatedAt: now,
      };
      try {
        fs.mkdirSync(stowDir(), { recursive: true });
        fs.writeFileSync(stowFile(c.id), JSON.stringify(panel, null, 2), 'utf8');
      } catch (e) {
        console.error('[收纳] 老组件迁移失败，留到下次再迁：', c.id, e);
        failed.push(c);
      }
    }

    this.ws = { ...this.ws, components: failed.length ? failed : undefined };
    this.save();
  }

  /**
   * 把**员工工作面**从"组件"里摘出来（一次性归位，之后就再也不会进去）。
   *
   * 来由：eschat开一块后台工作面时顺手盖过一个组件声明，图的是"万一被关掉，
   * 回的是收纳区、还打得开"。代价是员工跑进了 设置 → 组件 那张架子 ——
   * 而**员工是一个人，不是一份可复用的做法**：他的身份在角色卡里，克隆、钉顶栏、
   * "声明为组件"这些动作对他一件都不成立。现在组件由 `isComponentPanel` 定，
   * 它把员工工作面排除在外（判据就是 `noWorkspacePrompt`，本来就是"我是员工面板"的意思）。
   *
   * 两件事一起做：
   *   · 开着的员工面板：把 `component` / `pinned` 摘掉 —— 此后它关闭时回「历史会话」，
   *     跟其它没声明的面板一个去处（名册里那个人照旧在，他的工作面随时叫得回来）。
   *   · 躺在 `components/` 里的员工本体（早先关掉时回存进去的）：搬去 `closed/`。
   *     本体一个字节不动，只是换了目录 —— 认它的是文件里那个字段，不是文件名。
   *
   * 判据取 `"noWorkspacePrompt": true` 这个**没转义的**字段。为什么不是 JSON.parse：
   * 这几份文件可能带着几十万字对话，为了一个布尔值把整份对话读成一个对象图不划算。
   * 而字符串值里的同名文字在 JSON 里一定是 `\"noWorkspacePrompt\"`（前面带反斜杠），
   * 那个反向断言正好把"对话里恰好聊到这个字段名"排除掉。
   */
  private detachAgentPanels() {
    for (const p of Object.values(this.ws.panels)) {
      if (!p || !p.noWorkspacePrompt) continue;
      if (!p.component && !p.pinned) continue;
      delete p.component;
      delete p.pinned;
      p.updatedAt = Date.now();
    }

    let files: string[] = [];
    try {
      files = fs.readdirSync(stowDir()).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }
    let moved = 0;
    for (const f of files) {
      const from = path.join(stowDir(), f);
      // 只认文件头（4KB 里就有那个字段）—— 不为搬个家把整段对话读进来
      if (!isAgentHead(readHead(from))) continue;
      const to = path.join(closedDir(), f);
      try {
        fs.mkdirSync(closedDir(), { recursive: true });
        // 历史会话里已经有一条同 id 的（那份更新）：这一份就成了空壳
        if (fs.existsSync(to)) fs.unlinkSync(from);
        else fs.renameSync(from, to);
        moved++;
      } catch (e) {
        console.error('[组件] 员工工作面归位失败，先留在原处：', f, e);
      }
    }
    if (moved) console.log('[组件]', moved, t('份员工工作面搬回历史会话'));
  }

  /**
   * `components/` 里**没有组件声明**的文件搬回「历史会话」。
   *
   * 组件由**声明**定：面板上有 `component`才算数。目录里那些
   * 没声明的，是早先版本按"类型不是对话"自动收进来的（那时还没有声明这回事）——
   * 在这儿归位，历史会话里用户能看见、能处置，不用替谁删。
   * 两边存的是同一种东西（整个面板），所以搬就是改名，内容一个字节不动。
   *
   * 只读文件头认声明，不为搬个家把整段对话读进来。
   */
  private pruneUnclaimedStows() {
    let files: string[] = [];
    try {
      files = fs.readdirSync(stowDir()).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }

    let moved = 0;
    for (const f of files) {
      const from = path.join(stowDir(), f);
      if (/"component"\s*:\s*"[^"]*"/.test(readHead(from))) continue;
      const to = path.join(closedDir(), f);
      try {
        fs.mkdirSync(closedDir(), { recursive: true });
        // 历史会话里已经有一条同 id 的（那份更新）：这一份就成了空壳
        if (fs.existsSync(to)) fs.unlinkSync(from);
        else fs.renameSync(from, to);
        moved++;
      } catch (e) {
        console.error('[组件] 没声明的条目归位失败，先留在原处：', f, e);
      }
    }
    if (moved) console.log('[组件]', moved, t('份没有声明的面板搬回历史会话'));
  }

  /**
   * 清掉历史会话里**已经攒下的空壳**。
   *
   * 以前空面板关掉也会留档，于是 closed/ 里攒了一堆 0 KB 的「新面板」——
   * 新规矩是不再往里写（见 closePanel），已经写进去的那些在启动时顺手扫掉。
   *
   * 只读小文件：装不下东西的才可能是空壳，超过 4KB 的一定有对话，不必读进来。
   */
  private pruneBlankClosed() {
    let files: string[] = [];
    try {
      files = fs.readdirSync(closedDir()).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }
    let gone = 0;
    for (const f of files) {
      const full = path.join(closedDir(), f);
      try {
        if (fs.statSync(full).size > 4096) continue;
        const p = JSON.parse(readTextFile(full)) as Panel;
        if (!isBlankPanel(p)) continue;
        fs.unlinkSync(full);
        gone++;
      } catch {
        /* 读不出来的不动它 */
      }
    }
    if (gone) console.log('[历史会话]', gone, t('个空面板已清理'));
  }

  /** 某个面板的修订历史，新的在前（每条带原始下标，恢复时要用） */
  history(panelId: string) {
    const p = this.ws.panels[panelId];
    if (!p) return [];
    return p.revisions.map((r, index) => ({ index, at: r.at, title: r.title, note: r.note })).reverse();
  }

  /**
   * 恢复到指定的那一版。
   *
   * 恢复之前先把**当前状态**也存成一版 —— 恢复本身也是一次改动，
   * 不留档的话"恢复错了"就没有第二次机会了。
   */
  restoreRevision(panelId: string, index: number): boolean {
    const p = this.ws.panels[panelId];
    const r = p?.revisions[index];
    if (!p || !r) return false;
    p.revisions.push({ at: Date.now(), kind: p.kind, title: p.title, look: p.look, spec: p.spec, note: t('恢复前自动留档') });
    p.redoRevisions = [];
    if (r.kind && r.kind !== p.kind) {
      p.kind = r.kind;
    }
    p.title = r.title;
    p.look = r.look;
    p.spec = r.spec;
    p.updatedAt = Date.now();
    this.save();
    return true;
  }

  // ---------------------------------------------------------------- 悬浮面板

  /**
   * 让面板脱离停靠树，浮在宿主窗口上。
   * 从这一刻起它不占布局 —— 旁边的面板会因为它走了而重新分配空间，
   * 这正是"便签"和"停靠面板"的区别。
   *
   * box 里的位置是**比例**（见 PanelFloat）：主进程只管存，
   * 换算成像素是渲染层的事（只有它知道那块区域此刻多大）。
   */
  floatPanel(
    panelId: string,
    host: string,
    anchor: string,
    box: { rx: number; ry: number; width: number; height: number },
  ) {
    const p = this.ws.panels[panelId];
    if (!p) return;
    this.ws = W.removeEverywhere(this.ws, panelId);
    this.ws.panels[panelId] = { ...p, float: { host, anchor, ...box }, updatedAt: Date.now() };
    this.ws.layout = W.pruneEmptyTabs(this.ws.layout);
    this.ws.floating = this.ws.floating
      .map((w) => ({ ...w, root: W.pruneEmptyTabs(w.root) }))
      .filter((w) => W.tabGroupsOf(w.root).some((t) => t.panels.length > 0));
    this.rehomeOrphans();
    // 这里也必须做一次：如果它落进去的那块区域正好是个空组（或者因为它的离开而空了），
    // 上面的 pruneEmptyTabs 已经把那块区域剪掉了，它的归属就悬空了 ——
    // 渲染层找不到区域就不会画它，表现就是"面板凭空消失"。
    this.rehomeFloats();
    this.save();
  }

  /** 归位：从悬浮状态回到停靠树里 */
  dockFloatingPanel(panelId: string, target: DockTarget, index?: number) {
    const p = this.ws.panels[panelId];
    if (!p || !p.float) return;
    const { float: _gone, ...rest } = p;
    this.ws.panels[panelId] = { ...rest, updatedAt: Date.now() };
    this.dock(panelId, target, index);
  }

  /** 挪动或改大小一个悬浮面板 */
  moveFloat(panelId: string, patch: Partial<PanelFloat>) {
    const p = this.ws.panels[panelId];
    if (!p?.float) return;
    this.ws.panels[panelId] = { ...p, float: { ...p.float, ...patch } };
    this.save();
  }

  /**
   * 取消悬浮。归宿按这个顺序找：
   *   1. 它依附的那块区域还在 → 就回那儿（它本来就是那块的附属）
   *   2. 那块区域没了 → 回**它所属的那个窗口**的第一组标签（不是主窗口！
   *      从浮窗里拖出来的便签，归位该回那个浮窗）
   *   3. 那个窗口也没了 → 才退回主窗口
   */
  unfloatPanel(panelId: string) {
    const p = this.ws.panels[panelId];
    if (!p?.float) return;
    const { host, anchor } = p.float;

    const win = host === 'main' ? null : this.ws.floating.find((w) => w.id === host);
    const root = host === 'main' ? this.ws.layout : win?.root;
    const toMain = (): DockTarget => ({
      where: 'main',
      tabId: W.firstTabGroup(this.ws.layout).id,
      mode: 'center',
    });

    if (root) {
      const back = (tabId: string): DockTarget =>
        host === 'main'
          ? { where: 'main', tabId, mode: 'center' }
          : { where: 'floating', windowId: host, tabId, mode: 'center' };

      if (W.tabById(root, anchor)) return this.dockFloatingPanel(panelId, back(anchor));
      return this.dockFloatingPanel(panelId, back(W.firstTabGroup(root).id));
    }

    this.dockFloatingPanel(panelId, toMain());
  }

  /**
   * 把一块面板变成**挂件窗口**（见 Panel.widget）：脱离停靠树，自己是一扇独立窗口。
   *
   * 和 floatPanel 的分水岭：那个浮在宿主窗口里，这个自己就是窗口 ——
   * 所以它也要从所有树里摘干净，否则会同时出现在树里和窗口上（两份，各改各的）。
   */
  floatWidget(panelId: string, box: Partial<PanelWidget> & { width?: number; height?: number }) {
    const p = this.ws.panels[panelId];
    if (!p) return;
    this.ws = W.removeEverywhere(this.ws, panelId);
    this.ws.layout = W.pruneEmptyTabs(this.ws.layout);
    const { widgetReturn: _previousWidget, ...rest } = p;
    this.ws.panels[panelId] = {
      ...rest,
      hidden: false,
      widget: {
        x: Math.round(Number(box.x) || 0),
        y: Math.round(Number(box.y) || 0),
        width: Math.max(80, Math.round(Number(box.width) || 280)),
        height: Math.max(60, Math.round(Number(box.height) || 200)),
        transparent: box.transparent === true,
        // 卡面：窗口透明 + 页面里自己画那张卡（见 PanelWidget.card）
        card: box.card === true,
        onTop: box.onTop !== false,
        skipTaskbar: box.skipTaskbar !== false,
      },
      updatedAt: Date.now(),
    };
    this.cleanup();
    this.save();
  }

  /** 挪动/改大小一扇挂件窗口 */
  moveWidget(panelId: string, patch: Partial<PanelWidget>) {
    const p = this.ws.panels[panelId];
    if (!p?.widget) return;
    this.ws.panels[panelId] = { ...p, widget: { ...p.widget, ...patch } };
    this.save();
  }

  /** 取消挂件状态，把它摆回主窗口的停靠树里 */
  unwidget(panelId: string) {
    const p = this.ws.panels[panelId];
    if (!p?.widget) return;
    const { widget: previousWidget, ...rest } = p;
    this.ws.panels[panelId] = { ...rest, widgetReturn: { ...previousWidget, returnedAt: Date.now() } };
    this.dock(panelId, { where: 'main', tabId: W.firstTabGroup(this.ws.layout).id, mode: 'center' });
  }

  panel(id: string): Panel | undefined {
    return this.ws.panels[id];
  }

  createPanel(partial: Partial<Panel> & { kind?: PanelKind }, target?: DockTarget, index?: number): Panel {
    const id = W.newId('panel');
    const kind = partial.kind ?? 'chat';
    const now = Date.now();
    const panel: Panel = {
      id,
      title: partial.title ?? t('新面板'),
      kind,
      file: partial.file,
      // **默认打底、调用方的盖上去** —— 不能写成 `partial.spec ?? defaultSpec(kind)`：
      // 调用方给了一个"只有 body+text"的 spec 时，?? 认定它有值、默认一个都不补，
      // 于是缺 actions/fields 的残件直接落到渲染层，一读 .length 就炸（踩过）。
      look: { ...defaultLook(), ...(partial.look ?? {}) },
      spec: { ...defaultSpec(kind), ...(partial.spec ?? {}) },
      chat: partial.chat ?? [],
      revisions: [],
      origin: partial.origin ?? 'user',
      createdAt: now,
      updatedAt: now,
      ...(partial.hidden ? { hidden: true } : {}),
    };
    this.ws.panels[id] = panel;
    // 后台面板（hidden）：活在面板表里就够了，**不放进任何树** —— 界面上一个字都不显示，
    // 但它照样收得到消息、跑得完这一轮（见 Panel.hidden）。
    if (panel.hidden) {
      this.save();
      return panel;
    }
    const where: DockTarget = target ?? { where: 'main', tabId: W.firstTabGroup(this.ws.layout).id, mode: 'center' };
    this.ws = W.dockPanel(this.ws, id, where, index);
    this.save();
    return panel;
  }

  /**
   * 把当前的停靠树**拍成一份骨架**：只留形状、类型、规格，
   * 一个 panelId、一句对话都不带。
   *
   * 为什么必须有它：停靠树住在主进程，插件和界面都够不到 —— 而"记住一套布局"
   * 首先要能把它读出来。核心只提供这一个原语，其余（切片叫什么、存几份、
   * 放哪儿）全是用它的人的事。
   */
  sketchLayout(): SketchNode {
    const slotOf = (id: string): SketchSlot => {
      const p = this.ws.panels[id];
      const kind = (p?.kind ?? 'chat') as PanelKind;
      return {
        /** 记下**是哪一块** —— 切回来时要靠它找回原主，不靠类型猜 */
        id,
        kind,
        title: p?.title ?? t('新面板'),
        look: p?.look ?? defaultLook(),
        spec: p?.spec ?? defaultSpec(kind),
        ...(p?.file ? { file: p.file } : {}),
      };
    };
    const walk = (n: DockNode): SketchNode => {
      if (isTabGroup(n)) {
        const ids = n.panels.filter((id) => this.ws.panels[id]);
        const slots = ids.map(slotOf);
        const at = n.active ? ids.indexOf(n.active) : -1;
        return { type: 'tabs', slots, active: at < 0 ? Math.max(0, slots.length - 1) : at };
      }
      return {
        type: 'split',
        direction: n.direction,
        ratio: n.ratio,
        children: [walk(n.children[0]), walk(n.children[1])],
      };
    };
    return walk(this.ws.layout);
  }

  /**
   * 照一份骨架**重排工作区**（sketchLayout 的反操作）。
   *
   * 两条铁律，都是踩过坑写下来的：
   *
   *   1. **按 id 认人，绝不按类型猜。** 槽位记着那一块面板的 id，找回的就是它本人 ——
   *      对话、草稿、插件状态一并跟着走。id 不在了（用户真把它删了）这一格就**空着**：
   *      空着只是少一块，猜错是把别人的东西挪到自己位置上，性质和代价都不一样。
   *   2. **绝不新造面板。** 早先这里会照类型补一块新的出来，看着就像"现有的面板被克隆了"
   *      一份 —— 而真正的元凶不是补位，是下面那条：它把没进骨架的面板 `closePanel` 掉了，
   *      那些面板于是从面板表里消失，下次切回来槽位找不到主，只好再造一个。
   *      现在不进这一格的只**退到后台**（`hidden`），面板、对话、状态一个字都不丢，
   *      换回原来那一格原样回来。
   *
   * 为什么"退到后台"用 hidden 而不是关掉：关掉会写 closed/<id>.json 并把面板从面板表里
   * 摘出去（见 closePanel 的注释），台账一散，"切回去"就再也拼不回来了。hidden 是**在场**
   * 的另一种形态：收得到消息、跑得完这一轮，只是不占屏幕。
   *
   * 浮窗里的面板**不归切片管**（骨架记的是主窗口的摆法）：说到的才搬回主窗口，
   * 没说到的一个都不动 —— 早先那版把浮窗顺手掏空，窗口于是自己关了又开。
   */
  applySketch(
    sketch: SketchNode,
    extra?: { floating?: FloatingWindow[]; widgets?: { panelId: string; box: PanelWidget }[] }
  ): boolean {
    if (!sketch || (sketch.type !== 'tabs' && sketch.type !== 'split')) return false;

    // 动笔之前先把"谁在哪"一次性算清，别边改边看 —— 改到一半再问就是错的
    const inMain = new Set<string>();
    for (const t of W.tabGroupsOf(this.ws.layout)) t.panels.forEach((p) => inMain.add(p));
    const inFloat = new Set<string>();
    for (const w of this.ws.floating) for (const t of W.tabGroupsOf(w.root)) t.panels.forEach((p) => inFloat.add(p));

    // 老骨架（记 id 之前的版本）没有 id，按类型**在现有面板里**借一块顶上；借不到就空着。
    // 只借不造 —— 借来的那块仍然只有一个，不会凭空多出一份。
    const spare = new Map<string, string[]>();
    for (const id of inMain) {
      const p = this.ws.panels[id];
      const q = spare.get(p?.kind ?? '') ?? [];
      q.push(id);
      spare.set(p?.kind ?? '', q);
    }

    const used = new Set<string>();
    const build = (n: SketchNode): DockNode => {
      if (n.type === 'tabs') {
        const slots = (Array.isArray(n.slots) ? n.slots : []).slice(0, 48);
        const panels: string[] = [];
        for (const s of slots) {
          let id = s && typeof s.id === 'string' ? s.id : '';
          // 1. 如果在当前工作区活跃表中，且未被本次占用，直接认领
          if (id && this.ws.panels[id] && !used.has(id)) {
            // ok
          } else if (id && !this.ws.panels[id] && !used.has(id)) {
            // 2. 外部插件或先前被暂时关闭的面板：尝试从 closed/ 中无缝捞回复活，保留全部历史和状态
            if (this.reopenPanel(id)) {
              // 成功捞回
            } else {
              id = '';
            }
          } else {
            id = '';
          }
          // 3. 兜底容错（旧版本无 id 骨架）：同 kind 面板借用，绝不写死名字或硬编码类型
          if (!id && !(s && s.id)) {
            const q = spare.get(String((s && s.kind) || 'chat'));
            if (q && q.length) id = q.shift()!;
          }
          if (!id) continue; // 仍然无法恢复的槽位宁缺毋滥，保持空置，避免克隆捣乱
          used.add(id);
          panels.push(id);
        }
        const at = Math.max(0, Math.min(Math.round(Number(n.active) || 0), slots.length - 1));
        const pick = slots[at] && typeof slots[at].id === 'string' ? slots[at].id : '';
        const active = panels.includes(pick) ? pick : (panels[panels.length - 1] ?? null);
        return { type: 'tabs', id: W.newId('tabs'), panels, active };
      }
      const kids = Array.isArray(n.children) ? n.children : [];
      if (kids.length < 2 || !kids[0] || !kids[1]) {
        return { type: 'tabs', id: W.newId('tabs'), panels: [], active: null };
      }
      const ratio = Number(n.ratio);
      return {
        type: 'split',
        id: W.newId('split'),
        direction: n.direction === 'column' ? 'column' : 'row',
        ratio: Math.max(0.08, Math.min(0.92, Number.isFinite(ratio) ? ratio : 0.5)),
        children: [build(kids[0]), build(kids[1])],
      };
    };

    let next = W.pruneEmptyTabs(build(sketch));

    // 这一格摆法里没有的面板：退到后台（不销毁）。正在跑活的那几块例外 —— 并进第一组留着，
    // 别把跑到一半的一轮掐断。
    const keep: string[] = [];
    const away: string[] = [];
    for (const id of Object.keys(this.ws.panels)) {
      if (used.has(id)) continue;
      const p = this.ws.panels[id];
      if (!p || p.hidden || p.float) continue; // 后台的、贴着的便签：本来就不归布局管
      if (!inMain.has(id) && !inFloat.has(id)) {
        away.push(id); // 哪棵树里都没有的漏网面板，一并收后台，别让它被 cleanup 又塞回布局
        continue;
      }
      if (inFloat.has(id)) continue; // 浮窗里的**不归切片管**：一个字都不动，窗口才不会自己开开关关
      if (p.status === 'working') {
        keep.push(id);
        used.add(id);
        continue;
      }
      away.push(id);
    }
    for (const id of keep) {
      // insertPanel 是纯函数：返回值必须接住，丢了就等于没插
      next = W.insertPanel(next, W.firstTabGroup(next).id, id);
    }

    // 留下的面板可能原本待在浮窗 / 别的组里：先摘干净，再统一落到新树；顺带摘掉"后台"标记
    for (const id of used) {
      const p = this.ws.panels[id];
      if (!p) continue;
      if (p.hidden) {
        const { hidden: _h, ...rest } = p;
        this.ws.panels[id] = rest;
      }
      this.ws = W.removeEverywhere(this.ws, id);
    }

    // 退场的：从树里摘掉、标成后台。**不写 closed、不离表** —— 切回去还认得出它们
    for (const id of away) {
      const p = this.ws.panels[id];
      if (!p) continue;
      this.ws = W.removeEverywhere(this.ws, id);
      const { float: _f, ...rest } = p;
      this.ws.panels[id] = { ...rest, hidden: true, updatedAt: Date.now() };
    }

    this.ws.layout = W.pruneEmptyTabs(next);

    // 原生全景快照恢复：同步浮窗树 (floating) 与 挂件 (widgets)
    if (extra && Array.isArray(extra.floating)) {
      // 1. 先复活快照中浮窗内需要的面板
      const restoredFloating: FloatingWindow[] = [];
      for (const fw of extra.floating) {
        if (!fw || !fw.root) continue;
        const panelIds = W.tabGroupsOf(fw.root).flatMap((t) => t.panels);
        for (const pid of panelIds) {
          if (!this.ws.panels[pid]) this.reopenPanel(pid);
          if (this.ws.panels[pid]) {
            const { hidden: _h, ...rest } = this.ws.panels[pid];
            this.ws.panels[pid] = rest;
          }
        }
        const prunedRoot = W.pruneEmptyTabs(fw.root);
        if (W.tabGroupsOf(prunedRoot).some((t) => t.panels.length > 0)) {
          restoredFloating.push({ ...fw, root: prunedRoot });
        }
      }
      this.ws.floating = restoredFloating;
    } else {
      // 降级兼容：浮窗里被搬空的那几个收掉，其余原样留着
      this.ws.floating = this.ws.floating
        .map((w) => ({ ...w, root: W.pruneEmptyTabs(w.root) }))
        .filter((w) => W.tabGroupsOf(w.root).some((t) => t.panels.length > 0));
    }

    if (extra && Array.isArray(extra.widgets)) {
      // 清空现有面板的挂件状态
      for (const p of Object.values(this.ws.panels)) {
        if (p.widget) delete p.widget;
      }
      // 恢复快照里的挂件
      for (const w of extra.widgets) {
        if (w && w.panelId && w.box) {
          if (!this.ws.panels[w.panelId]) this.reopenPanel(w.panelId);
          if (this.ws.panels[w.panelId]) {
            this.ws.panels[w.panelId].widget = { ...w.box };
          }
        }
      }
    }

    this.cleanup();
    this.save();
    return true;
  }

  /**
   * 收进后台：脱离停靠树，但**留在面板表里** —— 不占布局、界面上不显示，
   * 却还活着（收得到消息、跑得完这一轮，对话照旧落在自己的 chat 里）。
   *
   * 跟 closePanel 的分水岭：那个是"放回家"（写文件、从面板表里摘掉），
   * 摘掉之后就收不到消息了 —— 那是结束。这里只是让它从界面上退场。
   */
  hidePanel(id: string): boolean {
    const p = this.ws.panels[id];
    if (!p) return false;
    this.ws = W.removeEverywhere(this.ws, id);
    this.ws.layout = W.pruneEmptyTabs(this.ws.layout);
    this.ws.floating = this.ws.floating
      .map((w) => ({ ...w, root: W.pruneEmptyTabs(w.root) }))
      .filter((w) => W.tabGroupsOf(w.root).some((t) => t.panels.length > 0));
    // 悬浮关系一起收拾干净：它已经不是"贴在哪个区域上的便签"了
    const { float: _gone, ...rest } = p;
    this.ws.panels[id] = { ...rest, hidden: true, updatedAt: Date.now() };
    this.rehomeFloats();
    this.save();
    return true;
  }

  /** 把后台的面板摆回布局（默认落在主窗口第一组；给了 target 就落在那儿） */
  showPanel(id: string, target?: DockTarget): boolean {
    const p = this.ws.panels[id];
    if (!p) return false;
    const { hidden: _h, ...rest } = p;
    this.ws.panels[id] = { ...rest, updatedAt: Date.now() };
    const where: DockTarget =
      target ?? { where: 'main', tabId: W.firstTabGroup(this.ws.layout).id, mode: 'center' };
    this.ws = W.dockPanel(this.ws, id, where, undefined);
    this.save();
    return true;
  }

  patchPanel(id: string, patch: Partial<Panel>) {
    const p = this.ws.panels[id];
    if (!p) return null;
    Object.assign(p, patch, { updatedAt: Date.now() });
    this.save();
    return p;
  }

  /** 真删除：面板连同它在树里的位置一起消失 */
  deletePanel(id: string) {
    delete this.ws.panels[id];
    // 面板真没了，它那份正文文件也收掉；缓存一起清，免得将来复用同一个 id 时读到旧内容
    this.bodyCache.delete(id);
    try {
      fs.unlinkSync(bodyFile(id));
    } catch {
      /* 文件本来就不在就算了 */
    }
    // 面板真删了，它选的模型也一起忘掉 —— 否则 workspace.json 里会攒一堆死键
    if (this.ws.panelModels?.[id]) {
      const next = { ...this.ws.panelModels };
      delete next[id];
      this.ws = { ...this.ws, panelModels: next };
    }
    // 思考水平同理：面板真没了，它那一档也一起忘掉，别在 workspace.json 里攒死键
    if (this.ws.thinks?.[id]) {
      const next = { ...this.ws.thinks };
      delete next[id];
      this.ws = { ...this.ws, thinks: next };
    }
    this.ws = W.removeEverywhere(this.ws, id);
    this.ws.layout = W.pruneEmptyTabs(this.ws.layout);
    this.ws.floating = this.ws.floating
      .map((w) => ({ ...w, root: W.pruneEmptyTabs(w.root) }))
      .filter((w) => W.tabGroupsOf(w.root).some((t) => t.panels.length > 0));
    this.save();
  }

  // ---------------------------------------------------------------- 关掉的面板

  /**
   * 关闭面板 = **放回它的家**，不是删。
   *
   * 有条目（`components/<id>.json` 在）的面板，家就是条目背后：关闭时把当前状态
   * 回存进那份文件 —— 条目一直在，下次点条目打开的就是这次的对话。
   * 入口不消费、记录不清除：文件少一条只可能是用户在设置里手动删的。
   *
   * 没条目的走「最近关闭」：本体单独写一个文件（closed/<id>.json），workspace.json 里只留索引 ——
   * 一个面板可能带着十几万字的对话，混进主状态文件会让每次启动的全量读
   * 和每次保存的全量写都变成灾难。以前这里是直接 delete：手滑关掉一个开了半天、
   * 聊了一堆的面板就永久没了，面板上带着整段对话记录，那是最不该丢的东西。
   *
   * 两个目录都**不设条数上限**：软件绝不自动挤掉任何一份记录，想瘦身只有设置里手动删。
   * 回存这条分支**先写文件、写成了才动布局**（跟收纳同一个理由：宁可关不掉，不能丢面板）。
   */
  closePanel(id: string): boolean {
    const p = this.ws.panels[id];
    if (!p) return false;

    const lift = () => {
      delete this.ws.panels[id];
      // 正文文件跟着收 —— 内容在这之前已经落进 closed/ 或组件条目里了，不会丢
      this.bodyCache.delete(id);
      try {
        fs.unlinkSync(bodyFile(id));
      } catch {
        /* 文件本来就不在就算了 */
      }
      this.ws = W.removeEverywhere(this.ws, id);
      this.ws.layout = W.pruneEmptyTabs(this.ws.layout);
      this.ws.floating = this.ws.floating
        .map((w) => ({ ...w, root: W.pruneEmptyTabs(w.root) }))
        .filter((w) => W.tabGroupsOf(w.root).some((t) => t.panels.length > 0));
      // 它可能正悬浮着：先把依附关系收拾干净，别留一条指向不存在区域的记录
      this.rehomeFloats();
    };

    // 声明过的 → 回存到条目背后：这份文件就是"上次用到哪儿"，库里那一条恒在。
    // **组件就是这个意思**：有声明的那块面板，家就在组件库 —— 关闭只是把它放回那个架子上，
    // 不进历史会话（历史会话只收没声明过的关闭）。
    // 钉没钉在顶栏（`pinned`）原样跟着走：关掉一个钉住的组件，它的入口照旧在条上。
    if (isComponentPanel(p)) {
      // 声明写在最前面 —— 列条目只读文件头，认的就是这个字段
      const body: Panel = { ...p, component: p.component };
      try {
        writeStow(id, body, !!p.pinned);
      } catch (e) {
        console.error('[关闭] 回存条目失败，取消关闭：', e);
        return false;
      }
      lift();
      this.rebuildStows(); // mtime/size 变了，条目上的时间与大小跟着走
      this.save();
      return true;
    }

    lift();

    // 空面板不留档：建出来一个字都没动过的那种（标题还叫「新面板」），
    // 关掉就是关掉 —— 历史会话是回头捞东西的地方，攒一屏空壳只会把真东西埋掉。
    // 注意面**照关**（lift 已经做完了），只是不写 closed/<id>.json。
    if (isBlankPanel(p)) {
      this.save();
      return true;
    }

    // 存档失败就别关 —— 宁可关不掉，也不能让面板真的丢了
    try {
      fs.mkdirSync(closedDir(), { recursive: true });
      fs.writeFileSync(closedFile(id), JSON.stringify(p, null, 2), 'utf8');
    } catch (e) {
      console.error('[关闭] 存档失败，取消关闭：', e);
      return false;
    }

    // 不往 workspace.json 里写索引，**只留文件**。
    // 索引和文件分开存早晚会不同步 —— 从备份恢复主文件时就会把索引带丢，
    // 文件明明还在、界面上却看不见（这事今天真撞上了）。目录本身就是真相。
    this.save();
    return true;
  }

  /**
   * 「最近关闭」的列表 —— **直接扫目录**，不看 workspace.json。
   *
   * 列个表只需要标题和类型，它们就在 JSON 最前面几个字段里，
   * 所以只读文件头部 4KB 去抠出来，不为了一张表把几百 KB 的对话整个读进来。
   */
  closedPanels(): ClosedRef[] {
    /*
     * 目录上的 mtime 当缓存钥匙：closed/ 里的文件是**归档**，写进去就不再改内容，
     * 目录 mtime 只在增删/改名时变。所以"mtime 没变"就等于"这份清单一个字节都没变"，
     * 可以直接把上一次的结果还回去 —— 省掉对 166 个文件逐个 statSync。
     *
     * 为什么值得缓存：这张清单每次开设置面板都要拉一遍（closed.list），
     * 主进程侧实测 7~12 ms；它不掉链子，但那点时间正好叠在"卡片出场"那条关键路径上。
     */
    let dirKey = 0;
    try {
      dirKey = fs.statSync(closedDir()).mtimeMs;
    } catch {
      return [];
    }
    if (this.closedCache && this.closedCache.key === dirKey) return this.closedCache.list;

    let files: string[] = [];
    try {
      files = fs.readdirSync(closedDir()).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }

    const out: ClosedRef[] = [];
    for (const f of files) {
      const full = path.join(closedDir(), f);
      let head = '';
      try {
        const fd = fs.openSync(full, 'r');
        const buf = Buffer.alloc(4096);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        head = buf.subarray(0, n).toString('utf8');
      } catch {
        continue;
      }

      const id = f.replace(/\.json$/, '');
      let title = id;
      let kind = 'chat';
      const tm = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
      if (tm) {
        try {
          title = JSON.parse(`"${tm[1]}"`);
        } catch {
          title = tm[1];
        }
      }
      const km = /"kind"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
      if (km) kind = km[1];

      let closedAt = 0;
      let bytes = 0;
      try {
        const st = fs.statSync(full);
        closedAt = st.mtimeMs;
        bytes = st.size;
      } catch {
        /* 读不到就排最后 */
      }
      out.push({ id, title, kind, closedAt, bytes, file: f });
    }

    const sorted = out.sort((a, b) => b.closedAt - a.closedAt);
    this.closedCache = { key: dirKey, list: sorted };
    return sorted;
  }

  /** 把收起来的面板放回来 —— 对话记录一并回来 */
  reopenPanel(id: string): boolean {
    let p: Panel | null = null;
    try {
      p = JSON.parse(readTextFile(closedFile(id))) as Panel;
    } catch {
      return false;
    }
    if (!Array.isArray(p.chat)) return false;

    // 从 closed/ 里读出来的同样补全：那份可能躺了几个月，是老版本写的
    const back: Panel = { ...completePanel(p), updatedAt: Date.now() };
    delete back.closedAt;
    delete back.float;
    /*
     * 它睡着的这段时间进程早没了，那一轮不可能还在跑 —— 跟开机（load 里那句）、
     * 从收纳区开回来（openStowed）用的是同一条判据。
     *
     * **少这一句就出事故**：一块被杀在半路的面板，收尾那段一次都没跑过，status
     * 永久停在 working；从历史会话唤醒它，它就**带着 working 复活**。而谁拿 working
     * 当"他正在跑"的守卫，谁就被它永久卡死 —— eschat 给员工发消息正是这么被吞掉的
     * （用户按了发送，界面上什么都不发生，右侧连自己发的那句都看不见）。
     */
    if (back.status === 'working') back.status = 'error';

    this.ws.panels[id] = back;
    this.ws.layout = W.insertPanel(this.ws.layout, W.firstTabGroup(this.ws.layout).id, id);
    this.dropClosedFile(id);
    this.save();
    return true;
  }

  /** 彻底忘掉一条 */
  forgetClosed(id: string) {
    this.dropClosedFile(id);
    // 记录真没了，这个面板只可能再也回不来 → 它私有的临时产物一起收掉。
    // 还开着的就不动：删的是那条入口或那份记录，对话里仍留着指向那些文件的字。
    if (!this.ws.panels[id]) dropPanelSpace(id);
    this.save();
  }

  private dropClosedFile(id: string) {
    try {
      fs.unlinkSync(closedFile(id));
    } catch {
      /* 文件本来就不在就算了 */
    }
  }

  /** 激活某个标签组里的面板 */
  activate(panelId: string) {
    // 后台的面板不在树里，findPanel 找不到它 —— 先说"请它出来"，再谈激活。
    // "切到某个面板"在用户嘴里就是一句话：后台的也该切得过来。
    if (this.ws.panels[panelId]?.hidden) {
      this.showPanel(panelId);
      return;
    }
    const at = W.findPanel(this.ws, panelId);
    if (!at) return;
    const bump = (root: any) => {
      const tab = W.tabById(root, at.tab.id);
      if (!tab) return root;
      const walk = (n: any): any =>
        isTabGroup(n) ? (n.id === tab.id ? { ...n, active: panelId } : n) : { ...n, children: [walk(n.children[0]), walk(n.children[1])] };
      return walk(root);
    };
    if (at.where === 'main') this.set({ ...this.ws, layout: bump(this.ws.layout) });
    else this.set({ ...this.ws, floating: this.ws.floating.map((w) => (w.id === at.windowId ? { ...w, root: bump(w.root) } : w)) });
  }

  // ---------------------------------------------------------------- 停靠

  /** 拖放的落点：中央并入标签组，四边自然分出新的停靠区 */
  dock(panelId: string, target: DockTarget, index?: number) {
    this.ws = W.removeEverywhere(this.ws, panelId);
    this.ws = W.dockPanel(this.ws, panelId, target, index);
    this.ws.layout = W.pruneEmptyTabs(this.ws.layout);
    this.ws.floating = this.ws.floating
      // 浮窗只有一层标签：并进去之后拍平（见 flattenTabs）
      .map((w) => ({ ...w, root: W.flattenTabs(W.pruneEmptyTabs(w.root)) }))
      .filter((w) => W.tabGroupsOf(w.root).some((t) => t.panels.length > 0));
    this.save();
  }

  /**
   * 拖动**整个标签组**。
   *   中央 = 把它的面板并进目标组，源组消失
   *   四边 = 整组作为一块挪到目标旁边
   * 跨宿主时四边落点降级为"并入标签"（不做跨树搬整块），行为可预期。
   */
  dockTab(tabId: string, target: DockTarget, fromWindowId?: string) {
    const fromRoot = fromWindowId
      ? (this.ws.floating.find((w) => w.id === fromWindowId)?.root ?? null)
      : this.ws.layout;
    const moving = fromRoot ? W.tabById(fromRoot, tabId) : null;
    if (!fromRoot || !moving) return;

    const sameHost =
      (target.where === 'main' && !fromWindowId) || (target.where === 'floating' && target.windowId === fromWindowId);

    /*
     * 搬自己到自己身上：整组原样搬进它自己那一组，数据上什么都没变，
     * 但过程里每个面板都被重新插了一遍（active 于是变成最后那个）——
     * 表现就是"只拖了一下标签栏空白，视角跳到最后一个标签页"。直接短路。
     */
    if (sameHost && target.tabId === tabId) return;

    // center / tabs 都是"并进一组标签"，跨宿主也成立；
    // 只有四边切分在跨宿主时说不清该贴哪一边，降级成并入
    const merging = target.mode === 'center' || target.mode === 'tabs';
    if (!merging && !sameHost) {
      this.dockTab(tabId, { ...target, mode: 'center' }, fromWindowId);
      return;
    }

    const targetRoot = () =>
      target.where === 'main' ? this.ws.layout : (this.ws.floating.find((w) => w.id === target.windowId)?.root ?? null);
    const writeTarget = (next: DockNode) => {
      if (target.where === 'main') this.ws = { ...this.ws, layout: next };
      else
        this.ws = {
          ...this.ws,
          floating: this.ws.floating.map((w) =>
            w.id === target.windowId ? { ...w, root: W.flattenTabs(next) } : w,
          ),
        };
    };
    const writeSource = (next: DockNode) => {
      if (!fromWindowId) this.ws = { ...this.ws, layout: next };
      else this.ws = { ...this.ws, floating: this.ws.floating.map((w) => (w.id === fromWindowId ? { ...w, root: next } : w)) };
    };

    if (target.mode === 'center' || target.mode === 'tabs') {
      let dst = targetRoot();
      if (!dst) return;
      for (const p of moving.panels) dst = W.insertPanel(dst, target.tabId, p);
      const src = W.pruneEmptyTabs(W.closeTabGroup(fromRoot, tabId));
      writeTarget(dst);
      writeSource(src);
    } else {
      const without = W.removeNode(fromRoot, tabId);
      if (!without || !W.tabById(without, target.tabId)) return; // 整棵树就这一组时挪了没意义
      const dst = W.insertNodeBeside(without, target.tabId, target.mode, moving);
      writeTarget(dst);
      writeSource(dst);
    }

    this.cleanup();
    this.save();
  }

  /** 把整个标签组分离成一个新浮窗（组里的面板一起走） */
  detachTabGroup(
    tabId: string,
    at?: { x: number; y: number },
    fromWindowId?: string,
    size?: { width: number; height: number },
    /** 拖动途中撕下来时为 true：源窗口先留着，松手之后再收（和 detachPanel 同一个道理） */
    keepSource = false,
  ): FloatingWindow | null {
    const fromRoot = fromWindowId
      ? (this.ws.floating.find((w) => w.id === fromWindowId)?.root ?? null)
      : this.ws.layout;
    const tab = fromRoot ? W.tabById(fromRoot, tabId) : null;
    if (!fromRoot || !tab || tab.panels.length === 0) return null;
    const without = W.removeNode(fromRoot, tabId);
    if (!without) return null; // 只剩这一组时没有别的落脚点，不动

    const win: FloatingWindow = {
      id: W.newId('win'),
      // 尺寸照传进来的来（主进程已经换算成方形，见 windows.floatSize）——
      // 忽略了它就退回 emptyRect 那块宽扁的默认板子
      rect: {
        ...emptyRect(),
        x: at?.x ?? 280,
        y: at?.y ?? 200,
        ...(size
          ? { width: Math.max(360, Math.round(size.width)), height: Math.max(360, Math.round(size.height)) }
          : {}),
      },
      root: tab,
    };

    if (!fromWindowId) this.ws = { ...this.ws, layout: W.pruneEmptyTabs(without) };
    else
      this.ws = {
        ...this.ws,
        floating: this.ws.floating.map((w) => (w.id === fromWindowId ? { ...w, root: without } : w)),
      };
    // 拖动途中撕下来：源窗口这一会儿就算空了也不能收 —— 它正是拿着这一拖的那扇窗，
    // 把它收掉，指针捕获和松手信号就一起没了，撕出来那块会永远挂在光标下（还是一块白板）。
    if (keepSource && fromWindowId) {
      this.keepEmpty = fromWindowId;
      // 记号自带寿命：到点自己失效并回收，绝不依赖"有人来收尾"
      if (this.keepTimer) clearTimeout(this.keepTimer);
      this.keepTimer = setTimeout(() => {
        this.keepTimer = null;
        this.keepEmpty = null;
        this.reapEmptyWindows();
      }, 4000);
    }
    this.ws = { ...this.ws, floating: [...this.ws.floating, win] };
    this.cleanup();
    this.save();
    return win;
  }

  setRatio(splitId: string, ratio: number, windowId?: string) {
    if (!windowId) this.set({ ...this.ws, layout: W.setRatio(this.ws.layout, splitId, ratio) });
    else this.set({ ...this.ws, floating: this.ws.floating.map((w) => (w.id === windowId ? { ...w, root: W.setRatio(w.root, splitId, ratio) } : w)) });
  }

  closeTabGroup(tabId: string, windowId?: string) {
    if (!windowId) {
      const layout = W.pruneEmptyTabs(W.closeTabGroup(this.ws.layout, tabId));
      this.set({ ...this.ws, layout });
    } else {
      const floating = this.ws.floating
        .map((w) => (w.id === windowId ? { ...w, root: W.pruneEmptyTabs(W.closeTabGroup(w.root, tabId)) } : w))
        .filter((w) => W.tabGroupsOf(w.root).some((t) => t.panels.length > 0));
      this.set({ ...this.ws, floating });
    }
  }

  // ---------------------------------------------------------------- 浮窗

  /** 把面板分出去：它自己成一棵新树（浮窗），所以往后还能往里放别的面板 */
  detachPanel(
    panelId: string,
    at?: { x: number; y: number },
    size?: { width: number; height: number },
    /** 拖动途中撕下来时为 true：源窗口先留着，松手之后再收（见下面的 filter） */
    keepSource = false,
  ): FloatingWindow | null {
    const panel = this.ws.panels[panelId];
    if (!panel) return null;
    const rect: Rect = {
      ...emptyRect(),
      x: at?.x ?? 280,
      y: at?.y ?? 200,
      // 拖出来的那块照着它在布局里原来占的地方开 —— 一出来就跟原来一样大，不用再拉一次
      ...(size ? { width: Math.max(320, Math.round(size.width)), height: Math.max(220, Math.round(size.height)) } : {}),
    };
    const win: FloatingWindow = { id: W.newId('win'), rect, root: W.makeTabGroup(W.newId('tabs'), [panelId]) };

    this.ws = W.removeEverywhere(this.ws, panelId);
    this.ws.layout = W.pruneEmptyTabs(this.ws.layout);
    this.ws.floating = [
      ...this.ws.floating
        .map((w) => ({ ...w, root: W.pruneEmptyTabs(w.root) }))
        // keepSource：拖动途中撕下来时源窗口**先留着** —— 它是拿着这一拖的那个窗口，
        // 在松手之前把它关掉，指针捕获和收尾信号就一起没了，那一块会永远挂在光标下。
        // 松手之后由 reapEmptyWindows 收掉。
        .filter((w) => keepSource || W.tabGroupsOf(w.root).some((t) => t.panels.length > 0)),
      win,
    ];
    this.save();
    return win;
  }

  /** 归一化：浮窗整棵树并回主窗口（并成标签，不再凭空分出新的区） */
  attachWindow(windowId: string, targetTabId?: string, index?: number) {
    const win = this.ws.floating.find((w) => w.id === windowId);
    if (!win) return;
    const ids = W.tabGroupsOf(win.root).flatMap((t) => t.panels);
    let layout = this.ws.layout;
    const tabId = (targetTabId && W.tabById(layout, targetTabId)) ? targetTabId : W.firstTabGroup(layout).id;
    let insertIdx = index;
    for (const id of ids) {
      layout = W.insertPanel(layout, tabId, id, insertIdx);
      if (insertIdx !== undefined) insertIdx++;
    }
    this.set({
      ...this.ws,
      layout: W.pruneEmptyTabs(layout),
      floating: this.ws.floating.filter((w) => w.id !== windowId),
    });
    // 这个窗口没了，挂在它下面的得重新找家
    this.cleanup();
    this.save();
  }

  /**
   * 把一个浮窗挂到另一个窗口上（`'main'` 或另一个浮窗的 id）；不传就是解除。
   *
   * 这里必须防环：A 挂到 B 上、B 又挂到 A 上，之后"宿主动我就动"会来回传，
   * 两个窗口一起飞出去。所以挂之前沿 parent 链往上走一遍，撞见自己就拒绝。
   */
  setWindowParent(windowId: string, parent?: string) {
    if (!windowId || windowId === parent) return;
    const next = this.ws.floating.map((w) => (w.id === windowId ? { ...w, parent } : w));
    if (parent) {
      let cur: string | undefined = parent;
      const seen = new Set<string>();
      while (cur && cur !== 'main' && !seen.has(cur)) {
        if (cur === windowId) return; // 会绕成一圈，不挂
        seen.add(cur);
        cur = next.find((w) => w.id === cur)?.parent;
      }
    }
    this.ws = { ...this.ws, floating: next };
    this.save();
  }

  /** 挂在某个窗口下面的浮窗 */
  childrenOf(windowId: string): FloatingWindow[] {
    return this.ws.floating.filter((w) => w.parent === windowId);
  }

  /**
   * 把一个浮窗并进另一个宿主：目标是主窗口就是"收回"，目标是另一个浮窗就是并进它那一组标签。
   * 拖到目标窗口的**标签栏**上松手走这条。
   */
  mergeWindowInto(windowId: string, targetId: string, targetTabId?: string, index?: number) {
    if (!windowId || windowId === targetId) return;
    if (targetId === 'main') {
      this.attachWindow(windowId, targetTabId, index);
      return;
    }
    const src = this.ws.floating.find((w) => w.id === windowId);
    const dst = this.ws.floating.find((w) => w.id === targetId);
    if (!src || !dst) return;

    const ids = W.tabGroupsOf(src.root).flatMap((t) => t.panels);
    let root = dst.root;
    const tabId = (targetTabId && W.tabById(root, targetTabId)) ? targetTabId : W.firstTabGroup(root).id;
    let insertIdx = index;
    for (const id of ids) {
      root = W.insertPanel(root, tabId, id, insertIdx);
      if (insertIdx !== undefined) insertIdx++;
    }

    this.ws = {
      ...this.ws,
      floating: this.ws.floating.map((w) => (w.id === targetId ? { ...w, root } : w)).filter((w) => w.id !== windowId),
    };
    this.cleanup();
    this.save();
  }

  /**
   * 把一个浮窗的面板做成**挂件**（落在某块区域的**正中**）：不算停靠，
   * 是"贴在那块区域上的便签" —— 一个面板一块，浮窗本身随之消失。
   *
   * 便签的 box 是**比例**（rx/ry 是左上角占那块区域的比例，width/height 是它占的比例），
   * 像素换算在渲染层做。这里给的是一块居中偏小的卡片，用户随手一拖就能挪。
   */
  floatWindowInto(
    windowId: string,
    where: { where: 'main' } | { where: 'floating'; windowId: string },
    anchor: string,
  ) {
    const win = this.ws.floating.find((w) => w.id === windowId);
    if (!win) return;
    if (where.where === 'floating' && where.windowId === windowId) return;
    /*
     * 只认**单面板**的浮窗。
     *
     * 多面板的浮窗在这里会被拆成一堆挂件**叠在同一块区域上** —— 那不是"嵌进去"，
     * 是把它打散。想嵌多面板，先在浮窗里把它并成一个标签组再说。
     */
    const moving = W.tabGroupsOf(win.root).flatMap((t) => t.panels);
    if (moving.length !== 1) return;
    const host = where.where === 'main' ? 'main' : where.windowId;
    const hostRoot =
      where.where === 'main' ? this.ws.layout : (this.ws.floating.find((w) => w.id === where.windowId)?.root ?? null);
    // 那块区域得还在：挂件是"依附在某一块区域上"的，没有依附对象就说不清它贴哪儿
    if (!hostRoot || !W.tabById(hostRoot, anchor)) return;

    for (const id of moving) {
      const p = this.ws.panels[id];
      if (!p) continue;
      this.ws = W.removeEverywhere(this.ws, id);
      this.ws.panels[id] = {
        ...p,
        // 不锁：刚嵌进来的挂件是**接着要摆**的东西，锁上等于当场把它钉死，
        // 还得先找锁才能挪。锁是给"摆好了、别误碰"准备的，不是入场状态。
        float: { host, anchor, rx: 0.16, ry: 0.16, width: 420, height: 300, locked: false },
        updatedAt: Date.now(),
      };
    }
    this.ws.layout = W.pruneEmptyTabs(this.ws.layout);
    this.ws.floating = this.ws.floating
      .map((w) => ({ ...w, root: W.pruneEmptyTabs(w.root) }))
      .filter((w) => W.tabGroupsOf(w.root).some((t) => t.panels.length > 0));
    // 面板都改成了便签，依附的区域可能因为它们的离开而被剪掉 —— 得重新认一次家
    this.rehomeOrphans();
    this.rehomeFloats();
    this.save();
  }

  /**
   * 整个浮窗挪到**另一块区域旁边**（落在四边）：那块地方一分为二，浮窗整棵树搬过去。
   * 和 mergeWindowInto 的区别是并成**分栏**而不是并成标签。
   */
  dockWindowBeside(
    windowId: string,
    where: { where: 'main' } | { where: 'floating'; windowId: string },
    anchor: string,
    mode: 'left' | 'right' | 'top' | 'bottom',
  ) {
    this.dockWindowWhole(windowId, where, anchor, mode, false);
  }

  /**
   * 整个浮窗贴到**宿主的最外沿**（窗口边上、或两块面板之间那道缝）：
   * 不看树里已经分了几块，直接在根上均等一分为二 —— 这就是"侧窗"。
   */
  dockWindowAtSide(
    windowId: string,
    where: { where: 'main' } | { where: 'floating'; windowId: string },
    side: 'left' | 'right' | 'top' | 'bottom',
  ) {
    this.dockWindowWhole(windowId, where, '', side, true);
  }

  /**
   * 上面两条共用的搬运：把一整个浮窗的树搬到目标宿主的某处。
   *   root = false → 贴在那块区域旁边（树里已经分了几块就在那块上再切一刀）
   *   root = true  → 贴在整棵树的最外沿（均等分，和窗口里原有的面板平起平坐）
   * 搬完源浮窗就没了（整棵树都走了），所以顺手清一次空窗。
   */
  private dockWindowWhole(
    windowId: string,
    where: { where: 'main' } | { where: 'floating'; windowId: string },
    anchor: string,
    side: 'left' | 'right' | 'top' | 'bottom',
    atRoot: boolean,
  ) {
    const win = this.ws.floating.find((w) => w.id === windowId);
    if (!win) return;
    // 目标是它自己：整块搬到自己的某一边，等于把树搅乱，不做
    if (where.where === 'floating' && where.windowId === windowId) return;
    const hostRoot =
      where.where === 'main' ? this.ws.layout : (this.ws.floating.find((w) => w.id === where.windowId)?.root ?? null);
    if (!hostRoot) return;
    if (!atRoot && !W.tabById(hostRoot, anchor)) return;

    const moving = W.pruneEmptyTabs(win.root);
    if (!W.tabGroupsOf(moving).some((t) => t.panels.length > 0)) {
      this.reapEmptyWindows();
      return;
    }

    const next = atRoot ? W.insertRootBeside(hostRoot, side, moving) : W.insertNodeBeside(hostRoot, anchor, side, moving);
    const rest = this.ws.floating.filter((w) => w.id !== windowId);
    if (where.where === 'main') this.ws = { ...this.ws, layout: next, floating: rest };
    else
      this.ws = {
        ...this.ws,
        floating: rest.map((w) => (w.id === where.windowId ? { ...w, root: next } : w)),
      };

    this.cleanup();
    this.save();
  }

  /**
   * 收掉已经空了的浮窗：面板都被搬走之后，那块窗口不该继续留在屏幕上占地方。
   *
   * 判据只看**树里还有没有面板**，不看窗口对象在不在 —— 真窗口的创建/销毁
   * 由 windows.ts 对着这份状态做增删，这里只管状态别留下空壳。
   */
  reapEmptyWindows() {
    // 这一拖已经落地了：拖动期间的"先别收"记号到此为止
    this.keepEmpty = null;
    if (this.keepTimer) {
      clearTimeout(this.keepTimer);
      this.keepTimer = null;
    }
    const rest = this.ws.floating.filter((w) => W.tabGroupsOf(w.root).some((t) => t.panels.length > 0));
    if (rest.length === this.ws.floating.length) return;
    for (const w of this.ws.floating) {
      if (!rest.includes(w)) this.onReap?.(w.id);
    }
    this.ws = { ...this.ws, floating: rest };
    this.save();
  }

  /** 收掉了一块空窗口 —— 上层拿它记一行日志（白板窗口就是"卡死盖屏"的真身） */
  onReap: ((windowId: string) => void) | null = null;

  setWindowRect(windowId: string, rect: Rect) {
    this.ws = { ...this.ws, floating: this.ws.floating.map((w) => (w.id === windowId ? { ...w, rect } : w)) };
    this.save();
  }

  save() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);
  }

  /**
   * 立刻落盘，并把挂着的那个防抖 timer 一起取消掉。
   *
   * 退出之前、以及"重启自己"之前必须调一次：那条路是 taskkill /F（mac 上是 SIGTERM），
   * 强杀不给任何退出钩子机会，挂着的 timer 直接随进程消失 —— 最后 250ms 里的改动
   * （比如刚切的模型）就这么静默丢了，不报错、不提示，下次打开才发现回到旧值。
   * 注意别用 save()：那是重新排 250ms，等于把数据又往后推了一格。
   */
  flushNow() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flushSync();
  }

  /** 读一块面板的正文文件；文件不在（或读坏了）就返回 null，让调用方退回骨架里那份 */
  private loadBody(id: string): Panel | null {
    try {
      if (!fs.existsSync(bodyFile(id))) return null;
      // 读回来的也补全 —— 老存档、别的机器搬过来的那份都可能缺键
      return completePanel(JSON.parse(readTextFile(bodyFile(id))) as Panel);
    } catch (e) {
      console.error('[面板] 正文读取失败，先用骨架里那份：', id, e);
      return null;
    }
  }

  /**
   * 把一块面板的正文写出去 —— **内容没变就一个字节都不写**（拿 bodyCache 比一比）。
   *
   * 返回 false = 这次没写成，调用方**必须**放弃拆分、把正文留在主文件里：
   * 宁可这次主文件大一点，也绝不能出现"主文件说正文在 panels/ 里、那边却没写成功"——
   * 那种不一致就是静默丢对话。
   */
  private writeBody(id: string, p: Panel): boolean {
    let text: string;
    try {
      text = JSON.stringify(p, null, 2);
    } catch (e) {
      console.error('[面板] 序列化失败：', id, e);
      return false;
    }
    if (this.bodyCache.get(id) === text) return true; // 没变，跳过 —— 省 IO 就靠这一行
    try {
      fs.mkdirSync(bodyDir(), { recursive: true });
      fs.writeFileSync(bodyFile(id), text, 'utf8');
      this.bodyCache.set(id, text);
      return true;
    } catch (e) {
      console.error('[面板] 正文写入失败：', id, e);
      return false;
    }
  }

  /** 已经不在面板表里的，正文文件也收掉 —— 目录本身就是真相，别攒孤儿文件 */
  private sweepBodies(alive: Record<string, unknown>) {
    for (const id of [...this.bodyCache.keys()]) {
      if (alive[id]) continue;
      this.bodyCache.delete(id);
      try {
        fs.unlinkSync(bodyFile(id));
      } catch {
        /* 文件本来就不在就算了 */
      }
    }
  }

  /**
   * 真正落盘。**先写临时文件，再改名** —— 绝不直接往正式文件上覆盖。
   *
   * 为什么这件事是致命的：这个软件重启自己的方式是 `taskkill /F`（强杀，不打招呼）。
   * 如果那一下正好落在 writeFileSync 的中间，文件就是半截的 ——
   * 下次启动解析失败，整个工作区会变成三个空面板，而且**不会报任何错**，
   * 数据没了都不知道为什么。
   *
   * 改名的原子性保证磁盘上永远是"上一份完整的"或"这一份完整的"，没有中间态：
   *   1. 写 workspace.json.tmp
   *   2. 旧文件改名成 .bak（rename 是移动，不是复制，不花时间）
   *   3. tmp 改名成 workspace.json（原子）
   */
  /**
   * 防抖那条路（每次改动排 250ms 后的那一次）—— **异步落盘**。
   *
   * 为什么必须异步：主进程只有一条事件循环。同步写盘 60~80 ms 期间，**所有** IPC
   * 都堵在队列里 —— 打开设置面板那 7 条请求、界面上的任何一次点击，全都排在它后面。
   * 磁盘一忙（杀毒/索引器插一脚），同一条路能从 75 ms 涨到 1200 ms
   * （`.ensoul/lag.log` 里那些 BLOCKER 就是这么来的）。
   *
   * 退出与重启**不走这里**：那条路要保证"函数返回时磁盘上已经有了"，
   * 所以 flushNow() 仍用同步版（见 flushSync）。两条路用不同的临时文件，
   * 同名 rename 是原子的，谁赢都是完整 JSON。
   */
  private flush(): void {
    void this.flushAsync();
  }

  private async flushAsync(): Promise<void> {
    const my = ++this.writeToken;
    // 每次落盘用**自己的**临时名：两次异步保存重叠时各写各的，不会互相写花
    const tmp = `${FILE()}.tmp-async-${my}`;
    try {
      const skel: Record<string, Partial<Panel>> = {};
      const dirty: Array<[string, string]> = [];
      let allOk = true;
      for (const [id, p] of Object.entries(this.ws.panels) as [string, Panel][]) {
        try {
          const text = JSON.stringify(p, null, 2);
          // 内容没变就一个字节都不写 —— 省 IO 的关键（和同步版同一套判据）
          if (this.bodyCache.get(id) !== text) dirty.push([id, text]);
        } catch (e) {
          console.error('[面板] 序列化失败：', id, e);
          allOk = false;
        }
        skel[id] = toSkeleton(p);
      }
      if (allOk) this.sweepBodies(skel);

      const out = allOk ? { ...this.ws, panels: skel } : this.ws;
      const json = JSON.stringify(out, null, 2);

      if (dirty.length) {
        await fs.promises.mkdir(bodyDir(), { recursive: true });
        for (const [id, text] of dirty) {
          await fs.promises.writeFile(bodyFile(id), text, 'utf8');
          this.bodyCache.set(id, text);
        }
      }
      await fs.promises.writeFile(tmp, json, 'utf8');
      // 已经有更晚的一次落盘跑过了 —— 它那份更新，这里别再改名把新的盖回旧的
      if (my !== this.writeToken) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* 清不掉就算了，下次启动的清扫会收掉 */
        }
        return;
      }
      if (fs.existsSync(FILE())) await fs.promises.rename(FILE(), BAK());
      await fs.promises.rename(tmp, FILE());
    } catch (e) {
      console.error('[工作区] 保存失败：', e);
    }
    this.syncCrafts();
  }

  /** 同步落盘 —— 只给"退出/重启前必须已经写进去"那条路用（见 flushNow） */
  private flushSync() {
    const my = ++this.writeToken;
    const tmp = `${FILE()}.tmp`;
    try {
      // 第一步：把每块面板的正文各自写进 panels/<id>.json —— **只写改动过的那几个**。
      // 第二步：主文件只写骨架（toSkeleton 削掉了对话和压缩存档）。
      const skel: Record<string, Partial<Panel>> = {};
      let allOk = true;
      for (const [id, p] of Object.entries(this.ws.panels) as [string, Panel][]) {
        if (!this.writeBody(id, p)) allOk = false;
        skel[id] = toSkeleton(p);
      }
      if (allOk) this.sweepBodies(skel);

      // 有一块正文没写成 → 这次整体不拆，照旧把完整对象写进主文件（下次保存再试）
      const out = allOk ? { ...this.ws, panels: skel } : this.ws;
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');

      // 先把内容刷到磁盘再改名。否则可能出现"文件名已经换了、内容还在系统缓存里"，
      // 断电时就是一个改了名却空着的文件。
      try {
        const fd = fs.openSync(tmp, 'r+');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
      } catch {
        /* 刷不动就算了，至少还有改名这一层保护 */
      }

      // Windows 上杀毒/索引器/同步盘会短暂占住 workspace.json，rename 抛 EPERM ——
      // 这一下失败 = "我明明选了工作区，重启就没了"，而且只在控制台留一行，界面毫无反应。
      // 改名是纯元数据操作，歇一下再试通常就成了；重试也不行才落到最后那行报错。
      const rename = (from: string, to: string) => {
        for (let i = 0; ; i++) {
          try {
            fs.renameSync(from, to);
            return;
          } catch (e) {
            if (i >= 4) throw e;
            const till = Date.now() + 40;
            while (Date.now() < till); // 只在失败路径上等，成功的保存一次都不多花
          }
        }
      };
      if (fs.existsSync(FILE())) rename(FILE(), BAK());
      rename(tmp, FILE());
    } catch (e) {
      console.error('[工作区] 保存失败：', e);
    }
    // 主状态存下来之后，顺手把开着的组件的做法同步进那份可分发文件
    this.syncCrafts();
  }
}

export const store = new Store();
