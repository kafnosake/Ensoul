/**
 * 连续重复调用同一个工具、同一套参数时，在结果后面追一句提醒。
 *
 * 为什么：token 暴增最大的来源不是"读得多"，是**原地打转** ——
 * 同一个文件同一段读三遍、同一个关键词搜三遍、同一个命令跑三遍。
 * 每次结果都原样塞回上下文，钱照付，"智力"却一步没往前走。
 *
 * 判据刻意定成"**连续**"：中间插了别的工具调用就重新计数。
 * 跨轮的、隔着好几步的重复是正常的（回头确认一件事），
 * 只有一步不挪地重复才算卡住。
 *
 * 计数**按面板分开**：两块面板同时跑，各自交替调工具，一个共同的计数器会被
 * 对方的调用不断打断或续上 —— 该叫住的时候不叫，不该叫的时候瞎叫。
 *
 * ── 两条策略，按危险程度分开 ─────────────────────────────────────────
 *
 * 一、只读的重复（读文件、搜关键词）：**结果 + 一句提醒**，第 3、5、8 次提。
 *     挂的是 onAfterTool 而不是 onBeforeTool：重复调用该给的是"结果 + 提醒"，
 *     不是把结果换成提醒 —— 万一模型就是需要再看一眼那份内容呢。
 *
 * 二、会动手的重复（run_command / job_start / run_code）：**第 2 次直接拦下**，
 *     不给它跑。理由：读文件重复三次无非浪费钱，**跑脚本重复两次是灾难** ——
 *     脚本的锚点是一次性的，第二次会在已经改过的内容上重新匹配，删掉别处
 *     （见 plugins/patch-guard 头部那段事故复盘）。
 *     同一条命令不超过上限（默认 2 次）就放行，超了才拦，按面板分开算。
 *
 *     ⚠ 拦的是"**同一个指纹连续出现**"；中间插了别的工具调用就重新计数。
 *     所以它拦不住"隔了几步再跑一遍"—— 那一层由 patch-guard 按
 *     "它上次改过的文件现在是什么状态"来判，两者互补，不重叠。
 */

/** 会动手的工具：重复调用有真实代价，不适用"稀疏提醒"那套 */
const MUTATING = new Set(['run_command', 'job_start', 'run_code']);

/** 同一条命令从**第几次**开始拦。2 = 跑过一次之后，第二次就不给跑 */
const BLOCK_FROM = 2;

module.exports = {
  name: 'loop-guard',
  description: t('连续重复调用同一个工具、同一套参数时叫住它：只读的追一句提醒，会动手的直接拦'),

  setup(api) {
    /** panelId -> { key, run } */
    const runs = new Map();

    // 参数可能很大（write_file 的 content），只拿长度 + 开头做指纹，别整份 stringify
    const keyOf = (name, args) => {
      let raw = '';
      try {
        raw = String(JSON.stringify(args ?? {}));
      } catch {
        raw = String(args);
      }
      const finger = raw.length > 400 ? `${raw.length}:${raw.slice(0, 200)}` : raw;
      return `${name}|${finger}`;
    };

    api.onBeforeTool((call) => {
      if (!call || !MUTATING.has(call.name)) return;
      const id = (call.ctx && call.ctx.panelId) || '';
      const key = keyOf(call.name, call.args);
      const prev = runs.get(id);
      const run = prev && prev.key === key ? prev.run + 1 : 1;
      if (runs.size > 64) runs.clear();
      runs.set(id, { key, run });
      if (run < BLOCK_FROM) return;

      return (
        t('**没有执行：这条命令刚刚跑过一次了。**') + '\n' +
        t('再跑一遍不会得到同样的结果 —— 脚本的锚点是一次性的，第二次会在已经被改过的内容上重新匹配，') +
        t('匹配到别处就删掉本不该动的代码。') + '\n' +
        t('先看清现状再决定：read_file / grep 看结果对不对；真要再改就把命令按现状重写。') + '\n' +
        t('（批量改代码用 patch_apply：它幂等，重复应用只会报"已经应用过"然后跳过。）')
      );
    });

    api.onAfterTool((done) => {
      if (!done) return;
      // 会动手的那类已经在 onBeforeTool 里记过数了，这里不重复记
      if (MUTATING.has(done.name)) return;

      const id = (done.ctx && done.ctx.panelId) || '';
      const key = keyOf(done.name, done.args);
      const prev = runs.get(id);
      const run = prev && prev.key === key ? prev.run + 1 : 1;
      // 面板开开关关也不至于一直攒着（真开过那么多面板时，清一次没有损失）
      if (runs.size > 64) runs.clear();
      runs.set(id, { key, run });

      // 第 3 次叫住，之后 5、8 —— 稀疏地提，免得提醒自己变成噪音
      if (run !== 3 && run !== 5 && run !== 8) return;

      return (
        `${done.result}\n\n` +
        t(`（提醒：这是**连续第 ${run} 次**用一模一样的参数调用 ${done.name}，结果不会变。`) +
        t('换参数、换条路，或者把已经确定的事直接说出来。）')
      );
    });
  },
};
