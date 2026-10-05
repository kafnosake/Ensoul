import React, { useEffect, useRef, useState } from 'react';
import type { PanelFaceProps } from '../../src/shared/types';

/**
 * 番茄钟面板 —— 一块表盘 + 一排按钮，**没有一行"什么时候该休息"的逻辑**。
 *
 * 计时、结算、到点提醒都在插件 `plugins/pomodoro` 里（主进程）。这里只做两件事：
 *
 *   读 `.ensoul/state/pomodoro.json`      —— 插件写下的这一刻是什么局面（哑的显示器）
 *   写 `.ensoul/state/pomodoro.cmd.json`  —— 一条命令，告诉插件我要它干什么（遥控器）
 *
 * 为什么倒计时在本地算：状态里给的是**绝对到点时刻**（until），这里每 250ms 减一次就行，
 * 于是插件不必为了"秒在跳"每秒写一次磁盘。读文件是 800ms 一次 —— 换段的延迟最多这么多。
 *
 * 插件的默认值这里抄了一份（面板读不到插件的代码）。抄的是**显示**用的默认值：
 * 多发一条命令，插件就会把真实配置写回来，之后以文件为准。
 *
 * 尺寸怎么定（这里是"挂件"，会浮在别的面板上面）：
 *   不用管 —— 核心的自适应层会自动认出来（见 src/renderer/panel/FitBox.tsx）：
 *   它看见这块面板**滚不动**（.pomo 是 overflow:hidden），就把整块内容缩放着装进容器。
 *   所以这里所有尺寸都按**自然尺寸**写：框变大它就变大、变小它就变小，
 *   永远不会出现滚动条，也不会把表盘裁掉半截。
 *   没有手动入口：挂件就该自己装，多一排按钮反而占地方。
 */

type Phase = 'work' | 'short' | 'long';

interface Config {
  work: number;
  short: number;
  long: number;
  /** 一段结束自动接下一段 */
  auto: boolean;
  /** 结束时响一声 */
  sound: boolean;
}

interface Clock {
  phase: Phase;
  /** 这一轮已经完成的番茄数 */
  done: number;
  running: boolean;
  /** 跑着时：跑到这个时刻为止（epoch ms） */
  until: number;
  /** 暂停或未开始时：还剩多少毫秒 */
  left: number;
  cfg: Config;
}

const STATE = '.ensoul/state/pomodoro.json';
const CMD = '.ensoul/state/pomodoro.cmd.json';
const MIN = 60_000;
/** 几个番茄换一次长休 */
const CYCLE = 4;

/** 可选的节奏：专注 / 短休 / 长休（分钟） */
const PRESETS = [
  { id: 'classic', label: t('经典 25/5'), work: 25, short: 5, long: 15 },
  { id: 'deep', label: t('深度 50/10'), work: 50, short: 10, long: 20 },
  { id: 'sprint', label: t('短跑 15/3'), work: 15, short: 3, long: 10 },
] as const;


const LABEL: Record<Phase, string> = { work: t('专注'), short: t('短休息'), long: t('长休息') };
const PHASES: Phase[] = ['work', 'short', 'long'];

const defaults = (): Config => ({ work: 25, short: 5, long: 15, auto: false, sound: true });

const blank = (): Clock => ({ phase: 'work', done: 0, running: false, until: 0, left: 25 * MIN, cfg: defaults() });

/** 从状态文件里挑出这个面板的那份时钟；读不懂就当没有 */
function pick(text: string, panelId: string): Clock | null {
  try {
    const raw = JSON.parse(text)?.panels?.[panelId];
    if (!raw || !PHASES.includes(raw.phase)) return null;
    const cfg = defaults();
    for (const k of ['work', 'short', 'long'] as const) {
      const n = Number(raw.cfg?.[k]);
      if (Number.isFinite(n) && n > 0) cfg[k] = n;
    }
    cfg.auto = !!raw.cfg?.auto;
    cfg.sound = raw.cfg?.sound !== false;
    return {
      phase: raw.phase,
      done: Math.max(0, Math.floor(Number(raw.done) || 0)),
      running: !!raw.running,
      until: Number(raw.until) || 0,
      left: Math.max(0, Number(raw.left) || 0),
      cfg,
    };
  } catch {
    return null;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
const fmt = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
};

/** 当前配置命中哪个预设 */
const presetOf = (c: Config) => PRESETS.find((p) => p.work === c.work && p.short === c.short && p.long === c.long)?.id ?? '';

/**
 * 命令排成一条队列往后发 —— 两次点击挨得再近也不会丢掉前一条。
 * 这个 Promise 链是**模块级**的（不是每挂载一次一条）：面板被卸载重挂也不该乱序。
 * 插件执行完会把队列清空，所以这里读到的通常是空的；读不懂就当空的（陈旧的那几条
 * seq 早就不比插件记着的大，重发也不会被执行第二次）。
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
  // 一步失败不能把后面排队的都卡死
  chain = chain.then(run).catch(() => {});
  return chain;
}

export default function Pomodoro({ panel, fs }: PanelFaceProps) {
  const [remote, setRemote] = useState<Clock | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** 发过几条命令 —— 用来判断"插件到底在不在" */
  const [sent, setSent] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  /** seq 单调递增：插件认它，同一个文件重复读到不会重复执行 */
  const seq = useRef(0);

  /*
   * 缩放不在这儿做了 —— 挂件整块自适应是**核心**的事（panel/FitBox.tsx）。
   * 这里只留一句声明：下面的 .pomo-inner 是"按自然尺寸排"的那一层，
   * 核心量它、把整块内容缩放着装进容器。以前这 40 行测量是每块挂件各写一份，
   * 写法还很容易错（量成"现在长什么样"就只缩不涨），所以搬进核心里了。
   */

  useEffect(() => {
    let alive = true;
    const read = async () => {
      const text = await fs.read(STATE);
      if (!alive) return;
      const c = pick(text, panel.id);
      if (c) setRemote(c);
    };
    void read();
    const timer = setInterval(() => void read(), 800);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [panel.id]);

  const clock = remote ?? blank();

  // 秒在跳这件事由本地负责（插件只给"跑到什么时候"）；停着就不必空转
  useEffect(() => {
    if (!clock.running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [clock.running]);

  /** 交给插件去做；面板先按"我以为的"画一版，800ms 内以文件为准 */
  const send = (patch: Record<string, unknown>) => {
    seq.current += 1;
    enqueue(fs, { seq: Date.now() * 1000 + (seq.current % 1000), panelId: panel.id, ...patch });
    setSent((n) => n + 1);
  };

  const local = (f: (c: Clock) => Clock) => setRemote((prev) => f(prev ?? blank()));

  const plan = clock.phase;
  const total = Math.max(1, clock.cfg[plan]) * MIN;
  const remain = Math.min(total, clock.running ? Math.max(0, clock.until - now) : clock.left);
  const progress = Math.min(1, Math.max(0, 1 - remain / total));
  const tone = plan === 'work' ? 'var(--accent)' : plan === 'short' ? 'var(--ok)' : '#7bd0ff';

  const toggle = () => {
    const startAt = Date.now() + (clock.left > 0 ? clock.left : total);
    local((c) => (c.running ? { ...c, running: false, left: remain } : { ...c, running: true, until: startAt }));
    send({ cmd: 'toggle' });
  };

  const reset = () => {
    local((c) => ({ ...c, running: false, left: total }));
    send({ cmd: 'reset' });
  };

  // 跳过：下一段是插件决定的（数到第 4 个番茄才长休），所以这里不猜，等文件回来
  const skip = () => send({ cmd: 'skip' });

  const usePreset = (p: (typeof PRESETS)[number]) => {
    local((c) => ({
      ...c,
      cfg: { ...c.cfg, work: p.work, short: p.short, long: p.long },
      // 跑着就只影响下一段，不打断手头这一轮
      left: c.running ? c.left : p[plan] * MIN,
    }));
    send({ cmd: 'preset', work: p.work, short: p.short, long: p.long });
  };

  const setCfg = (key: 'auto' | 'sound') => {
    const value = !clock.cfg[key];
    local((c) => ({ ...c, cfg: { ...c.cfg, [key]: value } }));
    send({ cmd: key, value });
  };

  // 只在番茄钟自己拿到焦点时响应键位，不去抢全局的空格
  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
    // 缩放不再有键位 —— 它自己跟着窗口走，多记一个键位反而是负担
    if (e.ctrlKey || e.metaKey) return;
    if (e.key === ' ') {
      e.preventDefault();
      toggle();
    } else if (e.key === 'r' || e.key === 'R') {
      reset();
    } else if (e.key === 'n' || e.key === 'N') {
      skip();
    }
  };

  const totalMin = clock.done * clock.cfg.work;

  // 进度环：SVG 圆周长，靠 dashoffset 表示走了多少
  const R = 62;
  const C = 2 * Math.PI * R;

  const cycleAt = clock.done % CYCLE;
  const dotOn = (i: number) => (clock.done > 0 && cycleAt === 0 ? true : i < cycleAt);

  // 发过命令却一直没读到状态：多半是插件没在跑（没装 / 被停用），说一句比干等强
  const silent = sent > 0 && !remote;

  return (
    <div
      ref={rootRef}
      className="pomo"
      tabIndex={0}
      onKeyDown={onKey}
      title={t('点一下这里，空格 开始/暂停 · R 重置 · N 跳过')}
      style={{ ['--tone' as any]: tone }}
    >
      {/*
        这一层是"内容本身"：按自然尺寸排（不折行、不被压扁）。
        尺寸一律按自然尺寸写，不乘任何倍率 —— 缩放是核心整体 transform 的，不归这儿管。
      */}
      <div className="pomo-inner">
        <div className="pomo-chips">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              className={`pomo-chip${presetOf(clock.cfg) === p.id ? ' is-on' : ''}`}
              onClick={() => usePreset(p)}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="pomo-ring">
          <svg viewBox="0 0 150 150">
            <circle cx="75" cy="75" r={R} className="pomo-track" />
            <circle
              cx="75"
              cy="75"
              r={R}
              className="pomo-bar"
              strokeDasharray={C}
              strokeDashoffset={C * (1 - progress)}
              transform="rotate(-90 75 75)"
            />
          </svg>
          <div className="pomo-face">
            <div className="pomo-phase">{LABEL[plan]}</div>
            <div className="pomo-time">{fmt(remain)}</div>
            <div className="pomo-sub">{clock.running ? t('计时中') : remain < total ? t('已暂停') : t('待开始')}</div>
          </div>
        </div>

        <div className="pomo-actions">
          <button className="primary" onClick={toggle}>
            {clock.running ? t('暂停') : remain < total ? t('继续') : t('开始')}
          </button>
          <button onClick={reset} disabled={!clock.running && remain === total}>
            {t('重置')}
          </button>
          <button onClick={skip} title={t('直接跳到下一段')}>
            {t('跳过')}
          </button>
        </div>

        <div className="pomo-toggles">
          <button className={`pomo-chip${clock.cfg.auto ? ' is-on' : ''}`} onClick={() => setCfg('auto')}>
            自动接续 {clock.cfg.auto ? t('开') : t('关')}
          </button>
          <button className={`pomo-chip${clock.cfg.sound ? ' is-on' : ''}`} onClick={() => setCfg('sound')}>
            提示音 {clock.cfg.sound ? t('开') : t('关')}
          </button>
        </div>

        <div className="pomo-dots" title={t('每 {n} 个番茄换一次长休', { n: CYCLE })}>
          {Array.from({ length: CYCLE }).map((_, i) => (
            <span key={i} className={`pomo-dot${dotOn(i) ? ' is-on' : ''}`} />
          ))}
          <span className="pomo-count">
            已完成 <b>{clock.done}</b>{t('个 · 专注')}<b>{totalMin}</b>{t('分钟')}
          </span>
        </div>

        <div className="pomo-foot">
          专注 {clock.cfg.work} 分 · 短休 {clock.cfg.short} 分 · 长休 {clock.cfg.long} 分 · 空格开始/暂停
          {silent && <span className="pomo-warn">{t('· 没读到插件状态（plugins/pomodoro 在吗？）')}</span>}
        </div>
      </div>
    </div>
  );
}
