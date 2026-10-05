const { createHash } = require('crypto');

module.exports = {
  name: 'subagent',
  description: t('用独立会话执行分身任务，持久记录真实状态与结果'),
  setup(api) {
    api.addTool({
      name: 'subagent_run', kits: ['dev', 'exec'],
      description: t('为一项具体任务创建独立面板并入队，立即返回 taskId。继承当前模型与工具清单，共用工作区；用 task_status 查询结果，不循环轮询。停止父任务或取消任务会取消子任务。'),
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: t('任务短标题') },
          task: { type: 'string', description: t('完整任务、范围、限制与验收标准') },
          requestId: { type: 'string', description: t('重试沿用的请求编号；不同任务用新编号，默认按本轮和正文识别重复') },
        }, required: ['title', 'task'],
      },
    }, (args, ctx) => {
      if (!api.workspace || !ctx?.panelId || !String(args.task || '').trim()) return JSON.stringify({ ok: false, error: '缺少工作区、面板或任务' });
      ctx.signal?.throwIfAborted();
      const task = String(args.task), title = String(args.title || '分身任务');
      const requestId = String(args.requestId || '') || (ctx.taskId || ctx.runId || ctx.panelId) + ':'
        + createHash('sha256').update(JSON.stringify([title, task])).digest('hex');
      const previous = api.tasks.request(requestId, ctx.panelId);
      if (previous) {
        if (previous.text !== task || previous.title !== title) return JSON.stringify({ ok: false, error: '请求编号已用于另一份任务' });
        const reused = api.tasks.submit({ panelId: previous.panelId, text: task, title, requestId }, ctx);
        return JSON.stringify({ ok: reused.ok, error: reused.error, taskId: previous.id, panelId: previous.panelId, status: reused.task?.status, reused: true });
      }
      const child = api.createPanel({ kind: 'chat', title, hidden: true, origin: ctx.panelId });
      const tools = api.tools(ctx.panelId).map((tool) => tool.name).filter((name) => name !== 'subagent_run' && name !== 'dispatch');
      api.patchPanel(child.id, { tools });
      const pick = api.modelPick(ctx.panelId);
      if (pick) api.setModel(child.id, pick);
      const result = api.tasks.submit({ panelId: child.id, text: task, title, requestId }, ctx);
      if (!result.ok && !result.task) api.closePanel(child.id);
      return JSON.stringify({ ok: result.ok, taskId: result.task?.id, panelId: child.id,
        status: result.task?.status, reused: result.reused, error: result.error,
        message: '已登记任务，通过 task_status 查看执行结果与验收状态' });
    });
  },
};
