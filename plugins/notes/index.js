/**
 * 便签 —— 从核心里搬出来的一个功能。
 *
 * 便签是"这一路到底定过哪些事"的记录：用户开口说的第一句、
 * 助手在回复里用 ==…== 自己圈出来的重点。它**不进上下文**（那会把缓存废掉一截），
 * 只在压缩历史时被顺手锚进摘要一次。所以它既不是对话的一部分，
 * 也不属于权限或停靠树 —— 它是一件**功能**，那就该住在插件里。
 *
 * ── 它怎么工作 ────────────────────────────────────────────────────────
 *
 * 插件每 1.2 秒看一遍所有面板的对话（`api.panels()` 拿到的就是真源，不是拷贝），
 * 把认得出是便签的东西剪下来，存进 `.ensoul/state/notes.json`：
 *
 *     { "panels": { "<面板 id>": [ { at, text, marks: ["...", ...] }, ... ] } }
 *
 * 一条便签 = **用户开口说的那一句**（text），下面挂着**紧接着那轮回答里 ==…== 标出来的信息**（marks）。
 * 助手自己后面圈的、跟哪句话都对不上的，不收 —— 那些是"它汇报的进度"，不是用户要回头查的事。
 *
 * 界面那边（对话面板右边那一栏）读的是**同一个文件** —— 跟任务清单面板一模一样：
 * 谁都不用认识谁；插件没装、文件不存在，栏子就是空的。
 *
 * ── 为什么是"扫对话"而不是让核心叫我们一声 ────────────────────────────
 *
 * 核心在写完一条助手回复时最清楚"现在该收便签了"。但为这一件事开一个口子
 * （`onMessage`），等于把"便签"这个概念又钉回核心。而 panels() 本来就是给插件用的口子，
 * 扫一遍的代价可以忽略：便签去重**按文本**，重复扫不会重复记，
 * 所以不必维护"读到第几条"的游标 —— 游标才是会出错的地方。
 * 代价只是新便签晚一秒左右出现，而这块东西是给人长期翻的记录，不在乎那一秒。
 *
 * ── 搬过来之后少了什么 ───────────────────────────────────────────────
 *
 * 核心以前会在压缩历史时，把当时的便签快照钉进摘要。那需要"读插件状态"，
 * 现在核心读不到也不该读 —— 于是那一处当时**刻意不住了**。
 * 后来按当初说好的那个口子回来了：核心在压缩那一刻调 `api.addSummaryNote`，
 * 答话的还是这个插件（见 setup 末尾）。核心只问"有什么不能丢的"，不知道答话的是谁。
 * 想让便签重新进摘要，该加的口子是"压缩时问插件要一句快照"，
 * 而不是让核心重新认识便签。
 */

const fs = require('fs');
const path = require('path');

/**
 * 便签正文存哪 —— **一块面板一份文件**（跟 histconv 同一个路子）。
 *
 * 以前所有人挤在一份 `notes.json` 里，两个后果：
 *   1. 一块面板变一变，**整份重写**一遍；
 *   2. 界面读它走 `fs:read`（有 300 KB 上限）—— 攒久了一旦涨过线，
 *      读回来就是一句占位文字、JSON.parse 失败，**所有面板的便签刻度一起消失**。
 *      histconv 当年正是这么撞的（见它的头注），这边同病。
 * 分开之后每块面板只读自己那一份，也不会被别人的大历史拖死。
 */
const DIR = '.ensoul/state/notes';
/** 老版本所有人挤在一份里，启动时搬过来一次 */
const LEGACY = '.ensoul/state/notes.json';

/**
 * 便利贴投给员工时，那句话头上的**固定前缀**。
 *
 * 与 `src/shared/note-prefix.ts` 必须**字面一致**（那边是渲染层的真源，这边拿不到 TS 模块）。
 * 这边认它只为一件事：员工回执时把前缀剥掉，剩下的才是那句原话。
 */
const NOTE_PREFIX = t('【来自便利贴】');
/** 老前缀：历史消息、老便签里还带着它 —— 认它只为别叠成两行、回执时能剥干净 */
const LEGACY_NOTE_PREFIX = t('【来自便签】');

/**
 * 投递账本：**哪块白板的哪句话投给了谁**（渲染层写、这里读）。
 *
 * 为什么非要单独记一笔：用户要的是"除了固定前缀，别的都不许影响视线" ——
 * 来源白板、甲方是谁，一个字都不能混进员工看到的那句话里。
 * 于是"来源"只能存在这儿，回执时按员工当前面板反查，才知道该钉回哪块白板、双击该跳谁。
 */
const DROP_FILE = '.ensoul/state/notes.drop.json';

/**
 * 员工名册 —— 头像 / 强调色的**唯一真源**（eschat 插件写的那份快照）。
 *
 * 回执盖章时账本里只有员工 id 和名字，而卡上要画头像：查不到就退化成
 * "色块加首字"，看着像认错了人。侧栏、任务监视器读的都是这一份，
 * 这里跟着读同一份，免得又长出第二套"谁长什么样"。
 */
const ROSTER_FILE = '.ensoul/state/eschat.json';

/** 便利贴白板（便签组件）那份笔记哪 —— 跟正文分开一个目录，免得两边同名撞上 */
const MEMO_DIR = '.ensoul/state/memo';
/** 一块白板最多钉几张交付便签（超了丢最旧的）—— 以前是只增不减，攒着攒着就没边了 */
const PIN_KEEP = 200;

/**
 * 面板 id 变文件名 —— 跟界面那边（useNotes.ts）那条规则**必须一模一样**，
 * 对不上就是互相读不到。这里的 safe 也跟主进程 stateFile 用的是同一套。
 */
function fileOf(pid) {
  const safe = String(pid || '').replace(/[^\w.-]+/g, '_');
  return safe ? `${DIR}/${safe}.json` : '';
}

/** 一条便签最长多少字、一个面板最多留几条 */
const NOTE_MAX = 120;
const NOTE_KEEP = 40;
/** 一条便签下面最多挂几条标记 —— 挂太多等于把整段回答抄了一遍，那就不是便签了 */
const MARK_KEEP = 6;
/** 一条标记最长多少字 —— 比 NOTE_MAX 宽：重点常常是一整句话，砍到一句读不完就没用了 */
const MARK_MAX = 200;
/** 最多给多少个面板留槽位（面板删了、关了，槽位也不会立刻没） */
const PANEL_KEEP = 60;

/** 扫一遍的间隔 */
const TICK_MS = 1200;

/**
 * 收拾成"能一条看完"的样子：去空白、压成长度，太短的不算。
 *
 * 压长度时**头尾都留**（头和尾各留一半，中间写个省略号）——
 * 从前是 `slice(0, NOTE_MAX)`，只留头。一条圈得长的重点，尾巴上那几个字
 * （"……，所以先不动"）往往正是结论，切掉就只剩半句半话的引子，
 * 挂在便签上比不记还误导。
 */
function clean(raw, max = NOTE_MAX) {
  const text = String(raw || '').trim().replace(/\s+/g, ' ');
  if (text.length < 2) return null;
  if (text.length <= max) return text;
  const head = Math.ceil(max / 2) - 1;
  const tail = Math.floor(max / 2) - 1;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

/**
 * 用户说的短话也进便签。
 *
 * 他很少长篇大论，开口说的通常就是要点。太长的就不记了 —— 一条便签要能一眼看完，
 * 把整段长文记进去，等于又造了一份需要被压缩的历史，那就本末倒置了。
 */
function fromUser(text) {
  const line = (String(text || '').trim().split('\n')[0] || '').trim();
  const first = (line.split(/[。！？!?]/)[0] || '').trim() || line;
  if (!first || first.length > NOTE_MAX) return null;
  return first;
}

/**
 * 助手圈出来的重点：==……==
 *
 * 从前是 `[^=\n]{2,200}` —— 中间**不许有等号、也不许换行**。后果就是"断章取义"：
 * 圈里只要出现一个 `=`（`x == y`、`a=b`、代码片段），匹配到那儿就断了，只剩前半句；
 * 圈里有个换行更狠，整条直接匹配不上、被丢掉。
 *
 * 现在惰性匹配：一路吃到**下一个 `==`** 为止，中间有什么都不管。
 * 为什么是惰性（`.+?`）而不是贪婪：一句话里连圈两条时（`==甲== 和 ==乙==`），
 * 贪婪会把两条连同中间的"和"一起吃成一条。
 *
 * 换行照收 —— 模型是照**语义**圈的，不是照屏幕换行圈的。收进来后 clean() 会把
 * 换行压成空格，便签里仍是一条一眼看得完的行。上下限只管这一条标记多长：
 * 太短的不是信息（"1"、"了"），太长的那是抄了一整段。
 */
const MARK = /==([\s\S]{2,400}?)==/g;

/**
 * 扫一遍对话，配成"我说的那一句 + 它下一轮回答里标出来的东西"。
 *
 * 一条便签 = 我说的那句话，下面挂着**紧接着那轮回答**里圈出来的信息；
 * 等我下一句开口，后面的标记就归下一条了。
 *
 * 为什么不把助手圈的重点单独收一条：那样会越长越多，翻起来全是它自己汇报的进度。
 * 便签要回答的是"我说了什么、它对我说的这件事定了什么"。
 */
function pairs(chat) {
  const out = [];
  let cur = null;
  for (const m of chat) {
    if (!m || typeof m.content !== 'string') continue;
    if (m.role === 'user') {
      // 太长的那句不记，这一轮的标记也就没有落脚处 —— 记半句不如不记
      const text = fromUser(m.content);
      cur = text ? { text, marks: [] } : null;
      if (cur) out.push(cur);
      continue;
    }
    if (m.role !== 'assistant' || !cur) continue;
    for (const hit of m.content.matchAll(MARK)) {
      if (cur.marks.length >= MARK_KEEP) break;
      const mk = clean(hit[1], MARK_MAX);
      if (mk && !cur.marks.includes(mk)) cur.marks.push(mk);
    }
  }
  return out;
}

/**
 * 把这一轮扫出来的并进已存的记录 —— **重复扫不会重复记**，所以不必维护"读到第几条"的游标
 * （游标才是会出错的地方：消息被压缩、面板被复制，它立刻就对不上了）。
 *
 * 回答是逐字到达的，一次扫可能只看见前半段，所以同一句话的标记要能**补进去**，
 * 而不是整条重记。
 */
function merge(list, fresh) {
  let changed = false;
  for (const pr of fresh) {
    const hit = list.find((n) => n.text === pr.text);
    if (!hit) {
      // 新的放**末尾**；界面上越新的越靠下，跟读文章一个方向
      list.push({ at: Date.now(), text: pr.text, marks: pr.marks.slice() });
      changed = true;
      continue;
    }
    if (!Array.isArray(hit.marks)) hit.marks = [];
    for (const mk of pr.marks) {
      if (hit.marks.length < MARK_KEEP && !hit.marks.includes(mk)) {
        hit.marks.push(mk);
        changed = true;
      }
    }
  }
  if (list.length > NOTE_KEEP) {
    list.splice(0, list.length - NOTE_KEEP);
    changed = true;
  }
  return changed;
}

/**
 * 头一回跑：把核心当年存在面板上的那些便签搬过来，一条都不丢。
 *
 * 旧数据是**扁平**的（我说的一句、助手标的一条各占一行），新结构是配对的 ——
 * 所以助手那几条挂到它前面最近的一条"我的话"下面；前面还没有我的话的，就只能丢了
 * （一条没有主的标记，正是这次要去掉的那种"它自己的进度"）。
 */
function migrate(old) {
  const out = [];
  for (const n of old) {
    const text = String((n && n.text) || '').trim().slice(0, NOTE_MAX);
    if (!text) continue;
    if (n && n.from === 'assistant') {
      const last = out[out.length - 1];
      if (last && last.marks.length < MARK_KEEP) last.marks.push(text);
      continue;
    }
    out.push({ at: Number(n && n.at) || Date.now(), text, marks: [] });
  }
  return out;
}

/** 扫对话的那个定时器 —— 重载/停用时得收掉 */
let timer = null;

module.exports = {
  name: 'notes',
  description: t('便签：随手便利贴速记、黄色专属输入框，回车直通无限画板，支持拖拽便签派发给AI员工'),
  panel: {
    kind: 'notes',
    aliases: ['sticker'],
    label: t('便签'),
    hint: t('随手便利贴速记，回车直通无限画板，支持拖拽派发给AI'),
    title: t('便签'),
    body: 'messages',
  },

  setup(api) {
    const root = () => api.workspace || '.';
    const bodyFile = (pid) => path.join(root(), fileOf(pid));

    /** 读一块面板的便签；文件不在（或读坏了）返回 null，跟"空数组"分得开 */
    const readPanel = (pid) => {
      try {
        const j = JSON.parse(fs.readFileSync(bodyFile(pid), 'utf8'));
        return Array.isArray(j) ? j : [];
      } catch {
        return null;
      }
    };
    const writePanel = (pid, list) => {
      const f = bodyFile(pid);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(list, null, 2), 'utf8');
    };

    /** 内存镜像：扫的时候不必每拍把几十份文件全读一遍 */
    let state = { panels: {}, at: 0 };

    /*
     * 头一回：把老版本的两种老账按面板拆开 ——
     *   a) 最老的：便签长在面板自己身上（p.notes，扁平的两行式）
     *   b) 后来的：所有人挤在 .ensoul/state/notes.json 里（{ panels: { id: [...] } }）
     * 都是**兼容性调整**，不是新功能 —— 老文件摆在那儿，不认它等于便签全丢。
     * 已经有自己那份的**一律不覆盖**，所以这件事重复跑也安全。
     */
    let seeded = 0;

    // a) 面板自带的旧便签
    for (const p of api.panels()) {
      const old = (p && p.notes) || [];
      if (!Array.isArray(old) || !old.length) continue;
      if (readPanel(p.id)) continue;
      const list = migrate(old.slice(-NOTE_KEEP));
      if (!list.length) continue;
      state.panels[p.id] = list;
      writePanel(p.id, list);
      seeded++;
    }

    // b) 老的单文件
    try {
      const legacy = JSON.parse(fs.readFileSync(path.join(root(), LEGACY), 'utf8'));
      let moved = 0;
      const box = legacy && legacy.panels && typeof legacy.panels === 'object' ? legacy.panels : {};
      for (const id of Object.keys(box)) {
        const raw = box[id];
        if (!Array.isArray(raw) || !raw.length) continue;
        if (readPanel(id)) continue;
        // 更老的结构是扁平的（每条带 from），就地迁成"我说的话 + 它下面的标记"
        const list = raw.some((n) => n && (n.from || !Array.isArray(n.marks))) ? migrate(raw) : raw;
        if (!list.length) continue;
        state.panels[id] = list;
        writePanel(id, list);
        moved++;
      }
      if (seeded || moved) {
        // 老文件**故意不动**：万一这边有问题，老账原封不动还在。
        // 重复搬是无害的 —— 下面"已经有自己那份就跳过"那条保证它不会盖掉新数据。
        api.log(`便签按面板拆开了：面板自带 ${seeded} 份、老单文件 ${moved} 份（老文件 ${LEGACY} 留着没动）`);
      }
    } catch {
      /* 老文件不在，正常（新装的就是这样） */
    }

    // c) 已经有自己那份的，装进内存镜像
    try {
      for (const f of fs.readdirSync(path.join(root(), DIR))) {
        if (!f.endsWith('.json')) continue;
        const id = f.replace(/\.json$/, '');
        if (state.panels[id]) continue;
        const list = readPanel(id);
        if (Array.isArray(list) && list.length) state.panels[id] = list;
      }
    } catch {
      /* 目录还不存在，正常 */
    }

    const scan = () => {
      let changed = false;
      const alive = new Set();

      for (const p of api.panels()) {
        if (!p || !p.id) continue;
        alive.add(p.id);
        if (!Array.isArray(p.chat)) continue;

        // 别给"一条便签都没有"的面板白占槽位：先拿临时数组接，真剪到东西才落盘
        const list = state.panels[p.id] || [];
        if (merge(list, pairs(p.chat))) {
          state.panels[p.id] = list;
          changed = true;
          // **只写这一块面板自己那份** —— 别的不动（这就是分家的意义）
          try {
            writePanel(p.id, list);
          } catch (e) {
            api.log(t('便签写盘出错：'), p.id, (e && e.message) || e);
          }
        }
      }

      // 槽位有上限：超了就先丢"已经不存在的面板"里最旧的那些（连它那份文件一起）
      const ids = Object.keys(state.panels);
      if (ids.length > PANEL_KEEP) {
        const stale = ids
          .filter((id) => !alive.has(id))
          .sort((a, b) => ((state.panels[a][0] || {}).at || 0) - ((state.panels[b][0] || {}).at || 0));
        for (const id of stale.slice(0, ids.length - PANEL_KEEP)) {
          delete state.panels[id];
          try {
            fs.unlinkSync(bodyFile(id));
          } catch {
            /* 文件本来就不在就算了 */
          }
          changed = true;
        }
      }

      if (changed) state.at = Date.now();
    };

    // 头一回就把话说完，界面不用等第一个 tick
    scan();

    const tick = setInterval(() => {
      try {
        scan();
      } catch (e) {
        api.log(t('扫便签出错：'), (e && e.message) || e); // 一个坏面板不许让整个插件停摆
      }
    }, TICK_MS);
    if (tick.unref) tick.unref();
    timer = tick;

    // 便签这个概念的说明，由插件自己讲给模型听 ——
    // 以前这段长在核心的系统提示里，等于核心必须一直认识便签。现在装了插件，
    // 模型才会被告知有这么个东西；卸了它，便签既不存在、也没人多一句嘴。
    //
    // ── 为什么不是每轮都发 ──────────────────────────────────────────────
    //
    // `api.addPrompt` 的正文拼在**本轮用户消息的末尾**，而真正进 `panel.chat` 的是
    // 用户那句原话（index.ts 里 `userMsg.content = text`）—— 也就是说这段说明
    // **压根不进历史**，每轮都是现拼一次、按全价重发，一次缓存都命不中。
    // 三百字看着不多，可它是每一轮 × 每一块面板的固定开销。
    //
    // 改成按**上下文代次**发：一代上下文里说过一遍就够，到下次压缩（历史被换成摘要、
    // 模型手上的上下文换了一茬）才再说一遍。这才是真省下来的部分。
    // 记账只认压缩那几个字段，**不认消息条数** —— 认条数就等于每轮都变，又变回每轮发。
    const sent = new Map();
    /** 这块面板此刻是"第几代"上下文：压缩一次就换一代（/clear 会退回第 0 代） */
    const genOf = (p) => `${(p && p.compact && p.compact.at) || 0}|${(p && p.compact && p.compact.upTo) || 0}`;

    /** 说明正文 —— **常量**，一字不多。它每轮现拼，变了就白花一次钱 */
    const BRIEF =
      t('【便签】用户开口说的那句话，会连同你**紧接着这一轮回答里**用 ==…== 圈出来的信息，') +
      t('一起收进这个面板的便签 —— 对话区右边缘那一串刻度，鼠标指上去就能看到：') +
      t('他说的那句话，下面挂着你这轮标出来的几条。') +
      t('所以 ==…== 该圈的是"**针对他这句话定下来的事**"，不是你自己这一路的进度汇报 ——') +
      t('便签是给用户长期翻的，他要回头查的是"我说了什么、这件事定了什么"，') +
      t('后面几轮你圈的、跟哪句话都对不上的，人家看不到。') +
      t('便签不会塞回你的上下文（那样会一直破坏缓存），所以圈得准比圈得多重要。') +
      `凡是以「${NOTE_PREFIX}」开头的那句话 = 有人从便利贴白板给你派了活：` +
      t('干完之后调一次 sticker_post({ receipt: true, text: "<那句话的原话>" }) 交回执 —— ') +
      t('插件会把发起任务的那张便签盖上「已完成」章，谁干的、几点干完它自己记，') +
      t('你不用写、也别说这段规矩。');

    api.addPrompt((ctx) => {
      const pid = (ctx && ctx.panelId) || '';
      if (!pid) return '';
      const me = api.panels().find((p) => p.id === pid);
      if (!me) return '';

      // 面板删了，它的记账也跟着走 —— 记账是内存里的，只在这一趟运行里管用
      const live = new Set(api.panels().map((p) => p.id));
      for (const k of [...sent.keys()]) if (k !== pid && !live.has(k)) sent.delete(k);

      const gen = genOf(me);
      if (sent.get(pid) === gen) return ''; // 这一代说过一遍了，不必再说
      sent.set(pid, gen);
      return BRIEF;
    });

    // 核心在压缩历史之前会问一句"有什么进了摘要才不丢" —— 便签就是答案。
    // 这是**唯一**把便签送回模型眼前的地方：它不进上下文（那会把缓存废掉一截），
    // 只在压缩那一刻留下一份要点，往后靠摘要带着走。
    api.addSummaryNote((ctx) => {
      const list = (state.panels && ctx && state.panels[ctx.panelId]) || [];
      if (!Array.isArray(list) || !list.length) return '';
      // 条数上限：摘要不是便签的第二份存档，抄太多等于没压
      return list
        .slice(-12)
        .map((n) => {
          const marks =
            Array.isArray(n.marks) && n.marks.length ? `\n  · ${n.marks.slice(0, 3).join('\n  · ')}` : '';
          return `- 用户说过：${n.text}${marks}`;
        })
        .join('\n');
    });

    /*
     * 盯住收件箱：有新交付完成时，自动生成一张交付便签钉在白板上。
     *
     * 投给**哪一块**便签面板：谁在用投给谁 —— 只有一块就投它；开着多块投最近动过的那块。
     * 一块都没有 = 没人接着这单，那就**不写**（写出去也没人看，还凭空长出个文件）。
     * 白板那份文件按面板 id 分家（见 MEMO_DIR），所以这里是"挑一块面板"，不是"挑一份文件"。
     */
    const INBOX_FILE = '.ensoul/state/dispatch.inbox.json';
    const memoFileOf = (pid) =>
      path.join(root(), MEMO_DIR, `${String(pid || '').replace(/[^\w.-]+/g, '_')}.json`);
    const pickBoard = () => {
      const boards = api.panels().filter((p) => p && (p.kind === 'notes' || p.kind === 'sticker'));
      if (!boards.length) return null;
      return boards.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0].id;
    };

    /* ── 投递账本（渲染层写、这里读）─────────────────────────────────── */
    const dropFilePath = () => path.join(root(), DROP_FILE);
    const readDrops = () => {
      try {
        const j = JSON.parse(fs.readFileSync(dropFilePath(), 'utf8'));
        const box = j && j.drops;
        return box && typeof box === 'object' ? box : {};
      } catch {
        return {};
      }
    };
    const writeDrops = (drops) => {
      try {
        fs.mkdirSync(path.dirname(dropFilePath()), { recursive: true });
        fs.writeFileSync(dropFilePath(), JSON.stringify({ at: Date.now(), drops }, null, 2), 'utf8');
      } catch {
        /* 账本写不进去只影响"回执钉回哪块"，不该搅黄钉便签这件事 */
      }
    };
    /** 完成时间：当天只写 HH:mm，隔天补上日期 —— 回执要短，多余的字一个不留 */
    const fmtDone = (t) => {
      const d = new Date(t);
      const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
    };
    const stripPrefix = (t) => {
      const s = String(t || '');
      for (const p of [NOTE_PREFIX, LEGACY_NOTE_PREFIX]) {
        if (s.startsWith(p)) return s.slice(p.length).replace(/^\s+/, '');
      }
      return s;
    };
    /**
     * 员工 id → 头像 / 强调色（查名册）。
     * 兜底盖章时卡上原本没有 targetEmp，账本里也可能只有 id 和名字 ——
     * 头像只能从名册问，问不到就返回空，让卡面退化成"色块 + 首字"。
     */
    const empFace = (id) => {
      const key = String(id || '').trim();
      if (!key) return {};
      try {
        const j = JSON.parse(fs.readFileSync(path.join(root(), ROSTER_FILE), 'utf8'));
        const list = j && Array.isArray(j.contacts) ? j.contacts : [];
        const hit = list.find((c) => c && String(c.id) === key);
        if (!hit) return {};
        return { avatar: String(hit.avatar || ''), accent: String(hit.accent || '') };
      } catch {
        return {};
      }
    };
    const seenTokens = new Set();
    try {
      const initInbox = JSON.parse(fs.readFileSync(path.join(api.workspace || '.', INBOX_FILE), 'utf8'));
      const entries = Array.isArray(initInbox?.entries) ? initInbox.entries : [];
      for (const e of entries) {
        if (e && e.token && e.status === 'done') seenTokens.add(e.token);
      }
    } catch {}

    const inboxCheck = () => {
      try {
        const raw = fs.readFileSync(path.join(api.workspace || '.', INBOX_FILE), 'utf8');
        const inbox = JSON.parse(raw);
        const entries = Array.isArray(inbox?.entries) ? inbox.entries : [];
        const boardId = pickBoard();
        // ⚠ 这里**不看有没有白板**：判据那一步要把"不是便利贴的单"标成已见，
        // 提前 return 会让它们下一拍又被翻出来重判一遍（虽然不写盘，但白跑）。
        let added = false;
        let memoList = [];
        try {
          const j = JSON.parse(fs.readFileSync(memoFileOf(boardId), 'utf8'));
          if (Array.isArray(j)) memoList = j;
        } catch {}

        for (const e of entries) {
          if (!e || !e.token || e.status !== 'done') continue;
          if (seenTokens.has(e.token)) continue;
          seenTokens.add(e.token);

          /**
           * **只认便利贴派出去的单。**
           *
           * 这一段原来没有判据，于是凡是"有文件交付的派单"都会在这儿长出一张便签 ——
           * 美术组交一批头像、开源组交一份报告，白板上都会凭空多一张
           * `[某某 交付] …`，跟便利贴一毛钱关系都没有（用户当场就问过
           * "触手系二伯为什么贴便利贴过来"）。便签是"从白板投出去那件事"的账，
           * 不是所有派单的流水。
           *
           * 认法两条，命中一条就算：投递账本里记着这张卡（noteId 对得上），
           * 或者正文就是便利贴投出去的那句话（前缀）。**两条都不中 = 不是便利贴的单**。
           */
          const taskText = String(e.task || '');
          const viaLedger =
            !!e.noteId && Object.values(readDrops()).some((d) => d && String(d.noteId) === String(e.noteId));
          const viaPrefix = taskText.startsWith(NOTE_PREFIX) || taskText.startsWith(LEGACY_NOTE_PREFIX);
          if (!viaLedger && !viaPrefix) continue;
          if (!boardId) continue; // 真是便利贴的单，但此刻一块白板都没开 —— 不写（写出去也没人看）

          const who = e.by || e.holderName || t('AI员工');
          const fileInfo = Array.isArray(e.files) && e.files.length ? `\n交付文件：${e.files.map(f => path.basename(f)).join(', ')}` : '';
          const noteText = `[${who} 交付]\n${(e.note || e.task || '任务已完成').slice(0, 80)}${fileInfo}`;

          memoList.push({
            id: 'pin_' + Math.random().toString(36).slice(2, 9),
            text: noteText,
            at: Date.now(),
            rotation: (Math.random() - 0.5) * 5,
            color: '#fef08a',
            pinColor: '#10b981',
            isNew: true,
          });
          added = true;
        }

        if (added) {
          if (memoList.length > PIN_KEEP) memoList = memoList.slice(-PIN_KEEP);
          const f = memoFileOf(boardId);
          fs.mkdirSync(path.dirname(f), { recursive: true });
          fs.writeFileSync(f, JSON.stringify(memoList, null, 2), 'utf8');
        }
      } catch {}
    };

    const inboxTimer = setInterval(inboxCheck, 2000);
    if (inboxTimer.unref) inboxTimer.unref();

    // ── 注册便签 / 便利贴工具 ──────────────────────────────────────────
    // 让智能体可以直接往便利贴白板上钉便签（如交付回执、备忘总结等）
    api.addTool(
      {
        name: 'sticker_post',
        description:
          t('向便利贴（Sticker/便签白板）上钉一张新的便签/贴纸卡片。用于返回工作回执、成果汇报、重要备忘或将新事项钉在白板上。') +
          t('贴纸会立刻显示在白板上并带上大头针。'),
        parameters: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: t('便签卡片正文（如回执说明、任务结果等）'),
            },
            color: {
              type: 'string',
              description: t('便签背景颜色（默认黄色 #fef08a；也可选 #fbcfe8 粉, #bbf7d0 绿, #bfdbfe 蓝, #e9d5ff 紫）'),
            },
            pinColor: {
              type: 'string',
              description: t('图钉大头针颜色（如 #ef4444 红色, #10b981 绿色, #3b82f6 蓝色）'),
            },
            panelId: {
              type: 'string',
              description: t('指定钉在哪个便利贴面板上（可选；默认钉在当前或最近使用的便利贴白板上）'),
            },
            receipt: {
              type: 'boolean',
              description:
                t('回执模式：干完「【来自便利贴】」派来的活就这么回。只给 text=那句原话即可 —— ') +
                t('插件会**把发起任务的那张便签盖上一枚「已完成」章**（不另立新卡），') +
                t('谁干的、几点干完由插件自己记，你不用写。'),
            },
          },
          required: ['text'],
        },
        level: 'write',
      },
      (args, ctx) => {
        const text = String(args?.text || '').trim();
        if (!text) return t('错误：便签内容不能为空。');

        const drops = readDrops();
        const myPanel = String((ctx && ctx.panelId) || '');

        /*
         * 找「我该回的那一单」。
         *
         * 账本由渲染层写、插件读，**写的是两份键**：员工 id（早年只有这一份，人看着方便）
         * 与**目标面板 id**（见 SidebarMonitor 的 handleDropNote）。回执是在员工那块面板里
         * 发的，这里手上只有面板 id —— 所以 `drops[myPanel]` 命中就收，这是正路。
         * 老账本（只有员工 id 那批）直查不中，退路是反查白板：哪张卡的目标面板正是"我"，
         * 那就是我的单；多张取最近的那张，已经盖过章的跳过（一单只回一次）。
         */
        const readBoardPins = (file) => {
          try {
            const j = JSON.parse(fs.readFileSync(file, 'utf8'));
            return Array.isArray(j) ? j : [];
          } catch {
            return [];
          }
        };
        /** 拿 noteId 反找出这张卡在哪个白板文件里 —— 账本没带 boardId / 文件时兜底 */
        const findPinFile = (noteId) => {
          if (!noteId) return null;
          let names = [];
          try {
            names = fs.readdirSync(path.join(root(), MEMO_DIR)).filter((n) => n.endsWith('.json'));
          } catch {
            return null;
          }
          for (const n of names) {
            const file = path.join(root(), MEMO_DIR, n);
            const pin = readBoardPins(file).find((p) => p && p.id === noteId);
            if (pin) return { file, boardId: n.replace(/\.json$/, ''), pin };
          }
          return null;
        };
        const findMyDrop = () => {
          const direct = drops[myPanel];
          if (direct && direct.noteId) {
            const found = findPinFile(direct.noteId);
            return {
              ...direct,
              boardId: direct.boardId || (found ? found.boardId : ''),
              file: found ? found.file : '',
            };
          }
          let names = [];
          try {
            names = fs.readdirSync(path.join(root(), MEMO_DIR)).filter((n) => n.endsWith('.json'));
          } catch {
            return null;
          }
          // 兜底 2：员工工作面被重建过（面板 id 换了、卡上的 targetEmp.panelId 成了旧号），
          // 白板反查就也落空。这时按**面板标题 == 账本里的员工名**认一次——
          // 严格相等才算数，名字对不上宁可不认，也不能把别人的单盖到自己头上。
          let myTitle = '';
          try {
            const mePanel = api.panels().find((p) => p.id === myPanel);
            myTitle = String((mePanel && mePanel.title) || '').trim();
          } catch {}
          if (myTitle) {
            let latest = null;
            for (const v of Object.values(drops)) {
              if (!v || !v.noteId || !v.empName) continue;
              if (String(v.empName).trim() !== myTitle) continue;
              if (!latest || (v.at || 0) > (latest.at || 0)) latest = v;
            }
            if (latest) {
              const found = findPinFile(latest.noteId);
              if (found && !found.pin.done) {
                return { ...latest, boardId: found.boardId, file: found.file, task: found.pin.text || latest.task || '' };
              }
            }
          }

          let best = null;
          for (const n of names) {
            const file = path.join(root(), MEMO_DIR, n);
            for (const p of readBoardPins(file)) {
              if (!p || p.done) continue;
              const t = p.targetEmp;
              if (!t || String(t.panelId || '') !== myPanel) continue;
              if (!best || (p.at || 0) > (best.pin.at || 0)) {
                best = { file, boardId: n.replace(/\.json$/, ''), pin: p };
              }
            }
          }
          if (!best) return null;
          const t = best.pin.targetEmp || {};
          return {
            boardId: best.boardId,
            file: best.file,
            noteId: best.pin.id,
            empId: t.id || '',
            empName: t.name || '',
            task: best.pin.text || '',
          };
        };

        /*
         * 回执 = **盖回原卡**，不另立一张新卡。
         *
         * 立新卡等于把"我让你干的那件事"和"你干完了"拆成两张，板子对半长、还得靠人脑配对。
         * 盖回原卡之后一块板就是一份台账：一件事一格，格子上有章没章就是进度。
         * 卡面文字**一个字不改**（任务原话原样留着）—— 章是后加的，不是把话换掉。
         */
        const drop = args?.receipt ? findMyDrop() : null;
        let targetPanelId = String(args?.panelId || '');
        if (drop && drop.noteId) {
          // 落点优先级：账本/反查给的文件 → 账本里的 boardId → 按 noteId 全板再找一遍。
          // 全都没有就别硬拼路径（memoFileOf('') 会拼出 memo/.json 这种空名文件）。
          const df = drop.file || (drop.boardId ? memoFileOf(drop.boardId) : '') || (findPinFile(drop.noteId) || {}).file || '';
          let dlist = [];
          try {
            const j = JSON.parse(fs.readFileSync(df, 'utf8'));
            if (Array.isArray(j)) dlist = j;
          } catch {}
          if (Array.isArray(dlist) && dlist.length) {
            const at = Date.now();
            let hit = false;
            /**
             * 兜底补 targetEmp 时用的头像 / 强调色。
             * 先信账本（渲染层写账时顺手带了），账本没有就查名册 ——
             * 两处都没有才留空。**不许只写 id 和名字**：那样盖上章的卡
             * 只剩一个色块加首字，看着像回错了人。
             */
            const face = (() => {
              const f = { avatar: String(drop.empAvatar || ''), accent: String(drop.empAccent || '') };
              if (f.avatar) return f;
              const r = empFace(drop.empId);
              return { avatar: r.avatar || '', accent: f.accent || r.accent || '' };
            })();
            dlist = dlist.map((p) => {
              if (!p || p.id !== drop.noteId) return p;
              hit = true;
              const { receipt: _legacy, ...rest } = p;
              return {
                ...rest,
                targetEmp:
                  p.targetEmp ||
                  (drop.empId
                    ? { id: drop.empId, name: drop.empName, avatar: face.avatar, accent: face.accent, panelId: myPanel }
                    : p.targetEmp),
                targetSent: true,
                done: { at, by: drop.empName || t('AI员工'), empId: drop.empId || '', panelId: myPanel },
              };
            });
            if (hit) {
              try {
                fs.mkdirSync(path.dirname(df), { recursive: true });
                fs.writeFileSync(df, JSON.stringify(dlist, null, 2), 'utf8');
                // 这一单回完了：账本里那条就此作废（**双键都要清** —— 写的时候写了两份，
                // 只删一个键会让同一单被下一张便签再认领一次），免得误当成"又来了一单"。
                delete drops[myPanel];
                for (const [k, v] of Object.entries(drops)) {
                  if (!v) continue;
                  if (v.noteId && v.noteId === drop.noteId) delete drops[k];
                  else if (drop.empId && k === drop.empId) delete drops[k];
                }
                writeDrops(drops);
                return `已给便签「${stripPrefix(drop.task).slice(0, 30)}」盖上「已完成」章（${drop.empName || 'AI员工'} · ${fmtDone(at)}）。`;
              } catch (e) {
                return `回执盖章失败：${(e && e.message) || e}`;
              }
            }
            /* 原卡被删了：落到下面的"钉一张新卡"，总比回执凭空消失强 */
          }
        }

        targetPanelId =
          targetPanelId ||
          (ctx?.panelId && api.panels().some(p => p.id === ctx.panelId && (p.kind === 'notes' || p.kind === 'sticker')) ? ctx.panelId : pickBoard());
        if (!targetPanelId) {
          return t('未找到处于打开状态的便利贴（Sticker）面板，请先打开便利贴面板。');
        }

        const f = memoFileOf(targetPanelId);
        let list = [];
        try {
          if (fs.existsSync(f)) {
            list = JSON.parse(fs.readFileSync(f, 'utf8')) || [];
          }
        } catch {}
        if (!Array.isArray(list)) list = [];

        const newPin = {
          id: 'pin_' + Math.random().toString(36).slice(2, 9),
          text,
          at: Date.now(),
          rotation: (Math.random() - 0.5) * 5,
          color: args.color || '#fef08a',
          pinColor: args.pinColor || '#10b981',
          isNew: true,
        };

        list.push(newPin);
        if (list.length > PIN_KEEP) list = list.slice(-PIN_KEEP);

        try {
          fs.mkdirSync(path.dirname(f), { recursive: true });
          fs.writeFileSync(f, JSON.stringify(list, null, 2), 'utf8');
          return `成功将便签钉至便利贴白板（ID: ${newPin.id}）：\n"${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`;
        } catch (e) {
          return `便签写入失败：${(e && e.message) || e}`;
        }
      }
    );

    api.log(`便签就绪（正文 ${DIR}/<面板 id>.json；白板 ${MEMO_DIR}/<面板 id>.json）`);
  },

  /** 插件被停用/重载时收拾自己的摊子 */
  dispose() {
    if (timer) clearInterval(timer);
    timer = null;
  },
};
