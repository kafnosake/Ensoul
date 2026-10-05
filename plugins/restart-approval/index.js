/**
 * 重启之前先问用户。
 *
 * agent 一旦真的跑起 restart_project，这个进程会当场收掉自己 —— 而它调用的那一刻这一轮
 * 还没跑完：回复还在内存里、没进 store。所以这里把那次调用**拦下来**（onBeforeTool），
 * 换成一条请求摆到界面上；用户按下「确认重启」之后，核心才替它跑那一次工具调用
 * （见 src/main/index.ts 的 chat:askConfirm —— 那条路上不再过本钩子，否则就是死循环）。
 *
 * 策略全在这儿：什么时候问、问什么、按钮写什么。画那条请求、点头之后跑工具是核心的事，
 * 核心并不认识"重启"这两个字（见 src/main/plugins.ts 的 AskSpec）。
 */

module.exports = {
  name: 'restart-approval',
  description: t('agent 想重启应用时先摆一条请求，等用户点头才真的重启'),

  setup(api) {
    api.onBeforeTool((call) => {
      if (call.name !== 'restart_project') return;
      const panelId = call.ctx && call.ctx.panelId;
      // 没工作区的时候没有"这个项目"可重启：放行，让核心去回那句人话
      if (!panelId || !api.workspace) return;

      const cmd = call.args && call.args.command ? String(call.args.command) : '';
      api.ask({
        panelId,
        text:
          t('它想重启应用让改动生效') +
          (cmd ? `（启动命令：${cmd}）` : '') +
          t(' —— 会先构建，窗口消失一下再回来，对话还在。'),
        confirm: t('确认重启'),
        cancel: t('先不重启'),
        // 第三条路：现在不方便打断（别的会话还在跑），等整个软件都闲下来再自己重启
        defer: { label: t('等全部会话结束') },
        then: { tool: 'restart_project', args: call.args },
      });

      return [
        t('重启**没有执行** —— 请求已经摆到界面上，用户有三个选择：'),
        t('「确认重启」立刻做；「等全部会话结束」让核心盯着，所有会话都跑完自动重启；「先不重启」作废。'),
        t('现在把话说完：改了哪些文件、为什么必须重启才生效，然后停下等用户点。'),
        t('不要再调 restart_project：重复调用只是再挂一条同样的请求。'),
      ].join('\n');
    });
  },
};
