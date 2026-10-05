import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { zoomScale } from '../ui/zoom-space';
/**
 * 面板的自适应层 —— 装不下的内容**整块缩放**着装进这块地方，
 * 而不是裁掉半边、也不是弹一根滑条。
 *
 * **所有面板都过这一层，面板自己一句话都不用说** —— 这才叫"原生支持缩放"。
 * 判据是**内容的行为**，不是面板的声明：
 *
 *   · 内容**滚得动**（有 overflow:auto/scroll 的层、而且真的溢出了）→ 弹性内容。
 *     会话、文件树、编辑器、网页全走这条：它们自己滚才是对的，一根手指都不碰。
 *   · 内容**滚不动**（`overflow:hidden` 那句话的意思是"我自己裁，别管我"）→
 *     固定尺寸的内容（一块钟、一张卡、一个计数器）。它装不下就是真装不下，
 *     整块缩放着装进容器：拉大就涨、拉小就缩，既不出现滚动条也不裁掉半截。
 *
 * 唯一要声明的例外是 `data-fit="off"`：只给**自己就在管缩放**的面板（无限画布有
 * view.z），免得被缩两遍。例外就该少，别到处加 —— 加一个就多一块要手动写通的地方。
 *
 * ## 量法：摆出两种环境各量一次，量完当场还原（这是这一层唯一要讲究的地方）
 *
 * 前两版都栽在同一件事上：**在"装它的容器"里量内容**。容器给什么尺寸，内容就报什么
 * 尺寸 —— 撑满容器的那层壳（height:100%）永远等于容器那么大，flex 还会把内容压扁，
 * 于是"内容想要多大"永远不小于"容器多大"，倍率算出来只能是 1 附近：**该缩的时候一点
 * 没缩，内容被 overflow:hidden 裁掉一截**（现场就是"挡住一块，拉长容器才好"）。
 *
 * 所以摆两趟：
 *   第一趟 撑满容器（真实的渲染环境）—— 只用来认"内容会不会滚"，弹性内容就地退出；
 *   第二趟 width:max-content / height:auto（**不受容器约束**）—— 这一趟才量得出
 *          "内容本来想占多大"：百分比高度退化成按内容排、flex 不再压扁。
 *
 * 写-读-写都在同一个任务里完成，浏览器到这一刻还没画，用户看不见任何闪动；
 * 量到的尺寸与当前倍率无关，所以缩得下去、也涨得回来。
 */

/** 兜住极端尺寸（被拖成一条缝 / 摊满整个大屏幕）算出来的荒唐值 */
const FIT_MIN = 0.3;
const FIT_MAX = 2.2;
/** 只用掉可用空间的 98%：贴着边界量，很容易在两三个相邻倍率之间来回跳 */
const FIT_MARGIN = 0.98;
/** 判定容差（px）。亚像素的差会把判定翻来覆去，缩放在原地抖 */
const EQ = 1;

const clampFit = (n: number) => Math.min(FIT_MAX, Math.max(FIT_MIN, Math.round(n * 1000) / 1000));

/**
 * 内容**自己滚不滚得动**。
 *
 * 只认 `auto / scroll`，`hidden` 不算 —— hidden 的元素 `scrollHeight` 照样反映溢出的
 * 内容，但那句话的意思是"我自己裁，别管我"，正是挂件的样子（番茄钟就是如此）：
 * 它滚不动，恰恰是最该被整体缩放的那一种。
 *
 * 按 DOM 顺序走、第一个命中就返回：滚动层基本都在最前面几个（会话是第 3 个），
 * 长会话不至于把上千条消息的计算样式全读一遍。
 */
function scrollsIn(stage: HTMLElement): boolean {
  for (const el of stage.querySelectorAll<HTMLElement>('*')) {
    const cs = getComputedStyle(el);
    const y = cs.overflowY === 'auto' || cs.overflowY === 'scroll';
    const x = cs.overflowX === 'auto' || cs.overflowX === 'scroll';
    if (x || y) return true;
  }
  return false;
}

/**
 * 内容**实际占了多大**（外接框的跨度）。
 *
 * 用外接框而不是 scrollWidth/scrollHeight：居中的内容向两边溢出的那种，
 * scrollWidth 只算右下方向，左边那半截它根本不认。
 *
 * 跳过 `offsetParent === null` 的元素 —— 那正是 `position: fixed` 和 `display:none`
 * 两种：fixed 的框是相对**视口**的，混进来会把外接框撑到整个窗口那么大，
 * 于是什么面板都会被判定成"装不下"。这一步不花额外代价（不用读计算样式）。
 *
 * rect 量到的是**屏幕单位**（面板缩放已经乘在里面了），而这里的尺寸要跟下面
 * 一起算比例 —— 两边要么都乘了倍率、要么都没乘。统一换成面板内部单位再返回：
 * 差这一个倍率，面板放大过的内容就会被平白判定成"装不下"而缩过头。
 */
function unionBox(stage: HTMLElement): { w: number; h: number } {
  const k = zoomScale(stage);
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const el of stage.querySelectorAll<HTMLElement>('*')) {
    if (el.offsetParent === null) continue;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    if (r.left < left) left = r.left;
    if (r.top < top) top = r.top;
    if (r.right > right) right = r.right;
    if (r.bottom > bottom) bottom = r.bottom;
  }
  return Number.isFinite(left) && Number.isFinite(top)
    ? { w: (right - left) / k, h: (bottom - top) / k }
    : { w: 0, h: 0 };
}

export function FitBox({ children }: { children: React.ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;

  const measure = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const el = outer.current;
    if (!el) return;

    let raf = 0;
    const apply = (next: number) => {
      // 差得不多就别动：省掉"量 → 改 → 再量"在原地来回抖
      if (Math.abs(next - zoomRef.current) > 0.01) {
        zoomRef.current = next;
        setZoom(next);
      }
    };

    /** 两趟各量一次，量完当场还原。null = 这次不用管（面板自己管缩放 / 还没量到尺寸） */
    const probe = () => {
      const st = stage.current;
      if (!st) return null;
      // 面板明说"别管我"：它自己管缩放，连量都不用量
      if (st.querySelector('[data-fit="off"]')) return null;
      // 可用空间是**布局单位**（`.fit-box` 那个盒子没被乘过倍率），而 unionBox
      // 刚按内部单位报了内容尺寸 —— 乘回去，两边同单位，比例才对。
      const k = zoomScale(el);
      const availW = el.clientWidth * k;
      const availH = el.clientHeight * k;
      if (!availW || !availH) return null;

      const prev = { w: st.style.width, h: st.style.height, t: st.style.transform };
      const restore = () => {
        st.style.width = prev.w;
        st.style.height = prev.h;
        st.style.transform = prev.t;
      };

      // 第一趟：真实的渲染环境（撑满容器）。只用来认"会不会滚" ——
      // 会话、文件树、网页在这儿就认出来了，重的那趟一次都不用干
      st.style.width = '100%';
      st.style.height = '100%';
      st.style.transform = 'none';
      const scrolling = scrollsIn(st);
      if (scrolling) {
        restore();
        return { availW, availH, scrolling: true, box: { w: 0, h: 0 } };
      }

      // 第二趟：**不受容器约束**的环境，见文件头。这一趟才量得出内容本来想占多大
      st.style.width = 'max-content';
      st.style.height = 'auto';
      const box = unionBox(st);
      restore();

      return { availW, availH, scrolling: false, box };
    };

    const run = () => {
      raf = 0;
      const p = probe();
      // 会滚 = 弹性内容，自己不碰；量不到内容（还是空的、图没加载完）就按原尺寸
      if (!p || p.scrolling || !p.box.w || !p.box.h) {
        apply(1);
        return;
      }
      apply(clampFit(Math.min(p.availW / p.box.w, p.availH / p.box.h) * FIT_MARGIN));
    };
    measure.current = () => {
      if (!raf) raf = requestAnimationFrame(run);
    };

    // 装它的地方变了、或者内容自己变了 → 重量一次。两轴都跟着走：拉大就涨、拉小就缩
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => measure.current());
      ro.observe(el);
      if (stage.current) ro.observe(stage.current);
    }
    // 图片、字体这些异步来的东西加载完，内容尺寸就变了，可 React 不会因此重渲染 ——
    // 靠 load 补一次（load 不冒泡，得用捕获）
    el.addEventListener('load', measure.current, true);
    measure.current();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      el.removeEventListener('load', measure.current, true);
    };
  }, []);

  // 内容变高变矮（换了段、多出一行提示、整块面板被换成别的类型）也要重量一次。
  // 组件里 setState 会再渲染一轮，但 apply() 有死区，停下来了就不会再量。
  useEffect(() => {
    measure.current();
  });

  /*
   * 内层按倍率的**倒数**给尺寸，再整体 scale 回去 —— 两边正好抵消，于是它缩放后
   * 恰好填满外层（100% / z 再乘 z = 100%）。不这么做的话，内层的布局宽度还是外层
   * 那么大，缩放后会溢出去一截（右下角露出一块空）。
   *
   * 倍率是 1 时**一个 transform 都不写**：那会凭空造出一个新的包含块，
   * 面板里 absolute / fixed 的层（看图那一层之类）会跟着改参照系 ——
   * 不能因为"过了一层包装"就让老面板的定位变样。
   */
  const sized =
    zoom === 1
      ? { width: '100%', height: '100%' }
      : { width: `calc(100% / ${zoom})`, height: `calc(100% / ${zoom})`, transform: `scale(${zoom})` };

  return (
    <div className="fit-box" ref={outer} data-zoom={zoom}>
      <div className="fit-inner" ref={stage} style={{ ...sized, ['--panel-zoom' as any]: zoom }}>
        {children}
      </div>
    </div>
  );
}