/**
 * 番茄钟 —— 计时这件事的"脑"。
 *
 * 为什么从核心搬出来：计时、轮次结算、到点提醒都是**功能**，不是"界面画不出来
 * 所以必须住在核心里的东西"。核心只留插件做不到的（画界面、停靠树、对话本身）。
 *
 * 两条文件通道（跟 todo / notes 同一个路子，不为它单开 IPC）：
 *
 *   状态  .ensoul/state/pomodoro.json      插件写，面板读   —— 面板是哑的显示器
 *   命令  .ensoul/state/pomodoro.cmd.json  面板写，插件读   —— 面板只是遥控器
 *
 * 为什么"什么时候该休息"必须算在主进程：
 *   面板切到别的标签页会被卸载，窗口最小化后渲染层的定时器会被浏览器降频 ——
 *   计时就飘了。主进程的 interval 不受这些影响，所以**番茄钟哪怕面板没显示也照常走完**，
 *   到点该提醒就提醒。
 *
 * 状态里存的是**绝对到点时刻**（until），不是"还剩多少毫秒"：
 *   于是面板自己每 250ms 算一次倒计时就行，插件不必每秒往磁盘写一次。
 *   磁盘只在"局面真的变了"时才写 —— 开始 / 暂停 / 重置 / 换段 / 结算。
 */

const fs = require('fs');
const path = require('path');

/** 测试环境（纯 node）里没有 electron，拿不到就算了 —— 提醒不是计时的前提 */
let el = null;
try {
  el = require('electron');
} catch {
  el = null;
}

const MIN = 60_000;
/** 几个番茄换一次长休 */
const CYCLE = 4; // 只是兜底；真正生效的是参数 cycle（见 PARAMS）
/** 多久看一次命令与到点 —— 300ms 够跟手，读的是个几百字节的小文件，代价可以忽略 */
const TICK = 300;
/** 面板写的命令文件（相对工作区） */
const CMD_FILE = '.ensoul/state/pomodoro.cmd.json';
/** 最多记住几个面板的时钟 —— 开过的面板多了，就按最近用过的留 */
const MAX_PANELS = 12;

const PHASES = ['work', 'short', 'long'];
const LABEL = { work: t('专注'), short: t('短休息'), long: t('长休息') };
const DEFAULTS = { work: 25, short: 5, long: 15, auto: false, sound: true, cycle: 4 };

/**
 * 声明成**可调参数**的东西：设置面板里能改，助手也能改（见 plugins/plugin-kit）。
 *
 * 只放"不同的人会设成不同值"的那几个。面板上那两个开关（自动接续、响不响）是
 * **单个面板**的事，留在这儿的这几个是新面板开局用的默认值。
 */
const PARAMS = {
  work: { label: t('专注时长（分钟）'), type: 'number', default: 25, min: 1, max: 240, hint: t('一个番茄走多久') },
  short: { label: t('短休息（分钟）'), type: 'number', default: 5, min: 1, max: 60 },
  long: { label: t('长休息（分钟）'), type: 'number', default: 15, min: 1, max: 120 },
  cycle: { label: t('几个番茄一次长休'), type: 'number', default: 4, min: 2, max: 8 },
  auto: { label: t('自动接续下一段'), type: 'bool', default: false, hint: t('不勾就要点一下才开始下一段') },
  sound: { label: t('到点响一声'), type: 'bool', default: true, hint: t('系统通知之外再响一声') },
};

/** 默认值从参数来：参数一改插件会重新 setup，于是新开局的面板按新默认走 */
function defaultsFrom(api) {
  const d = { ...DEFAULTS };
  for (const k of Object.keys(PARAMS)) {
    const v = api.param(k);
    if (v !== undefined && v !== null) d[k] = v;
  }
  d.cycle = Math.max(2, Math.round(Number(d.cycle) || CYCLE));
  return d;
}

const mins = (c, phase) => Math.max(1, Number(c.cfg[phase]) || DEFAULTS[phase]) * MIN;
const remainIn = (c, now) => (c.running ? Math.max(0, c.until - now) : Math.max(0, c.left));

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 240 ? n : fallback;
};

function newClock(cfg, defaults) {
  const c = {
    phase: 'work',
    done: 0,
    running: false,
    until: 0,
    left: 0,
    cfg: { ...defaults, ...(cfg || {}) },
    seen: Date.now(),
  };
  c.left = mins(c, c.phase);
  return c;
}

/** 磁盘上那份状态可能是旧的、或者被人手改坏了 —— 只信字段齐全的那部分 */
function normalize(raw, defaults) {
  const out = { at: 0, panels: {} };
  const panels = raw && raw.panels && typeof raw.panels === 'object' ? raw.panels : {};
  for (const [id, c] of Object.entries(panels)) {
    if (!c || typeof c !== 'object') continue;
    if (!PHASES.includes(c.phase)) continue;
    const cfg = { ...defaults };
    for (const k of ['work', 'short', 'long']) cfg[k] = num(c.cfg && c.cfg[k], defaults[k]);
    cfg.cycle = Math.max(2, Math.round(Number((c.cfg && c.cfg.cycle) || defaults.cycle)));
    cfg.auto = !!(c.cfg && c.cfg.auto);
    cfg.sound = !(c.cfg && c.cfg.sound === false);
    out.panels[id] = {
      phase: c.phase,
      done: Math.max(0, Math.floor(Number(c.done) || 0)),
      running: !!c.running,
      until: Number(c.until) || 0,
      left: Number(c.left) || 0,
      cfg,
      // 没有 seen 的老状态按"刚刚动过"算 —— 版本升级上来不该把人的番茄数清掉
      seen: Number(c.seen) || Date.now(),
    };
  }
  out.at = Number(raw && raw.at) || 0;
  return out;
}

/** 模块级：dispose 要能收掉它（插件文件改了会重装，旧的那份靠这个收摊） */
let timer = null;

module.exports = {
  params: PARAMS,
  name: 'pomodoro',
  description: t('番茄钟：专注 / 休息的节奏由它来算，到点提醒 —— 面板只是它的遥控器'),

  /**
   * 自带一种面板类型。声明是**纯数据**（它要过 IPC，函数过不去）；脸在 panel.tsx、
   * 皮在 panel.css —— 渲染层扫 plugins 下每个目录的 panel.tsx 和同名 .css 自动收走。
   * 加这一整套不用核心动一行：核心只按这份声明装配。
   * 声明必须在 module.exports **里面** —— 放外面是语法错误，整个插件都加载不了。
   */
  panel: {
    kind: 'pomodoro',
    label: t('番茄钟'),
    hint: t('专注 25 分钟，休息 5 分钟'),
    title: t('番茄钟'),
    body: 'messages',
    floatBare: true,
  },

  setup(api) {
    const defaults = defaultsFrom(api);
    const state = normalize(api.state.load(null), defaults);
    const cmdPath = path.join(api.workspace || '.', CMD_FILE);
    let lastSeq = 0;

    const save = () => {
      state.at = Date.now();
      api.state.save(state);
    };

    /** 到点提醒：系统通知 +（可选）一声。发不出去也不影响计时本身 */
    function alarm(title, body, sound) {
      try {
        if (el && typeof el.Notification === 'function') new el.Notification({ title, body, silent: true }).show();
      } catch {
        /* 不支持或没权限，静默跳过 */
      }
      if (sound) {
        try {
          if (el && el.shell && typeof el.shell.beep === 'function') el.shell.beep();
        } catch {
          /* 没声音也不影响计时 */
        }
      }
    }

    /** 一段结束：结算番茄、换下一阶段；勾了自动接续就接着跑，否则停下等用户 */
    function settle(c, now) {
      if (c.phase === 'work') {
        c.done += 1;
        c.phase = c.done % Math.max(2, Math.round(Number(c.cfg.cycle) || CYCLE)) === 0 ? 'long' : 'short';
      } else {
        c.phase = 'work';
      }
      c.left = mins(c, c.phase);
      alarm(
        `${LABEL[c.phase]} ${c.cfg[c.phase]} 分钟`,
        c.phase === 'work' ? t('休息好了，回来接着干。') : t('这一轮结束了，去歇会儿。'),
        c.cfg.sound,
      );
      if (c.cfg.auto) {
        c.until = now + c.left;
        c.running = true;
      } else {
        c.running = false;
      }
    }

    /** 面板写来的那条命令 —— 认 seq，同一个文件被重复读到不会重复执行 */
    function applyCmd(raw, now) {
      const id = String((raw && raw.panelId) || '');
      if (!id) return false;
      const c = state.panels[id] || (state.panels[id] = newClock(null, defaults));
      c.seen = now;

      switch (raw.cmd) {
        case 'toggle': {
          if (c.running) {
            c.left = remainIn(c, now);
            c.running = false;
          } else {
            c.until = now + (c.left > 0 ? c.left : mins(c, c.phase));
            c.running = true;
          }
          return true;
        }
        case 'reset': {
          c.running = false;
          c.left = mins(c, c.phase);
          return true;
        }
        case 'skip': {
          c.running = false;
          c.left = 0;
          settle(c, now);
          return true;
        }
        case 'preset': {
          c.cfg.work = num(raw.work, c.cfg.work);
          c.cfg.short = num(raw.short, c.cfg.short);
          c.cfg.long = num(raw.long, c.cfg.long);
          // 跑着就只影响下一段，不打断手头这一轮
          if (!c.running) c.left = mins(c, c.phase);
          return true;
        }
        case 'auto':
        case 'sound': {
          c.cfg[raw.cmd] = !!raw.value;
          return true;
        }
        default:
          return false;
      }
    }

    /**
     * 面板写的命令**队列**。
     *
     * 为什么是队列而不是"一个文件装一条命令"：面板两次点击要是落在同一跳（300ms）里，
     * 后一条会把前一条盖掉 —— 丢命令是看得见的错误（点了没反应），队列就没有这个问题。
     */
    function readCmdQueue() {
      try {
        const j = JSON.parse(fs.readFileSync(cmdPath, 'utf8'));
        return Array.isArray(j && j.cmds) ? j.cmds : [];
      } catch {
        return []; // 还没发过命令，或者正读到一半 —— 下一跳再说
      }
    }

    /** 执行过的清掉。清不掉也无所谓：seq 不会再大过 lastSeq，同一批不会被执行两次 */
    function clearCmdQueue() {
      try {
        fs.writeFileSync(cmdPath, JSON.stringify({ cmds: [] }), 'utf8');
      } catch {
        /* 清不掉就留着，下一跳还会走到这里 */
      }
    }

    /**
     * 只按"记住几个面板"封顶，按最近动过的顺序留 —— 不按时间清。
     * 按时间清会顺手把人家的番茄数抹掉，而"已完成的番茄数"是这个面板全部的历史。
     */
    function prune() {
      const ids = Object.keys(state.panels);
      if (ids.length <= MAX_PANELS) return false;

      const keep = ids
        .sort((a, b) => (state.panels[b].seen || 0) - (state.panels[a].seen || 0))
        .slice(0, MAX_PANELS);
      let cut = false;
      for (const id of ids) {
        if (keep.includes(id)) continue;
        if (state.panels[id].running) continue; // 还在跑的绝不删
        delete state.panels[id];
        cut = true;
      }
      return cut;
    }

    function tick() {
      const now = Date.now();
      let dirty = false;

      let applied = false;
      for (const raw of readCmdQueue()) {
        const s = Number(raw && raw.seq);
        if (!Number.isFinite(s) || s <= lastSeq) continue; // 已经执行过的，跳过
        lastSeq = s;
        if (applyCmd(raw, now)) applied = true;
      }
      if (applied) {
        clearCmdQueue();
        dirty = true;
      }

      for (const c of Object.values(state.panels)) {
        if (c.running && now >= c.until) {
          settle(c, now);
          dirty = true;
        }
      }

      if (prune()) dirty = true;
      if (dirty) save();
    }

    timer = setInterval(tick, TICK);
    if (timer && typeof timer.unref === 'function') timer.unref();

    api.log(`番茄钟就绪（状态 .ensoul/state/pomodoro.json，命令 ${CMD_FILE}）`);
  },

  dispose() {
    if (timer) clearInterval(timer);
    timer = null;
  },
};
