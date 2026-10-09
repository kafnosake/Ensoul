import React from 'react';
import type { PanelFaceProps } from '../../src/shared/types';

/**
 * 调度中心 —— **员工编制管理台**（dispatch 插件的脸）。
 *
 * 按网页后台那套：左边组织树（部门 → 员工），点开谁，右边就是他的一张**角色卡**。
 * 三件事，别的都不管：部门、员工、角色卡（简介/能力范围/特长/固定模型/专属提示词）。
 *
 * 刻意**不做**的：
 *   · 不摆在勤状态 —— 这不是真的公司，没人需要盯"他忙不忙"。
 *   · 不做派活 —— 派活是对话里 dispatch 工具的事，搬进界面只会多一层空壳。
 *   · 不打一堆按钮 —— 就两个：保存、移除。
 *
 *   读 `.ensoul/state/dispatch.board.json`  —— 插件算好的组织树 + 员工卡 + 可选模型
 *   写 `.ensoul/state/dispatch.cmd.json`    —— 点一下塞一条命令（带 panelId、认 seq）
 * 回执写在看板的 feed 里，插件**绝不 api.send 进对话**（那会唤醒模型跑一整轮）。
 */

interface Card {
  id: string;
  name: string;
  dept: string;
  role: 'manager' | 'member';
  avatar: string;
  intro: string;
  skills: string[];
  strength: string;
  model: string;
  prompt: string;
  /** 生效的工具套件组（可多个，来自 dispatch.kits.json 那张表）。空 = 按岗位自动推 */
  kits?: string[];
  /** true = 本人一个都没勾，这份是按岗位推出来的 */
  kitAuto?: boolean;
  /** 这个岗位实际拿到的工具名单（看板算好的，面板只画不判） */
  tools?: string[];
  /** 他自己申请到、**还没生效**的套件组 —— 下一次开工（新会话或压缩后）才发给他 */
  pendingKits?: string[];
  hasPanel: boolean;
  /** 完成的工作 —— 确认有效的成功案例（存他工作区 work/名字/成功案例.json：只有做了什么+实现路径，没有上下文） */
  cases: { at: number; work: string; how: string }[];
  /** 学会的工作流 —— 跑通一条存一条（他自己的 learn 工具存的）：专属，可在这复制给别人 */
  learned?: { name: string; how: string; at: number }[];
  /** 调度中心合成好的总提示词（基础+部门简介+部门提示词+简介+职位提示词）—— 右栏预览用 */
  composed?: string;
}
interface Dept {
  name: string;
  /** 挂在哪家公司（名册里的 company id） */
  company: string;
  intro: string;
  prompt: string;
  manager: Card | null;
  members: Card[];
}
/** 公司：名册里只有 id+名，简介与基础提示词从它自己的文件读（看板已合成好） */
interface Co {
  id: string;
  name: string;
  intro: string;
  base: string;
  count: number;
}
interface Board {
  at: number;
  /** 基础提示词（旧的全局那份）—— 只作新公司的出厂默认值 */
  base: string;
  baseLen: number;
  companies: Co[];
  depts: Dept[];
  models: { pick: string; label: string }[];
  /** 可选的工具套件组 —— 面板画下拉用（含每组到底给了哪些工具） */
  kits: { key: string; label: string; when: string; tools: string[] }[];
  feed: { at: number; text: string; ok: boolean }[];
  /** 「这一下要打开谁」（设置里点「在调度中心中查看」时写进来的）—— 认过就回 clearFocus 销掉 */
  focus?: { id: string; at: number } | null;
}

const BOARD = '.ensoul/state/dispatch.board.json';
const CMD = '.ensoul/state/dispatch.cmd.json';

function parse(data: unknown): Board | null {
  if (!data || typeof data !== 'object') return null;
  const j = data as Partial<Board>;
  if (!Array.isArray(j.depts)) return null;
  if (!Array.isArray(j.kits)) j.kits = [];
  if (!Array.isArray(j.companies)) j.companies = [];
  return j as Board;
}

/**
 * 看板的**业务指纹** —— 故意不含 at，跟主进程 boardSig 一套判断。
 *
 * 插件那一跳就算内容一个字没动，重算出来的 at 也是新值：整份 JSON 一比就是"变了"，
 * 于是每 1.5 秒 setBoard 一次、整棵树重渲染 —— 下拉框正被销毁重建，
 * 展开与选中自然保不住。比业务内容，只有它真变了才值得重画。
 */
const coreSig = (b: Board | null | undefined): string =>
  b ? JSON.stringify([b.base, b.baseLen, b.companies, b.depts, b.models, b.kits, b.feed, b.focus]) : '';

const hue = (name: string) => {
  let h = 11;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
};
const avatarBg = (name: string) => `hsl(${hue(name)} 46% 52%)`;
const initials = (name: string) => (String(name || '?').trim().slice(0, 1) || '?');

/** 命令排队：两次点击落在同一跳里也不会丢前一条（跟组件库同一套） */
let chain: Promise<unknown> = Promise.resolve();
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
 * 上一次挂载读到的看板 + 折叠状态 —— **模块级内存，按 panel.id 分槽**。
 *
 * 标签组切面板是 `key={active.id}`（见 DockTree.tsx）：换一个标签 = 旧组件卸载、新组件挂载。
 * 而 board 住在 useState(undefined) 里，重挂的第一帧只能渲染「正在读编制…」空壳，
 * 要等一次异步 fs.read 回来（下一跳，最快也是一个 IPC 往返）才铺开组织树 —— 这是闪的第一下；
 * 折叠状态又是 `[]` 初值，铺开时先全折一帧再展开 —— 这是闪的第二下。
 *
 * 做法照 `src/renderer/panel/chat/drafts.ts`：切标签能接上靠的就是**同步**内存，
 * 不能等主进程把文件读回来（那是异步的，重挂时可能还没到）。
 * 这里只存"下一次挂载的初值"，真相仍在 `dispatch.board.json`（插件写、1.5s 一跳地读回来），
 * 所以这一份**不落盘**，也不会跟看板打架。
 *
 * 按 panel.id 分槽 —— 每块调度中心面板各存各的，不互相串味。
 */
interface Memo {
  board: Board;
  openCos: string[];
  openDepts: string[];
}
const memo = new Map<string, Memo>();

/**
 * 中间那一栏当前是哪张页面 —— **同一时刻只可能是其中一张**。
 * 以前是 pick / adding / attaching / orgSel 四五个开关各管各的，互相不清场：
 * 点了「加员工」再点人，NewAgent 还开着；取消了又露出底下那层 —— 就是用户看到的"页面互相覆盖、叠在一起"。
 * 现在合成一个 state：互斥是**结构上**保证的，别的页面不存在。
 */
type View =
  | { kind: 'company'; id: string } // 公司页：名字 / 简介 / 基础提示词 + 新建部门
  | { kind: 'dept'; name: string } // 部门页：简介 / 提示词（新建/挂载的入口在树的行右侧 ＋ ⧉）
  | { kind: 'emp'; id: string; from: string } // 员工卡；from = 在哪个部门点开的（兼职的人从那摘出）
  | { kind: 'new'; dept: string }; // 新建员工（挂在哪；取消就退回那个部门页）

export default function DispatchPanel({ panel, fs }: PanelFaceProps) {
  /**
   * 初值**同步**取模块级缓存：这块面板上次挂载时读到的看板还留着，
   * 切走再切回来第一帧就是完整组织树，不再是「正在读编制…」空壳。
   * 只有本次运行第一次进来（没缓存）才落回 undefined，等下面那一跳读盘。
   */
  const memoed = memo.get(panel.id);
  const [board, setBoard] = React.useState<Board | null | undefined>(memoed ? memoed.board : undefined);
  /**
   * 上一次**成功解析**的那份看板 + 一句可见提示。
   *
   * 快照读坏（太大 / 正写到一半 / 被人手改坏）时：**留着上一份**，绝不 setBoard(null) ——
   * null 渲染出来就是一片空白，而真相是文件还在、员工一个没丢。提示要说清是哪一种坏法，
   * 否则用户只能猜"是不是人没了"。
   */
  const lastGood = React.useRef<Board | null>(memoed ? memoed.board : null);
  /** 上一次**真正画上去**的那份看板的业务指纹 —— 只有它变了才 setBoard（at 单独跳不算） */
  const lastSig = React.useRef<string>(coreSig(memoed ? memoed.board : null));
  const [snapBad, setSnapBad] = React.useState('');
  const [view, setView] = React.useState<View | null>(null);
  /** 挂现有员工的**弹窗**：挂在哪个部门（null = 关着）。不进 view —— 弹窗盖在部门页上，底下那页原样不动 */
  const [attachDept, setAttachDept] = React.useState<string | null>(null);
  /** 公司行右侧「＋」= 加子级：行下开一条内联输入（null = 关着）—— 加子级只发生在层级行上，不进角色卡 */
  const [addDeptCo, setAddDeptCo] = React.useState<string | null>(null);
  const [ndName, setNdName] = React.useState('');
  const [draft, setDraft] = React.useState<Card | null>(null); // 员工卡草稿（只在 view=emp 时有意义）
  const [note, setNote] = React.useState('');
  const [newCo, setNewCo] = React.useState('');
  /** 折叠状态：**各折各的**（数组）—— 点行只选中，箭头只管这一行的折叠，谁也不影响谁 */
  const [openCos, setOpenCos] = React.useState<string[]>(memoed ? memoed.openCos : []);
  const [openDepts, setOpenDepts] = React.useState<string[]>(memoed ? memoed.openDepts : []);
  /** 展开只在首次读到看板时初始化一次，之后完全归用户 —— 否则全折起来又被自动撑开（旧 bug） */
  /** 有缓存 = 这次是重挂，折叠状态已经从缓存恢复，不必再"初始化展开一次" */
  const inited = React.useRef(!!memoed);
  const seq = React.useRef(0);

  React.useEffect(() => {
    let alive = true;
    const tick = async () => {
      let snapshot;
      try {
        snapshot = await fs.readJson(BOARD);
      } catch (error) {
        if (alive) setSnapBad(t('快照读取失败：') + String(error));
        return;
      }
      if (!alive) return;
      if (snapshot.status === 'missing') {
        setSnapBad('');
        return;
      }
      if (snapshot.status !== 'ready') {
        setSnapBad(snapshot.status === 'too_large'
          ? `${BOARD}：${Math.round(snapshot.bytes / 1024)} KB > ${Math.round(snapshot.limit / 1024)} KB`
          : `${BOARD}：${snapshot.error}`);
        return;
      }
      const next = parse(snapshot.data);
      if (!next) {
        setSnapBad(
          t('快照格式不正确：') + BOARD +
            (lastGood.current ? t(' —— 下面是上一次读到的那份，员工一个没丢。') : '。'),
        );
        return;
      }
      setSnapBad('');
      /**
       * 模型清单兜底：这一跳读到的 models 是空的，而上一份有 —— 那是读坏了
       * （providers.json 正被某个插件/主进程写），空会把角色卡的模型下拉直接抽干。
       * 沿用上一份，等下一跳自己读回来；真把提供方删光了，插件那边的 lastValidModels 也会跟上。
       */
      const prev = lastGood.current;
      const held =
        prev && prev.models && prev.models.length && (!Array.isArray(next.models) || !next.models.length)
          ? { ...next, models: prev.models }
          : next;
      lastGood.current = held;
      /** 业务内容没变（只有 at 在跳）—— 不 setBoard：不重渲染，下拉框就不会被销毁重建 */
      const sig = coreSig(held);
      if (sig === lastSig.current) return;
      lastSig.current = sig;
      setBoard(held);
    };
    void tick();
    const timer = setInterval(() => void tick(), 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [panel.id]);

  const depts = board?.depts ?? [];
  const companies = board?.companies ?? [];
  // 首次读到看板时全部展开一次，之后**折叠完全由箭头管**（不许再有"数量为 0 就自动撑开"那种回收逻辑）
  React.useLayoutEffect(() => {
    if (inited.current || !board) return;
    if (!board.companies.length && !board.depts.length) return; // 编制还是空的，等建出第一家再初始化
    inited.current = true;
    setOpenCos(board.companies.map((c) => c.id));
    setOpenDepts(board.depts.map((d) => d.name));
  }, [board]);

  /**
   * 看板 / 折叠状态一变就把最新的一份放回内存 —— 下次挂载（切标签回来）同步取到它。
   * 不落盘：真值在 dispatch.board.json，这一份只为"重挂第一帧"服务。
   */
  React.useLayoutEffect(() => {
    if (!board) return;
    memo.set(panel.id, { board, openCos, openDepts });
  }, [panel.id, board, openCos, openDepts]);

  /**
   * 设置那边的「在调度中心中查看」：那一页在别处，只能把"要看谁"写进看板。
   * 这里读到就把这个人翻出来，然后回一条 clearFocus —— 不销掉，下次切标签回来又会翻一遍。
   */
  const lastFocus = React.useRef(0);
  React.useEffect(() => {
    const f = board?.focus;
    if (!f || !f.id || !(Number(f.at) > lastFocus.current)) return;
    lastFocus.current = Number(f.at);
    const hit = depts
      .map((d) => ({ from: d.name, card: [d.manager, ...d.members].filter(Boolean).find((c) => (c as Card).id === f.id) }))
      .find((x) => x.card);
    if (hit && hit.card) {
      setDraft(JSON.parse(JSON.stringify(hit.card)));
      setView({ kind: 'emp', id: f.id, from: hit.from });
      setNote('');
    }
    seq.current += 1;
    void enqueue(fs, { seq: Date.now() * 1000 + (seq.current % 1000), panelId: panel.id, cmd: 'clearFocus' });
  }, [board?.focus?.at]);

  const noteTimer = React.useRef<any>(null);
  const send = (patch: Record<string, unknown>, text: string) => {
    seq.current += 1;
    void enqueue(fs, { seq: Date.now() * 1000 + (seq.current % 1000), panelId: panel.id, ...patch });
    setNote(text);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(''), 4000);
  };

  /** 点开一个人：把他的卡拷进草稿（之后改的是草稿，保存才写回去）。from = 他在树上的哪个部门下 */
  const open = (c: Card, from: string) => {
    setDraft(JSON.parse(JSON.stringify(c)));
    setView({ kind: 'emp', id: c.id, from });
    setNote('');
  };
  /** 新建 / 挂载的取消与完成都退回**进来时那个部门页** —— 不会露出生疏的"下一层页面" */
  const backToDept = (name: string) => setView({ kind: 'dept', name });
  /** 公司行「＋」建部门：回车/点「建」即走，连经理一起建出来（插件那边 done），建完内联输入收起 */
  const createDept = (coId: string) => {
    const n = ndName.trim();
    if (!n) return;
    send({ cmd: 'addDept', name: n, company: coId }, `建部门「${n}」，同时把经理建出来…`);
    setNdName('');
    setAddDeptCo(null);
  };

  // 回执 / 提示展示逻辑：
  // 1. lastFeed 增加过期机制（8 秒内才算新鲜回执，超时不再显示）
  // 2. 本地操作触发的 note 具有最高优先级；无本地操作时才展示后台回执
  const rawFeed = board?.feed?.length ? board.feed[board.feed.length - 1] : null;
  const lastFeed = rawFeed && (Date.now() - (Number(rawFeed.at) || 0) < 8000) ? rawFeed : null;
  const activeText = note || (lastFeed ? lastFeed.text : '');
  const isBad = !note && lastFeed ? lastFeed.ok === false : false;

  if (board === undefined) {
    return (
      <div className="dp">
        <div className="dp-top">
          <div className="dp-me">{panel.title || t('调度中心')}</div>
          <div className="dp-stats">{t('正在读编制…')}</div>
          {/* 连一份好的都还没读到过 —— 也得说清是"读不出来"，不是"编制空了" */}
          {snapBad ? <div className="dp-note bad">{snapBad}</div> : null}
        </div>
      </div>
    );
  }

  const total = depts.reduce((n, d) => n + d.members.length + (d.manager ? 1 : 0), 0);
  const sel = draft;
  // view → 中间那张页面的原料（公司/部门被删了就落到提示页）
  const coSel = view?.kind === 'company' ? companies.find((c) => c.id === view.id) ?? null : null;
  const deptObj = view?.kind === 'dept' ? depts.find((d) => d.name === view.name) ?? null : null;
  // 挂现有员工弹窗的目标部门（null = 关着）；分层名单由 AttachModal 按 公司→部门→人 自己算
  const attachTo = attachDept ? depts.find((d) => d.name === attachDept) ?? null : null;

  return (
    <div className="dp">
      <div className="dp-top">
        <div className="dp-me">{panel.title || t('调度中心')}</div>
        <div className="dp-stats">
          {t('{c} 家公司 · {d} 个部门 · {n} 名员工 · 一人一张角色卡', { c: companies.length, d: depts.length, n: total })}
        </div>
        {activeText ? (
          <div className={`dp-note${isBad ? ' bad' : ''}`}>
            {activeText}
          </div>
        ) : null}
        {/* 快照读坏了 —— 必须说出来：不说的话，界面看着就是"编制空了" */}
        {snapBad ? <div className="dp-note bad">{snapBad}</div> : null}
      </div>

      {/* 挂现有员工 = **弹窗**：盖在整个面板上，底下的部门页原样不动（不是换页） */}
      {attachTo ? (
        <AttachModal
          companies={companies}
          depts={depts}
          target={attachTo}
          onCancel={() => setAttachDept(null)}
          onPick={(c) => {
            send({ cmd: 'attachAgent', dept: attachTo.name, emp: c.id }, `正在把「${c.name}」挂进「${attachTo.name}」…`);
            setAttachDept(null);
          }}
        />
      ) : null}

      <div className="dp-body">
        {/* ------------------------------------------------ 左：组织树 */}
        <div className="dp-tree">
          {companies.map((co) => {
            const coOpen = openCos.includes(co.id);
            const myDepts = depts.filter((d) => d.company === co.id);
            return (
              <React.Fragment key={co.id}>
                {/* ── 公司行：点行 = 选中（并确保自己是展开的，别家折叠不动它）；折叠只归箭头管 ── */}
                <div
                  className={`dp-dept-row${view?.kind === 'company' && view.id === co.id ? ' on' : ''}`}
                  onClick={() => {
                    setView({ kind: 'company', id: co.id });
                    setDraft(null);
                    setNote('');
                    setOpenCos((s) => (s.includes(co.id) ? s : [...s, co.id]));
                  }}
                >
                  <span
                    className={`dp-caret${coOpen ? ' open' : ''}`}
                    title={coOpen ? t('折叠') : t('展开')}
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenCos((s) => (coOpen ? s.filter((x) => x !== co.id) : [...s, co.id]));
                    }}
                  >
                    <i />
                  </span>
                  ◆ {co.name}
                  {/* 行右侧「＋」= 在这家公司下加部门（加子级只在这儿，不进角色卡）。行内计数按要求去掉了 */}
                  <span className="dp-row-actions">
                    <span
                      className="dp-row-add"
                      title={t('在这家公司下加部门')}
                      onClick={(e) => {
                        e.stopPropagation();
                        setAddDeptCo((v) => (v === co.id ? null : co.id));
                        setNdName('');
                        setOpenCos((s) => (s.includes(co.id) ? s : [...s, co.id]));
                      }}
                    >
                      ＋
                    </span>
                  </span>
                </div>
                {/* 公司行下面的内联输入：回车 / 点「建」即建；Esc、失焦留空则收起 */}
                {addDeptCo === co.id ? (
                  <div className="dp-addrow dp-addrow-in">
                    <input
                      autoFocus
                      value={ndName}
                      placeholder={t('部门名，如「音乐组」')}
                      onChange={(e) => setNdName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') createDept(co.id);
                        if (e.key === 'Escape') setAddDeptCo(null);
                      }}
                      onBlur={() => {
                        if (!ndName.trim()) setAddDeptCo(null);
                      }}
                    />
                    <button className="dp-mini" disabled={!ndName.trim()} onClick={() => createDept(co.id)}>
                      {t('建')}
                    </button>
                  </div>
                ) : null}

                {coOpen
                  ? myDepts.map((d) => {
                      const opened = openDepts.includes(d.name);
                      return (
                        <React.Fragment key={d.name}>
                          {/* ── 部门行：点行 = 选中；箭头只折叠**这一行**，不联动别人 ── */}
                          <div
                            className={`dp-dept-row dp-dept2${view?.kind === 'dept' && view.name === d.name ? ' on' : ''}`}
                            onClick={() => {
                              setView({ kind: 'dept', name: d.name });
                              setDraft(null);
                              setNote('');
                              setOpenDepts((s) => (s.includes(d.name) ? s : [...s, d.name]));
                            }}
                          >
                            <span
                              className={`dp-caret${opened ? ' open' : ''}`}
                              title={opened ? t('折叠') : t('展开')}
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenDepts((s) => (opened ? s.filter((x) => x !== d.name) : [...s, d.name]));
                              }}
                            >
                              <i />
                            </span>
                            {d.name}
                            {/* 行右侧：＋ 新建员工（换页）、⧉ 挂现有员工（弹窗）—— 加子级只在层级行上；计数去掉了 */}
                            <span className="dp-row-actions">
                              <span
                                className="dp-row-add"
                                title={t('在这个部门新建员工')}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setOpenDepts((s) => (s.includes(d.name) ? s : [...s, d.name]));
                                  setDraft(null);
                                  setView({ kind: 'new', dept: d.name });
                                }}
                              >
                                ＋
                              </span>
                              <span
                                className="dp-row-add"
                                title={t('挂现有员工（弹窗）')}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setAttachDept(d.name);
                                }}
                              >
                                ⧉
                              </span>
                            </span>
                          </div>
                          {opened
                            ? [d.manager, ...d.members].filter(Boolean).map((c) => (
                                <EmpRow
                                  key={(c as Card).id}
                                  c={c as Card}
                                  on={view?.kind === 'emp' && view.id === (c as Card).id}
                                  onClick={() => open(c as Card, d.name)}
                                />
                              ))
                            : null}
                          {opened && !d.manager ? (
                            <div className="dp-empt">
                              {t('这个部门还没有经理 —— 经理得有模型才派得动活。')}
                              <button className="dp-mini" onClick={() => send({ cmd: 'fixManager', dept: d.name }, `正给「${d.name}」补经理…`)}>
                                {t('补一个')}
                              </button>
                            </div>
                          ) : null}
                        </React.Fragment>
                      );
                    })
                  : null}
              </React.Fragment>
            );
          })}

          {/* 加公司 —— 编制树的根，一家公司 = 一套自己的基础提示词 */}
          <div className="dp-newdept">
            <input
              value={newCo}
              placeholder={t('新公司名，如「星海互动」')}
              onChange={(e) => setNewCo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newCo.trim()) {
                  send({ cmd: 'addCo', name: newCo.trim() }, `建公司「${newCo.trim()}」…`);
                  setNewCo('');
                }
              }}
            />
            <button
              disabled={!newCo.trim()}
              onClick={() => {
                send({ cmd: 'addCo', name: newCo.trim() }, `建公司「${newCo.trim()}」…`);
                setNewCo('');
              }}
            >
              {t('加公司')}
            </button>
          </div>
        </div>

        {/* ------------------------------------------------ 中：当前页面（同时只有一张） */}
        <div className="dp-card">
          {!companies.length ? (
            <div className="dp-empty">
              {t('编制还是空的。先在左栏建一家公司 —— 再往里加部门，部门会**连经理一起建出来**。')}
            </div>
          ) : view?.kind === 'new' ? (
            <NewAgent
              dept={view.dept}
              models={board.models}
              onCancel={() => backToDept(view.dept)}
              onSave={(c) => {
                send(
                  {
                    cmd: 'addAgent',
                    dept: view.dept,
                    name: c.name,
                    intro: c.intro,
                    skills: c.skills.join('，'),
                    strength: c.strength,
                    model: c.model,
                    prompt: c.prompt,
                    avatar: c.avatar,
                  },
                  t('正在为「{name}」建角色卡…', { name: c.name }),
                );
                backToDept(view.dept);
              }}
            />
          ) : coSel ? (
            <CompanyEditor
              key={`co:${coSel.id}:${coSel.base.length}:${coSel.intro.length}:${coSel.name.length}`}
              co={coSel}
              onSave={(name, intro, base) =>
                send({ cmd: 'saveCo', id: coSel.id, name, intro, base }, `正在保存「${name}」的公司提示词…`)
              }
            />
          ) : deptObj ? (
            <DeptEditor
              key={`d:${deptObj.name}:${deptObj.intro.length}:${deptObj.prompt.length}`}
              name={deptObj.name}
              intro={deptObj.intro}
              prompt={deptObj.prompt}
              onSave={(i, p) => send({ cmd: 'saveDept', name: deptObj.name, company: deptObj.company, intro: i, prompt: p }, `正在保存「${deptObj.name}」的部门提示词…`)}
            />
          ) : sel && view?.kind === 'emp' ? (
            <CardEditor
              key={sel.id}
              kits={board.kits}
              card={sel}
              models={board.models}
              people={depts.flatMap((d) => [d.manager, ...d.members]).filter(Boolean) as Card[]}
              onCopy={(from, to, name) =>
                send({ cmd: 'copySkill', from, to, name }, `正在把「${name}」复制过去…`)
              }
              onChange={setDraft}
              onDetach={
                // 在 A 部门点开一个主部门不是 A 的人 → 出「从本部门摘出」；摘完退回 A 部门页
                view.from !== sel.dept
                  ? () => {
                      send({ cmd: 'detachAgent', dept: view.from, emp: sel.id }, `正在把「${sel.name}」从「${view.from}」摘出…`);
                      setDraft(null);
                      backToDept(view.from);
                    }
                  : undefined
              }
              onSave={() =>
                send(
                  {
                    cmd: 'saveCard',
                    id: sel.id,
                    name: sel.name,
                    intro: sel.intro,
                    skills: sel.skills.join('，'),
                    strength: sel.strength,
                    model: sel.model,
                    prompt: sel.prompt,
                    avatar: sel.avatar,
                    kits: sel.kits || [],
                  },
                  t('已保存「{name}」的角色卡…', { name: sel.name }),
                )
              }
              onRemove={() => {
                if (window.confirm(`把「${sel.name}」移出编制？（角色卡会删掉，他那块面板还开着）`)) {
                  send({ cmd: 'removeAgent', id: sel.id }, `正在移除「${sel.name}」…`);
                  setDraft(null);
                  backToDept(view.from);
                }
              }}
              onOpenPanel={() => send({ cmd: 'openPanel', id: sel.id }, `正在给「${sel.name}」开工作面…`)}
            />
          ) : (
            <div className="dp-empty">
              {t('左边点公司改它的名字/简介/基础提示词、点部门改部门简介/提示词、点一个人改他的卡 —— 右边始终是他最终收到的总提示词。')}
              <br />
              <br />
              {board.models.length ? '' : t('（提示：模型清单是空的，先去设置里配一个提供方，角色卡才能指定模型。）')}
            </div>
          )}
        </div>

        {/* 右：总提示词（只读预览 —— 定义在左栏和中间） */}
        <PromptPane
          key={sel?.id || 'none'}
          card={sel}
          board={board}
        />
      </div>
    </div>
  );
}

/**
 * 左栏「公司」节点的编辑器：公司名 + 公司简介 + **本公司的基础提示词**。
 * 一家公司一套，别家公司不受影响（新公司出厂默认接的是旧的全局那份）。
 */
function CompanyEditor({ co, onSave }: { co: Co; onSave(name: string, intro: string, base: string): void }) {
  const [name, setName] = React.useState(co.name);
  const [intro, setIntro] = React.useState(co.intro);
  const [base, setBase] = React.useState(co.base);
  const dirty = name !== co.name || intro !== co.intro || base !== co.base;
  // 卸载即带走：树上点别处这页就消失 —— 没存的字不许凭空丢（公司名留空则不带走，避免存进空名）
  const latest = React.useRef({ name, intro, base, dirty });
  latest.current = { name, intro, base, dirty };
  React.useEffect(() => {
    return () => {
      const l = latest.current;
      if (l.dirty && l.name.trim()) onSave(l.name, l.intro, l.base);
    };
  }, []);
  return (
    <React.Fragment>
      <div className="dp-card-head">
        <div>
          <div className="dp-card-title">◆ {co.name}</div>
          <div className="dp-card-sub">
            公司 · {co.count} 个部门 —— 公司简介 {co.intro.length} 字 · 基础提示词 {co.base.length} 字
            {dirty ? t('（有未保存的改动）') : ''}
          </div>
        </div>
      </div>

      <div className="dp-field">
        <label>{t('公司名')}</label>
        <div className="dp-in">
          <input type="text" value={name} placeholder={t('这家公司叫什么')} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>

      <div className="dp-field">
        <label>{t('公司简介')}</label>
        <div className="dp-in">
          <textarea
            value={intro}
            placeholder={t('公司是干什么的、怎么运转（一两句话）')}
            onChange={(e) => setIntro(e.target.value)}
          />
          <div className="dp-help">{t('跟在基础提示词后面，全公司的人都吃这一段。')}</div>
        </div>
      </div>

      <div className="dp-field">
        <label>{t('基础提示词')}</label>
        <div className="dp-in">
          <textarea
            className="prompt"
            value={base}
            placeholder={t('全体员工的通用几条：怎么干活、不许虚报、排版……')}
            onChange={(e) => setBase(e.target.value)}
          />
          <div className="dp-help">{t('只写全员共用的；部门的事写在部门、岗位的事写在卡上 —— 各段不重复。')}</div>
        </div>
      </div>

      <div className="dp-card-foot">
        <button className="dp-primary" disabled={!dirty} onClick={() => onSave(name.trim() || co.name, intro, base)}>
          {t('保存（本公司重算）')}
        </button>
        <span className="dp-foot-note">{t('保存后这家公司每名员工的合成提示词立即重算；别家公司不动。')}</span>
      </div>
    </React.Fragment>
  );
}

/**
 * 左栏部门节点的编辑器：部门简介 + 部门提示词。
 * 经理合成时只吃简介（挑人派活，不掌握本组工具），员工两段都吃。
 */
function DeptEditor({
  name,
  intro,
  prompt,
  onSave,
}: {
  name: string;
  intro: string;
  prompt: string;
  onSave(intro: string, prompt: string): void;
}) {
  const [i, setI] = React.useState(intro);
  const [p, setP] = React.useState(prompt);
  const dirty = i !== intro || p !== prompt;
  // 卸载即带走：树上点 ＋ 新建、点别处，这页都会消失 —— 敲了半天的字不许凭空丢
  const latest = React.useRef({ i, p, dirty });
  latest.current = { i, p, dirty };
  React.useEffect(() => {
    return () => {
      if (latest.current.dirty) onSave(latest.current.i, latest.current.p);
    };
  }, []);
  return (
    <React.Fragment>
      <div className="dp-card-head">
        <div>
          <div className="dp-card-title">{name} · 部门提示词</div>
          <div className="dp-card-sub">{t('本部门合成时的第二、三段 —— 简介')}{intro.length} 字 · 提示词 {prompt.length} 字</div>
        </div>
      </div>
      <div className="dp-field">
        <label>{t('部门简介')}</label>
        <div className="dp-in">
          <textarea
            value={i}
            placeholder={t('这个组怎么运转、用什么工作流（如：出图走无限画布 + ComfyUI 接口）')}
            onChange={(e) => setI(e.target.value)}
          />
          <div className="dp-help">{t('经理和员工都吃这一段。')}</div>
        </div>
      </div>
      <div className="dp-field">
        <label>{t('部门提示词')}</label>
        <div className="dp-in">
          <textarea
            value={p}
            placeholder={t('本组干活用哪些工具插件、怎么配合（没有就不填）')}
            onChange={(e) => setP(e.target.value)}
          />
          <div className="dp-help">{t('只发给员工 —— 经理挑人派活，不吃这段。')}</div>
        </div>
      </div>
      <div className="dp-card-foot">
        <button className="dp-primary" disabled={!dirty} onClick={() => onSave(i, p)}>
          {t('保存（本部门重算）')}
        </button>
        <span className="dp-foot-note">{t('新建 / 挂载在左边部门行右侧的 ＋ ⧉；保存后本部门每人的合成提示词立即重算。')}</span>
      </div>
    </React.Fragment>
  );
}

/**
 * 右栏：这个人**最终收到的**总提示词 —— **只预览，不在这儿定义**。
 * 定义入口在左栏：公司行改基础提示词、部门行改部门简介/提示词、中间角色卡改简介/职位提示词。
 * 合成在插件主进程做（composePrompt），脸只管展示，两边不重复实现。
 */
function PromptPane({ card, board }: { card: Card | null; board: Board }) {
  // 预览要拿**看板上最新那份**（card 是打开时拷的草稿，存完不会自己刷新）
  const fresh = card
    ? (board.depts.flatMap((d) => [d.manager, ...d.members]).find((c) => c && c.id === card.id) ?? null)
    : null;
  const composed = fresh?.composed || '';

  return (
    <div className="dp-prompt">
      <div className="dp-pt-head">
        总提示词 {composed ? <span className="dp-pt-count">{composed.length} 字</span> : null}
      </div>

      <div className="dp-pt-sec grow">
        <div className="dp-pt-label">{t('合成结果（他实际收到的）')}</div>
        <pre className="dp-pt-prev">
          {card
            ? composed || t('（还没合成 —— 保存任意一段就会生成）')
            : t('左边点一个员工，这里显示他最终收到的总提示词。')}
        </pre>
        <div className="dp-help">
          {t('固定顺序：基础提示词 → 姓名 → 简介 → 隶属公司 → 部门 → 职能（职位提示词）——')}
          {t('改公司 / 部门 / 角色卡上任意一段，这里自动重算。')}
        </div>
      </div>
    </div>
  );
}

/** 组织树里的一行：头像 + 名字（经理挂个标签），头像是上传过的就显示图 */function EmpRow({ c, on, onClick }: { c: Card; on: boolean; onClick(): void }) {
  return (
    <div className={`dp-emp${on ? ' on' : ''}`} onClick={onClick}>
      {c.avatar ? (
        <img className="dp-av" src={c.avatar} alt="" />
      ) : (
        <span className="dp-av" style={{ background: avatarBg(c.name) }}>
          {initials(c.name)}
        </span>
      )}
      <span className="dp-emp-name">{c.name}</span>
      {c.role === 'manager' ? <span className="dp-mgr-tag">{t('经理')}</span> : null}
      {!c.model || !c.hasPanel ? <span className="dp-warn" title={!c.model ? t('还没指定模型') : t('还没开工作面')} /> : null}
    </div>
  );
}

/**
 * 挂现有员工 —— **弹窗**（盖在部门页上，不是换一页）。
 * 里面按 公司 → 部门 → 人 分层（和左树同款），各折各的：进来全展开，点行折叠，Esc 取消。
 * 只列还没在目标部门的人；点名字就挂上 —— 不新建卡，他的提示词仍按主部门算。
 */
function AttachModal({
  companies,
  depts,
  target,
  onCancel,
  onPick,
}: {
  companies: Co[];
  depts: Dept[];
  target: Dept;
  onCancel(): void;
  onPick(c: Card): void;
}) {
  // 已在目标部门的人不列出来（本来就在，重挂没意义）
  const ids = new Set(([target.manager, ...target.members].filter(Boolean) as Card[]).map((c) => c.id));
  const people = (d: Dept) => [d.manager, ...d.members].filter(Boolean) as Card[];
  const can = (d: Dept) => people(d).filter((c) => !ids.has(c.id));
  /** 弹窗自己的折叠（数组、各折各的）—— 挂载时全展开，和左树互不干扰 */
  const [mCos, setMCos] = React.useState<string[]>(companies.map((c) => c.id));
  const [mDepts, setMDepts] = React.useState<string[]>(depts.map((d) => d.name));
  // Esc = 取消（弹窗惯例）
  React.useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onCancel]);

  const coDeptsOf = (coId: string) =>
    depts.filter((d) => d.company === coId && d.name !== target.name && can(d).length > 0);
  const total = companies.reduce((n, co) => n + coDeptsOf(co.id).reduce((m, d) => m + can(d).length, 0), 0);

  return (
    <div className="dp-modal-mask" onClick={onCancel}>
      {/* 点弹窗里面别冒泡到遮罩 —— 否则点人会顺手把弹窗关了 */}
      <div className="dp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="dp-card-head">
          <div>
            <div className="dp-card-title">{t('挂现有员工 →')}{target.name}</div>
            <div className="dp-card-sub">
              按公司分层 · 本部门已有 {ids.size} 人 · 可挂 {total} 人 —— 点名字就挂上，不新建卡，他的提示词按主部门算。
            </div>
          </div>
        </div>

        <div className="dp-modal-body">
          {total === 0 ? (
            <div className="dp-empty">{t('没有可挂的人 —— 编制里的人都已经在「')}{target.name}」了。</div>
          ) : (
            companies.map((co) => {
              const coDepts = coDeptsOf(co.id);
              const n = coDepts.reduce((m, d) => m + can(d).length, 0);
              const opened = mCos.includes(co.id);
              return (
                <React.Fragment key={co.id}>
                  {/* 公司行：整行点 = 折叠（弹窗里没有"选中"这回事） */}
                  <div
                    className="dp-dept-row"
                    style={n ? undefined : { opacity: 0.5 }}
                    onClick={() => setMCos((s) => (opened ? s.filter((x) => x !== co.id) : [...s, co.id]))}
                  >
                    <span className="dp-caret">{opened ? '▾' : '▸'}</span>
                    ◆ {co.name}
                    <span className="dp-dept-count">{n} 人可挂</span>
                  </div>
                  {opened
                    ? coDepts.map((d) => {
                        const dOpen = mDepts.includes(d.name);
                        return (
                          <React.Fragment key={d.name}>
                            <div
                              className="dp-dept-row dp-dept2"
                              onClick={() => setMDepts((s) => (dOpen ? s.filter((x) => x !== d.name) : [...s, d.name]))}
                            >
                              <span className="dp-caret">{dOpen ? '▾' : '▸'}</span>
                              {d.name}
                              <span className="dp-dept-count">{can(d).length} 人</span>
                            </div>
                            {dOpen
                              ? can(d).map((c) => (
                                  <div
                                    className="dp-emp"
                                    key={`${d.name}:${c.id}`}
                                    title={t('主部门在「{d}」—— 点一下挂进「{t}」', { d: c.dept, t: target.name })}
                                    onClick={() => onPick(c)}
                                  >
                                    {c.avatar ? (
                                      <img className="dp-av" src={c.avatar} alt="" />
                                    ) : (
                                      <span className="dp-av" style={{ background: avatarBg(c.name) }}>
                                        {initials(c.name)}
                                      </span>
                                    )}
                                    <span className="dp-emp-name">{c.name}</span>
                                    <span className="dp-mgr-tag">{d.name}</span>
                                  </div>
                                ))
                              : null}
                          </React.Fragment>
                        );
                      })
                    : null}
                </React.Fragment>
              );
            })
          )}
        </div>

        <div className="dp-card-foot">
          <button className="dp-danger" onClick={onCancel}>
            {t('取消（Esc）')}
          </button>
          <span className="dp-foot-note">{t('只把他记进本部门成员表 —— 卡、面板、提示词都不动。')}</span>
        </div>
      </div>
    </div>
  );
}

/** 角色卡编辑器 —— 就这一张表单，字段就是要求里那几样 */
function CardEditor({
  kits,
  card,
  models,
  people,
  onChange,
  onSave,
  onRemove,
  onOpenPanel,
  onCopy,
  onDetach,
}: {
  card: Card;
  models: { pick: string; label: string }[];
  /** 可选套件组 —— 面板画下拉用 */
  kits: { key: string; label: string; when: string; tools: string[] }[];
  people: Card[];
  onChange(c: Card): void;
  onSave(): void;
  onRemove(): void;
  onOpenPanel(): void;
  onCopy(fromId: string, toId: string, name: string): void;
  /** 兼职的人（主部门不是这儿）从当前部门摘出 —— 不给就是主部门的人，不出这颗按钮 */
  onDetach?(): void;
}) {
  const set = (patch: Partial<Card>) => onChange({ ...card, ...patch });
  // 勾选状态：看板已经把「自动推的那份」算进 card.kits 了，
  // 所以这里照抄就是**正在生效的**那份，不会出现"显示一套、生效另一套"。
  const chosen = Array.isArray(card.kits) ? card.kits : [];
  // 清单以看板算好的为准 —— 多选合并、去重都在插件那边做，这边只画不算
  const shown = card.tools || [];
  /** 他自己申请到、还没生效的那几组 —— 只标出来；勾选状态仍是"正在生效的"那份，两套说法不许混 */
  const pending = Array.isArray(card.pendingKits) ? card.pendingKits : [];
  /** 勾上 / 取消一组 —— 多选，重叠的工具由插件去重 */
  const toggle = (key: string) => {
    set({ kits: chosen.indexOf(key) >= 0 ? chosen.filter((k) => k !== key) : chosen.concat(key) });
  };
  /** 一个都没勾时标出"这一组是按岗位推的"，免得以为已经变成全给了 */
  const autoOne = card.kitAuto && chosen.length === 1 ? chosen[0] : '';
  const fileRef = React.useRef<HTMLInputElement>(null);

  /**
   * 这里**只挑图**：选完把 data URL 塞进草稿，命令交给插件，插件写盘时当场落成
   * .ensoul/state/avatars/<id>.png、卡上只留相对路径（见 dispatch/index.js 的 landAvatar）。
   * 卡里内联 base64 会把快照顶过 fs:read 的 300KB —— 那条路已经封死了。
   */
  const pickAvatar = (f: File | null) => {
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result || '');
      // 卡是 JSON，塞太大的图会把整张卡撑起来 —— 400KB 封顶（插件那边也会再挡一道）
      if (url.length > 400 * 1024) {
        window.alert(t('这张图太大了（超过 400KB）—— 换一张小点的，或者先压一下。'));
        return;
      }
      set({ avatar: url });
    };
    r.readAsDataURL(f);
  };

  return (
    <React.Fragment>
      <div className="dp-card-head">
        <div className="dp-avwrap" onClick={() => fileRef.current?.click()} title={t('点一下换头像')}>
          {card.avatar ? (
            <img className="dp-av big" src={card.avatar} alt="" />
          ) : (
            <span className="dp-av big" style={{ background: avatarBg(card.name) }}>
              {initials(card.name)}
            </span>
          )}
          <input ref={fileRef} type="file" accept="image/*" onChange={(e) => pickAvatar(e.target.files?.[0] ?? null)} />
        </div>
        <div>
          <div className="dp-card-title">
            {card.name || t('（没名字）')}
            {card.role === 'manager' ? <span className="dp-mgr-tag">{t('经理')}</span> : null}
          </div>
          <div className="dp-card-sub">
            主部门 {card.dept}
            {card.hasPanel ? t(' · 工作面已开') : t(' · 还没开工作面')}
            {card.tools && card.tools.length ? ` · 每轮固定发 ${card.tools.length} 个工具` : ''}
          </div>
        </div>
      </div>

      <div className="dp-field">
        <label>{t('姓名')}</label>
        <div className="dp-in">
          <input type="text" value={card.name} onChange={(e) => set({ name: e.target.value })} />
          <div className="dp-help">{t('路由认这个名字 —— 要唯一。改名会连他面板的标题一起改。')}</div>
        </div>
      </div>

      <div className="dp-field">
        <label>{t('简介')}</label>
        <div className="dp-in">
          <textarea value={card.intro} placeholder={t('这个人是干什么的，一句话')} onChange={(e) => set({ intro: e.target.value })} />
        </div>
      </div>

      <div className="dp-field">
        <label>{t('能力范围')}</label>
        <div className="dp-in">
          <input
            type="text"
            value={card.skills.join('，')}
            placeholder={t('逗号分隔：角色立绘，场景概念图，UI图标')}
            onChange={(e) => set({ skills: e.target.value.split(/[，,、]/).map((s) => s.trim()).filter(Boolean) })}
          />
          <div className="dp-help">{t('写能被需求直接命中的词 —— 派单和经理挑人都照它认。')}</div>
        </div>
      </div>

      {/* 特长只给员工 —— 经理挑人派活，这栏对他没意义（职位提示词经理照写，在下面） */}
      {card.role === 'manager' ? null : (
        <div className="dp-field">
          <label>{t('特长')}</label>
          <div className="dp-in">
            <input type="text" value={card.strength} placeholder={t('最拿手的那一手')} onChange={(e) => set({ strength: e.target.value })} />
          </div>
        </div>
      )}

      <div className="dp-field">
        <label>{t('固定模型')}</label>
        <div className="dp-in">
          <select value={card.model} onChange={(e) => set({ model: e.target.value })}>
            <option value="">{t('（没指定 —— 开不了工）')}</option>
            {models.map((m) => (
              <option key={m.pick} value={m.pick}>
                {m.label}
              </option>
            ))}
          </select>
          <div className="dp-help">
            {t('这个岗位**固定**用这只模型，会话区不给换 —— 模型是岗位的属性，不是每次随手挑的。')}
          </div>
        </div>
      </div>

      {/* 工具套件组：**这是每轮都要重发一遍的固定税** —— 一个人只该拿到他岗位真用得上的那几个。
          清单在轮与轮之间换（下一轮就生效），正在跑的那一轮不受影响。 */}
      <div className="dp-field">
        <label>{t('工具套件组（可多选）')}</label>
        <div className="dp-in">
                    {/* 勾几个就并几个，重叠的工具自动去掉 —— 多选，不是"选一个替换" */}
          <div className="dp-kits">
            {kits.map((k) => {
              const on = chosen.indexOf(k.key) >= 0;
              const wait = pending.indexOf(k.key) >= 0;
              return (
                <label
                  key={k.key}
                  className={'dp-kit' + (on ? ' on' : '') + (wait ? ' wait' : '')}
                  style={{ display: 'block', cursor: 'pointer', lineHeight: '1.8' }}
                >
                  <input type="checkbox" checked={on} onChange={() => toggle(k.key)} />{' '}
                  <b>{k.label}</b>
                  <span className="dp-n"> · {k.tools.indexOf('*') >= 0 ? '全部' : k.tools.length + ' 个'}</span>
                  <i className="dp-kit-when"> · {k.when}</i>
                  {wait ? <i className="dp-kit-when">{t('· 已申请，待生效')}</i> : null}
                </label>
              );
            })}
          </div>
          <div className="dp-help">
            {autoOne ? t('现在是按岗位自动推的 —— 勾一下任意一组，就把它固定下来。') : ''}
            {chosen.length ? '' : t('一个都没勾 = 按岗位自动推：经理给纯路由，成员按部门给。')}
          </div>
          <div className="dp-help">
            每轮固定发 {shown.length} 个：{shown.join('、') || t('（一个都没匹配上 → 退回全给）')}
          </div>
          {pending.length ? (
            <div className="dp-help">
              他自己申请到的 <b>{pending.length}</b>{t('组（')}{pending.join('、')}）还没生效 ——
              {t('下一次开工（新会话，或压缩过之后）才发给他。中途换工具表会废掉他面板的整段缓存，不值当。')}
            </div>
          ) : null}
        </div>
      </div>

      {/* 职位提示词：**经理也写** —— 挑人标准、派单写法、回执要求就是他的职位本身（saveCard 已放行） */}
      <div className="dp-field">
        <label>{t('职位提示词')}</label>
        <div className="dp-in">
          <textarea
            className="prompt"
            value={card.prompt}
            placeholder={t('他是谁、接什么活、不接什么、交付到哪……')}
            onChange={(e) => set({ prompt: e.target.value })}
          />
          <div className="dp-help">
            {t('只写他**自己**那一份 —— 它和基础/部门/简介几段一起合成总提示词（右栏可预览），各段不重复。')}
          </div>
        </div>
      </div>

      {/* 学会的工作流：经历 + 能力范围各一份，专属；要用就在这复制给谁 */}
      {card.role !== 'manager' && (card.learned || []).length ? (
        <div className="dp-field">
          <label>{t('学会的工作流')}</label>
          <div className="dp-in">
            <ul className="dp-hist dp-learn">
              {(card.learned || []).map((l, i) => (
                <li key={`l${i}`}>
                  <time>{new Date(l.at).toLocaleDateString('zh-CN')}</time> <b>{l.name}</b>
                  {l.how ? ` — ${l.how}` : ''}
                  <select
                    className="dp-copy"
                    value=""
                    title={t('复制给另一个员工（他的经历和能力范围各加一份）')}
                    onChange={(e) => {
                      if (e.target.value) onCopy(card.id, e.target.value, l.name);
                    }}
                  >
                    <option value="">{t('复制给…')}</option>
                    {people
                      .filter((p) => p.id !== card.id && p.role !== 'manager')
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </li>
              ))}
            </ul>
            <div className="dp-help">
              {t('他自己跑通一条就存一条（learn 工具）—— 能力是学会的，不是先天的。存下来是他的专属，别人没有。')}
            </div>
          </div>
        </div>
      ) : null}

      {card.cases && card.cases.length ? (
        <div className="dp-field">
          <label>{t('完成的工作')}</label>
          <div className="dp-in">
            <ul className="dp-hist">
              {card.cases.map((c, i) => (
                <li key={`c${i}`}>
                  <time>{new Date(c.at).toLocaleDateString('zh-CN')}</time> {c.starred ? '⭐ ' : ''}{c.work}
                  {c.how ? <div className="dp-case-how">{c.how}</div> : null}
                </li>
              ))}
            </ul>
            <div className="dp-help">
              {t('只记**确认有效**的活：做了什么 + 实现路径，不存上下文 —— 存在应用资料目录 .ensoul/state/cases/名字/成功案例.json。经理挑人看的就是这段。')}
            </div>
          </div>
        </div>
      ) : null}

      <div className="dp-card-foot">
        <button className="dp-primary" onClick={onSave}>
          {t('保存')}
        </button>
        {!card.hasPanel ? (
          <button className="dp-danger" onClick={onOpenPanel} disabled={!card.model} title={card.model ? '' : t('先指定模型')}>
            {t('开工作面')}
          </button>
        ) : null}
        {onDetach ? (
          <button className="dp-danger" onClick={onDetach} title={t('只从这个部门的成员表去掉，卡和工作面都留着')}>
            {t('从本部门摘出')}
          </button>
        ) : null}
        <span className="dp-foot-note">{t('保存后下一轮起生效；改名字会连面板标题一起改。')}</span>
        <button className="dp-danger" onClick={onRemove}>
          {t('移除')}
        </button>
      </div>
    </React.Fragment>
  );
}

/** 新员工：先填卡，保存时一并建卡 + 开工作面 */
function NewAgent({
  dept,
  models,
  onCancel,
  onSave,
}: {
  dept: string;
  models: { pick: string; label: string }[];
  onCancel(): void;
  onSave(c: { name: string; intro: string; skills: string[]; strength: string; model: string; prompt: string; avatar: string }): void;
}) {
  const [name, setName] = React.useState('');
  const [intro, setIntro] = React.useState('');
  const [skills, setSkills] = React.useState('');
  const [strength, setStrength] = React.useState('');
  const [model, setModel] = React.useState('');
  const [prompt, setPrompt] = React.useState('');
  const [avatar, setAvatar] = React.useState('');
  const fileRef = React.useRef<HTMLInputElement>(null);

  const pickAvatar = (f: File | null) => {
    if (!f) return;
    /** 同上：这里只挑图，落盘与"卡上不留 base64"由插件的 writeCard 负责 */
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result || '');
      if (url.length > 400 * 1024) {
        window.alert(t('这张图太大了（超过 400KB）—— 换一张小点的。'));
        return;
      }
      setAvatar(url);
    };
    r.readAsDataURL(f);
  };

  return (
    <React.Fragment>
      <div className="dp-card-head">
        <div className="dp-avwrap" onClick={() => fileRef.current?.click()} title={t('点一下传头像')}>
          {avatar ? (
            <img className="dp-av big" src={avatar} alt="" />
          ) : (
            <span className="dp-av big ghost">＋</span>
          )}
          <input ref={fileRef} type="file" accept="image/*" onChange={(e) => pickAvatar(e.target.files?.[0] ?? null)} />
        </div>
        <div>
          <div className="dp-card-title">{t('新员工')}</div>
          <div className="dp-card-sub">{t('加入')}{dept} · 建卡的同时把工作面开出来</div>
        </div>
      </div>

      <div className="dp-field">
        <label>{t('姓名')}</label>
        <div className="dp-in">
          <input type="text" autoFocus value={name} placeholder={t('如「原画师」')} onChange={(e) => setName(e.target.value)} />
          <div className="dp-help">{t('路由认这个名字 —— 要唯一。')}</div>
        </div>
      </div>

      <div className="dp-field">
        <label>{t('简介')}</label>
        <div className="dp-in">
          <textarea value={intro} placeholder={t('这个人是干什么的，一句话')} onChange={(e) => setIntro(e.target.value)} />
        </div>
      </div>

      <div className="dp-field">
        <label>{t('能力范围')}</label>
        <div className="dp-in">
          <input type="text" value={skills} placeholder={t('角色立绘，场景概念图，UI图标')} onChange={(e) => setSkills(e.target.value)} />
        </div>
      </div>

      <div className="dp-field">
        <label>{t('特长')}</label>
        <div className="dp-in">
          <input type="text" value={strength} placeholder={t('最拿手的那一手')} onChange={(e) => setStrength(e.target.value)} />
        </div>
      </div>

      <div className="dp-field">
        <label>{t('固定模型')}</label>
        <div className="dp-in">
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">{t('（没指定 —— 开不了工）')}</option>
            {models.map((m) => (
              <option key={m.pick} value={m.pick}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="dp-field">
        <label>{t('专属提示词')}</label>
        <div className="dp-in">
          <textarea
            className="prompt"
            value={prompt}
            placeholder={t('他是谁、接什么活、不接什么、交付到哪……')}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <div className="dp-help">{t('只写他自己那一份；通用提示词每轮由系统另外叠。')}</div>
        </div>
      </div>

      <div className="dp-card-foot">
        <button
          className="dp-primary"
          disabled={!name.trim()}
          onClick={() =>
            onSave({
              name: name.trim(),
              intro,
              skills: skills.split(/[，,、]/).map((s) => s.trim()).filter(Boolean),
              strength,
              model,
              prompt,
              avatar,
            })
          }
        >
          建卡并开工
        </button>
        <button className="dp-danger" onClick={onCancel}>
          取消
        </button>
        {!model ? <span className="dp-foot-note">{t('没指定模型的话，卡会建好，但工作面先不开。')}</span> : null}
      </div>
    </React.Fragment>
  );
}
