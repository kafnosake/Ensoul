/**
 * 工具输出的两只手：**留头留尾**，和**落盘取回**。
 *
 * 为什么单独一份放在 shared：从前模型看到的工具输出被两处不同的『截断』各砍一刀，
 * 而且有一档是只留开头 —— 构建报错、Node 崩溃调用栈、非零退出码恰恰都在**末尾**，
 * 于是模型拿着半截输出猜错误（历史《代码Agent工具优化范式》里那条就是这个）。
 * 现在统一成一条规矩：
 *
 *   1. 太长就**头尾都留**，中间省略并说明省略了多少字；
 *   2. 只要还没被落盘接走，尾部的诊断信息一定看得见。
 *
 * 放在 shared 是因为主进程（agent.ts）、工作线程（ptc-worker.ts）、任务服务
 * （task-service.ts）三处都要用同一把尺子 —— 各写一份，它们迟早对不齐。
 */

/** 尾部至少留这么多字：报错 / 调用栈 / 退出码都在这儿 */
export const TAIL_KEEP = 3_000;

/**
 * 掐长文本：留下 head 和 tail，中间那句说明省掉了多少。
 *
 * - 不超过 limit 就原样返回（**一个字节都不动**，不动才不会有『看起来变过』的假变化）。
 * - tail 是硬保底：limit 再小也不会把尾巴掐没，"前面的噪声换尾巴的报错" 是笔亏本买卖。
 * - head 可以为 0（只要尾巴），那种情况不重复写省略说明。
 */
export function clipOutput(text: string, limit: number, head = 4_000, tail = TAIL_KEEP, note = ''): string {
  const s = String(text == null ? '' : text);
  if (s.length <= limit) return s;
  const t = Math.max(0, Math.min(tail, Math.floor(limit / 2)));
  const h = Math.max(0, Math.min(head, limit - t));
  const cut = s.length - h - t;
  if (cut <= 0) return s;
  const why = note ? '；' + note : '';
  if (h <= 0) return '…（前面 ' + cut + ' 字没显示' + why + '）\n' + s.slice(-t);
  return s.slice(0, h) + '\n\n…（中间 ' + cut + ' 字没显示' + why + '）\n\n' + s.slice(-t);
}
