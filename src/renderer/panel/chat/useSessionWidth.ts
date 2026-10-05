import { useRef } from 'react';
import type React from 'react';
import type { Panel } from '../../../shared/types';
import { api } from '../../core/api';
import { SESSION_GUTTER, SESSION_W, SESSION_W_MIN } from './constants';
import { zoomScale, toPanelUnits } from '../../ui/zoom-space';

/**
 * 会话列的宽度 —— 会话区左右各一条**几乎看不见**的竖边，中轴对称。
 *
 * 拖任意一条，两条一起动：宽度 = 离中轴距离的两倍。所以它永远是居中一条，
 * 不会出现"往一边歪"的列。双击回到默认宽度。
 *
 * ── 为什么单独一份状态、单独一个文件 ──────────────────────────────────
 *
 * 便签那条刻度也贴在会话区的右边缘，但它跟这件事**毫无关系**：
 * 刻度宽度是 0，落在这一列的留白里（见 constants 里的 SESSION_GUTTER）。
 * 以前 ChatDock 的注释里写着"便签栏宽度"——那是错的：便签从来不是一栏、
 * 也没有一条可拖的缝。宽度是**会话列自己**的事，存 `panel.chatW`。
 *
 * ── "巨卡"是从哪儿来的 ────────────────────────────────────────────────
 *
 * 宽度改一格，浏览器就要把这一列的消息**全部重新排版一遍**。所以真正要治的
 * 不是宽度这个数字，是"这一列里有多少条 DOM"—— 那件事归 ChatDock 管（只渲染
 * 最近 PAGE 条，更早的点按钮才放出来，见 constants.ts）。DOM 降到几十条之后，
 * 拖宽度就是几十条的重排，实时跟着改也不卡，不必再绕什么花样。
 *
 * 剩下两条小账还在这一路上：**一个 React 渲染都不发**（宽度直接写 DOM 的
 * `--chat-w`，以前每次 pointermove 都 setState，那是把整块面板重渲染一遍），
 * 以及 pointermove 用 rAF 合并。
 */
export function useSessionWidth(panel: Panel) {
  /**
   * 面板的根节点 —— 松手时宽度**直接写进它的 `--chat-w`**，不走 React。
   *
   * 以前是每来一个 pointermove 就 `setLive(宽度)`：那就是把整块 ChatDock 重渲染一遍，
   * 而这个软件里一块对话面板动辄几百上千条消息（画布那块有九百多条），
   * 而且宽度一变，整整一列每条都要重新排版。一次拖动里塞几百次这个，机器直接趴下。
   * 宽度说到底只是两个数字，写进 DOM 就够了；松手落盘、状态推回来，React 自然对上。
   * 跟停靠树拖分割线是同一套写法（见 dock/DockTree.tsx）。
   */
  const root = useRef<HTMLDivElement | null>(null);
  const width = panel.chatW ?? SESSION_W;

  /**
   * 一条边能拖到的最宽处：会话区宽度减去两边留白（留白是给便签刻度的）。
   *
   * rect 是**屏幕单位**，而这个上限要跟 SESSION_W_MIN / SESSION_GUTTER 这些
   * 内部 px 比大小 —— 先换算回来，别让面板放大之后上限跟着虚高（见 ui/zoom-space.ts）。
   */
  const maxFor = (bodyEl: HTMLElement) =>
    Math.max(SESSION_W_MIN, toPanelUnits(bodyEl, bodyEl.getBoundingClientRect().width) - SESSION_GUTTER * 2);

  const paint = (w: number) => root.current?.style.setProperty('--chat-w', `${w}px`);

  const start = (e: React.PointerEvent, bodyEl: HTMLElement | null) => {
    if (!bodyEl) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = bodyEl.getBoundingClientRect();
    const center = rect.left + rect.width / 2; // 中轴：拖动中容器不会动，算一次就够
    const max = maxFor(bodyEl);
    /**
     * 面板缩放倍率：指针走的是屏幕距离，写进 --chat-w 的却是内部 px —— 差的就是它。
     * **在按下时算一次**：拖动中每一帧都读计算样式，等于每帧叫醒一次样式重算。
     */
    const k = zoomScale(bodyEl);
    document.body.classList.add('is-resizing');

    let w = panel.chatW ?? SESSION_W;
    let moved = false;
    let raf = 0;
    const move = (ev: PointerEvent) => {
      // 中轴对称：宽度就是"离中轴多远"的两倍，两条边一起动。
      // 先把屏幕距离换回内部单位再乘 2 —— 不换的话，面板放大过之后列宽会虚胖 k 倍，
      // 表现就是「指针到了、列没跟过来」。
      const half = Math.abs(ev.clientX - center) / k;
      w = Math.round(Math.max(SESSION_W_MIN, Math.min(max, half * 2)));
      moved = true;
      // pointermove 比帧密得多，多余的合并掉；一帧只写一个 CSS 变量
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          paint(w);
        });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      document.body.classList.remove('is-resizing');
      // 只点了一下、没拖：不动它，也不白写一次盘
      if (!moved) return;
      paint(w); // 定在最终值上，等状态推回来时不闪
      void api.panel.patch(panel.id, { chatW: w });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** 双击：回到默认宽度 */
  const reset = () => {
    paint(SESSION_W);
    void api.panel.patch(panel.id, { chatW: SESSION_W });
  };

  return { width, root, start, reset };
}

