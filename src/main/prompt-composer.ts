import type { Panel } from '../shared/types';
import { t } from '../shared/i18n';

/**
 * 提示词层级切片定义：
 * 按从通用到具体的顺序组装：
 *   1. project: 全局项目规约（如 AGENTS.md、项目全局约束）
 *   2. stage: 阶段/环节规约（如 需求分析期、实现期、审核验收期）
 *   3. role: 岗位职责/角色人设（如 架构师、前端专家、角色卡）
 *   4. panel: 面板专属额外指令（面板自身的特有规约）
 */
export interface PromptLayers {
  project?: string;
  stage?: { id?: string; name?: string; content: string };
  role?: { name?: string; intro?: string; duty?: string };
  panel?: string;
}

/**
 * 提示词合并器（Prompt Composer）：
 * 把全局层、环节层、角色层、面板层纯净有序地合成为终态系统提示词。
 */
export function composePromptLayers(layers: PromptLayers): string {
  const parts: string[] = [];

  if (layers.project && layers.project.trim()) {
    parts.push(`【全局项目规约】\n${layers.project.trim()}`);
  }

  if (layers.stage && layers.stage.content && layers.stage.content.trim()) {
    const stageHeader = layers.stage.name ? `【当前工作环节：${layers.stage.name}】` : t('【当前工作环节规约】');
    parts.push(`${stageHeader}\n${layers.stage.content.trim()}`);
  }

  if (layers.role) {
    const roleBits: string[] = [];
    if (layers.role.name) roleBits.push(`【姓名/角色】${layers.role.name}`);
    if (layers.role.intro) roleBits.push(`【简介与擅长】\n${layers.role.intro.trim()}`);
    if (layers.role.duty) roleBits.push(`【岗位职责与要求】\n${layers.role.duty.trim()}`);
    if (roleBits.length) {
      parts.push(roleBits.join('\n\n'));
    }
  }

  if (layers.panel && layers.panel.trim()) {
    parts.push(`【本面板的额外要求】\n${layers.panel.trim()}`);
  }

  return parts.join('\n\n---\n\n').trim();
}

/**
 * 将提示词变动记录为增量（Delta）或直接更新：
 * 1. 如果面板从未有基准（新面板或空白），直接作为 activeBase 生效；
 * 2. 如果面板处于热会话中（已有 activeBase），绝不当场破坏 systemPrompt 前缀缓存，
 *    而是存入 pendingDeltas，在下一轮作为增量通知单次送给模型；
 * 3. pendingDeltas 将在随后的热压缩、冷压缩或手动压缩（以及 /clear）时被收拢编译进新基底。
 */
export function recordPromptDelta(
  panel: Panel,
  newComposed: string,
  title?: string,
): { changed: boolean; isDelta: boolean } {
  const currentBase = panel.promptState?.activeBase ?? (panel.spec?.systemPrompt || '');

  // 内容完全没变，直接返回
  if (currentBase.trim() === newComposed.trim()) {
    return { changed: false, isDelta: false };
  }

  if (!panel.promptState) {
    panel.promptState = {
      activeBase: currentBase,
      pendingDeltas: [],
    };
  }

  // 如果会话尚未开始（无历史消息）或者从未设置过基底，直接原地更新基底
  const chatCount = (panel.chat || []).filter((m) => m.role !== 'tool').length;
  if (chatCount === 0 || !currentBase.trim()) {
    panel.promptState.activeBase = newComposed;
    panel.promptState.pendingDeltas = [];
    panel.spec = { ...(panel.spec || {}), systemPrompt: newComposed } as any;
    return { changed: true, isDelta: false };
  }

  // 处于活跃会话中：记录 Delta 增量，不破坏 systemPrompt
  const deltaId = `delta_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const deltas = panel.promptState.pendingDeltas || [];
  deltas.push({
    id: deltaId,
    title: title || t('提示词规则更新'),
    text: newComposed,
    createdAt: Date.now(),
    appliedOnce: false,
  });
  panel.promptState.pendingDeltas = deltas;

  return { changed: true, isDelta: true };
}

/**
 * 消费待消费的增量变更说明（单次注入）：
 * 只在模型回答前的用户轮次中带上一次，带完即标记 appliedOnce。
 */
export function consumePromptDeltas(panel: Panel): string {
  if (!panel.promptState?.pendingDeltas || !panel.promptState.pendingDeltas.length) {
    return '';
  }

  const unapplied = panel.promptState.pendingDeltas.filter((d) => !d.appliedOnce);
  if (!unapplied.length) return '';

  const texts: string[] = [];
  for (const delta of unapplied) {
    delta.appliedOnce = true;
    const title = delta.title ? `【提示词与规则变动通知：${delta.title}】` : t('【提示词与规则变动通知】');
    texts.push(`${title}\n请注意：从本轮开始，最新规则与规约已更新如下，后续指令请遵照执行：\n\n${delta.text}`);
  }

  return texts.join('\n\n');
}

/**
 * 编译/重置基底（Full Baseline Commit）：
 * 在压缩（热压缩、冷压缩、手动压缩 /compress）或清理（/clear）时调用。
 * 此时前缀缓存反正要重整或清空，将最新的最新合并提示词全量固化写入 systemPrompt，
 * 并清空所有历史 Delta 补丁。
 */
export function commitPromptBaseline(panel: Panel, latestComposed?: string): void {
  // 如果给定了最新合成结果则用最新的，否则优先取最后一条 Delta 或当前的 activeBase
  let target = latestComposed;
  if (target === undefined) {
    const deltas = panel.promptState?.pendingDeltas || [];
    if (deltas.length > 0) {
      target = deltas[deltas.length - 1].text;
    } else {
      target = panel.promptState?.activeBase || panel.spec?.systemPrompt || '';
    }
  }

  panel.promptState = {
    activeBase: target,
    pendingDeltas: [],
  };

  panel.spec = {
    ...(panel.spec || {}),
    systemPrompt: target,
  } as any;
}
