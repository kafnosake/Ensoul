import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatResponse, LiveTask, Panel, PanelNote } from '../../shared/types';
import { api } from '../core/api';
import type { AskView } from '../core/api';
import { IconChevron } from '../ui/icons';
import { onAppearance, getToolStepMode } from '../ui/theme';
import { PanelZoomChip } from '../ui/ZoomOverlay';
import { Composer } from './chat/Composer';
import { Message } from './chat/Message';
import { ToolGroup } from './chat/toolgroup';
import { applyChatStreamEvent, buildChatTimeline, emptyChatStream, restoreChatStream } from './chat/timeline';
import type { ChatStreamEvent } from './chat/timeline';
import { renderMarkdown } from '../ui/markdown';
import { LiveCard } from './chat/LiveCard';
import { NoteGauge } from './chat/NoteGauge';
import { AskBar } from './chat/AskBar';
import type { AskAnswerDraft } from './chat/AskBar';
import { GitPackagerDock } from './chat/GitPackagerDock';
import { HistRail } from './chat/HistRail';
import { FOLLOW_SLACK, PAGE, PEEK_W } from './chat/constants';
import type { ChatQuote } from './chat/types';
import { SelectionToolbar, SelectionPos } from './chat/SelectionToolbar';
import { fmtTime } from './chat/format';
import { useNotes } from './chat/useNotes';
import { useUserHighlights } from './chat/useUserHighlights';
import { absOffset, makeRange, paintHighlights, clearHighlights } from './chat/highlight-dom';
import { useSessionWidth } from './chat/useSessionWidth';
import { useWorkspace, hydratePanel, forgetHydrated } from '../core/useWorkspace';
import { zoomScale } from '../ui/zoom-space';

/**
 * 对话面板（外壳）：头部 + 消息区 + 输入区 + 会话列那两条可拖的边。
 * 一块块分在 ./chat/ 下面 —— 这里只负责把它们摆在一起，
 * 以及管住"这一轮要发出去的东西"（草稿 / 待发的图 / 是否在跑 / 会话列的宽度）。
 *
 * 便签**不住在这里**：它是右边缘那条宽度 0 的刻度（NoteGauge），读的是插件写的
 * `.ensoul/state/notes.json`。会话列有多宽、便签有几条，是两件不相干的事。
 */
/**
 * 面板自己的对话框 —— 这个项目的对话框就是这里。
 *
 * 它是 composer 形态：输入框下面一条工具栏，
 *   · 左边「＋」引用工作区文件（插 `@路径`，发出去时带上文件内容）
 *   · 右边**模型选择**就贴在输入框上（这个窗口用哪个模型，一眼看到、随手能换）
 *   · 最右是发送/停止
 */
const StreamingMarkdown = React.memo(function StreamingMarkdown({ content }: { content: string }) {
  return <>{renderMarkdown(content)}</>;
});

/**
 * 思维链只摆最后一段：要的是"它此刻在想什么"，不是把它的草稿摊满一屏。
 * 摊满一屏正是"莫名其妙一大堆文字"的来源之一。
 */
function tailOf(s: string, n = 220) {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

/**
 * 历史会话小栏开着没有 —— **按面板记**。跟便签不一样：便签是数据，这是
 * 这个人的习惯（他习惯左边摆着还是收着），所以放 localStorage 而不是面板上。
 *
 * key 里带 `rail`：这跟早期那两版（零宽刻度带、抽屉）**不是同一个东西**，
 * 那时候收起来的记忆不该继承下来 —— 换了形态就该从头来。
 * 默认**开着**：历史就该待在会话区左边；只有明明白白收起过（'0'）才收起来。
 */
const HIST_LS = 'histconv.rail.';
const readHistOpen = (id: string): boolean => {
  try {
    return localStorage.getItem(HIST_LS + id) !== '0';
  } catch {
    return true;
  }
};
const writeHistOpen = (id: string, on: boolean) => {
  try {
    localStorage.setItem(HIST_LS + id, on ? '1' : '0');
  } catch {
    /* 存不上就只管这一回 */
  }
};

export function ChatDock({ panel, hostKey = 'main', full = false }: { panel: Panel; hostKey?: string; full?: boolean }) {
  const [, setAppearanceTick] = useState(0);
  useEffect(() => onAppearance(() => setAppearanceTick(t => t + 1)), []);
  const stepMode = getToolStepMode();
  const [stream, setStream] = useState('');
  const [liveResponses, setLiveResponses] = useState<ChatResponse[]>([]);
  /** 这一轮模型想的过程（思维链）：不进正文、不进历史，只给用户看它没在发呆 */
  const [think, setThink] = useState('');
  /** 它此刻是不是**还在**想 —— 只有这时候才把思维链摆出来，正文一出来就撤 */
  const [thinking, setThinking] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * 待用户点头的请求（null = 没有）—— 插件提的，界面只负责摆出来。
   * 为什么非要人来点：请求的一般形态是"那次调用会收掉这个进程"，而它提出请求的那一刻
   * 这一轮还没跑完，回复只在内存里 —— 自动执行等于把刚写的那段一起杀掉。
   */
  const [ask, setAsk] = useState<AskView | null>(null);
  /**
   * 工具跑动中那一块（进行中的容器 + 已经送进对话的图）。
   * **主进程是真源**：切标签时这个组件会卸载重挂，只活在 useState 里的话，
   * 换回来那段进度就全丢了 —— 所以挂载时要问一次，之后听广播。
   */
  const [live, setLive] = useState<{ tasks: LiveTask[]; images: string[] }>({ tasks: [], images: [] });
  const [askErr, setAskErr] = useState('');

  /** 有一批题要答时：问题卡片接管输入框那一格，Composer 让位（dsh 的附着式卡片就该这样） */
  const hasQuestions = Boolean(ask && ask.questions && ask.questions.length > 0);
  /**
   * 全局挂着"等全部会话结束就重启" —— 这件事不在本面板上判（它盯的是整个软件），
   * 主进程说了算。它一旦为真，这个输入框整个换一套手势（见 Composer）。
   */
  const [restartArmed, setRestartArmed] = useState(false);
  /**
   * 贴底部时历史会话开着没有 —— **按面板记**（localStorage），重启不丢。默认开着：
   * 贴底部那会儿消息列居中、左右各一大片留白，它住在留白里，一点代价都没有。
   */
  const [hist, setHist] = useState(() => readHistOpen(panel.id));
  useEffect(() => setHist(readHistOpen(panel.id)), [panel.id]);
  /**
   * 停到侧面时的历史会话 —— **默认收起，不常驻**。
   *
   * 侧面是把一条窄栏（默认 360）一切两半：历史栏一展开，正文就只剩一半 ——
   * 贴底部那套「默认开着」的理由在这儿不成立。所以这个停法下一律从收起开始，
   * 要看得自己点头栏那颗 ☰。这个开合**只活在当前停法里**，不动上面那份按面板
   * 记着的偏好：换回底部，该怎么显示还怎么显示。
   */
  const [histSide, setHistSide] = useState(false);
  /** 换面板、换停法 —— 侧栏里一律回到「收起」 */
  useEffect(() => { setHistSide(false); }, [panel.id, panel.chatSide]);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  /** 会话区那一块 —— 会话列的上下限按它的实际宽度算 */
  const body = useRef<HTMLDivElement>(null);
  // silent 的那些是插件注入的机器触发语：进历史（模型读得到），但**不画出来** ——
  // 用户没说过那句话，不能在他的对话里冒充「我」（见 ChatMessage.silent）
  const messages = React.useMemo(
    () => buildChatTimeline(Array.isArray(panel.chat) ? panel.chat : [], liveResponses)
      .filter((m) => m.role !== 'system' && !m.silent),
    [panel.chat, liveResponses],
  );

  /**
   * 这一块的正文**该不该去补**。
   *
   * 两种情况都要补：
   *   · 广播回来的是摘要版（这里根本没有 chat）
   *   · 有 chat，但**比主进程那边的条数少** —— 说明中间有消息没同步上
   *     （比如广播先到、增量在后，或者反向），得整份重拉一次对齐
   */
  const needBody = !Array.isArray(panel.chat) || panel.chat.length < (panel.summary?.count ?? 0);
  /**
   * 只在**这一块真的在屏幕上**时才补正文。
   *
   * 不加这道门的话：AI 员工那一堆是后台面板，每回一条消息摘要就变一次，
   * 后台上跑一轮就往主进程要一次几 MB 的正文，白白抢 IPC —— 刚省下来的又还回去了。
   * 看不见的面板不需要正文；被切到前台那一刻由下面那个 observer 补，一样来得及。
   */
  useEffect(() => {
    if (!needBody) return;
    // 「在不在屏幕上」要认**常驻**的 .dock-body，不能认会话列（log）。
    // 会话区没展开时 log 根本不在文档里 —— 刷新渲染层之后恰好就是这个状态：
    // 这道门一挡，panel:body 就没人去要，对话一直空着回不来。
    const el = body.current;
    // offsetParent 是 null = 祖先里有 display:none（后台标签组就是这么藏的）
    if (!el || el.offsetParent === null) return;
    void hydratePanel(panel.id);
  }, [panel.id, needBody, panel.summary?.count]);
  /**
   * 对话**被整体换掉**（/clear 清空、/compress 压缩）时重新拉一次。
   *
   * 判据是摘要条数**变小 / 归零**：那种情况下主进程那边的 chat 已经换了一批内容，
   * 本地补好的那份是旧的，必须丢掉重拉。往上长（正常对话）不管 —— 那条路由
   * chat:message 增量接就行，不必每次都要一遍全文。
   */
  const lastCount = useRef(panel.summary?.count ?? panel.chat?.length ?? 0);
  useEffect(() => {
    const now = panel.summary?.count ?? panel.chat?.length ?? 0;
    if (now < lastCount.current) {
      forgetHydrated(panel.id);
      void hydratePanel(panel.id);
    }
    lastCount.current = now;
  }, [panel.id, panel.summary?.count, panel.chat?.length]);
  /** 被切到前台的那一刻补正文 —— 兜住上面「当时还看不见」那种情况。 */
  useEffect(() => {
    if (!needBody) return;
    const el = body.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void hydratePanel(panel.id);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [panel.id, needBody]);
  type TimelineItem =
    | { type: 'msg'; msg: (typeof messages)[number] }
    | { type: 'tool-group'; id: string; tools: typeof messages };

  const timeline = React.useMemo(() => {
    if (stepMode !== 'compact') {
      return messages.map((m) => ({ type: 'msg' as const, msg: m }));
    }
    const res: TimelineItem[] = [];
    let curTools: typeof messages = [];
    for (const m of messages) {
      if (m.role === 'tool') {
        curTools.push(m);
      } else {
        if (curTools.length > 0) {
          res.push({ type: 'tool-group', id: 'tg-' + curTools[0].id, tools: curTools });
          curTools = [];
        }
        res.push({ type: 'msg', msg: m });
      }
    }
    if (curTools.length > 0) {
      res.push({ type: 'tool-group', id: 'tg-' + curTools[0].id, tools: curTools });
    }
    return res;
  }, [messages, stepMode]);

  /**
   * 从第几个条目开始渲染 —— 这是"长对话干什么都卡"的正解。
   *
   * 卡的不是宽度这个数字，是这一列里挂着多少条 DOM：上千条全在文档里，
   * 改一次宽度就要把上千条重新排版一遍，拖起来一帧一卡，滚动和流式也一样。
   * 所以老的那些**先不放进文档**，上面挂一个按钮，点一下再放一段
   * （只给最近的一段，更早的手动点开）。
   *
   * 在简洁模式（compact）下，连续的工具步骤已折叠为 ToolGroup，
   * 折叠的步骤不挂载内部 DOM，整个工具组只占 1 个展示条目，不逐条吃掉这 100 条渲染配额。
   *
   * null = 还跟着尾巴走（起点永远是"末尾往前数 PAGE 条"）。一旦点过按钮，
   * 就钉在具体的下标上 —— 钉住之后来了新消息，窗口往下长，**下面进新的、
   * 上面一条也不掉**。不钉的话，新消息一到起点就往后挪一格，正在往上看的人
   * 会看见自己读的那一行突然往上跳。
   *
   * 这里只管"渲染多少"，对话本身一条没少 —— 数据还是整份在 panel.chat 里。
   */
  const [from, setFrom] = useState<number | null>(null);
  useEffect(() => setFrom(null), [panel.id]); // 换一块面板 = 换一段对话
  const tail = Math.max(0, timeline.length - PAGE);
  const start = from == null ? tail : Math.min(from, tail);
  const visibleTimeline = timeline.slice(start);

  /**
   * 没钉住的时候，窗口是"末尾往前数 PAGE 条"—— 来一条新消息，整个窗口就往后滑一格，
   * 最上面那一条被挤出去。用户刚好在往回读，就会看见自己读的那行突然往上跳。
   * 所以：**用户不在底部**（follow 是假的）而来了新消息，就把窗口钉在当前位置。
   *
   * startRef 存的是**上一次渲染**的起点 —— 钉住要钉在那个旧值上，
   * 用新值等于什么都没钉（新的起点已经把最上面那条挤掉了）。
   */
  const startRef = useRef(start);
  const prevLen = useRef(timeline.length);
  useEffect(() => {
    if (timeline.length > prevLen.current && !follow.current) setFrom(startRef.current);
    prevLen.current = timeline.length;
    startRef.current = start;
  }, [timeline.length, start]);
  /** 往上放一段的时候记一下"视口离底部多远"，补回去就看不见跳动 */
  const keepAt = useRef(0);
  const showMore = () => {
    const el = log.current;
    keepAt.current = el ? el.scrollHeight - el.scrollTop : 0;
    follow.current = false; // 人家是在往回读，放完别又把他拽到底
    setFrom(Math.max(0, start - PAGE));
  };
  useLayoutEffect(() => {
    const el = log.current;
    if (!el || !keepAt.current) return;
    el.scrollTop = el.scrollHeight - keepAt.current;
    keepAt.current = 0;
  }, [start]);
  /**
   * 会话区开没开 —— 初始值**要认摘要**。
   *
   * 刷新渲染层那一刻广播里只有骨架 + summary，panel.chat 还没补回来，
   * 光看 messages 会算成 0：会话区一刷新就整个塌掉。塌掉之后上面那道补正文的门
   * 也走不进去（log 不在文档里），正文就永远没人要 —— 表现正是「一刷新就清空」。
   * 摘要说有几条就先开着，正文一到就是那几条。
   */
  const [openState, setOpen] = useState(messages.length > 0 || (panel.summary?.count ?? 0) > 0);
  const open = full || openState;
  /**
   * 这一轮**已经在跑、但一个字还没吐出来** —— 就是开头那几秒。
   *
   * 它决定那块"正在发生的事"要不要**提前摆出来**：以前它要等第一个 token 才出现，
   * 于是块的高度是在滚动完之后才长出来的，新内容停在视野下面，用户得自己往下拉。
   * 现在开跑就摆（摆个转着的小点 + "正在想"），高度先占住，内容一来就在眼前。
   */
  const idle = !stream && !think && live.tasks.length === 0 && live.images.length === 0;
  /** 便签：读插件写下的那份文件（.ensoul/state/notes.json）—— 核心已经不认识了 */
  const notes = useNotes(panel.id);
  /** 插件挂的顶上状态（git 分支这类）在广播里，跟着它一起读 */
  const ws = useWorkspace();
  /**
   * 会话列的宽度 —— 左右各一条几乎看不见的边，拖它就是改列宽、双击复位。
   * **跟便签没有关系**：那是这一列的事，存 panel.chatW（见 useSessionWidth）。
   */
  const sess = useSessionWidth(panel);
  /** 会话区停哪一边 —— 没这个字段（老面板）就是一直的样子：贴底部 */
  const side = full ? null : panel.chatSide ?? null;
  /**
   * 历史栏此刻该不该露出来，以及头栏那颗 ☰ 管的是哪个开关：
   * 贴底部用按面板记住的那份（默认开），停侧面用 histSide（默认关）。
   */
  const histOn = side ? histSide : hist;
  const persistHist = (on: boolean) => {
    if (side) return setHistSide(on);
    setHist(on);
    writeHistOpen(panel.id, on);
  };
  /** 轮转：底部 → 右侧 → 左侧 → 底部 */
  const cycleSide = () => {
    const next = side === null ? 'right' : side === 'right' ? 'left' : undefined;
    void api.panel.patch(panel.id, next ? { chatSide: next } : { chatSide: undefined });
  };
  /** 鼠标停在哪一格刻度上 —— 那一条的内容要浮出来 */
  const [peek, setPeek] = useState<{ note: PanelNote; top: number; left: number } | null>(null);
  /** 点住的那一格：鼠标移开也不消失，可以慢慢看、滚、选中文字 */
  const [pinned, setPinned] = useState<{ note: PanelNote; top: number; left: number } | null>(null);

  /**
   * 逐字到达的增量先攒起来，按帧合并成一次 setState（一个 token 一次 setState 会把
   * 主线程压死）。缓冲和 rAF 句柄住在 ref 里，因为这一轮结束时得把它们**一起掐掉** ——
   * 见下面的 resetLive。
   */
  const liveBuf = useRef({ text: '', raf: 0, timer: null as ReturnType<typeof setTimeout> | null, tbuf: '', traf: 0 });
  const activeAssistant = useRef<string | null>(null);
  const completedAssistant = useRef<string | null>(null);
  const streamView = useRef(emptyChatStream());

  /**
   * 还跟不跟着底部走。用户自己往上翻了就是在读旧内容 —— 那时候再自动滚到底，
   * 等于把他正在看的东西抽走。所以他离底部远了就停下，回到（接近）底部再自动跟。
   */
  const follow = useRef(true);
  /** 上一次的 scrollTop —— 用它认出"用户往上滚了"（见下面 onScroll）。 */
  const lastTop = useRef(0);
  /**
   * 用户翻上去了（离底部远、且是他自己滚的）—— 才浮出「回到底部」那个按钮。
   * 它跟 follow 说的是同一件事，只是一个给逻辑用（ref，不重渲染），一个给界面用。
   */
  const [away, setAway] = useState(false);
  const pinBottom = React.useCallback(() => {
    follow.current = true;
    setAway(false);
    setFrom(null);
    const go = () => {
      const el = log.current;
      if (el) el.scrollTop = el.scrollHeight;
    };
    go();
    // 新消息挂进 DOM 的那一帧，浏览器还没量出新高度（图、代码块、流式正文都是之后
    // 才长高的），只滚一帧就停在半路 —— 用户看到的正是"我发的话在下面，得自己往下拉"。
    requestAnimationFrame(() => {
      go();
      requestAnimationFrame(go);
    });
  }, []);

  /**
   * 新消息落定（自己那句、助手那条）也跟着回到底部 —— 前提是用户没在往回读。
   *
   * 发送那一刻已经 pinBottom 过一次，这里是第二道：从「按下发送」到「这条真进列表」
   * 隔着主进程一个来回，这期间用户完全可能又滚上去了；而 follow 记的是他一整路的意图
   * —— 他要是正在读旧内容，这里就不动他（那正是 follow 的用处）。
   */
  const lastLen = useRef(messages.length);
  useEffect(() => {
    if (messages.length > lastLen.current && follow.current) pinBottom();
    lastLen.current = messages.length;
  }, [messages.length, pinBottom]);
  const stick = React.useCallback(() => {
    const el = log.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, []);

  /**
   * 这一轮结束：先把还在帧里排队的增量丢掉，再清屏。**顺序不能反**。
   *
   * 帧合并的代价是：最后一次 flush 很可能排在"这一轮结束"之后才跑。那时屏已经清了，
   * 它又把攒着的那段追加回去 —— 于是正文的尾巴永远留在对话最下面，不再属于任何一条
   * 回复（"莫名其妙一个助手说了一大堆文字常驻在最下面"就是它，截图里那半句就是尾巴）。
   */
  const resetDraft = React.useCallback(() => {
    const s = liveBuf.current;
    if (s.raf) cancelAnimationFrame(s.raf);
    if (s.timer) clearTimeout(s.timer);
    if (s.traf) cancelAnimationFrame(s.traf);
    s.raf = 0;
    s.timer = null;
    s.traf = 0;
    s.text = '';
    s.tbuf = '';
    setStream('');
    setThink('');
    setThinking(false);
  }, []);
  const resetLive = React.useCallback(() => {
    resetDraft();
    setLiveResponses([]);
    activeAssistant.current = null;
    streamView.current = emptyChatStream();
  }, [resetDraft]);

  useEffect(() => {
    resetLive();
    completedAssistant.current = null;
  }, [panel.id, resetLive]);

  useEffect(() => {
    const s = liveBuf.current;
    let alive = true;
    let restoring = true;
    let runningChanged = false;
    const pendingEvents: ChatStreamEvent[] = [];
    const accepts = (id: string) => {
      if (!activeAssistant.current && completedAssistant.current !== id) activeAssistant.current = id;
      return activeAssistant.current === id;
    };
    const cancelWrite = () => {
      if (s.raf) cancelAnimationFrame(s.raf);
      if (s.timer) clearTimeout(s.timer);
      s.raf = 0;
      s.timer = null;
    };
    const trimThinking = (amount: number) => {
      if (s.traf) cancelAnimationFrame(s.traf);
      s.traf = 0;
      const reasoning = s.tbuf;
      s.tbuf = '';
      setThink((v) => (v + reasoning).slice(0, Math.max(0, v.length + reasoning.length - amount)));
      setThinking(false);
    };
    const flush = () => {
      s.raf = 0;
      setStream(s.text);
      setOpen(true);
    };
    const applyEvent = (event: ChatStreamEvent) => {
      const previous = streamView.current;
      const next = applyChatStreamEvent(previous, event, completedAssistant.current);
      if (previous === next) return;
      streamView.current = next;
      activeAssistant.current = next.id;
      if (event.kind === 'progress') {
        if (event.value.reset || previous.id !== next.id) resetDraft();
        s.text = next.text;
        setStream(next.text);
        setLiveResponses(next.responses);
        setOpen(true);
      } else if (event.kind === 'retract') {
        cancelWrite();
        s.text = next.text;
        setStream(next.text);
        trimThinking(event.value.think);
      } else {
        s.text = next.text;
        setThinking(false);
        if (!s.raf && !s.timer) {
          s.timer = setTimeout(() => {
            s.timer = null;
            s.raf = requestAnimationFrame(flush);
          }, 80);
        }
      }
    };
    const receive = (event: ChatStreamEvent) => {
      if (event.value.panelId !== panel.id) return;
      if (event.value.id === completedAssistant.current) return;
      if (restoring) {
        if (event.kind === 'progress') activeAssistant.current = event.value.id;
        pendingEvents.push(event);
        if (event.kind === 'retract' && accepts(event.value.id)) trimThinking(event.value.think);
      } else applyEvent(event);
    };
    const off = api.chat.onDelta((p) => receive({ kind: 'delta', value: p }));
    const offP = api.chat.onProgress((p) => receive({ kind: 'progress', value: p }));
    const offR = api.chat.onRetract((p) => receive({ kind: 'retract', value: p }));
    const flushThink = () => {
      s.traf = 0;
      if (!s.tbuf) return;
      const d = s.tbuf;
      s.tbuf = '';
      setThink((v) => v + d);
      setOpen(true);
    };
    const offT = api.chat.onReasoning((p) => {
      if (p.panelId !== panel.id || !accepts(p.id)) return;
      setThinking(true);
      s.tbuf += p.delta;
      if (!s.traf) s.traf = requestAnimationFrame(flushThink);
    });
    const offRunning = api.chat.onRunning((p) => {
      if (p.panelId !== panel.id) return;
      runningChanged = true;
      setBusy(p.running);
    });
    const restore = (snapshot?: Awaited<ReturnType<typeof api.chat.running>>[number]) => {
      const next = restoreChatStream(snapshot, pendingEvents, completedAssistant.current);
      pendingEvents.length = 0;
      restoring = false;
      streamView.current = next;
      activeAssistant.current = next.id;
      cancelWrite();
      s.text = next.text;
      setStream(next.text);
      setLiveResponses(next.responses);
      if (next.text) setThinking(false);
      if (next.id) setOpen(true);
    };
    void api.chat.running().then((list) => {
      if (!alive) return;
      const me = Array.isArray(list) ? list.find((x) => x.panelId === panel.id) : undefined;
      if (!runningChanged) setBusy(Boolean(me && me.id !== completedAssistant.current));
      restore(me);
    }, () => {
      if (alive) restore();
    });

    return () => {
      alive = false;
      cancelWrite();
      if (s.traf) cancelAnimationFrame(s.traf);
      s.traf = 0;
      s.text = '';
      s.tbuf = '';
      off();
      offT();
      offP();
      offR();
      offRunning();
    };
  }, [panel.id, resetDraft]);

  /** 跑动中那一块：挂载时问一次（切标签回来接得上），之后听广播 */
  useEffect(() => {
    let alive = true;
    const apply = (v: { tasks?: LiveTask[]; images?: string[] } | null) => {
      if (!v) return;
      setLive({ tasks: v.tasks ?? [], images: v.images ?? [] });
      if ((v.tasks?.length ?? 0) > 0 || (v.images?.length ?? 0) > 0) setOpen(true);
    };
    const off = api.chat.onLive((p) => {
      if (p.panelId === panel.id) apply(p);
    });
    void api.chat.liveState(panel.id).then((v) => {
      if (alive) apply(v);
    });
    return () => {
      alive = false;
      off();
    };
  }, [panel.id]);

  /**
   * 落定的回复一到，临时那一块立刻撤 —— 撤的时机以**主进程的广播**为准，
   * 不赌"发出去那个 promise 谁先回来"：这一轮真正结束的标志是那条消息进了对话，
   * 不是 send() 的返回。两处都清一次是刻意的，谁先到都不留残影。
   */
  useEffect(() => {
    const off = api.chat.onMessage((p) => {
      if (p.panelId !== panel.id) return;
      if (p.message.role !== 'assistant') return;
      if (activeAssistant.current && activeAssistant.current !== p.message.id) return;
      completedAssistant.current = p.message.id;
      resetLive();
    });
    return off;
  }, [panel.id, resetLive]);

  /** 待确认的请求：挂载时问一次（换窗口、刷新之后也找得回来），之后听广播 */
  useEffect(() => {
    let alive = true;
    void api.chat.askState(panel.id).then((r) => {
      if (alive) {
        setAsk(r?.ask ?? null);
        setRestartArmed(Boolean(r?.restartArmed));
      }
    });
    const off = api.chat.onAsk((p) => {
      // 挂起是**全局**的一件事（整个软件都闲下来才动手），所以哪怕这条请求不是本面板的，
      // 那个标记也得跟着更新 —— 否则别的面板上输入框还是"直接发送"的手势。
      if (typeof p.restartArmed === 'boolean') setRestartArmed(p.restartArmed);
      if (p.panelId !== panel.id) return;
      setAsk(p.ask);
      setAskErr('');
    });
    return () => {
      alive = false;
      off();
    };
  }, [panel.id]);

  /**
   * 自动跟着走：这一轮在长的时候，**新出来的东西得自己进视野**。
   *
   * 以前是"这几个 state 一变就滚一次"，漏得很干脆 —— 思维链（think）和跑动中的容器
   * （进度、预览图）根本不在依赖里，而它们恰恰是**先**到的；更要命的是那块容器还在自己长高
   * （过程预览图一帧比一帧大），外面的 state 一动不动。于是内容一路长在视野**下面**，
   * 用户得自己往下拉，才看得见"它在想什么"。
   *
   * 所以别看 state，看**盒子**：滚动列里每个孩子都挂一个 ResizeObserver（谁长高了都算数），
   * 再用 MutationObserver 认住新来的孩子。滚动权留在用户手上 —— 自己往上翻了就不再拽他回来，
   * 回到（接近）底部才重新跟着走。
   */
  useEffect(() => {
    const el = log.current;
    if (!el) return;

    /**
     * 滚回底部这件事按帧合并 —— 一帧最多滚一次。
     *
     * 滚动列里每个孩子都挂着一个 ResizeObserver（见上面那段），一轮回答里
     * 能连着刷几十次回调；每次 stick() 都要读 scrollHeight（强制布局）。
     * 不过真要说"拖起来卡"，根子不在这儿，在消息列里挂着多少条 DOM ——
     * 那个由上面那份窗口管（只渲染最近 PAGE 条），这里只要不重复滚就够。
     */
    let raf = 0;
    const kick = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        stick();
      });
    };
    const ro = new ResizeObserver(kick);
    const watch = () => {
      for (const c of Array.from(el.children)) ro.observe(c);
    };
    const mo = new MutationObserver(() => {
      watch();
      kick();
    });
    watch();
    mo.observe(el, { childList: true });
    /**
     * 挂载（含切标签切回来、展开会话区）时先站到底部 —— 长对话默认落在最下面那条，
     * 而不是回顶端。这里顺手滚两帧：图、代码块要等排完版才知道自己多高。
     */
    pinBottom();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
    };
  }, [open, stick, pinBottom]);

  /** 钉住的卡片：点别的地方就收起来（点卡片自己、点刻度不算） */
  useEffect(() => {
    if (!pinned) return;
    const away = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('.note-pop') || t.closest('.note-gauge'))) return;
      setPinned(null);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [pinned]);

  // 叠加引用列表与划词小浮窗
  const [quotes, setQuotes] = useState<ChatQuote[]>([]);
  const [selectionPos, setSelectionPos] = useState<SelectionPos | null>(null);

  const addQuote = (quote: Omit<ChatQuote, 'id'>) => {
    setQuotes((prev) => [...prev, { ...quote, id: 'q-' + Math.random().toString(36).slice(2, 9) }]);
    input.current?.focus();
  };

  const removeQuote = (id: string) => {
    setQuotes((prev) => prev.filter((q) => q.id !== id));
  };

  const clearQuotes = () => {
    setQuotes([]);
  };

  const handleEditUserMsg = (msgId: string, newContent: string) => {
    const newChat = (panel.chat ?? []).map((m) => (m.id === msgId ? { ...m, content: newContent } : m));
    void api.panel.patch(panel.id, { chat: newChat });
  };

  const handleResendUserMsg = (content: string, pics?: string[]) => {
    void send(content, pics ?? []);
  };

    /** 纯客户端视觉层划词荧光笔：像笔记软件一样标黄，完全不污染消息内容与 LLM 上下文，截图即用 */
        // —— 用户划词高亮：纯前端个人笔记（localStorage 持久化，刷新不丢；会话 JSON 零改动）——
  const { highlights, addHighlight, removeHighlight, migrateHighlights } = useUserHighlights(panel.id);

  // 消息区每次重绘后把记录重新画上：CSS Custom Highlight 只在文字底下上色，
  // 零 DOM 改动 → 零宽度变化、零断行；一整段划词就是一条连续 Range → 点击绝不拆块。
  useLayoutEffect(() => {
    if (stream) return;
    const mig = paintHighlights(panel.id, log.current, highlights);
    // 旧格式记录 / 消息被改写后重新定位到真实位置 → 回填，一次收敛
    if (mig.length) migrateHighlights(mig);
    return () => clearHighlights(panel.id);
  }, [highlights, visibleTimeline.length, !stream]);

  /** 单击已标记的文字 → 把这一整段（哪怕跨节点、跨格式）完整选中并弹浮窗 */
  const clickSelectMark = (clientX: number, clientY: number): boolean => {
    const doc = document as any;
    if (typeof doc.caretRangeFromPoint !== 'function') return false;
    const caret: Range | null = doc.caretRangeFromPoint(clientX, clientY);
    if (!caret || !log.current) return false;
    const node = caret.startContainer;
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
    const msgEl = el?.closest?.('[data-msg-id]');
    if (!msgEl) return false;
    const body = (msgEl.querySelector('.msg-body') as HTMLElement) || (msgEl as HTMLElement);
    const abs = absOffset(body, node, caret.startOffset);
    if (abs < 0) return false;
    const msgId = msgEl.getAttribute('data-msg-id') || '';
    const hit = highlights.find((h) => h.msgId === msgId && abs >= h.start && abs < h.start + h.len);
    if (!hit) return false;
    const r = makeRange(body, hit.start, hit.len);
    const sel = window.getSelection();
    if (!r || !sel) return false;
    sel.removeAllRanges();
    sel.addRange(r);
    const rect = r.getBoundingClientRect();
    setSelectionPos({
      x: rect.right + 2,
      y: rect.bottom + 4,
      selectedText: hit.text,
      msgId,
      start: hit.start,
      len: hit.len,
      isMarked: true,
      hlIds: [hit.id],
    });
    return true;
  };

  /** 浮窗「标记 / 取消标记」：只增删本地记录，绝不碰消息 DOM，更不碰会话 JSON */
  const handleHighlight = (pos: SelectionPos) => {
    try {
      if (pos.isMarked) {
        for (const id of pos.hlIds || []) removeHighlight(id);
      } else if (pos.msgId && pos.start != null && pos.len != null && pos.len > 0) {
        const escaped = pos.msgId.replace(/["\\]/g, '\\$&');
        const msgEl = log.current?.querySelector(`[data-msg-id="${escaped}"]`);
        const body = (msgEl?.querySelector('.msg-body') as HTMLElement) || null;
        const text = (body?.textContent || '').slice(pos.start, pos.start + pos.len);
        if (text.trim()) addHighlight(pos.msgId, pos.start, pos.len, text);
      }
    } finally {
      window.getSelection()?.removeAllRanges();
      setSelectionPos(null);
    }
  };

  // 拼接叠加的引用内容与图片
  const mergeQuotes = (text: string, pics: string[]) => {
    const textQuotes = quotes.filter((q) => q.type === 'text');
    let combinedText = text;
    if (textQuotes.length > 0) {
      const quoteBlock = textQuotes
        .map((q) =>
          q.content
            .trim()
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n'),
        )
        .join('\n\n');
      combinedText = combinedText ? `${quoteBlock}\n\n${combinedText}` : quoteBlock;
    }
    const imgQuotes = quotes.filter((q) => q.type === 'image').map((q) => q.content);
    const combinedPics = [...new Set([...imgQuotes, ...pics])];
    return { combinedText, combinedPics };
  };

  const send = async (text: string, pics: string[]) => {
    const { combinedText, combinedPics } = mergeQuotes(text, pics);
    if ((!combinedText && !combinedPics.length) || busy) return;
    clearQuotes();
    pinBottom(); // 自己发的这一轮，当然要从头看到尾：立刻回到底部（哪怕刚才翻到上面去了）
    resetLive();
    setBusy(true);
    setOpen(true);
    await api.chat.send(panel.id, combinedText, combinedPics);
    // 正文与进度由 chat:message 的落定事件一起交接。
  };

  /**
   * 排队：把草稿挂到面板的待发队列上，**不打断**这一轮。
   */
  const queueUp = async (text: string, pics: string[]) => {
    const { combinedText, combinedPics } = mergeQuotes(text, pics);
    if (!combinedText && !combinedPics.length) return;
    clearQuotes();
    setOpen(true);
    await api.chat.enqueue(panel.id, combinedText, combinedPics);
  };

  /**
   * 插话：送进**此刻正在跑**的那一轮。
   */
  const steerNow = async (text: string, pics: string[]): Promise<boolean> => {
    const { combinedText, combinedPics } = mergeQuotes(text, pics);
    if ((!combinedText && !combinedPics.length) || !busy) return false;
    clearQuotes();
    pinBottom(); // 插话是自己说的，也跟着到底部（哪怕刚才翻在上面）
    const r = await api.chat.steer(panel.id, combinedText, combinedPics);
    return Boolean(r?.ok);
  };

  /**
   * 卡片摆在刻度左边、别出屏（下沿留点余量，免得贴到窗口底）。
   *
   * 量到的是**屏幕坐标**，而这张卡是面板里的 fixed 元素 —— 面板缩放过之后，
   * 它的 left/top 会被再乘一次倍率（实测），所以先换回面板内部单位再摆。
   * 不换的话，面板一放大卡片就整个飘到刻度外面去。
   */
  const placeFor = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const k = zoomScale(el);
    const px = (v: number) => Math.round(v / k);
    return {
      left: Math.max(8, px(r.left) - PEEK_W - 10),
      top: Math.max(8, Math.min(px(r.top), window.innerHeight - 140)),
    };
  };

  /**
   * 指到一条便签：把内容摆到它**左边**（刻度在最右边，往右展开会出屏）。
   * 已经点住某一条的时候不再跟着鼠标飘 —— 那时候用户是在读，不是在找。
   */
  const hoverNote = (note: PanelNote | null, el?: HTMLElement | null) => {
    if (!note || !el || pinned) return setPeek(null);
    setPeek({ note, ...placeFor(el) });
  };

  /** 点一格刻度：钉住（再点同一格、点别处、或按关闭都取消） */
  const pickNote = (note: PanelNote, el: HTMLElement) => {
    setPeek(null);
    setPinned((p) => (p && p.note === note ? null : { note, ...placeFor(el) }));
  };

  return (
    <div
      className={`chatdock${full ? ' is-full' : ''}${side ? ` is-side-${side}` : ''}${restartArmed ? ' is-restart-armed' : ''}`}
      ref={sess.root}
      /* 会话列的有效宽度由它算（CSS 里的 --col-w / --col-in，见 chat.css）。
         拖动中这个变量由 useSessionWidth 直接写，不走 React —— 见那边的说明。 */
      style={
        {
          '--chat-w': `${sess.width}px`,
          // 只有**用户拖出来过**才写死这个值；没拖过就走 CSS 里那个 25%。
          // 一律写死像素值等于把「按面板比例」废掉 —— 面板缩放了它不跟，越看越别扭。
          ...(panel.chatWSide ? { '--chat-w-side': `${panel.chatWSide}px` } : {}),
        } as React.CSSProperties
      }
    >
      <div className="dock-head" onClick={() => !full && setOpen((v) => !v)}>
        <span className={`dock-caret${open ? ' is-open' : ''}`}>
          <IconChevron open={open} />
        </span>
        <span className="dock-title">{t('对话')}</span>
        {/* 历史会话抽屉的开合 —— 就摆在头栏这里（deepseek 那颗也在左上角）。
            收起之后**左边什么都不留**：不看历史的人一点代价都没有。 */}
        <button
          className={`dock-hist${histOn ? ' on' : ''}`}
          title={t(histOn ? '收起历史' : '展开历史')}
          onClick={(e) => {
            e.stopPropagation();
            // 拨的是**此刻露着的那个**开关（histOn）：侧栏里 hist 还是贴底部那份记忆，
            // 拿它取反会让 ☰ 点了没反应。
            persistHist(!histOn);
          }}
        >
          ☰
        </button>
        {!full && (
          <button
            className={`dock-side${side ? ' on' : ''}`}
            title={t(
              side === 'left'
                ? '会话区在左侧，点一下放回底部'
                : side === 'right'
                  ? '会话区在右侧，点一下挪到左侧'
                  : '会话区在底部，点一下停到右侧',
            )}
            onClick={(e) => {
              e.stopPropagation();
              cycleSide();
            }}
          >
            {side === 'left' ? '◧' : side === 'right' ? '◨' : '▭'}
          </button>
        )}
        <span className="dock-note">{messages.length > 0 ? t('{n} 条', { n: messages.length }) : ''}</span>
        <SubAgentHeader panelId={panel.id} />
        
        <span className="dock-right">
          {/* 插件挂的顶上状态（git 分支这类）：插件跑在主进程、画不了界面，
              所以它只说「显示什么」，画由这里来 —— 关掉那个插件，这块干净消失。 */}
          {(ws?.status?.[panel.id] ?? [])
            .filter((s) => s.slot === 'head' && Boolean(s.text?.trim()))
            .map((s) => (
              <span className="head-status" key={s.id} title={s.title}>
                {s.text}
              </span>
            ))}
          {
            /* 这块面板的比例显示 —— 就挂在 git 状态条右手边（见 ui/ZoomOverlay）。
               头部那一行本来就是「这块面板现在什么处境」，比例跟它是同类。 */
          }
          <PanelZoomChip panelId={panel.id} uiZoom={panel.uiZoom} />
          {panel.revisions && panel.revisions.length > 0 && (
            <button
              className="dock-revert"
              onClick={(e) => {
                e.stopPropagation();
                void api.panel.rollback(panel.id);
              }}
              title={
                panel.revisions[panel.revisions.length - 1]?.note
                  ? t('回退到上次输入前状态：{note}', { note: panel.revisions[panel.revisions.length - 1].note })
                  : t('回退到上次输入前的面板状态')
              }
            >
              回退上一版
            </button>
          )}
          {panel.redoRevisions && panel.redoRevisions.length > 0 && (
            <button
              className="dock-revert dock-redo"
              onClick={(e) => {
                e.stopPropagation();
                void api.panel.redo(panel.id);
              }}
              title={
                panel.redoRevisions[panel.redoRevisions.length - 1]?.note
                  ? t('恢复下一版：{note}', { note: panel.redoRevisions[panel.redoRevisions.length - 1].note })
                  : t('恢复被回退的面板改动')
              }
            >
              恢复下一版
            </button>
          )}
        </span>
      </div>

      {/* 会话区本体 + 贴在它右边缘的便签刻度 + 贴在它左边缘的历史会话。
          两条都是**会话区自己的东西**：便签是右边缘一条零宽刻度，历史是左边缘
          一列小字 —— 都住在列外面的留白里，谁也不推挤会话列。 */}
      <div className="dock-body" ref={body}>

      {/* 历史会话：**会话区左边界**上的一栏（跟右边缘那条便签同一族）。
          一版会话一行（今天 / 昨天 / 7 天内 / 更早 分组），点一行中间的会话
          就跳过去；行上还能改名、让模型重起标题、拖拽排序、多选删除。
          数据是插件写的 .ensoul/state/histconv/<面板 id>.json，
          动作写 .ensoul/state/histconv.cmd.json 递回插件（见 useHist）。
          开合由头栏那颗 ☰ 管（histOpen）；它自己量位置，挤不下就让位。 */}
      {/* 侧栏里它**默认不摆**（见 histSide）：窄栏经不起一半给历史，要看再点 ☰。 */}
      {open && histOn && <HistRail panel={panel} />}

      {/* 消息列这一块（列 + 那两条可拖的边 + 便签刻度）。
          **单独包一层**：历史那一栏是它的兄弟、绝对定位在它左边，两者谁也不覆盖谁。 */}
      <div className="dock-main">

      {open && (
        <div
          className="dock-log"
          data-step-mode={stepMode}
          ref={log}
          onMouseUp={(e) => {
            setTimeout(() => {
              const sel = window.getSelection();
              if (!sel) {
                setSelectionPos(null);
                return;
              }

              // ① 单击（无拖动选区）：点在已标记文字上 → 自动整段选中
              if (sel.isCollapsed) {
                if (clickSelectMark(e.clientX, e.clientY)) return;
                setSelectionPos(null);
                return;
              }

              // ② 拖动划词：量出选区在本条消息文本里的绝对位置
              const range = sel.getRangeAt(0);
              if (!log.current || !log.current.contains(range.commonAncestorContainer)) {
                setSelectionPos(null);
                return;
              }
              let sNode: Node = range.startContainer;
              if (sNode.nodeType === Node.TEXT_NODE) sNode = sNode.parentElement!;
              let msgEl = (sNode as HTMLElement | null)?.closest?.('[data-msg-id]') || null;
              if (!msgEl) {
                let eNode: Node = range.endContainer;
                if (eNode.nodeType === Node.TEXT_NODE) eNode = eNode.parentElement!;
                msgEl = (eNode as HTMLElement | null)?.closest?.('[data-msg-id]') || null;
              }
              if (!msgEl) {
                setSelectionPos(null);
                return;
              }
              const msgId = msgEl.getAttribute('data-msg-id') || undefined;
              const body = (msgEl.querySelector('.msg-body') as HTMLElement) || (msgEl as HTMLElement);
              const absStart = absOffset(body, range.startContainer, range.startOffset);
              const absEnd = absOffset(body, range.endContainer, range.endOffset);
              if (absStart < 0 || absEnd <= absStart) {
                setSelectionPos(null);
                return;
              }
              // 与已有高亮相交 → 浮窗按钮显示「取消标记」
              const hlIds = highlights
                .filter((h) => h.msgId === msgId && absStart < h.start + h.len && absEnd > h.start)
                .map((h) => h.id);

              const rects = range.getClientRects();
              const lastRect = rects[rects.length - 1] || range.getBoundingClientRect();
              setSelectionPos({
                x: lastRect.right + 2,
                y: lastRect.bottom + 4,
                selectedText: sel.toString().trim() || (body.textContent || '').slice(absStart, absEnd),
                msgId,
                start: absStart,
                len: absEnd - absStart,
                isMarked: hlIds.length > 0,
                hlIds,
              });
            }, 20);
          }}
          /* 用户自己往上翻过 = 他在读旧内容，别再把他拽回底下（见上面 stick）。
             回到接近底部 = 又在跟新内容了，窗口跟着放开，重新只渲染最近那段。 */
          onScroll={(e) => {
            const el = e.currentTarget;
            const top = el.scrollTop;
            const prev = lastTop.current;
            lastTop.current = top;
            const near = el.scrollHeight - top - el.clientHeight < FOLLOW_SLACK;
            /**
             * 判据**只看"用户往上滚"这一个动作**，不看"现在离底多远"。
             *
             * 只按距离判会误伤两种情况，两种都会让人以为"它不跟着走了"：
             *   · 内容在下面长高（图加载、代码块排版、流式正文变长）—— scrollTop
             *     一动不动，可它离底越来越远，于是一次次的自动滚都被当成用户往上翻；
             *   · 程序性滚动（stick 自己设的 scrollTop）也会派发 scroll 事件，
             *     夹在中间那几帧同样可能被算成"用户滚了"。
             * 所以：往回滚一截（比上一帧小）才算"他在读旧内容"，其余一律继续跟。
             */
            if (near) {
              follow.current = true;
              setAway(false);
              setFrom(null); // 值没变时 React 直接跳过，不会多渲染
            } else if (top < prev - 2) {
              follow.current = false;
              setAway(true); // 他是在读旧内容：别拽他，但要在角落告诉他"新内容在下面"
            }
          }}
        >
          {messages.length === 0 && !stream && !thinking && (
            <div className="dock-blank">{t('对话以注入灵魂。')}</div>
          )}
          {/* 更早的那些没放进文档 —— 点一下往上放一段。
              这是这一列轻下来的关键：DOM 只留最近几十条，改宽度、滚动、流式
              都不用再把上千条重排一遍（见上面 start 那段）。 */}
          {start > 0 && (
            <button className="dock-more" onClick={showMore}>
              {t('显示更早的 {n} 条', { n: Math.min(start, PAGE) })}<span className="dock-more-rest">{t('（还有 {n} 条）', { n: start })}</span>
            </button>
          )}
          {visibleTimeline.map((item) =>
            item.type === 'tool-group' ? (
              <ToolGroup
                key={item.id}
                tools={item.tools}
                panel={panel}
                stepMode={stepMode}
                onQuoteImage={(img) => addQuote({ type: 'image', content: img })}
                onEditUserMsg={handleEditUserMsg}
                onResendUserMsg={handleResendUserMsg}
              />
            ) : (
              <Message
                key={item.msg.id}
                panel={panel}
                id={item.msg.id}
                role={item.msg.role}
                content={item.msg.displayContent ?? item.msg.content}
                edited={item.msg.edited}
                at={item.msg.createdAt}
                stepMode={stepMode}
                stats={item.msg.stats}
                images={item.msg.images}
                steer={item.msg.steer}
                onQuoteImage={(img) => addQuote({ type: 'image', content: img })}
                onEditUserMsg={handleEditUserMsg}
                onResendUserMsg={handleResendUserMsg}
              />
            )
          )}
          {/* 这一轮**正在发生的事**：已经吐出来的正文 / 此刻在干什么 / 慢活跑到哪了。
              合成**一块**（.run-block），顺序就是这个时间线 —— 上面的都已经发生过了，
              最下面那条说的是"现在"。以前是三个兄弟节点各飘一处、顺序还是反的
              （图在最上、思考夹在中间、正文沉在最下），读起来像三段互不相干的东西。 */}
          {(stream || (thinking && think) || live.tasks.length > 0 || live.images.length > 0 || (busy && idle)) && (
            <div className="run-block">
              {/* 已经吐出来的正文：**不冒充一条落定的回复** —— 没有"助手"、没有假的时间戳，
                  顶上挂一个"正在写"的记号。但排版和宽度跟真消息完全一样：
                  它落定、换成正式那条的那一刻，不该有东西跳。 */}
              {stream && (
                <div className="live-write">
                  <span className="live-write-tag">{t('正在写')}</span>
                  <div className="msg-body live-write-body">
                    <StreamingMarkdown content={stream} />
                    <span className="live-caret" />
                  </div>
                </div>
              )}

              {/* 思维链：摆**内容**，而不是干一句"正在想"；位置压在正文下面，因为它说的是"此刻"。
                  以前它在正文上面，可一轮里模型要想好几回（正文写了一段又开始想下一轮），
                  于是屏幕上就成了"正在想"压着一大段已经写出来的输出，读起来自相矛盾。 */}
              {((thinking && think) || (busy && idle)) && (
                <div className="live-think">
                  <span className="think-dot" />
                  <span className="live-think-label">{t(stream ? '还在想' : '正在想')}</span>
                  {/* 还没有内容的那几秒只摆小点和这句标签 —— 它先把高度占住 */}
                  {think && <span className="live-think-text">{tailOf(think)}</span>}
                </div>
              )}

              {/* 进行中的容器压在最下面：它讲的是"这条回复底下正在跑什么"。
                  图最后也是落在正文后面的（见 Message 里 shotsEl 的摆法）——
                  两处位置对上，跑完就不该有东西跳来跳去。 */}
              <LiveCard tasks={live.tasks} images={live.images} panel={panel.id} />
            </div>
          )}
        </div>
      )}

      {/* 翻上去读旧内容时，右下角浮一个「回到底部」（主流对话工具里都有这一个）。
          它把话说清楚：新内容在下面，是**你自己在往回读**，所以它没跟着走 ——
          不然"它怎么不自动滚了"看起来就像坏了。 */}
      {open && away && (
        <button className="dock-jump" onClick={pinBottom} title={t('回到底部')}>
          回到底部
        </button>
      )}

      {/* 会话列的那两条边：**中轴对称**、几乎看不见，拖它就是改会话区的宽度（双击复位）。
          它们只属于消息列 —— 便签那条刻度是另一件东西，落在列的留白里，谁也不挡谁。 */}
      {open && side && (
        <div
          className="dock-gutter"
          onPointerDown={(e) => sess.startSide(e, body.current)}
          onDoubleClick={sess.resetSide}
          title={t('拖动改宽度，双击回到默认')}
        />
      )}

      {open && !side && (
        <>
          <div
            className="dock-edge dock-edge-l"
            onPointerDown={(e) => sess.start(e, body.current)}
            onDoubleClick={sess.reset}
            title={t('拖动改宽度')}
          />
          <div
            className="dock-edge dock-edge-r"
            onPointerDown={(e) => sess.start(e, body.current)}
            onDoubleClick={sess.reset}
            title={t('拖动改宽度')}
          />
        </>
      )}

      {/* 便签刻度：贴在消息列右边缘那串刻痕，**宽度 0**，鼠标指上去浮出那一条，点一下钉住。
          **一条便签都没有的时候也摆着**（空着）：文件面板里会话区的右边缘总得有点东西，
          不然"这里有没有控制"全靠运气 —— 有刻痕才说明这儿是刻度带。 */}
      {open && <NoteGauge notes={notes} onHover={hoverNote} onPick={pickNote} />}

      {/* 开源打包台（小林专属：便签右侧挂件） */}
      <GitPackagerDock panel={panel} />
      </div>
      </div>

      {/*
       * 模型卡在一次工具调用上等人回答 —— 问题表单。
       *
       * 跟下面那条「请用户点头」的老横条是两种东西：那个是审批（一句话 + 按钮，
       * 点了核心替插件跑一次工具）；这个是**问答**（一批题、翻页、单选选中即前进、
       * 能多选、能填自定义、能跳过），提交之后结构化答案顺 then 那条路回到提问方。
       * 所以先判 questions：有题目就走表单，没有才落到老横条。
       */}
      {ask && ask.questions && ask.questions.length > 0 && (
        <AskBar
          ask={{ text: ask.text, confirm: ask.confirm, cancel: ask.cancel, questions: ask.questions }}
          err={askErr}
          onSubmit={(answers: AskAnswerDraft[]) => {
            setAskErr('');
            void api.chat.askConfirm(panel.id, { answers }).then((r) => {
              if (!r?.ok && r?.error) setAskErr(r.error);
            });
          }}
          onCancel={() => {
            setAskErr('');
            // 右上角 ✕ —— 整张问卷作废（askCancel）。题内「跳过」不走这里
            void api.chat.askCancel(panel.id);
          }}
        />
      )}

      {/* 插件挂的请求：它自己按不下去这个按钮 —— 按下去等于把这一轮还没落盘的回复一起收掉 */}
      {ask && !(ask.questions && ask.questions.length > 0) && (
        <div className="ask-bar">
          <div className="ask-bar-text">
            {ask.text}
            {askErr && <div className="ask-bar-err">{askErr}</div>}
          </div>
          <div className="ask-bar-btns">
            {/*
             * **不给它 disabled**：重启这个请求天生就是「面板正跑着的时候提出来的」，
             * 从前这里写 disabled={busy} —— 于是按钮永远是灰的，用户看到的就是「点不了」。
             * 真按下去了，主进程那一侧还有一道守卫会拦住并给出人话（见 chat:askConfirm），
             * 界面这层不该替他做这个判断。
             */}
            <button
              className="ask-bar-ok"
              onClick={() => {
                setAskErr('');
                void api.chat.askConfirm(panel.id).then((r) => {
                  if (!r?.ok && r?.error) setAskErr(r.error);
                });
              }}
            >
              {ask.confirm}
            </button>
            {/* 第三条路：现在正忙（别的会话还在跑），等整个软件都闲下来再自己动手。
                点了不是立刻做，是把它挂起来 —— 时机由主进程盯着。 */}
            {ask.defer && (
              <button
                className={`ask-bar-defer${ask.armed ? ' is-armed' : ''}`}
                disabled={Boolean(ask.armed)}
                title={t(ask.armed ? '已挂起' : '跑完自动重启')}
                onClick={() => {
                  setAskErr('');
                  void api.chat.askDefer(panel.id).then((r) => {
                    if (!r?.ok && r?.error) setAskErr(r.error);
                  });
                }}
              >
                {ask.armed ? t('已挂起，等全部会话结束') : ask.defer}
              </button>
            )}
            <button
              className="ask-bar-no"
              onClick={() => {
                setAskErr('');
                void api.chat.askCancel(panel.id);
              }}
            >
              {ask.cancel}
            </button>
          </div>
        </div>
      )}

      {/* 有问题卡片时它**占掉输入框这一格**（dsh 就是这么做的：附着式卡片接管编辑器位置） */}
      {!hasQuestions && (
      <Composer
        panel={panel}
        hostKey={hostKey}
        busy={busy}
        send={send}
        queueUp={queueUp}
        steerNow={steerNow}
        queue={panel.outbox ?? []}
        restartArmed={restartArmed}
        inputRef={input}
        quotes={quotes}
        onRemoveQuote={removeQuote}
        onClearQuotes={clearQuotes}
      />
      )}

      {/* 划词小浮窗：引用、复制、标记（高亮） */}
      {selectionPos && (
        <SelectionToolbar
          pos={selectionPos}
          onQuote={(txt) => {
            addQuote({ type: 'text', content: txt });
            window.getSelection()?.removeAllRanges();
            setSelectionPos(null);
          }}
          onCopy={(txt) => void navigator.clipboard?.writeText(txt)}
          onHighlight={handleHighlight}
          onClose={() => setSelectionPos(null)}
        />
      )}

      {/* 便签摊开的那张卡：挂在最外层（fixed），才不会被消息区的滚动裁掉。
          指一下浮出来的那种只读、不挡点击；**点住的**那张可以滚动、能选中文字 —— 内容长的时候要能看全。 */}
      {peek && !pinned && (
        <div className="note-pop" style={{ top: peek.top, left: peek.left }}>
          <NotePeek note={peek.note} />
        </div>
      )}
      {pinned && (
        <div className="note-pop is-pinned" style={{ top: pinned.top, left: pinned.left }}>
          <button className="note-pop-close" onClick={() => setPinned(null)} title={t('收起')}>
            ×
          </button>
          <NotePeek note={pinned.note} />
        </div>
      )}
    </div>
  );
}

/** 一张便签的样子：我说的话，下面挂着它这一轮标出来的那几条 */
function NotePeek({ note }: { note: PanelNote }) {
  return (
    <>
      <div className="note-pop-meta">{t('你说的')} · {fmtTime(note.at)}</div>
      <div className="note-pop-text">{note.text}</div>
      {note.marks.length > 0 ? (
        <ul className="note-pop-marks">
          {note.marks.map((mk, i) => (
            <li key={i}>{mk}</li>
          ))}
        </ul>
      ) : (
        <div className="note-pop-none">{t('这一轮它还没标出什么')}</div>
      )}
    </>
  );
}

// ── 子智能体挂件 ──
interface SubAgentRecord {
  id: string;
  panelId?: string;
  title: string;
  status: 'running' | 'completed';
  startTime?: number;
  tokens?: string;
  duration?: string;
  summary?: string;
}

// ── 子智能体顶栏挂件 ──
interface SubRecord {
  id: string;
  panelId?: string;
  title: string;
  status: string;
  tokens?: string;
  duration?: string;
  summary?: string;
  targetPanelId?: string | null;
  taskId?: string;
  accepted?: boolean;
  canAccept?: boolean;
}

function SubAgentHeader({ panelId }: { panelId: string }) {
  const [items, setItems] = useState<SubRecord[]>([]);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!api.tasks) return;
    let alive = true;
    const load = async () => {
      try {
        const records = await api.tasks.list(panelId);
        let legacy: SubRecord[] = [];
        try {
          const text = await api.fs.read('.ensoul/state/subagents.json');
          legacy = text ? (JSON.parse(text).list || []).filter((x: SubRecord) => x.panelId === panelId) : [];
        } catch { /* 旧记录可能不存在 */ }
        if (!alive) return;
        const list: SubRecord[] = records.map((task) => ({
          id: task.id, taskId: task.id, title: task.title, status: task.status,
          targetPanelId: task.panelId, accepted: Boolean(task.acceptance),
          canAccept: task.originPanelId === panelId && task.status === 'completed' && !task.acceptance,
          tokens: task.tokens === undefined ? '' : `${task.tokens} tok`,
          duration: task.startedAt && task.endedAt ? `${((task.endedAt - task.startedAt) / 1000).toFixed(1)}秒` : '',
          summary: (task.error || task.result || '').slice(0, 500),
        }));
        setItems([...list, ...legacy].slice(0, 100));
      } catch {
        if (alive) setItems([]);
      }
    };
    load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = api.tasks.onChanged(() => { clearTimeout(timer); timer = setTimeout(load, 100); });
    return () => {
      alive = false;
      clearTimeout(timer);
      off();
    };
  }, [panelId]);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', down);
    return () => window.removeEventListener('mousedown', down);
  }, [open]);

  if (items.length === 0) return null;

  return (
    <div
      ref={popRef}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        marginLeft: '12px',
        zIndex: 50,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '5px',
          background: open ? 'var(--tint-b)' : 'var(--tint-a)',
          border: '1px solid var(--line-soft)',
          color: open ? 'var(--text)' : 'var(--dim)',
          fontSize: '12px',
          padding: '2px 8px',
          borderRadius: '5px',
          cursor: 'pointer',
          outline: 'none',
          transition: 'all 0.15s',
        }}
        onClick={() => setOpen((v) => !v)}
        title={t('查看任务状态与会话')}
      >
        <span>{t('{n} 个任务', { n: items.length })}</span>
        <span
          style={{
            fontSize: '9px',
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.15s',
          }}
        >
          ▾
        </span>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            width: '320px',
            maxHeight: '380px',
            overflowY: 'auto',
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: '8px',
            boxShadow: 'var(--shadow)',
            padding: '4px',
            zIndex: 9999,
          }}
        >
          {items.map((sub) => (
            <div
              key={sub.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 10px',
                borderRadius: '6px',
                cursor: 'pointer',
                transition: 'background 0.12s',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--tint-b)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              onClick={async () => {
                setOpen(false);
                // 1. 如果已有关联的分身面板，直接 openFloat 唤起悬浮窗
                if (sub.targetPanelId) {
                  void (api.panel as any).openFloat(sub.targetPanelId, { width: 560, height: 640 });
                  return;
                }
              }}
            >
              <div style={{ flex: 1, minWidth: 0, marginRight: '8px' }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '3px',
                  }}
                >
                  <span
                    style={{
                      fontSize: '12px',
                      fontWeight: 500,
                      color: 'var(--text)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {sub.title}
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--faint)' }}>
                    {sub.targetPanelId ? sub.tokens || t('用量未记录') : t('旧记录未验证')}
                  </span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: '11px',
                    color: 'var(--dim)',
                  }}
                >
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: '180px',
                    }}
                  >
                    {!sub.targetPanelId ? t('无执行会话') : sub.accepted ? t('验收通过') : ({ queued: t('已入队'), running: t('执行中'), cancelling: t('正在停止'), cancelled: t('已取消'), stopped: t('已停止'), completed: t('会话结束 · 待验收'), failed: t('失败'), interrupted: t('执行中断') } as Record<string, string>)[sub.status] || sub.status}
                    {sub.summary ? ` · ${sub.summary}` : ''}
                  </span>
                  <span style={{ color: 'var(--faint)' }}>{sub.duration}</span>
                </div>
                {sub.taskId && <div style={{ marginTop: 4, display: 'flex', gap: 6 }} onClick={(event) => event.stopPropagation()}>
                  {['queued', 'running'].includes(sub.status) && <button onClick={async () => {
                    try {
                      const result = await api.tasks.cancel(sub.taskId!, panelId);
                      setNotice(result.ok ? '' : result.error || t('取消失败'));
                    } catch (error) { setNotice(String(error)); }
                  }}>{t('取消任务')}</button>}
                  {sub.canAccept && <button onClick={async () => {
                    try {
                      const result = await api.tasks.accept(sub.taskId!, panelId);
                      setNotice(result.ok ? '' : result.error || t('验收未确认'));
                    } catch (error) { setNotice(String(error)); }
                  }}>{t('确认验收')}</button>}
                </div>}
              </div>
              <span style={{ color: 'var(--faint)', fontSize: '13px' }}>›</span>
            </div>
          ))}
          {notice && <div style={{ padding: 8, color: 'var(--dim)', fontSize: 12 }}>{notice}</div>}
        </div>
      )}
    </div>
  );
}
