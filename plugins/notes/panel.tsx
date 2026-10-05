import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { PanelFaceProps } from '../../src/shared/types';
import { NOTE_PREFIX, hasNotePrefix } from '../../src/shared/note-prefix';

/** 派单命令队列 —— 跟 SidebarMonitor 走的是同一条（消费方 plugins/dispatch/index.js 的 openPanel） */
const CMD_FILE = '.ensoul/state/dispatch.cmd.json';

export interface MemoPin {
  id: string;
  text: string;
  at: number;
  rotation: number;
  color: string;
  pinColor: string;
  isNew?: boolean;
  delayMin?: number;
  targetEmp?: {
    id: string;
    name: string;
    avatar?: string;
    accent?: string;
    panelId?: string;
  };
  targetDue?: number;
  targetSent?: boolean;
  /**
   * 「已完成」章 —— 员工干完活之后由插件盖上来的，**盖在原卡上，不另立新卡**。
   *
   * 一块板就是一份台账，一件事一格：有章的就是办完的。卡面文字一个字不动
   * （任务原话原样留着）—— 章是后加的，不是把话换掉。
   *
   * 盖上章的卡**不再可编辑**：它此刻是凭证，双击只跳去看那个人干了什么。
   * 想改就得先撤章（再把这张卡拖给员工，重新走一遍）。
   */
  done?: {
    at: number;
    by: string;
    empId: string;
    /** 回执是在哪块面板上回的（双击跳他工作面、排错时都用得上） */
    panelId: string;
  };
}

/**
 * 便签存哪 —— **一块面板一份文件**（跟 workspace / histconv 同一个路子）。
 *
 * 以前所有便签面板共用一份 `.ensoul/state/notes.memo.json`：两块便签面板同时开着，
 * 各自"读出来 → 改 → 整份写回"，谁后写谁赢，先写的那张就被盖掉了。
 * 分开之后每块面板只碰自己那一份，也顺带让"交付便签"能投给指定的一块。
 */
const MEMO_DIR = '.ensoul/state/memo';
/** 老版本所有面板共用一份，第一次打开时把里面那几条搬进新位置 */
const LEGACY_MEMO = '.ensoul/state/notes.memo.json';
const CANVAS_FILE = '.ensoul/state/canvas.json';

/** 面板 id 变文件名 —— 跟插件那边（plugins/notes/index.js）那条规则必须一模一样 */
function memoFileOf(panelId: string): string {
  const safe = String(panelId || '').replace(/[^\w.-]+/g, '_');
  return safe ? `${MEMO_DIR}/${safe}.json` : '';
}

const PIN_COLORS = ['#ef4444', '#f59e0b', '#3b82f6', '#10b981', '#8b5cf6'];
const NOTE_COLORS = ['#fef08a', '#fde047', '#fef9c3', '#fed7aa'];
const ROTATIONS = [-3, -2, -1, 1, 2, 3, -1.5, 2.5];

const MINUTES_PER_TURN = 4 * 60; // 一圈 4 小时 = 240 分钟，支持顺时针连续拧很多圈

function formatDelayText(min: number): string {
  if (!min || min <= 0) return t('立刻');
  if (min < 60) return t('{n}分', { n: min });
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}h${m}m` : `${h}小时`;
}

/** 章上只印时分：当天的事一眼够用，跨天的也认得出是旧账（完整时间在悬停里） */
function formatDoneTime(t: number): string {
  const d = new Date(Number(t) || 0);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const today = new Date();
  return d.toDateString() === today.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

interface RingSliderProps {
  pin: MemoPin;
  anchorRect: DOMRect;
  onUpdate: (min: number) => void;
  onClose: () => void;
}

function RingSliderModal({ pin, anchorRect, onUpdate, onClose }: RingSliderProps) {
  const [val, setVal] = useState<number>(pin.delayMin || 0);
  const isDraggingRef = useRef(false);
  const lastAngleRef = useRef<number | null>(null);
  const accumulatedRef = useRef<number>(pin.delayMin || 0);
  const circleRef = useRef<SVGSVGElement>(null);

  // 点击外部自动关闭
  useEffect(() => {
    const onPointerDownOutside = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.note-ring-popover')) {
        onClose();
      }
    };
    window.addEventListener('pointerdown', onPointerDownOutside, true);
    return () => window.removeEventListener('pointerdown', onPointerDownOutside, true);
  }, [onClose]);

  // SVG 画布与圆环几何尺寸（严格 1:1 绝对居中）
  const size = 104;
  const center = 52;
  const radius = 39;
  const strokeWidth = 6.5;
  const circumference = 2 * Math.PI * radius;

  // 当前圈内比例：一圈 4 小时 (240 分钟)，可连续顺时针拧很多圈
  const inTurn = val % MINUTES_PER_TURN;
  const turnRatio = val > 0 && inTurn === 0 ? 1 : inTurn / MINUTES_PER_TURN;
  const angle = turnRatio * 360;
  const strokeDashoffset = circumference - turnRatio * circumference;

  const rad = ((angle - 90) * Math.PI) / 180;
  const knobX = center + radius * Math.cos(rad);
  const knobY = center + radius * Math.sin(rad);

  const getAngleFromPointer = (clientX: number, clientY: number): number | null => {
    if (!circleRef.current) return null;
    const rect = circleRef.current.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    let deg = Math.atan2(dy, dx) * (180 / Math.PI) + 90;
    if (deg < 0) deg += 360;
    return deg;
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isDraggingRef.current = true;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}
    const startDeg = getAngleFromPointer(e.clientX, e.clientY);
    lastAngleRef.current = startDeg;
    accumulatedRef.current = val;
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    e.preventDefault();
    const currentDeg = getAngleFromPointer(e.clientX, e.clientY);
    if (currentDeg === null || lastAngleRef.current === null) return;

    let deltaDeg = currentDeg - lastAngleRef.current;
    // 顺时针/逆时针穿过 12 点钟（0°/360°）时的跳变平滑处理
    if (deltaDeg < -180) deltaDeg += 360;
    else if (deltaDeg > 180) deltaDeg -= 360;

    lastAngleRef.current = currentDeg;

    // 1度 = 240 / 360 = 2/3 分钟，支持多圈无上限持续旋转
    const deltaMin = deltaDeg * (MINUTES_PER_TURN / 360);
    const nextAcc = Math.max(0, accumulatedRef.current + deltaMin);
    accumulatedRef.current = nextAcc;

    // 每 5 分钟严格吸附一次（0~2.5分吸附为 0 即“立刻”，2.5~7.5分吸附为 5分，依次类推）
    let nextVal = Math.round(nextAcc / 5) * 5;
    if (nextVal < 0) nextVal = 0;

    if (nextVal !== val) {
      setVal(nextVal);
      onUpdate(nextVal);
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {}
      accumulatedRef.current = val;
    }
  };

  // 弹窗外框对齐闹钟图标的几何中心线，杜绝视觉偏歪
  const popWidth = 126;
  const popHeight = 132;
  let top = Math.round(anchorRect.top + anchorRect.height / 2 - popHeight / 2);
  let left = Math.round(anchorRect.right + 8);

  if (left + popWidth > window.innerWidth - 12) {
    left = Math.round(anchorRect.left - popWidth - 8);
  }
  if (left < 12) left = 12;
  if (top + popHeight > window.innerHeight - 12) {
    top = window.innerHeight - popHeight - 12;
  }
  if (top < 12) top = 12;

  const currentTurnNum = Math.floor(val / MINUTES_PER_TURN) + (inTurn > 0 ? 1 : 0);

  return createPortal(
    <div
      className="note-ring-popover"
      style={{ top, left }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="note-ring-body"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <svg
          ref={circleRef}
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="note-ring-svg"
        >
          {/* 刻度盘：一圈 4 小时共 48 格，每 5 分钟一格 */}
          <g className="note-ring-ticks">
            {Array.from({ length: 48 }, (_, i) => {
              const tickMin = i * 5;
              const tickDeg = i * 7.5;
              const rad = ((tickDeg - 90) * Math.PI) / 180;
              const cos = Math.cos(rad);
              const sin = Math.sin(rad);

              const isHour = tickMin % 60 === 0;
              const isQuarter = tickMin % 15 === 0;

              const rOuter = isHour ? 49.5 : isQuarter ? 48 : 46.8;
              const rInner = isHour ? 43.5 : isQuarter ? 44.5 : 44.8;

              // 是否在当前圈进度范围内点亮
              const isPassed = val > 0 && (val >= MINUTES_PER_TURN || tickDeg <= angle + 0.1);
              const stroke = isPassed
                ? (val >= MINUTES_PER_TURN ? '#ea580c' : '#f59e0b')
                : (isHour ? '#94a3b8' : isQuarter ? '#cbd5e1' : '#e2e8f0');
              const strokeW = isHour ? 1.8 : isQuarter ? 1.2 : 0.9;

              return (
                <line
                  key={i}
                  x1={center + rInner * cos}
                  y1={center + rInner * sin}
                  x2={center + rOuter * cos}
                  y2={center + rOuter * sin}
                  stroke={stroke}
                  strokeWidth={strokeW}
                  strokeLinecap="round"
                  opacity={isPassed ? 1 : (isHour ? 0.9 : 0.6)}
                />
              );
            })}
          </g>

          {/* 背景底轨 */}
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="#e2e8f0"
            strokeWidth={strokeWidth}
          />
          {/* 进度前景色（多圈时色泽更深，增强多圈质感） */}
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={val >= MINUTES_PER_TURN ? '#ea580c' : '#f59e0b'}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            transform={`rotate(-90 ${center} ${center})`}
          />
          {/* 交互旋钮（物理质感圆点） */}
          <circle
            cx={knobX}
            cy={knobY}
            r={6.5}
            fill="#ffffff"
            stroke={val >= MINUTES_PER_TURN ? '#ea580c' : '#f59e0b'}
            strokeWidth={2.8}
            className="note-ring-knob"
          />
        </svg>

        <div className="note-ring-label-center">
          <div className="note-ring-val">{formatDelayText(val)}</div>
          {val >= MINUTES_PER_TURN && (
            <div className="note-ring-turn-tag">
              第{currentTurnNum}圈 (4h/圈)
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

export default function NotesPanel({ panel, fs }: PanelFaceProps) {
  const [pins, setPins] = useState<MemoPin[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [activeRing, setActiveRing] = useState<{ pin: MemoPin; rect: DOMRect } | null>(null);

  const boardRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLTextAreaElement>(null);

  const [boardZoom, setBoardZoom] = useState<number>(() => {
    try {
      const s = localStorage.getItem('ensoul_note_zoom_' + panel.id);
      if (s) {
        const v = parseFloat(s);
        if (Number.isFinite(v) && v >= 0.4 && v <= 2.5) return v;
      }
    } catch {}
    return 1.0;
  });

  const changeZoom = (next: number) => {
    const z = Math.round(Math.min(2.5, Math.max(0.4, next)) * 100) / 100;
    setBoardZoom(z);
    try {
      localStorage.setItem('ensoul_note_zoom_' + panel.id, String(z));
    } catch {}
  };

  /** 这块面板自己的那份便签文件 —— panel.id 不变它就跟着不变 */
  const memoFile = memoFileOf(panel.id);

  const loadPins = async () => {
    if (!memoFile) return;
    try {
      let raw = await fs.read(memoFile);
      // 头一回：自己那份还不存在，就把老版本那份共用的搬过来（搬完清空旧位置，别的面板不会重复搬一遍）
      if (!raw) {
        try {
          const legacy = await fs.read(LEGACY_MEMO);
          const old = legacy ? JSON.parse(legacy) : null;
          if (Array.isArray(old) && old.length) {
            const w = await fs.write(memoFile, JSON.stringify(old, null, 2));
            if (w && w.ok) await fs.write(LEGACY_MEMO, '[]');
            raw = JSON.stringify(old);
          }
        } catch {}
      }
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          // 磁盘是真源：合并而不是替换，否则插件刚钉上去的回执活不过这一拍（下一拍才读得到）
          setPins(prev => {
            const ids = new Set(parsed.map(p => p.id));
            const extra = prev.filter(p => p.isNew && !ids.has(p.id));
            return extra.length ? [...parsed, ...extra] : parsed;
          });
        }
      }
    } catch {}
  };

  useEffect(() => {
    loadPins();
    const interval = setInterval(loadPins, 1500);

    const onWindowClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.note-ring-popover') && !target.closest('.note-clock-btn')) {
        setActiveRing(null);
      }
    };

    window.addEventListener('click', onWindowClick);
    return () => {
      clearInterval(interval);
      window.removeEventListener('click', onWindowClick);
    };
  }, [memoFile]);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  /**
   * 写盘前**先跟磁盘核对一次**。
   *
   * 白板这份文件有两个写者：这里的面板（用户增删挪）和主进程那边的插件
   * （员工交回执时自动钉一张）。两边各拿各的内存快照整份写回，谁后写谁赢 ——
   * 插件刚钉的那张，会被面板下一次保存直接抹掉（用户在板上根本看不到它）。
   * 所以写之前把磁盘上"我不认识的"那些并进来，一个都不丢。
   */
  const mergeWithDisk = async (list: MemoPin[]): Promise<MemoPin[]> => {
    if (!memoFile) return list;
    try {
      const raw = await fs.read(memoFile);
      const parsed = raw ? JSON.parse(raw) : null;
      if (!Array.isArray(parsed)) return list;
      const ids = new Set(list.map((p) => p.id));
      const extra = parsed.filter((p) => p && p.id && !ids.has(p.id));
      return extra.length ? [...list, ...extra] : list;
    } catch {
      return list;
    }
  };

  const savePins = async (newPins: MemoPin[], isDelete = false) => {
    // 只有在非删除（如新增、编辑、改时间）时才与磁盘未知卡片合并；
    // 删除操作必须遵从用户的显式删除意图，绝不能把刚删掉的卡当作“磁盘新卡”复活回来！
    const finalPins = isDelete ? newPins : await mergeWithDisk(newPins);
    setPins(finalPins);
    if (!memoFile) return;
    try {
      await fs.write(memoFile, JSON.stringify(finalPins.map(p => ({ ...p, isNew: false })), null, 2));
    } catch {}
  };

  const createPin = async (initialText: string = '') => {
    const newPin: MemoPin = {
      id: 'pin_' + Math.random().toString(36).slice(2, 9),
      text: initialText,
      at: Date.now(),
      rotation: ROTATIONS[Math.floor(Math.random() * ROTATIONS.length)],
      color: NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)],
      pinColor: PIN_COLORS[Math.floor(Math.random() * PIN_COLORS.length)],
      isNew: true,
      delayMin: 0,
    };

    const nextPins = [...pins, newPin];
    await savePins(nextPins, false);
    setEditingId(newPin.id);

    requestAnimationFrame(() => {
      if (boardRef.current) {
        boardRef.current.scrollTop = boardRef.current.scrollHeight;
      }
    });

    try {
      let canvasDoc: any = { panels: {} };
      try {
        const raw = await fs.read(CANVAS_FILE);
        canvasDoc = JSON.parse(raw) || { panels: {} };
      } catch {}

      if (!canvasDoc.panels) canvasDoc.panels = {};
      const targetPanelId = Object.keys(canvasDoc.panels)[0] || 'default';
      if (!canvasDoc.panels[targetPanelId]) {
        canvasDoc.panels[targetPanelId] = { elements: [] };
      }
      if (!Array.isArray(canvasDoc.panels[targetPanelId].elements)) {
        canvasDoc.panels[targetPanelId].elements = [];
      }

      const existingCount = canvasDoc.panels[targetPanelId].elements.length;
      canvasDoc.panels[targetPanelId].elements.push({
        id: 'canvas_' + newPin.id,
        type: 'note',
        text: newPin.text,
        x: 60 + (existingCount % 6) * 150,
        y: 60 + Math.floor(existingCount / 6) * 130,
        width: 130,
        height: 100,
        color: newPin.color,
      });

      await fs.write(CANVAS_FILE, JSON.stringify(canvasDoc, null, 2));
    } catch (e) {}
  };

  const handleBoardDoubleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.note-pin-card') || target.closest('.note-ring-popover')) {
      return;
    }
    createPin('');
  };

  /**
   * 回执卡双击 = 跳去看那个人干了什么。
   *
   * 走的是跟侧栏监视台同一条命令队列（`dispatch.cmd.json` 的 `openPanel`，见
   * plugins/dispatch/index.js）—— 脸拿不到开面板的口子，也不该为一个跳转给它开一个。
   */
  const jumpToEmp = async (pin: MemoPin) => {
    const emp = pin.done;
    if (!emp || !emp.empId) return;
    try {
      let cmds: any[] = [];
      try {
        const raw = await fs.read(CMD_FILE);
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.cmds)) cmds = parsed.cmds;
      } catch {
        cmds = [];
      }
      cmds.push({
        seq: Date.now() * 1000 + Math.floor(Math.random() * 1000),
        panelId: emp.panelId || '',
        cmd: 'openPanel',
        id: emp.empId,
      });
      await fs.write(CMD_FILE, JSON.stringify({ cmds: cmds.slice(-20) }));
    } catch {}
  };

  const handleDelete = (id: string, e?: React.SyntheticEvent) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    savePins(pins.filter(p => p.id !== id), true);
    if (activeRing?.pin.id === id) setActiveRing(null);
    if (editingId === id) setEditingId(null);
  };

  const handleCardMouseDown = (e: React.MouseEvent, id: string) => {
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      handleDelete(id, e);
    }
  };

  const handleFinishEdit = (id: string, newText: string) => {
    const trimmed = newText.trim();
    if (!trimmed) {
      handleDelete(id);
    } else {
      const nextPins = pins.map(p => p.id === id ? { ...p, text: trimmed } : p);
      savePins(nextPins);
    }
    setEditingId(null);
  };

  const handleClockClick = (e: React.MouseEvent, pin: MemoPin) => {
    e.stopPropagation();
    e.preventDefault();
    const cardEl = (e.currentTarget as HTMLElement).closest('.note-pin-card');
    if (!cardEl) return;
    const rect = cardEl.getBoundingClientRect();
    if (activeRing?.pin.id === pin.id) {
      setActiveRing(null);
    } else {
      setActiveRing({ pin, rect });
    }
  };

  const updatePinDelay = (id: string, delayMin: number) => {
    const updated = pins.map(p => p.id === id ? { ...p, delayMin } : p);
    savePins(updated);
  };

  return (
    <div
      className="ensoul-note-board-root"
      ref={rootRef}
      data-fit="off"
      onWheel={(e) => {
        if (e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          changeZoom(boardZoom + (e.deltaY < 0 ? 0.08 : -0.08));
        }
      }}
    >
      <div
        className="note-whiteboard"
        ref={boardRef}
        onDoubleClick={handleBoardDoubleClick}
      >
        <div
          className="note-pins-grid"
          style={{
            transform: boardZoom !== 1 ? `scale(${boardZoom})` : undefined,
            transformOrigin: 'top left',
            width: boardZoom !== 1 ? `calc(100% / ${boardZoom})` : '100%',
          }}
        >
          {pins.map((pin) => {
            const hasTimer = Boolean(pin.delayMin && pin.delayMin > 0);
            const isEditing = editingId === pin.id;

            return (
              <div
                key={pin.id}
                className={`note-pin-card ${pin.isNew ? 'is-launching' : ''} ${hasTimer ? 'has-timer' : ''} ${isEditing ? 'is-editing' : ''} ${pin.done ? 'is-done' : ''}`}
                title={pin.done ? `已由 ${pin.done.by} 完成（${formatDoneTime(pin.done.at)}） · 双击查看` : undefined}
                style={{
                  backgroundColor: pin.color,
                  transform: `rotate(${pin.rotation}deg)`,
                }}
                draggable={!isEditing}
                onDragStart={(e) => {
                  // 正文只留前缀 + 原话（用户明确要求别的东西不许影响视线）；
                  // 来源白板、甲方是谁写进投递账本，员工看不到、回执时才用得上
                  const outgoing = hasNotePrefix(pin.text)
                    ? pin.text
                    : `${NOTE_PREFIX}\n${pin.text}`;

                  // 又派出去一次 = 这活儿重新开始了：旧章当场撤掉。
                  // 留着章会变成"已完成"的卡还在干活，比没有章更骗人。
                  if (pin.done) {
                    savePins(pins.map(p => (p.id === pin.id ? { ...p, done: undefined } : p)));
                  }

                  const payload = {
                    text: outgoing,
                    rawText: pin.text,
                    delayMin: pin.delayMin || 0,
                    delayMs: (pin.delayMin || 0) * 60 * 1000,
                    noteId: pin.id,
                    memoFile,
                    boardId: panel.id,
                    from: panel.title || '便利贴',
                  };

                  e.dataTransfer.setData('text/plain', outgoing);
                  e.dataTransfer.setData('application/x-ensoul-note', JSON.stringify(payload));
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onMouseDown={(e) => handleCardMouseDown(e, pin.id)}
                onAuxClick={(e) => handleCardMouseDown(e, pin.id)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  // 盖了章就是凭证，不是草稿：双击跳去看那个人干了什么，不进退改字那一套
                  if (pin.done) {
                    void jumpToEmp(pin);
                    return;
                  }
                  setEditingId(pin.id);
                }}
              >
                <div
                  className="note-pin-thumbtack"
                  style={{ backgroundColor: pin.pinColor }}
                >
                  <div className="thumbtack-dot" />
                </div>

                {/* 完成了就盖个章：右下角一枚朱红印章，斜带里一个对钩 */}
                {pin.done && (
                  <NoteStamp title={t('已由 {by} 完成 · {at}', { by: pin.done.by, at: formatDoneTime(pin.done.at) })} />
                )}

                {/* 右上角：把这张便利贴撕掉 —— 平时不露脸，指到卡上才出现 */}
                <button
                  type="button"
                  className="note-pin-close-btn"
                  title={t('删除这张便利贴')}
                  draggable={false}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                  }}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onClick={(e) => handleDelete(pin.id, e)}
                  onPointerUp={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    handleDelete(pin.id, e);
                  }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" aria-hidden="true">
                    <path d="M6.5 6.5 L17.5 17.5 M17.5 6.5 L6.5 17.5" />
                  </svg>
                </button>
                
                {isEditing ? (
                  <textarea
                    ref={editInputRef}
                    className="note-pin-edit-area"
                    defaultValue={pin.text}
                    rows={2}
                    spellCheck={false}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleFinishEdit(pin.id, e.currentTarget.value);
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        setEditingId(null);
                      }
                    }}
                    onBlur={(e) => handleFinishEdit(pin.id, e.currentTarget.value)}
                  />
                ) : (
                  <div className="note-pin-text">
                    {pin.text || '双击输入内容...'}
                  </div>
                )}

                <div className="note-pin-footer">
                  <div
                    className={`note-clock-btn ${hasTimer ? 'is-set' : ''}`}
                    onClick={(e) => handleClockClick(e, pin)}
                    title={hasTimer ? `已定时：${formatDelayText(pin.delayMin || 0)}后发送` : '设置倒计时'}
                  >
                    <svg width="8.5" height="8.5" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 3.5a.5.5 0 0 0-1 0V9a.5.5 0 0 0 .252.434l3.5 2a.5.5 0 0 0 .496-.868L8 8.71V3.5z"/>
                      <path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm7-8A7 7 0 1 1 1 8a7 7 0 0 1 14 0z"/>
                    </svg>
                    {hasTimer && (
                      <span className="note-clock-tag">{formatDelayText(pin.delayMin || 0)}</span>
                    )}
                  </div>

                  {pin.targetEmp && (
                    <div
                      className={`note-target-emp ${pin.targetSent ? 'is-sent' : ''}`}
                      title={`${pin.targetSent ? t('已发送给') : t('定时派单给')}：${pin.targetEmp.name}`}
                    >
                      <div
                        className="note-emp-avatar"
                        style={{ backgroundColor: pin.targetEmp.accent || '#3b82f6' }}
                      >
                        {pin.targetEmp.avatar ? (
                          <img src={pin.targetEmp.avatar} alt="" />
                        ) : (
                          <span>{(pin.targetEmp.name || '?').trim().charAt(0)}</span>
                        )}
                      </div>
                      <span className="note-emp-name">{pin.targetEmp.name}</span>
                      {pin.targetSent ? (
                        <span className="note-emp-check" title={t('已成功送达')}>✓</span>
                      ) : (
                        <button
                          className="note-emp-cancel"
                          title={t('取消定时派单')}
                          onClick={async (e) => {
                            e.stopPropagation();
                            // 从定时账里删去这个任务
                            try {
                              const sRaw = await fs.read('.ensoul/state/notes.timers.json');
                              const sDoc = JSON.parse(sRaw);
                              if (Array.isArray(sDoc?.tasks)) {
                                sDoc.tasks = sDoc.tasks.filter((t: any) => t.noteId !== pin.id);
                                await fs.write('.ensoul/state/notes.timers.json', JSON.stringify(sDoc, null, 2));
                              }
                            } catch {}
                            // 更新便签移除 targetEmp
                            const updated = pins.map((p) =>
                              p.id === pin.id
                                ? { ...p, targetEmp: undefined, targetDue: undefined, targetSent: undefined }
                                : p
                            );
                            savePins(updated);
                          }}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {activeRing && (
        <RingSliderModal
          pin={activeRing.pin}
          anchorRect={activeRing.rect}
          onUpdate={(min) => updatePinDelay(activeRing.pin.id, min)}
          onClose={() => setActiveRing(null)}
        />
      )}

      {/* 印章的滤镜与星形只定义一次，所有已完成的卡共用 */}
      <NoteStampDefs />

      {/* 便签白板右下角自由缩放微型悬浮工具条 */}
      <div className="note-zoom-bar" onClick={(e) => e.stopPropagation()}>
        <button
          className="note-zoom-btn"
          title={t('缩小便签视图 (Alt + 滚轮向下)')}
          onClick={(e) => {
            e.stopPropagation();
            changeZoom(boardZoom - 0.1);
          }}
        >
          −
        </button>
        <button
          className="note-zoom-reset"
          title={t('点击恢复 100% 原始大小')}
          onClick={(e) => {
            e.stopPropagation();
            changeZoom(1.0);
          }}
        >
          {Math.round(boardZoom * 100)}%
        </button>
        <button
          className="note-zoom-btn"
          title={t('放大丈夫便签 (Alt + 滚轮向上)')}
          onClick={(e) => {
            e.stopPropagation();
            changeZoom(boardZoom + 0.1);
          }}
        >
          +
        </button>
      </div>
    </div>
  );
}

/** 印章的滤镜（毛边）与星形，整个白板只定义一次 */
function NoteStampDefs() {
  return (
    <svg className="note-stamp-defs" aria-hidden="true" focusable="false">
      <defs>
        <filter id="noteStampInk" x="-16%" y="-16%" width="132%" height="132%">
          <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="1" seed="7" result="edge" />
          <feDisplacementMap in="SourceGraphic" in2="edge" scale="0.6" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <path id="noteStampStar" d="M0 -3 L0.74 -1.02 L2.85 -0.93 L1.2 0.39 L1.76 2.43 L0 1.26 L-1.76 2.43 L-1.2 0.39 L-2.85 -0.93 L-0.74 -1.02 Z" />
      </defs>
    </svg>
  );
}

/**
 * 印章本体：锯齿花边 + 双圈 + 五颗星 + 中间一个粗对钩（整枚右倾 17°）。
 *
 * 三件事是算过的，不是摆着看的：
 *   · 五颗星同在半径 12.8 的圆上、72° 等分、正上方一颗 —— 左右对称，间距一致；
 *   · 星外沿 15.8 刚好抵住内圈内侧、不压线；
 *   · 对钩旋转后离最近那颗星净空 2 个单位以上 —— 钩再粗也不会跟星糊成一团。
 *
 * 花边保留了 16 齿的深齿（34px 下每齿约 3.7px）：再密就成一条毛边，再疏就不像印章。
 */
function NoteStamp({ title }: { title?: string }) {
  return (
    <div className="note-pin-done-stamp" title={title}>
      <svg viewBox="-3 -3 54 54" aria-hidden="true" focusable="false">
        <g filter="url(#noteStampInk)" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
          <path d="M42.4 24 Q45.58 28.29 41 31.04 Q42.29 36.22 37.01 37.01 Q36.22 42.29 31.04 41 Q28.29 45.58 24 42.4 Q19.71 45.58 16.96 41 Q11.78 42.29 10.99 37.01 Q5.71 36.22 7 31.04 Q2.42 28.29 5.6 24 Q2.42 19.71 7 16.96 Q5.71 11.78 10.99 10.99 Q11.78 5.71 16.96 7 Q19.71 2.42 24 5.6 Q28.29 2.42 31.04 7 Q36.22 5.71 37.01 10.99 Q42.29 11.78 41 16.96 Q45.58 19.71 42.4 24 Z" strokeWidth="2.4" />
          <circle cx="24" cy="24" r="18.6" strokeWidth="1.8" />
          <circle cx="24" cy="24" r="16.3" strokeWidth="0.95" />
          <g fill="currentColor" stroke="none">
            <use href="#noteStampStar" transform="translate(24 11.2)" />
            <use href="#noteStampStar" transform="translate(36.17 20.04)" />
            <use href="#noteStampStar" transform="translate(31.52 34.36)" />
            <use href="#noteStampStar" transform="translate(16.48 34.36)" />
            <use href="#noteStampStar" transform="translate(11.83 20.04)" />
          </g>
          <path d="M14.6 24.3 L20.9 30.6 L33.4 16.6" strokeWidth="5.8" transform="rotate(-17 24 24)" />
        </g>
      </svg>
    </div>
  );
}
