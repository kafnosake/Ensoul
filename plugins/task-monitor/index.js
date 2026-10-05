/**
 * task-monitor —— 全局任务与员工可视化态势大盘
 *
 * 聚合所有已编制员工与当前活跃面板，实时监视工作态势、
 * 运行中流光转圈、待确认请求、交付物状态，支持悬停摘要、单击会话与双击跳转。
 */

module.exports = {
  name: 'task-monitor',
  description: t('任务与员工可视化态势大盘：头像流光监控、悬停简报、轻量会话与双击跳转'),
  panel: {
    kind: 'task-monitor',
    label: t('任务监视器'),
    title: t('任务监视器'),
    hint: t('全员态势监视大盘：贴边悬浮抽屉、工作流光转圈、悬停简报与快速会话'),
    floatBare: true,
  },
  setup(api) {
    api.log(t('[task-monitor] 插件已加载'));
  },
};
