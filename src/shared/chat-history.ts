import type { ChatMessage } from './types';

export type ChatHistoryMessage = ChatMessage & { responseOf?: string };

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
