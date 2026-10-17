import type { ChatMessage } from './types';

export type ChatHistoryMessage = ChatMessage & { responseOf?: string };

/**
 * 助手一段回复的**规范正文** —— 实发和回放必须用同一份。
 *
 * 刮掉两样东西：模型手写的 `[那一轮的动作]`（留着就是给它继续模仿的样板），
 * 以及行尾多余的空行。
 *
 * 为什么它必须同时出现在"发请求"和"回放历史"两条路上：回放的那条消息和当时
 * 实发的那条差一个字节，服务商的前缀缓存就从那里断开，之后整段全价重算。
 * 从前只有回放这条路做刮除，实发用的是模型原样吐出来的字 —— 两边永远不一样。
 */
export function normalizeAnswerText(text: string): string {
  return String(text ?? '')
    .replace(/\n*\[那一轮的动作\][^\n]*(?:\n[-•][^\n]*)*/g, '')
    .replace(/\n+$/, '');
}

/** 按原消息锚点还原每次模型回复，供界面和模型历史共用。 */
export function expandChatResponses(messages: ChatMessage[]): ChatHistoryMessage[] {
  const anchors = new Set(messages.map((message) => message.id));
  const after = new Map<string, ChatHistoryMessage[]>();
  const fallback = new Map<ChatMessage, ChatHistoryMessage[]>();

  for (const message of messages) {
    if (message.role !== 'assistant' || !message.responses?.length) continue;
    for (const response of message.responses) {
      if (!response.content && !response.toolCalls?.length) continue;
      const expanded: ChatHistoryMessage = {
        id: response.id,
        responseOf: message.id,
        role: 'assistant',
        content: response.content,
        createdAt: response.createdAt ?? message.createdAt,
        toolCalls: response.toolCalls,
      };
      if (anchors.has(response.afterMessageId)) {
        const pending = after.get(response.afterMessageId) ?? [];
        pending.push(expanded);
        after.set(response.afterMessageId, pending);
      } else {
        const pending = fallback.get(message) ?? [];
        pending.push(expanded);
        fallback.set(message, pending);
      }
    }
  }

  const expanded: ChatHistoryMessage[] = [];
  for (const message of messages) {
    expanded.push(...(fallback.get(message) ?? []));
    if (message.role !== 'assistant' || !message.responses?.length) expanded.push(message);
    expanded.push(...(after.get(message.id) ?? []));
  }
  return expanded;
}
