import React, { useEffect, useRef, useState } from 'react';
import type { DockNode } from '../../shared/types';
import { isTabGroup } from '../../shared/types';
import { api } from '../core/api';
import { useWorkspace } from '../core/useWorkspace';
import { DockPreview } from '../dock/DockPreview';
import { ZoneHint } from './ZoneHint';
import { DockTree } from '../dock/DockTree';
import { askForeignThrottled, dragHint, groupBox, hitDock, isNoop, isOutside, leftTabstrip, onlyTabs, placeDrag, tabAnchor, willDetach, type DragSource, type DragState } from '../dock/drag';
import { IconClose, IconCollect, IconMax, IconMin } from '../ui/icons';
import { usePanelZoom } from '../ui/ZoomOverlay';
import { useCloseActivePanel } from '../ui/active-panel';
import { t } from '../core/i18n';

/**
 * 我那个标签的中心在本窗口里的位置 —— 当跟手锚点报给主进程。
 *
 * 直接量 DOM：标签栏的左内边距、把手宽度、有没有窗口按钮，这些都只有这一层知道。
 * 量不到就退回一个大致值（新窗口的标签永远紧挨左端）。
 */
function anchorHere(): [number, number] {
  const tab = document.querySelector<HTMLElement>('.floating-shell .tab');
  const r = tab?.getBoundingClientRect();
  if (!r) return [60, 17];
  return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
}

/** 这扇浮窗里一共几个标签（整棵树数一遍） */
const countTabs = (node: DockNode): number =>
  isTabGroup(node) ? node.panels.length : countTabs(node.children[0]) + countTabs(node.children[1]);

/**
 * 浮窗：一棵小的停靠树。
 *
 * 它不是一个"装单个面板的盒子" —— 里面照样能叠标签、能分成几块、能再拖出新的浮窗，
 * 和主窗口用的是同一个 DockTree。右下角可以拉大小；标题栏拖回主窗口就停靠回去。
 */
export function FloatingShell({ windowId }: { windowId: string }) {
  const ws = useWorkspace();
  usePanelZoom();
  /** Ctrl/⌘+W 关的是当前会话 —— 那个键由主进程按住（见 main/windows.ts） */
  useCloseActivePanel(ws);
  const win = ws?.floating.find((w) => w.id === windowId);
  const [drag, setDrag] = useState<DragState | null>(null);
  const pending = useRef<{ source: DragSource; x: number; y: number; moved: boolean; pid?: number } | null>(null);
  const live = useRef<DragState | null>(null);
  const raf = useRef(0);
  /** 这一拖已经交给一块真窗口了：跟手和落点都归主进程，渲染层只负责报点 */
  const handedOff = useRef(false);
  /** 拖动期间的心跳定时器：手停在半空不动时，全靠它告诉主进程"还按着" */
  const beat = useRef(0);

  const cursor = useRef({ x: 0, y: 0 });
  /** 标题栏拖动 / 拉大小 是否进行中 —— 窗口级兜底松手时靠它收尾 */
  const barHeld = useRef(false);
  const szHeld = useRef(false);
  /** 这一拖其实是"搬整扇窗"（本浮窗里只有一个标签），不撕新窗 */
  const wholeHeld = useRef<{ x: number; y: number; pid?: number; moved: boolean; panelId?: string } | null>(null);

  useEffect(() => {
    const flush = () => {
      raf.current = 0;
      const p = pending.current;
      if (!p) return;
      const { x, y } = cursor.current;
      const outside = isOutside(x, y);
      // 离开**它出发的那条标签栏**了没有 —— 浏览器那种"拖出去就是拿出来"靠它
      const outOfBar = !outside && leftTabstrip(p.source.kind === 'component' || p.source.kind === 'monitor' ? undefined : p.source.tabId, x, y);
      const next: DragState = {
        source: p.source,
        from: { kind: 'floating', windowId },
        x,
        y,
        /*
         * 落点就是光标底下那个标签组、那个方位。**没有兜底**：
         * 没压在标签栏上、也没贴着边 → hit 为空，意思是"停在空处"，
         * 那就该按"拿出来"处理（见 willDetach），绝不能替它决定一个归宿。
         *
         * 上一版在这里兜了一句"光标还在本窗口里就算并进这组标签"，本意是修"并不回来"，
         * 结果两头都坏：浮窗里的 hit 永远不为空 → 标签根本撕不出来；
         * 丢在主体上也变成并回去。并入只有一个入口 —— **标签栏**。
         */
        hit: outside ? null : onlyTabs(hitDock(x, y)),
        // 本窗口自己判不出收纳区（它在主窗口的顶栏上）：落在它上面那条路靠 foreign（见下）
        outside,
        outOfBar,
      };
      live.current = next;
      setDrag(next);
      /*
       * 和松手那条路用**同一个判据**（willDetach），两个壳也同一套。
       *
       * 这里以前手写的是 `outside || (outOfBar && !hit)`，和主窗口那份**不完全一样**：
       * 同一个动作，从主窗口拖和从浮窗拖会得到不同结果，出了问题更看不出哪边错。
       */
      if (!handedOff.current && willDetach(next)) {
        handOff();
      }
      /*
       * 指针在窗口外：问一句「底下是谁、它说落在哪」。
       * 就是这一句让「从浮窗里把标签拖到主窗口上」吸附得进去 ——
       * 以前窗口外一律当成「自己立户」，主窗口明明就在光标底下也没人问它。
       */
      if (next.outside) {
        const ask = askForeignThrottled();
        if (ask) {
          void ask.then((f) => {
            const cur = live.current;
            if (!cur || !cur.outside) return;
            const nx = { ...cur, foreign: f };
            live.current = nx;
            setDrag(nx);
          });
        }
      }
    };

    const onMove = (e: PointerEvent) => {
      /*
       * 搬整扇窗那一拖（本浮窗只有一个标签）：和拖标题栏走同一条通道。
       * 这里也要等超过阈值才真开始 —— 否则点一下标签就会把窗口挪走一小截。
       */
      const whole = wholeHeld.current;
      if (whole) {
        cursor.current = { x: e.clientX, y: e.clientY };
        if (!whole.moved) {
          if (Math.hypot(e.clientX - whole.x, e.clientY - whole.y) < 6) return;
          whole.moved = true;
          /*
           * 捕获挂**壳**上，不挂标签上。搬窗走完之后这块面板可能已经不在这一扇窗里了
           * （被并进了别处），标签元素随之卸载 —— 捕获元素一卸载，浏览器当场收回捕获，
           * 松手信号就再也回不来，这一拖会永远挂着。
           */
          try {
            shellRef.current?.setPointerCapture?.(whole.pid!);
          } catch {
            /* 合成事件没有有效 pointerId */
          }
          // 真在拖了才开搬窗会话：单纯点一下标签就开会话，等于留下一个没人收的锚点
          api.window.beginDrag();
        }
        if (!raf.current) {
          raf.current = requestAnimationFrame(() => {
            raf.current = 0;
            api.window.moveDrag();
          });
        }
        return;
      }
      const p = pending.current;
      if (!p) return;
      cursor.current = { x: e.clientX, y: e.clientY };
      if (!p.moved) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 6) return;
        p.moved = true;
        /*
         * 确认真在拖了，才把指针攥到**壳元素**上。
         * 按下就攥住是不行的：那样这一次点击的 pointerup 会落到壳上，
         * click 再也送不到按钮上（收纳区整条点不动就是这个原因）。
         * 攥在壳上而不是标签上：标签会被卸载（拖出去时它就从布局树里走了），
         * 捕获元素一被卸载，浏览器当场收回捕获，松手信号就再也回不来了。
         */
        try {
          shellRef.current?.setPointerCapture?.(p.pid ?? 0);
        } catch {
          /* 合成事件没有有效 pointerId：窗口内这一拖照样走得完 */
        }
      }
      // 已经交出去了：这一拖由主进程挪那块真窗口，这里只负责每帧报一句"还在拖"与存活心跳
      if (handedOff.current) {
        if (!raf.current) {
          raf.current = requestAnimationFrame(() => {
            raf.current = 0;
            api.window.tearMove();
            api.window.tearTick();
          });
        }
        return;
      }
      if (!raf.current) raf.current = requestAnimationFrame(flush);
    };

    /** 把这一拖交给一块真窗口：这个标签从这扇浮窗里摘出去，当场立户跟手 */
    const handOff = () => {
      const p = pending.current;
      if (!p || p.source.kind === 'component' || p.source.kind === 'monitor') return;
      handedOff.current = true;
      if (!beat.current) {
        beat.current = window.setInterval(() => {
          api.window.tearTick();
        }, 150);
      }
      api.window.tearTick();
      // 带上**固定锚点**：光标压在新窗口那个标签的中心。
      const box = { ...groupBox(p.source.tabId), ...tabAnchor(p.source.tabId, p.source.kind === 'panel' ? p.source.panelId : undefined) };
      const undo = (ok: boolean) => {
        if (ok) return;
        handedOff.current = false;
        pending.current = null;
        live.current = null;
        if (beat.current) {
          clearInterval(beat.current);
          beat.current = 0;
        }
        setDrag(null);
      };
      const ask = p.source.kind === 'panel'
        ? api.panel.tear(p.source.panelId, box)
        : api.dock.tearTabs(p.source.tabId, box);
      void ask.then(undo, () => undo(false));
    };

    const onUp = () => {
      const whole = wholeHeld.current;
      if (whole) {
        wholeHeld.current = null;
        if (whole.pid != null) {
          try {
            shellRef.current?.releasePointerCapture?.(whole.pid);
          } catch {
            /* 已经自己释放了 */
          }
        }
        if (raf.current) {
          cancelAnimationFrame(raf.current);
          raf.current = 0;
        }
        if (whole.moved) api.window.endDrag();
        // 没挪动就是点了一下这个标签：那一下的本意是"切到这块面板"
        else if (whole.panelId) void api.panel.activate(whole.panelId);
        return;
      }
      const pid = pending.current?.pid;
      if (pid != null) {
        try {
          shellRef.current?.releasePointerCapture?.(pid);
        } catch {
          /* 已经自己释放了 */
        }
      }
      const p = pending.current;
      const d = live.current;
      const off = handedOff.current;
      pending.current = null;
      live.current = null;
      handedOff.current = false;
      if (beat.current) {
        clearInterval(beat.current);
        beat.current = 0;
      }
      if (raf.current) {
        cancelAnimationFrame(raf.current);
        raf.current = 0;
      }
      setDrag(null);
      // 兜底收尾：指针捕获失效、在窗口别处松手时，拖动/缩放的会话也必须结束 ——
      // 会话残留下来，之后按住别处划过把手就会按旧锚点算，窗口会突然暴涨
      if (barHeld.current) {
        barHeld.current = false;
        api.window.endDrag();
      }
      if (szHeld.current) {
        szHeld.current = false;
        api.window.resizeEnd();
      }
      // 交出去的那一拖：落点由主进程在光标底下那扇窗里判 —— 这里再判一次就落两遍
      if (off) {
        api.window.tearEnd();
        return;
      }
      if (!p) return;
      if (!d) {
        if (p.source.kind === 'panel') void api.panel.activate(p.source.panelId);
        return;
      }
      /*
       * 从浮窗里把面板拖到**顶上那条收纳区**上，走的就是这条路：面板一离开标签栏就当场
       * 撕成一块真窗口（上面 handOff），松手由主进程问光标底下那扇窗 —— 那条判定认收纳区
       * （见 drag.ts 的 barHitAt），落到收纳区上就是把这块面板收起来。
       *
       * 窗口内的落点在这里就地处理：浮窗和主窗口并排、收纳区正好压在这扇窗身上时，
       * 本窗口自己就答得出来（filterForWindow 认得它）。
       */
      void placeDrag(d);
    };

    /**
     * 松手在别的窗口上时本窗口收不到 pointerup，会话会一直挂着 ——
     * 拖窗口 / 拉大小那两套残留下来最脏：之后按住别处划过把手，会按旧锚点算，
     * 窗口当场暴涨。窗口一失焦就当场把这两套会话收掉。
     */
    const onBlur = () => {
      // 撕窗弹出新浮窗时失焦是必然的，绝不能在 blur 时判定撕窗结束
      if (handedOff.current) return;
      if (wholeHeld.current) {
        const moved = wholeHeld.current.moved;
        wholeHeld.current = null;
        if (raf.current) {
          cancelAnimationFrame(raf.current);
          raf.current = 0;
        }
        if (moved) api.window.endDrag();
      }
      if (!pending.current && !barHeld.current && !szHeld.current) return;
      pending.current = null;
      live.current = null;
      if (beat.current) {
        clearInterval(beat.current);
        beat.current = 0;
      }
      if (raf.current) {
        cancelAnimationFrame(raf.current);
        raf.current = 0;
      }
      setDrag(null);
      if (barHeld.current) {
        barHeld.current = false;
        api.window.endDrag();
      }
      if (szHeld.current) {
        szHeld.current = false;
        api.window.resizeEnd();
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      if (beat.current) {
        clearInterval(beat.current);
        beat.current = 0;
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [windowId]);

  // 我是"刚被撕下来、正挂在光标下"的那一块 → 报一句，源窗口据此把跟手的吊牌收掉
  useEffect(() => {
    void api.window.isLive().then((live) => {
      if (live) api.window.liveReady();
    });
  }, [windowId]);

  /**
   * 撕下来的这一拖：**这块窗口自己就是光标底下那扇窗**，所以"还按着 / 松开了"由它来证明。
   *
   * 指针事件里带着按钮状态（buttons），这是唯一可靠的依据：
   *   · 收到 pointermove 且按钮按下 → 报一句"还按着"，主进程的看门狗就知道这一拖还活着；
   *     手停在半空不动时收不到 move，所以只要按钮还按着，就每 200ms 补一句
   *     （这个补报有来源：按钮真抬起来、或者光标离开这块窗口，它就停）。
   *   · 收到松手（pointerup，或者哪次 move 里按钮已经抬起）→ 当场报"松手了"。
   *
   * 这一步不能省：源窗口那边常常已经收不到事件了（指针在这块窗口身上），
   * 只靠它报松手，这一拖就会永远挂在半路。
   */
  useEffect(() => {
    /** 只有"刚被撕下来、正挂在光标下"的那一块才报证据；它落地之后就不再报了 */
    let armed = false;
    let timer = 0;
    /** 证据的有效期：动一下就续 5 秒；静着不动，它自己会枯掉 */
    let until = 0;
    const stop = () => {
      if (timer) {
        window.clearInterval(timer);
        timer = 0;
      }
    };
    const beat = () => {
      /*
       * 证据必须**会自己枯掉**。它是"还按着"的证明，可万一按钮其实早抬了
       * （松手那一刻没送到我们任何一扇窗），一条永远响下去的证明会把看门狗按死，
       * 这一拖就再也收不了尾 —— 那才是真正的卡死。所以静默过了有效期就停。
       */
      if (performance.now() > until) {
        stop();
        return;
      }
      api.window.tearTick();
    };
    const arm = (ms: number) => {
      until = performance.now() + ms;
      if (!timer) timer = window.setInterval(beat, 200);
      api.window.tearTick();
    };
    const onMove = () => {
      if (!armed) return;
      arm(8000);
    };
    const onUp = () => {
      if (!armed) return;
      stop();
      armed = false;
      api.window.tearEnd();
    };
    const onLeave = () => {
      // 光标划出浮窗边缘去瞄准落点是正常操作，不立即清空 until，保持正常缓冲
    };
    void api.window.isLive().then((v) => {
      if (!v) return;
      /*
       * 证据**当场就开始报**，不等第一次 pointermove。
       *
       * 这一刻按钮一定是按着的 —— 这一拖正是"按着拖动"刚撕出来的。以前要等第一次
       * pointermove 才开张，可撕出来之后手常常先停一下：这一停，一条证据都没有，
       * 看门狗以为松手了，当场把还在进行的一拖结算掉 —— 就是"拖出去之后就脱离控制"。
       */
      /*
       * 先把**我自己的**标签中心报给主进程当跟手锚点。
       *
       * 越早越好：窗口是按"源窗口推出来的近似位置"建的，报过去它当场纠正偏移并重摆，
       * 之后整场跟手就都压在这个真值上。这一步只有新窗口做得到 —— 源窗口量的是
       * 它自己那条标签栏，跟这里不是一回事（见 drag.ts 里 tabAnchor 的说明）。
       */
      api.window.readyAnchor(...anchorHere());
      armed = true;
      arm(5000);
      api.window.liveReady();
    });
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointerleave', onLeave);
    return () => {
      stop();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointerleave', onLeave);
    };
  }, [windowId]);

  /* 上屏那一句已经并进上面那段（它要先报证据再报上屏），这里不重复报一遍 */

  // 撕下来那块真窗口上屏了 → 收掉源窗口内部的半透明跟手吊牌
  useEffect(
    () =>
      api.window.onLiveReady(() => {
        live.current = null;
        setDrag(null);
      }),
    [],
  );

  /** 主进程宣布"这一拖结束了"：本窗口把自己那份拖拽状态清干净 */
  useEffect(
    () =>
      api.window.onDragEnd(() => {
        handedOff.current = false;
        pending.current = null;
        live.current = null;
        if (beat.current) {
          clearInterval(beat.current);
          beat.current = 0;
        }
        if (raf.current) {
          cancelAnimationFrame(raf.current);
          raf.current = 0;
        }
        setDrag(null);
      }),
    [],
  );

  /** 整个浮窗的壳 —— 指针捕获挂在它上面（见 grab） */
  const shellRef = useRef<HTMLDivElement>(null);

  const grab = (source: DragSource, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    cursor.current = { x: e.clientX, y: e.clientY };
    pending.current = { source, x: e.clientX, y: e.clientY, moved: false, pid: e.pointerId };
  };

  const stop = (e: React.PointerEvent) => e.stopPropagation();

  const barDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      /* 忽略 */
    }
    barHeld.current = true;
    api.window.beginDrag();
  };
  /*
   * 拖动期间必须限流：窗口自己挪动也会让渲染层持续收到 pointermove，
   * 不拦一下就是每秒几十次 IPC 去改窗口 —— 主进程和系统两边互相顶，顶出抖动。
   * 一帧最多发一次，松手时把没发出去的那一帧取消。
   */
  const gestRaf = useRef(0);
  const throttle = (fn: () => void) => {
    if (gestRaf.current) return;
    gestRaf.current = requestAnimationFrame(() => {
      gestRaf.current = 0;
      fn();
    });
  };
  /**
   * 这两个从标题栏挪到了**整个窗口**上（浮窗没有标题栏了，见下面那段说明）——
   * 所以必须自己认「这一拖是不是我发起的」：在面板里选文字、拖里面的便签，
   * 同样会派发按着左键的 pointermove；不加这道闸门，鼠标在里面一动窗口就跟着跑。
   */
  const barMove = (e: React.PointerEvent) => {
    if (!barHeld.current || !e.buttons) return;
    throttle(() => api.window.moveDrag());
  };
  const barUp = () => {
    if (!barHeld.current) return;
    if (gestRaf.current) {
      cancelAnimationFrame(gestRaf.current);
      gestRaf.current = 0;
    }
    barHeld.current = false;
    api.window.endDrag();
  };



  return (
    <div
      className={`floating-shell${drag ? ' is-dragging' : ''}`}
      ref={shellRef}
      onPointerMove={barMove}
      onPointerUp={barUp}
      onPointerCancel={barUp}
    >
      {/*
       * 浮窗**没有**自己的标题栏 —— 顶上那一条就是标签栏（浏览器那样）。
       *
       * 原来那条 header 只干两件事（拖窗口、放窗口按钮），却占掉一整行，
       * 还把视觉焦点从标签上抢走。现在两件事各自并进标签栏那一条：
       *   · 拖窗口   → 标签栏的空白处（界面上它本来就是"窗口的顶"）
       *   · 窗口按钮 → 浮在这一条的右端（.floating-tools），位置和浏览器一致
       */}
      {/*
       * 左端那个小把手：浮窗没有标题栏，**挪窗口**得有个抓得住的地方。
       * 标签栏的空白处也能拖（见下面 stripTitle），但窗口里标签一多就一点空白都不剩 ——
       * 所以再给一个永远在、体积又小的把手。双击支持铺满全屏 / 还原。
       */}
      <span
        className="float-grip"
        onPointerDown={barDown}
        onDoubleClick={() => void api.window.control('maximize')}
        title={t('按住这里拖动这个窗口；双击铺满全屏 / 还原')}
      />

      <div
        className="floating-tools"
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          void api.window.control('maximize');
        }}
      >
        {win?.parent && (
          <span className="win-flag" title={t('这个窗口挂在别的窗口上，会跟着它一起动')}>
            {t('附属')}
          </span>
        )}
        <div className="win-buttons">
          <button onPointerDown={stop} onClick={() => void api.window.attach(windowId)} title={t('停靠回主窗口')}>
            <IconCollect />
          </button>
          <button onPointerDown={stop} onClick={() => void api.window.control('minimize')} title={t('最小化')}>
            <IconMin />
          </button>
          <button onPointerDown={stop} onClick={() => void api.window.control('maximize')} title={t('最大化')}>
            <IconMax />
          </button>
          <button className="win-close" onPointerDown={stop} onClick={() => void api.window.control('close')} title={t('关闭并停靠回主窗口')}>
            <IconClose />
          </button>
        </div>
      </div>

      <main className="workspace">
        {ws && win ? (
          <DockTree
            node={win.root}
            ws={ws}
            host={{ kind: 'floating', windowId }}
            drag={drag}
            stripTitle={t('拖动这一条的空白处 = 移动这个窗口；双击 = 铺满全屏 / 还原')}
            onTabPointerDown={(panelId, tabId, e) => {
              /*
               * 这扇浮窗里**只有一个标签**时，拖它就该是搬这扇窗本身，而不是
               * 撕出一块新窗、把这一扇留成空壳（界面上就是旁边多一块只剩"+"的白窗）。
               * 判据就是整棵树里的标签总数：1 个 → 搬窗；2 个以上 → 才撕。
               */
              if (win && countTabs(win.root) <= 1 && e.button === 0) {
                e.preventDefault();
                wholeHeld.current = { x: e.clientX, y: e.clientY, pid: e.pointerId, moved: false, panelId };
                return;
              }
              grab({ kind: 'panel', panelId, tabId }, e);
            }}
            onStripPointerDown={(_tabId, e) => barDown(e)}
            onStripDoubleClick={() => void api.window.control('maximize')}
          />
        ) : (
          <div className="blank">
            {ws
              ? t('这块浮窗里已经没有内容了，它马上会被收回（不该一直留在屏幕上）。')
              : t('正在打开浮窗…')}
          </div>
        )}
      </main>

      <ZoneHint />
      <DockPreview hit={drag?.hit ?? null} hidden={!!drag && willDetach(drag)} sameGroup={!!drag && isNoop(drag)} />


      {drag && <div className="drag-hint">{dragHint(drag)}</div>}

      <div className="resize-handle" title={t('浮窗边缘与角落均可拉伸缩放')} />

    </div>
  );
}
