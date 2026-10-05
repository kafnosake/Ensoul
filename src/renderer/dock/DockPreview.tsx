import React from 'react';
import { isBarHit, previewRect, type ProbeHit } from './drag';

/**
 * 落点预览：整个窗口只有这一层，fixed 定位。
 * 因为它始终是同一个元素，跨标签组移动时是平滑滑过去的，不会闪。
 *
 * `hidden`：这一拖松手其实是"拿出来"（变成一块悬浮窗），预览框就该收掉 —— 
 * 还画着一个"并进去"的框，界面就是在撒谎。
 */
export function DockPreview({
  hit,
  hidden,
  sameGroup,
}: {
  hit: ProbeHit | null;
  hidden?: boolean;
  /** 这一落等于没落（自己那组里换位置 / 搬自己到自己身上）：这种由空位说话，不画框 */
  sameGroup?: boolean;
}) {
  /*
   * 落在标签栏上也算一处落点，画成标签栏那一条 —— 但要分两种情形：
   *
   *   · 拖到**别的**标签组上 → 画。以前这里对 tabs 一律不画（理由是"由空位来说"），
   *     可空位只在目标那一组里、又很窄，隔着一个标签组看过去几乎等于没有反馈 ——
   *     "能并入的时候反而什么预览都没有"说的就是它。
   *   · 落在**自己这一块**上（`sameGroup`，见 drag.ts 的 isNoop）→ 不画：
   *     那些落点松手之后什么都没发生，画个框出来就是空头承诺。
   */
  if (!hit || hidden || sameGroup) return null;
  const r = previewRect(hit);
  return (
    <div
      // 收纳区那个落点也走这一层框：那一整段就是盒子，一眼看得出收到哪儿去
      className={`dock-preview mode-${isBarHit(hit) ? 'bar' : hit.mode}`}
      style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
    />
  );
}
