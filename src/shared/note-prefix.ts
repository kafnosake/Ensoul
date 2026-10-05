/**
 * 便利贴投给员工时，话题上那句话的**固定前缀**。
 *
 * 为什么单独放一个文件：贴在员工眼前的正文**只留这一行 + 原话**，别的（来源白板、
 * 便签 id、回执怎么回）一个字都不许混进去 —— 混进去就是视线噪音，用户明确不要。
 * 于是"来源"只能靠前缀认，前缀就必须**只有一个真源**：渲染层这两处
 * （`plugins/notes/panel.tsx` 拼、`src/renderer/shell/SidebarMonitor.tsx` 补）
 * 都从这里取，别再各写一份字面量。
 *
 * 主进程那边（`plugins/notes/index.js`）拿不到 TS 模块，它在自己文件里另写了一份
 * 同名常量并注明同步 —— 那边认前缀只为"回执时剥掉它"，字面对上即可。
 */
export const NOTE_PREFIX = '【来自便利贴】';

/**
 * 老前缀。历史消息、老便签里还带着它：
 * - 拼接时先认旧的，避免叠成两行；
 * - 回执剥前缀时两种都算。
 */
export const LEGACY_NOTE_PREFIX = '【来自便签】';

export function hasNotePrefix(text: string): boolean {
  return text.startsWith(NOTE_PREFIX) || text.startsWith(LEGACY_NOTE_PREFIX);
}

/** 把前缀（新旧都算）从正文头上摘掉，剩下的就是用户那句原话 */
export function stripNotePrefix(text: string): string {
  const t = String(text || '');
  const hit = [NOTE_PREFIX, LEGACY_NOTE_PREFIX].find((p) => t.startsWith(p));
  return hit ? t.slice(hit.length).replace(/^\s+/, '') : t;
}
