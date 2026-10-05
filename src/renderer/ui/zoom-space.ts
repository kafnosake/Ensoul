/**
 * 面板缩放下的坐标换算 —— 一处说清，别处只管调用。
 *
 * 面板级缩放（`panel.uiZoom`）是拿 CSS `zoom` 套在 `.panel-zoom-inner` 上的
 * （见 PanelSurface.tsx 里为什么用 zoom 而不用 transform）。于是同一块面板里
 * 同时住着**两套长度单位**，平时相等、放大过之后就分家：
 *
 *   · **屏幕单位** —— 指针事件（clientX / clientY）、getBoundingClientRect()、
 *     window.innerWidth / innerHeight。全都**已经被乘过**那个倍率。
 *   · **本地布局单位** —— 面板内部那些 px 样式值（`--chat-w`、浮层的 left/top）、
 *     offsetWidth / offsetHeight、CSS 里的 50%。**没被乘过。**
 *
 * （这不是推断：Electron 33 / Chrome 130 实测 —— left:10px 的 fixed 元素在
 *   倍率 1.5 的面板里落在屏幕 15px 处；而同一个盒子的 rect.width / offsetWidth
 *   正好等于倍率。）
 *
 * 判据只有一条：**这个值是不是「距离 / 位置」**。
 *
 *   · 纯比值 —— 比如拖分割线的 `(鼠标 - 容器左边) / 容器宽`：分子分母都是屏幕
 *     单位，倍率自己约掉了，**不要换算**。拖挂件、拖窗口也都是这种。
 *   · 距离 / 位置，而且要按面板内部的 px 来使（写进样式、或跟内部常量比较）：
 *     **必须换算**，否则差一个倍率 —— 表现就是「指针到了、东西没跟过来」。
 *
 * 注意：**全局**缩放不归这里管。那是 Electron 原生的 setZoomFactor，屏幕单位
 * 与页面单位始终一致，比值天然是 1。
 */

/**
 * 屏幕 px ↔ 面板内部 px 的倍率。
 *
 * 从元素往上找**第一个真的带 zoom 的祖先**（就是面板那层壳）：zoom 本身不继承
 * —— 实测壳里没设 zoom 的孩子，计算值读到的就是 1 —— 所以只能这样上溯。
 *
 * 眼下全项目只有一层缩放壳，「第一个非 1」就是全部；哪天真出现嵌套的两层 zoom，
 * 这里得改成连乘。
 */
export function zoomScale(el: Element | null): number {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const z = parseFloat(getComputedStyle(n).zoom);
    if (z && z !== 1) return z;
  }
  return 1;
}

/**
 * 屏幕单位 → 面板内部单位。
 *
 * 长度和「以同一个原点量的位置」公式一致，所以一个函数够用 —— 要紧的是
 * **别把两边混着算**。留着两位小数：宽度、坐标都够用，不在这里替调用方取整。
 */
export function toPanelUnits(el: Element | null, screenValue: number): number {
  return Math.round((screenValue / zoomScale(el)) * 100) / 100;
}
