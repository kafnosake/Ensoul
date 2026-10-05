/**
 * 常驻的斜杠命令（输入框里敲 `/` 就能挑）：
 *
 *   /工具      —— 这个面板这一刻能用哪些工具（名字 + 一句话）
 *   /clear     —— 清空这个面板的会话上下文（消息和前情摘要一起清）
 *
 * /compress（压缩上下文）搬去 plugins/compress 了 —— 那边管着它用哪个模型，命令跟着它走。
 *
 * 它们**在主进程直接跑、不经模型**（见 index.ts 里"斜杠命令"那段），所以返回什么就是什么，
 * 模型只能接着这份真实结果往下写 —— "没跑却说跑过了"在这里没有落脚点。
 *
 * 说话对象是**这一刻的面板**（handler 拿到的 ctx.panelId）：/clear 清的是当前这块，
 * 不会顺手把别的面板的对话也抹掉。
 *
 * 核心才做得到的事走 api.clearChat / api.tools
 * （对话、摘要、工具表都归核心管，插件碰不着）。
 */

/** 说明太长会在对话里糊成一坨，列表里只留开头一段 */
const clip = (s, n = 90) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

module.exports = {
  name: 'slash-kit',
  description: t('两条常用斜杠命令：/工具 看这个面板能用哪些工具，/clear 清空当前会话的上下文'),

  setup(api) {
    api.addCommand(
      { id: '工具', label: t('看工具'), hint: t('/工具 —— 这个面板这一刻能用哪些工具') },
      (argText, ctx) => {
        const list = api.tools((ctx && ctx.panelId) || '');
        if (!list.length) return '这一刻一个工具都用不了：面板不在，或者插件还没装完。';
        const wanted = String(argText || '').trim().toLowerCase();
        const shown = wanted ? list.filter((t) => t.name.toLowerCase().includes(wanted)) : list;
        if (!shown.length) {
          return `没有名字里带「${wanted}」的工具。这一刻能用的是：${list.map((t) => t.name).join('、')}`;
        }
        return [
          `这个面板这一刻能用 ${shown.length} 个工具${wanted ? `（筛的是「${wanted}」）` : ''}：`,
          ...shown.map((t) => `- ${t.name}：${clip(t.description)}`),
        ].join('\n');
      },
    );

    api.addCommand(
      { id: 'clear', label: t('清空上下文'), hint: t('/clear —— 清空当前会话的上下文，从头开始') },
      (_argText, ctx) => {
        const id = (ctx && ctx.panelId) || '';
        if (!id) return '命令没有执行：不知道是哪块面板。';
        if (!api.clearChat(id)) return `命令没有执行：找不到面板 ${id}。`;
        return '这块面板的会话上下文已清空（对话记录和前情摘要一起清了），下一轮从空白开始。';
      },
    );

    // /compress 搬去 plugins/compress 了 —— 那边才是"压缩"这件事的家（连它用哪个模型
    // 一起管）。两条命令都留在这儿的话，同一个 id 会撞上，先注册的赢，谁也说不清是谁的。
  },
};
