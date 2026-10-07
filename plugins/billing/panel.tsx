import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PanelFaceProps } from '../../src/shared/types';

/**
 * 实时计费面板 —— 一块哑显示器 + 一个按钮。
 *
 * 它自己**不记账**：记账在插件（主进程，见 plugins/billing/index.js）里，结果写在
 * `.ensoul/state/billing.json`，这里每 2 秒读一次。为什么不让脸直接算：脸只有读/写
 * 工作区文件这几样能力，而且**面板切到别的标签页会被卸载** —— 谁在盯着账就成了运气问题。
 *
 * 三份文件（老规矩，不开 IPC）：
 *   .ensoul/state/billing.json       明细 + 分支（插件写、这里读）
 *   .ensoul/state/billing.live.json  跑动中那一轮（同上，单独一份小的）
 *   .ensoul/state/billing.cmd.json   这里写、插件读 —— 打分支 / 切分支 / 删分支
 *
 * 主角是**一个模型两根横柱**：上面用量、下面价格。
 *   · 每根柱子里再切成三截 —— 缓存命中 / 未命中输入 / 输出（用量按 token，价格按元）。
 *   · 长度以这一段里**最大的那个模型为满格**：它 100%，别的按比值缩。
 *     所以横着比的是"谁是大头"，不是"绝对值多少"（绝对值就写在柱头）。
 */

interface Entry {
  id: string;
  at: number;
  pick: string;
  tin: number;
  tout: number;
  hit: number;
  miss: number;
  /** null = 这个模型没标价（免费 / 未定价）：只计量不计费 */
  cost: number | null;
  /** 花费按三档拆开（元）：缓存命中 / 未命中输入 / 输出。旧记录没有这三项 → 全 0 */
  ch: number;
  cm: number;
  co: number;
}

interface Branch {
  id: string;
  at: number;
  label: string;
}

/**
 * 已经不在明细里的更早的账：按模型合计（键是 `provider::model`，空串 = 未记录模型）。
 * 插件把超出的老明细折进这里（见 index.js 的 FEED_KEEP）：明细只留面板读得动的那么多，
 * 但"全部时段"的合计、老模型的钱一笔都不少。
 */
interface Past {
  rounds: number;
  tin: number;
  tout: number;
  hit: number;
  miss: number;
  cost: number;
  ch: number;
  cm: number;
  co: number;
  free: number;
}

interface Snapshot {
  at: number;
  entries: Entry[];
  dropped: number;
  branches: Branch[];
  selected: string;
  /** 折叠掉的更早的账（按模型合计），见上面 */
  past: Record<string, Past>;
  /** 明细的起点时刻；>0 说明有账已经折进 past 了 */
  feedFrom: number;
  /** 逐笔明细保留几天（插件当前的值，只用来在说明里显示） */
  rawDays: number;
  /** 合计保留几天；0 = 永久 */
  keepDays: number;
}

interface Live {
  at: number;
  rounds: number;
  cost: number;
  tin: number;
  tout: number;
}

/**
 * 面板读的是**有界的那一份**（billing.feed.json），不是账本本身。
 *
 * 为什么分开：面板读文件走核心的 fs:read，**超过 300KB 只回一句占位文字**
 * （见 src/main/fsapi.ts 的 readText）。账本是全量的、只涨不缩，长过 300KB 那天，
 * 这块面板就再也读不回来 —— 界面上一片"还没记录"，看着像插件坏了，其实账一直在记。
 * 所以插件另写一份明细有界的给面板读，账本自己留着全量。
 */
const STATE = '.ensoul/state/billing.feed.json';
const LIVE = '.ensoul/state/billing.live.json';
const CMD = '.ensoul/state/billing.cmd.json';
const DAY = 86_400_000;

/**
 * 柱子里那三截的颜色。**同一个颜色在用量柱和价格柱里意思是同一个东西** ——
 * 上面那根说"这些 token 花在哪"，下面那根说"这些钱花在哪"，对得上才读得懂。
 */
const SEG_COLOR = { hit: '#4fb286', miss: '#5b8cff', out: '#c9924a' };

/**
 * 看哪一段账。默认 24 小时（用户要的就是"今天花了多少"）。
 *
 * `branch` 那一档的画法和别的都不一样：它的起点**由分支点决定，跟时间窗无关**
 * （ms: -1 是个占位，算起点时根本走不到它）。
 *
 * 为什么非要单独给它一档：别的档是"时间窗和分支取更晚的那个"。三天前打的分支配上
 * 24 小时窗，前两天的账就被悄悄切掉了 —— 数字看着还是个正常小数，拿来量一整段
 * 实验却会量错。想要精确的整段增量，就得有一个"只认分支点"的档。
 */
const RANGES = [
  { k: '24h', label: '24 小时', ms: DAY },
  { k: '7d', label: '7 天', ms: 7 * DAY },
  { k: '30d', label: '30 天', ms: 30 * DAY },
  { k: 'all', label: '全部', ms: 0 },
  { k: 'branch', label: '分支', ms: -1 },
] as const;
type RangeKey = (typeof RANGES)[number]['k'];

/** 看哪几样：都看 / 只看用量 / 只看价格。表格的列也跟着它走 */
const VIEWS = [
  { k: 'both', label: '都看' },
  { k: 'tok', label: '用量' },
  { k: 'cost', label: '价格' },
] as const;
type ViewKey = (typeof VIEWS)[number]['k'];

const n0 = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const empty = (): Snapshot => ({
  at: 0,
  entries: [],
  dropped: 0,
  branches: [],
  selected: '',
  past: {},
  feedFrom: 0,
  rawDays: 0,
  keepDays: 0,
});

function parse(text: string, panelId: string): Snapshot | null {
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== 'object') return null;
    const entries: Entry[] = Array.isArray(j.entries)
      ? j.entries
          .filter((e: any) => e && typeof e === 'object')
          .map((e: any) => ({
            id: String(e.id || ''),
            at: n0(e.at),
            pick: String(e.pick || ''),
            tin: Math.max(0, n0(e.tin)),
            tout: Math.max(0, n0(e.tout)),
            hit: Math.max(0, n0(e.hit)),
            miss: Math.max(0, n0(e.miss)),
            cost: e.cost === null || e.cost === undefined ? null : n0(e.cost),
            ch: Math.max(0, n0(e.ch)),
            cm: Math.max(0, n0(e.cm)),
            co: Math.max(0, n0(e.co)),
          }))
      : [];
    const rawBr = j.branches && typeof j.branches === 'object' ? j.branches[panelId] : null;
    const branches: Branch[] = Array.isArray(rawBr)
      ? rawBr
          .filter((b: any) => b && typeof b === 'object')
          .map((b: any) => ({ id: String(b.id || ''), at: n0(b.at), label: String(b.label || '') }))
          .filter((b) => b.id)
      : [];
    const past: Record<string, Past> = {};
    if (j.past && typeof j.past === 'object') {
      for (const [k, v] of Object.entries(j.past as Record<string, any>)) {
        if (!v || typeof v !== 'object') continue;
        past[String(k)] = {
          rounds: Math.max(0, n0(v.rounds)),
          tin: Math.max(0, n0(v.tin)),
          tout: Math.max(0, n0(v.tout)),
          hit: Math.max(0, n0(v.hit)),
          miss: Math.max(0, n0(v.miss)),
          cost: Math.max(0, n0(v.cost)),
          ch: Math.max(0, n0(v.ch)),
          cm: Math.max(0, n0(v.cm)),
          co: Math.max(0, n0(v.co)),
          free: Math.max(0, n0(v.free)),
        };
      }
    }
    return {
      at: n0(j.at),
      entries,
      dropped: Math.max(0, n0(j.dropped)),
      branches,
      selected: String((j.selected && j.selected[panelId]) || ''),
      past,
      feedFrom: Math.max(0, n0(j.feedFrom)),
      rawDays: Math.max(0, n0(j.rawDays)),
      keepDays: Math.max(0, n0(j.keepDays)),
    };
  } catch {
    return null; // 还没写过，或者正读到一半 —— 下一跳再说
  }
}

function parseLive(text: string): Live | null {
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== 'object') return null;
    return {
      at: n0(j.at),
      rounds: Math.max(0, n0(j.rounds)),
      cost: n0(j.cost),
      tin: n0(j.tin),
      tout: n0(j.tout),
    };
  } catch {
    return null;
  }
}

/**
 * 命令排成一条队列往后发 —— 两次点击挨得再近也不会丢掉前一条。
 * 这个 Promise 链是模块级的（不是每挂载一次一条）：面板卸载重挂也不该乱序。
 */
let chain: Promise<void> = Promise.resolve();

function enqueue(fs: PanelFaceProps['fs'], payload: Record<string, unknown>) {
  const run = async () => {
    let cmds: unknown[] = [];
    try {
      const j = JSON.parse(await fs.read(CMD));
      if (Array.isArray(j?.cmds)) cmds = j.cmds;
    } catch {
      cmds = [];
    }
    cmds.push(payload);
    await fs.write(CMD, JSON.stringify({ cmds: cmds.slice(-20) }));
  };
  chain = chain.then(run).catch(() => {});
  return chain;
}

/**
 * 这一段的起点（毫秒时刻）。**纯函数** —— 这块是"选分支会不会算错"的对错所在，
 * 抽出来才能脱离界面单独验（主进程点不了这块面板）。
 *
 * 两条规则，差在「分支」那一档：
 *
 *   普通档（24 小时 / 7 天 / …） → 窗和分支**取更晚**的那个。
 *     理由：窗里本来就不含更早的账，挡住它是诚实的。代价是"分支比窗早"时
 *     前面那段会被吃掉 —— 所以想要精确整段的人不该用这些档。
 *
 *   「分支」档 → **只认分支点**，时间窗完全不参与。
 *     这是"我要精确量这一段实验"的档：不管多久以前打的点，都从头算起。
 *     没选分支时退成 0（= 从头），跟「全部」等价。
 */
export function fromOf(range: RangeKey, now: number, branchAt: number): number {
  if (range === 'branch') return branchAt || 0;
  const ms = RANGES.find((r) => r.k === range)?.ms ?? DAY;
  const rangeFrom = ms > 0 ? now - ms : 0;
  return Math.max(rangeFrom, branchAt || 0);
}

/** 大数字好读：12.3M / 45.6k */
const fmt = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`;

/** 钱按用量级换精度：花了几毛的显示 4 位小数，花了上百的显示 2 位 */
const yuan = (n: number) => `¥${n.toFixed(n >= 100 ? 2 : n >= 1 ? 3 : 4)}`;

const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const ago = (ms: number) => {
  const d = Math.max(0, Date.now() - (ms || 0));
  if (d < 60_000) return t('刚刚');
  if (d < 3_600_000) return t('{n} 分钟前', { n: Math.round(d / 60_000) });
  if (d < 86_400_000) return t('{n} 小时前', { n: Math.round(d / 3_600_000) });
  return t('{n} 天前', { n: Math.round(d / 86_400_000) });
};

/** 模型名：`provider::model` 只取后半截，带提供方的一整串放在悬停里 */
const modelName = (pick: string) => {
  const i = pick.indexOf('::');
  return i < 0 ? pick || t('未记录模型') : pick.slice(i + 2);
};

/** 一段账合计起来（顶部两个大数用） */
interface Sum {
  rounds: number;
  tin: number;
  tout: number;
  hit: number;
  miss: number;
  cost: number;
  /** 这一段里有多少轮是"没标价"的模型（免费模型只计量不计费） */
  free: number;
}

const sum = (list: Entry[], past?: Record<string, Past>): Sum => {
  const t: Sum = { rounds: 0, tin: 0, tout: 0, hit: 0, miss: 0, cost: 0, free: 0 };
  for (const e of list) {
    t.rounds += 1;
    t.tin += e.tin;
    t.tout += e.tout;
    t.hit += e.hit;
    t.miss += e.miss;
    if (e.cost === null) t.free += 1;
    else t.cost += e.cost;
  }
  // 折进 past 的那些（更早、已经不在明细里的账）一起算 —— 全时段合计才是真的全时段
  for (const p of Object.values(past || {})) {
    t.rounds += p.rounds;
    t.tin += p.tin;
    t.tout += p.tout;
    t.hit += p.hit;
    t.miss += p.miss;
    t.cost += p.cost;
    t.free += p.free;
  }
  return t;
};

/** 一个模型在这段时间里的账 */
export interface MSum {
  pick: string;
  rounds: number;
  /** 缓存命中 / 未命中输入 / 输出，三个加起来就是这一段的全部 token */
  hit: number;
  miss: number;
  tout: number;
  tok: number;
  cost: number;
  /** 花费的三档拆分（元），跟上面三个 token 一一对应 */
  ch: number;
  cm: number;
  co: number;
  /** 有多少轮是没标价的模型 */
  free: number;
}

/**
 * 按模型归总 —— **纯函数**，不在组件里现算。
 *
 * 这一段是"按模型计费"的对错所在（谁和谁合成一个、三档怎么加、没定价的怎么算），
 * 所以抽出来能脱离界面单独验：主进程那边点不了这块面板。
 */
export function byModel(entries: Entry[], from: number, past?: Record<string, Past>, feedFrom = 0): MSum[] {
  const m = new Map<string, MSum>();
  /**
   * past 里的账是**按模型合计**的，没有逐条时刻 —— 所以只有"这一段从明细起点之前就开始"
   * 的窗口才把它算进来（早于明细起点的窗口本来就该含它）。更窄的窗口里它会被略过：
   * 宁可少算一点老账，也不能把它当成"刚刚花的"混进增量里。
   */
  if (past && from <= feedFrom) {
    for (const [k, p] of Object.entries(past)) {
      m.set(k, {
        pick: k,
        rounds: p.rounds,
        hit: p.hit,
        miss: p.miss,
        tout: p.tout,
        tok: p.tin + p.tout,
        cost: p.cost,
        ch: p.ch,
        cm: p.cm,
        co: p.co,
        free: p.free,
      });
    }
  }
  for (const e of entries) {
    if (e.at < from) continue;
    const key = e.pick || '';
    let x = m.get(key);
    if (!x) {
      x = { pick: key, rounds: 0, hit: 0, miss: 0, tout: 0, tok: 0, cost: 0, ch: 0, cm: 0, co: 0, free: 0 };
      m.set(key, x);
    }
    x.rounds += 1;
    x.hit += e.hit;
    x.miss += e.miss;
    x.tout += e.tout;
    x.tok += e.tin + e.tout;
    if (e.cost === null) x.free += 1;
    else {
      x.cost += e.cost;
      x.ch += e.ch;
      x.cm += e.cm;
      x.co += e.co;
    }
  }
  return [...m.values()];
}

/** 按当前口径排座次：谁大谁在上面 */
export function rank(models: MSum[], view: ViewKey): MSum[] {
  const cost = (m: MSum) => (view === 'tok' ? 0 : m.cost);
  const tok = (m: MSum) => (view === 'cost' ? 0 : m.tok);
  return [...models].sort((a, b) => cost(b) - cost(a) || tok(b) - tok(a) || b.rounds - a.rounds);
}

/**
 * 一根横柱：左边是标签和绝对值，中间是轨道（满格 = 这一段里最大的那个模型），
 * 里面这条按比值缩，再按三截分色。
 *
 * 绝对值写在柱头而不是柱尾：所有柱子从同一条竖线起跑，把数字挂在尾巴上
 * 就会跟着柱子的长短左右乱跳，竖着扫下来读不成一列。
 */
function Bar({
  label,
  value,
  pct,
  segs,
  zero,
}: {
  label: string;
  /** 柱头那个绝对值（`1.2M tok` / `¥0.9000` / `未定价`） */
  value: string;
  /** 相对最大那个模型的百分比（100 = 满格） */
  pct: number;
  segs: { v: number; c: string; k: string }[];
  /** 一个都没有时（没花钱 / 没用量）在轨道左边点一小截，别让这一行看着像坏了 */
  zero: boolean;
}) {
  const total = segs.reduce((n, s) => n + s.v, 0);
  return (
    <div className="mb-row">
      <span className="mb-k">{label}</span>
      <span className="mb-track">
        {total <= 0 && zero ? (
          <span className="mb-nil" />
        ) : (
          <span className="mb-fill" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}>
            {segs.map((s) => (
              <i key={s.k} style={{ flexGrow: s.v, background: s.c }} />
            ))}
          </span>
        )}
      </span>
      <span className="mb-val">{value}</span>
    </div>
  );
}

/**
 * 一个模型**一行**：左边一栏是模型名和轮次，右边两根横柱（用量 / 价格）。
 *
 * 为什么名字在左边而不是上面：这两根柱子是**横向**的，横着排就是为了能并排比长短 ——
 * 名字摆到柱子上方，左边那一栏就空着，柱子只能从整行最左开始画，
 * 于是每行的柱子起点不一样、也就没法竖着扫下来比。名字占住左侧固定一栏之后，
 * 所有柱子从同一条竖线起跑，长短一眼就能横向比。
 *
 * 抽成组件是为了能无头渲染出来断言（主进程点不了面板，界面对不对 build 也看不出来）。
 */
export function ModelCard({ m, maxTok, maxCost, view }: { m: MSum; maxTok: number; maxCost: number; view: ViewKey }) {
  // 一分钱没花的（免费 / 未定价）不写 ¥0.0000 —— 那看着像"花了但很少"
  const free = m.free === m.rounds && m.rounds > 0;
  return (
    <div className="mb">
      {/* 左边一栏：是谁、跑了几轮。柱子从这一栏右边那条线上起跑 */}
      <div className="mb-side">
        <span className="mb-name" title={m.pick || t('旧记录未留模型名')}>
          {m.pick ? modelName(m.pick) : t('未记录模型')}
        </span>
        <span className="mb-sub">
          {t('{n} 轮', { n: m.rounds })}
          {free && <span className="bill-free">{t('· 未定价')}</span>}
        </span>
      </div>

      {/* 右边：两根横柱，柱头写各自的绝对值 */}
      <div className="mb-bars">
        {view !== 'cost' && (
        <Bar
          label={t('用量')}
          value={`${fmt(m.tok)} tok`}
          pct={maxTok > 0 ? (m.tok / maxTok) * 100 : 0}
          zero={m.tok <= 0}
          segs={[
            { k: 'hit', v: m.hit, c: SEG_COLOR.hit },
            { k: 'miss', v: m.miss, c: SEG_COLOR.miss },
            { k: 'out', v: m.tout, c: SEG_COLOR.out },
          ]}
        />
      )}

      {view !== 'tok' && (
        <Bar
          label={t('价格')}
          value={free ? t('未定价') : yuan(m.cost)}
          pct={maxCost > 0 ? (m.cost / maxCost) * 100 : 0}
          zero={!free}
          // 老账里没留三档拆分（ch/cm/co 全 0），那就把总价画成一整截，别画成空柱
          segs={
            m.ch + m.cm + m.co > 0
              ? [
                  { k: 'ch', v: m.ch, c: SEG_COLOR.hit },
                  { k: 'cm', v: m.cm, c: SEG_COLOR.miss },
                  { k: 'co', v: m.co, c: SEG_COLOR.out },
                ]
              : [{ k: 'all', v: m.cost, c: 'var(--accent)' }]
          }
        />
      )}
      </div>
    </div>
  );
}

export default function Billing({ panel, fs }: PanelFaceProps) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  /** 看哪一段账：默认 24 小时 */
  const [range, setRange] = useState<RangeKey>('24h');
  /** 看哪几样：默认用量和价格都看 */
  const [view, setView] = useState<ViewKey>('both');
  const [now, setNow] = useState(() => Date.now());
  const [sent, setSent] = useState(0);
  const [err, setErr] = useState('');
  const seq = useRef(0);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const [text, liveText] = await Promise.all([fs.read(STATE), fs.read(LIVE)]);
      if (!alive) return;
      const s = parse(text, panel.id);
      if (s) setSnap(s);
      setLive(parseLive(liveText));
      setNow(Date.now()); // 时间窗跟着往前滚，面板开着也不会停在旧窗口上
    };
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [fs, panel.id]);

  const s = snap ?? empty();
  /** 选中分支：给定它就从那一刻起算增量（"这一小段工作流花了多少"） */
  const branch = s.selected ? s.branches.find((b) => b.id === s.selected) ?? null : null;

  /**
   * 真正生效的起点。
   *
   * `分支` 那一档**只认分支点**（没有分支就是 0 = 从头算），别的档才是"窗和分支取更晚"。
   * 分开写是为了让"我要精确量这一段"有个不打架的选项：窗 × 分支相乘的话，
   * 分支比窗早的部分会被默默吃掉，看着正常、其实是少算的。
   */
  const from = useMemo(() => fromOf(range, now, branch ? branch.at : 0), [range, now, branch]);

  /** 整本账（全时段）—— 顶部左边那个数，跟时间窗无关 */
  const all = useMemo(() => sum(s.entries, s.past), [s.entries, s.past]);
  /** 这一段窗里的合计 —— 有分支时就是"增量" */
  const win = useMemo(() => sum(s.entries.filter((e) => e.at >= from)), [s.entries, from]);

  const models = useMemo(
    () => rank(byModel(s.entries, from, s.past, s.feedFrom), view),
    [s.entries, from, view, s.past, s.feedFrom],
  );
  const maxTok = useMemo(() => models.reduce((n, m) => Math.max(n, m.tok), 0), [models]);
  const maxCost = useMemo(() => models.reduce((n, m) => Math.max(n, m.cost), 0), [models]);

  const send = (payload: Record<string, unknown>) => {
    seq.current += 1;
    void enqueue(fs, { seq: Date.now() * 1000 + (seq.current % 1000), panelId: panel.id, ...payload }).then(() =>
      setSent((n) => n + 1),
    );
  };

  const addBranch = () => {
    // 本地先画一个点，2 秒内以文件为准 —— 点了立刻会有反应，不必等下一跳
    setSent((n) => n + 1);
    send({ cmd: 'branch', at: Date.now() });
  };

  const removeBranch = (id: string) => send({ cmd: 'delbranch', id });

  /**
   * 点分支芯片 = 选中它，**并把上排切到「分支」档**。
   *
   * 为什么不只是选中：选中只改了起点，上排还停在"24 小时"的话，
   * 分支早于 24 小时的部分照样会被窗吃掉 —— 那时候用户看到的是"我明明选了分支，
   * 数怎么不对"。所以选中这件事直接把口径也一起切过去，一步就是他要的那一段。
   */
  const selectBranch = (id: string) => {
    const on = id !== s.selected;
    send({ cmd: 'select', id: on ? id : '' });
    if (on) setRange('branch');
  };

  // 发过命令却一直没读到状态：多半是插件没在跑（没装 / 被停用），说一句比干等强
  const silent = sent > 0 && !snap;
  const busy = live && live.rounds > 0;
  const rangeLabel = t(RANGES.find((r) => r.k === range)?.label ?? '');
  /** 这一段是不是"只算分支之后"：标题、提示都要照这个换说法 */
  const byBranch = range === 'branch';
  /**
   * 给人看的"这一段是什么"——标题里用它。
   * 「分支」档要是只写"分支"两个字，看不出算的是哪一段，所以把时刻也带上。
   */
  const segLabel = byBranch ? (branch ? t('分支 · 自 {at}', { at: hhmm(branch.at) }) : t('分支')) : rangeLabel;

  return (
    /*
     * data-fit="off"：告诉核心的自适应层"这块别管缩放"。
     *
     * 别的面板靠它把装不下的固定内容整体缩小（一块钟、一个计数器），
     * 但这是一张**数据表**：内容少的时候（比如 24 小时里只有一笔账）它会判定
     * "装得下"，于是把整块放大到填满 —— 字被撑得很大、内容拉成一条，
     * 全屏看着就是这样。账本要的是一页一页稳定的版式，不缩放，
     * 多出来的地方空着就空着，多了就由宿主那层正常往下滚。
     */
    <div className="bill" data-fit="off">
      {/* ① 顶部那条：这是谁在花钱、有没有正在跑的 */}
      <div className="bill-head">
        <span className="bill-title">{t('全软件用量')}</span>
        <span className="bill-live">
          {busy ? (
            <>
              <span className="bill-dot" />{t('正在跑')}{t('{n} 轮 · ', { n: live!.rounds })}{yuan(live!.cost)}
            </>
          ) : (
            <>{s.at ? ago(s.at) : t('尚未')}</>
          )}
        </span>
        <button className="bill-btn is-primary" onClick={addBranch} title={t('从这里开始另算')}>
          {t('＋ 分支')}
        </button>
      </div>

      {err && <div className="bill-err">{err}</div>}

      {/* ② 两个大数：整本账 / 这一段的账 */}
      <div className="bill-cards">
        <div className="bill-card">
          <div className="bill-card-k">{t('历史总计')}</div>
          <div className="bill-card-v">{yuan(all.cost)}</div>
          <div className="bill-card-s">
            {t('{n} 轮 · ', { n: all.rounds })}{fmt(all.tin + all.tout)} tok
            {all.free > 0 && <span className="bill-free">{t(' · {n} 轮未定价', { n: all.free })}</span>}
          </div>
        </div>
        <div className={`bill-card${byBranch && branch ? ' is-branch' : ''}`}>
          <div className="bill-card-k">
            {branch ? t('自 {at} 起', { at: hhmm(branch.at) }) : rangeLabel}
          </div>
          <div className="bill-card-v">{yuan(win.cost)}</div>
          <div className="bill-card-s">
            {t('{n} 轮 · ', { n: win.rounds })}{fmt(win.tin + win.tout)} tok
            {win.free > 0 && <span className="bill-free">{t(' · {n} 轮未定价', { n: win.free })}</span>}
          </div>
        </div>
      </div>

      {/* ③ 分支：打点、切换、删掉。切换的点就是"从这里开始算" */}
      {s.branches.length > 0 && (
        <div className="bill-branches">
          <span className="bill-branches-k">{t('分支')}</span>
          <button
            className={`bill-chip${!s.selected ? ' is-on' : ''}`}
            onClick={() => {
              send({ cmd: 'select', id: '' });
              // 退出分支口径：档位留在「分支」上的话标题还写着"分支 · 自 …"，
              // 而实际算的是从头开始 —— 两者得对上
              if (byBranch) setRange('all');
            }}
            title={t('看全部')}
          >
            {t('全部')}
          </button>
          {s.branches.map((b) => {
            const seg = sum(s.entries.filter((e) => e.at >= b.at));
            return (
              <span key={b.id} className={`bill-chip-wrap${s.selected === b.id ? ' is-on' : ''}`}>
                <button
                  className={`bill-chip${s.selected === b.id ? ' is-on' : ''}`}
                  onClick={() => selectBranch(b.id)}
                  title={t('从 {at} 起算', { at: hhmm(b.at) })}
                >
                  {b.label} · {hhmm(b.at)} · {yuan(seg.cost)}
                </button>
                <button className="bill-x" onClick={() => removeBranch(b.id)} title={t('删掉分支')}>
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* ④ 按模型：一个模型两根横柱。这一段是这块面板的主角 */}
      <div className="bill-sec">
        <div className="bill-sec-h">
          <h4>
            {t('按模型')} <b>{models.length}</b>
          </h4>
          <div className="bill-seg">
            {VIEWS.map((v) => (
              <button
                key={v.k}
                className={`bill-seg-b${view === v.k ? ' is-on' : ''}`}
                onClick={() => setView(v.k)}
              >
                {t(v.label)}
              </button>
            ))}
          </div>
          <div className="bill-seg is-right">
            {RANGES.map((r) => {
              /*
               * 「分支」这一档要有分支才成立：一个分支都没打的时候，
               * 它跟「全部」是同一个意思 —— 那就别让它点，免得点出一段"没区别"的选择。
               */
              const off = r.k === 'branch' && s.branches.length === 0;
              const on = range === r.k && !off;
              return (
                <button
                  key={r.k}
                  className={`bill-seg-b${on ? ' is-on' : ''}`}
                  disabled={off}
                  onClick={() => {
                    setRange(r.k);
                    // 切到「分支」档而手上还没选分支：顺手选中最近打的那个，别让人再点一次
                    if (r.k === 'branch' && !s.selected) {
                      const last = s.branches[s.branches.length - 1];
                      if (last) send({ cmd: 'select', id: last.id });
                    }
                  }}
                  title={
                    off ? t('还没有分支') : r.k === 'branch' ? t('只算分支点之后') : t('按时间统计')
                  }
                >
                  {t(r.label)}
                </button>
              );
            })}
          </div>
        </div>

        {view !== 'cost' && (maxTok > 0 || models.length > 0) && (
          <div className="bill-key" title={t('柱子满格 = 这一段里最大的模型')}>
            {[
              { k: t('缓存命中'), c: SEG_COLOR.hit },
              { k: t('未命中输入'), c: SEG_COLOR.miss },
              { k: t('输出'), c: SEG_COLOR.out },
            ].map((x) => (
              <span key={x.k} className="bill-key-i">
                <i className="bill-swatch" style={{ background: x.c }} />
                {x.k}
              </span>
            ))}
          </div>
        )}

        {models.length === 0 ? (
          <div className="bill-empty">
            {t('这一段没有记录')}
          </div>
        ) : (
          <div className="mb-grid">
            {models.map((m) => (
              <ModelCard key={m.pick || '__none'} m={m} maxTok={maxTok} maxCost={maxCost} view={view} />
            ))}
          </div>
        )}
      </div>

      {/* ⑤ 表格：跟上面同一份数据，只是摊平成一行一个模型 */}
      {models.length > 0 && (
        <div className="bill-sec">
          <div className="bill-sec-h">
            <h4>{t('明细（')}{segLabel}）</h4>
            {s.dropped > 0 && (
              <span className="bill-hint">
                {t('更早 {n} 轮已折成合计', { n: s.dropped })}
              </span>
            )}
          </div>
          <div className="bill-tbl-wrap">
            <table className="bill-tbl">
              <thead>
                <tr>
                  <th>{t('模型')}</th>
                  <th className="is-num">{t('轮次')}</th>
                  {view !== 'cost' && (
                    <>
                      <th className="is-num">{t('缓存命中')}</th>
                      <th className="is-num">{t('未命中输入')}</th>
                      <th className="is-num">{t('输出')}</th>
                      <th className="is-num">{t('合计 tok')}</th>
                    </>
                  )}
                  {view !== 'tok' && <th className="is-num">{t('花费')}</th>}
                </tr>
              </thead>
              <tbody>
                {models.map((m) => {
                  const free = m.free === m.rounds && m.rounds > 0;
                  return (
                    <tr key={m.pick || '__none'}>
                      <td className="bill-model" title={m.pick || t('旧记录未留模型名')}>
                        {m.pick ? modelName(m.pick) : t('未记录模型')}
                        {free && <span className="bill-free">{t('· 未定价')}</span>}
                      </td>
                      <td className="is-num">{m.rounds}</td>
                      {view !== 'cost' && (
                        <>
                          <td className="is-num">{fmt(m.hit)}</td>
                          <td className="is-num">{fmt(m.miss)}</td>
                          <td className="is-num">{fmt(m.tout)}</td>
                          <td className="is-num">{fmt(m.tok)}</td>
                        </>
                      )}
                      {view !== 'tok' && (
                        <td className="is-num bill-cost">{free ? <span className="bill-free">{t('未定价')}</span> : yuan(m.cost)}</td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td>{t('合计')}</td>
                  <td className="is-num">{win.rounds}</td>
                  {view !== 'cost' && (
                    <>
                      <td className="is-num">{fmt(win.hit)}</td>
                      <td className="is-num">{fmt(win.miss)}</td>
                      <td className="is-num">{fmt(win.tout)}</td>
                      <td className="is-num">{fmt(win.tin + win.tout)}</td>
                    </>
                  )}
                  {view !== 'tok' && <td className="is-num bill-cost">{yuan(win.cost)}</td>}
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      <div className="bill-foot">
        {t('账为整个工作区一份')}
        {s.keepDays > 0 && t('合计保留 {n} 天。', { n: s.keepDays })}
        {silent && <span className="bill-warn">{t('没读到插件状态')}</span>}
      </div>
    </div>
  );
}
