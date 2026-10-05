/**
 * 看图：**谁都能叫开，同时只有一份 —— 而且只开在发起的那块面板里**。
 *
 * 为什么是一个模块级的小仓库，而不是给组件传 prop：
 * 图出现在好几个地方（助手回复里的图、进行中那块的过程图和成品图），
 * 而查看层同时只能有一份 —— 两边靠这里接起来。
 * 传 prop 的话，那个回调得一路穿过 chat 面板的每一层，而且它一变
 * Message（memo 过的）就整排重渲染 —— 为了一张图不值。
 *
 * 状态里为什么要带 panel：查看层不住在根上了，它住在**每块面板里**
 * （见 panel/PanelSurface 和 ui/ImageView）。一份全局状态要落到具体某一块面板上，
 * 就得知道这张图是**谁**点开的 —— 不是这块面板开的图，那块面板里的查看层不亮。
 *
 * 文件名刻意不叫 imageView —— 和组件 ImageView.tsx 只差一个字母的大小写，
 * 在 Windows / macOS 上会撞（`./ui/ImageView` 会解析到这个文件），
 * 而且这种撞法只在某些平台上报错，最难查。
 */
export type ImageViewState = {
  /** 要看的图（磁盘路径） */
  path: string;
  /** 在哪块面板里点开的 —— 查看层只在那块面板里铺开 */
  panel: string;
};

let current: ImageViewState | null = null;
const subs = new Set<(s: ImageViewState | null) => void>();

const emit = (s: ImageViewState | null) => {
  current = s;
  subs.forEach((f) => f(s));
};

/** 点开一张图：path 是磁盘路径，panel 是**发起的那块面板 id** */
export const openImage = (path: string, panel: string) => emit({ path, panel });

/** 关掉查看层 */
export const closeImage = () => emit(null);

/** 查看层挂载时订阅 —— 返回退订 */
export function subscribeImage(fn: (s: ImageViewState | null) => void) {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}
