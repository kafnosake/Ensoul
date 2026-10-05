import type { Panel, PanelStatus } from '../../shared/types';
import { t } from '../core/i18n';

/**
 * 名字边上那颗点点：把面板的**工作情况**画成颜色。
 *
 *   没工作过的 → 灰      正在跑这一轮 → 蓝（固定状态色 --busy，会呼吸）
 *   干完了     → 绿      失败 / 被停止 → 红      干完了但在等回话 → 黄
 *
 * 状态本身是主进程在对话的几个节点上写进 `panel.status` 的（见 shared/types.ts
 * 里那段注释）—— 渲染层只负责照着画，不自己推断"它跑没跑完"。
 */
const COLORS: Record<PanelStatus, string> = {
  idle: 'var(--faint)',
  working: 'var(--busy)', // 进行中 —— 固定状态色，不跟用户选的强调色走
  done: 'var(--ok)',
  error: 'var(--danger)',
  confirm: 'var(--warn)',
};

const LABELS: Record<PanelStatus, string> = {
  idle: t('没有工作'),
  working: t('正在工作'),
  done: t('完成'),
  error: t('失败 / 已中断'),
  confirm: t('等你确认'),
};

export function statusOf(panel: Panel): PanelStatus {
  return panel.status ?? 'idle';
}

export function statusColor(panel: Panel): string {
  return COLORS[statusOf(panel)];
}

export function statusLabel(panel: Panel): string {
  return LABELS[statusOf(panel)];
}

/** 点点上挂的类名 —— "正在工作"要呼吸，其余静止 */
export function statusClass(panel: Panel): string {
  return `st-${statusOf(panel)}`;
}
