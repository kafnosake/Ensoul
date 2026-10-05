import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isTabGroup, type DockTarget, type DockNode, type Workspace } from '../../shared/types';
import { NOTE_PREFIX, hasNotePrefix } from '../../shared/note-prefix';
import { snapshotFailed, validateSnapshot, type JsonSnapshot } from '../../shared/json-snapshot';
import { matchPanelAvatarFamily, panelAvatarFileName } from '../../shared/panel-avatars';
import { panelAvatarUrl } from '../panel/panelAvatarUrl';
import { api } from '../core/api';
import './SidebarMonitor.css';
import { t } from '../core/i18n';

interface MonitorUnit {
  id: string;
  name: string;
  dept?: string;
  role?: string;
  avatar?: string;
  accent?: string;
  model?: string;
  panelId?: string;
  /**
   * 底状态（不含未读）—— 真正画哪个点由 dotOf() 按优先级决定：
   *   working 正在输出 · confirm 等你回话 · error 上一轮失败 · deliverable 成果可交付 ·
   *   idle 空闲 · offline 未开班
   */
  status: 'working' | 'waiting' | 'deliverable' | 'idle' | 'offline' | 'confirm' | 'error';
  statusText: string;
  /** 核心挂着"等你点头"的请求（重启用的是这条路，见 plugins/restart-approval） */
  ask?: boolean;
  /** 还没看过的回信条数 —— 绿点 + 数字徽章就是它 */
  unread?: number;
  /** 最后一条助手回信的**消息 id** —— 已读水位锚在它上面（不用时间戳，理由见 SeenRec） */
  lastReplyId?: string;
  /** 它的时间，只在拿不到 id 时当兜底 */
  lastReplyAt?: number;
  taskSnippet?: string;
  at: number;
  lastMsg?: string;
  /** 最后一条**助手回信**的时间 —— 排序 1 级键 */
  replyAt?: number;
  /** 最后一条**用户提问 / 派单**的时间 —— 排序 3 级键 */
  askingAt?: number;
  /** 当前面板是否正处于主屏检阅中（在前台激活标签显示） */
  isActiveInView?: boolean;
  /** 是否已被⭐收藏常驻（关闭后仍留在列表中） */
  starred?: boolean;
  /** 最新一次对话中附带的图片（优先在浮窗中展示） */
  lastImage?: string;
  /** 浮窗中展示的详细文字内容（最多 400 字） */
  popoverText?: string;
}

const ESCHAT_FILE = '.ensoul/state/eschat.json';
const INBOX_FILE = '.ensoul/state/dispatch.inbox.json';
const TODO_FILE = '.ensoul/state/todo.json';
const CMD_FILE = '.ensoul/state/dispatch.cmd.json';
const PINS_KEY = 'ensoul_sidebar_pins';
const STARRED_KEY = 'ensoul_sidebar_starred';
const STARRED_META_KEY = 'ensoul_sidebar_starred_meta';

interface StarredMeta {
  id: string;
  name: string;
  avatar?: string;
  accent?: string;
  at?: number;
  replyAt?: number;
  askingAt?: number;
  lastMsg?: string;
}

function loadStarred(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(STARRED_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

function saveStarred(starred: Set<string>): void {
  try {
    localStorage.setItem(STARRED_KEY, JSON.stringify([...starred]));
  } catch {}
}

function loadStarredMeta(): Record<string, StarredMeta> {
  try {
    const raw = JSON.parse(localStorage.getItem(STARRED_META_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveStarredMeta(meta: Record<string, StarredMeta>): void {
  try {
    localStorage.setItem(STARRED_META_KEY, JSON.stringify(meta));
  } catch {}
}
/**
 * 递归遍历停靠树，找出当前在各窗口/各标签组里**正处于激活、摆在眼前展示**的面板 id。
 * 只要用户在实际面板里看着它，就算已读，监视台上的未读标记立刻消掉。
 */
function collectVisibleActivePanelIds(ws: Workspace | null): Set<string> {
  const activeIds = new Set<string>();
  if (!ws) return activeIds;

  function walk(node: DockNode | null | undefined) {
    if (!node) return;
    if (node.type === 'tabs') {
      if (node.active) activeIds.add(node.active);
    } else if (node.type === 'split') {
      if (Array.isArray(node.children)) {
        for (const child of node.children) walk(child);
      }
    }
  }

  walk(ws.layout);
  if (Array.isArray(ws.floating)) {
    for (const f of ws.floating) {
      if (f && f.root) walk(f.root);
    }
  }

  return activeIds;
}

/**
 * 已读账本：<单位 id> → { 我读到哪条回信了, 什么时候 }。
 *
 * 水位**锚在最后一条回信的消息 id 上**，不是时间戳 —— 时间戳那套从写出来那天就是坏的：
 * 首屏水位是 0，等于"这个人历史上每一句回信我都没看过"，一个跑过上百轮的员工
 * 一上来就顶个 9+；而对话被裁进归档之后老时间戳再也对不上现存消息，数字就**永远清不掉**，
 * 只剩一个点不掉的徽章。
 *
 * 换成 id 之后规则是硬的，四条：
 *   1. 头一回见到这个单位 → **当场起底成已读**，绝不追讨历史；
 *   2. 记的是"我读到哪条回信了"，id 没变就是看过了；
 *   3. id 变了 = 有新回信，条数就是账本锚点之后那几条 —— 真实条数，不是 9+ 这种虚数；
 *   4. 锚点被裁进归档（找不到了）→ 起底到最新，同样不追讨。
 */
const SEEN_KEY = 'ensoul_sidebar_seen';

interface SeenRec {
  /** 最后一条已读回信的消息 id（空串 = 见过这个单位，但它还没有任何回信） */
  id: string;
  at: number;
}

/** 读账本。老版本存的是裸时间戳（没有 id）—— 一律丢弃，下次见到重新起底 */
function loadSeen(): Record<string, SeenRec> {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}');
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, SeenRec> = {};
    for (const [k, v] of Object.entries(raw as Record<string, any>)) {
      if (v && typeof v === 'object' && typeof (v as any).id === 'string') {
        out[k] = { id: String((v as any).id), at: Number((v as any).at) || 0 };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveSeen(ledger: Record<string, SeenRec>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(ledger));
  } catch {
    /* 配额满了就算了，别让记账把界面拖死 */
  }
}

/**
 * 数未读，顺手把该起底的起底（这个函数会改账本，改没改看返回值之外由调用方落盘）。
 * `ids` 是这个单位的助手消息 id，按时间顺序；拿不到对话时给一条伪 id 也行。
 */
function unreadOf(ledger: Record<string, SeenRec>, key: string, ids: string[], lastAt: number): number {
  const lastId = ids[ids.length - 1] || '';
  if (!lastId) return 0; // 还没有任何回信
  const rec = ledger[key];
  if (!rec) {
    // 头一回见：起底到最新，不追讨历史
    ledger[key] = { id: lastId, at: lastAt || Date.now() };
    return 0;
  }
  if (rec.id === lastId) return 0; // 看过了
  if (!rec.id) return ids.length; // 以前一条回信都没有 —— 这一批全算新
  const idx = ids.lastIndexOf(rec.id);
  if (idx < 0) {
    // 锚点被裁进归档了：不追讨，重新起底
    ledger[key] = { id: lastId, at: lastAt || Date.now() };
    return 0;
  }
  return ids.length - idx - 1;
}

/** 消息时间：ChatMessage 用的是 createdAt，老数据里可能是 at */
function msgTime(m: any): number {
  return Number(m?.createdAt ?? m?.at ?? 0) || 0;
}

/** 从对话里倒着找最后一条某个角色的消息 */
function lastByRole(chat: any, role: string): any | null {
  if (!Array.isArray(chat)) return null;
  for (let i = chat.length - 1; i >= 0; i--) {
    if (chat[i] && chat[i].role === role) return chat[i];
  }
  return null;
}

/**
 * 侧栏要的那几个数：**优先读主进程算好的摘要素描，读不到才退回真 chat**。
 *
 * 为什么要有这一层：广播出去的 panels 现在只带骨架 + `summary`（聊天正文十几 MB，
 * 全量进广播就是"点一下要等一秒"的根）。侧栏本来是把整份 chat 遍历一遍算
 * 未读 / 最后一句 / 最后一张图 —— 这些主进程在自己那边现算一次就行，
 * 界面上收现成的。形状**刻意和 ChatMessage 一致**（id / role / content / createdAt /
 * images），所以下面那些 lastByRole / msgTime 一行都不用改。
 *
 * 自己那块面板（或其浮窗）正开着时，cache 里那一份是真 body → 走不到这儿。
 * 所以这个兜底只在"面板在后台、广播那份是摘要"时生效 —— 正是要省的那条路。
 */
function panelFeed(p: any): any[] {
  if (!p) return [];
  if (Array.isArray(p.chat) && p.chat.length) return p.chat; // 真 body
  const s = p.summary;
  if (!s) return Array.isArray(p.chat) ? p.chat : [];
  const out: any[] = [];
  const t = Number(s.askingAt ?? 0) || Number(s.replyAt ?? 0) || 0;
  if (s.lastUserText) out.push({ id: 'sum:user', role: 'user', content: String(s.lastUserText), createdAt: t });
  if (s.lastText && s.lastText !== s.lastUserText) {
    out.push({ id: 'sum:last', role: 'assistant', content: String(s.lastText), createdAt: Number(s.replyAt ?? 0) || t, images: s.lastImage ? [String(s.lastImage)] : undefined });
  }
  return out;
}

/** 数未读要的那串"回信 id" —— 摘要里带了现成的（只留最近 100 条，够用） */
function replyIdsOf(p: any, feed: any[]): string[] {
  const sids = p?.summary?.assistantIds;
  if (Array.isArray(sids) && sids.length) return sids.map((x: any) => String(x || ''));
  return feed.filter((m) => m && m.role === 'assistant').map((m) => String(m.id || ''));
}

/**
 * 会话列表精准排序：
 *   0 级 置顶（手动钉住的永远在最前）
 *   1 级 正在运转的（status === 'working'，包括正在输出/执行任务）—— 排在普通会话最上方
 *   2 级 普通会话 —— 严格按照回信时间与送信时间（二者同级，取最新一条消息时间戳）倒序排列！
 * 铁律：绝不使用 updatedAt 修改时间，防止用户一打开/查看面板卡片就乱跳！
 */
/**
 * 纯粹事件序排序：
 *   0 级：置顶单位（pins）
 *   1 级：普通会话与运转中会话全员平等，==严格只锚定：送信时间 vs 最终回信时间（二者取大，倒序排列）==
 *
 * 铁律与设计原则：
 *   1. 绝不使用 updatedAt（防止查看面板时产生乱跳）；
 *   2. 绝不因为正在运转 (status === 'working') 单独提拔，也绝不在运转途中因为执行了一行工具或吐出部分字词而跳动；
 *   3. 会话在送信的瞬间顶到最新位置；在模型生成/跑工具的整个生命周期中，卡片位置保持静止；
 *   4. 只有当 LLM 这一轮彻底触发 EOS（或者网络中断、报错、手动停止）将 Assistant 最终消息落盘后，才结算最新的回信时间，平稳归位！
 */
export function sortUnits(list: MonitorUnit[], pins: Set<string>): MonitorUnit[] {
  const getLatestTime = (u: MonitorUnit): number => {
    // 回信、送信二者同级，取最新的一条已完成消息时间；若无对话，取创建登记时间 u.at
    return Math.max(u.replyAt || 0, u.askingAt || 0, u.at || 0);
  };

  return [...list].sort((a, b) => {
    // 0 级：置顶（pins 置顶）
    const pa = pins.has(a.id) ? 0 : 1;
    const pb = pins.has(b.id) ? 0 : 1;
    if (pa !== pb) return pa - pb;

    // 所有会话严格按最新送信/回信时间倒序排列
    const ta = getLatestTime(a);
    const tb = getLatestTime(b);
    return tb - ta;
  });
}

/**
 * 一个单位只画一个点，按这个优先级取一个：
 *   正在输出(working) > 等你点头(ask) > 等你回话(confirm) > 上一轮失败(error) > 有回信没看(unread) > 成果可交付(deliverable) > 空闲(idle) > 未开班(offline)
 * 
 * 铁律：正在输出/运转具有绝对的实时物理性！
 * 即使后台还挂着重启或等待点头的事务，只要会话当前正在运转输出（用户追加了会话或智能体在跑），必须呈现青色光流与运转微点！
 */
function dotOf(u: MonitorUnit): string {
  if (u.status === 'working') return 'working';
  if (u.ask) return 'ask';
  if (u.status === 'confirm') return 'confirm';
  if (u.status === 'error') return 'error';
  if (u.unread && u.unread > 0) return 'unread';
  if (u.status === 'deliverable') return 'deliverable';
  if (u.status === 'waiting') return 'waiting';
  if (u.status === 'offline') return 'offline';
  return 'idle';
}

function dotColor(d: string): string {
  switch (d) {
    case 'ask':
    case 'confirm':
      return '#eab308'; // P1 & P3: 明黄色
    case 'working':
      return '#06b6d4'; // P2: 蓝绿色/青色 (Cyan)
    case 'error':
    case 'unread':
      return '#ef4444'; // P4: 红色
    case 'deliverable':
      return '#22c55e'; // P6: 荧光绿色
    case 'waiting':
      return '#38bdf8'; // 待处理工单（天蓝色）
    default:
      return 'var(--dim)';
  }
}

function safeParse<T>(raw: string, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function formatRelativeTime(ts?: number): string {
  if (!ts) return t('未活跃');
  const diff = Date.now() - ts;
  if (diff < 60000) return t('刚刚');
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 工具名黑名单，避免工具调用占位符被当成意图展示 */
const TOOL_NAME_REGEX = /^\*{0,2}(run_code|read_file|write_file|edit|grep|glob|list_dir|search|browser_open|dispatch|deliver_result|use_skill|job_\w+|git_\w+|comfyui_\w+|todo_\w+|template_\w+|subagent_\w+|component_\w+|build_project|start_project|stop_project|restart_project|project_status)\*{0,2}$/i;

/** 严苛清洗文本：丢弃终端日志、构建输出、纯工具名等杂音，剥除标记符，仅留干净人话第一行 */
function cleanText(raw?: string, maxLen = 42): string {
  if (!raw) return '';
  let s = String(raw).trim();
  // 剥除外层包裹的 == 高亮符号
  s = s.replace(/^==\s*/, '').replace(/\s*==$/, '');

  if (
    s.includes('npm run') ||
    s.includes('tsc -p') ||
    s.includes('vite build') ||
    s.includes('building for production') ||
    s.includes(t('确认重启')) ||
    s.includes('dist/renderer') ||
    s.includes('[36m') ||
    s.startsWith('$ ') ||
    s.startsWith('```')
  ) {
    return '';
  }

  const lines = s.split('\n').map((x) => x.trim()).filter(Boolean);
  for (const line of lines) {
    if (
      line.startsWith('【') ||
      line.startsWith('#') ||
      line.startsWith('```') ||
      line.startsWith('<<<') ||
      line.startsWith('>>>')
    ) {
      continue;
    }
    // 剥除行首多余 markdown 标记
    const cleanLine = line
      .replace(/^[*_~`#>\s-]+/, '')
      .replace(/[*_~`]+$/, '')
      .replace(/^==\s*/, '')
      .replace(/\s*==$/, '')
      .trim();
    if (!cleanLine) continue;
    // 过滤纯工具调用名，如 **run_code** / run_code
    if (TOOL_NAME_REGEX.test(cleanLine) || TOOL_NAME_REGEX.test(line)) {
      continue;
    }
    return cleanLine.length > maxLen ? cleanLine.slice(0, maxLen) + '…' : cleanLine;
  }
  return '';
}

/**
 * 精准提取会话当前的意图或待办进展：
 *   1. 优先提取当前正在推进的待办项（TodoList in_progress 项）
 *   2. 其次提取派单/流转中的具体任务描述（activeTicket.task）
 *   3. 会话正在运转工作时，优先呈现用户最新发出的需求/指令（即会话当下意图）
 *   4. 倒序提取助手最新说出的自然语言有效人话（排除纯工具名与系统日志）
 *   5. 再次看 TodoList 中下一条待办（pending 项）
 */
function extractIntentSnippet(args: {
  isWorking: boolean;
  todo?: any;
  activeTicket?: any;
  chat?: any[];
  fallbackMsg?: string;
}): string {
  const { isWorking, todo, activeTicket, chat = [], fallbackMsg } = args;

  // 1. 如果有活跃派单，展示派单任务内容
  if (activeTicket && activeTicket.task) {
    const t = cleanText(activeTicket.task, 45);
    if (t) return t;
  }

  // 2. 检查 Todo 清单：正在进行的待办 (in_progress) 权重最高！
  if (todo && Array.isArray(todo.items)) {
    const inProg = todo.items.find((i: any) => i && i.status === 'in_progress');
    if (inProg && inProg.content) {
      const t = cleanText(inProg.content, 45);
      if (t) return `⚡ ${t}`;
    }
  }

  // 3. 如果会话正在工作运转中 (isWorking)
  // 用户最新发给它的那句指令，恰好是当前正在执行的核心意图！
  if (isWorking && chat.length > 0) {
    const lastUserMsg = lastByRole(chat, 'user');
    if (lastUserMsg && lastUserMsg.content) {
      const uText = cleanText(lastUserMsg.content, 45);
      if (uText) return uText;
    }
  }

  // 4. 倒序寻找第一条真正对人类说的自然语言发言（排除纯工具名如 **run_code**）
  if (chat.length > 0) {
    for (let i = chat.length - 1; i >= 0; i--) {
      const item = chat[i];
      if (!item) continue;
      const text = cleanText(item.content, 45);
      if (text) return text;
    }
  }

  // 5. 检查 Todo 清单中首条排队待办 (pending)
  if (todo && Array.isArray(todo.items)) {
    const pending = todo.items.find((i: any) => i && i.status === 'pending');
    if (pending && pending.content) {
      const t = cleanText(pending.content, 45);
      if (t) return t;
    }
  }

  // 6. 兜底回落
  if (fallbackMsg) {
    const f = cleanText(fallbackMsg, 45);
    if (f) return f;
  }

  return t('暂无动态');
}

/** 规范化图片显示路径 */
function toShotUrl(p?: string): string {
  if (!p) return '';
  if (p.startsWith('data:') || p.startsWith('http://') || p.startsWith('https://') || p.startsWith('file://')) return p;
  return `file:///${String(p).replace(/\\/g, '/')}`;
}

/** 提取对话历史中最新出现的图片 */
function extractLastImage(chat?: any[]): string | undefined {
  if (!Array.isArray(chat) || chat.length === 0) return undefined;
  for (let i = chat.length - 1; i >= 0; i--) {
    const msg = chat[i];
    if (!msg) continue;
    // 1. msg.images 数组
    if (Array.isArray(msg.images) && msg.images.length > 0) {
      const img = msg.images[msg.images.length - 1];
      if (img) return String(img);
    }
    // 2. markdown / html 图片
    const content = typeof msg.content === 'string' ? msg.content : '';
    const mdImgMatch = content.match(/!\[.*?\]\((.+?)\)/);
    if (mdImgMatch && mdImgMatch[1]) {
      return mdImgMatch[1].trim();
    }
    const htmlImgMatch = content.match(/<img [^>]*src=["']([^"']+)["']/i);
    if (htmlImgMatch && htmlImgMatch[1]) {
      return htmlImgMatch[1].trim();
    }
  }
  return undefined;
}

/** 详细文字清洗，支持段落，最多显示指定字数（默认 400 字） */
function cleanLongText(raw?: string, maxLen = 400): string {
  if (!raw) return '';
  let s = String(raw).trim();
  // 剥除 FLOAT_EDIT 提案块
  if (s.includes('FLOAT_EDIT')) {
    s = s.replace(/<<<FLOAT_EDIT>>>[\s\S]*?<<<END_FLOAT_EDIT>>>/g, '').trim();
  }
  // 过滤构建输出、大段命令日志
  if (
    s.includes('npm run') ||
    s.includes('tsc -p') ||
    s.includes('building for production') ||
    s.startsWith('```') ||
    s.startsWith('$ ')
  ) {
    return '';
  }
  const lines = s.split('\n').map((l) => l.trim()).filter((l) => {
    if (!l) return false;
    if (l.startsWith('<<<') || l.startsWith('>>>') || l.startsWith('```')) return false;
    if (TOOL_NAME_REGEX.test(l)) return false;
    return true;
  });
  const text = lines.join('\n').replace(/^[*_~`#>\s-]+/gm, '').trim();
  return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
}

/** 提取浮窗中展示的详细文字（最多 400 字） */
function extractDetailedText(chat: any[], snippet?: string, maxLen = 400): string {
  if (Array.isArray(chat) && chat.length > 0) {
    for (let i = chat.length - 1; i >= 0; i--) {
      const msg = chat[i];
      if (!msg) continue;
      const raw = typeof msg.content === 'string' ? msg.content : '';
      if (!raw.trim()) continue;
      const t = cleanLongText(raw, maxLen);
      if (t) return t;
    }
  }
  if (snippet) return cleanLongText(snippet, maxLen);
  return '';
}

/**
 * 打开或唤醒一个单位（双击/点击跳转/发指令都走这儿）：
 * 1. 若面板正在当前工作区（含后台 hidden）：直接 activate 叫到前台。
 * 2. 若面板不在眼前（被关闭收进 closed/ 目录）：
 *    a. 先试 api.panel.reopen(pId) —— 把它从 closed 捞回主工作区并激活；
 *    b. 若捞不回来（或角色卡未绑定面板）且是 AI 员工：
 *       用标准 dispatch 命令队列唤醒（dispatch 会把收纳区或睡着的历史对话自动接上）；
 */
async function openOrWakeUnit(unit: MonitorUnit, ws: Workspace | null, activate = true) {
  const pId = unit.panelId;
  const inWs = pId && ws?.panels && ws.panels[pId];

  if (inWs) {
    if (activate) void api.panel.activate(pId);
    return;
  }

  // 不在活动工作区：尝试从「最近关闭」中捞回
  if (pId) {
    try {
      const ok = await api.panel.reopen(pId);
      if (ok) {
        if (activate) void api.panel.activate(pId);
        return;
      }
    } catch {}
  }

  // 捞不回来，如果是编制内员工，通过 dispatch 插件的标准命令队列唤醒
  try {
    let cmds: any[] = [];
    try {
      const raw = await api.fs.read(CMD_FILE);
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.cmds)) cmds = parsed.cmds;
    } catch {
      cmds = [];
    }
    cmds.push({
      seq: Date.now() * 1000 + Math.floor(Math.random() * 1000),
      panelId: pId || '',
      cmd: 'openPanel',
      id: unit.id,
    });
    await api.fs.write(CMD_FILE, JSON.stringify({ cmds: cmds.slice(-20) }));
  } catch {}
}

export function SidebarMonitor({
  ws,
  onHide,
  onGrab,
  draggingPanelId,
}: {
  ws: Workspace | null;
  onHide: () => void;
  /** 按住带面板的行开始拖 —— 接到主壳的统一拖拽管线（同收纳区入口那套）；look = 跟手影子要画的头像信息 */
  onGrab?: (
    panelId: string,
    name: string,
    state: 'visible' | 'hidden' | 'closed',
    e: React.PointerEvent,
    look?: { accent?: string; avatar?: string },
  ) => void;
  /** 正在被拖拽的面板 id（那一行画半透明跟手态） */
  draggingPanelId?: string | null;
}) {
  const [units, setUnits] = useState<MonitorUnit[]>([]);
  /** 快照读坏时脑袋上那句提示（'' = 一切正常） */
  const [snapBad, setSnapBad] = useState('');
  /** 名册读坏时接着用这一份（上一次成功解析的 contacts）—— 绝不兜成空数组 */
  const lastContactsRef = useRef<any[]>([]);
  const lastContactsWorkspaceRef = useRef('');
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [isExpanded, setIsExpanded] = useState<boolean>(() => {
    return localStorage.getItem('ensoul_sidebar_expanded') === 'true';
  });
  const [hoveredUnit, setHoveredUnit] = useState<MonitorUnit | null>(null);
  const [activeUnit, setActiveUnit] = useState<MonitorUnit | null>(null);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
  const [quickInput, setQuickInput] = useState('');
  /**
   * 每个单位各自的输入草稿 —— 卡片是跟着光标走的，光标一移开卡片就换人，
   * 所以打的字必须按单位分槽存；否则在 A 那儿打一半、光标扫过 B，字就串到 B 名下了。
   */
  const draftsRef = useRef<Record<string, string>>({});
  /** 定时器里要用到"此刻是谁"，走 ref 拿最新值（闭包里的 state 是老的） */
  const activeUnitRef = useRef<MonitorUnit | null>(null);
  activeUnitRef.current = activeUnit;
  const quickInputRef = useRef('');
  quickInputRef.current = quickInput;
  const [sending, setSending] = useState(false);
  /** 拖拽便签悬停的目标单位 id */
  const [dragOverUnitId, setDragOverUnitId] = useState<string | null>(null);
  /** 置顶：钉住的单位永远浮在最上面，跨重启仍在 */
  const [pins, setPins] = useState<string[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(PINS_KEY) || '[]');
      return Array.isArray(raw) ? raw.map(String) : [];
    } catch {
      return [];
    }
  });
  const pinsRef = useRef<Set<string>>(new Set(pins));
  pinsRef.current = new Set(pins);

  /** ⭐ 收藏常驻：被收藏的面板在列表中永远保留，关闭后依然常驻 */
  const [starred, setStarred] = useState<Set<string>>(() => loadStarred());
  const starredRef = useRef<Set<string>>(starred);
  starredRef.current = starred;
  const starredMetaRef = useRef<Record<string, StarredMeta>>(loadStarredMeta());

  /** 浮窗内面板名称重命名行内编辑状态 */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const editNameInputRef = useRef<HTMLInputElement>(null);
  /** 已读账本（跟置顶一样，是"看的人自己"的状态） */
  const seenRef = useRef<Record<string, SeenRec>>({});
  const seenRefInited = useRef(false);
  if (!seenRefInited.current) {
    seenRefInited.current = true;
    seenRef.current = loadSeen();
  }

  const hoverTimerRef = useRef<any>(null);
  const cardHoveredRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  /** 卡片和侧栏各自的 DOM —— 判断"点哪儿算是点了别处" */
  const popRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  /** ws 每次状态更新都是新对象；放进 ref，别让它把轮询定时器反复重置 */
  const wsRef = useRef(ws);
  wsRef.current = ws;

  /**
   * 信号驱动的实时检阅集合：
   * 只要工作区标签页一变，父级传下的 ws 立即变，React 当帧同步推导出激活的面板 id！
   * 彻底告别依靠 1000ms 定时器轮询导致的 UI 切换迟滞感！
   */
  const visibleActivePanels = useMemo(() => collectVisibleActivePanelIds(ws), [ws]);

  /** 乐观激活信号：双击或点击跳转瞬间立即点亮，0 毫秒响应 */
  const [optimisticActiveId, setOptimisticActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (optimisticActiveId) setOptimisticActiveId(null);
  }, [ws]);

  /** 列表项 DOM 引用与历史纵向位置缓存（用于 FLIP 平滑重排与挤占位动画） */
  const itemElsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const prevTopsRef = useRef<Map<string, number>>(new Map());

  /** 主进程真实执行态追踪：内存级的 running 集合，绝不漏掉正在运行/请求中的会话 */
  const runningPanelsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    const off = api.chat.onRunning((p) => {
      if (!p || !p.panelId) return;
      if (p.running) {
        runningPanelsRef.current.add(p.panelId);
      } else {
        runningPanelsRef.current.delete(p.panelId);
      }
    });
    void api.chat.running().then((list) => {
      if (!alive || !Array.isArray(list)) return;
      runningPanelsRef.current = new Set(list.map((x) => x.panelId));
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  /**
   * 会话拖拽期间（自绘指针管线，不走 HTML5 拖放）：光标压到别的成员行上就把
   * **橙色虚线框**点亮 —— 和便签拖进来时同一个 `.is-drag-target`，两套拖法一个样。
   * 松手在行上 = 把拖着的那块并进那行面板所在的标签组（同浏览器把标签拖到标签上并组）。
   * 命中靠 elementFromPoint + closest：影子卡、提示条都是 pointer-events:none，不会挡判定。
   */
  useEffect(() => {
    if (!draggingPanelId) return;
    const rowAt = (x: number, y: number): HTMLDivElement | null => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      const row = el?.closest('.sbm-item') as HTMLDivElement | null;
      if (!row) return null;
      const pid = row.dataset.panelId;
      // 没面板的行（纯员工）或拖的就是它自己：不亮也不接
      if (!pid || pid === draggingPanelId) return null;
      return row;
    };
    const onMove = (e: PointerEvent) => {
      const id = rowAt(e.clientX, e.clientY)?.dataset.unitId || null;
      setDragOverUnitId((prev) => (prev === id ? prev : id));
    };
    const onUp = (e: PointerEvent) => {
      const row = rowAt(e.clientX, e.clientY);
      setDragOverUnitId(null);
      if (!row) return; // 松在别处：落点归 placeDrag 管，这里只管"落在行上"这一种
      const targetPid = row.dataset.panelId as string;
      const cur = wsRef.current;
      if (!cur) return;
      const findTab = (n: DockNode, pid: string): string | null =>
        isTabGroup(n) ? (n.panels.includes(pid) ? n.id : null) : findTab(n.children[0], pid) || findTab(n.children[1], pid);
      let target: DockTarget | null = null;
      const mainTab = findTab(cur.layout, targetPid);
      if (mainTab) target = { where: 'main', tabId: mainTab, mode: 'tabs' };
      else {
        for (const f of cur.floating) {
          const t = findTab(f.root, targetPid);
          if (t) {
            target = { where: 'floating', windowId: f.id, tabId: t, mode: 'tabs' };
            break;
          }
        }
      }
      if (target) void api.dock.drop(draggingPanelId, target);
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    return () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      setDragOverUnitId(null);
    };
  }, [draggingPanelId]);

  // 轮询态势与真实活跃时间（挂载即刷一次 —— 这叫"调出后一次性刷新"）
  useEffect(() => {
    let unmounted = false;

    async function loadData() {
      try {
        const readState = async (file: string, field: string, array: boolean) => validateSnapshot(
          await api.fs.readJson(file),
          (data) => {
            if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
            const value = (data as Record<string, unknown>)[field];
            return array ? Array.isArray(value) : !!value && typeof value === 'object' && !Array.isArray(value);
          },
          t('快照格式不正确：') + field,
        );
        const [eschatSnapshot, inboxSnapshot, todoSnapshot] = await Promise.all([
          readState(ESCHAT_FILE, 'contacts', true),
          readState(INBOX_FILE, 'entries', true),
          readState(TODO_FILE, 'panels', false),
        ]);

        if (unmounted) return;

        const eschatData = eschatSnapshot.status === 'ready' ? eschatSnapshot.data as { contacts?: unknown[] } : { contacts: [] };
        const inboxData = inboxSnapshot.status === 'ready' ? inboxSnapshot.data as { entries?: unknown[] } : { entries: [] };
        const todoData = todoSnapshot.status === 'ready' ? todoSnapshot.data as { panels?: Record<string, unknown> } : { panels: {} };
        const curWs = wsRef.current || (await api.workspace.get().catch(() => null));
        if (lastContactsWorkspaceRef.current !== curWs?.workspace) {
          lastContactsWorkspaceRef.current = curWs?.workspace || '';
          lastContactsRef.current = [];
        }

        /**
         * 名册读不出来 → **留着上一次那份**。
         * 原来这里兜底成 `{ contacts: [] }`，于是侧栏变空、用户以为员工没了 ——
         * 明明只是文件大到读不回来（内容好好的，一个字节没丢）。
         */
        const eschatBroken = snapshotFailed(eschatSnapshot);
        const contacts: any[] = eschatBroken
          ? lastContactsRef.current
          : Array.isArray(eschatData?.contacts)
            ? eschatData.contacts
            : lastContactsRef.current;
        if (!eschatBroken) lastContactsRef.current = contacts;
        const failed: [string, JsonSnapshot][] = [[ESCHAT_FILE, eschatSnapshot], [INBOX_FILE, inboxSnapshot], [TODO_FILE, todoSnapshot]];
        setSnapBad(failed.filter(([, snapshot]) => snapshotFailed(snapshot)).map(([file, snapshot]) =>
          snapshot.status === 'too_large' ? `${file}：${Math.round(snapshot.bytes / 1024)} KB`
            : snapshot.status === 'error' || snapshot.status === 'invalid' ? `${file}：${snapshot.error}` : '',
        ).join('\n'));
        const inboxEntries: any[] = Array.isArray(inboxData?.entries) ? inboxData.entries : [];
        const todoPanels: Record<string, any> = (todoData && todoData.panels) || {};
        const panels = curWs?.panels || {};
        // 用户眼皮底下正摆着看哪几块面板（主窗口各分屏激活的标签 + 各浮窗激活的标签）
        const visibleActivePanels = collectVisibleActivePanelIds(curWs);
        const list: MonitorUnit[] = [];
        const seenPanelIds = new Set<string>();

        // 1. 编制员工
        for (const c of contacts) {
          const empId = String(c.id);
          const pId = c.panel ? String(c.panel) : undefined;
          if (pId) seenPanelIds.add(pId);

          const livePanel = pId ? panels[pId] : null;

          // 真实时间戳：严格只绑定回信与送信的真实消息时间，绝不使用 updatedAt（防止点开面板乱跳）
          let realAt = Number(c.at) || 0;
          let lastMsg = c.last ? String(c.last.text || '') : undefined;
          let replyAt = 0;
          let askingAt = 0;
          if (c.last && c.last.role === 'assistant') replyAt = Number(c.at) || 0;
          if (c.last && c.last.role === 'user') askingAt = Number(c.at) || 0;

          const chat: any[] = panelFeed(livePanel);
          if (livePanel) {
            const replyT = msgTime(lastByRole(chat, 'assistant'));
            const askT = msgTime(lastByRole(chat, 'user'));
            if (replyT > replyAt) replyAt = replyT;
            if (askT > askingAt) askingAt = askT;
            const newAt = Number((livePanel as any).newSessionAt) || 0;
            // 铁律：排序严格只锚定用户送信与助手最终回信！绝不使用中间 tool/delta 消息时间（防止跑一行跳一下）
            if (newAt > realAt) realAt = newAt;
            const lastItem = chat[chat.length - 1];
            if (lastItem && typeof lastItem.content === 'string') {
              lastMsg = lastItem.content;
            }
          }

          // 查工单（按时间从新到旧找最新一条）
          const activeTicket = [...inboxEntries].reverse().find(
            (e) => (e.holder === pId || e.holderName?.includes(c.name)) && e.status === 'pending'
          );
          const doneTicket = [...inboxEntries].reverse().find(
            (e) => (e.holder === pId || e.holderName?.includes(c.name)) && e.status === 'done'
          );

          if (activeTicket && activeTicket.at > askingAt) askingAt = activeTicket.at;
          if (doneTicket && doneTicket.doneAt > replyAt) replyAt = doneTicket.doneAt;

          // 事件序模式：谁最新谁在先，取回信/送信/建卡初始时间最大值
          realAt = Math.max(replyAt, askingAt, Number(c.at) || 0);

          // 未读：面板开着就照对话里的回信 id 数，面板关着就只能拿联系人上那条兜底
          const replyIds = replyIdsOf(livePanel, chat);
          let unread = replyIds.length
            ? unreadOf(seenRef.current, empId, replyIds, msgTime(lastByRole(chat, 'assistant')))
            : unreadOf(seenRef.current, empId, [String(c.last?.id || `wx:${c.at || 0}`)], Number(c.at) || 0);

          // 用户眼皮底下正摆着这个面板看呢（在激活标签里）—— 当场抹平未读，记入账本
          if (pId && visibleActivePanels.has(pId)) {
            const lastRepId = replyIds.length ? replyIds[replyIds.length - 1] : (c.last?.id || `seen:${empId}`);
            seenRef.current[empId] = { id: String(lastRepId), at: replyAt || Number(c.at) || 0 };
            unread = 0;
          }

          // 计算底状态（点画什么由 dotOf 定，这里只定处境）
          const isActuallyRunning = Boolean((pId && runningPanelsRef.current.has(pId)) || runningPanelsRef.current.has(empId));
          const ps = isActuallyRunning ? 'working' : (livePanel ? String(livePanel.status || 'idle') : '');

          // 查待办：只有当面板自身仍在运行工作时，待办中的 in_progress 才作为辅助标记
          // 如果会话实际已经处于 idle，说明当前轮次已经结束（例如派单完成正等待交回），不应被遗留的 todo 假死锁住
          const myTodo = pId ? todoPanels[pId] : null;
          const inProgressTodo = (ps === 'working') && myTodo?.items?.find((i: any) => i.status === 'in_progress');
          let status: MonitorUnit['status'] = 'idle';
          let statusText = t('就绪空闲');

          // 铁律：只有模型物理上在跑（isActuallyRunning 或 ps === 'working'）才算 working！绝不允许空转光圈！
          if (isActuallyRunning || ps === 'working') {
            status = 'working';
            statusText = inProgressTodo ? t('正在推进待办') : (activeTicket ? t('正在执行工单') : t('正在工作'));
          } else if (ps === 'confirm') {
            status = 'confirm';
            statusText = t('等你回话');
          } else if (ps === 'error' || c.status === 'error') {
            status = 'error';
            statusText = t('上一轮已停止');
          } else if (activeTicket) {
            status = 'waiting';
            statusText = t('待处理工单');
          } else if (doneTicket) {
            status = 'deliverable';
            statusText = t('成果可交付');
          } else if (!livePanel && !c.open) {
            status = 'offline';
            statusText = t('未开班');
          }
          if (unread > 0 && (status === 'idle' || status === 'deliverable' || status === 'offline')) {
            statusText = t('有 {n} 条新回信', { n: unread });
          }

          const snippet = extractIntentSnippet({
            isWorking: status === 'working',
            todo: myTodo,
            activeTicket,
            chat,
            fallbackMsg: lastMsg,
          });

          const lastImage = extractLastImage(chat);
          const popoverText = extractDetailedText(chat, snippet, 400);

          list.push({
            id: empId,
            name: String(c.name || t('AI员工')),
            dept: c.dept,
            role: c.role,
            avatar: c.avatar,
            accent: c.accent || '#e0a35f',
            model: c.model,
            panelId: pId,
            status,
            statusText,
            taskSnippet: snippet,
            at: realAt,
            lastMsg: cleanText(lastMsg, 60),
            replyAt,
            askingAt,
            unread,
            lastReplyId: replyIds.length ? replyIds[replyIds.length - 1] : String(c.last?.id || `seen:${empId}`),
            lastReplyAt: msgTime(lastByRole(chat, 'assistant')) || Number(c.at) || 0,
            isActiveInView: !!(pId && visibleActivePanels.has(pId)),
            starred: starredRef.current.has(empId) || (pId ? starredRef.current.has(pId) : false),
            lastImage,
            popoverText,
          });
        }

        // 2. 所有新开面板（会话/工具/画布等全量纳入监控）
        for (const [id, p] of Object.entries(panels)) {
          // 铁律：子代理分身、瞬态沙盒、隐藏面板一律不进侧边栏
          if (seenPanelIds.has(id) || p.hidden || (p as any).isSubagent || p.title?.startsWith('⚡') || id.includes('subagent')) continue;
          seenPanelIds.add(id);

          // 用户明确关闭了会话副面板的组件（showChat === false），回归纯工具态，不在成员会话列表中展示
          if (p.look?.showChat === false) continue;

          let lastMsg = '';
          const chat = panelFeed(p);
          const replyAt = msgTime(lastByRole(chat, 'assistant'));
          const askingAt = msgTime(lastByRole(chat, 'user'));
          const newSessionAt = Number((p as any).newSessionAt) || 0;
          // 绝对不使用 p.updatedAt，也绝不使用中间 tool/delta 消息时间！事件序模式严格只认回信与送信；空会话优先取 /new 新会话时间或创建时间
          const realAt = Math.max(replyAt, askingAt, newSessionAt, Number(p.createdAt) || 0);
          if (chat.length > 0) {
            // 倒序找第一条像人话的消息（避开系统构建输出与空消息）
            for (let i = chat.length - 1; i >= 0; i--) {
              const item = chat[i];
              if (!item) continue;
              const text = cleanText(item.content, 40);
              if (text && !lastMsg) {
                lastMsg = text;
              }
            }
          }
          if (!lastMsg && (newSessionAt || chat.some((m: any) => m && m.role === 'tool' && String(m.content).includes('/new')))) {
            lastMsg = t('新会话已开启');
          }

          const asstIds = replyIdsOf(p, chat);
          let unread = unreadOf(seenRef.current, id, asstIds, msgTime(lastByRole(chat, 'assistant')));

          // 用户眼皮底下正摆着这个面板（激活标签）—— 当场抹平未读
          if (visibleActivePanels.has(id)) {
            const lastRepId = asstIds.length ? asstIds[asstIds.length - 1] : '';
            seenRef.current[id] = { id: lastRepId, at: replyAt || realAt || 0 };
            unread = 0;
          }
          const isActuallyRunning = runningPanelsRef.current.has(id);
          const ps = isActuallyRunning ? 'working' : String(p.status || 'idle');
          let status: MonitorUnit['status'] = 'idle';
          let statusText = t('就绪');
          if (isActuallyRunning || ps === 'working') {
            status = 'working';
            statusText = t('正在输出');
          } else if (ps === 'confirm') {
            status = 'confirm';
            statusText = t('等你回话');
          } else if (ps === 'error') {
            status = 'error';
            statusText = t('上一轮失败');
          }
          if (unread > 0 && status === 'idle') statusText = t('有 {n} 条新回信', { n: unread });

          const myTodo = todoPanels[id];
          const snippet = extractIntentSnippet({
            isWorking: status === 'working',
            todo: myTodo,
            chat,
            fallbackMsg: p.title || t('工作面板'),
          });

          const isStarred = starredRef.current.has(id);
          /**
           * 面板头像：家族定下来就冻着（look.avatarKey，主进程在标题落地那轮写死），
           * 老面板没这个字段就**现算一次** —— 按 kind / 标题。第几张由面板 id 哈希挑，
           * 不落库；面板 id 一生不变，所以这张脸不会跳。
           */
          const panelAvatar = panelAvatarUrl(
            panelAvatarFileName(
              matchPanelAvatarFamily({
                avatarKey: p.look?.avatarKey,
                kind: p.kind,
                title: p.title,
              }),
              id,
            ),
          );
          const lastImage = extractLastImage(chat);
          const popoverText = extractDetailedText(chat, snippet, 400);

          if (isStarred) {
            starredMetaRef.current[id] = {
              id,
              name: p.title || t('新面板'),
              avatar: panelAvatar,
              accent: p.look?.accent || '#5b8cff',
              at: realAt,
              replyAt,
              askingAt,
              lastMsg: popoverText || lastMsg,
            };
            saveStarredMeta(starredMetaRef.current);
          }

          list.push({
            id,
            name: p.title || t('新面板'),
            avatar: panelAvatar,
            accent: p.look?.accent || '#5b8cff',
            panelId: id,
            status,
            statusText,
            taskSnippet: snippet,
            at: realAt,
            lastMsg,
            replyAt,
            askingAt,
            unread,
            lastReplyId: asstIds.length ? asstIds[asstIds.length - 1] : '',
            lastReplyAt: msgTime(lastByRole(chat, 'assistant')) || realAt,
            isActiveInView: visibleActivePanels.has(id),
            starred: isStarred,
            lastImage,
            popoverText,
          });
        }

        // 3. 检查⭐收藏面板：如果已被关闭（不在当前 seenPanelIds 里），依然保留在成员列表常驻！
        const closedList = await api.closed.list().catch(() => []);
        for (const sId of starredRef.current) {
          if (seenPanelIds.has(sId)) continue;
          seenPanelIds.add(sId);
          const meta = starredMetaRef.current[sId] || { id: sId, name: t('已收藏面板') };
          const closedInfo = closedList.find((c) => c.id === sId);
          const name = closedInfo?.title || meta.name || t('已收藏面板');
          // 铁律：已关闭面板的排序时间绝不能用 closedAt（关闭时间戳是最新瞬间，会错误冲到列表最顶端）！
          // 必须严格继承其最后一次送信/回信的真实消息时间戳 meta.at
          const savedAt = Number(meta.at) || 0;
          const savedReplyAt = Number(meta.replyAt) || (savedAt ? savedAt : 0);
          const savedAskingAt = Number(meta.askingAt) || (savedAt ? savedAt : 0);
          list.push({
            id: sId,
            name,
            avatar: meta.avatar,
            accent: meta.accent || '#5b8cff',
            panelId: sId,
            status: 'offline',
            statusText: t('已关闭 · 收藏常驻'),
            taskSnippet: t('已关闭 · 点击唤醒'),
            popoverText: meta.lastMsg || t('面板当前处于已关闭状态，点击或双击可随时重新唤醒。'),
            at: savedAt,
            replyAt: savedReplyAt,
            askingAt: savedAskingAt,
            starred: true,
          });
        }

        // 核心那边挂着"等你点头"的请求 —— 只有主进程知道，文件里看不出来，所以每拍问一次
        const askIds = list.filter((u) => u.panelId).map((u) => u.panelId as string);
        if (askIds.length) {
          const asks = await Promise.all(askIds.map((id) => api.chat.askState(id).catch(() => null)));
          askIds.forEach((id, i) => {
            const hit = asks[i];
            if (!hit || !hit.ask) return;
            const u = list.find((x) => x.panelId === id);
            if (u) {
              u.ask = true;
              u.statusText = t('等你点头');
            }
          });
        }

        // 置顶 > 有回信(1) > 正在输出(2) > 只被提问(3)，同层内正在输出优先、时间倒序
        saveSeen(seenRef.current); // 这一拍里起底/推过的水位要落盘
        setUnits(sortUnits(list, pinsRef.current));
      } catch {}
    }

    loadData();
    const timer = setInterval(loadData, 1000);
    return () => {
      unmounted = true;
      clearInterval(timer);
    };
  }, []);

  const toggleExpand = () => {
    setIsExpanded((prev) => {
      const next = !prev;
      localStorage.setItem('ensoul_sidebar_expanded', String(next));
      return next;
    });
  };

  /**
   * 光标进到某一行 → 就显示它。
   *
   * 原来这里有道 `if (activeUnit) return`：点开过一次之后，光标移到别的行不跟手了 ——
   * 卡片锁在旧那行上，只能靠再点一次换。现在光标到哪儿卡片跟到哪儿，
   * 「注意力在哪就显示谁」是这条侧栏唯一的交互原则。
   */
  const handleMouseEnter = (e: React.MouseEvent, unit: MonitorUnit) => {
    // 正拖着会话走：不弹卡片 —— 卡片会盖住底下的行，虚线框就点不亮了
    if (draggingPanelId) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setPopoverPos({ top: Math.min(Math.max(10, rect.top - 8), window.innerHeight - 440), left: rect.right + 10 });
      // 换人就把输入框换成他自己那份草稿 —— 卡片走哪儿，稿子跟哪儿
      setQuickInput(draftsRef.current[unit.id] || '');
      setHoveredUnit(unit);
      // 发送目标跟着可见的卡片走 —— 否则悬到 B 上、字却打给了 A
      setActiveUnit(unit);
    }, 120);
  };

  /**
   * 鼠标离开行（或卡片）→ 自己散掉。**没有例外**。
   *
   * 这是这条侧栏唯一的交互原则：注意力转移到哪儿，卡片就跟到哪儿；转移走了，它就没了。
   * 以前有两道闸把它钉死在屏幕上 —— 点开一次就 `!activeUnit` 不再关、焦点留在输入框里
   * 也不再关 —— 于是看着就是一个关不掉的框。
   * 打了一半的字不会丢：按单位分槽存在 draftsRef 里，下次悬回同一行还在。
   */
  const handleMouseLeave = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      if (cardHoveredRef.current) return;
      // 走之前把没发出去的字存进这个单位自己的槽
      const cur = activeUnitRef.current;
      if (cur) draftsRef.current[cur.id] = quickInputRef.current;
      setActiveUnit(null);
      setHoveredUnit(null);
      setPopoverPos(null);
    }, 180);
  };

  /** 看过了：水位推到这条最新的回信上，绿点和数字徽章立刻落下去 */
  const markSeen = (unit: MonitorUnit) => {
    // 无论是普通回信还是没有 replyId 的任务提醒，均记录最新水位（切勿使用 Date.now()，否则会把查看时间误当成活跃时间导致乱跳排序）
    const fallbackId = unit.lastReplyId || `read:${unit.at || 0}`;
    seenRef.current[unit.id] = { id: fallbackId, at: unit.lastReplyAt || unit.replyAt || unit.at || 0 };
    saveSeen(seenRef.current);
    setUnits((us) => us.map((u) => (u.id === unit.id ? { ...u, unread: 0 } : u)));
  };

  /** 一键全清：所有单位的水位推到各自最新，消除孤立/已失效未读状态 */
  const markAllSeen = () => {
    for (const u of units) {
      if (!u.unread) continue;
      const fallbackId = u.lastReplyId || `read:${u.at || 0}`;
      seenRef.current[u.id] = { id: fallbackId, at: u.lastReplyAt || u.replyAt || u.at || 0 };
    }
    saveSeen(seenRef.current);
    setUnits((us) => us.map((u) => ({ ...u, unread: 0 })));
  };

  /**
   * 行上按下指针的位置 —— 拖过就不再是"点击"（判据同收纳区：位移超过 6px 即算拖）。
   * 不这样拦一下，松手补的那个 click 会把卡片弹开，拖一次像做了两件事。
   */
  const rowDownRef = useRef<{ x: number; y: number } | null>(null);
  const rowMoved = (e: { clientX: number; clientY: number }) => {
    const d = rowDownRef.current;
    return !!d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6;
  };

  const handleClick = (e: React.MouseEvent, unit: MonitorUnit) => {
    if (rowMoved(e)) return; // 刚才是按住拖着走的，不算点
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setPopoverPos({ top: Math.min(Math.max(10, rect.top - 8), window.innerHeight - 440), left: rect.right + 10 });
    setActiveUnit(unit);
    setHoveredUnit(unit);
    // 单击只打开卡片/快捷通道，不标记已读 —— 只有真正点进面板（双击或点「跳转 ↗」）或者面板激活才算已读
    // 不自动聚焦：焦点一旦落进输入框，鼠标移开也得给键盘让路，卡片就赖着不走了
  };

  const handleDoubleClick = async (unit: MonitorUnit, e?: React.MouseEvent) => {
    if (e && rowMoved(e)) return; // 拖拽收尾的补发事件，不算双击
    markSeen(unit);
    closePopover();
    setOptimisticActiveId(unit.panelId || unit.id);
    await openOrWakeUnit(unit, wsRef.current);
  };

  /** 拖拽便签放置到 AI 员工身上：支持即时发送或带定时倒计时任务，并向便签卡片标记派单目标头像与倒计时 */
  const handleDropNote = async (target: MonitorUnit, rawData: string) => {
    if (!rawData || !target) return;
    let content = '';
    let delayMin = 0;
    let noteId = '';
    let memoFile = '';
    let boardId = '';
    let from = '';

    try {
      const parsed = JSON.parse(rawData);
      if (parsed && typeof parsed === 'object') {
        content = String(parsed.text || parsed.rawText || '').trim();
        delayMin = Number(parsed.delayMin) || 0;
        noteId = String(parsed.noteId || parsed.id || '');
        memoFile = String(parsed.memoFile || '');
        boardId = String(parsed.boardId || '');
        from = String(parsed.from || '');
      }
    } catch {
      content = rawData.trim();
    }

    // 投递正文只留前缀 + 原话（用户明确要求别的一律不许影响视线）。
    // 来源白板、甲方是谁写进账本 —— 员工回执时插件按它挑白板、补来源、装跳转。
    if (!content) return;
    if (!hasNotePrefix(content)) {
      content = `${NOTE_PREFIX}\n${content}`;
    }
    if (noteId || boardId) {
      // 账本写**两份键**：员工 id（老读法/人看的）和**目标面板 id**。
      // 回执是插件在员工那块面板里发的，它手上只有面板 id —— 只写员工 id 的话
      // drops[myPanel] 永远查不到，回执就只能靠"反查白板卡上的 targetEmp"，
      // 而那条路依赖卡已写好目标（见下面 stampCard 的位置约束）。
      const dropPanelId = target.panelId || '';
      const entry = {
        at: Date.now(),
        boardId: boardId || '',
        from: from || t('便利贴'),
        noteId,
        task: content,
        empId: target.id,
        empName: target.name,
        // 头像 / 强调色一起记账：回执兜底盖章时账本是唯一能问到"他长什么样"的地方，
        // 不给就只能画一个色块加首字（看着像认错了人）。
        empAvatar: target.avatar || '',
        empAccent: target.accent || '',
        due: delayMin > 0 ? Date.now() + delayMin * 60 * 1000 : 0,
      };
      try {
        const rawDrop = await api.fs.read('.ensoul/state/notes.drop.json');
        const doc = JSON.parse(rawDrop);
        const drops = doc && doc.drops && typeof doc.drops === 'object' ? doc.drops : {};
        drops[target.id] = entry;
        if (dropPanelId) drops[dropPanelId] = entry;
        // 一个员工只留最近一笔（同一时刻不可能有两张便签等他回执），别把账本攒成第二个历史
        const keys = Object.keys(drops);
        for (const k of keys.slice(0, Math.max(0, keys.length - 40))) delete drops[k];
        await api.fs.write('.ensoul/state/notes.drop.json', JSON.stringify({ at: Date.now(), drops }, null, 2));
      } catch {}
    }

    try {
      // 静默唤醒/捞回，不切换或激活目标面板，保持当前便利贴面板焦点
      await openOrWakeUnit(target, wsRef.current, false);
      let pId = target.panelId;
      if (!pId && target.id) {
        try {
          const cardRaw = await api.fs.read(`.ensoul/dispatch/cards/${target.id}.json`);
          if (cardRaw) {
            const cardObj = JSON.parse(cardRaw);
            if (cardObj && cardObj.panel) pId = cardObj.panel;
          }
        } catch {}
      }

      // 目标员工信息：用于便签卡片底部头像小圆标展示
      const targetEmp = {
        id: target.id,
        name: target.name,
        avatar: target.avatar,
        accent: target.accent,
        panelId: pId || '',
      };

      /**
       * 把目标员工写回便签卡 —— 插件回执时若账本直查不中，就靠卡上的 targetEmp 反查认领。
       * **必须在 api.chat.send 之前落盘**：员工可能一进来就回执，卡上没目标就认不回原卡，
       * 于是同一件事在板上长成两张（一张没章）。
       */
      const stampCard = async (patch: Record<string, any>) => {
        if (!memoFile || !noteId) return;
        try {
          const memoRaw = await api.fs.read(memoFile);
          const memoList = JSON.parse(memoRaw);
          if (Array.isArray(memoList)) {
            const updated = memoList.map((p: any) => (p.id === noteId ? { ...p, targetEmp, ...patch } : p));
            await api.fs.write(memoFile, JSON.stringify(updated, null, 2));
          }
        } catch {}
      };

      if (delayMin > 0) {
        // 定时倒计时：给便签插件记一条"到点自己发"的账（插件每轮扫它，到点替我发出去）
        try {
          const schedRaw = await api.fs.read('.ensoul/state/notes.timers.json');
          const schedDoc = JSON.parse(schedRaw) || { at: Date.now(), seq: 0, tasks: [], due: [] };
          if (!Array.isArray(schedDoc.tasks)) schedDoc.tasks = [];
          schedDoc.seq = (Number(schedDoc.seq) || 0) + 1;
          const dueTime = Date.now() + delayMin * 60 * 1000;
          schedDoc.tasks.push({
            id: 't' + schedDoc.seq,
            kind: 'after',
            text: t('[定时便签发给 {who}]：{what}', { who: target.name, what: content }),
            due: dueTime,
            panelId: pId || '',
            empId: target.id,
            empName: target.name,
            every: 60,
            createdAt: Date.now(),
            autoSend: true,
            sendText: content,
            noteId,
            memoFile,
          });
          await api.fs.write('.ensoul/state/notes.timers.json', JSON.stringify(schedDoc, null, 2));

          // 便签回写：目标头像与倒计时立刻上卡（这单还没发出去，等定时到点）
          await stampCard({ targetDue: dueTime, targetSent: false });
        } catch (err) {
          console.warn('[SidebarMonitor] 定时便签写入失败:', err);
        }
      } else if (pId) {
        // 立刻发送。**先盖章后发**：反过来（发完再写卡）员工若抢在前面回执，
        // 卡上还没有 targetEmp，回执就认不回原卡 —— 板上会凭空多一张没章的副本。
        await stampCard({ targetSent: true });
        try {
          await api.chat.send(pId, content);
        } catch {}
      }
    } catch (e) {
      console.warn('[SidebarMonitor] 拖拽便签派单失败:', e);
    }
  };
  const handleSend = async (target: MonitorUnit | null) => {
    if (!quickInput.trim() || !target) return;
    setSending(true);
    const text = quickInput.trim();
    setQuickInput('');
    const cur = target.id;
    if (draftsRef.current[cur]) delete draftsRef.current[cur];

    try {
      const pId = target.panelId;
      const inWs = pId && wsRef.current?.panels && wsRef.current.panels[pId];
      if (inWs) {
        await api.chat.send(pId, text);
      } else {
        await openOrWakeUnit(target, wsRef.current);
        if (pId) {
          try {
            await api.chat.send(pId, text);
          } catch {}
        }
      }
    } catch {} finally {
      setSending(false);
    }
  };

  const togglePin = (id: string) => {
    const cur = pinsRef.current;
    const next = cur.has(id) ? [...cur].filter((x) => x !== id) : [id, ...cur];
    pinsRef.current = new Set(next);
    setPins(next);
    localStorage.setItem(PINS_KEY, JSON.stringify(next));
    setUnits((us) => sortUnits(us, pinsRef.current));
  };

  /** ⭐ 收藏/取消收藏面板：收藏后面板在列表中常驻，关闭后不从列表消失 */
  const toggleStar = (unit: MonitorUnit) => {
    const targetId = unit.panelId || unit.id;
    const cur = starredRef.current;
    const next = new Set(cur);
    const nextMeta = { ...starredMetaRef.current };
    if (next.has(targetId)) {
      next.delete(targetId);
      delete nextMeta[targetId];
    } else {
      next.add(targetId);
      nextMeta[targetId] = {
        id: targetId,
        name: unit.name,
        avatar: unit.avatar,
        accent: unit.accent,
        at: unit.at,
        replyAt: unit.replyAt,
        askingAt: unit.askingAt,
        lastMsg: unit.popoverText || unit.lastMsg,
      };
    }
    starredRef.current = next;
    starredMetaRef.current = nextMeta;
    setStarred(next);
    saveStarred(next);
    saveStarredMeta(nextMeta);
    setUnits((us) =>
      us.map((u) => {
        const uid = u.panelId || u.id;
        return uid === targetId ? { ...u, starred: next.has(targetId) } : u;
      })
    );
    setHoveredUnit((prev) => (prev && (prev.panelId || prev.id) === targetId ? { ...prev, starred: next.has(targetId) } : prev));
    setActiveUnit((prev) => (prev && (prev.panelId || prev.id) === targetId ? { ...prev, starred: next.has(targetId) } : prev));
  };

  /** 浮窗中为面板重命名并同步持久化 */
  const saveRename = async () => {
    const cur = hoveredUnit || activeUnit;
    if (!cur) return;
    const trimmed = editingName.trim();
    setEditingId(null);
    if (!trimmed || trimmed === cur.name) return;

    const pId = cur.panelId || cur.id;
    if (cur.panelId) {
      await api.panel.patch(cur.panelId, { title: trimmed }).catch(() => {});
    }
    if (starredMetaRef.current[pId]) {
      starredMetaRef.current[pId].name = trimmed;
      saveStarredMeta(starredMetaRef.current);
    }
    setHoveredUnit((prev) => (prev && (prev.panelId || prev.id) === pId ? { ...prev, name: trimmed } : prev));
    setActiveUnit((prev) => (prev && (prev.panelId || prev.id) === pId ? { ...prev, name: trimmed } : prev));
    setUnits((us) => us.map((u) => ((u.panelId || u.id) === pId ? { ...u, name: trimmed } : u)));
  };

  /** 收起卡片（Esc、点别处都走这儿）。草稿先存档，下次悬回同一行还在 */
  const closePopover = () => {
    const cur = activeUnitRef.current;
    if (cur) draftsRef.current[cur.id] = quickInputRef.current;
    setActiveUnit(null);
    setHoveredUnit(null);
    setPopoverPos(null);
    setQuickInput('');
  };

  /**
   * 除了"光标移开"，再多两条散的路径：Esc、以及点卡片和侧栏之外的任何地方。
   *
   * 光标移开是主路（注意力转移就该自己消失）；这两条是给键盘用户和
   * "鼠标停在别处顺手一点"补的，免得非得把光标挪回来才能让卡片走。
   */
  useEffect(() => {
    if (!popoverPos) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closePopover();
      }
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (popRef.current?.contains(t)) return;
      if (rootRef.current?.contains(t)) return;
      closePopover();
    };
    window.addEventListener('keydown', onKey, true);
    // 捕获阶段：别等别的处理器先把事件吃了
    document.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown, true);
    };
  }, [popoverPos]);

  const currentDisplay = hoveredUnit || activeUnit;
  const workingCount = units.filter((u) => u.status === 'working').length;
  const unreadTotal = units.reduce((n, u) => n + (u.unread || 0), 0);
  const q = query.trim().toLowerCase();
  const shown = q
    ? units.filter((u) => `${u.name} ${u.dept || ''} ${u.role || ''} ${u.taskSnippet || ''} ${u.lastMsg || ''}`.toLowerCase().includes(q))
    : units;

  useLayoutEffect(() => {
    const prevTops = prevTopsRef.current;
    const currentEls = itemElsRef.current;
    const nextTops = new Map<string, number>();

    currentEls.forEach((el, id) => {
      const currentTop = el.offsetTop;
      nextTops.set(id, currentTop);

      const prevTop = prevTops.get(id);
      if (prevTop !== undefined) {
        const deltaY = prevTop - currentTop;
        if (Math.abs(deltaY) > 1) {
          // 1. Invert: 将卡片瞬间反转到重排前的物理位置
          el.style.transform = `translateY(${deltaY}px)`;
          el.style.transition = 'none';
          if (deltaY > 0) {
            // 向上跃升的卡片适度提升层级，避免被下移卡片遮盖
            el.style.zIndex = '3';
          }

          // 强制同步 Reflow 提交初始位置
          void el.offsetHeight;

          // 2. Play: 下一帧以阻尼贝塞尔曲线平滑滑动回目标新位置
          requestAnimationFrame(() => {
            el.style.transition = 'transform 0.36s cubic-bezier(0.16, 1, 0.3, 1)';
            el.style.transform = '';

            const onEnd = () => {
              el.style.transition = '';
              el.style.zIndex = '';
              el.removeEventListener('transitionend', onEnd);
            };
            el.addEventListener('transitionend', onEnd);
          });
        }
      }
    });

    prevTopsRef.current = nextTops;
  }, [shown]);

  return (
    <aside ref={rootRef} className={`sidebar-monitor-root ${isExpanded ? 'is-expanded' : 'is-collapsed'}`}>
      <div className="sbm-head">
        <button className="sbm-toggle-btn" onClick={toggleExpand} title={isExpanded ? t('折叠为头像栏') : t('展开信息栏')}>
          {isExpanded ? '◀' : '▶'}
        </button>
        {isExpanded && (
          <>
            {searchOpen ? (
              <div className="sbm-head-search">
                <input
                  ref={searchInputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('搜索成员 / 面板…')}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setQuery('');
                      setSearchOpen(false);
                    }
                  }}
                />
                {query && (
                  <button className="sbm-head-search-clear" onClick={() => setQuery('')} title={t('清空')}>
                    ✕
                  </button>
                )}
                <button
                  className="sbm-head-search-close"
                  onClick={() => {
                    setQuery('');
                    setSearchOpen(false);
                  }}
                  title={t('关闭搜索')}
                >
                  ✕
                </button>
              </div>
            ) : (
              <>
                <span className="sbm-head-title" title={snapBad || undefined}>
                  {snapBad ? t('成员列表 ⚠') : t('成员列表')}
                </span>
                <span style={{ flex: 1 }} />
                {snapBad ? <span className="sbm-warn" title={snapBad}>{t('快照异常')}</span> : null}
                {workingCount > 0 && <span className="sbm-busy-tag"><i />{workingCount}</span>}
                {unreadTotal > 0 && (
                  <button className="sbm-readall-btn" onClick={markAllSeen} title={t('全部标记为已读')}>
                    {t('全部已读')}
                  </button>
                )}
                <button
                  className={`sbm-toggle-btn ${query ? 'is-active' : ''}`}
                  onClick={() => {
                    setSearchOpen(true);
                    setTimeout(() => searchInputRef.current?.focus(), 50);
                  }}
                  title={t('搜索成员 / 面板')}
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="6.5" cy="6.5" r="4.5" />
                    <line x1="10" y1="10" x2="14.5" y2="14.5" />
                  </svg>
                </button>
                <button className="sbm-toggle-btn sbm-hide-btn" onClick={onHide} title={t('彻底隐藏（Ctrl+B 可调出）')}>
                  ✕
                </button>
              </>
            )}
          </>
        )}
      </div>

      {/* 点列表空白处也收起卡片 —— 行的 onClick 已经 stopPropagation，不会误触发 */}
      <div className="sbm-list" onClick={() => activeUnit && closePopover()}>
        {shown.map((unit) => {
          const dot = dotOf(unit);
          const isWorking = dot === 'working';
          const pinned = pins.includes(unit.id);
          const initial = unit.name ? unit.name.trim().charAt(0) : '?';
          const isInReview =
            (optimisticActiveId ? (unit.panelId === optimisticActiveId || unit.id === optimisticActiveId) : false) ||
            (unit.panelId ? visibleActivePanels.has(unit.panelId) : false) ||
            visibleActivePanels.has(unit.id);

          return (
            <div
              key={unit.id}
              ref={(el) => {
                if (el) itemElsRef.current.set(unit.id, el);
                else itemElsRef.current.delete(unit.id);
              }}
              data-unit-id={unit.id}
              data-panel-id={unit.panelId || ''}
              title={unit.panelId ? t('{s}（按住可拖到布局里挪动 / 在落点打开）', { s: unit.statusText }) : unit.statusText}
              className={`sbm-item is-${dot} ${isWorking ? 'is-active' : ''} ${pinned ? 'is-pinned' : ''} ${isInReview ? 'is-in-review' : ''} ${dragOverUnitId === unit.id ? 'is-drag-target' : ''}${unit.panelId && onGrab ? ' is-grabbable' : ''}${draggingPanelId && unit.panelId === draggingPanelId ? ' is-dragging' : ''}`}
              onPointerDown={(e) => {
                rowDownRef.current = { x: e.clientX, y: e.clientY };
                if (unit.panelId && e.button === 0 && onGrab) {
                  const p = ws?.panels?.[unit.panelId];
                  onGrab(unit.panelId, unit.name, p ? (p.hidden ? 'hidden' : 'visible') : 'closed', e, {
                    accent: unit.accent,
                    avatar: unit.avatar,
                  });
                }
              }}
              onMouseEnter={(e) => handleMouseEnter(e, unit)}
              onMouseLeave={handleMouseLeave}
              onClick={(e) => handleClick(e, unit)}
              onDoubleClick={(e) => handleDoubleClick(unit, e)}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
              }}
              onDragEnter={() => setDragOverUnitId(unit.id)}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                if (dragOverUnitId === unit.id) setDragOverUnitId(null);
              }}
              onDrop={async (e) => {
                e.preventDefault();
                setDragOverUnitId(null);
                const noteJson = e.dataTransfer.getData('application/x-ensoul-note');
                const text = noteJson || e.dataTransfer.getData('text/plain');
                if (text) {
                  await handleDropNote(unit, text);
                }
              }}
            >
              <div className={`sbm-avatar-box ${isWorking ? 'is-working' : ''}`}>
                <div className="sbm-avatar-circle" style={{ backgroundColor: unit.accent || '#475569' }}>
                  {unit.avatar ? <img src={unit.avatar} alt="" /> : initial}
                </div>
                {unit.starred && (
                  <div className="sbm-avatar-star" title={t('已收藏常驻')}>
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        d="M 10.7 5.1 Q 12.0 3.0 13.3 5.1 L 14.2 6.4 Q 15.1 7.8 16.6 8.2 L 18.1 8.6 Q 20.6 9.2 19.0 11.1 L 18.0 12.4 Q 16.9 13.6 17.0 15.2 L 17.1 16.8 Q 17.3 19.3 15.0 18.4 L 13.5 17.8 Q 12.0 17.2 10.5 17.8 L 9.0 18.4 Q 6.7 19.3 6.9 16.8 L 7.0 15.2 Q 7.1 13.6 6.0 12.4 L 5.0 11.1 Q 3.4 9.2 5.9 8.6 L 7.4 8.2 Q 8.9 7.8 9.8 6.4 Z"
                        fill="currentColor"
                        stroke="#1e293b"
                        strokeWidth="1.6"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                    </svg>
                  </div>
                )}
                <div className={`sbm-dot ${dot}`} />
                {unit.unread && unit.unread > 0 ? (
                  <span className="sbm-badge">{unit.unread}</span>
                ) : null}
              </div>

              <div className="sbm-expanded-info">
                <div className="sbm-name-row">
                  <span className="sbm-name">{unit.name}</span>
                  <button
                    className={`sbm-pin-btn ${pinned ? 'is-on' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      togglePin(unit.id);
                    }}
                    title={pinned ? t('取消置顶') : t('置顶')}
                  >
                    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
                      <path
                        d={pinned ? 'M4 1.5h8L10.6 6l1.9 2v1.4H3.5V8L5.4 6 4 1.5Z' : 'M4.7 1.5h6.6L10 6l1.8 1.9v1.3H4.2V7.9L6 6 4.7 1.5Z'}
                        fill={pinned ? 'currentColor' : 'none'}
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinejoin="round"
                      />
                      <path d="M8 9v5.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                    </svg>
                  </button>
                  <span className="sbm-time">{formatRelativeTime(Math.max(unit.replyAt || 0, unit.askingAt || 0, unit.at || 0))}</span>
                </div>
                <div className="sbm-snippet">{unit.taskSnippet || t('暂无动态')}</div>
              </div>
            </div>
          );
        })}
        {shown.length === 0 && isExpanded && (
          <div className="sbm-empty">{units.length === 0 ? t('暂无成员') : t('没有匹配的成员')}</div>
        )}
      </div>

      {currentDisplay &&
        popoverPos &&
        createPortal(
          <div
            ref={popRef}
            className="sbm-popover"
            style={{ top: `${popoverPos.top}px`, left: `${popoverPos.left}px` }}
            onMouseEnter={() => {
              cardHoveredRef.current = true;
              if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
            }}
            onMouseLeave={() => {
              cardHoveredRef.current = false;
              handleMouseLeave();
            }}
          >
            <div className="sbm-pop-head">
              <div className="sbm-pop-title">
                {editingId === currentDisplay.id ? (
                  <input
                    ref={editNameInputRef}
                    className="sbm-pop-name-input"
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onBlur={saveRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveRename();
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    autoFocus
                  />
                ) : (
                  <div
                    className="sbm-pop-name-wrap"
                    onClick={() => {
                      setEditingName(currentDisplay.name);
                      setEditingId(currentDisplay.id);
                      setTimeout(() => editNameInputRef.current?.select(), 50);
                    }}
                    title={t('点击修改名称')}
                  >
                    <span className="sbm-pop-name">{currentDisplay.name}</span>
                    <button
                      className="sbm-pop-edit-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingName(currentDisplay.name);
                        setEditingId(currentDisplay.id);
                        setTimeout(() => editNameInputRef.current?.select(), 50);
                      }}
                      title={t('重命名')}
                    >
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M11.5 2.5a1.8 1.8 0 0 1 2.5 2.5L5 14l-4 1 1-4 9.5-9.5z" />
                      </svg>
                    </button>
                  </div>
                )}
                {currentDisplay.dept && <span className="sbm-pop-dept">{currentDisplay.dept}</span>}
                <button
                  className={`sbm-pop-star ${starred.has(currentDisplay.panelId || currentDisplay.id) ? 'is-on' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleStar(currentDisplay);
                  }}
                  title={starred.has(currentDisplay.panelId || currentDisplay.id) ? t('已收藏（关闭后在列表中常驻）') : t('收藏此面板（关闭后在列表中常驻）')}
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill={starred.has(currentDisplay.panelId || currentDisplay.id) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
                    <path d="M8 1.8l1.8 3.9 4.3.6-3.1 3 0.7 4.3L8 11.6l-3.7 2 0.7-4.3-3.1-3 4.3-.6L8 1.8z" />
                  </svg>
                </button>
              </div>
              <button className="sbm-pop-jump" onClick={() => handleDoubleClick(currentDisplay)}>
                {t('跳转')}
              </button>
            </div>

            <div className="sbm-pop-body">
              <div className="sbm-pop-status">
                <b style={{ color: dotColor(dotOf(currentDisplay)) }}>
                  ● {currentDisplay.statusText}
                </b>
                <span>{formatRelativeTime(Math.max(currentDisplay.replyAt || 0, currentDisplay.askingAt || 0, currentDisplay.at || 0))}</span>
              </div>

              {currentDisplay.lastImage && (
                <div className="sbm-pop-image-wrap">
                  <img
                    src={toShotUrl(currentDisplay.lastImage)}
                    alt=""
                    className="sbm-pop-image"
                    title={t('最新对话图片')}
                  />
                </div>
              )}

              {currentDisplay.popoverText ? (
                <div className={`sbm-pop-block ${currentDisplay.status === 'working' ? 'is-active' : ''}`}>
                  <div className="sbm-pop-block-label">{currentDisplay.status === 'working' ? t('正在推进') : t('最新内容')}</div>
                  <div className="sbm-pop-block-text">{currentDisplay.popoverText}</div>
                </div>
              ) : currentDisplay.taskSnippet ? (
                <div className="sbm-pop-block is-active">
                  <div className="sbm-pop-block-label">{t('正在推进')}</div>
                  <div className="sbm-pop-block-text">{currentDisplay.taskSnippet}</div>
                </div>
              ) : currentDisplay.lastMsg ? (
                <div className="sbm-pop-block">
                  <div className="sbm-pop-block-label">{t('最新发言')}</div>
                  <div className="sbm-pop-block-text">{currentDisplay.lastMsg}</div>
                </div>
              ) : (
                <div className="sbm-pop-empty">{t('暂无活跃任务')}</div>
              )}
            </div>

            <div className="sbm-pop-input">
              <input
                ref={inputRef}
                placeholder={t('发指令给 {name}…', { name: currentDisplay.name })}
                value={quickInput}
                onChange={(e) => setQuickInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSend(currentDisplay);
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    closePopover();
                  }
                }}
              />
              <button className="sbm-send-btn" onClick={() => handleSend(currentDisplay)} disabled={sending}>
                {t('发送')}
              </button>
            </div>
          </div>,
          document.body
        )}
    </aside>
  );
}
