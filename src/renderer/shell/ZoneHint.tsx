import React, { useEffect, useRef, useState } from 'react';
import { api } from '../core/api';
import { filterForWindow, probeAt, probeLabel, probeRect } from '../dock/drag';

/** 拖动中主进程每帧都会来问一次；这么久没人问，就认为这一拖已经结束了（主进程那边也有看门狗） */
const IDLE_MS = 3000;

/**
 * 收到「这一拖结束了」之后余下的这段时间里来的探测，一律不画。
 *
 * 这是残留的来源之一：主进程发问、本窗口答完，落地动作才发生；结束信号（probe:end）
 * 有可能**先**到，而那一条在路上的一问**后**到 —— 画上去之后就再没有人负责收它了，
 * 界面上会永远挂着一个过期的框。它不是"拖到哪了"，只是一句迟到的旁白。
 */
const LATE_MS = 1200;

/**
 * 落点提示 —— 拖动浮窗时「松手会落到哪」，由**光标底下这扇窗**自己画。
 *
 * 为什么得由目标窗口自己画：拖浮窗是主进程直接 setPosition 移窗口，渲染层手上
 * 既没有落点也没有命中信息。所以主进程只把**光标点**（换算成本窗口的坐标）
 * 发过来问一句；这里用 DOM 当场算出来、顺手画上、再把答案回给主进程。
 *
 * 这么一来，「画出来的那个框」和「松手真正发生的事」必然是同一个判定 ——
 * 都是下面这句 probeAt，不存在两套逻辑各说各的。
 */
export function ZoneHint() {
  const [hint, setHint] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
    label: string;
  } | null>(null);
  /** 上一次「这一拖结束」是什么时候 —— 用来挡掉迟到的探测 */
  const endedAt = useRef(0);
  /** 看门狗：拖动一停就自己收框，不指望结束信号一定到得了 */
  const idle = useRef(0);

  useEffect(() => {
    const stopIdle = () => {
      if (idle.current) {
        window.clearTimeout(idle.current);
        idle.current = 0;
      }
    };
    const clear = () => {
      stopIdle();
      setHint(null);
    };

    const offProbe = api.window.onProbe((q) => {
      /*
       * 浮窗里**只有一层标签**：四边落点降级成"并进这组标签"（见 filterForWindow）。
       * 但**不做兜底** —— 没压在标签栏上、也没贴边就是没落点，问了就答"没有落点"。
       * 兜成"整扇窗都算并进去"会让浮窗里的标签永远撕不出来（见 FloatingShell 里那段）。
       *
       * 顶上那条**收纳区**是唯一的例外：它在主窗口的顶栏上，不属于任何一块面板，
       * 却是"从浮窗里也能把面板收回去"的唯一通道（见 drag.ts 的 barHitAt）。
       *
       * `q.whole` = 主进程问的是"一整块浮窗落哪"：那种才认正中的「嵌成挂件」。
       */
      const raw = probeAt(q.x, q.y, Boolean(q.whole));
      const p = filterForWindow(raw, api.mode === 'floating');
      const r = p ? probeRect(p) : null;
      // draw: false 是松手那一刻问的 —— 只要答案，别在落地前又闪一下框
      // 迟到的那一条（结束信号已经到过了）同样只答不画
      if (q.draw !== false && Date.now() - endedAt.current > LATE_MS) {
        /*
         * 落在标签栏上也画 —— 画成标签栏那一条。以前这里把 tabs 一律排除，
         * 理由是"由标签让位来表示"，可那条让位只在**目标那一组里**、又很窄，
         * 拖着一块浮窗从别处过来时几乎看不出反应 ——
         * "拖到另一个面板上用来预览接入位置，需要这个框，但却没有"说的就是它。
         * 让位说"插在第几个"，框说"并进这一组"，两件事一起说才完整。
         */
        setHint(p && r ? { ...r, label: probeLabel(p) } : null);
        /*
         * 每问一次就把看门狗往后推。拖动中这个点一直在被问，框就一直在；
         * 一旦没人问了（松手、拖动被打断、那扇窗被并走）—— 盒子自己收掉。
         * 结束信号漏一次，界面上就是一个永远擦不掉的框，所以这道兜底必须有。
         */
        stopIdle();
        idle.current = window.setTimeout(() => {
          idle.current = 0;
          setHint(null);
        }, IDLE_MS);
      }
      api.window.probeReply(q.id, p);
    });
    const offEnd = api.window.onProbeEnd(() => {
      endedAt.current = Date.now();
      clear();
    });
    return () => {
      offProbe();
      offEnd();
      stopIdle();
    };
  }, []);

  if (!hint) return null;

  return (
    <div className="zone-hint" aria-hidden>
      <div className="zone-box" style={{ left: hint.left, top: hint.top, width: hint.width, height: hint.height }}>
        <span className="zone-label">{hint.label}</span>
      </div>
    </div>
  );
}
