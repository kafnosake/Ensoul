import React, { useRef, useState } from 'react';
import type { PanelNote } from '../../../shared/types';
import { t } from '../../core/i18n';

/**
 * 便签刻度 —— 贴在**消息列右边缘**外侧那道留白里的一条细刻痕，
 * 不占宽度、不挡视线。
 *
 * 一条便签一个刻度，越新的越靠下。鼠标指到**这一带**（不用正好指到那一格），
 * 最近的那一格就吸过来亮起来，那一条的内容在左边摊开；点一下可以把卡片钉住。
 *
 * 刻度**不表示进度** —— 它就是个把手。挂着自己那句话的回答标记时亮一点，
 * 一眼能看出哪几条有内容（这一轮还没答完的那几条是暗的）。
 *
 * ── 为什么只摆最近的 ──────────────────────────────────────────────────
 *
 * 摆满几十格的时候，整条带子既长又密，每一格细得像头发丝 —— 点不中，
 * 也认不出。而且条数每多一条，整串的排法就跟着变一次。所以这里只摆最近
 * VISIBLE 条（贴底排，最新的一条永远在最下面），更早的收起来，顶上留一格
 * 极小的提示说明"还有几条"。
 *
 * 为什么不是"右边一栏"：一栏要吃掉一两百像素，为了几条便签把对话挤窄，本末倒置 ——
 * 这条东西**占据的宽度是 0**：它盖在会话区右边缘上，会话区该多宽还是多宽。
 *
 * **一条便签都没有的时候也照样摆出来**（只是空着）：文件面板里会话区的右边缘
 * 本来什么都没有，用户会以为"这一块根本没有控制"。空着的那条轨道 + 那两条拖边
 * 一起，才说明得清"这里能拖"。有便签时才有刻痕 —— 那是数据的事，不是控制的事。
 */

/** 一次最多摆几格 —— 便签是"最近定过什么事"的记录，不是全史 */
const VISIBLE = 30;
/** 吸附半径：鼠标离最近那一格中心超过这么多像素，就当没指着它 */
const SNAP = 72;

export function NoteGauge({
  notes,
  onHover,
  onPick,
}: {
  notes: PanelNote[];
  onHover(note: PanelNote | null, el?: HTMLElement | null): void;
  onPick(note: PanelNote, el: HTMLElement): void;
}) {
  const ticks = useRef<(HTMLElement | null)[]>([]);
  const hotRef = useRef(-1);
  const [hot, setHot] = useState(-1);

  const empty = notes.length === 0;
  const shown = notes.length > VISIBLE ? notes.slice(-VISIBLE) : notes;
  const more = notes.length - shown.length;
  ticks.current.length = shown.length;

  /**
   * 鼠标在这一带的哪个高度 → 指着哪一格。
   * **按最近的算**，不是"进了那一格才算"：刻度只有几个像素高，
   * 要求用户把鼠标停在它上面，等于要求他做一次瞄准。
   */
  const aim = (clientY: number) => {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < shown.length; i++) {
      const el = ticks.current[i];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const d = Math.abs(clientY - (r.top + r.height / 2));
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return bestD <= SNAP ? best : -1;
  };

  /** 换一格才通知外面 —— 同一格上晃来晃去不该反复重渲染 */
  const mark = (i: number) => {
    if (i === hotRef.current) return;
    hotRef.current = i;
    setHot(i);
    onHover(i >= 0 ? shown[i] : null, i >= 0 ? ticks.current[i] : null);
  };

  return (
    <div
      className={`note-gauge${empty ? ' is-empty' : ''}`}
      title={empty ? t('拖这条边改列宽') : `便签 ${notes.length} 条`}
      onMouseMove={empty ? undefined : (e) => mark(aim(e.clientY))}
      onMouseLeave={empty ? undefined : () => mark(-1)}
      onClick={
        empty
          ? undefined
          : (e) => {
              const i = aim(e.clientY);
              const el = ticks.current[i];
              if (i >= 0 && el) onPick(shown[i], el);
            }
      }
    >
      {more > 0 && <span className="note-tick is-more" title={t('还有 {n} 条更早的', { n: more })} />}
      {shown.map((n, i) => (
        <span
          key={`${n.at}-${i}`}
          ref={(el) => {
            ticks.current[i] = el;
          }}
          className={`note-tick${n.marks.length ? ' has-marks' : ''}${i === hot ? ' is-hot' : ''}`}
        />
      ))}
    </div>
  );
}
