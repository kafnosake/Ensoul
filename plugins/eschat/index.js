/**
 * eschat（eschat）—— 脑（主进程那一半）。
 *
 * 把公司名册里的 AI 员工组织为即时通讯名册：**一个员工一个联系人**，点开就是他那块"工作面"的
 * 对话，打字就是发给他；他跑完这一轮，回答落回同一个对话流里。单位不是"会话"，是"人"。
 *
 * ── 员工平时待在**后台**，你点谁才叫谁 ───────────────────────────────
 *
 * 「后台」是核心给的一种面板状态（`Panel.hidden`）：面板活在面板表里、**不进任何停靠树** ——
 * 界面上一个字都不显示，但收得到消息、跑得完这一轮，对话照旧落在它自己的 chat 里。
 * 员工要的正是这个：一直在岗，不占你的布局。
 *
 * 于是这里的规矩是：
 *
 * ── 会话是**按次**看的，不是一条长河 ─────────────────────────────────
 *
 * 一个员工的 chat 是一条长线，但人回忆它的时候是按"一次一次对话"的 ——
 * 隔了一段时间再聊，前面那些不会一直摊在下面就成"上一条消息"。
 *
 *   相邻两句话隔超过**会话边界**（默认 30 分钟）→ 就是**另一次会话**
 *   这个数**不归这边管**：唯一真源是 plugins/histconv 的 `gapMin`，这边读同一个键
 *   （见下面的 `histGap`）—— 一份声明、一处修改，不会再出现"改了一边没反应"。
 *   下面只显示**当前这一次**（当前这一段是现算的，不落盘）
 *   更早的按次列在右上角的**会话记录**里 —— 读的是**会话栏左侧那条「历史会话」
 *   的同一份账**（`.ensoul/state/histconv/<面板 id>.json`，plugins/histconv 写的）：
 *   标题是同一个，rail 上改名 / 删除 / 排序，这边跟着一模一样。一处账、两处读。
 *   点一次 → 整段对话挤出来给你回忆（rail 上点一下是**跳过去**，两边各是各的动作）
 *
 * 这不改面板本身：上下文还是连着的那一条线，员工照样记得之前说过什么。
 * 变的是**读法** —— 一次会话是一个整体，不是一个一个消息。
 *
 * ── 员工平时待在**后台**，你点谁才叫谁 ───────────────────────────────
 *
 *   开班（叫到岗）= 造一块**后台**面板 —— 从此他随时收得到消息，界面上看不见他
 *   列表里的对话 = 活面板的 chat，或者从下面那两处后台文件里读出来的（只读）
 *   打字发给他   = 先确保他到岗（没有就现开一块后台面板），再发给那块面板
 *   「摆到布局」  = 唯一会让他出现在你标签栏里的动作，而且是**你点了才算**
 *
 * 他可能会睡在两个地方（都不是"活着的面板"）：
 *
 *   userData/components/<面板id>.json   收纳区（组件）—— **插件能打开**
 *   userData/closed/<面板id>.json      历史会话 —— 打不开，但对话是数据，抄得回来（见 wake）
 *
 * ── 边界，写在这儿免得白试 ────────────────────────────────────────
 *
 *   · 收纳区（components/）的面板：`api.openComponent(id)` 能打开 ✓
 *   · 历史会话（closed/）的面板：核心没把"重开"给插件 ✗ —— 那就把那份 chat 抄进
 *     一块新的后台面板（wake 里的第二条路）。人接得回来，原文件不动。
 *   · 后台面板必须有 `hidden` 这个豁免才活得住：核心的清理（store.cleanup）会把不在
 *     任何树里的面板当孤儿收回主标签组，以前只放过 `float` —— 这就是这个字段的来由。
 *   · 面板在 ws.panels 里就**必须在某棵树里**：核心的清理会把不在树里的面板当孤儿
 *     收回主标签组，唯一的豁免是 `float`（便签，可它浮在界面上、也不叫"后台"）。
 *     所以"在岗"和"不占布局"这两件事在核心这儿是互斥的 —— 想要干净布局，
 *     就只能让员工睡着。这是设计，不是没做完。
 *
 * ── 跟 dispatch 的边界（写清楚，免得以后互相踩） ─────────────────────────
 *
 *   名册（谁是谁、属哪个部门、人设是什么）—— **dispatch 的**，这里只读
 *     `.ensoul/state/agents/*.json`      每人一张角色卡（含 panel、model、history）
 *     `.ensoul/state/dispatch.json`      认部门与公司
 *     `.ensoul/state/dispatch.board.json` 取拼好的 composed（公司 + 部门 + 职能）
 *   面板归属（哪个员工归我开的哪块面板）—— **我自己的**，只写进 eschat.json 的 panels。
 *   谁的状态谁写：编制归 dispatch，这里从不回写它一个字节。
 *
 * ── 面板隔离（这条栽过跟头，别省） ─────────────────────────────────────
 *   · 命令文件一块面板一份：`eschat.cmd.<面板id>.<序号>.json` —— 两块 eschat 同时
 *     发消息不会互相覆盖。
 *   · "正打开着谁"按**发起的那块 eschat 面板**分槽（opens），否则两块面板会抢同一个字段。
 */

const fs = require('fs');
const path = require('path');


/** 心跳间隔。读的都是内存里的面板对象，写盘只在内容真变了时发生 */
const TICK = 800;
/** 列表里那句预览的最长字数 */
const LAST = 120;
/** 一个员工给界面多少条最近的对话 */
const MSGS = 60;
/** 对话里每行最多多少字 */
const LINE = 400;
/** 正在跑的那一轮给界面看多少字（"有多少转多少"的那一份，比历史那行给得多） */
const LIVE = 3000;
/** 最近这么多条给**全文** —— "复制"复制的就该是整段，给半截等于没这个功能 */
const FULL = 20;
/** 派单回执最多给几条 */
const RECORDS = 3;
/** 回执里每段给多少字 —— 比消息那行宽松些：回执是"他干完一轮的交代"，掐掉半句看不懂 */
const REC_LINE = 900;
/** 搜索命中里，给出来的那一条截多少字 —— 它是列表里的一行摘要，不是把整段搬过去 */
const FIND_LINE = 90;
/** 会话边界的**兜底**（分钟）—— 真源在 histconv 的 `gapMin`，只在那本账还没有时用 */
const SEG = 30;
/** 记录区里一次会话最多给多少条 / 每条多少字 —— "按一次完整的对话回忆" */
const RECALL = 150;
const RECALL_LINE = 1500;
/** 记录区最多列几次更早的会话 */
const SEGS_MAX = 30;

let el = null;
try {
  el = require('electron');
} catch (e) {
  el = null;
}

let api = null;
let timer = null;
/** 上一次写盘的指纹（跟文件内容比，不是跟内存比） */
let print = '';
/** <eschat 面板id> → 我正看着哪个员工 */
const opens = {};
/** <员工id> → 我替他开的那个面板 id（存在 eschat.json 的 panels 里，重启也在） */
const myPanels = {};
/** 每块 eschat 面板各自置顶了谁（empId 数组，最新置顶的在最前）。跟 opens 一样按面板分槽 */
const tops = {};
/**
 * <eschat 面板id> → 记录区正打开着的那一次会话的 key（没打开就不记）。
 *
 * 漏过一次声明：`recallOf()` 里读它、`run()` 里写它，全文件却只有这一处从没定义过。
 * 读一个没声明过的变量会抛 ReferenceError，而它挂在 `detailOf → snapshot` 这条线上 ——
 * 于是心跳每 800ms 都整条崩在摘数据那一步，快照永远写不出去（脸就永远停在旧数据上：
 * 自己刚发的、员工刚回的，一条都看不见，可后台其实都跑完了）。
 */
const recalls = {};
/**
 * <eschat 面板id> → { q, hits }：他那一栏搜索框里现在是什么词、在**聊天记录**里命中了谁。
 *
 * 搜索为什么在脑里做：全文只在这儿（活面板的 chat、后台那份文件），脸手里只有每个员工
 * 最后一条 —— 在脸里搜只能搜到人名和"最后一句"。跟 opens/recalls/tops 一样按面板分槽。
 */
const finds = {};

/** 一块面板最多置顶几个人 —— 置顶多到能滚一屏，就跟没置顶一样了 */
const TOP_MAX = 20;

/** 从磁盘捞回来的那份状态里，把每块面板的置顶名单接管过来 */
function loadTops(raw) {
  for (const [k, v] of Object.entries(raw || {})) {
    if (Array.isArray(v)) tops[k] = v.map(String).slice(0, TOP_MAX);
  }
}

/** 名册缓存：agents 目录的 mtime 一变就重扫 */
let cardCache = { stamp: -1, list: [] };
/** composed 缓存：看板文件大，按 mtime 缓存 */
let compCache = { stamp: -1, map: null };
/** 后台面板索引缓存：目录里文件的清单指纹没变就复用 */
let dormCache = { stamp: '', map: new Map() };
/** 已经关过思考的员工面板（插件重挂后重来一轮，免得手动改回去了还留着） */
const noThink = new Set();

const flat = (s) => String(s == null ? '' : s).replace(/\*\*/g, '').replace(/^斜杠命令\s*\//, '/').replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
const at = (m) => Number((m && (m.createdAt || m.at)) || 0);

/** `.ensoul/state` 下的一个文件 */
function statePath(...rest) {
  return path.join(api.workspace, '.ensoul', 'state', ...rest);
}

/**
 * 卡上的头像字段 → 界面能直接喂 `<img src>` 的地址（跟 dispatch 的 avaUrl 同一条规矩）。
 *
 * **快照里只准出现这个函数的结果** —— 这份 eschat.json 会被侧栏、任务监视器、eschat
 * 三处读，而 `fs:read` 有 300KB 上限：一张 base64 头像（56–287KB）就足以把整份快照顶过线，
 * 读回来的是占位文字 → 三处一起变空。卡上现在存的是 `.ensoul/state/avatars/<id>.png`
 * 这样的相对路径，这里算成 `file:///` 绝对地址（对话里的图就是这么显示的）。
 */
function avaUrl(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  // 过渡期兜底：还没迁移的老卡（data URL）、已经算好的 file://、外链 —— 原样给
  if (s.startsWith('data:') || s.startsWith('file://') || /^(https?|blob):/i.test(s)) return s;
  const abs = path.isAbsolute(s) ? s : path.resolve(api.workspace || '.', s);
  return `file:///${abs.replace(/\\/g, '/')}`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

/** 应用数据目录 —— 睡在后台的面板本体住在它下面（跟 plugins/history 一个办法） */
function userData() {
  try {
    return el && el.app ? el.app.getPath('userData') : '';
  } catch (e) {
    return '';
  }
}

/**
 * 睡在后台的面板：id → { where: 'stow' | 'closed', panel }
 *
 * 两处都是"一个面板一个 JSON"的目录，认的就是文件名（= 面板 id）。
 * 代价用目录自身 mtime 挡一道：只要目录里没有增删文件，0 次子文件 stat，0ms 完成！
 * 目录自身 mtime 变了（有人新关了面板或收纳），才重扫子文件。
 */
function dormant() {
  const base = userData();
  if (!base) return dormCache.map;

  const dirs = [
    ['stow', path.join(base, 'components')],
    ['closed', path.join(base, 'closed')],
  ];

  // 第一道快车道：直接比两个目录自身的 mtime，1 次 statSync 只要 0.05ms
  let dirStamp = '';
  for (const [, dir] of dirs) {
    try {
      const st = fs.statSync(dir);
      dirStamp += dir + ':' + st.mtimeMs + ';';
    } catch {
      dirStamp += dir + ':0;';
    }
  }
  if (dormCache && dormCache.dirStamp === dirStamp && dormCache.map) {
    return dormCache.map;
  }

  let stamp = dirStamp;
  for (const [, dir] of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      continue; // 目录还没建过 —— 正常
    }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      try {
        const st = fs.statSync(path.join(dir, n));
        stamp += n + ':' + st.mtimeMs + ':' + st.size + ';';
      } catch (e) {
        /* 刚好被删了，下一跳再说 */
      }
    }
  }
  if (stamp === dormCache.stamp) {
    dormCache.dirStamp = dirStamp;
    return dormCache.map;
  }

  const map = new Map();
  for (const [where, dir] of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const id = n.slice(0, -'.json'.length);
      if (map.has(id)) continue;
      const p = readJson(path.join(dir, n));
      if (!p || !Array.isArray(p.chat)) continue;
      map.set(id, { where, panel: p });
    }
  }
  dormCache = { stamp, dirStamp, map };
  return map;
}

/** 名册：dispatch 的 agents/*.json，每人一张角色卡 */
function cards() {
  const dir = statePath('agents');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch (e) {
    return []; // dispatch 还没建过员工 —— 空名册是正常状态，不是错误
  }
  let stamp = '';
  for (const n of names) {
    try {
      stamp += `${n}:${fs.statSync(path.join(dir, n)).mtimeMs};`;
    } catch {
      stamp += `${n}:0;`;
    }
  }
  if (stamp && stamp === cardCache.stamp && cardCache.list) return cardCache.list;

  const list = [];
  for (const n of names) {
    const c = readJson(path.join(dir, n));
    if (c && c.id && c.name) list.push(c);
  }
  cardCache = { stamp, list };
  return list;
}

/** 员工 → 部门/公司。dispatch.json 是编制真源，读不到就只有部门名 */
function orgOf(card) {
  const reg = readJson(statePath('dispatch.json'));
  const dept = String(card.dept || '');
  let company = '';
  if (reg && Array.isArray(reg.depts)) {
    for (const d of reg.depts) {
      if (String(d.name) !== dept) continue;
      const co = (reg.companies || []).find((c) => c.id === d.company);
      company = String((co && co.name) || '');
      break;
    }
  }
  return { dept, company };
}

/**
 * 员工 id → 拼好的完整人设（公司 + 部门 + 职能）。
 * 取的是 dispatch 看板里的 composed —— 那是编制唯一真源算出来的那份，
 * 我自己去拼会跟它漂开，而且漂了不报错。
 */
function composedMap() {
  const file = statePath('dispatch.board.json');
  let stamp = 0;
  try {
    stamp = fs.statSync(file).mtimeMs;
  } catch (e) {
    return null;
  }
  if (stamp === compCache.stamp) return compCache.map;

  const board = readJson(file);
  const map = new Map();
  const take = (v) => {
    if (v && v.id && v.composed) map.set(String(v.id), String(v.composed));
  };
  if (board && Array.isArray(board.depts)) {
    for (const d of board.depts) {
      take(d.manager);
      if (Array.isArray(d.members)) d.members.forEach(take);
    }
  }
  compCache = { stamp, map };
  return map;
}

/** 部门配色：经理是 dispatch 那支橙色，其他人的色按部门散列固定下来（同部门一个色） */
const PALETTE = ['#5b8cff', '#41b883', '#c471ed', '#e2585f', '#2fb6c4', '#8a7ff0', '#d4a017'];
function accentOf(card) {
  if (String(card.role) === 'manager') return '#e0a35f';
  const s = String(card.dept || card.name || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** 这块面板 id 现在活着吗 */
function live(id) {
  return !!id && (api.panels() || []).some((p) => String(p.id) === String(id));
}

/**
 * 认人：**哪一块面板才是他** —— 这条规矩必须和 plugins/dispatch 的 panelOf 一模一样
 * （那边也有一份同样的注释；改一处就得改两处）。
 *
 * 为什么不认"谁记的 id"：一个人的面板常常不止一块 —— 派单开过一块、eschat 开过一块、
 * 手上还留着更早的几块，而**只有一块装着他真正在说的话**。认错一块的表现就是
 * "左边明明有我俩，点进去什么都没有"（我们就是这么被坑的：卡上指着 9/25 那块，
 * 今天的话全说在 9/26 那块上；eschat 记的那块干脆是空的）。
 *
 * 所以按面板自己的"热度"认；人还没开口（候选全是空的）时才回到"谁记着他是谁"：
 *   ① 真是员工工作面（锁过模型 + 不收全局说明，见 spawn）
 *   ② 最近说过话 → ③ 说得多 → ④ 卡上记的 → ⑤ eschat 记的 → ⑥ 谁最后动过
 */
function isWorkspace(p) {
  return !!p && p.lockedModel === true && p.noWorkspacePrompt === true;
}

/** 一块面板有多"热"：最近一句人话的时间 / 人话条数 / 面板自己最后动的时间（结合 chat 与 histconv） */
function heatOf(chat, panelId) {
  let last = 0;
  let n = 0;
  for (const m of Array.isArray(chat) ? chat : []) {
    if (!m || m.role === 'tool' || !hasBody(m)) continue;
    n++;
    const t = at(m);
    if (t > last) last = t;
  }
  // 如果面板刚被翻篇或刚 /new，chat 为空，必须从该面板的历史会话账本读取真实活跃时间，绝不可当作 0
  if (panelId) {
    const entries = histOf(panelId);
    if (Array.isArray(entries) && entries.length > 0) {
      for (const e of entries) {
        const msgs = Array.isArray(e.msgs) ? e.msgs : [];
        for (const m of msgs) {
          if (!m || m.role === 'tool' || !hasBody(m)) continue;
          n++;
          const t = at(m);
          if (t > last) last = t;
        }
      }
    }
  }
  return [last, n];
}

/** 并列时的先后：卡上记的 > eschat 记的 > 都不是 */
function tieOf(id, cardId, mineId) {
  return [id && id === cardId ? 1 : 0, id && id === mineId ? 1 : 0];
}

/** 他名下的**所有**面板：活着的 + 睡在收纳区/历史会话里的，按"热"从高到低 */
function homesOf(card) {
  const name = String(card.name || '');
  const cardId = String(card.panel || '');
  const mineId = String(myPanels[String(card.id)] || '');
  const out = [];
  for (const p of api.panels() || []) {
    const id = String(p.id);
    if (String(p.title || '') !== name && id !== cardId) continue;
    out.push({
      id,
      where: 'live',
      panel: p,
      // 角色卡当前绑定的 cardId 具备极高优先级，排在最前；接着是融合了 histconv 的真实热度
      key: [
        isWorkspace(p) ? 1 : 0,
        id && id === cardId ? 1 : 0,
        ...heatOf(p.chat, id),
        tieOf(id, cardId, mineId)[1],
        Number(p.updatedAt || 0),
      ],
    });
  }
  for (const [id, hit] of dormant()) {
    const panel = hit && hit.panel;
    if (String((panel && panel.title) || '') !== name && id !== cardId) continue;
    out.push({
      id,
      where: String((hit && hit.where) || 'closed'),
      panel,
      key: [
        isWorkspace(panel) ? 1 : 0,
        id && id === cardId ? 1 : 0,
        ...heatOf(panel && panel.chat, id),
        tieOf(id, cardId, mineId)[1],
        Number((panel && panel.updatedAt) || 0),
      ],
    });
  }
  out.sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return b.key[i] - a.key[i];
    return 0;
  });
  return out;
}

/** 他此刻在岗吗（活着返回面板 id，否则空串） */
function onDuty(card) {
  const h = homesOf(card).find((x) => x.where === 'live');
  return h ? h.id : '';
}

/** 他睡在后台的那份（收纳区优先，其次历史会话）—— 取他名下最热的那块 */
function asleep(card) {
  const h = homesOf(card).find((x) => x.where !== 'live');
  return h ? { id: h.id, where: h.where, panel: h.panel } : null;
}

/**
 * 按角色卡造一块**后台面板**给他。
 *
 * 顺带把 dispatch 开工作面的那几下对齐：专属提示词、锁死模型、不收全局说明。
 *
 * **不盖组件声明**（这条是补上的）：员工是一个人，不是一份可复用的做法。
 * 声明过的面板会跑进 设置 → 组件 那张架子，还会被当成"可以克隆"的东西 ——
 * 对一个人两件都不成立。他的名册在 设置 → agent（dispatch 开的那一页），
 * 关掉时跟其它没声明的面板一样回「历史会话」，人随时叫得回来（wake 那条路）。
 *
 * `seedChat` 是给"从历史会话接回来"用的：那份对话原样抄进新面板，旧文件一个字节不动。
 */
function inheritHistconv(oldId, newId) {
  try {
    if (!oldId || !newId || oldId === newId) return;
    const histDir = statePath('histconv');
    const oldFile = path.join(histDir, `${String(oldId).replace(/[^\w.-]+/g, '_')}.json`);
    const newFile = path.join(histDir, `${String(newId).replace(/[^\w.-]+/g, '_')}.json`);
    if (!fs.existsSync(oldFile)) return;
    const oldData = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
    let newData = { at: Date.now(), arch: 0, entries: [] };
    if (fs.existsSync(newFile)) {
      try { newData = JSON.parse(fs.readFileSync(newFile, 'utf8')); } catch {}
    }
    const map = new Map();
    for (const e of (oldData.entries || [])) if (e && e.key) map.set(e.key, e);
    for (const e of (newData.entries || [])) if (e && e.key) map.set(e.key, e);
    newData.entries = Array.from(map.values()).sort((a, b) => (a.from || 0) - (b.from || 0));
    if (oldData.anchor && !newData.anchor) newData.anchor = oldData.anchor;
    fs.mkdirSync(histDir, { recursive: true });
    fs.writeFileSync(newFile, JSON.stringify(newData, null, 2), 'utf8');
    api.log(`[eschat] 历史会话继承成功：${oldId} -> ${newId}（共 ${newData.entries.length} 条）`);
  } catch (e) {
    api.log(`[eschat] 历史会话继承失败：${(e && e.message) || e}`);
  }
}

function saveCardPanel(cardId, panelId) {
  try {
    const dir = statePath('agents');
    const file = path.join(dir, `${cardId}.json`);
    if (!fs.existsSync(file)) return;
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    c.panel = String(panelId || '');
    fs.writeFileSync(file, JSON.stringify(c, null, 2), 'utf8');
  } catch {}
}

function spawn(card, seedChat) {
  const id = String(card.id);
  const composed = composedMap();
  const p = api.createPanel({
    title: String(card.name),
    kind: 'chat',
    hidden: true,
    chat: Array.isArray(seedChat) ? seedChat : [],
    look: { accent: accentOf(card), density: 'normal', showChat: true },
    spec: {
      body: 'messages',
      systemPrompt: String((composed && composed.get(id)) || card.prompt || ''),
      actions: [],
      fields: [],
      text: '',
    },
  });
  if (!p) return '';
  if (card.model && typeof api.setModel === 'function') api.setModel(p.id, String(card.model));
  // 经理**不开思考**：派单、转述、回话都是看一眼就该决定的活，让它想只是白等。
  if (String(card.role) === 'manager' && typeof api.setThink === 'function') api.setThink(p.id, 'off');
  if (typeof api.patchPanel === 'function') {
    // 顺手把历史上可能留下的组件声明摘掉（老版本盖过）—— 摘了才不会再回到组件库里
    api.patchPanel(p.id, { lockedModel: true, noWorkspacePrompt: true, component: '' });
  }
  myPanels[id] = String(p.id);
  const oldPid = String(card.panel || '');
  if (oldPid && oldPid !== String(p.id)) {
    inheritHistconv(oldPid, p.id);
    saveCardPanel(id, p.id);
  }
  api.log(`给《${card.name}》开了后台工作面 ${p.id}`);
  return String(p.id);
}

/**
 * 确保他到岗 —— **先唤醒睡着的，实在没有才新开**。
 *
 * 为什么非这么写：这里原来只看**活着**的面板，睡在收纳区/历史会话里的那份一概不管，
 * 于是"给他要一块面板"就新开一块**空的** —— 同一个人名下攒出"活的空块 + 睡的有历史"，
 * 点开他看到的是一片空白（文案组经理、何且曦就是这么攒出来的）。
 * 那两份睡着的不是别的东西，**是同一个人的对话**：能开就开回来，开不了就把对话抄进来。
 */
function ensure(card) {
  const id = String(card.id);

  // ① 已经有一块活着的：就用它（卡上记的那块优先 —— 见 homesOf 的排序）
  const duty = onDuty(card);
  if (duty) {
    delete myPanels[id]; // 他自己那块活着，我这边不用记了
    fillBlank(card, duty); // 它是空壳、睡着的兄弟块里有对话 → 接进来
    if (String(card.panel || '') !== String(duty)) {
      inheritHistconv(card.panel, duty);
      saveCardPanel(id, duty);
    }
    return duty;
  }
  const mine = myPanels[id];
  if (mine && live(mine)) return String(mine);

  const sleep = asleep(card);

  // ② 睡在收纳区：能真打开（id、对话、模型都是原来那份），开完再收进后台
  if (sleep && sleep.where === 'stow' && typeof api.openComponent === 'function') {
    try {
      const p = api.openComponent(sleep.id);
      if (p) {
        // 放回布局只是为了"让它成为一块活着的面板"；紧接着收进后台 ——
        // 员工该待的地方是后台，不是你的标签栏。
        if (typeof api.hidePanel === 'function') api.hidePanel(String(p.id));
        if (staleChat(p.chat)) clearStaleWork(p, card.name);
        api.log(`把《${card.name}》从收纳区叫回后台 ${p.id}`);
        return String(p.id);
      }
    } catch (e) {
      api.log(t('从收纳区叫回失败：') + ((e && e.message) || e));
    }
  }

  // ③ 睡在历史会话：插件打不开它，把那份对话**抄**进一块新面板（原文件一个字节不动）
  if (sleep && sleep.where === 'closed') {
    try {
      const seed = sleep.panel && sleep.panel.chat;
      if (staleChat(seed)) {
        api.log(`《${card.name}》睡着的对话已经过期，不接回来（新会话从空白开始，旧的在左边抽屉里）`);
        return spawn(card, null);
      }
      return spawn(card, chatCopy(seed));
    } catch (e) {
      api.log(t('从历史会话接手失败：') + ((e && e.message) || e));
    }
  }

  // ④ 哪儿都没有：这才新开一块
  try {
    return spawn(card, null);
  } catch (e) {
    api.log(t('开工作面失败：') + ((e && e.message) || e));
    return '';
  }
}

/** 一份对话的**副本** —— 抄进别的面板时不能共用同一个数组（改一处两边都变） */
function chatCopy(chat) {
  try {
    return JSON.parse(JSON.stringify(Array.isArray(chat) ? chat : []));
  } catch (e) {
    return [];
  }
}

/**
 * 这块活面板是个空壳、而他睡着的兄弟块里存着对话 → 把那份接进来。
 *
 * 光改"新建"那条路治不了**已经攒下来的**空块（空块天天在用、历史睡在旁边），
 * 所以每次到岗都顺手补一下：只在他一句人话都没说过时才补，不会盖掉正在聊的。
 */
function fillBlank(card, panelId) {
  try {
    const p = (api.panels() || []).find((x) => String(x.id) === String(panelId));
    if (!p) return;
    const said = (p.chat || []).some((m) => m && m.role !== 'tool' && typeof m.content === 'string' && m.content.trim());
    if (said) return;
    const sleep = asleep(card);
    const chat = chatCopy(sleep && sleep.panel && sleep.panel.chat);
    if (staleChat(chat)) {
      api.log(`《${card.name}》睡着的对话已经过期，不接进空工作面（旧的在左边抽屉里）`);
      return;
    }
    if (!chat.length || typeof api.patchPanel !== 'function') return;
    api.patchPanel(String(panelId), { chat });
    if (typeof api.refresh === 'function') api.refresh();
    api.log(`把《${card.name}》睡着的对话接进空工作面 ${panelId}（${chat.length} 条）`);
  } catch (e) {
    api.log(t('接回睡着的对话失败：') + ((e && e.message) || e));
  }
}

/**
 * 把他叫到岗 —— **不往你的布局里放任何东西**。
 *
 *   已经活着（在后台 / 已经摆在外面）→ 什么都不做，他本来就在岗
 *   睡在收纳区 → openComponent 放回布局，**紧接着收进后台**（id、对话、模型都是原来那份）
 *   睡在历史会话 → 插件打不开它，把那份对话抄进一块新的后台面板（接得回来，原文件不动）
 *   没开过班 → 按角色卡造一块后台面板
 */
function wake(card) {
  // 叫到岗和"确保他有一块面板"本来就是同一件事 —— 只有一份实现，见 ensure。
  return ensure(card);
}

/** 从一段 chat 里找出"人话"的最后一条 + 有多少条 —— 在岗和睡着两条路共用，chat 为空时回退 histconv */
function tailOf(raw, panelId) {
  let tail = null;
  let count = 0;
  for (const m of (Array.isArray(raw) ? raw : [])) {
    // 只有图没配字也算一条 —— "他发了张图"不该在列表里消失
    if (!m || m.role === 'tool' || !hasBody(m)) continue;
    count++;
    tail = m;
  }
  // 若当前 chat 为空（刚被翻篇或刚 /new），从历史会话账本中提取最新一条人话作为摘要展示
  if (!tail && panelId) {
    const entries = histOf(panelId);
    if (Array.isArray(entries) && entries.length > 0) {
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        const msgs = Array.isArray(e && e.msgs) ? e.msgs : [];
        for (let j = msgs.length - 1; j >= 0; j--) {
          const m = msgs[j];
          if (!m || m.role === 'tool' || !hasBody(m)) continue;
          count++;
          if (!tail) tail = m;
        }
      }
    }
  }
  return { tail, count };
}

/** 这条消息有东西给人看吗（字或者图） */
function hasBody(m) {
  return (
    (typeof m.content === 'string' && !!m.content.trim()) ||
    (Array.isArray(m.images) && m.images.length > 0)
  );
}

/** 一条消息 → 界面里的一行。图只给路径，脸自己拼 file:// 显示 */
function lineOf(m, limit) {
  const text = flat(m.content);
  return {
    role: String(m.role || ''),
    text: limit ? cut(text, limit) : text,
    at: at(m),
    ...(Array.isArray(m.images) && m.images.length ? { images: m.images.slice(0, 6) } : {}),
  };
}

/**
 * 一个员工的完整聊天 —— **在岗读活面板，睡着读后台那份文件**。
 *
 * 列表那一行、详细对话、搜索三处都要它，取法只有一条：抽出来共用。
 * 抽出来不是为了省几行 —— 是怕搜索偷偷走另一条路，那样就会出现
 * "列表里明明有他、搜聊天记录却搜不到"这种没处说理的事。
 */
function rawOf(card) {
  const duty = onDuty(card);
  const p = duty ? (api.panels() || []).find((x) => String(x.id) === duty) : null;
  const sleep = p ? null : asleep(card);
  const raw = p ? (Array.isArray(p.chat) ? p.chat : []) : sleep ? sleep.panel.chat : [];
  return { duty, p, sleep, raw };
}

/**
 * 在**所有人的聊天记录**里找这个词。
 *
 * 给回的是"谁那儿命中了、一共几条、最近那条长什么样" —— 列表里要的正是这个：
 * 搜"发票"是为了知道**这话谁说过**，不是把几十段聊天全搬进侧栏。
 * 命中的那条给的是**最后一条**（最近说的），因为一屏只能放一行。
 */
function findIn(q) {
  const needle = q.toLowerCase();
  const out = {};
  for (const card of cards()) {
    let count = 0;
    let hit = null;
    for (const m of rawOf(card).raw) {
      if (!m || m.role === 'tool' || !hasBody(m)) continue;
      const text = flat(m.content);
      if (!text || !text.toLowerCase().includes(needle)) continue;
      count++;
      hit = m;
    }
    if (!count || !hit) continue;
    out[String(card.id)] = {
      count,
      role: String(hit.role || ''),
      text: cut(flat(hit.content), FIND_LINE),
      at: at(hit),
    };
  }
  return out;
}

/** 一个员工 → 列表里的一行 */
function rowOf(card) {
  const empId = String(card.id);
  const { duty, p, sleep, raw } = rawOf(card);
  const targetPid = duty || (sleep ? sleep.id : String(card.panel || ''));
  const { tail, count } = tailOf(raw, targetPid);

  const { dept, company } = orgOf(card);
  return {
    id: empId,
    name: String(card.name),
    dept,
    company,
    role: String(card.role || 'member'),
    // 快照里的头像**只能是 URL**，不许是 base64（见 avaUrl）
    avatar: avaUrl(card.avatar),
    accent: accentOf(card),
    model: String(card.model || ''),
    panel: duty || (sleep ? sleep.id : String(card.panel || '')),
    /** 有活着的面板 = 现在就能收消息（它可能在后台，界面上看不见） */
    open: !!p,
    /** 它此刻摆在布局里吗（false = 在后台） */
    shown: !!(p && !p.hidden),
    /** idle / working / confirm（在岗）· stow（睡在收纳区）· closed（睡在历史会话）· off（没开过班） */
    status: p ? String(p.status || 'idle') : sleep ? sleep.where : 'off',
    count,
    at: tail ? at(tail) : 0,
    last: tail ? { role: String(tail.role || ''), text: cut(flat(tail.content) || t('[图片]'), LAST) } : null,
  };
}

/**
 * 把一段对话切成**一次一次会话**。
 *
 * 切法只有一条：**相邻两句话隔了超过 `gap` 就是另一次**
 * （间隔较久再开口，就归入新的一条会话记录）。工具消息不参与判断，它不打断"续上"。
 *
 * key 取该段第一条的时间戳（`s<at>`）：段是按时间切出来的，这个 key 天然稳定 ——
 * 脸点开某一次、脑过一会儿重算，对得上同一个 key。
 */
function segmentsOf(human, gap) {
  const segs = [];
  let cur = null;
  for (const m of human) {
    const t = at(m);
    if (!cur || (t && cur.to && t - cur.to > gap)) {
      cur = { key: `s${t || segs.length}`, from: t, to: t, items: [] };
      segs.push(cur);
    }
    cur.items.push(m);
    if (t) cur.to = t;
  }
  return segs;
}

/**
 * 更早的那些次会话从哪儿来 —— **读会话栏左侧那条「历史会话」的同一份账**：
 * `.ensoul/state/histconv/<面板 id>.json`（plugins/histconv 写的）。
 *
 * 为什么不再自己切一遍：这两处原来是各算一份的 —— rail 读那份账（有模型起的标题，
 * 能改名 / 删除 / 排序），这里拿面板的 chat 现切（标题就是开头那句）。同一批对话
 * 在两处长得不一样，在一处删掉的段在另一处还列着。一处账、两处读，才叫互通。
 *
 * 文件不在（插件没装 / 这一次还没被收进去）= 没有更早的会话，列空着，不报错。
 * 心跳 800ms 一拍，所以按 stat 的 mtime+size 挡一道指纹，没变不重读。
 */
const HIST_DIR = '.ensoul/state/histconv';
/** 面板 id → { stamp, entries }：上一次读到的那份账 + 它的指纹 */
const histCache = new Map();
const NO_HIST = { entries: [] };
function histMeta(pid) {
  const id = String(pid || '');
  if (!id) return NO_HIST;
  const file = path.join(api.workspace, HIST_DIR, id.replace(/[^\w.-]+/g, '_') + '.json');
  let stamp = '';
  try {
    const st = fs.statSync(file);
    stamp = st.mtimeMs + ':' + st.size;
  } catch (e) {
    return NO_HIST; // 没这份账 —— 正常状态，不是错误
  }
  const hit = histCache.get(id);
  if (hit && hit.stamp === stamp) return hit;
  const box = readJson(file);
  const meta = { stamp, entries: box && Array.isArray(box.entries) ? box.entries : [] };
  histCache.set(id, meta);
  return meta;
}
function histOf(pid) {
  return histMeta(pid).entries;
}

/**
 * 那份账里的一版 → 记录区里的一行（**只给摘要**，完整对话点开才给 —— 快照每 800ms 重写一次）。
 *
 * `head` 用**标题**（有的话）—— rail 上那一行显示的就是它，两边得是同一句话；
 * 标题还没起出来就退回这一段的开头那句，跟 rail 一个规矩。
 */
function histRow(e) {
  const msgs = Array.isArray(e.msgs) ? e.msgs : [];
  const head = flat(msgs[0] && msgs[0].content);
  const tail = flat(msgs[msgs.length - 1] && msgs[msgs.length - 1].content);
  return {
    key: String(e.key || ''),
    from: Number(e.from) || 0,
    to: Number(e.to) || 0,
    count: msgs.length,
    title: String(e.title || ''),
    head: cut(String(e.title || '') || head || t('[图片]'), 80),
    tail: cut(tail || t('[图片]'), 80),
  };
}

/**
 * 会话边界那一份值 —— histconv 的 `gapMin`。
 *
 * ★ **同一个需求只有一个数**：它声明在 plugins/histconv（那边才是"到点翻篇、收进
 * 抽屉"的执行者），这边**读同一个键**、不再自己声明一份。从前两家各有一个参数
 * （segMin / gapMin），改了这边那边不动 —— 看上去就是"改了没反应"，其实是同一件事
 * 判了两遍、还挂在两个名字下。histconv 没装 / 没设过 = 读不到，退回 SEG。
 */
function histconvGapMin() {
  try {
    const all = api.allParams && api.allParams();
    const p = Array.isArray(all) ? all.find((x) => String((x && x.name) || '') === 'histconv') : null;
    return p && p.values ? Number(p.values.gapMin) || 0 : 0;
  } catch (e) {
    return 0;
  }
}


/**
 * 一份**睡太久**的对话被开回来 → 把工作面清空。
 *
 * 为什么省不得：收纳区里那份是**真开回来**的（同一块面板、同一份 chat）。开回来之后，
 * 紧接着那条派单会带着几天前的完整上下文开跑 —— 新会话等于从没发生（实测就是这样）。
 * 只动这一组字段（与 histconv 的 `/new` 完全同一组），**不碰 histconv 的账**：
 * 那几段一条不少地留在左边抽屉里，员工这一轮该有的【接续锚点】照旧由那边给。
 */
function clearStaleWork(p, name) {
  if (!p || typeof api.patchPanel !== 'function') return false;
  const now = Date.now();
  try {
    api.patchPanel(String(p.id), {
      chat: [],
      compact: undefined,
      createdAt: now,
      updatedAt: now,
      newSessionAt: now,
    });
    api.log(`「${name}」的工作面睡太久了，按过期处理：工作面清空（旧的在左边抽屉里）`);
    return true;
  } catch (e) {
    api.log(`清空过期工作面失败：${(e && e.message) || e}`);
    return false;
  }
}

/**
 * 这份睡着的对话是不是**已经过期**了（超过 histconv 的会话边界，见 histGap）。
 * 过期就不接回来：那一份还在左边抽屉里，接回来等于让几天前的上下文复活，
 * 员工以为同一场对话还开着 —— 新会话必须真的从空白开始。
 */
function staleChat(chat) {
  try {
    const rows = Array.isArray(chat) ? chat : [];
    let at = 0;
    for (const m of rows) {
      if (!m || m.role === 'tool') continue;
      const t = Number(m.createdAt) || 0;
      if (t > at) at = t;
    }
    return !!at && Date.now() - at > histGap();
  } catch (e) {
    return false;
  }
}

/** 会话边界：隔多久算"另一次会话"（毫秒）—— 值来自 histconv（见上） */
function histGap() {
  const g = histconvGapMin();
  return (g > 0 ? g : SEG) * 60 * 1000;
}

/** 记录区正打开着的那一次会话 —— **整段**给出去，脸在那儿慢慢回忆 */
/**
 * 记录区点开的那一次 —— **整段**给出去，脸在那儿慢慢回忆。跟上面那列同一份账，
 * 所以 rail 上删掉的那一版，这儿也点不开了（不是在两份数据里各找各的）。
 */
function recallOf(entries, panelId) {
  const key = recalls[String(panelId || '')];
  if (!key) return null;
  const e = entries.find((x) => String(x.key) === key);
  if (!e) return null;
  const msgs = Array.isArray(e.msgs) ? e.msgs : [];
  return {
    key: String(e.key),
    from: Number(e.from) || 0,
    to: Number(e.to) || 0,
    title: String(e.title || ''),
    count: msgs.length,
    truncated: msgs.length > RECALL,
    msgs: msgs.slice(-RECALL).map((m) => lineOf(m, RECALL_LINE)),
  };
}

/** 某个员工的对话流（给正看着他的那块 eschat 面板） */
function detailOf(card, panelId) {
  const on = panelId ? (api.panels() || []).find((x) => String(x.id) === String(panelId)) : null;
  const sleep = on ? null : asleep(card);
  const p = on || (sleep ? sleep.panel : null);
  const raw = p && Array.isArray(p.chat) ? p.chat : [];
  const human = raw.filter((m) => m && m.role !== 'tool' && hasBody(m));
  const want = Math.max(10, Number(api.param('msgs', MSGS)) || MSGS);

  // ★ 先切成"一次一次会话"，当前这一屏只说**最后那一次** ——
  //   再早的按次列在右上角记录区里（那是"回忆"，不是把旧消息一直摊在下面）
  // 边界值取值于 histconv 的 gapMin（见 histGap）—— 一份声明、一处修改
  const gapMin = Math.round(histGap() / 60000);
  const segs = segmentsOf(human, gapMin * 60000);
  const cutAt = segs.length - 1;
  const cur = segs[cutAt] || null;
  // 更早的那些次**不在这儿算** —— 读 rail 的同一份账（见 histOf）
  const hist = histOf(panelId);
  const lines = cur ? cur.items : [];
  const first = Math.max(0, lines.length - want);

  const records = (Array.isArray(card.history) ? card.history : [])
    .slice(-RECORDS)
    .map((h) => ({
      at: Number((h && h.at) || 0),
      task: cut(flat(h && h.task), REC_LINE),
      note: cut(flat(h && h.note), REC_LINE),
    }));

  const { dept, company } = orgOf(card);
  return {
    id: String(card.id),
    name: String(card.name),
    dept,
    company,
    role: String(card.role || 'member'),
    accent: accentOf(card),
    open: !!on,
    shown: !!(on && !on.hidden),
    /*
     * 状态那一格：**真在跑**只认核心那张内存表（api.isRunning）。落盘的 status 会在
     * 进程被杀时永久停在 working —— 那样列表里他一直"正在工作"、脸一直转圈，
     * 而实际上早没人干活了。落盘值只用来认 error / confirm 这些**静态**处境：
     * 停在 working 又没真的在跑 = 上一轮断在半路，报成 error 比谎报在跑强。
     */
    status: !on
      ? sleep
        ? sleep.where
        : 'off'
      : typeof api.isRunning === 'function' && api.isRunning(panelId)
        ? 'working'
        : String(on.status || 'idle') === 'working'
          ? 'error'
          : String(on.status || 'idle'),
    more: first > 0,
    records,
    /** 会话边界（分钟）—— 脸拿它显示"现在发就是新的一次会话"那句提示，跟上面切段同一个数 */
    gapMin,
    /** 当前这一次会话（按间隔切出来的最后一段） */
    seg: cur
      ? { key: cur.key, from: cur.from, to: cur.to, count: cur.items.length, truncated: first > 0 }
      : null,
    /**
     * 更早的会话，**一次一条** —— 跟会话栏左侧那条「历史会话」是同一份账、同一批段，
     * 连标题都是同一个（rail 上改过名，这边跟着变）。最新的排最前。
     */
    sessions: hist.slice(-SEGS_MAX).reverse().map(histRow),
    /** 记录区点开的那一次：整段（从同一份账里取） */
    recall: recallOf(hist, panelId),
    // 当前段里最近这 FULL 条**给全文**（要复制就复制得走整段），更早的压一压 ——
    // 快照每 800ms 重写一次，老消息没人会去复制它。
    msgs: lines.slice(first).map((m, i, arr) => lineOf(m, arr.length - i <= FULL ? 0 : LINE)),
    live: liveOf(on || p),
  };
}

/**
 * 正在跑的那一轮 —— **有多少转多少**。
 *
 * 助手那条消息要到整轮跑完才进 `chat`，光看 chat 就永远是"跑完才吐出来"。
 * 核心把那条**还没进 chat** 的消息贴在快照的 `liveTurn` 上（只带正文），这里摘给人看。
 *
 * 两条边界：
 *   · **不含思考**：思维链走的是另一条通道，从来不在 content 里 —— 不该显示的东西
 *     不是"显示出来再过滤"，而是压根不在这儿。
 *   · 提案块切掉：`<<<FLOAT_EDIT>>>` 是给别处看的东西，流式时还没闭合，露出来只是噪音。
 */
function liveOf(p) {
  const lt = p && p.liveTurn;
  if (!lt || typeof lt.content !== 'string') return null;
  const text = flat(lt.content.split('<<<FLOAT_EDIT>>>')[0]);
  // 最后一步工具在跑什么 —— 没吐字的时候这句就是"他此刻在干嘛"
  const tools = (Array.isArray(lt.toolCalls) ? lt.toolCalls : [])
    .map((t) => String((t && (t.title || t.name)) || '').trim())
    .filter(Boolean)
    .slice(-1);
  if (!text && !tools.length) return null;
  return { text: cut(text, LIVE), tool: tools[0] || '' };
}

function snapshot() {
  const list = cards();
  const byId = new Map(list.map((c) => [String(c.id), c]));
  const rows = list.map(rowOf);
  // 左边那栏按**最近说话**排：刚开过口的在最上，从没说过话的垫底。
  //
  // 以前是"正在干活的最前，其次按时间"—— 结果是刚跟他说完一句，只要别人在跑活，
  // 他就往下掉一位，顺序变得没法预期。谁在干活行上有状态字和绿点，不用靠位置说。
  rows.sort((a, b) => (b.at || 0) - (a.at || 0));

  const openMap = {};
  for (const [watcher, empId] of Object.entries(opens)) {
    const card = byId.get(empId);
    const row = rows.find((r) => r.id === empId);
    if (card) openMap[watcher] = detailOf(card, row && row.panel);
  }
  // tops：**按面板分槽**的置顶名单。排序交给脸做 —— 同一份名册要给两块面板用，
  // 在这儿排就等于替所有面板一起定了，两块面板互相打架。
  return {
    at: Date.now(),
    contacts: rows,
    opens: openMap,
    tops,
    // found：各面板搜索框里那个词**命中了谁的聊天记录**（脸按自己的面板 id 取）
    found: finds,
  };
}

/** 跑掉一条脸发来的命令 */
function run(c) {
  if (!c || typeof c !== 'object') return;
  const type = String(c.type || '');

  if (type === 'find') {
    // 搜索**不针对某个人**，所以必须排在下面那道"先找到这个人"的检查之前 ——
    // 落在它后面的话，这条命令会因为"没带 empId"被静默丢掉，搜了等于没搜。
    const watcher = String(c.watcher || '');
    if (!watcher) return;
    const q = flat(c.q);
    if (!q) delete finds[watcher];
    else finds[watcher] = { q, hits: findIn(q) };
    return;
  }

  const card = cards().find((x) => String(x.id) === String(c.empId || ''));
  if (!card) return;
  const id = String(card.id);

  if (type === 'open') {
    const watcher = String(c.watcher || '');
    if (watcher) opens[watcher] = id;
    // "我想看他" —— 睡着就把他从后台拉回来，压根没开班才新建。
    // 这是唯一会动布局的动作，而且只对**你点的那一个人**做。
    wake(card);
    return;
  }

  if (type === 'pin' || type === 'unpin') {
    // 唯一会让员工出现在标签栏里的动作 —— 而且是**用户点了才算**。
    const panelId = ensure(card);
    if (!panelId) return;
    if (type === 'pin') {
      if (typeof api.showPanel === 'function') api.showPanel(panelId);
    } else if (typeof api.hidePanel === 'function') {
      api.hidePanel(panelId);
    }
    return;
  }

  if (type === 'top') {
    // 置顶 / 取消置顶。这是**看的人自己**的界面状态（跟 opens、recalls 一路），
    // 所以按发起的那块面板分槽 —— 两块 eschat 各有各的置顶，互不影响。
    const watcher = String(c.watcher || '');
    if (!watcher) return;
    const list = (tops[watcher] || []).filter((x) => x !== id);
    if (c.on !== false) list.unshift(id); // 最新置顶的排最前
    if (list.length) tops[watcher] = list.slice(0, TOP_MAX);
    else delete tops[watcher];
    return;
  }

  if (type === 'close') {
    delete opens[String(c.watcher || '')];
    return;
  }

  if (type === 'recall') {
    // 记录区点开/收起某一次会话。不带 key = 回到列表 —— 这是我这一层的界面状态，
    // 跟别人无关，但要按**发起的那块面板**分槽，两块 eschat 才不会抢同一个记录区。
    const watcher = String(c.watcher || '');
    if (!watcher) return;
    const key = String(c.key || '');
    if (key) recalls[watcher] = key;
    else delete recalls[watcher];
    return;
  }

  if (type === 'send') {
    const text = flat(c.text);
    // 图：脸递过来的是 data URL（它只能写文本文件），核心那边会落成磁盘路径。
    const shots = (Array.isArray(c.images) ? c.images : [])
      .filter((s) => typeof s === 'string' && s.slice(0, 11) === 'data:image/')
      .slice(0, 4);
    if (!text && !shots.length) return;
    const panelId = wake(card); // 想让他收到这条，他就得在岗
    if (!panelId) return;
    /*
     * 正跑着时别叠第二轮（api.send 自己也这么说）—— 让他跑完再接。
     *
     * **判据必须是内存里的真运行表，不能是 p.status**：那是个落过去的字段，
     * 进程被杀在半路时收尾那段一次都不跑，它会永久停在 working。拿它当守卫
     * 的结果就是——这个人从此收不到任何话：用户按了发送，这里静默 return，
     * 界面上什么都不发生、右侧连自己发的那句都看不见，而列表里他一直"正在工作"。
     * 谷谷那块面板就是这么卡住的（旧工作面从历史会话唤醒时带着 working 复活）。
     *
     * api.isRunning 由核心回答（它才够得着那张表）；老版本没有这个函数时退回不拦，
     * 宁可叠一轮也不能把用户的话吃掉 —— 叠一轮看得见、吞一条没人知道。
     */
    const running =
      typeof api.isRunning === 'function' ? api.isRunning(panelId) : false;
    if (running) {
      // 他真在跑：这一句进排队，这一轮跑完自动接力发出 —— 静默丢掉是最坏的处理
      if (typeof api.enqueue === 'function') api.enqueue(panelId, text, shots);
      else api.log(t('他正在跑，这句话先记着：') + text.slice(0, 60));
      return;
    }
    Promise.resolve(api.send(panelId, text, shots)).catch((e) =>
      api.log(t('发给员工失败：') + ((e && e.message) || e)),
    );
    return;
  }
}

/** 把 .ensoul/state 下所有 eschat.cmd.*.json 收走、执行、删掉 */
function drain() {
  const dir = statePath();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return;
  }
  for (const n of names) {
    if (!n.startsWith('eschat.cmd.') || !n.endsWith('.json')) continue;
    const file = path.join(dir, n);
    const box = readJson(file); // 半截的 JSON 当没有 —— 脸可能正写到一半
    try {
      fs.unlinkSync(file);
    } catch (e) {
      /* 删不掉就下次再来，不致命 */
    }
    if (box && Array.isArray(box.cmds)) for (const c of box.cmds) run(c);
  }
}

function tick() {
  try {
    drain();

    // 自动开班默认**关着**（见 params）：布局该由用户自己决定，不该被一块面板塞满。
    // 打开的话就是老行为 —— 一开面板，名册上每个人都在布局里占一块。
    const panels = api.panels() || [];
    const hasEschat = panels.some((p) => ['eschat', 'wechat'].includes(String(p.kind)));
    if (hasEschat && api.param('autoOpen', false)) {
      for (const card of cards()) ensure(card);
    }

    // 经理**不开思考**：只设一次，给**已经开着**的那些面板补上（新开的在 spawn 里就设了）
    for (const card of cards()) {
      if (String(card.role) !== 'manager') continue;
      const duty = onDuty(card);
      if (!duty || noThink.has(duty)) continue;
      noThink.add(duty);
      if (typeof api.setThink === 'function') api.setThink(duty, 'off');
    }

    const data = snapshot();
    data.panels = myPanels;
    data.recalls = recalls; // 记录区开着哪一次，重启后还开着那一次
    data.tops = tops; // 谁被置顶了，重启后还在最上面
    const next = JSON.stringify(data);
    if (next === print) return; // 一个字的变动都没有：磁盘和界面都别动
    // 搜索结果是**纯界面态**（跟"正在看谁"一样），不落盘 —— 重启后搜索框本来就是空的，
    // 落下去只是往文件里堆一份过期的命中片段
    delete data.found;
    if (api.state.save(data) !== false) print = next;
  } catch (e) {
    // 一次读盘/摘数据失败不能让心跳停掉 —— 停了脸就永远停在旧快照上
    api.log(t('心跳出错：') + ((e && e.message) || e));
  }
}

module.exports = {
  params: [
    {
      key: 'autoOpen',
      label: t('自动开班'),
      type: 'bool',
      default: false,
      hint: t('默认关：员工平时待在后台，你点谁才叫谁到岗（**不占布局**，标签栏干干净净）。打开它 = 这块面板一开，名册上每个人都在后台开班'),
    },
    {
      key: 'msgs',
      label: t('对话给多少条'),
      type: 'number',
      default: 60,
      min: 10,
      max: 300,
      step: 10,
      hint: t('每个员工的**当前这一次**会话给界面多少条（更早的按"一次会话"收进右上角的会话记录里）'),
    },
  ],

  name: 'eschat',
  description: t('eschat：AI 员工的会话前端。员工平时睡在后台（收纳区/历史会话），点谁才把谁拉回前台；开着就能就地看、就地回'),

  panel: {
    kind: 'eschat',
    aliases: ['wechat'],
    label: 'eschat',
    hint: t('AI 员工的会话前端：一个员工一个联系人，睡着的只读、点开才唤醒'),
    title: 'eschat',
    body: 'messages',
  },

  setup(a) {
    api = a;
    const st = a.state.load({ contacts: [], opens: {}, panels: {}, recalls: {}, tops: {} });
    opens_restore(st.opens);
    Object.assign(myPanels, st.panels || {});
    for (const [k, v] of Object.entries(st.recalls || {})) if (v) recalls[k] = String(v);
    loadTops(st.tops);
    // 认下上次那份长相，免得启动时白写一次盘、白刷一次界面
    print = JSON.stringify({ ...st, at: undefined, panels: myPanels });
    timer = setInterval(tick, TICK);
    if (timer && typeof timer.unref === 'function') timer.unref();
    tick();
  },

  dispose() {
    if (timer) clearInterval(timer);
    timer = null;
    api = null;
    cardCache = { stamp: -1, list: [] };
    compCache = { stamp: -1, map: null };
    dormCache = { stamp: '', map: new Map() };
  },
};

/** 上次正看着谁 —— 面板关掉再打开，还落在同一个人身上 */
function opens_restore(prev) {
  for (const [k, v] of Object.entries(prev || {})) {
    if (v && typeof v === 'object' && v.id) opens[k] = String(v.id);
  }
}
