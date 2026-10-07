import type { ChatMessage, ChatResponse } from './types';

/** 累计正文与当前回复段共用写入和撤回，重试只影响当前段。 */
export class ChatResponseBuffer {
  readonly responses: ChatResponse[];
  private prefix = '';

  constructor(private readonly message: ChatMessage) {
    this.responses = message.responses ??= [];
  }

  nextSequence(): number {
    return this.message.streamSequence = (this.message.streamSequence ?? 0) + 1;
  }

  get current(): ChatResponse | undefined {
    return this.responses[this.responses.length - 1];
  }

  start(id: string, afterMessageId: string, createdAt: number): ChatResponse {
    if (this.current) this.current.phase = 'progress';
    this.prefix = this.message.content;
    const response: ChatResponse = { id, afterMessageId, createdAt, phase: 'draft', content: '' };
    this.responses.push(response);
    return response;
  }

  append(delta: string): void {
    if (!this.current) {
      this.message.content += delta;
      return;
    }
    this.current.content += delta;
    this.sync();
  }

  seal(content: string, hasTools: boolean): void {
    if (!this.current) return;
    this.current.content = content;
    this.current.phase = hasTools ? 'progress' : 'answer';
    this.sync();
  }

  retract(length: number): void {
    if (!this.current) return;
    this.current.content = this.current.content.slice(0, Math.max(0, this.current.content.length - length));
    this.sync();
  }

  private sync(): void {
    const content = this.current?.content ?? '';
    this.message.content = this.prefix + (this.prefix && content ? '\n\n' : '') + content;
  }
}
