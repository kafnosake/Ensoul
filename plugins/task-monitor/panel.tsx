import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PanelFaceProps } from '../../src/shared/types';

/**
 * 任务监视器 —— 方案 A 贴边悬浮抽屉大盘
 *
 * 1. 抽屉式侧边挂件形态：支持极窄折叠 (50px 纯头像) 与平滑展开 (260px 完整态势清单)。
 * 2. 真实活跃时间驱动排序：跨 Panel.updatedAt / Chat 最后发言 / 工单流转全量求最大时间戳，杜绝假排序。
 * 3. 运行中流光转圈：模型思考中、工单处理中或待办推进中激活顺时针光流。
 * 4. 悬停浮出简报 (Portal)：挂载于 document.body，防裁剪、带毛玻璃与微动效。
 * 5. 快速会话与双击跳转：内嵌 Mini 输入框即发即回，双击主工作区安全唤醒与聚焦。
 */

type UnitStatus = 'working' | 'waiting' | 'deliverable' | 'idle' | 'offline';

interface MonitorUnit {
  id: string;
  name: string;
  type: 'agent' | 'panel';
  dept?: string;
  role?: string;
  avatar?: string;
  accent?: string;
  model?: string;
  panelId?: string;
  status: UnitStatus;
  statusText: string;
  taskTitle?: string;
  taskSnippet?: string;
  deliverFiles?: string[];
  deliverNote?: string;
  at: number; // 绝对真实的时间戳
  lastMsg?: string;
  lastRole?: string;
}

const ESCHAT_FILE = '.ensoul/state/eschat.json';
/** 跟主进程 fs:read 的 300KB 对齐 —— 超了就说明读回来会是一句占位文字，不是 JSON */
const SNAP_MAX = 300_000;
const ESCHAT_NAME = 'eschat.json';
const BOARD_FILE = '.ensoul/state/dispatch.board.json';
const INBOX_FILE = '.ensoul/state/dispatch.inbox.json';
const TODO_FILE = '.ensoul/state/todo.json';
const CMD_FILE = '.ensoul/state/dispatch.cmd.json';

function getEnsoulApi() {
  if (typeof window !== 'undefined' && (window as any).ensoul) {
    return (window as any).ensoul;
  }
  return null;
}

function safeParse<T>(raw: string, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * 快照读坏的判据：read 回来**不是 JSON**（空串 = 还没写出来，不算坏）。
 *
 * 为什么会读到不是 JSON 的东西：文件超过主进程 fs:read 的 300KB 上限时，回来的
 * 是一句占位文字。它流进 JSON.parse 只会炸，而 fast 兜底成空数组的后果是
 * **大盘上的人一起消失** —— 用户以为员工没了，其实名册好好的。
 * 所以坏掉时保留上一次成功那份，只说一句"读不出来"。
 */
function badSnap(raw: string): boolean {
  const s = String(raw || '').trim();
  if (!s) return false;
  try {
    JSON.parse(s);
    return false;
  } catch {
    return true;
  }
}

function truncate(str: string, len: number): string {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '…' : str;
}

function formatRelativeTime(ts?: number): string {
  if (!ts || ts <= 0) return t('未开始');
  const diff = Date.now() - ts;
  if (diff < 15000) return t('刚刚');
  if (diff < 60000) return t('{n} 秒前', { n: Math.floor(diff / 1000) });
  if (diff < 3600000) return t('{n} 分钟前', { n: Math.floor(diff / 60000) });
  if (diff < 86400000) return t('{n} 小时前', { n: Math.floor(diff / 3600000) });
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function TaskMonitorPanel({ fs, panel }: PanelFaceProps) {
  const [units, setUnits] = useState<MonitorUnit[]>([]);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const [isExpanded, setIsExpanded] = useState(false);
  /** 快照读坏时顶上那句提示（'' = 一切正常） */
  const [snapBad, setSnapBad] = useState('');
  /** 名册读坏时接着用这一份（上一次成功解析的 contacts）—— 绝不把自己清空 */
  const lastContactsRef = useRef<any[]>([]);

  // 悬浮/会话气泡状态
  const [activeUnit, setActiveUnit] = useState<MonitorUnit | null>(null);
  const [isPinned, setIsPinned] = useState(false);
  const [portalPos, setPortalPos] = useState<{ top: number; left: number } | null>(null);

  // 会话输入
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const hoverTimerRef = useRef<any>(null);
  const cardHoveredRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const api = getEnsoulApi();

  // 1. 订阅模型真实运行态
  useEffect(() => {
    if (!api || !api.chat) return;

    if (typeof api.chat.running === 'function') {
      api.chat.running().then((list: any[]) => {
        if (Array.isArray(list)) {
          setRunningIds(new Set(list.map((x) => String(x.panelId || ''))));
        }
      }).catch(() => {});
    }

    if (typeof api.chat.onRunning === 'function') {
      const unsub = api.chat.onRunning((evt: { panelId: string; running: boolean }) => {
        setRunningIds((prev) => {
          const next = new Set(prev);
          if (evt.running) next.add(evt.panelId);
          else next.delete(evt.panelId);
          return next;
        });
      });
      return () => unsub();
    }
  }, [api]);

  // 2. 真实活跃状态与全量时间戳聚合（解决假排序）
  useEffect(() => {
    let unmounted = false;

    async function loadData() {
      try {
        // 先看大小：快照被撑过 300KB 时，read 回来的是一句占位文字、不是 JSON
        const big = await fs
          .list('.ensoul/state')
          .then((l) => Number((l.find((x) => x.name === ESCHAT_NAME) || {}).size || 0) > SNAP_MAX, () => false);
        const [eschatRaw, inboxRaw, todoRaw, wsState] = await Promise.all([
          fs.read(ESCHAT_FILE).catch(() => ''),
          fs.read(INBOX_FILE).catch(() => ''),
          fs.read(TODO_FILE).catch(() => ''),
          api && api.workspace ? api.workspace.get().catch(() => null) : Promise.resolve(null),
        ]);

        if (unmounted) return;

        const eschatData = safeParse<any>(eschatRaw, { contacts: [] });
        const inboxData = safeParse<any>(inboxRaw, { entries: [] });
        const todoData = safeParse<any>(todoRaw, { panels: {} });

        // 名册读坏 → 用上一次那份（空数组会让大盘"全员消失"）
        const eschatBroken = big || badSnap(eschatRaw);
        const contacts: any[] = eschatBroken
          ? lastContactsRef.current
          : Array.isArray(eschatData?.contacts)
            ? eschatData.contacts
            : lastContactsRef.current;
        if (!eschatBroken) lastContactsRef.current = contacts;
        setSnapBad(
          eschatBroken || badSnap(inboxRaw) || badSnap(todoRaw)
            ? t('快照读不出来（文件太大或坏了）—— 下面还是上一次那份，员工一个没丢。')
            : '',
        );
        const inboxEntries: any[] = Array.isArray(inboxData?.entries) ? inboxData.entries : [];
        const todoPanels: Record<string, any> = (todoData && todoData.panels) || {};
        const activePanels: Record<string, any> = (wsState && wsState.panels) || {};

        const list: MonitorUnit[] = [];
        const seenPanelIds = new Set<string>();
        const seenNames = new Set<string>();

        // ① 提取全体编制员工
        for (const c of contacts) {
          const empId = String(c.id);
          const empName = String(c.name || t('AI员工'));
          seenNames.add(empName);

          // 寻找其活面板
          let livePanel: any = null;
          let pId = c.panel ? String(c.panel) : undefined;

          if (pId && activePanels[pId]) {
            livePanel = activePanels[pId];
          } else {
            // 通过名字或 spec 关联活面板
            for (const [id, p] of Object.entries(activePanels)) {
              if (p.title === empName || (p.spec && p.spec.employeeId === empId)) {
                livePanel = p;
                pId = id;
                break;
              }
            }
          }

          if (pId) seenPanelIds.add(pId);

          const isRunning = pId ? runningIds.has(pId) : false;

          // 关联工单
          const activeTicket = inboxEntries.find(
            (t) => (t.holder === pId || (t.token && t.by === empId)) && t.status !== 'done' && t.status !== 'cancelled'
          );
          const doneTicket = inboxEntries.find(
            (t) => (t.holder === pId || t.by === empId) && t.status === 'done' && Date.now() - (t.doneAt || 0) < 3600000 * 2
          );

          // 关联 Todo 清单
          const panelTodo = pId ? todoPanels[pId] : null;
          const inProgressTodo = Array.isArray(panelTodo?.items)
            ? panelTodo.items.find((item: any) => item.status === 'in_progress')
            : null;

          // 判定状态
          let status: UnitStatus = 'idle';
          let statusText = t('空闲待命');

          if (isRunning) {
            status = 'working';
            statusText = t('思考执行中…');
          } else if (activeTicket) {
            status = 'working';
            statusText = activeTicket.note ? t('工单执行: {n}', { n: activeTicket.note }) : t('工单执行中');
          } else if (inProgressTodo) {
            status = 'working';
            statusText = t('进行中: {c}', { c: inProgressTodo.content });
          } else if (doneTicket && doneTicket.files && doneTicket.files.length) {
            status = 'deliverable';
            statusText = t('已交付成果 ({n} 个文件)', { n: doneTicket.files.length });
          } else if (livePanel || c.open) {
            status = 'idle';
            statusText = t('在线就绪');
          } else {
            status = 'offline';
            statusText = t('后台就绪');
          }

          let taskSnippet = '';
          if (activeTicket) {
            taskSnippet = activeTicket.task || '';
          } else if (inProgressTodo) {
            taskSnippet = inProgressTodo.content || '';
          } else if (doneTicket) {
            taskSnippet = doneTicket.note || (doneTicket.files && doneTicket.files.join(', ')) || '';
          }

          // ★ 核心修复：真实活跃时间绝对最大值
          let realAt = Number(c.at) || 0;
          let lastMsg = c.last ? String(c.last.text || '') : undefined;
          let lastRole = c.last ? String(c.last.role || '') : undefined;

          if (livePanel) {
            if (livePanel.updatedAt) {
              realAt = Math.max(realAt, Number(livePanel.updatedAt));
            }
            if (Array.isArray(livePanel.chat) && livePanel.chat.length > 0) {
              for (let i = livePanel.chat.length - 1; i >= 0; i--) {
                const m = livePanel.chat[i];
                if (m && m.content) {
                  lastMsg = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                  lastRole = m.role;
                  if (m.at) realAt = Math.max(realAt, Number(m.at));
                  break;
                }
              }
            }
          }

          if (activeTicket && activeTicket.at) {
            realAt = Math.max(realAt, Number(activeTicket.at));
          }
          if (doneTicket && doneTicket.doneAt) {
            realAt = Math.max(realAt, Number(doneTicket.doneAt));
          }

          list.push({
            id: empId,
            name: empName,
            type: 'agent',
            dept: c.dept,
            role: c.role,
            avatar: c.avatar,
            accent: c.accent || '#e0a35f',
            model: c.model,
            panelId: pId,
            status,
            statusText,
            taskTitle: activeTicket ? `工单: ${activeTicket.token}` : inProgressTodo ? t('正在推进') : undefined,
            taskSnippet,
            deliverFiles: doneTicket ? doneTicket.files : undefined,
            deliverNote: doneTicket ? doneTicket.note : undefined,
            at: realAt,
            lastMsg,
            lastRole,
          });
        }

        // ② 补充活跃的非编制独立面板
        for (const [pid, p] of Object.entries(activePanels)) {
          if (seenPanelIds.has(pid) || pid === panel.id) continue;
          if (seenNames.has(p.title)) continue;

          const isRunning = runningIds.has(pid);
          const panelTodo = todoPanels[pid];
          const inProgressTodo = Array.isArray(panelTodo?.items)
            ? panelTodo.items.find((item: any) => item.status === 'in_progress')
            : null;

          let status: UnitStatus = 'idle';
          let statusText = t('就绪');

          if (isRunning) {
            status = 'working';
            statusText = t('生成中…');
          } else if (inProgressTodo) {
            status = 'working';
            statusText = t('进行中: {c}', { c: inProgressTodo.content });
          }

          let lastAt = Number(p.updatedAt) || 0;
          let lastContent = '';
          let lastRole = '';

          if (Array.isArray(p.chat) && p.chat.length > 0) {
            for (let i = p.chat.length - 1; i >= 0; i--) {
              const m = p.chat[i];
              if (m && m.content) {
                lastContent = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                lastRole = m.role;
                if (m.at) lastAt = Math.max(lastAt, Number(m.at));
                break;
              }
            }
          }

          list.push({
            id: pid,
            name: p.title || t('工作面板'),
            type: 'panel',
            dept: p.kind || t('面板'),
            panelId: pid,
            accent: '#38bdf8',
            status,
            statusText,
            taskSnippet: inProgressTodo ? inProgressTodo.content : undefined,
            at: lastAt,
            lastMsg: lastContent,
            lastRole,
          });
        }

        // ★ 核心时间倒序（谁刚刚发言或动过，谁立刻升至最前）
        list.sort((a, b) => b.at - a.at);

        setUnits(list);
      } catch {}
    }

    loadData();
    const interval = setInterval(loadData, 1000);
    return () => {
      unmounted = true;
      clearInterval(interval);
    };
  }, [fs, api, runningIds, panel.id]);

  // ★ 双击主工作区智能寻址跳转
  const jumpToMainWorkspace = async (targetUnit: MonitorUnit) => {
    if (!api) return;

    try {
      const wsNow = api.workspace ? await api.workspace.get().catch(() => null) : null;
      if (!wsNow || !wsNow.layout) {
        if (targetUnit.panelId && api.panel?.activate) {
          api.panel.activate(targetUnit.panelId);
        }
        return;
      }

      // 寻找非当前侧边栏所在的主标签组
      let sidebarTabId: string | null = null;
      const findSidebar = (node: any) => {
        if (!node) return;
        if (Array.isArray(node.panels) && node.panels.includes(panel.id)) {
          sidebarTabId = node.id;
          return;
        }
        if (node.children) {
          findSidebar(node.children[0]);
          findSidebar(node.children[1]);
        }
      };
      findSidebar(wsNow.layout);

      let mainTabId: string | null = null;
      let maxPanels = -1;
      const findMain = (node: any) => {
        if (!node) return;
        if (Array.isArray(node.panels) && node.id !== sidebarTabId) {
          if (node.panels.length > maxPanels) {
            maxPanels = node.panels.length;
            mainTabId = node.id;
          }
        }
        if (node.children) {
          findMain(node.children[0]);
          findMain(node.children[1]);
        }
      };
      findMain(wsNow.layout);

      const targetTab = mainTabId || sidebarTabId;

      if (targetUnit.panelId) {
        if (api.panel?.activate) {
          api.panel.activate(targetUnit.panelId);
        }
        return;
      }

      // 未开工的员工，下发唤醒命令
      if (targetUnit.type === 'agent') {
        await fs.write(CMD_FILE, JSON.stringify({ cmd: 'openPanel', id: targetUnit.id, at: Date.now() }));
      }
    } catch {}
  };

  // 鼠标悬停管理
  const handleMouseEnter = (e: React.MouseEvent<HTMLDivElement>, unit: MonitorUnit) => {
    if (isPinned) return;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);

    const rect = e.currentTarget.getBoundingClientRect();
    const top = Math.min(Math.max(12, rect.top - 10), window.innerHeight - 360);
    const left = rect.right + 12;

    hoverTimerRef.current = setTimeout(() => {
      setPortalPos({ top, left });
      setActiveUnit(unit);
      setFeedback(null);
    }, 120);
  };

  const handleMouseLeave = () => {
    if (isPinned) return;
    hoverTimerRef.current = setTimeout(() => {
      if (!cardHoveredRef.current) {
        setActiveUnit(null);
        setPortalPos(null);
      }
    }, 160);
  };

  // 单击锁定卡片并聚焦输入
  const handleUnitClick = (e: React.MouseEvent<HTMLDivElement>, unit: MonitorUnit) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const top = Math.min(Math.max(12, rect.top - 10), window.innerHeight - 360);
    const left = rect.right + 12;

    setPortalPos({ top, left });
    setActiveUnit(unit);
    setIsPinned(true);
    setFeedback(null);

    setTimeout(() => {
      inputRef.current?.focus();
    }, 60);
  };

  // 快速发信
  const handleSendMessage = async (text: string) => {
    if (!text.trim() || !activeUnit || !api || !api.chat) return;
    setSending(true);
    setFeedback(null);

    try {
      let targetPanel = activeUnit.panelId;
      if (!targetPanel && activeUnit.type === 'agent') {
        await fs.write(CMD_FILE, JSON.stringify({ cmd: 'openPanel', id: activeUnit.id, at: Date.now() }));
        setFeedback(t('正在启动工作面板…'));
        return;
      }
      if (targetPanel) {
        await api.chat.send(targetPanel, text.trim());
        setInputText('');
        setFeedback(t('已发送'));
        setTimeout(() => setFeedback(null), 2000);
      }
    } catch {
      setFeedback(t('发送失败'));
    } finally {
      setSending(false);
    }
  };

  const workingCount = units.filter((u) => u.status === 'working').length;

  return (
    <div className="tm-drawer-root">
      <div className={`tm-drawer-container ${isExpanded ? 'expanded' : 'collapsed'}`}>
        {/* 顶部控制栏 */}
        <div className="tm-drawer-header">
          <button
            className="tm-drawer-toggle-btn"
            onClick={() => setIsExpanded(!isExpanded)}
            title={isExpanded ? t('收起大盘') : t('展开大盘')}
          >
            {isExpanded ? '◀' : '▶'}
          </button>
          {isExpanded && (
            <>
              <span className="tm-header-title">{t('任务态势大盘')}</span>
              {workingCount > 0 && <span className="tm-header-status">{workingCount} 工作中</span>}
              {snapBad ? <span className="tm-header-warn" title={snapBad}>{t('快照读不出来')}</span> : null}
            </>
          )}
        </div>

        {/* 垂直单位流 */}
        <div className="tm-unit-list">
          {units.map((unit) => {
            const isWorking = unit.status === 'working';
            const isWaiting = unit.status === 'waiting';
            const isDeliverable = unit.status === 'deliverable';
            const isSelected = activeUnit?.id === unit.id;
            const initial = unit.name ? unit.name.trim().charAt(0) : '?';

            return (
              <div
                key={unit.id}
                className={`tm-unit-item ${isSelected ? 'active' : ''}`}
                onMouseEnter={(e) => handleMouseEnter(e, unit)}
                onMouseLeave={handleMouseLeave}
                onClick={(e) => handleUnitClick(e, unit)}
                onDoubleClick={() => jumpToMainWorkspace(unit)}
                title={t('{n}（单击快速会话，双击主区打开）', { n: unit.name })}
              >
                {/* 圆形头像与光流环 */}
                <div
                  className={`tm-avatar-wrapper ${
                    isWorking ? 'working' : isWaiting ? 'waiting' : isDeliverable ? 'deliverable' : ''
                  }`}
                >
                  <div className="tm-avatar-circle" style={{ backgroundColor: unit.accent || '#38bdf8' }}>
                    {unit.avatar ? <img src={unit.avatar} alt={unit.name} /> : <span>{initial}</span>}
                  </div>
                  <div className={`tm-status-dot ${unit.status}`} />
                </div>

                {/* 展开模式下的文字详情 */}
                {isExpanded && (
                  <div className="tm-unit-meta">
                    <div className="tm-meta-row1">
                      <span className="tm-meta-name">{unit.name}</span>
                      <span className="tm-meta-time">{formatRelativeTime(unit.at)}</span>
                    </div>
                    <div className="tm-meta-row2">
                      {unit.dept && <span className="tm-meta-badge">{unit.dept}</span>}
                      <span className="tm-meta-text">
                        {truncate(unit.taskSnippet || unit.lastMsg || unit.statusText, 14)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 悬停与极速会话 Portal 挂载在 body 上 */}
      {activeUnit && portalPos && createPortal(
        <div
          className="tm-popover-card"
          style={{ top: `${portalPos.top}px`, left: `${portalPos.left}px` }}
          onMouseEnter={() => {
            cardHoveredRef.current = true;
            if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
          }}
          onMouseLeave={() => {
            cardHoveredRef.current = false;
            if (!isPinned) handleMouseLeave();
          }}
        >
          {/* 卡片头部 */}
          <div className="tm-pop-head">
            <div className="tm-pop-title-wrap">
              <span className="tm-pop-name">{activeUnit.name}</span>
              {activeUnit.dept && <span className="tm-pop-tag">{activeUnit.dept}</span>}
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                className="tm-pop-jump-btn"
                onClick={() => jumpToMainWorkspace(activeUnit)}
                title={t('在主工作区打开')}
              >
                {t('主区打开 ↗')}
              </button>
              {isPinned && (
                <button
                  className="tm-pop-jump-btn"
                  style={{ padding: '3px 6px' }}
                  onClick={() => {
                    setIsPinned(false);
                    setActiveUnit(null);
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* 状态副栏 */}
          <div className="tm-pop-subbar">
            <span className={`tm-pop-status-badge ${activeUnit.status}`}>{activeUnit.statusText}</span>
            <span>{activeUnit.model ? truncate(activeUnit.model.split('::')[1] || activeUnit.model, 16) : t('默认模型')}</span>
          </div>

          {/* 内容区 */}
          <div className="tm-pop-body">
            {activeUnit.taskSnippet && (
              <div className="tm-pop-section">
                <div className="tm-pop-section-label">
                  <span>{t('当前工单 / 待办事项')}</span>
                </div>
                <div className="tm-pop-task-box">{activeUnit.taskSnippet}</div>
              </div>
            )}

            {activeUnit.lastMsg && (
              <div className="tm-pop-section">
                <div className="tm-pop-section-label">
                  <span>最近交流 ({activeUnit.lastRole === 'user' ? t('用户') : activeUnit.name})</span>
                  <span>{formatRelativeTime(activeUnit.at)}</span>
                </div>
                <div className="tm-pop-msg-box">{truncate(activeUnit.lastMsg, 120)}</div>
              </div>
            )}

            {!activeUnit.taskSnippet && !activeUnit.lastMsg && (
              <div style={{ fontSize: '12px', color: '#64748b', textAlign: 'center', padding: '6px 0' }}>
                {t('当前暂无活跃记录，可直接在下方发信开工')}
              </div>
            )}
          </div>

          {/* 底部极速发信 */}
          <div className="tm-pop-composer">
            <form
              className="tm-pop-input-row"
              onSubmit={(e) => {
                e.preventDefault();
                handleSendMessage(inputText);
              }}
            >
              <input
                ref={inputRef}
                className="tm-pop-input"
                placeholder={t('向 {n} 发送指令 / 消息…', { n: activeUnit.name })}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
              />
              <button className="tm-pop-send-btn" type="submit" disabled={sending}>
                {sending ? '…' : t('发送')}
              </button>
            </form>

            {feedback && (
              <div style={{ fontSize: '11px', color: '#38bdf8', textAlign: 'center' }}>
                {feedback}
              </div>
            )}

            <div className="tm-pop-hint">
              {t('提示：双击头像或点击「主区打开」在主屏幕展开')}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
