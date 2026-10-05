/**
 * star-chart —— AI 协同工作星图监控
 *
 * 监控软件内正在工作的 AI 智能体，根据工作链路、流转任务和活跃状态绘制动态星图拓扑。
 */

module.exports = {
  name: 'star-chart',
  description: t('AI 协同工作星图监控：动态绘制智能体星系、链路星轨与实时任务流动'),
  panel: {
    kind: 'star-chart',
    label: t('AI星图'),
    title: t('AI工作星图'),
    hint: t('AI 协同态势星图：实时监控各部门与智能体星体、星轨连线与流光粒子'),
  },
  setup(api) {
    api.log(t('[star-chart] 插件已加载'));
  },
};
