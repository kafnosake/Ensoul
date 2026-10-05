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
 * 挂的是 onAfterTool 而不是 onBeforeTool：重复调用该给的是**结果 + 一句提醒**，
 * 不是把结果换成提醒 —— 万一模型就是需要再看一眼那份内容呢。
 */

module.exports = {
  name: 'loop-guard',
  description: t('连续重复调用同一个工具、同一套参数时，在结果后追一句提醒，破死循环'),

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

    api.onAfterTool((done) => {
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
        `（提醒：这是**连续第 ${run} 次**用一模一样的参数调用 ${done.name}，结果不会变。` +
        `换参数、换条路，或者把已经确定的事直接说出来。）`
      );
    });
  },
};
