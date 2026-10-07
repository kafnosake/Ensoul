import type { ChatDeltaEvent, ChatMessage, ChatProgressEvent, ChatResponse, ChatRetractEvent, ChatRunningState } from '../../../shared/types';

export function buildChatTimeline(messages: readonly ChatMessage[], liveResponses: readonly ChatResponse[]): ChatMessage[] {
  const progress = new Map<string, { response: ChatResponse; owner?: ChatMessage }>();
  for (const message of messages) {
    for (const response of message.responses ?? []) {
      if (response.phase === 'progress' && response.content.trim()) progress.set(response.id, { response, owner: message });
    }
  }
  for (const response of liveResponses) {
    if (response.phase === 'progress' && response.content.trim() && !progress.has(response.id)) {
      progress.set(response.id, { response });
    }
  }
  const anchors = new Map(messages.map((message) => [message.id, message]));
  const after = new Map<string, ChatMessage[]>();
  const before = new Map<string, ChatMessage[]>();
  const trailing: ChatMessage[] = [];
  for (const { response, owner } of progress.values()) {
    const anchor = anchors.get(response.afterMessageId);
    const entry: ChatMessage = {
      id: 'response:' + response.id,
      role: 'assistant',
      content: response.content,
      createdAt: response.createdAt ?? owner?.createdAt ?? anchor?.createdAt ?? 0,
    };
    if (anchor) {
      const bucket = after.get(anchor.id) ?? [];
      bucket.push(entry);
      after.set(anchor.id, bucket);
    } else if (owner) {
      const bucket = before.get(owner.id) ?? [];
      bucket.push(entry);
      before.set(owner.id, bucket);
    } else {
      trailing.push(entry);
    }
  }
  const timeline: ChatMessage[] = [];
  for (const message of messages) {
    timeline.push(...(before.get(message.id) ?? []), message, ...(after.get(message.id) ?? []));
  }
  return [...timeline, ...trailing];
}

export function appendStreamDelta(text: string, delta: string, offset?: number): string {
  const overlap = offset == null ? 0 : Math.max(0, text.length - offset);
  return text + delta.slice(overlap);
}

export type ChatStreamEvent =
  | { kind: 'delta'; value: ChatDeltaEvent }
  | { kind: 'progress'; value: ChatProgressEvent }
  | { kind: 'retract'; value: ChatRetractEvent };

export interface ChatStreamView {
  id: string | null;
  responseId: string | null;
  sequence: number;
  text: string;
  responses: ChatResponse[];
}

export function emptyChatStream(): ChatStreamView {
  return { id: null, responseId: null, sequence: 0, text: '', responses: [] };
}

export function applyChatStreamEvent(state: ChatStreamView, event: ChatStreamEvent, completedId: string | null): ChatStreamView {
  const p = event.value;
  if (p.id === completedId) return state;
  const sameAssistant = state.id === p.id;
  const sequence = p.sequence ?? (sameAssistant ? state.sequence + 1 : 1);
  if (sameAssistant && p.sequence != null && sequence <= state.sequence) return state;
  if (state.id && !sameAssistant && event.kind !== 'progress') return state;
  if (event.kind === 'progress') {
    return {
      id: p.id,
      responseId: event.value.responseId ?? null,
      sequence,
      text: event.value.reset || !sameAssistant ? '' : state.text,
      responses: event.value.responses,
    };
  }
  const next = { ...state, id: p.id, sequence };
  if (event.kind === 'retract') {
    return { ...next, text: state.text.slice(0, Math.max(0, state.text.length - event.value.text)) };
  }
  const delta = event.value;
  if (delta.responseId) {
    if (state.responses.some((response) => response.id === delta.responseId && response.phase !== 'draft')) return next;
    if (state.responseId && state.responseId !== delta.responseId) return next;
  }
  return {
    ...next,
    responseId: delta.responseId ?? state.responseId,
    text: appendStreamDelta(state.text, delta.delta, delta.offset),
  };
}

export function restoreChatStream(snapshot: ChatRunningState | undefined, events: readonly ChatStreamEvent[], completedId: string | null): ChatStreamView {
  let state: ChatStreamView = snapshot && snapshot.id !== completedId ? {
    id: snapshot.id,
    responseId: snapshot.responseId ?? null,
    sequence: snapshot.sequence ?? 0,
    text: snapshot.streamText ?? snapshot.text,
    responses: snapshot.responses ?? [],
  } : emptyChatStream();
  let start = 0;
  if (snapshot) {
    events.forEach((event, index) => {
      if (event.value.id === snapshot.id && event.value.sequence != null && event.value.sequence <= (snapshot.sequence ?? 0)) start = index + 1;
    });
  }
  for (const event of events.slice(start)) {
    if (snapshot && event.value.id === snapshot.id && event.value.sequence != null && event.value.sequence <= (snapshot.sequence ?? 0)) continue;
    state = applyChatStreamEvent(state, event, completedId);
  }
  return state;
}
