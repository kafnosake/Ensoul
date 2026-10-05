/**
 * 历史会话 —— 把"这一次对话已经结束"的那些收进 `.ensoul/state/histconv/<面板 id>.json`，
 * 界面上由**面板最左边那条抽屉**读（核心画的 HistRail：一版一行，点一行中间的会话跳过去）。
 *
 * ── 为什么一块面板一个文件（不是大家挤在一个 JSON 里）──────────────────
 * 以前所有面板的历史都堆在 `histconv.json` 里，涨到 300 KB 之后界面**整个读不出来**：
 * 界面读文件走 `fs:read`，它有个 300 KB 上限（超过就只回一句"先不整个读进来"），
 * 于是 JSON.parse 失败、左边一条刻度都不显示 —— 数据明明收着了，就是看不见。
 * 一个面板一份文件顺带把"面板之间互不相干"也落到地上：界面只读**自己**那一份，
 * 别的面板收了多少历史、收没收到，跟它没关系，也不会被别人的大历史拖死。
 * 单份文件另有 SIZE_MAX 兜底：超了就丢最旧的几段，永远不给界面递一个读不动的文件。
 *
 * ── 收哪三种（**不发明判据，只收已经发生的事**）────────────────────────
 *   1. 压缩前：`/compress` 把原文挪进 `compact.archive`（对话区不再显示、也不再进
 *      请求）—— 那些原文按**增量**收进来：`arch` 记着收到第几条，连压多次不重复。
 *      所有面板都收。
 *   2. 翻篇：**只对员工面板**（dispatch 开的工作面，`noWorkspacePrompt`）——
 *      这块面板隔了 `gapMin`（默认 30 分钟）**没动过**，先把那一段收进左边抽屉、
 *      **再把面板清空**（下面 `newSession` 干的就是这件事），员工下一句开口是一个
 *      全新的会话。
 *      ★ 这个数就是**全局唯一的会话边界**：eschat（plugins/eschat）不再留自己那份
 *      `segMin`，它切「当前这一次」直接读设置里这一个数（见它那边的 `histGap`）。
 *      要改就改这一处 —— 从前两处各一份，改了一边另一边没反应。
 *      「没动过」算的是**面板本身**（chat 最后一次变化到现在，见 `lastTouch`），
 *      **不是** chat 里最后那条消息的时间戳 —— 这两者在回档时差得最远：从抽屉
 *      点开一版几天前的历史，消息是旧的、可面板刚动过。按消息时间判，用户点开
 *      下一秒就被清空，翻都没法翻。
 *      **这一步会让他忘** —— 上一次那些话不在他上下文里了。数据安全线只有一条：
 *      **先收再清**。五条边界写死在这儿，动之前先读一遍：
 *        · 只在员工工作面；普通面板**永不按时间切**，你不说话对话就一直是同一次；
 *        · 面板正在跑（`status === "working"`）不动 —— 那是它手头的活，翻篇会把它腰斩；
 *        · 更早那几段和收尾这一段都进了 box 之后才清 chat，顺序反了就是丢对话；
 *        · 判据看"面板多久没动"，所以回档（点一行跳过去）也算刚动过 —— 翻历史
 *          不会被翻篇吃掉；插件重载后从头起算，最多让该翻的晚一个 gap；
 *        · 收完 chat 归空，下一拍判据自然不成立 —— 不会连着翻。
 *      想手动翻篇另有三条路：/new（收进抽屉后重开）、/clear（连摘要一起丢）、
 *      /compress（留摘要，原文进隐性存档）。
 *   3. 收尾：面板被关掉 / 收进收纳区，对话区里那一次还没等到上面任何一条 ——
 *      人走了本身就是结束，拿内存里上一拍的快照落底（面板一走就再也读不到 chat 了）。
 *
 * ── 界面上长什么样（在核心画的 HistRail 里，这个插件不管画）────────────
 * 一块面板最左边一条**抽屉**：栏里一版一行，按时间分组（今天 / 昨天 / 7 天内 / 更早），
 * 点一行**中间的会话就跳过去**（跳过去当然能接着聊 —— 就是回档：把这个面板的 chat
 * 换成那一段，compact 一起清掉）。收起就整条不见，会话列一点都不动。
 *
 * ── 跟 plugins/notes 同一个路子 ───────────────────────────────────────
 * 每 2 秒扫一遍 `api.panels()`，有变化才落盘；界面每 1.5 秒读同一个文件。
 * 谁都不用认识谁：插件没装、文件不在，左边那条抽屉就是空的，别的一个字都不报。
 *
 * ── 界面要动这份账时走**命令文件** ─────────────────────────────────────
 * 重命名 / 删除 / 排序 / 跳转都是界面上的动作，可界面够不着这份账（只有主进程能读写
 * 工作区）。所以照 whale-pet 那个遥控器的写法：界面把命令**追加**进
 * `.ensoul/state/histconv.cmd.json`，这里每 600 ms 取一次、按 seq 去重、取完清空。
 * 谁都不用认识谁 —— 这个插件没装，界面上点那些按钮就只是没人应。
 *
 * 分段按面板缓存（签名 = 条数 + 首末条 id），没变不重算 —— 几千条消息的大面板，
 * 每 2 秒全量重切一次纯属浪费。
 *
 * 只收**用户和助手**的正文：工具消息是重放用的原料（动辄几千字的文件内容、
 * 命令输出），不是"说过的话"，收进来历史没法读，文件也会跟着滚大。
 */

const fs = require('fs');
const path = require('path');

const TICK_MS = 2000;
/** 每块面板留多少次历史（超了丢最旧的） */
const KEEP = 40;
/** 最多记多少块面板的账 */
const PANEL_KEEP = 200;
/** 一份面板历史最多多大（字节）—— 界面读文件有 300 KB 上限，留足余量 */
const SIZE_MAX = 180000;
/** 分片放哪（工作区相对路径） */
const DIR = '.ensoul/state/histconv';
/** 老版本把所有人堆在一个文件里，启动时搬过来一次 */
const LEGACY = '.ensoul/state/histconv.json';
/** 界面的动作（重命名 / 删除 / 排序 / 跳转）写这儿，这里取走就清空 */
const CMD_FILE = '.ensoul/state/histconv.cmd.json';
/** 命令取多勤 —— 点一行要"马上跳过去"，不能等那个 2 秒的扫描 */
const CMD_MS = 600;
/** 起标题每轮问几个模型。一次问一堆会把用户那个模型打满，慢慢来 */
const TITLE_PER_ROUND = 2;
/** 一条标题最多几个字（模型不听话时兜底截断） */
const TITLE_MAX = 20;

/** 起标题的规矩：短、像人话、别加引号别解释 */
const TITLE_SYS = [
  t('你是给对话起标题的。读下面这段对话，起一个标题。'),
  `要求：不超过 12 个字，能一眼看出这段在做什么，用名词短语，不要标点结尾。`,
  t('只输出标题本身，不要引号、不要句号、不要解释、不要思考过程。'),
].join('\n');

let api = null;
let timer = null;
/** 起标题那个循环在不在跑（模型慢，一轮没回来就别再开一轮） */
let titling = false;
/** 命令文件里已经处理到哪个 seq —— 认的是它，不是"文件里有没有东西" */
let cmdSeq = 0;
let cmdTimer = null;
/** pid → { sid, segs }：上一拍的分段快照 —— 面板消失时（收尾）全靠它 */
const cache = new Map();
/** pid → 这一份分片（内存里那份）—— 没变的面板每拍不该再读一次文件 */
const boxes = new Map();
/** 上一拍还在的面板 */
let prevAlive = new Set();
/**
 * pid → 这块面板**最后一次真的动过**是什么时候（chat 一有变化就刷新）。
 *
 * 翻篇判据看的是它，**不是** chat 里最后那条消息的 `createdAt` —— 这两者在"回档"
 * 时会分岔：从抽屉点开一版几天前的历史，chat 换成了旧消息（时间戳是几天前的），
 * 可"这块面板刚刚动过"是现在。按消息时间判，回档下一拍就被判成"闲置了很久"、
 * 当场清空 —— 用户点开一眼就没了（这就是这条表存在的理由，别改回去）。
 */
const lastTouch = new Map();

/**
 * 面板 id 变成文件名。两边（插件写、界面读）都走这一条，
 * 对不上就是对不上，所以这条规则必须一模一样。
 */
function fileOf(pid) {
  const safe = String(pid || '').replace(/[^\w.-]+/g, '_');
  return safe ? `${DIR}/${safe}.json` : '';
}

/** 绝对路径（插件落盘用） */
function absOf(pid) {
  const rel = fileOf(pid);
  return rel ? path.join(api.workspace || '.', rel) : '';
}

/**
 * 这块面板是不是**员工的工作面**。只有它按"隔一阵子没说话"切段 ——
 * 并且到点会**真的翻篇**：那一段收进抽屉、面板清空（见文件头第 2 条）。
 * 这条规矩属于员工（见 dispatch），不该落到普通面板头上。
 */
function isEmployee(p) {
  return !!(p && p.noWorkspacePrompt);
}

/**
 * 员工那边"多久没续上算翻篇"（分钟）。默认 30。
 * ★ 这是**全局唯一的会话边界**：eschat（员工通讯录）切「一次一次会话」用的就是它，
 * 那边不再留自己那份 `segMin` —— 从前两处各一份，改了一边另一边没反应。
 * **只对员工面板生效**：到点就收进抽屉 + 清空面板。
 * 算的是**这块面板多久没动**（`lastTouch`），不是 chat 里最后一条消息多老 ——
 * 回档看旧历史时两者分岔，按消息判会把用户正在看的那一版当场清掉。
 * 只想记账、不想清空，把下面 `autoNew` 关掉（见文件头第 2 条）。
 */
function gapMs() {
  const min = Number(api.param('gapMin', 30));
  return (Number.isFinite(min) && min > 0 ? min : 30) * 60000;
}

function at(m) {
  const ms = Number(m && m.createdAt);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * 一版历史在清单里的名次。默认就是它开始的时间（于是天然按时间排），
 * 但人**手动拖过**之后以 `ord` 为准 —— 自动排完又被人挪走，挪动才算数。
 */
function ordOf(e) {
  const o = Number(e && e.ord);
  if (Number.isFinite(o) && o > 0) return o;
  return Number((e && e.from) || 0);
}

/** 这段对话的开头几句 —— 给它起标题时看的就这么多 */
function segText(e, n = 900) {
  const lines = [];
  for (const m of e.msgs) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const who = m.role === 'user' ? t('用户') : t('助手');
    lines.push(`${who}：${String(m.content || '').replace(/\s+/g, ' ').slice(0, 300)}`);
    if (lines.join('\n').length > n) break;
  }
  return lines.join('\n').slice(0, n);
}

/**
 * 翻篇时留下的**接续锚点**：上一段从哪起、到哪收。新会话开头把它摆一次 ——
 * 不然 30 分钟一翻篇，新会话什么都不记得，只能去翻旧文件考古
 * （真发生过：对着已交付的单找了十几轮令牌，还把题材画串了）。
 */
function anchorOf(seg, title) {
  const cut = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 160);
  const firstUser = seg.msgs.find((m) => m.role === 'user');
  let lastA = null;
  for (const m of seg.msgs) if (m.role === 'assistant') lastA = m;
  const bits = [];
  if (title) bits.push(`标题「${title}」`);
  if (firstUser) bits.push(`起于：${cut(firstUser.content)}`);
  if (lastA) bits.push(`收于：${cut(lastA.content)}`);
  return bits.join('｜');
}

/** 模型回的标题收拾一下：剥引号、去掉换行和结尾的标点、超长截断 */
function cleanTitle(s) {
  const out = String(s || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^["'“”「『《\s]+|["'“”」』》\s。.!！?？]+$/g, '')
    .trim();
  return out.slice(0, TITLE_MAX);
}

/**
 * 只留对话本身。工具消息不收 —— 那是给模型回放用的原料，不是"说过的话"。
 * 图照旧收（存的是磁盘路径，不是 base64，一条才几十字节）。
 */
function slim(m) {
  if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null;
  if (typeof m.content !== 'string' || !m.content) return null;
  const out = { id: m.id, role: m.role, content: m.content, createdAt: at(m) };
  if (m.edited) out.edited = true;
  if (m.images && m.images.length) out.images = m.images;
  if (m.stats) out.stats = m.stats;
  if (m.steer) out.steer = true;
  return out;
}

/**
 * 把对话切开。**只有员工面板会真的被切成多段**（`gap` 是那个 30 分钟）；
 * 普通面板的 gap 传 Infinity —— 整份对话就是一段，永远不会"因为隔得久"被拆开。
 *
 * 切口落在**用户消息**上：两条用户消息之间隔超 gap 就开新段，助手的回答跟着它
 * 服务的那一次走。段的 key 取第一条用户消息的时间（这个 key 天然稳定）。
 */
function segmentsOf(chat, gap) {
  const segs = [];
  let cur = null;
  const cut = (t) => !cur || (Number.isFinite(gap) && t && cur.lu && t - cur.lu > gap);
  for (const m of chat) {
    if (!m) continue;
    const tm = at(m);
    if (m.role === 'user') {
      if (cut(tm)) {
        cur = { key: `s${tm || 'x' + segs.length}`, from: tm, to: tm, lu: tm, msgs: [] };
        segs.push(cur);
      }
      if (tm) cur.lu = tm;
    }
    if (!cur) continue; // 第一条用户消息之前的（系统铺垫之类），不属任何一次
    const s = slim(m);
    if (s) cur.msgs.push(s);
    if (tm) {
      if (!cur.from) cur.from = tm;
      cur.to = tm;
    }
  }
  return segs.filter((s) => s.msgs.length > 0);
}

/**
 * 员工面板里哪些段已经冻结：除最后一段外都冻结了（后面已经有人开口）；最后一段若
 * **整段最后一次动静**都过了 gap，也算 —— 真续上时那句话必然隔了 gap、会另起
 * 一段，所以先收不会错。`to` 看的是任意消息（含助手），长任务跑着不算闲置。
 *
 * `gap` 是 Infinity 时（普通面板）一段都不会被收 —— 这正是要的。
 */
function frozenOf(segs, now, gap) {
  if (!Number.isFinite(gap)) return [];
  return segs.filter((s, i) => i < segs.length - 1 || (s.to && now - s.to > gap));
}

/** 一份面板历史的形状在这里定死一遍：读进来的脏文件一律过这一道 */
function normBox(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const entries = Array.isArray(b.entries)
    ? b.entries.filter((e) => e && e.key && Array.isArray(e.msgs))
    : [];
  for (const e of entries) {
    // 标题和挪动过的名次是**人的东西**，读回来必须原样带着 —— 丢了就等于没起过、
    // 没拖过。没标题就空着，界面那边照旧显示它自己挑的开头那句。
    e.title = typeof e.title === 'string' ? e.title.slice(0, TITLE_MAX) : '';
    // 这一条什么时候试过起标题 —— 模型不可用时按条歇着，别让一条坏面板
    // 把别的面板也一起拖住（更别每拍都去撞同一堵墙）
    e.titleTried = Number(e.titleTried) || 0;
    const o = Number(e.ord);
    e.ord = Number.isFinite(o) && o > 0 ? o : Number(e.from) || 0;
    // 段的 key 就是它开头那条用户消息的时间，正常必然等于 from。对不上说明这一条
    // 被旧版本就地覆盖过（正文换成了别的一段，from 还停在原来那个时间）——
    // 起点按它自己第一条正文算回来。这样界面上分组、先后、回档回来那一下都取对，
    // 也才让 isSameSeg 的起点判据恢复可用。
    const f0 = Number(e.msgs[0] && e.msgs[0].createdAt) || 0;
    if (f0 && Number(e.from) !== f0) e.from = f0;
  }
  // 老数据里同一批消息可能挂着两个 key（/compress 收进来一条、跳转时又收了一条），
  // 清单里就成了两条一模一样的、来路还各挂一个。读进来就对一遍：同一批只留一条，
  // 来路留**更具体**的那个（压缩前 > 冻结 > 收尾）。
  const kept = [];
  for (const e of entries) {
    const twin = kept.find((x) => sameMsgs(x.msgs, e.msgs));
    if (!twin) {
      kept.push(e);
      continue;
    }
    if (whyRank(e.why) > whyRank(twin.why)) twin.why = e.why;
    if (!twin.title && e.title) twin.title = e.title;
    // 两条正文一样时留**自洽的那一条**：key 跟起点对得上的才算数 ——
    // 被旧版本覆盖过的那条，key 还挂在原来那个时间上（正文却是新那一段），
    // 留着它界面点这一行就会认错人。其余按先来后到（keep 顺序 `s` 打头）。
    const okA = /^s\d+$/.test(twin.key) && Number(twin.key.slice(1)) === twin.from;
    const okB = /^s\d+$/.test(e.key) && Number(e.key.slice(1)) === e.from;
    if (okB && !okA) kept[kept.indexOf(twin)] = e;
  }
  // 翻篇锚点是接续的全部依据，读回来必须原样带着（老数据没有就没有）
  const a = b.anchor && typeof b.anchor === 'object' && b.anchor.text ? b.anchor : null;
  return {
    at: Number(b.at) || 0,
    arch: Number(b.arch) || 0,

    activeKey: typeof b.activeKey === 'string' ? b.activeKey : undefined,
    touch: Number(b.touch) || 0,
    anchor: a ? { at: Number(a.at) || 0, text: String(a.text).slice(0, 1200) } : undefined,
    entries: kept,
  };
}

/** 同一批消息挂两条时留哪个来路：越具体的越说明它怎么来的 */
function whyRank(w) {
  if (w === 'compress') return 3;
  if (w === 'freeze' || w === 'idle') return 2;
  return 1;
}

/**
 * 一份历史太大就丢最旧的几段。界面读文件是**一次性整读**（`fs:read` 超 300 KB
 * 就只回一句话，界面那边 JSON.parse 直接失败）—— 与其让它读不动，不如自己先瘦下来。
 * 丢的是最旧的那几次会话，最近的永远留着。
 *
 * 每丢一段只序列化**那一段**来扣账，不整份重算 —— 整份 stringify 一遍再比一次大小
 * 是平方级的开销，分片越大越慢，正是这种东西会把一个 2 秒的定时器拖成卡顿。
 */
function slimBox(box) {
  let size = JSON.stringify(box, null, 2).length;
  while (box.entries.length > 1 && size > SIZE_MAX) {
    size -= JSON.stringify(box.entries.shift(), null, 2).length + 3; // +3：逗号与换行
  }
  return box;
}

function readBox(pid) {
  try {
    const raw = JSON.parse(fs.readFileSync(absOf(pid), 'utf8'));
    const box = normBox(raw);
    const before = Array.isArray(raw && raw.entries) ? raw.entries.length : 0;
    // 读进来就已经超限（老版本落下的、或者别处塞进来的）：当场瘦下来写回去。
    // 不瘦的话界面那边读不动，等于这一块面板的历史整个不见了。
    // 对掉过重复条目的也写回去一次 —— 不然那份文件里两条一样的会一直在。
    if (before !== box.entries.length || JSON.stringify(box, null, 2).length > SIZE_MAX) writeBox(pid, box);
    return box;
  } catch {
    return { at: 0, arch: 0, touch: 0, entries: [] };
  }
}

/**
 * 这一刻这块面板的那份账。**这份文件只有本插件写**，所以读进内存之后就一直用内存里
 * 这份，不再每 2 秒重读一遍（几十万字节的分片，2 秒解析一次纯属白烧）。
 * 面板真被删掉、分片被清掉的情况，靠收尾那一步从这张表里摘掉。
 */
function openBox(pid) {
  let box = boxes.get(pid);
  if (!box) {
    box = readBox(pid);
    boxes.set(pid, box);
  }
  return box;
}

function writeBox(pid, box) {
  const file = absOf(pid);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(slimBox(box), null, 2), 'utf8');
  } catch (e) {
    api.log(`历史会话：${pid} 的状态存不下来 ——`, (e && e.message) || e);
  }
}

/** 两段是不是同一批消息（id 逐个对得上就是同一段） */
function sameMsgs(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if ((a[i] && a[i].id) !== (b[i] && b[i].id)) return false;
  return true;
}

/**
 * 一段新分出来的段，是不是**就是账上那一条**（同一次会话又长了）。
 *
 * 只认"接着长"，不认"收尾时间变了"。三条同时成立才算：
 *   1. 起点没动过：e.from === seg.from；
 *   2. 第一句还是那一句：首条正文 id 相同；
 *   3. e.msgs 是 seg.msgs 的前缀：账上记的那些一条不少地还在前面。
 *
 * 老写法只看 to 和条数，那是错的：员工工作面隔 30 分钟翻篇之后，新会话的 key 跟
 * 旧条目必然不同，可翻篇那一拍留下的 to、别处改写过的 to，都能跟老条目撞上 ——
 * 于是新会话那一段被当成"老会话又长了"就地覆盖，用户点开那条历史只剩刚发的一条。
 * 起点和首条对不上，就是两次不同的会话，宁可各留一条。
 */
function isSameSeg(e, seg) {
  const a = e && e.msgs;
  const b = seg && seg.msgs;
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return false;
  if (a[0] && b[0] && a[0].id !== b[0].id) return false;
  if (Number(e.from) !== Number(seg.from || 0)) return false;
  return b.length >= a.length && a.every((m, k) => m && b[k] && m.id === b[k].id);
}

/**
 * 给一条新条目挑一个**没人占的** key。
 *
 * 段的 key 是它开头那条用户消息的时间，本来天然唯一；可两个不同的会话凑巧
 * 取到同一个毫秒是可能的（回档、翻篇、面板被重开都撞得上）。撞上就得换一个 ——
 * 清单是**按 key 找条目**的，两条同 key 的话，点一行、删一行、重命名一行都会认错人。
 */
function keyFor(box, key, from) {
  if (!box.entries.some((e) => e.key === key)) return key;
  const base = key + '#' + (from || Date.now());
  let alt = base;
  let n = 1;
  while (box.entries.some((e) => e.key === alt)) alt = base + '#' + ++n;
  return alt;
}

/**
 * 把一段收进这块面板的历史。
 *
 * key 撞上**不等于**就是它：只有账上那条和这一段**确实是同一次会话**（见 isSameSeg）
 * 才就地接长；否则它们是两个不同的会话，只是 key 凑巧一样 —— 这时候另存一条，
 * 绝不动账上那条。老写法在这里无条件覆盖，用户点一下别的会话，他原来那版历史
 * 就被新会话那一条洗掉了（这才是「点回去只剩我最近一条」的真凶）。
 */
function store(box, key, why, seg) {
  // 同一批消息已经以别的 key 收过了就当收过 —— 不然"点一行跳过去"会把用户
  // 正在看的那一版再收一遍（key 不一样），清单里于是冒出两条一模一样的，
  // 来路还各挂一个（压缩前 / 收尾），看着像两个不同的会话。
  const twin = box.entries.find((e) => e.key !== key && sameMsgs(e.msgs, seg.msgs));
  if (twin) return false;
  const found = box.entries.find((e) => e.key === key);
  // 撞了 key 却不是同一段：另起一条，账上那条一个字都不动
  if (found && !isSameSeg(found, seg)) {
    const alt = keyFor(box, key, seg.from);
    box.entries.push({
      key: alt,
      why,
      from: seg.from || 0,
      to: seg.to || 0,
      ord: Number.isFinite(seg.ord) && seg.ord > 0 ? seg.ord : (seg.from || Date.now()),
      title: seg.title || '',
      msgs: seg.msgs,
    });
    box.entries.sort((a, b) => ordOf(a) - ordOf(b));
    if (box.entries.length > KEEP) box.entries.splice(0, box.entries.length - KEEP);
    return true;
  }
  if (found) {
    if (found.to === (seg.to || 0) && found.msgs.length === seg.msgs.length) return false;
    found.msgs = seg.msgs;
    found.to = seg.to || found.to;
    if (!found.from && seg.from) found.from = seg.from;
    if (Number.isFinite(seg.ord) && seg.ord > 0) found.ord = seg.ord;
    // title 一个字都不动 —— 那是人给的，不是这一段自己长出来的
    return true;
  }
  box.entries.push({
    key: keyFor(box, key, seg.from),
    why,
    from: seg.from || 0,
    to: seg.to || 0,
    ord: Number.isFinite(seg.ord) && seg.ord > 0 ? seg.ord : (seg.from || Date.now()),
    title: seg.title || '',
    msgs: seg.msgs,
  });
  box.entries.sort((a, b) => ordOf(a) - ordOf(b));
  if (box.entries.length > KEEP) box.entries.splice(0, box.entries.length - KEEP);
  return true;
}

/**
 * `compact.archive` 的增量：arch 记着上次收到第几条。/compress 是**往后追加**的
 * （[...旧的, ...这次对话]），所以切一刀正好是这次的新账；/clear 把 compact
 * 整个清掉时 arch 归零 —— 历史里已经收下的一个字不删，只是下次从头记。
 */
function sweepArchive(box, p) {
  const arc = p.compact && Array.isArray(p.compact.archive) ? p.compact.archive : null;
  if (!arc) {
    if (box.arch) {
      box.arch = 0;
      return true;
    }
    return false;
  }
  const seen = Math.min(box.arch, arc.length);
  if (arc.length === seen) return false;
  const msgs = arc.slice(seen).map(slim).filter(Boolean);
  box.arch = arc.length;
  if (!msgs.length) return true; // 这一刀里全是工具消息：只记账，不产生空历史
  const ts = msgs.map(at).filter((t) => t);
  return store(box, `a${p.compact.at || seen}`, 'compress', {
    from: ts.length ? Math.min(...ts) : 0,
    to: ts.length ? Math.max(...ts) : 0,
    msgs,
  });
}

/** 分片目录里现在有哪些面板的账 */
function knownPanels() {
  try {
    return fs
      .readdirSync(path.join(api.workspace || '.', DIR))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

/** 槽位上限：面板没了账还在（历史是给人翻的），只丢"最久没动静"的死账 */
function prune(alive, now) {
  const ids = knownPanels();
  if (ids.length <= PANEL_KEEP) return false;
  const dead = ids.filter((id) => !alive.has(id));
  if (!dead.length) return false;
  const last = (id) => {
    const b = readBox(id);
    const e = b.entries[b.entries.length - 1];
    return ((e && e.to) || b.at || 0);
  };
  dead.sort((a, b) => last(a) - last(b));
  let over = ids.length - PANEL_KEEP;
  for (const id of dead) {
    if (over-- <= 0) break;
    try {
      fs.unlinkSync(absOf(id));
      boxes.delete(id); // 内存里那份也要跟着走，不然下一拍又把它写回去
    } catch {
      /* 删不掉就留着：清理失败不该让扫描停下 */
    }
  }
  return true;
}

/**
 * 老版本的那个大文件（所有面板挤在一起）搬到分片里来，然后把它删掉。
 * 只在第一回跑的时候做一次；搬完就没了，之后这函数几乎不干活。
 */
function migrateLegacy() {
  const legacy = path.join(api.workspace || '.', LEGACY);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(legacy, 'utf8'));
  } catch {
    return;
  }
  const panels = raw && raw.panels && typeof raw.panels === 'object' ? raw.panels : {};
  let ok = true;
  for (const [pid, box] of Object.entries(panels)) {
    const b = normBox(box);
    if (!b.entries.length) continue;
    // 已经有分片的**一个字都不动**：那份是新的，老文件可能只是"上一个实例最后
    // 又写了一次"，拿它盖回去等于把刚收下的历史退回几十秒。
    try {
      if (!fs.existsSync(absOf(pid))) writeBox(pid, b);
    } catch {
      ok = false;
    }
  }
  if (!ok) return; // 有一份没搬成就不删原件，下次再来
  try {
    fs.unlinkSync(legacy);
    api.log(t('历史会话：老的单文件历史已按面板拆开（.ensoul/state/histconv/）'));
  } catch (e) {
    api.log(t('历史会话：老文件搬完了但删不掉，留着也不碍事 ——'), (e && e.message) || e);
  }
}

/** 命令文件在哪 */
function cmdPath() {
  return path.join(api.workspace || '.', CMD_FILE);
}

/**
 * 跳过去看某一版。**这就是"回档"**：把这个面板的 chat 换成那一段，摘要一起清掉
 * （跟 /compress 一样丢掉工具消息 —— 那些是重放用的原料，不是"说过的话"）。
 * 换完当然能接着聊：它就是一段普通对话，只是比刚才短。
 *
 * 换之前**先把现在这一段收进历史** —— 跳走等于它也结束了，不收的话它连个条目
 * 都没有，用户想回来就再也找不到（而且它正是用户刚在聊的那一段，最不该丢）。
 */
function jumpTo(pid, key) {
  const box = openBox(pid);
  const target = box.entries.find((e) => e.key === key);
  if (!target || !target.msgs.length) return;
  const p = api.panels().find((x) => x.id === pid);
  if (!p) return;

  // 换之前先把现在这一段收进历史，但绝不允许用当前内容冲掉目标 target 或长记录
  const gap = isEmployee(p) ? gapMs() : Infinity;
  const segs = segmentsOf(Array.isArray(p.chat) ? p.chat : [], gap);
  const cur = segs.length ? segs[segs.length - 1] : null;
  if (cur && cur.msgs.length) {
    const curKey = box.activeKey || cur.key;
    if (curKey !== key) {
      store(box, curKey, 'end', cur);
    }
  }

  box.activeKey = key;
  box.touch = Date.now();
  box.at = Date.now();
  writeBox(pid, box);

  api.patchPanel(pid, { chat: target.msgs.slice(), compact: undefined });
}

/**
 * 开一个新的会话（`/new`）：把**当前这一段**收进左边的历史，然后把这个面板清空，
 * 从空白开始。收的那一下跟 jumpTo 一模一样，区别只在收完不回填 —— 用户要的是
 * "这一版结束了、存在左边"，接着从头聊。
 */
function newSession(p, title) {
  const box = openBox(p.id);
  const gap = isEmployee(p) ? gapMs() : Infinity;
  const all = Array.isArray(p.chat) ? p.chat : [];
  const last = all[all.length - 1];
  const isSelf = last && last.role === 'user' && /^\/new(\s|$)/.test(String(last.content || '').trim());
  const segs = segmentsOf(isSelf ? all.slice(0, -1) : all, gap);
  const cur = segs.length ? segs[segs.length - 1] : null;
  const msgs = cur && cur.msgs.length ? cur.msgs : null;
  const ttl = cleanTitle(title);
  if (msgs) {
    const curKey = box.activeKey || cur.key;
    store(box, curKey, 'end', cur);
    if (ttl) {
      const e = box.entries.find((x) => x.key === curKey);
      if (e) e.title = ttl;
    }
    box.anchor = { at: Date.now(), text: anchorOf(cur, ttl) };
  }
  // 清空面板，重置活跃 key，开启全新空白会话
  const now = Date.now();
  box.activeKey = '';
  box.touch = now;
  box.at = now;
  writeBox(p.id, box);

  api.patchPanel(p.id, {
    chat: [],
    compact: undefined,
    createdAt: now,
    updatedAt: now,
    newSessionAt: now,
  });
  if (!msgs) return t('这块面板上还没有可收的对话，已经给你一个空白会话。');
  return `已把刚才那一段收进左边的历史（${msgs.length} 条${t ? `，标题「${t}」` : ''}），`
    + t('这个面板从空白开始 —— 想回去点左边那一行就行。');
}

/** 界面递过来的一条命令 */
function runCmd(c) {
  const pid = String((c && c.pid) || '');
  if (!pid) return;
  const kind = String((c && c.kind) || '');

  if (kind === 'jump') return jumpTo(pid, String(c.key || ''));

  const box = openBox(pid);

  if (kind === 'rename') {
    const e = box.entries.find((x) => x.key === String(c.key || ''));
    if (!e) return;
    const ttl2 = cleanTitle(c.title);
    if (ttl2 === e.title) return;
    e.title = ttl2;
    e.at = Date.now();
    return writeBox(pid, box);
  }

  if (kind === 'remove') {
    const keys = new Set((Array.isArray(c.keys) ? c.keys : [c.key]).map(String));
    const n = box.entries.length;
    box.entries = box.entries.filter((e) => !keys.has(e.key));
    if (box.entries.length === n) return;
    if (keys.has(box.activeKey)) {
      box.activeKey = '';
    }
    box.at = Date.now();
    return writeBox(pid, box);
  }

  // 排序：界面给的是**从上到下**的 key，上面的名次大（跟"新的在上面"同一个方向）
  if (kind === 'reorder') {
    const order = (Array.isArray(c.keys) ? c.keys : []).map(String);
    if (!order.length) return;
    const rank = new Map(order.map((k, i) => [k, order.length - i]));
    for (const e of box.entries) {
      const r = rank.get(e.key);
      if (r) e.ord = r;
    }
    box.entries.sort((a, b) => ordOf(a) - ordOf(b));
    box.at = Date.now();
    return writeBox(pid, box);
  }

  // 从某条消息进行会话分支：把该消息及之前截出的上下文作为一个新的历史会话存入左侧列表
  if (kind === 'branch') {
    const msgId = String(c.msgId || '');
    if (!msgId) return;
    const p = api.panels().find((x) => x.id === pid);
    if (!p || !Array.isArray(p.chat)) return;
    const idx = p.chat.findIndex((m) => m && m.id === msgId);
    if (idx === -1) return;
    const msgs = p.chat.slice(0, idx + 1).map(slim).filter(Boolean);
    if (!msgs.length) return;

    // 1. 换之前先把当前完整对话收进历史兜底，防止直接被覆盖
    const gap = isEmployee(p) ? gapMs() : Infinity;
    const segs = segmentsOf(p.chat, gap);
    const cur = segs.length ? segs[segs.length - 1] : null;
    if (cur && cur.msgs.length) {
      const curKey = box.activeKey || cur.key;
      store(box, curKey, 'end', cur);
    }

    // 2. 生成全局独立的唯一分支 key
    const now = Date.now();
    const key = `b${now}_${Math.random().toString(36).slice(2, 6)}`;
    let branchTitle = c.title ? cleanTitle(c.title) : '';
    if (!branchTitle) {
      const branchMsg = msgs[msgs.length - 1];
      const preview = String(branchMsg?.content || '').replace(/\s+/g, ' ').slice(0, 12);
      branchTitle = preview ? `分支：${preview}` : t('新分支');
    }

    const entry = {
      key,
      why: 'branch',
      from: msgs[0].createdAt || now,
      to: msgs[msgs.length - 1].createdAt || now,
      ord: now,
      msgs,
      title: branchTitle,
    };
    box.entries.push(entry);
    box.entries.sort((a, b) => ordOf(a) - ordOf(b));

    // 3. 如果指定了切换到新分支
    if (c.switchToBranch) {
      box.activeKey = key;
      api.patchPanel(pid, { chat: msgs.slice(), compact: undefined });
    }
    box.at = Date.now();
    writeBox(pid, box);
    return;
  }

  // 要重新起的：把标题和"试过的时间"一起清掉，起标题那个循环自然会再问一遍
  if (kind === 'title') {
    const keys = new Set((Array.isArray(c.keys) ? c.keys : [c.key]).map(String));
    let changed = false;
    for (const e of box.entries) {
      if (!keys.has(e.key)) continue;
      if (e.title) changed = true;
      e.title = '';
      if (Number(e.titleTried)) {
        e.titleTried = 0;
        changed = true;
      }
    }
    if (changed) writeBox(pid, box);
  }
}

/** 取一次命令。按 seq 去重 —— 认的是"处理到第几条"，不是"文件里有没有东西" */
function tickCmd() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(cmdPath(), 'utf8'));
  } catch {
    return; // 文件不在 / 正在写一半：下一拍再来
  }
  const cmds = raw && Array.isArray(raw.cmds) ? raw.cmds : [];
  const fresh = cmds.filter((c) => Number(c && c.seq) > cmdSeq);
  if (!fresh.length) return;
  for (const c of fresh) {
    cmdSeq = Math.max(cmdSeq, Number(c && c.seq) || 0);
    try {
      runCmd(c);
    } catch (e) {
      api.log(t('历史会话：界面的命令没跑成 ——'), (e && e.message) || e);
    }
  }
  try {
    fs.writeFileSync(cmdPath(), JSON.stringify({ cmds: [] }), 'utf8');
  } catch {
    /* 清不掉就留着：seq 已经记下了，不会重复执行 */
  }
}

/**
 * 给还没有标题的条目起个标题。**每轮只问两个**：问的是用户自己的模型，
 * 一次把几十条全灌过去等于把人家打满，而且这事一点都不急。
 *
 * 失败（模型没配 / 接口挂了 / 一直回空）就**记在那一条上**，五分钟内不再碰它 ——
 * 按条退避，不是全局停摆：一块面板的模型坏了，别的面板照样能起标题。
 */
async function askTitles() {
  if (titling) return;
  titling = true;
  const now = Date.now();
  try {
    for (const p of api.panels()) {
      if (!p || !p.id) continue;
      const box = openBox(p.id);
      let changed = false;
      let n = 0;
      for (const e of box.entries) {
        if (n >= TITLE_PER_ROUND) break;
        if (e.title) continue;
        if (now < (Number(e.titleTried) || 0)) continue; // 这条刚试过、败了，先歇着
        const text = segText(e);
        if (!text) continue;
        n++;
        let got = '';
        try {
          got = cleanTitle(await api.askModel(p.id, { system: TITLE_SYS, user: text, maxTokens: 400 }));
          if (!got) {
            // 回了空内容：多半是思考型模型把额度烧在思考上。给足额度再问一次。
            got = cleanTitle(
              await api.askModel(p.id, {
                system: `${TITLE_SYS}\n不要思考过程，直接输出那一行标题。`,
                user: text,
                maxTokens: 2048,
              }),
            );
          }
        } catch (err) {
          api.log(t('历史会话：给这一版起标题没成 ——'), (err && err.message) || err);
        }
        if (got) {
          e.title = got;
          changed = true;
        } else {
          // 这一条先放着（界面会退回显示开头那句），五分钟后再试
          e.titleTried = now + 5 * 60000;
          changed = true;
        }
      }
      if (changed) {
        box.at = Date.now();
        writeBox(p.id, box);
      }
    }
  } finally {
    titling = false;
  }
}

module.exports = {
  params: [
    {
      key: 'gapMin',
      label: t('多久算另一次会话 / 翻篇（分钟）'),
      type: 'number',
      default: 30,
      min: 1,
      max: 1440,
      step: 5,
      hint: t('**会话边界就这一个数**：eschat（员工通讯录）不再有自己的一份，它切"当前这一次"读的就是这个值。隔了这么久没续上，就归入新的一次会话 —— 老的进右上角会话记录、并把这一段收进面板左边的历史抽屉。')
        + t('**注意：收完还会把工作面清空、员工从空白开始 —— 他会忘**（上一次的事抽屉里翻得回来）。不想要就关掉下面那个开关。')
        + t('普通面板不按时间切 —— 你不说话，对话就一直是同一次'),
    },
    {
      key: 'autoNew',
      label: t('员工到点自动翻篇（清空工作面）'),
      type: 'bool',
      default: true,
      hint: t('开（默认）：员工隔了上面那么久没续上，就把这一段收进左边抽屉、然后清空工作面 —— 他下一句开口是一个全新的会话，上一次的事不在眼前了（左边抽屉里翻得回来）。')
        + t('关：只记一版进抽屉，对话原样留着，他什么都记得。'),
    },
  ],

  name: 'histconv',
  description:
    t('历史会话：/compress 压缩前的原文、员工到点翻篇的那一段、面板收尾的对话，按面板收进 .ensoul/state/histconv/<面板 id>.json；面板最左边那条抽屉读它，点一行中间的会话就跳过去（到点翻篇 = 先收进抽屉、再把工作面清空；手动翻篇敲 /new）'),

  setup(a) {
    api = a;
    migrateLegacy();

    /**
     * 新会话开头把**接续锚点**摆一次 —— 翻篇清空工作面之后，员工已经不记得上一段
     * 干到哪了，只能去翻旧文件考古（真发生过：对着已交付的单找了十几轮令牌）。
     * 只在新会话头两轮出声（chat ≤ 3 条）：它拼在用户消息上、不进历史，讲一遍就够。
     * 消息比锚点老的不摆（从抽屉跳回旧版本不是新会话，摆了就是拿别人的收尾指错路）。
     */
    api.addPrompt((ctx) => {
      const pid = (ctx && ctx.panelId) || '';
      if (!pid) return '';
      const p = api.panels().find((x) => x.id === pid);
      if (!p || !isEmployee(p)) return '';
      const chat = Array.isArray(p.chat) ? p.chat : [];
      if (chat.length > 3) return '';
      const a = openBox(pid).anchor;
      if (!a || !a.text) return '';
      const first = chat.length ? at(chat[0]) : 0;
      if (first && first < a.at) return '';
      return t('【接续锚点】上一段会话刚翻篇 —— 下面这段是它的收尾记录，**不是用户的新消息**，')
        + t('本轮真正的指令在再下面的用户消息里：\n')
        + a.text
        + '\n动手前先核对每轮注入的派单状态（已交付/已撤单的活别重办），清单和事实冲突时以事实为准。';
    });

    const scan = () => {
      const now = Date.now();
      const gapEmp = gapMs();
      const autoNewOn = api.param('autoNew', true) !== false;
      const alive = new Set();
      /** 这一拍动过的面板：只写它们那几份文件 */
      const dirty = new Map();

      for (const p of api.panels()) {
        if (!p || !p.id) continue;
        alive.add(p.id);
        const chat = Array.isArray(p.chat) ? p.chat : [];
        const sig = `${chat.length}|${chat.length ? chat[0] && chat[0].id : ''}|${
          chat.length ? chat[chat.length - 1] && chat[chat.length - 1].id : ''
        }`;
        // 普通面板 gap = Infinity：整份对话一段，永远不会因为"隔得久"被拆开
        const gap = isEmployee(p) ? gapEmp : Infinity;

        let c = cache.get(p.id);
        const moved = !!c && c.sig !== sig;
        if (!c || c.sig !== sig) {
          c = { sig, segs: segmentsOf(chat, gap) };
          cache.set(p.id, c);
        }
        // 这块面板**刚动过没有** —— 翻篇判据看它，不看消息自己的时间戳（见 lastTouch 那段）。
        // 头一次见到（插件刚起 / 面板刚开）只**起算**，不当成"刚动过"：不然插件每重载
        // 一次就等于把所有员工工作面原地续命一遍，谁也翻不了篇。起算 + 真闲置满 gap
        // 才翻，重启最多让该翻的晚 gap 时间，不会有别的后果。
        if (moved || !lastTouch.has(p.id)) lastTouch.set(p.id, now);

        // 这块面板的账：内存里那份；这一块从来没读过才落一次盘
        const box = openBox(p.id);
        let changed = false;
        // ★ 闲置起点**接着账本算**，不是每次从 now 重新起算。
        // 从前是后者：软件每重启 / 插件每重载一次就等于把所有员工工作面原地续命一遍，
        // 闲置永远凑不满 gap —— 翻篇一次都没发生过（实测 0 例，跨 6 天的死会话反倒一堆）。
        // 老账本没有 touch：拿"眼前这一段的收尾时间"补一次，不然那些已经闲置了几天的
        // 会话还要再等整整一个 gap，等于补丁自己也给它续了一次命。
        if (!moved && !(Number(box.touch) > 0)) {
          const curSeg = c.segs.length ? c.segs[c.segs.length - 1] : null;
          const base = (curSeg && curSeg.to) || 0;
          if (base > 0 && base < now) { box.touch = base; changed = true; }
        }
        // 闲置从账本里那个时刻接着算 —— 重启、重载都不再归零。
        if (!moved && Number(box.touch) > 0 && Number(box.touch) < now) {
          const seen = lastTouch.get(p.id);
          if (!seen || Number(box.touch) < seen) lastTouch.set(p.id, Number(box.touch));
        }
        // 这一拍真的动过：把"刚刚动过"记进账本，重启之后接着算。
        if (moved && Number(box.touch) !== now) { box.touch = now; changed = true; }


        // 活跃会话实时建档与同步：第一句话说出来后就立刻出现在左侧列表，不用等收尾或翻篇。
        // 每拍都**拿眼前这一段去对**，不信账上那个 activeKey —— 它只说明"上次记到谁"，
        // 面板可能早就翻篇、被回档、被清空过（员工工作面隔 30 分钟就翻一次），那个记号
        // 落在哪一条都不该决定"哪一条算当前"。对不上就按起点和首条正文在清单里找**它自己**
        // 那一条（翻篇 / 收尾时已经收下的）；找不到才是真新的，才建一条。
        if (c.segs.length > 0) {
          const cur = c.segs[c.segs.length - 1];
          if (cur && cur.msgs.length > 0) {
            const actEntry = box.entries.find((e) => e.key === box.activeKey);
            if (!actEntry || !isSameSeg(actEntry, cur)) {
              let mine = box.entries.find((e) => isSameSeg(e, cur));
              if (!mine) {
                mine = {
                  key: keyFor(box, cur.key, cur.from),
                  why: 'active',
                  from: cur.from || now,
                  to: cur.to || now,
                  ord: now,
                  title: '',
                  msgs: cur.msgs,
                };
                box.entries.push(mine);
                box.entries.sort((a, b) => ordOf(a) - ordOf(b));
                changed = true;
              } else if (cur.msgs.length > mine.msgs.length && !sameMsgs(mine.msgs, cur.msgs)) {
                mine.msgs = cur.msgs;
                mine.to = cur.to || now;
                mine.ord = Math.max(mine.ord || 0, cur.to || now);
                changed = true;
              }
              // 当前会话的记号永远钉在**这一条**上 —— 它跟前面的 key 撞了也没关系，
              // 撞了自然会被另存成一条独立的（见 store 开头那段）。
              if (box.activeKey !== mine.key) {
                box.activeKey = mine.key;
                changed = true;
              }
            } else if (cur.msgs.length >= actEntry.msgs.length && !sameMsgs(actEntry.msgs, cur.msgs)) {
              actEntry.msgs = cur.msgs;
              actEntry.to = cur.to || now;
              actEntry.ord = Math.max(actEntry.ord || 0, cur.to || now);
              changed = true;
            }
          }
        }

        for (const s of frozenOf(c.segs, now, gap)) {
          if (store(box, s.key, 'freeze', s)) changed = true;
        }
        if (sweepArchive(box, p)) changed = true;
        if (changed) dirty.set(p.id, box);

        // 到点翻篇（见文件头第 2 条）。**必须放在冻结之后**：更早那几段得先收进 box，
        // 否则下面清空 chat 会把它们一起带走 —— 那是丢对话，不是翻篇。
        //
        // 判据 = 这块面板**多久没动**（lastTouch），不是 chat 里最后一条消息多老。
        // 两者只在一处会分岔，而那一处恰恰是用户在干的事：从抽屉点开一版几天前的
        // 历史（jumpTo 把旧消息换回 chat）—— 按消息时间判，点开下一拍就被清空。
        // gap 对普通面板是 Infinity，所以这个判据天然只落在员工工作面上。
        if (autoNewOn && p.status !== 'working' && chat.length) {
          const idle = now - (lastTouch.get(p.id) || now);
          if (idle > gap) {
            try {
              const said = newSession(p, '');
              cache.delete(p.id); // 刚清空：这一拍的快照作废，下一拍按新 chat 重算
              lastTouch.set(p.id, now); // 空会话从这一刻起算，不会连着翻
              api.log(`[histconv] ${p.title || p.id} 到点翻篇 —— ${said}`);
            } catch (e) {
              api.log(t('[histconv] 翻篇没成：'), (e && e.message) || e);
            }
          }
        }
      }

      // 收尾：上一拍还在、这一拍没了的面板（关掉 / 收进收纳区）。对话区里那一次
      // 还没等到上面的判据 —— 拿内存里的快照落底，不然面板一走就再也读不到 chat 了。
      for (const id of prevAlive) {
        if (alive.has(id)) continue;
        const c = cache.get(id);
        if (c) {
          const box = openBox(id);
          let changed = false;
          for (const s of c.segs) if (store(box, s.key, 'end', s)) changed = true;
          if (changed) dirty.set(id, box);
        }
        cache.delete(id);
      }
      prevAlive = alive;

      // 这张表只为**活着的工作面**记时间：面板关了/删了就不该再占着。
      // （再出现时按"头一次见到"重新起算，顶多多等一个 gap，不会误翻。）
      for (const id of [...lastTouch.keys()]) if (!alive.has(id)) lastTouch.delete(id);

      for (const [pid, box] of dirty) {
        box.at = now;
        writeBox(pid, box);
      }

      prune(alive, now);
    };

    scan(); // 头一拍就干活，界面不用等第一个 tick
    const tick = setInterval(() => {
      try {
        scan();
      } catch (e) {
        api.log(t('扫历史会话出错：'), (e && e.message) || e); // 一个坏面板不许让整个插件停摆
      }
    }, TICK_MS);
    if (tick.unref) tick.unref();
    timer = tick;

    // 界面的动作走命令文件：点一行要"马上跳过去"，不能等那个 2 秒的扫描
    try {
      tickCmd();
    } catch {
      /* 头一拍读不到就当没有 */
    }
    const ct = setInterval(() => {
      try {
        tickCmd();
      } catch (e) {
        api.log(t('历史会话：取界面命令出错 ——'), (e && e.message) || e);
      }
      // 起标题慢（要问模型），跟取命令分开跑：它自己会挡住重入
      void askTitles();
    }, CMD_MS);
    if (ct.unref) ct.unref();
    cmdTimer = ct;

    /**
     * `/new` —— 开一个新的会话：把当前这一段收进左边的历史，面板清空重开。
     * 跟 /clear 差在"收不收"：/clear 是丢掉，这条是**存档**（所以住在这儿，
     * 记账的手只有这一双）。`/new 标题` 顺手把标题也定了。
     */
    api.addCommand(
      {
        id: 'new',
        label: t('开新会话'),
        hint: t('/new [标题] —— 把当前这段收进左边历史，这个面板从空白重新开始'),
      },
      (argText, ctx) => {
        const pid = (ctx && ctx.panelId) || '';
        if (!pid) return t('命令没有执行：不知道是哪块面板。');
        const p = api.panels().find((x) => x.id === pid);
        if (!p) return `命令没有执行：找不到面板 ${pid}。`;
        return newSession(p, argText);
      },
    );

    api.log(t('历史会话就绪（每块面板一份：.ensoul/state/histconv/<面板 id>.json）'));
  },

  /** 插件被停用/重载时收拾自己的摊子 */
  dispose() {
    if (timer) clearInterval(timer);
    timer = null;
    if (cmdTimer) clearInterval(cmdTimer);
    cmdTimer = null;
    cache.clear();
    boxes.clear();
    prevAlive = new Set();
    lastTouch.clear();
  },
};
