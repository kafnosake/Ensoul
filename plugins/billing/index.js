/**
 * 实时计费 —— 把整个软件里**所有**模型调用按天、按模型算成钱。
 *
 * 治的是这个：软件里同时有好几块面板在跑（还有后台的员工会话），一轮一轮花掉的
 * token 散在每条助手消息的 stats 里，谁也说不清"今天这个模型花了多少"。
 * 这个插件把那本账收拢起来，面板（kind: billing）只是它的显示器。
 *
 * 钱**不在这里重算**：核心在开工那一刻就把当时的单价快照连同三档费用写进了
 * 每条消息的 stats.cost（见 src/main/index.ts 的 accountOf、providers.ts 的 costOf），
 * 命中 / 未命中 / 输出分档和峰谷价它已经算过了。所以模型列表里没标价的（免费模型）
 * 自然就是"只计量不计费"：核心算不出钱，这里也不编一个。
 *
 * 落盘（不开 IPC）：
 *   .ensoul/state/billing/days/2026-10-02.jsonl  一行一笔，**追加写** —— 当天的明细
 *   .ensoul/state/billing/summary.json           水位线 / 分支 / **按天合计**（不存明细，所以不随天数涨）
 *   .ensoul/state/billing.feed.json              面板读的那份（明细有界，见 FEED_KEEP）
 *   .ensoul/state/billing.live.json              跑动中那一轮（小文件，每跳都在变）
 *   .ensoul/state/billing.cmd.json               面板写、插件读（打分支 / 切分支 / 删分支）
 *
 * 为什么**不是**一整份 JSON 账本：那样每进一笔账都要整份重写（已经长到 330KB），
 * 写得越来越慢；更糟的是写在半路断电，整本 parse 不了 —— 一笔都读不回来。
 * 追加写只碰末尾那一行，断电最多丢最后一行（读的时候跳过就是）。
 *
 * 保留策略三档（都能调，见 PARAMS）：
 *   0 到 rawDays 天   逐笔明细，按自然日分片（jsonl）。面板按天、按模型聚合用这一档
 *   rawDays 之后      只留**按模型合计**（轮次记录不保存），折进 summary.json 一个文件
 *   keepDays 之后     连合计一起删。默认 0 = **永不删** —— 这是账单，删了找不回来；
 *                     想自动清就在设置里填天数
 *
 * 账是**工作区级**一份（跟 git 局面同级）：花掉的钱不因为面板关了、对话清了就消失。
 * 分支是**面板私有**的（branches[panelId]）—— 谁打的点归谁比，两块面板互不串味。
 */

const fs = require('fs');
const path = require('path');

/** 换行。不用反斜杠转义写它，是因为这个文件是整段生成出来的，越少转义越不容易写歪 */
const NL = String.fromCharCode(10);

/** 账本目录：明细按自然日分片放在这里 */
const DIR = '.ensoul/state/billing';
/** 分片目录 */
const DAYS_DIR = DIR + '/days';
/** 汇总（水位线、分支、按天合计）—— 不存明细，所以不随天数涨 */
const SUMMARY_FILE = DIR + '/summary.json';
/** 老版本把整本账放在这一个文件里。见 migrate() */
const LEGACY_FILE = '.ensoul/state/billing.json';
/** 面板读的那份：**有界**，见 FEED_KEEP */
const FEED_FILE = '.ensoul/state/billing.feed.json';
/** 跑动中那一轮的实时账（小文件，随时在变） */
const LIVE_FILE = '.ensoul/state/billing.live.json';
/** 面板写命令、插件读。每条命令都带 panelId：认得出这个点是谁打的 */
const CMD_FILE = '.ensoul/state/billing.cmd.json';

const DAY = 86400000;
/** 多久扫一遍账（读的是内存里的面板表，很快；命令文件也就几百字节） */
const TICK = 2000;
/**
 * 明细最多留多少条给面板。**这个数是被另一头上限管着的**：
 * 面板读文件走核心的 fs:read，超过 300KB 它只回一句占位文字（见 src/main/fsapi.ts
 * 的 readText）—— 一条明细紧凑写下来约 150 字节，300KB 只装得下 1500 条上下。
 */
const FEED_KEEP = 900;
/** 参数能把它调到多大 —— 再大就要撞 300KB 那道坎了 */
const FEED_SAFE_MAX = 1300;
/** 一块面板最多留几个分支：它是拿来对比工作流的，不是账本 */
const MAX_BRANCHES = 40;
/** 彻底不清理时按天合计最多留这么多天（约三年半）—— 总得有个头 */
const MAX_SUMMARY_DAYS = 1300;

/** 一个合计桶（按天合计、按模型合计都用这个形状；轮次记录不在这里） */
function newBucket() {
  return { rounds: 0, tin: 0, tout: 0, hit: 0, miss: 0, cost: 0, ch: 0, cm: 0, co: 0, free: 0 };
}

/**
 * 可调参数。只放"不同的人会设成不同值"的东西；面板上的选中态是那块面板自己的事。
 */
const PARAMS = {
  interval: {
    label: t('扫描间隔（秒）'),
    type: 'number',
    default: 2,
    min: 1,
    max: 60,
    hint: t('多久重新扫一遍所有面板的用量账'),
  },
  rawDays: {
    label: t('逐笔明细保留几天'),
    type: 'number',
    default: 7,
    min: 1,
    max: 90,
    hint: t('这么多天内的账按自然日分片存着，面板能按天、按模型摊开看；更早的折成合计，只留总数'),
  },
  keepDays: {
    label: t('合计保留几天（0 = 永久）'),
    type: 'number',
    default: 0,
    min: 0,
    max: 3650,
    hint: t('超过就从合计里删掉。默认 0 = 永不删 —— 这是账单，删了找不回来'),
  },
  keep: {
    label: t('面板明细条数上限'),
    type: 'number',
    default: FEED_KEEP,
    min: 200,
    max: FEED_SAFE_MAX,
    hint: t('面板一次读文件有 300KB 上限，条数调太高面板就读不动了'),
  },
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, num(v)));

/** 自然日键（**本地时区**）：2026-10-02。归档按人过的日子分，不按 UTC */
function dayKey(ms) {
  const d = new Date(num(ms));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/** 分片文件名是不是一天的分片（不写正则：这个文件里一个反斜杠都不要有） */
function isShardName(n) {
  return n.length === 16 && n.slice(4, 5) === '-' && n.slice(7, 8) === '-' && n.slice(10) === '.jsonl';
}

/**
 * 把一条助手消息的 stats 折成一条明细。
 *
 * cost 三种取值要分清（跟 ChatStats.price 一样的意思）：
 *   null  → 这个模型没标价（免费 / 未定价），**只计量不计费**
 *   数字  → 这一轮实际花的钱（核心按当时的价算好的）
 */
function entryOf(m) {
  const s = m && m.stats;
  if (!s) return null;
  const tin = Math.max(0, num(s.tokensIn));
  const tout = Math.max(0, num(s.tokensOut));
  // 一个字都没花（比如没配密钥那一轮）就不入账，免得零头把"轮数"撑起来
  if (!tin && !tout) return null;
  const hit = Math.max(0, Math.min(num(s.cacheHit), tin));
  const c = s.cost;
  const cost = c
    ? Number.isFinite(Number(c.total))
      ? Number(c.total)
      : num(c.hit) + num(c.miss) + num(c.out)
    : null;
  return {
    /** 消息 id —— 扫多少遍都只会入账一次 */
    id: String(m.id || ''),
    at: num(s.at) || num(m.createdAt),
    /** 这一轮用的模型（provider::model）；空串 = 加这个字段之前的旧记录 */
    pick: String(s.pick || ''),
    tin: tin,
    tout: tout,
    hit: hit,
    miss: Math.max(0, tin - hit),
    cost: cost,
    /**
     * 花费也按三档拆开留着（缓存命中 / 未命中输入 / 输出）——
     * 面板那根"价格柱"要按这三截画，只有总价是拆不出来的。
     * 加这三项之前的老账里没有（= 0），面板会把总价画成一整截。
     */
    ch: c ? num(c.hit) : 0,
    cm: c ? num(c.miss) : 0,
    co: c ? num(c.out) : 0,
  };
}

/** 磁盘上的一条明细：可能是旧的、或者被手改坏了 —— 只信字段齐全的那部分 */
function normEntry(e) {
  if (!e || typeof e !== 'object' || !e.id) return null;
  return {
    id: String(e.id),
    at: num(e.at),
    pick: String(e.pick || ''),
    tin: Math.max(0, num(e.tin)),
    tout: Math.max(0, num(e.tout)),
    hit: Math.max(0, num(e.hit)),
    miss: Math.max(0, num(e.miss)),
    cost: e.cost === null || e.cost === undefined ? null : num(e.cost),
    // 花费的三档拆分。老账里没有（= 0），面板会把总价画成一整截
    ch: Math.max(0, num(e.ch)),
    cm: Math.max(0, num(e.cm)),
    co: Math.max(0, num(e.co)),
  };
}

/** 磁盘上的一个合计桶 */
function normBucket(v) {
  const b = newBucket();
  if (!v || typeof v !== 'object') return b;
  b.rounds = Math.max(0, num(v.rounds));
  b.tin = Math.max(0, num(v.tin));
  b.tout = Math.max(0, num(v.tout));
  b.hit = Math.max(0, num(v.hit));
  b.miss = Math.max(0, num(v.miss));
  b.cost = Math.max(0, num(v.cost));
  b.ch = Math.max(0, num(v.ch));
  b.cm = Math.max(0, num(v.cm));
  b.co = Math.max(0, num(v.co));
  b.free = Math.max(0, num(v.free));
  return b;
}

/** 把一条明细并进一个合计桶 */
function addTo(x, e) {
  x.rounds += 1;
  x.tin += e.tin;
  x.tout += e.tout;
  x.hit += e.hit;
  x.miss += e.miss;
  if (e.cost === null) x.free += 1;
  else {
    x.cost += e.cost;
    x.ch += e.ch;
    x.cm += e.cm;
    x.co += e.co;
  }
}

/** 把多个合计桶并成一个（写面板那份时要用） */
function mergeInto(x, v) {
  x.rounds += v.rounds;
  x.tin += v.tin;
  x.tout += v.tout;
  x.hit += v.hit;
  x.miss += v.miss;
  x.cost += v.cost;
  x.ch += v.ch;
  x.cm += v.cm;
  x.co += v.co;
  x.free += v.free;
}

/** 汇总文件的空白形状（**不含明细**：明细在分片里） */
function blank() {
  return {
    at: 0,
    /**
     * 明细起点（ms）：at >= 它 的账才算"逐笔明细"，比它早的已经在 days 合计里了。
     * 它同时是防重复计的闸门（重启后把老分片捞回来时，靠它把已经折过的挡在外面）。
     */
    detailFrom: 0,
    /**
     * 按自然日的合计：{ '2026-10-02': { 'provider::model': 桶 } }。
     * 只有"已经不在明细里"的账会落这儿 —— 轮次记录不保存，只留能调用的总数。
     */
    days: {},
    /** 折进合计的轮次总数 */
    dropped: 0,
    seq: 0,
    /** 已处理过多少轮、处理到哪一刻 —— 明细被折走之后靠它们防重复计（见 collect 里的水位线） */
    rounds: 0,
    maxAt: 0,
    processedUpTo: 0,
    branches: {},
    selected: {},
  };
}

/** 读一份 JSON；没有 / 坏了都给 null，绝不抛 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 写一份 JSON（缺的目录自己建）。写不出去也不抛：下一跳还会试 */
function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function loadSummary(file) {
  const out = blank();
  const raw = readJson(file);
  if (!raw || typeof raw !== 'object') return out;

  out.detailFrom = Math.max(0, num(raw.detailFrom));
  out.dropped = Math.max(0, num(raw.dropped));
  out.seq = Math.max(0, num(raw.seq));
  out.rounds = Math.max(0, num(raw.rounds));
  out.maxAt = Math.max(0, num(raw.maxAt));
  out.processedUpTo = Math.max(0, num(raw.processedUpTo)) || out.maxAt;

  const days = raw.days && typeof raw.days === 'object' ? raw.days : {};
  for (const day of Object.keys(days)) {
    const byModel = days[day];
    if (!byModel || typeof byModel !== 'object') continue;
    const bucket = {};
    for (const k of Object.keys(byModel)) bucket[String(k)] = normBucket(byModel[k]);
    out.days[String(day)] = bucket;
  }

  const br = raw.branches && typeof raw.branches === 'object' ? raw.branches : {};
  for (const pid of Object.keys(br)) {
    const arr = br[pid];
    if (!Array.isArray(arr)) continue;
    const keep = [];
    for (const b of arr) {
      if (!b || typeof b !== 'object' || !b.id) continue;
      keep.push({ id: String(b.id), at: num(b.at), label: String(b.label || '') });
    }
    if (keep.length) out.branches[pid] = keep.slice(-MAX_BRANCHES);
  }

  const sel = raw.selected && typeof raw.selected === 'object' ? raw.selected : {};
  for (const pid of Object.keys(sel)) out.selected[pid] = String(sel[pid] || '');

  return out;
}

/** 某一天分片文件的路径 */
function shardPath(root, day) {
  return path.join(root, DAYS_DIR, day + '.jsonl');
}

/**
 * 往某一天的分片**追加**几笔。一行一笔，断了只断最后一行。
 * 用 appendFileSync：这是这个插件唯一一处"写账"，必须是追加、不能是重写。
 */
function appendShard(root, day, rows) {
  try {
    fs.mkdirSync(path.dirname(shardPath(root, day)), { recursive: true });
    const text = rows.map((r) => JSON.stringify(r)).join(NL) + NL;
    fs.appendFileSync(shardPath(root, day), text, 'utf8');
    return true;
  } catch {
    return false; // 写不出去不影响后面：下一跳会重试（这一跳的账还在内存里）
  }
}

/** 分片目录里现在有哪些自然日（升序） */
function shardDays(root) {
  try {
    return fs
      .readdirSync(path.join(root, DAYS_DIR))
      .filter(isShardName)
      .map((n) => n.slice(0, 10))
      .sort();
  } catch {
    return [];
  }
}

/**
 * 把明细捞回来：读所有分片，按时刻排好。
 *
 * from 之下的行**不读回来**：那些已经折进合计了（在 days 里），
 * 再捞一遍就是同一笔钱算两次。
 */
function loadDetail(root, from) {
  let names = [];
  try {
    names = fs.readdirSync(path.join(root, DAYS_DIR));
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    if (!isShardName(name)) continue;
    let text = '';
    try {
      text = fs.readFileSync(path.join(root, DAYS_DIR, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(NL)) {
      if (!line) continue;
      let e = null;
      try {
        e = normEntry(JSON.parse(line));
      } catch {
        e = null; // 断电时写了一半的那一行 —— 跳过就是
      }
      if (!e || e.at < from) continue;
      rows.push(e);
    }
  }
  rows.sort((a, b) => a.at - b.at);
  return rows;
}

/**
 * 老版本一次性搬家：把整本 billing.json 拆成"分片 + 汇总"，然后把旧文件改名 .bak。
 *
 * 只在**新结构还不存在**时做一次。改名的意思是不删旧文件 ——
 * 万一搬哪儿不对，那本账还在原地，能人工捞。
 */
function migrate(root) {
  if (fs.existsSync(path.join(root, SUMMARY_FILE))) return false;
  const legacy = path.join(root, LEGACY_FILE);
  if (!fs.existsSync(legacy)) return false;

  const raw = readJson(legacy);
  if (!raw || typeof raw !== 'object') return false;

  const byDay = {};
  const list = Array.isArray(raw.entries) ? raw.entries : [];
  for (const e of list) {
    const x = normEntry(e);
    if (!x) continue;
    const day = dayKey(x.at);
    (byDay[day] || (byDay[day] = [])).push(x);
  }
  for (const day of Object.keys(byDay).sort()) appendShard(root, day, byDay[day]);

  const sm = blank();
  sm.seq = Math.max(0, num(raw.seq));
  sm.rounds = Math.max(0, num(raw.rounds));
  sm.maxAt = Math.max(0, num(raw.maxAt));
  sm.processedUpTo = Math.max(0, num(raw.processedUpTo)) || sm.maxAt;
  sm.dropped = Math.max(0, num(raw.dropped));
  sm.branches = raw.branches && typeof raw.branches === 'object' ? raw.branches : {};
  sm.selected = raw.selected && typeof raw.selected === 'object' ? raw.selected : {};

  /**
   * 老账本里已经折过的那部分（过去没有日期，只有总数）落在 legacy 这一天。
   * 它排在所有真实日期之前，语义正好是"更早的账"，删除时也永远不碰它。
   */
  const past = raw.past && typeof raw.past === 'object' ? raw.past : {};
  if (Object.keys(past).length) {
    const bucket = {};
    for (const k of Object.keys(past)) bucket[String(k)] = normBucket(past[k]);
    sm.days.legacy = bucket;
  }

  writeJson(path.join(root, SUMMARY_FILE), sm);
  try {
    fs.renameSync(legacy, legacy + '.bak');
  } catch {
    /* 改不了名也认了：新结构已经就位，旧文件不再被读 */
  }
  return true;
}

/** 模块级：dispose 要能收掉它（插件文件改了会重装，旧的那份靠这个收摊） */
let timer = null;

module.exports = {
  params: PARAMS,
  name: 'billing',
  description:
    t('把整个软件的 API 用量按天、按模型算成钱'),

  /**
   * 自带一种面板类型。声明是**纯数据**（要过 IPC，函数过不去），
   * 脸在 panel.tsx、皮在 panel.css。声明必须写在 module.exports **里面**。
   */
  panel: {
    kind: 'billing',
    label: t('实时计费'),
    hint: t('按天按模型看 token 用量与花费，可打分支比增量'),
    title: t('实时计费'),
    body: 'messages',
  },

  setup(api) {
    const root = path.dirname(api.dataPath('.ensoul'));
    const summaryPath = path.join(root, SUMMARY_FILE);
    const feedPath = path.join(root, FEED_FILE);
    const livePath = path.join(root, LIVE_FILE);
    const cmdPath = path.join(root, CMD_FILE);

    const moved = migrate(root);
    const state = loadSummary(summaryPath);

    const tickMs = Math.max(1, num(api.param('interval', TICK / 1000)) || TICK / 1000) * 1000;
    // 夹在安全区里：参数是给"面板读得动"用的，调过头这个插件就自己把自己读瞎了
    const maxKeep = clamp(api.param('keep', FEED_KEEP) || FEED_KEEP, 200, FEED_SAFE_MAX);
    const rawDays = clamp(api.param('rawDays', 7) || 7, 1, 90);
    const keepDays = clamp(api.param('keepDays', 0), 0, 3650);

    /** 明细的内存镜像（起点 = state.detailFrom），面板看到的"这一段"就是它 */
    const detail = loadDetail(root, state.detailFrom);
    /** 已经入过账的消息 id —— 重扫多少遍都不会重复计 */
    const known = new Set(detail.map((e) => e.id));

    let lastSeq = 0;
    /** 上一份实时账的文本 —— 没变就不写盘 */
    let lastLiveText = '';
    /** 上一份面板账的文本 —— 同上 */
    let lastFeedText = '';
    /** 这一跳动过汇总（折了账 / 清过分片 / 收过命令）—— 那就得落盘 */
    let dirty = false;
    /** collect 这一跳看到的"跑动中"汇总，交给 writeLive 去写 */
    let liveNow = { at: 0, rounds: 0, cost: 0, tin: 0, tout: 0 };

    const saveSummary = () => {
      state.at = Date.now();
      writeJson(summaryPath, state);
    };

    /** 命令队列：面板写的那些点。每条都带 panelId，动作落在那块面板自己的分支槽里 */
    function readCmdQueue() {
      const j = readJson(cmdPath);
      return Array.isArray(j && j.cmds) ? j.cmds : [];
    }

    /**
     * 把处理过的清掉。只清 seq 不大于 upto 的那些 ——
     * 读完之后面板又写进来的命令不能被这把清空带走（那是看得见的"点了没反应"）。
     */
    function clearCmdQueue(upto) {
      try {
        const rest = readCmdQueue().filter((c) => num(c && c.seq) > upto);
        fs.writeFileSync(cmdPath, JSON.stringify({ cmds: rest.slice(-20) }), 'utf8');
      } catch {
        /* 清不掉就留着，seq 已经记住，同一批不会被执行两次 */
      }
    }

    /**
     * 一条命令。分支持在 state.branches[panelId] 里 —— 打点是"这块面板要比较的两段"，
     * 不是全局事实，所以按面板分槽。
     */
    function applyCmd(raw, now) {
      const pid = String((raw && raw.panelId) || '');
      if (!pid) return false;
      const list = state.branches[pid] || (state.branches[pid] = []);

      switch (raw && raw.cmd) {
        case 'branch': {
          const at = num(raw.at) || now;
          // 同一毫秒点两下不该长出两个点
          if (list.some((b) => b.at === at)) return false;
          state.seq = Math.max(0, num(state.seq)) + 1;
          const id = 'b' + state.seq.toString(36) + at.toString(36).slice(-4);
          list.push({ id: id, at: at, label: t('分支 ') + state.seq });
          if (list.length > MAX_BRANCHES) list.shift();
          state.selected[pid] = id; // 打完点就切到它：用户接下来要看的就是"从这里起"
          return true;
        }
        case 'delbranch': {
          const want = String(raw.id || '');
          const i = list.findIndex((b) => b.id === want);
          if (i < 0) return false;
          list.splice(i, 1);
          if (state.selected[pid] === want) delete state.selected[pid];
          return true;
        }
        case 'select': {
          const want = String(raw.id || '');
          if (want && !list.some((b) => b.id === want)) return false;
          state.selected[pid] = want;
          return true;
        }
        default:
          return false;
      }
    }

    /** 一条要离开明细的账：按它自己那一天、按模型折进合计（轮次记录不留） */
    function fold(e) {
      const day = dayKey(e.at);
      const byModel = state.days[day] || (state.days[day] = {});
      const k = e.pick || '';
      const x = byModel[k] || (byModel[k] = newBucket());
      addTo(x, e);
      state.dropped = num(state.dropped) + 1;
      dirty = true;
    }

    /**
     * 把这一刻面板表上的账收下来，再把超出窗口的折进合计。返回这一跳收了几笔、实时数。
     *
     * 每条消息入账一次（按消息 id 去重）：面板被关、对话被清之后，**已经花掉的钱照旧留着**，
     * 它是这一整个工作区的账，不是某个面板的。
     */
    function collect(now) {
      let added = 0;
      /** 处理过的轮次总数（含没有 token 的那些）—— 变了就得落盘，哪怕没新增明细 */
      const roundsBefore = num(state.rounds);
      /**
       * 水位线：明细折走之后，被折掉的那一批在重启时**会重新出现在面板的 chat 里**
       * （它们本来就还在，被折掉的只是账里的副本）。水位线就是"已经处理到哪一刻"——
       * 比它更早的一律不再入账，于是 dropped 这个数才真的是折了、不会变成重复计。
       */
      const watermark = num(state.processedUpTo);
      const live = { at: now, rounds: 0, cost: 0, tin: 0, tout: 0 };
      const fresh = [];

      for (const p of api.panels()) {
        for (const m of p.chat || []) {
          if (!m || m.role !== 'assistant' || !m.stats) continue;
          if (known.has(m.id)) continue;
          // 已经折走的旧轮次：它早入过账了，只是明细里没留 —— 不能再算一遍
          if (m.stats.at && m.stats.at < watermark) continue;
          known.add(m.id);
          state.rounds = num(state.rounds) + 1;
          state.maxAt = Math.max(num(state.maxAt), num(m.stats.at) || num(m.createdAt));
          const e = entryOf(m);
          if (e) fresh.push(e);
        }
        // 正在跑的那一轮：它的账要到整轮跑完才进 chat，可钱已经在花了
        if (p.live) {
          live.rounds += 1;
          live.tin += Math.max(0, num(p.live.tokensIn));
          live.tout += Math.max(0, num(p.live.tokensOut));
          live.cost += p.live.cost ? num(p.live.cost.total) : 0;
        }
      }

      if (fresh.length) {
        // 按时刻排一下：面板那边按模型聚合、按分支切段，有序的输入看着也顺
        fresh.sort((a, b) => a.at - b.at);
        /** 按自然日攒成一批，一天只开一次文件（同一秒来十条账也只追加一次） */
        const byDay = {};
        for (const e of fresh) {
          // 比明细起点还早的（面板刚被打开时补记的旧账）：直接进合计，不建分片 ——
          // 那个分片早就归档走人了，再建一个就是把折过的日子复活
          if (e.at < num(state.detailFrom)) fold(e);
          else {
            const day = dayKey(e.at);
            (byDay[day] || (byDay[day] = [])).push(e);
            detail.push(e);
            added += 1;
          }
        }
        for (const day of Object.keys(byDay).sort()) appendShard(root, day, byDay[day]);
        if (added) detail.sort((a, b) => a.at - b.at);
        // 收完这一跳才抬水位线：抬早了会把这一跳真进来的账挡在门外
        state.processedUpTo = Math.max(num(state.processedUpTo), num(state.maxAt));
      }

      /**
       * 窗口推进 + 条数上限，**每跳都做**（很便宜）。
       *
       * 两件事：rawDays 之前的明细折进合计、条数超过上限的折进合计。
       * 折 = 数字进 days 合计，逐笔轮次记录不留。
       */
      /*
       * 起点只在**真折了账**的时候才抬。
       *
       * 不能让 now - rawDays 每跳都往前拱：那样这个数每 2 秒都变一次，
       * 面板读的那份（含 900 条明细）就得跟着每 2 秒重写一遍 —— 白写。
       */
      const cut = now - rawDays * DAY;
      let folded = 0;
      let i = 0;
      while (i < detail.length) {
        if (detail[i].at < cut) {
          fold(detail[i]);
          detail.splice(i, 1);
          folded += 1;
        } else i += 1;
      }
      if (folded) state.detailFrom = Math.max(num(state.detailFrom), cut);
      const over = detail.length - maxKeep;
      if (over > 0) {
        for (const e of detail.slice(0, over)) fold(e);
        detail.splice(0, over);
        // 起点跟着抬：这些账已经进合计了，重启时不能再从分片捞回来算一遍
        state.detailFrom = detail.length ? detail[0].at : num(state.detailFrom);
      }

      // 已经折空的分片（整天的账都进合计了）就把文件收掉：一个日子一个文件，不留空壳
      const keepDay = dayKey(num(state.detailFrom));
      for (const day of shardDays(root)) {
        if (day >= keepDay) break; // 已升序，到了明细覆盖的那天就停
        try {
          fs.unlinkSync(shardPath(root, day));
        } catch {
          /* 删不掉就留着，下次再试 —— 它已经不会影响计账（loadDetail 会跳过旧行） */
        }
      }

      /**
       * 合计的过期清理。**默认不删**（keepDays = 0）：这是账单，删了找不回来。
       * 想自动瘦身的人把它设成 30，30 天以前那几天就整个消失。
       */
      if (keepDays > 0) {
        const cutDay = dayKey(now - keepDays * DAY);
        for (const day of Object.keys(state.days)) {
          if (day === 'legacy') continue; // 老账没有日期，只能按"永久"对待
          if (day < cutDay) {
            delete state.days[day];
            dirty = true;
          }
        }
      }
      // 谁也没设 keepDays 时也得有个头：约三年半
      const allDays = Object.keys(state.days).sort();
      if (allDays.length > MAX_SUMMARY_DAYS) {
        for (const day of allDays.slice(0, allDays.length - MAX_SUMMARY_DAYS)) {
          if (day === 'legacy') continue;
          delete state.days[day];
          dirty = true;
        }
      }

      return { added: added, roundsChanged: roundsBefore !== num(state.rounds), live: live };
    }

    /** 实时账单独一份小文件：跑动中的数字每跳都在变，不该拖着整份明细一起重写 */
    function writeLive() {
      const text = JSON.stringify(liveNow);
      if (text === lastLiveText) return;
      lastLiveText = text;
      try {
        fs.writeFileSync(livePath, text, 'utf8');
      } catch {
        /* 写不出去也不影响记账，下一跳还会试 */
      }
    }

    /**
     * 面板读的那份 —— 明细 + 折过的合计 + 分支，紧着写（不带缩进）且明细有界。
     *
     * 为什么还要这一份：明细分了片之后单日确实远不到 300KB，可**面板的时间窗是
     * 24 小时 / 7 天 / 30 天**，一个窗口要跨好几个分片读 —— 每 2 秒读七八个文件，
     * 还得自己处理"正好读在追加那一瞬间"。合成一份给它读，一次一个文件，稳。
     */
    function writeFeed() {
      /** 折过的账按模型并成一份（面板要拿它算"全部"的合计） */
      const past = {};
      for (const day of Object.keys(state.days)) {
        const byModel = state.days[day];
        for (const k of Object.keys(byModel)) {
          const x = past[k] || (past[k] = newBucket());
          mergeInto(x, byModel[k]);
        }
      }
      const text = JSON.stringify({
        at: state.at,
        /** 明细起点：比它早的账只在 past 里（面板据此判断"这一段要不要把合计算进来"） */
        feedFrom: state.detailFrom,
        dropped: state.dropped,
        rounds: state.rounds,
        rawDays: rawDays,
        keepDays: keepDays,
        past: past,
        entries: detail,
        branches: state.branches,
        selected: state.selected,
      });
      if (text === lastFeedText) return;
      lastFeedText = text;
      try {
        fs.writeFileSync(feedPath, text, 'utf8');
      } catch {
        /* 写不出去也不影响记账，下一跳还会试 */
      }
    }

    function tick() {
      const now = Date.now();
      dirty = false;

      let maxSeq = lastSeq;
      for (const raw of readCmdQueue()) {
        const s = num(raw && raw.seq);
        if (!Number.isFinite(s) || s <= lastSeq) continue; // 已经执行过的
        maxSeq = Math.max(maxSeq, s);
        if (applyCmd(raw, now)) dirty = true;
      }
      if (maxSeq > lastSeq) {
        lastSeq = maxSeq;
        clearCmdQueue(maxSeq);
      }

      const res = collect(now);
      if (res.added || res.roundsChanged) dirty = true;
      liveNow = res.live;

      writeLive();
      writeFeed();

      if (dirty) saveSummary();
    }

    timer = setInterval(tick, tickMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    // 头一跳立刻跑一次，别让面板空等一个间隔
    tick();

    const keepNote = keepDays > 0 ? '、合计留 ' + keepDays + ' 天' : '、合计永久保留';
    const moveNote = moved ? t('；已把老的 billing.json 搬成新结构') : '';
    api.log(
      t('实时计费就绪（明细 ') +
        DAYS_DIR +
        t('/<日子>.jsonl，汇总 ') +
        SUMMARY_FILE +
        t('，明细留 ') +
        rawDays +
        t(' 天') +
        keepNote +
        moveNote +
        t('，每 ') +
        tickMs / 1000 +
        t(' 秒扫一遍）'),
    );
  },

  dispose() {
    if (timer) clearInterval(timer);
    timer = null;
  },
};
