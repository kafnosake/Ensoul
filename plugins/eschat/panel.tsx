import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PanelFaceProps } from '../../src/shared/types';

/**
 * eschat —— 脸（渲染进程那一半）。**这里没有一行"谁在岗、谁在等我"的判断**。
 *
 * 联系人 = 公司名册上的 AI 员工，谁在岗、正在干什么、最后一句说了什么，全在主进程摘好
 * 放在 `.ensoul/state/eschat.json` 里（见 index.js）。这一层只做两件事：
 *
 *   读 `.ensoul/state/eschat.json`                     —— 哑的显示器
 *   写 `.ensoul/state/eschat.cmd.<自己>.<序号>.json`    —— 遥控器（点开某人、发一句）
 *
 * 为什么命令文件名带**自己这块面板的 id**：软件里可能同时开着好几块 eschat，一个共用的
 * 命令文件会互相覆盖、也会抢"我正看着谁"。已读水位同理，按 panel.id 分键存。
 *
 * ── 两个刻意的决定 ───────────────────────────────────────────────────
 *
 * · `data-fit="off"`：核心的自适应层靠"内容滚不滚得动"决定要不要整块缩放
 *   （src/renderer/panel/FitBox.tsx）。eschat 是必须铺满容器的那种界面（左人右聊），
 *   消息少的时候它滚不动 —— 那一刻会被判成挂件、整块放大到 2 倍，布局当场废掉。
 *
 * · 只画 user / assistant 两种气泡。工具结果排在 chat 里又长又糙，混进来这张eschat
 *   就成日志窗口了 —— 谁跟谁说了什么，才是一个人的会话该有的样子。
 *
 * ── 像eschat的那几条，都在这一层 ───────────────────────────────────────
 * 深色主题、绿气泡、气泡尖角、消息头像、居中时间条（间隔超过 5 分钟才出）、
 * 侧栏搜索、未读数红底白字。**这些都是画法，不是逻辑** —— 数据一个字节都没多要。
 */

const STATE = '.ensoul/state/eschat.json';
/**
 * 快照文件的上限（跟主进程 fs:read 的 300KB 对齐）。
 * 超过上限时 read 回来的是一句占位文字、不是 JSON —— 流进 JSON.parse 只会炸。
 * 所以**先看大小**：超了就根本不读，接着用上一次成功读到的那份名册。
 */
const SNAP_MAX = 300_000;
const STATE_DIR = '.ensoul/state';
const STATE_NAME = 'eschat.json';
const TICK = 400;
/** 两条消息隔了这么久，中间就插一条居中时间 —— eschat就是这么断句的 */
const GAP = 5 * 60 * 1000;

interface Contact {
  id: string;
  name: string;
  dept: string;
  company: string;
  role: string;
  avatar: string;
  accent: string;
  model: string;
  panel: string;
  /** 有活着的面板 = 现在就能收消息（可能在后台，界面上看不见） */
  open: boolean;
  /** 它此刻摆在布局里吗（false = 在后台） */
  shown: boolean;
  status: string;
  count: number;
  at: number;
  last: { role: string; text: string } | null;
}
interface Line {
  role: string;
  text: string;
  at: number;
  /** 这条消息带的图（磁盘路径）—— 脸自己拼 file:// 显示，图本身不进快照 */
  images?: string[];
}
interface Rec {
  at: number;
  task: string;
  note: string;
}
/**
 * 一次会话的摘要（记录区里的一行）—— **一次一条**，不是一条消息一条。
 *
 * 这份账是**会话栏左侧那条「历史会话」的同一份**（plugins/histconv 写的），
 * `title` 也就是 rail 那一行上显示的那句话。
 */
interface Seg {
  key: string;
  from: number;
  to: number;
  count: number;
  /** 模型给这一段起的标题（跟 rail 上是同一句）；空串 = 还没起 */
  title?: string;
  head: string;
  tail: string;
}
interface Detail {
  id: string;
  name: string;
  dept: string;
  company: string;
  role: string;
  accent: string;
  open: boolean;
  shown: boolean;
  status: string;
  more: boolean;
  records: Rec[];
  msgs: Line[];
  /** 当前这一次会话（下面显示的就是它） */
  seg: { key: string; from: number; to: number; count: number; truncated: boolean } | null;
  /** 更早的会话，一次一条 —— 右上角会话记录区列的就是它 */
  sessions: Seg[];
  /** 记录区点开的那一次：整段对话，按"一次完整的对话"回忆 */
  recall: { key: string; from: number; to: number; count: number; truncated: boolean; msgs: Line[] } | null;
  /** 会话边界（分钟）—— 跟设置里那个参数同一个值，由脑按面板从账里取出 */
  gapMin: number;
  /** 正在跑的那一轮（有多少转多少）；没在跑就是 null。**不含思考内容** */
  live: { text: string; tool: string } | null;
}
interface Snap {
  contacts: Contact[];
  opens: Record<string, Detail>;
  /** 每块 eschat 面板各自置顶了谁（empId，最新置顶的在最前）。跟 opens 一样按面板分槽 */
  tops?: Record<string, string[]>;

  /**
   * 各面板搜索框里的词**命中了谁的聊天记录**（脑搜好了给回来的），按面板 id 分。
   * 带上 q —— 脸拿它比对"这份结果是不是我现在这个词搜出来的"，不然会拿旧结果过滤。
   */
  found?: Record<string, { q: string; hits: Record<string, FindHit> }>;
}

/** 一条搜索命中：谁那儿命中了、一共几条、最近那一句是什么 */
export interface FindHit {
  count: number;
  role: string;
  text: string;
  at: number;
}

const EMPTY: Snap = { contacts: [], opens: {} };
/** 账里还没写出边界值时的兜底 —— 跟 index.js / histconv 里的默认值一致 */
const SEG_MIN = 30;

/**
 * 把脑给的那份详情**补齐成现在这一版要的形状**。
 *
 * 为什么非补不可：脑和脸是**两个节奏**在热更新（脑按文件时间重挂、脸跟 ui-refresh
 * 重建 reload）。两边版本错开的那一段窗口期里，脸手里是旧形状的数据 —— 少一个字段，
 * 某一行 `.length` 就抛，以前的表现是**整窗口白屏**（现在至少只烂一块面板，
 * 见核心的 PanelBoundary，但能不错就干脆别错）。
 */
/**
 * 空壳详情：**脑还没把新选的人算出来时，中间那一栏读它**。
 *
 * 为什么非有不可：`shown` 是"快照里那份详情正好是这个人"，而快照最多要一个 tick 才追上来。
 * 那一段空窗里 `shown` 是 null，顶栏却照样渲染（它只判"选中了人"），于是
 * `shown.sessions.length` 直接抛 —— ==切员工、点加号都白屏==，点「重载界面」才好，
 * 因为重载时脑早就算完了。
 *
 * 修法不是到处加 `?.`（漏一处就再白屏一次），而是让**数据读取永远有个空壳可读**，
 * 真不真的另用一个 `ready` 判。
 */
const EMPTY_DETAIL: Detail = {
  id: '',
  name: '',
  dept: '',
  company: '',
  role: '',
  accent: '',
  open: false,
  shown: false,
  status: 'off',
  more: false,
  records: [],
  msgs: [],
  seg: null,
  sessions: [],
  recall: null,
  live: null,
  gapMin: SEG_MIN,
};

function normOpens(raw: Snap['opens']): Record<string, Detail> {
  const out: Record<string, Detail> = {};
  for (const [k, d] of Object.entries(raw || {})) {
    if (!d || typeof d !== 'object') continue;
    out[k] = {
      ...d,
      msgs: Array.isArray(d.msgs) ? d.msgs : [],
      records: Array.isArray(d.records) ? d.records : [],
      sessions: Array.isArray(d.sessions) ? d.sessions : [],
      seg: d.seg || null,
      recall: d.recall || null,
      live: d.live || null,
      gapMin: Number(d.gapMin) || SEG_MIN,
    };
  }
  return out;
}

/** 磁盘路径 → 能当图看的那种地址（跟核心的 shotUrl 一个做法） */
const shotUrl = (p: string) => `file:///${String(p).replace(/\\/g, '/')}`;

/**
 * 复制一段文字。`navigator.clipboard` 在某些环境里没有（不是 https 就没有），
 * 那就退到老办法 —— 复制不了只是不方便，不该把界面弄崩。
 */
function copyText(text: string) {
  const clip = navigator.clipboard;
  if (clip && clip.writeText) {
    void clip.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } catch (e) {
    /* 兜底也失败了就算了 */
  }
  document.body.removeChild(ta);
}

/**
 * 一套手画的线性图标 —— eschat那几处（导航栏、顶栏、输入区）要用的都在这儿。
 *
 * 为什么不引图标库：面板的脸是**渲染层**组件，加一个依赖就是给整个软件加一个依赖。
 * 这几个形状一共几十行，自己画了。统一 24 的 viewBox、描边 currentColor，
 * 颜色和大小都由外面那层决定（`.wx-rail-btn` / `.wx-act` / `.wx-tool-btn` 管）。
 */
const PATHS: Record<string, React.ReactNode> = {
  chat: <path d="M4.5 5h15A1.5 1.5 0 0 1 21 6.5v8a1.5 1.5 0 0 1-1.5 1.5H10l-4.4 3.4V16h-1A1.5 1.5 0 0 1 3 14.5v-8A1.5 1.5 0 0 1 4.5 5z" />,
  plus: (
    <>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 8.4v7.2M8.4 12h7.2" />
    </>
  ),
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="6.2" />
      <path d="M15.4 15.4L20 20" />
    </>
  ),
  image: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M4 15.5l4.2-4 3.6 3.4 3-2.6L20 15" />
      <circle cx="9" cy="9.4" r="1.2" />
    </>
  ),
  folder: <path d="M3.8 7.2A1.6 1.6 0 0 1 5.4 5.6h3.4l1.8 2h6a1.6 1.6 0 0 1 1.6 1.6v7A1.6 1.6 0 0 1 16.6 18H5.4A1.6 1.6 0 0 1 3.8 16.4z" />,
  cut: (
    <>
      <circle cx="7" cy="7" r="2.2" />
      <circle cx="7" cy="17" r="2.2" />
      <path d="M8.9 8.4L20 18M8.9 15.6L20 6" />
    </>
  ),
  down: <path d="M7 10.5l5 4.5 5-4.5" />,
  /** 会话记录：一圈钟 + 往回挑的箭头 —— "翻回去看那一次说了什么" */
  history: (
    <>
      <path d="M4.6 10.4A7.6 7.6 0 1 1 5.4 15" />
      <path d="M4.2 5.6v4.6h4.6" />
      <path d="M12 8.4V12l2.6 1.6" />
    </>
  ),
  back: <path d="M14.4 6.6L9 12l5.4 5.4" />,
  close: <path d="M6.6 6.6l10.8 10.8M17.4 6.6L6.6 17.4" />,
  mute: (
    <>
      <path d="M6.6 9.6a5.4 5.4 0 0 1 10.8 0v3.9l1.4 2.4H5.2l1.4-2.4z" />
      <path d="M4 4.2l16 15.6" />
    </>
  ),
  /** 置顶：一枚图钉（帽子 + 针） */
  pin: (
    <>
      <path d="M9.6 3.8h4.8l-.7 5.2 2.7 2.6H7.6l2.7-2.6z" />
      <path d="M12 11.6v8.6" />
    </>
  ),
  /** 通讯录：两个小人 —— eschat里就是它。区别在"按人查"，不是"按最近" */
  people: (
    <>
      <circle cx="9.2" cy="8.2" r="3.3" />
      <path d="M3.4 19.4c0-3.2 2.6-5.4 5.8-5.4s5.8 2.2 5.8 5.4" />
      <path d="M15.9 5.6a3.1 3.1 0 0 1 0 5.8" />
      <path d="M17.6 19.4c0-1.9-.6-3.5-1.5-4.5" />
    </>
  ),
};

function Ico({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name] ?? null}
    </svg>
  );
}

/** 列表里那点时间：今天只给时刻，更早给月/日 */
function when(time: number): string {
  if (!time) return '';
  const d = new Date(time);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return d.toDateString() === now.toDateString() ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 行内标记 → 真样式：`==重点==` 高亮、`**粗体**` 加粗。
 *
 * 为什么 eschat 得自己画一遍：这块脸只拿到**纯文本**（脑从 chat 里摘出来的那些字），
 * 而核心那套 markdown 渲染（src/renderer/ui/markdown.tsx）是核心会话区画的 ——
 * 插件面板够不着。不画的话，员工话里、派单回执里那些 `==…==`、`**…**`
 * 就原样摆出来，看着像乱码（这正是"这什么玩意"那个观感的来源）。
 *
 * 只认这两种就够：员工写的是给便签用的重点标记，不是正经 markdown 文档。
 */
function rich(text: string): React.ReactNode {
  const re = /(\*\*[^*]+\*\*|==[^=\n]+==)/g;
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('==')) out.push(<mark className="wx-hl" key={out.length}>{t.slice(2, -2)}</mark>);
    else out.push(<strong key={out.length}>{t.slice(2, -2)}</strong>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const clockOf = (time: number) =>
  time
    ? `${String(new Date(time).getHours()).padStart(2, '0')}:${String(new Date(time).getMinutes()).padStart(2, '0')}`
    : '';

/** 记录区里那个日子头：回忆一次会话，先认是哪天 */
function dayOf(time: number): string {
  if (!time) return '';
  const d = new Date(time);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return t('今天');
  if (d.toDateString() === new Date(now.getTime() - 864e5).toDateString()) return t('昨天');
  return t('{m}月{d}日', { m: d.getMonth() + 1, d: d.getDate() });
}

/**
 * 命中片段里的关键词加亮 —— 搜"发票"时那两个字得一眼看见，
 * 不然一行 90 字里读者还得自己找它在哪。
 */
function hi(text: string, q: string): React.ReactNode {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <em className="wx-hit">{text.slice(i, i + q.length)}</em>
      {text.slice(i + q.length)}
    </>
  );
}

/** 消息之间那条居中时间：说得细一点，翻旧账时才知道是哪天 */
function stamp(time: number): string {
  if (!time) return '';
  const d = new Date(time);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return t('{m}月{d}日 {hm}', { m: d.getMonth() + 1, d: d.getDate(), hm });
}

/**
 * 一行状态字：同一个"在不在"这里只说一次，别处都读它。
 *
 * 「在后台」和「已摆到布局」都是**在岗**（都收得到消息）—— 区别只在界面上有没有他。
 * 这是员工和普通面板最大的不同：占不占地方，跟干不干活是两件事。
 */
function stateOf(c: { status: string; open: boolean; shown: boolean }): { text: string; cls: string } {
  if (c.open) {
    if (c.status === 'working') return { text: c.shown ? t('正在工作（已摆出）') : t('正在工作…'), cls: 'busy' };
    if (c.status === 'confirm') return { text: t('等你确认'), cls: 'ask' };
    return { text: c.shown ? t('已摆到布局') : t('在后台待命'), cls: 'idle' };
  }
  if (c.status === 'stow') return { text: t('睡在收纳区'), cls: 'stow' };
  if (c.status === 'closed') return { text: t('睡在历史会话里'), cls: 'closed' };
  return { text: t('还没开班'), cls: 'off' };
}

function preview(c: Contact): React.ReactNode {
  if (!c.last) return c.open ? t('还没说过话') : t('点开就把他叫到岗');
  let msgText = c.last.text || '';
  msgText = msgText.replace(/\*\*/g, '').replace(/```[\s\S]*?```/g, '').trim();
  msgText = msgText.replace(/^斜杠命令\s*\//, '/');
  msgText = msgText.replace(/^跑命令[：:]\s*/, 'run ');
  msgText = msgText.replace(/^搜\s+/, 'search ');
  msgText = msgText.replace(/^读\s+/, 'read ');
  msgText = msgText.replace(/^写\s+/, 'write ');
  msgText = msgText.replace(/^改\s+/, 'edit ');
  msgText = msgText.replace(/^看目录\s+/, 'list ');
  msgText = msgText.replace(/^正则检索\s+/, 'grep ');
  msgText = msgText.replace(/^文件匹配\s+/, 'glob ');
  msgText = msgText.replace(/^查看图片\s+/, 'view ');
  msgText = msgText.replace(/^构建项目\b/, 'build');
  msgText = msgText.replace(/^启动项目\b/, 'start');
  msgText = msgText.replace(/^停止项目\b/, 'stop');
  msgText = msgText.replace(/^构建并重启项目\b/, 'restart');
  msgText = msgText.replace(/^看项目状态\b/, 'status');
  msgText = msgText.replace(/^读项目日志\b/, 'logs');

  if (msgText.startsWith('/')) {
    return <span className="wx-cmd-verb">{msgText}</span>;
  }
  const tm = msgText.match(/^(run|search|read|write|edit|list|grep|glob|view|build|start|stop|restart|status|logs|dispatch|skill)\b\s*(.*)$/);
  if (tm) {
    return (
      <>
        <span className="wx-tool-verb">{tm[1]}</span>
        {tm[2] ? ` ${tm[2]}` : ''}
      </>
    );
  }
  return msgText;
}

export default function EschatFace({ panel, fs }: PanelFaceProps) {
  const [snap, setSnap] = useState<Snap>(EMPTY);
  const [sel, setSel] = useState('');
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState('');
  const [query, setQuery] = useState('');
  /**
   * 要发给他的图（data URL）。脸只能写文本文件，所以图以 data URL 进命令文件，
   * 核心那边 keepShot 会落成磁盘路径 —— 跟核心会话区粘图是同一条路。
   */
  const [shots, setShots] = useState<string[]>([]);
  /** 要一起发出去的文件（挑的文本文件，内容拼进消息里）—— 跟"文件"那个按钮配套 */
  const [files, setFiles] = useState<{ name: string; text: string }[]>([]);
  /** 点开看大图的那张（'' = 没开）。脸开不了核心那层看图，就在自己这一层铺一张 */
  const [zoom, setZoom] = useState('');
  /**
   * 右键点出来的那个小菜单：{ id, x, y }。x/y 是**视口坐标** ——
   * 菜单用 position: fixed，这样才能贴着鼠标出，不会被会话列表那个滚动容器裁掉。
   */
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** 刚复制过哪一条 —— 按钮上给一下反馈 */
  const [copied, setCopied] = useState('');
  /** 右上角那个"会话记录"开着没有 —— 开了就从右边挤出一栏 */
  const [recOpen, setRecOpen] = useState(false);
  /**
   * 左边那栏现在看哪一屏：会话（按最近说话排）还是通讯录（按部门排）。
   * 两屏共用同一份名册、同一行的长相，只换排序的着眼点 ——
   * 会话是"我刚跟谁说过"，通讯录是"这个人是谁、在不在"。
   */
  const [view, setView] = useState<'chat' | 'book'>('chat');

  /** 已读水位：<员工id> → 看到哪一条了。按键分槽，几块 eschat 各记各的 */
  const readKey = `eschat.read.${panel.id}`;
  const [read, setRead] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem(readKey) || '{}');
    } catch (e) {
      return {};
    }
  });

  /**
   * 读快照 —— 插件还没写出第一份（刚开、或还没跑过一轮）时静默等一下。
   *
   * 读坏了（太大 / 正写到一半 / 被手改坏）**绝不把 contacts 清空**：清空渲染出来就是
   * 左栏空名单，用户以为"员工全没了"（其实一份名册好好的）。留着上一次成功的那份，
   * 顶上挂一句提示，恢复文件后自己就好。
   */
  const lastGood = useRef<Snap | null>(null);
  const [snapBad, setSnapBad] = useState('');
  useEffect(() => {
    let alive = true;
    const pull = async () => {
      // ① 先看大小：超过上限时 read 给的是一句占位文字，不是 JSON
      try {
        const list = await fs.list(STATE_DIR);
        const f = list.find((x) => x.name === STATE_NAME);
        if (f && f.size > SNAP_MAX) {
          if (!alive) return;
          setSnapBad(
            `快照读不出来（文件太大：${Math.round(f.size / 1024)}KB）` +
              (lastGood.current ? t(' —— 名册还是上一次读到的那份。') : '。'),
          );
          return;
        }
      } catch {
        /* 看不了大小就照常读 */
      }
      // ② 再读、再解析
      let text = '';
      try {
        text = await fs.read(STATE);
      } catch {
        return; // 文件还没有，正常
      }
      if (!alive) return;
      try {
        const next = JSON.parse(text) as Snap;
        const snapNext: Snap = {
          contacts: Array.isArray(next.contacts) ? next.contacts : [],
          opens: normOpens(next.opens),
          // 置顶名单：脑那边还没来得及产出这份字段时当空 —— 脸比脑先上过新版，
          // 这么写就不会因为少一个字段把整块面板弄崩
          tops: next.tops && typeof next.tops === 'object' ? next.tops : {},
          found: next.found && typeof next.found === 'object' ? next.found : {},
        };
        lastGood.current = snapNext;
        setSnap({ ...snapNext, found: snapNext.found || {} });
        setSnapBad('');
      } catch {
        setSnapBad(
          t('快照读不出来（文件太大或坏了）') +
            (lastGood.current ? t(' —— 名册还是上一次读到的那份。') : t(' —— 正写到一半的话，下一拍会自己好。')),
        );
      }
    };
    pull();
    const h = setInterval(pull, TICK);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [fs]);

  /** 给脑递一条命令：一块面板一个文件，不跟别的面板抢 */
  const push = useCallback(
    (cmd: Record<string, unknown>) => {
      const name = `.ensoul/state/eschat.cmd.${panel.id}.${Date.now()}${Math.floor(Math.random() * 1000)}.json`;
      void fs.write(name, JSON.stringify({ cmds: [cmd] })).then((r) => {
        if (!r.ok) setErr(r.error || t('命令没递出去'));
      });
    },
    [fs, panel.id],
  );

  /** 点开一个员工：告诉脑"我要看他"，顺便让他上班（没有工作面就现在开一块） */
  const open = useCallback(
    (id: string) => {
      setSel(id);
      push({ type: 'open', watcher: panel.id, empId: id });
    },
    [push, panel.id],
  );

  /** 打开就先落在最上面那个（= 最近说过话的那个）—— eschat打开就是最近的对话，不是一张白纸 */
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current || sel || !snap.contacts.length) return;
    booted.current = true;
    open(snap.contacts[0].id);
  }, [snap.contacts, sel, open]);

  /**
   * 搜索框里的词**递给脑**去搜。
   *
   * 为什么搜索在脑里做：全文只在那儿（活面板的 chat / 后台那份文件），
   * 脸手里只有每个员工最后一条 —— 在脸里搜只能搜到人名和"最后一句"。
   * 敲字时压一下（220ms）：不压的话一个字一次文件往返，打三个字跑三趟。
   */
  useEffect(() => {
    const term = query.trim();
    const h = setTimeout(() => push({ type: 'find', watcher: panel.id, q: term }), 220);
    return () => clearTimeout(h);
  }, [query, push, panel.id]);

  const row = useMemo(() => snap.contacts.find((c) => c.id === sel) || null, [snap.contacts, sel]);

  /** 这块面板置顶了谁（顺序 = 置顶的先后，最新置顶的在最前） */
  const topIds = useMemo(() => {
    const list = snap.tops ? snap.tops[panel.id] : null;
    return Array.isArray(list) ? list : [];
  }, [snap.tops, panel.id]);
  const topped = useMemo(() => new Set(topIds), [topIds]);
  const detail = snap.opens[panel.id];
  /** 快照里那份详情正好是**当前选的这个人**吗（不是就说明脑还没跟上，见 EMPTY_DETAIL） */
  const ready = !!(detail && detail.id === sel);
  const shown = ready && detail ? detail : EMPTY_DETAIL;

  /** 侧栏搜索：名字 / 部门 / 公司，**加上所有人的聊天记录**（脑搜好了给回来的） */
  const found = snap.found ? snap.found[panel.id] : null;
  const q = query.trim();
  /** 脑那份结果是不是**现在这个词**搜出来的 —— 不是就说明还在路上，先别拿它过滤 */
  const fhits = found && found.q === q ? found.hits : null;

  const hits = useMemo(() => {
    if (!q) return snap.contacts;
    const needle = q.toLowerCase();
    return snap.contacts.filter(
      (c) => `${c.name} ${c.dept} ${c.company}`.toLowerCase().includes(needle) || !!(fhits && fhits[c.id]),
    );
  }, [snap.contacts, q, fhits]);

  /**
   * 会话屏的最终顺序 = **置顶的在前，其余照旧按最近说话排**。
   *
   * 排序在脸这一层做，不在脑里：`tops` 是**按面板分槽**的（两块 eschat 各有各的置顶），
   * 而脑给出来的是同一份名册 —— 在那里排就等于替所有面板一起定了，两块面板互相打架。
   *
   * 置顶那一组的内部顺序 = 置顶动作的先后（最新置顶的排最前），
   * 因为 `Array.sort` 是稳定的：没置顶的那些原样保持脑给的"最近说话"顺序。
   */
  const ordered = useMemo(() => {
    if (!topIds.length) return hits;
    const rank = new Map(topIds.map((id, i) => [id, i]));
    const rankOf = (c: Contact) => (rank.has(c.id) ? rank.get(c.id)! : Infinity);
    return [...hits].sort((a, b) => rankOf(a) - rankOf(b));
  }, [hits, topIds]);

  /** 右键那一行 → 记下位置，把菜单摆出来。位置夹在窗口里，边上的行也不会把菜单顶出去 */
  const ctxMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    setMenu({
      id,
      x: Math.min(e.clientX, window.innerWidth - 168),
      y: Math.min(e.clientY, window.innerHeight - 96),
    });
  };

  /** 点别处 / 按 Esc / 一滚就收起来 —— 菜单挂着不走的界面最烦人 */
  useEffect(() => {
    if (!menu) return;
    const shut = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      setMenu(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    const blur = () => setMenu(null);
    document.addEventListener('mousedown', shut);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', shut, true);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('mousedown', shut);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', shut, true);
      window.removeEventListener('blur', blur);
    };
  }, [menu]);

  /**
   * 按部门分块 —— **只给通讯录那一屏用**。
   *
   * 会话屏绝不能走这份分组：那一屏的规则是"最近说过话的排最前"，而分组是
   * "同一部门的人捆在一起"。两个规则叠上去，部门头就把时间顺序切成一段段 ——
   * 看着就是"按最近排"没生效。会话屏直接铺 hits（脑里已经按 at 排好）。
   */
  const groups = useMemo(() => {
    const out: { dept: string; company: string; items: Contact[] }[] = [];
    for (const c of hits) {
      const dept = c.dept || t('（没有部门）');
      let g = out.find((x) => x.dept === dept);
      if (!g) {
        g = { dept, company: c.company, items: [] };
        out.push(g);
      }
      g.items.push(c);
    }
    return out;
  }, [hits]);

  /** 选中/水位变化就落盘（按面板分键，不串味） */
  useEffect(() => {
    if (!sel || !row) return;
    if ((read[sel] || 0) >= row.at) return;
    const next = { ...read, [sel]: row.at };
    setRead(next);
    try {
      localStorage.setItem(readKey, JSON.stringify(next));
    } catch (e) {
      /* 存不下就算了，红点不准比崩掉强 */
    }
  }, [sel, row, read, readKey]);

  /** 消息流自己滚到底 —— 流式那一段每长一点也跟着走 */
  const flow = useRef<HTMLDivElement>(null);
  /**
   * 从搜索结果点进来时，要落在**命中的那一句**上（存那条消息的时间）。
   * 只在"跳过去看那一下"用一次，滚到位就清掉 —— 之后流式照旧跟着滚到底。
   */
  const jumpAt = useRef(0);
  useEffect(() => {
    const el = flow.current;
    if (!el) return;
    const at = jumpAt.current;
    if (at) {
      const node = el.querySelector(`[data-at="${at}"]`);
      if (node) {
        node.scrollIntoView({ block: 'center' });
        jumpAt.current = 0;
        return;
      }
    }
    el.scrollTop = el.scrollHeight;
  }, [shown && shown.msgs.length, sel, shown && shown.records.length, shown && shown.live && shown.live.text.length]);

  const unread = useMemo(
    () => snap.contacts.filter((c) => c.at > (read[c.id] || 0)).length,
    [snap.contacts, read],
  );

  const send = () => {
    const text = draft.trim();
    if ((!text && shots.length === 0 && files.length === 0) || !sel) return;
    // 文件拼进正文：核心本来就会把引用到的文件内容一并带给模型，这是同一条路
    const body = [
      text,
      ...files.map((f) => `【文件 ${f.name}】\n\`\`\`\n${f.text}\n\`\`\``),
    ]
      .filter(Boolean)
      .join('\n\n');
    push({ type: 'send', empId: sel, text: body, images: shots });
    setDraft('');
    setShots([]);
    setFiles([]);
    // 不用等回执：下一份快照里这个人的状态就变成"正在工作"
  };

  /** 收下几张图（粘的、挑的都走这儿）：转成 data URL 摆进待发区，最多 4 张 */
  const takeShots = useCallback((files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return;
    void Promise.all(
      imgs.map(
        (f) =>
          new Promise<string>((res) => {
            const r = new FileReader();
            r.onload = () => res(String(r.result));
            r.onerror = () => res('');
            r.readAsDataURL(f);
          }),
      ),
    ).then((list) => setShots((s) => [...s, ...list.filter(Boolean)].slice(0, 4)));
  }, []);

  /**
   * 收一个文件：图进待发图，文本进"附件"（发送时拼进正文）。
   * 太大就不寄了 —— 拼进去的是**内容本身**，几百 KB 的东西会把整句话撑爆。
   */
  const takeFile = useCallback(
    (f: File) => {
      if (f.type.startsWith('image/')) {
        takeShots([f]);
        return;
      }
      if (f.size > 200 * 1000) {
        setErr(`「${f.name}」${Math.round(f.size / 1024)}KB，太大了 —— 超过 200KB 就不寄了`);
        return;
      }
      const r = new FileReader();
      r.onload = () => {
        setFiles((all) => [...all, { name: f.name, text: String(r.result || '') }].slice(0, 3));
        setErr('');
      };
      r.onerror = () => setErr(`读不了「${f.name}」`);
      r.readAsText(f);
    },
    [takeShots],
  );

  /**
   * 截图：从**剪贴板**里取图 —— 刚截的图就在那儿，这是唯一"不用挑文件"的入口。
   * 环境不给读也没关系：直接 Ctrl+V 粘进输入框是同一条路（见 onPaste）。
   */
  const grabClip = async () => {
    try {
      const items = await navigator.clipboard.read();
      const out: File[] = [];
      for (const it of items) {
        for (const t of it.types) {
          if (!t.startsWith('image/')) continue;
          const blob = await it.getType(t);
          out.push(new File([blob], `截图.${t.split('/')[1] || 'png'}`, { type: t }));
        }
      }
      if (!out.length) {
        setErr(t('剪贴板里没有图 —— 截完图直接按 Ctrl+V 粘进来也一样'));
        return;
      }
      takeShots(out);
      setErr('');
    } catch (e) {
      setErr(t('读不了剪贴板 —— 截完图直接按 Ctrl+V 粘进来'));
    }
  };

  /**
   * 侧栏里的一个人 —— **两屏共用这一行**，差别只在右边给什么：
   *
   *   会话屏：最后说了什么 + 时间 + 未读红点（"我刚跟谁说过话"）
   *   通讯录：他现在什么状态（"这个人是谁、在不在"）
   *
   * 两屏各画一套的话，改一处永远漏另一处 —— 这儿只是换个问法，行还是那一行。
   */
  const person = (c: Contact, book: boolean) => {
    const on = c.id === sel;
    const s = stateOf(c);
    const stick = topped.has(c.id);
    /** 这个人**聊天记录里**命中了没有 —— 命中就把他那一行的第二行换成命中的那句 */
    const f = fhits ? fhits[c.id] : null;
    return (
      <button
        key={c.id}
        className={`wx-item${on ? ' on' : ''}${c.open ? '' : ' away'}${stick ? ' is-top' : ''}`}
        onClick={() => {
          if (f && f.at) jumpAt.current = f.at; // 打开后落在命中的那一句上
          open(c.id);
          if (book) setView('chat');
        }}
        onContextMenu={(e) => ctxMenu(e, c.id)}
        title={t('{n}{m} · {s}', { n: c.name, m: c.role === 'manager' ? t('（经理）') : '', s: s.text })}
      >
        <span className="wx-ava" style={{ background: c.open ? c.accent : '#4a4a4a' }}>
          {c.avatar ? <img src={c.avatar} alt="" /> : c.name.slice(0, 1)}
          <i className={`wx-mark mm-${s.cls}`} />
        </span>
        <span className="wx-mid">
          <span className="wx-line1">
            <b>{c.name}</b>
            {c.role === 'manager' && <i className="wx-role">{t('经理')}</i>}
            {!c.open && <Ico name="mute" size={14} />}
            {/* 图钉摆在这儿（跟免打扰的小铃铛同一格）：一眼看出他是被自己顶上去的，
                不是"最近刚说过话" —— 两者在列表里看着都是排前面，得分得清 */}
            {stick && <i className="wx-pinmark" title={t('已置顶')}><Ico name="pin" size={13} /></i>}
            {!book && <time>{when(c.at)}</time>}
          </span>
          <span className={`wx-line2${book ? ` wx-st st-${s.cls}` : ''}`}>
            {f ? (
              <>
                {hi(f.text, q)}
                {f.count > 1 && <i className="wx-hitn">{t('共')}{f.count} 条</i>}
              </>
            ) : book ? (
              s.text
            ) : (
              preview(c)
            )}
          </span>
        </span>
        {!book && c.at > (read[c.id] || 0) && c.count > 0 && <em className="wx-badge">{c.count}</em>}
      </button>
    );
  };

  const st = row ? stateOf(row) : { text: '', cls: '' };
  const busy = !!row && row.status === 'working';

  /** 一条消息的脑袋：对方才有头像，自己的在右边 */
  const ava = (sm: boolean) => (
    <span className={`wx-ava${sm ? ' sm' : ''}`} style={{ background: row ? row.accent : '#3a404a' }}>
      {row && row.avatar ? <img src={row.avatar} alt="" /> : row ? row.name.slice(0, 1) : ''}
    </span>
  );

  const firm = (snap.contacts[0] && snap.contacts[0].company) || t('人理说工作室');

  return (
    <div className="wx" data-fit="off">
      {/* 最左那条导航栏。**只留真的**：eschat里收藏/朋友圈那些在这儿没有对应的东西，
          摆一排按不动的图标是复刻，不是功能，所以一个都不留。
          聊天 + 通讯录这两屏是真的 —— 它们对应的是同一份名册的两种问法。 */}
      <nav className="wx-rail">
        <span className="wx-rail-ava" title={firm}>
          {firm.slice(0, 1)}
        </span>
        <button
          className={`wx-rail-btn${view === 'chat' ? ' on' : ''}`}
          title={t('员工会话（{n} 人，最近说过话的排最前）', { n: snap.contacts.length })}
          onClick={() => setView('chat')}
        >
          <Ico name="chat" />
          {unread > 0 && <em className="wx-total">{unread}</em>}
        </button>
        <button
          className={`wx-rail-btn${view === 'book' ? ' on' : ''}`}
          title={t('通讯录（{n} 人，按部门排）', { n: snap.contacts.length })}
          onClick={() => setView('book')}
        >
          <Ico name="people" />
        </button>
        <span className="wx-rail-pad" />
      </nav>

      <aside className="wx-side">
        <div className="wx-search">
          <span className="wx-searchbox">
            <Ico name="search" size={15} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={view === 'book' ? t('搜索联系人、聊天记录') : t('搜索人名或聊天记录')}
              spellCheck={false}
            />
          </span>
          {/* eschat那个「+」是发起会话；这儿就是"叫一个还没到岗的人上来"。
              通讯录里不摆它 —— 那一屏点谁就是叫谁，不需要另一个入口。 */}
          {view === 'chat' && (
            <button
              className="wx-add"
              title={t('叫一个员工到岗（在后台开班，不占布局）')}
              onClick={() => {
                const next = snap.contacts.find((c) => !c.open) || snap.contacts[0];
                if (next) open(next.id);
              }}
            >
              <Ico name="plus" size={18} />
            </button>
          )}
        </div>

        <div className="wx-list">
          {/* 快照读不出来（太大/坏了）—— 不明说的话，空名单看着像"员工全没了" */}
          {snapBad && <p className="wx-warn">{snapBad}</p>}
          {groups.length === 0 && (
            <p className="wx-hint">
              {snap.contacts.length === 0 ? (
                <>
                  还没读到员工名册。<br />
                  {t('编制在调度中心里建（Dispatch 插件 → 名册）。')}
                </>
              ) : (
                <>{t('没有匹配的人。')}</>
              )}
            </p>
          )}

          {/* 搜聊天记录时，命中列表可能跟"分组到底有没有东西"对不上 —— 说一句，
              免得用户以为搜索没反应（那是搜到了但结果还没回来） */}
          {q && view === 'chat' && hits.length === 0 && snap.contacts.length > 0 && (
            <p className="wx-hint">
              {fhits ? t('名字和聊天记录里都没有这个词。') : t('正在翻聊天记录…')}
            </p>
          )}

          {/* 会话屏：**不分组**，一条接一条平铺，纯按最近说话排 —— 顺序来自 ordered
              （置顶的挑到最前，其余保持脑给的"最近说话"顺序）。
              通讯录屏才按部门分块 —— 那一屏问的是"这人是谁、在哪个部门"。 */}
          {view === 'book'
            ? groups.map((g) => (
                <div key={g.dept}>
                  <div className="wx-group">
                    <b>{g.dept}</b>
                    {g.company && <i>{g.company}</i>}
                  </div>
                  {g.items.map((c) => person(c, true))}
                </div>
              ))
            : ordered.map((c) => person(c, false))}
        </div>
      </aside>

      <section className="wx-main">
        {!sel && <p className="wx-empty">{t('左边点一个员工，就在这儿看他的工作面、就在这儿回他。')}</p>}
        {sel && (
          <>
            {/* 顶栏：名字在左，状态 + 一排图标在右 —— 跟eschat一样只有一条 */}
            <header className="wx-head">
              <span className="wx-title">
                <b>{row ? row.name : '…'}</b>
                {row && row.role === 'manager' && <i className="wx-role">{t('经理')}</i>}
              </span>
              <em className={`wx-state st-${st.cls}`} title={row && row.model ? row.model : ''}>
                {st.text}
              </em>

              <span className="wx-acts">
                {row && (
                  <button
                    className="wx-pin"
                    title={
                      row.shown
                        ? t('收进后台：不占布局，照样收得到消息')
                        : t('把他也摆到标签栏里（默认都在后台，不占你的布局）')
                    }
                    onClick={() => push({ type: row.shown ? 'unpin' : 'pin', empId: row.id })}
                  >
                    {row.shown ? t('收回后台') : t('摆到布局')}
                  </button>
                )}
                {/* 会话记录：点开从右边挤出一栏 —— 更早的每一次会话都在那儿，
                    点一次看那一次的整段（**按一次完整的对话回忆**，不是一条条翻） */}
                <button
                  className={`wx-act${recOpen ? ' on' : ''}`}
                  title={t('会话记录') + (shown.sessions.length ? t('（更早的有 {n} 次）', { n: shown.sessions.length }) : '')}
                  onClick={() => setRecOpen((v) => !v)}
                >
                  <Ico name="history" />
                </button>
              </span>
            </header>

            <div className="wx-flow" ref={flow}>
              {ready ? (
                <>
                  {/* 派单回执：他**没在这块面板里**干的那一轮的交代（派单器写进角色卡的）。
                      分两半写清楚 —— "派给他的"和"他回的"，不然就是一坨字，谁看谁懵。
                      太长的那种默认折起来：它是背景，不是这次会话本身。 */}
                  {shown.records.length > 0 && (
                    <div className="wx-recs">
                      {shown.records.map((r, i) => (
                        <details className="wx-rec" key={i} open={(r.task + r.note).length < 420}>
                          <summary>
                            <span className="wx-rec-tag">{t('派单回执')}</span>
                            <time>{when(r.at)}</time>
                          </summary>
                          {r.task && (
                            <p className="wx-rec-task">
                              <em>{t('派给他的')}</em>
                              {rich(r.task)}
                            </p>
                          )}
                          {r.note && (
                            <p>
                              <em>{t('他回的')}</em>
                              {rich(r.note)}
                            </p>
                          )}
                        </details>
                      ))}
                    </div>
                  )}

                  {/* 当前这一屏**只是这一次会话** —— 说清楚，不然会以为上面被截掉了 */}
                  {shown.seg && shown.sessions.length > 0 && (
                    <button className="wx-segline" title={t('打开会话记录')} onClick={() => setRecOpen(true)}>
                      这是第 {shown.sessions.length + 1} 次会话
                      {shown.seg.from ? `（${stamp(shown.seg.from)} 起）` : ''} —— 更早的 {shown.sessions.length}{' '}
                      {t('次点这儿看')}
                    </button>
                  )}
                  {shown.more && (
                    <p className="wx-more">
                      … 这一次会话再往前的部分没显示（「对话给多少条」那个参数能调）
                    </p>
                  )}

                  {shown.msgs.length === 0 && shown.records.length === 0 && (
                    <p className="wx-loading">
                      {row && row.status === 'closed'
                        ? t('他的会话在历史会话里 —— 想接手就发一句，会给他新开一块。')
                        : t('他还没说过话 —— 说一句给他。')}
                    </p>
                  )}

                  {shown.msgs.map((m, i) => {
                    const prev = i > 0 ? shown.msgs[i - 1] : null;
                    const gap = !prev || (m.at > 0 && prev.at > 0 && m.at - prev.at > GAP);
                    const me = m.role === 'user';
                    return (
                      <React.Fragment key={i}>
                        {gap && m.at > 0 && <div className="wx-time">{stamp(m.at)}</div>}
                        <div className={`wx-msg ${me ? 'me' : 'it'}`} data-at={m.at || undefined}>
                          {!me && ava(true)}
                          <div className="wx-bubwrap">
                            {m.images && m.images.length > 0 && (
                              <div className="wx-shots">
                                {m.images.map((s, j) => (
                                  <img
                                    key={j}
                                    src={shotUrl(s)}
                                    alt=""
                                    title={t('点开看大图')}
                                    onClick={() => setZoom(s)}
                                  />
                                ))}
                              </div>
                            )}
                            {m.text && <div className="wx-bub">{rich(m.text)}</div>}
                            {m.text && (
                              <button
                                className="wx-copy"
                                title={t('复制这整段')}
                                onClick={() => {
                                  copyText(m.text);
                                  setCopied(String(i));
                                  window.setTimeout(() => setCopied((c) => (c === String(i) ? '' : c)), 1400);
                                }}
                              >
                                {copied === String(i) ? t('已复制') : t('复制')}
                              </button>
                            )}
                          </div>
                        </div>
                      </React.Fragment>
                    );
                  })}

                  {/* 正在跑的这一轮：**有多少转多少**（核心把还没进 chat 的那条贴给我们了）。
                      只带正文 —— 思考内容走的是另一条通道，压根不在这儿 */}
                  {shown.live && (
                    <div className="wx-msg it">
                      {ava(true)}
                      <div className="wx-bubwrap">
                        {shown.live.tool && <div className="wx-tool">▸ {shown.live.tool}</div>}
                        {shown.live.text && (
                          <div className="wx-bub wx-live">
                            {rich(shown.live.text)}
                            <i className="wx-caret" />
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* 一个字都还没吐出来时给三个点 —— 不然看不出他在不在干活 */}
                  {busy && !(shown.live && (shown.live.text || shown.live.tool)) && (
                    <div className="wx-msg it">
                      {ava(true)}
                      <div className="wx-bub wx-typing">
                        <i />
                        <i />
                        <i />
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <p className="wx-loading">{t('正在取这个人的工作面…')}</p>
              )}
            </div>

            <footer className="wx-foot">
              {err && <p className="wx-err">{err}</p>}
              {/* 隔得太久：说清楚"现在发就是新的一次会话"，别让人以为是丢了上下文 */}
              {row && row.at > 0 && Date.now() - row.at > (shown.gapMin || SEG_MIN) * 60000 && (
                <p className="wx-newseg">
                  距上次说话 {Math.round((Date.now() - row.at) / 60000)} 分钟 —— 现在发，就是新的一次会话
                </p>
              )}
              {files.length > 0 && (
                <div className="wx-atts">
                  {files.map((f, i) => (
                    <span className="wx-att" key={i} title={t('{n} 字', { n: f.text.length })}>
                      <Ico name="folder" size={14} />
                      {f.name}
                      <button
                        title={t('去掉这个文件')}
                        onClick={() => setFiles((all) => all.filter((_, j) => j !== i))}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {/* 待发的图：贴在输入框上头，跟eschat里"发之前先看一眼"一样 */}
              {shots.length > 0 && (
                <div className="wx-drafts">
                  {shots.map((s, i) => (
                    <span className="wx-draft" key={i}>
                      <img src={s} alt="" />
                      <button
                        title={t('去掉这张')}
                        onClick={() => setShots((all) => all.filter((_, j) => j !== i))}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {/* eschat的输入区：一块深灰大方框，顶上排一排小图标，右下角一个方块「发送」 */}
              <div className="wx-composer">
                {/* 只留三个**真有作用**的：图片、文件、截图。
                    表情和语音在 eschat 里没有对应的东西，一个都不摆。 */}
                <div className="wx-tools">
                  <label className="wx-tool-btn" title={t('发张图给他（也可以直接粘进来）')}>
                    <Ico name="image" size={19} />
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      hidden
                      onChange={(e) => {
                        takeShots([...(e.target.files ?? [])]);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  <label className="wx-tool-btn" title={t('贴一个文件给他看（图直接看，文本连内容一起带上）')}>
                    <Ico name="folder" size={19} />
                    <input
                      type="file"
                      multiple
                      hidden
                      onChange={(e) => {
                        for (const f of [...(e.target.files ?? [])]) takeFile(f);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  <button className="wx-tool-btn" title={t('把剪贴板里的截图贴进来')} onClick={() => void grabClip()}>
                    <Ico name="cut" size={19} />
                  </button>
                </div>

                <textarea
                  className="wx-input"
                  value={draft}
                  rows={3}
                  placeholder={
                    busy
                      ? t('他正忙着，等这一轮跑完再发')
                      : row && !row.open
                        ? t('说一句就把他叫到岗（在后台，不占布局）')
                        : ''
                  }
                  onChange={(e) => setDraft(e.target.value)}
                  onPaste={(e) => {
                    // 剪贴板里有图就用图，没有就当普通文本粘贴 —— 不抢掉正常粘贴
                    const files = [...(e.clipboardData?.files ?? [])];
                    if (!files.some((f) => f.type.startsWith('image/'))) return;
                    e.preventDefault();
                    takeShots(files);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />

                <div className="wx-sendrow">
                  <button
                    className="wx-send"
                    disabled={!draft.trim() && shots.length === 0 && files.length === 0}
                    onClick={send}
                  >
                    发送
                  </button>
                </div>
              </div>
            </footer>
          </>
        )}
      </section>

      {/*
        右侧挤出来的**会话记录**：**按一次完整的对话回忆**，不是一条条翻旧账。
        点右上角那个会话键开关；它一开，聊天区被挤窄 —— 是挤压，不是盖上去的浮层。
      */}
      {sel && recOpen && ready && (
        <aside className="wx-hist">
          <header className="wx-hist-head">
            {shown.recall ? (
              <>
                <button
                  className="wx-act"
                  title={t('回到会话列表')}
                  onClick={() => push({ type: 'recall', watcher: panel.id, empId: sel })}
                >
                  <Ico name="back" />
                </button>
                <b>{t('这一次会话')}</b>
              </>
            ) : (
              <b>{t('会话记录')}</b>
            )}
            <button className="wx-act" title={t('收起')} onClick={() => setRecOpen(false)}>
              <Ico name="close" />
            </button>
          </header>

          <div className="wx-hist-body">
            {shown.recall ? (
              <>
                <p className="wx-hist-when">
                  {dayOf(shown.recall.from)} {clockOf(shown.recall.from)}
                  {shown.recall.to && shown.recall.to !== shown.recall.from
                    ? ` – ${clockOf(shown.recall.to)}`
                    : ''}{' '}
                  · {shown.recall.count} 条
                  {shown.recall.truncated ? t('（只给最近一部分）') : ''}
                </p>
                {shown.recall.msgs.map((m, i) => (
                  <div className={`wx-rmsg ${m.role === 'user' ? 'me' : 'it'}`} key={i}>
                    <span className="wx-rwho">{m.role === 'user' ? t('你') : shown.name}</span>
                    {m.images && m.images.length > 0 && (
                      <div className="wx-shots">
                        {m.images.map((s, j) => (
                          <img key={j} src={shotUrl(s)} alt="" title={t('点开看大图')} onClick={() => setZoom(s)} />
                        ))}
                      </div>
                    )}
                    {m.text && <p>{rich(m.text)}</p>}
                  </div>
                ))}
              </>
            ) : shown.sessions.length === 0 ? (
              <p className="wx-hint">
                还没有更早的会话。<br />
                一次对话停 {shown.gapMin || SEG_MIN} 分钟以上，再来就是新的一次 ——
                {t('那一次会收进面板左边那条「历史会话」，跟这儿是同一份。')}
              </p>
            ) : (
              shown.sessions.map((s) => (
                <button
                  className="wx-seg"
                  key={s.key}
                  title={t('点开看这一次完整的对话')}
                  onClick={() => push({ type: 'recall', watcher: panel.id, empId: sel, key: s.key })}
                >
                  <span className="wx-seg-top">
                    <b>{dayOf(s.from)}</b>
                    <time>
                      {clockOf(s.from)} – {clockOf(s.to)}
                    </time>
                  </span>
                  <span className="wx-seg-line">{s.title || s.head}</span>
                  <span className="wx-seg-foot">
                    {s.count} 条 · {s.tail}
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>
      )}

      {/* 右键那一行点出来的小菜单。只此一项 —— 聊天列表里右键一个人，
          想要的就是"把他钉在最上面"。位置用视口坐标，贴着鼠标出。 */}
      {menu && (
        <div className="wx-menu" ref={menuRef} style={{ left: menu.x, top: menu.y }}>
          <button
            onClick={() => {
              push({ type: 'top', watcher: panel.id, empId: menu.id, on: !topped.has(menu.id) });
              setMenu(null);
            }}
          >
            <Ico name="pin" size={15} />
            {topped.has(menu.id) ? t('取消置顶') : t('置顶')}
          </button>
        </div>
      )}

      {/* 看图：脸自己铺一层，点一下就关。（核心也有一层看大图，但那是核心画的界，插件够不着） */}
      {zoom && (
        <div className="wx-zoom" onClick={() => setZoom('')} title={t('点一下关掉')}>
          <img src={shotUrl(zoom)} alt="" />
        </div>
      )}
    </div>
  );
}
