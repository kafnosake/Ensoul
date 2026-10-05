import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';

export interface FileWriteEvent {
  toolCallId: string;
  toolName: string;
  panelId: string;
  path: string;
  before: string | null;
  beforeHash: string;
  afterHash: string;
}
export type FileWriteHook = (event: FileWriteEvent) => void;
type Call = { id: string; name: string; panelId: string; hooks: FileWriteHook[] };
type Lease = { callId: string; panelId: string; expected: string };

export class FileConflict extends Error {
  readonly code = 'FILE_CONFLICT';
  constructor(readonly file: string, message: string) { super(message); }
  result() { return JSON.stringify({ ok: false, code: this.code, path: this.file, error: this.message, next: '重新读取文件，按当前版本修改；不要盲目重试覆盖。' }); }
}

export class FileWriteCoordinator {
  private calls = new AsyncLocalStorage<Call>();
  private leases = new Map<string, Lease>();
  private observations = new Map<string, Map<string, string>>();

  private key(file: string): string {
    let parent = path.resolve(file), suffix: string[] = [];
    while (!fs.existsSync(parent)) {
      const next = path.dirname(parent);
      if (next === parent) break;
      suffix.unshift(path.basename(parent)); parent = next;
    }
    const resolved = path.join(fs.realpathSync(parent), ...suffix);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  hash(data: Buffer | null): string { return data === null ? 'missing' : createHash('sha256').update(data).digest('hex'); }
  private read(file: string): Buffer | null {
    try { return fs.readFileSync(file); }
    catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
  }
  revision(file: string): string { return this.hash(this.read(this.key(file))); }
  observe(file: string, data: Buffer, panelId: string): void {
    if (!panelId) return;
    const reads = this.observations.get(panelId) || new Map<string, string>();
    const key = this.key(file);
    reads.delete(key); reads.set(key, this.hash(data));
    if (reads.size > 512) reads.delete(reads.keys().next().value!);
    this.observations.set(panelId, reads);
  }
  withCall<T>(call: Call, fn: () => T): T { return this.calls.run(call, fn); }
  acquire(file: string): void {
    const call = this.calls.getStore();
    if (!call) throw new Error('写入缺少工具调用身份');
    const key = this.key(file), lease = this.leases.get(key);
    if (lease && lease.callId !== call.id) throw new FileConflict(file, `文件正由面板 ${lease.panelId || '其他调用'} 修改或验证`);
    const current = this.hash(this.read(key));
    const observed = this.observations.get(call.panelId)?.get(key);
    if (observed !== undefined && observed !== current) throw new FileConflict(file, '文件自上次读取后已经变化，本次没有写入');
    this.leases.set(key, { callId: call.id, panelId: call.panelId, expected: current });
  }
  release(callId: string): void {
    for (const [key, lease] of this.leases) if (lease.callId === callId) this.leases.delete(key);
  }
  private check(key: string, current: string): Lease | undefined {
    const lease = this.leases.get(key), call = this.calls.getStore();
    if (lease && lease.callId !== call?.id) throw new FileConflict(key, '文件仍在其他调用的修改或验证中');
    if (lease && lease.expected !== current) throw new FileConflict(key, '文件在本次执行期间被其他来源改动');
    return lease;
  }
  private put(key: string, data: Buffer | null, expected: string): void {
    if (data === null) {
      if (this.hash(this.read(key)) !== expected) throw new FileConflict(key, '删除前版本已变化');
      if (expected !== 'missing') fs.unlinkSync(key);
      return;
    }
    fs.mkdirSync(path.dirname(key), { recursive: true });
    const tmp = `${key}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, data);
      if (fs.existsSync(key)) fs.chmodSync(tmp, fs.statSync(key).mode);
      if (this.hash(this.read(key)) !== expected) throw new FileConflict(key, '提交前版本已变化');
      fs.renameSync(tmp, key);
    } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  }
  write(file: string, data: Buffer, text: boolean): void {
    const key = this.key(file), before = this.read(key), beforeHash = this.hash(before);
    const call = this.calls.getStore();
    if (call && !this.leases.has(key)) this.acquire(key);
    const lease = this.check(key, beforeHash);
    const afterHash = this.hash(data);
    if (text && call && afterHash !== beforeHash) {
      const event: FileWriteEvent = { toolCallId: call.id, toolName: call.name, panelId: call.panelId,
        path: key, before: before?.toString('utf8') ?? null, beforeHash, afterHash };
      for (const hook of call.hooks) hook(event);
    }
    this.put(key, data, beforeHash);
    if (lease) lease.expected = afterHash;
    if (call?.panelId) this.observe(key, data, call.panelId);
  }
  restore(file: string, before: string | null, expected: string): void {
    const key = this.key(file), current = this.hash(this.read(key));
    const lease = this.check(key, current);
    if (current !== expected) throw new FileConflict(file, '回滚目标已被后续修改，保留当前文件');
    const data = before === null ? null : Buffer.from(before, 'utf8');
    this.put(key, data, expected);
    if (lease) lease.expected = this.hash(data);
    const call = this.calls.getStore();
    if (call?.panelId) {
      const reads = this.observations.get(call.panelId);
      reads?.set(key, this.hash(data));
    }
  }
}
export const fileWrites = new FileWriteCoordinator();
