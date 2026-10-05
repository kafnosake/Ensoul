module.exports = {
  name: 'tasks',
  description: t('查询真实任务状态与回执，取消任务及其子任务'),
  setup(api) {
    api.addTool({
      name: 'task_status', level: 'read', kits: ['dev', 'exec'],
      description: t('按 taskId 查询任务真实状态与结果；不填则列出当前面板相关的最近任务。completed 只表示会话结束，acceptance 才表示用户确认验收。不要循环轮询。'),
      parameters: { type: 'object', properties: { taskId: { type: 'string' } } },
    }, (args, ctx) => JSON.stringify(args.taskId
      ? api.tasks.get(args.taskId, ctx?.panelId) || { ok: false, error: '任务不存在或不可见' }
      : api.tasks.list(ctx?.panelId)));
    api.addTool({
      name: 'task_cancel', level: 'write', kits: ['dev', 'exec'],
      description: t('取消 taskId 对应任务及其子任务；已结束的任务不重写结果，但仍可取消未结束的子任务。'),
      parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
    }, (args, ctx) => JSON.stringify(ctx?.panelId ? api.tasks.cancel(String(args.taskId || ''), ctx.panelId) : { ok: false, error: '缺少当前面板' }));
    api.addCommand({ id: 'tasks', label: t('任务状态'), hint: t('查询最近任务或指定 taskId') }, (text, ctx) =>
      JSON.stringify(text.trim() ? api.tasks.get(text.trim(), ctx.panelId) || { error: '任务不可见' } : api.tasks.list(ctx.panelId), null, 2));
  },
};
