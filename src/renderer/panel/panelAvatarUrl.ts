/**
 * 面板预设头像 —— 文件名 → 真正的 URL。
 *
 * 只有渲染层用得上：预置图在 `src/renderer/assets/panel-avatars/`，
 * 靠 `import.meta.glob` 交给 vite 处理（打进包、带 hash、给 URL）。
 * 主进程绝不能引这个文件 —— 它不认识 `import.meta`。
 *
 * 与员工头像**刻意不同路**：员工头像在 `.ensoul/state/avatars/`，是运行时产物，
 * 对模型/用户可换（"换张头像"就是往那儿写一个文件），用 `file://` 绝对路径。
 * 面板头像是**程序自带的美术资源**，跟版本走，不给换文件这条路。
 *
 * 现役格式是 **webp（每张 ≤20K，512px）**：84 张 PNG 原件共 12.4MB，进了仓库就是
 * 每次 clone 都背着一包 150KB 的 34px 缩略图。**原件不留备份** —— 要重压或改图，
 * 从美术那边重新拿 PNG，再跑 `python scripts/slim-avatars.py --target panel`。
 *
 * 查表**按文件名主干**，不认扩展名 —— 这样 png / webp 混着放也认得出来，
 * 美术哪天丢一批 png 进来，不用先改代码。
 */

const PNG = import.meta.glob('/src/renderer/assets/panel-avatars/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

const WEBP = import.meta.glob('/src/renderer/assets/panel-avatars/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/** 文件名主干 → url（webp 优先：同一张两个格式都在时用小的那份） */
const BY_STEM: Record<string, string> = {};
for (const [fullPath, url] of Object.entries(PNG)) {
  const stem = fullPath.slice(fullPath.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  if (stem) BY_STEM[stem] = url;
}
for (const [fullPath, url] of Object.entries(WEBP)) {
  const stem = fullPath.slice(fullPath.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  if (stem) BY_STEM[stem] = url;
}

/**
 * 取一张预设头像的 URL。给的文件名不存在（美术还没出到那一张）就返回 undefined ——
 * 调用方退回首字母字形，不报错、不空窗。
 */
export function panelAvatarUrl(fileName: string): string | undefined {
  const stem = String(fileName || '').replace(/\.[^.]+$/, '');
  return stem ? BY_STEM[stem] : undefined;
}

/** 手上到底有几张（排错时看一眼就知道 glob 有没有接上） */
export function panelAvatarCount(): number {
  return Object.keys(BY_STEM).length;
}
