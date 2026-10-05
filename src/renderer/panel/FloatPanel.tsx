import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Panel, PanelFloat } from '../../shared/types';
import { floatRatio } from '../../shared/types';
import { api } from '../core/api';
import { statusClass, statusColor, statusLabel } from '../ui/status';
import { IconLock } from '../ui/icons';
import { PanelSurface } from '../panel/PanelSurface';
import { panelType, panelTypesRevision, subscribePanelTypes } from './registry';
import { t } from '../core/i18n';
import { useFloatUnlock } from './useFloatUnlock';

/**
 * 悬浮面板 —— 脱离布局、浮在**所属那块区域**上方的便签。
 *
 * 和停靠面板的三点不同：
 *   1. **它不在停靠树里**，但也没有飘到整个窗口上：它渲染在自己那块区域内部，
 *      所以区域一挪、一缩放，它自动跟着走，也永远跑不到别的面板上面去
 *   2. **位置存的是比例，大小存的是像素**（见 PanelFloat）：拖动过程在本地走，
 *      松手才提交一次 IPC —— 每帧都提交会让所有窗口跟着重渲染，拖起来会发涩
 *   3. **不许出界**：拖动和拉大小都被夹在那块区域的范围内；区域自己缩小的时候，
 *      它按比例重新落位（这是"绝对坐标"做不到的那一半 —— 区域缩了，
 *      存在 594 那儿的挂件不会知道，会被甩到画面外）
 *
 * **默认锁住**（桌面歌词那条规矩）：摆好之后它就只是一块内容，误碰不动它。
 * 锁着的时候拖动带、改大小、解除、**以及悬停那圈边框**一个都不出现
 * （不是盖住，是根本不存在），在内容空白处长按右键，进度圈走满后才能调整。
 * 这一条不只是防误碰：挂件常年压在别的面板上，任何一点透明的可点区域
 * 都会从底下那块面板手里抢走点击；也不该让人从边框看出这儿框着一块地方。
 */

/** 便签的最小尺寸。CSS 里不再设 min-width/min-height —— 位置的夹取全靠这里的数，两处会打架 */
const MIN_W = 200;
const MIN_H = 140;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * 把存下来的比例换算成**这一刻**该待的位置。
 *
 * 宽高先夹进区域（挂件不可能比母体还大），再按比例落在剩下的余量上 ——
 * 所以区域怎么缩，它都还在框里。
 */
function place(f: PanelFloat, avail: { w: number; h: number }): Box {
  const width = Math.min(Math.max(MIN_W, f.width), Math.max(MIN_W, avail.w));
  const height = Math.min(Math.max(MIN_H, f.height), Math.max(MIN_H, avail.h));
  const slackX = Math.max(0, avail.w - width);
  const slackY = Math.max(0, avail.h - height);
  // 旧数据存的是绝对像素：这里当场折算成比例，写完一次之后文件里就只剩比例了
  const rx = Number.isFinite(f.rx) ? clamp01(f.rx) : slackX > 0 ? clamp01((f.x ?? 0) / slackX) : 0;
  const ry = Number.isFinite(f.ry) ? clamp01(f.ry) : slackY > 0 ? clamp01((f.y ?? 0) / slackY) : 0;
  return { x: Math.round(rx * slackX), y: Math.round(ry * slackY), width, height };
}

export function FloatPanel({ panel, hostKey }: { panel: Panel; hostKey?: string }) {
  const f = panel.float!;
  /** 缺省锁住：只有显式写 false 才算解开（旧数据没有这个字段 = 锁住） */
  const locked = f.locked !== false;
  /** 锁是挂件自己的字段，跟位置一样存回主进程 */
  const setLocked = (next: boolean) => void api.panel.moveFloat(panel.id, { locked: next });
  const unlockGesture = useFloatUnlock(locked, () => setLocked(false));
  const box = useRef<HTMLDivElement>(null);
  /** 所属那块区域的可用尺寸：既是活动边界，也是把比例折成像素的依据 */
  const [avail, setAvail] = useState<{ w: number; h: number } | null>(null);
  const availRef = useRef(avail);
  availRef.current = avail;

  /** 这一刻的落位（像素）。null = 还没量到区域，先不画 */
  const [rect, setRect] = useState<Box | null>(null);

  // 松手时要提交"最后停在哪"，而手势期间 rect 一直在变 —— 用 ref 兜住最新值
  const latest = useRef<Box | null>(rect);
  latest.current = rect;

  const mode = useRef<'move' | 'size' | null>(null);
  // 会话**绑死在按下的那根指针上**：不是那根指针的移动，一概不许改尺寸
  const start = useRef({ x: 0, y: 0, pid: -1, from: { x: 0, y: 0, width: 0, height: 0 } as Box });

  /**
   * 量所属那块区域。**layout 期先量一次**（赶在第一帧画出来之前就落好位，
   * 否则会闪一下"便签从左上角飞过来"），之后交给 ResizeObserver 跟着走。
   */
  useLayoutEffect(() => {
    const el = box.current?.parentElement;
    if (!el) return;
    const read = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      setAvail((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };
    read();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(read) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  /**
   * 区域尺寸变了 → 按比例重新落位。这就是"挂件不会飞出画面"的那一步：
   * 它记住的是**相对位置**，不是某个像素坐标。
   * 拖动中不重排 —— 别把用户正拖着的那只手甩开。
   */
  useLayoutEffect(() => {
    if (!avail || mode.current) return;
    setRect(place(f, avail));
  }, [avail, f.rx, f.ry, f.width, f.height]);

  /**
   * 手势会话**绑在便签自己身上**（而不是 window）。
   *
   * 之前是 window 上收 pointerup —— 指针在窗口外面松手时那个 up 根本收不到，
   * mode 就一直停在 'size'，旧锚点留着；之后按住别处一动，它照样按老起点重算尺寸，
   * 表现就是"点住就不断变大"。锁住指针（setPointerCapture）之后，
   * 拖到窗口外面松手，up 也一定会回到这里，会话关得掉。
   */
  const onMove = (e: React.PointerEvent) => {
    const m = mode.current;
    if (!m) return;
    // 不是按下时那根指针、或者左键已经松了 —— 这条移动跟本次会话无关，一动都不能动。
    // 旧写法只看 e.buttons：按着右键划过、或者上一轮的会话没关干净，它照样按老锚点重算。
    if (e.pointerId !== start.current.pid || !(e.buttons & 1)) {
      if (!(e.buttons & 1)) mode.current = null;
      return;
    }
    const a = availRef.current;
    const s = start.current;
    if (!a) return;

    if (m === 'move') {
      setRect({
        ...s.from,
        x: Math.max(0, Math.min(a.w - s.from.width, s.from.x + (e.clientX - s.x))),
        y: Math.max(0, Math.min(a.h - s.from.height, s.from.y + (e.clientY - s.y))),
      });
    } else {
      setRect({
        ...s.from,
        width: Math.max(MIN_W, Math.min(a.w - s.from.x, s.from.width + (e.clientX - s.x))),
        height: Math.max(MIN_H, Math.min(a.h - s.from.y, s.from.height + (e.clientY - s.y))),
      });
    }
  };

  /** 松手 / 取消 / 指针被系统收走：会话一律销毁，而且只在这一刻提交一次 IPC */
  const endSession = () => {
    if (!mode.current) return;
    mode.current = null;
    const r = latest.current;
    const a = availRef.current;
    if (!r || !a) return;
    // 提交的是**比例**：这一下落定的是"贴在母体的哪个相对位置"，不是某个像素坐标
    void api.panel.moveFloat(panel.id, {
      rx: floatRatio(r.x, a.w, r.width),
      ry: floatRatio(r.y, a.h, r.height),
      width: r.width,
      height: r.height,
    });
  };

  /*
   * 兜底：会话一定要关得掉。
   *
   * 元素上的 pointerup 靠 setPointerCapture 保证收得到；万一捕获没建立成功，
   * 在便签外面松手时那个 up 就丢了 —— mode 留在原地，之后按住划过来还会按
   * 上一次的旧锚点重算尺寸，看起来就是"点一下自己变大"。所以在窗口上再听一遍，
   * 任何一次松手都把会话结束掉，不给残留留机会。
   */
  useEffect(() => {
    const stop = () => endSession();
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    // endSession 只碰 ref（mode / latest）和稳定的 panel.id，闭包不新鲜也不影响
  }, []);

  /**
   * 这种面板浮起来要不要底，由**类型自己声明**（PanelTypeDef.floatBare）。
   * 判据不能是"浮起来了" —— 会话面板浮起来也是一块实心的正文，
   * 只有番茄钟、桌宠那种"自己带着底"的挂件才该透出底下 ——
   * 顺带它的透明处也漏鼠标给底下的面板（见 float.css 的 bare-float）。
   *
   * 注册表是启动之后才被插件填满的，所以要订阅：插件面板一装好，
   * 这块浮着的挂件得跟着重画一遍，不然它按"还没这个类型"算了。
   */
  React.useSyncExternalStore(subscribePanelTypes, panelTypesRevision, panelTypesRevision);
  const bare = panelType(panel.kind)?.floatBare === true;

  const grab = (kind: 'move' | 'size') => (e: React.PointerEvent) => {
    // 锁着就没有"拖动"这回事。操纵件本来就没渲染，这儿再挡一道，
    // 免得以后谁把按钮放回锁着的那一支里，悄悄又能拖了
    if (locked || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      /* 忽略 */
    }
    mode.current = kind;
    start.current = { x: e.clientX, y: e.clientY, pid: e.pointerId, from: latest.current ?? start.current.from };
  };

  return (
    <div
      ref={box}
      className={`float-panel${locked ? ' is-locked' : ''}${bare ? ' bare-float' : ''}`}
      style={
        rect
          ? { left: rect.x, top: rect.y, width: rect.width, height: rect.height }
          : // 还没量到区域：挂在这儿把 ref 接上就行，别先画在 (0,0) 再飞过来
            { display: 'none' }
      }
      onPointerDownCapture={unlockGesture.onPointerDownCapture}
      onContextMenuCapture={unlockGesture.onContextMenuCapture}
      onPointerMove={onMove}
      onPointerUp={endSession}
      onPointerCancel={endSession}
      onLostPointerCapture={endSession}
    >
      <div className="float-body">
        <PanelSurface panel={panel} hostKey={hostKey} />
      </div>

      {unlockGesture.point && (
        <span
          className="float-unlock-progress"
          style={{ left: unlockGesture.point.x, top: unlockGesture.point.y }}
          aria-hidden="true"
        >
          <svg viewBox="0 0 40 40">
            <circle className="float-unlock-track" cx="20" cy="20" r="15" />
            <circle ref={unlockGesture.progress} className="float-unlock-fill" cx="20" cy="20" r="15" pathLength="1" />
          </svg>
          <IconLock />
        </span>
      )}

      {!locked && (
        <>
          <button
            className="float-lock"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setLocked(true)}
            title={t('锁定')}
          >
            <IconLock open />
          </button>
          <div className="float-bar" onPointerDown={grab('move')} title={t('拖动')}>
            <span
              className={`float-dot ${statusClass(panel)}`}
              style={{ background: statusColor(panel), color: statusColor(panel) }}
              title={statusLabel(panel)}
            />
            <span className="float-title">{panel.title}</span>
          </div>

          <button
            className="float-unlock"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => void api.panel.dockFloat(panel.id, null)}
            title={t('解除悬浮')}
          >
            {t('解除')}
          </button>

          <div className="float-resize" onPointerDown={grab('size')} title={t('改大小')} />
        </>
      )}
    </div>
  );
}
