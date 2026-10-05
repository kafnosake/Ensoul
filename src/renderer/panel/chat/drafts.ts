/**
 * 每个面板**没发出去**的草稿（文字 + 粘好的图）—— 切标签、拖成浮窗、
 * 换窗口回来都还在。
 *
 * ── 为什么要单独有这么一份 ──────────────────────────────────────────
 *
 * 标签组里切面板时，PanelSurface 是 `key={active.id}`（见 DockTree.tsx）：
 * 换一个标签 = 旧组件卸载、新组件挂载。草稿原本躺在 ChatDock 的 useState 里，
 * 一卸载就归零 —— 打了一半的字、粘好的几张图，切过去看一眼回来就没了。
 *
 * ── 分两层 ────────────────────────────────────────────────────────
 *
 *   · 内存（本文件）：**同步**读写。卸载和重挂之间立刻接得上，切标签靠的就是它 ——
 *     不能等主进程把工作区写回来，那是异步的，重挂时可能还没到。
 *   · 工作区（panel.draft）：文字再顺手写一份，重启之后也还在。攒一下再写
 *     （敲一个字写一次盘不可接受）。
 *
 * 图**只留内存**：data URL 动辄几百 KB，塞进 workspace.json 会让每次保存
 * 都拖着它走。切标签能保住（这是用户真正碰到的那个问题），重启后不保留。
 */

const mem = new Map<string, { draft: string; shots: string[] }>();

/** 这个面板存着的草稿；没打过字就是 undefined */
export function readDraft(panelId: string) {
  return mem.get(panelId);
}

/** 每次改动都写一次（内存，同步，不落盘） */
export function writeDraft(panelId: string, v: { draft: string; shots: string[] }) {
  mem.set(panelId, v);
}
