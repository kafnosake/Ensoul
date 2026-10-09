import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { TaskApi, TaskContext, TaskRecord, TaskRequest } from '../shared/types';
import { projectDataPath, registerProjectStorage } from './storage';

registerProjectStorage('tasks', ['.ensoul/state/tasks.json']);

interface TaskQueue {
  enqueue(task: TaskRecord): void;
  remove(ids: string[]): void;
  changed(): void;
}
type Journal = { root: string; records: TaskRecord[] };
type RunResult = { ok: boolean; content?: string; error?: string; tokens?: number };
const activeStatus = (task: TaskRecord) => ['queued', 'running', 'cancelling'].includes(task.status);

export class TaskService implements TaskApi {
  private journals = new Map<string, Journal>();
  private active = new Map<string, { journal: Journal; ctrl: AbortController; runId: string }>();

  constructor(private root: () => string, private queue: TaskQueue) {}

  private journal(): Journal {
    const root = this.root();
    if (!root) throw new Error('还没选工作区');
    const key = path.resolve(root);
    const known = this.journals.get(key);
    if (known) return known;
    const file = projectDataPath('.ensoul/state/tasks.json', key);
    const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, tasks: [] };
    if (data.version !== 1 || !Array.isArray(data.tasks)) throw new Error('任务记录格式不支持，请检查 tasks.json');
    const journal = { root: key, records: data.tasks as TaskRecord[] };
    this.journals.set(key, journal);
    return journal;
  }

  private commit(journal: Journal, records: TaskRecord[]): void {
    const file = projectDataPath('.ensoul/state/tasks.json', journal.root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, tasks: records }, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
    journal.records = records;
    this.queue.changed();
  }

  private visible(journal: Journal, task: TaskRecord, panelId?: string): boolean {
    if (!panelId) return true;
    let current: TaskRecord | undefined = task;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      if (current.originPanelId === panelId || current.panelId === panelId) return true;
      visited.add(current.id);
      current = journal.records.find((record) => record.id === current!.parentTaskId);
    }
    return false;
  }

  submit(request: TaskRequest, context: TaskContext) {
    if (!request.requestId?.trim() || !request.panelId || !request.text?.trim() || !context.panelId) {
      return { ok: false, error: '任务需要目标面板、正文、发起面板和稳定 requestId' };
    }
    if (request.panelId === context.panelId) return { ok: false, error: '不能向自己派单' };
    const journal = this.journal();
    const existing = journal.records.find((task) => task.originPanelId === context.panelId && task.requestId === request.requestId);
    if (existing) {
      if (existing.panelId !== request.panelId || existing.text !== request.text || existing.correlationId !== request.correlationId) {
        return { ok: false, error: 'requestId 已用于另一份任务，请查询原任务' };
      }
      if (existing.status === 'queued') this.enqueue(journal, existing);
      const saved = this.get(existing.id)!;
      return { ok: saved.status !== 'failed', task: saved, reused: true, error: saved.error };
    }
    if (context.taskId) {
      const parent = journal.records.find((task) => task.id === context.taskId);
      if (!parent || parent.panelId !== context.panelId || parent.status !== 'running' || parent.runId !== context.runId) return { ok: false, error: '父任务已停止或不可用' };
    }
    const now = Date.now();
    const task: TaskRecord = { ...request, id: 'task-' + randomUUID(), workspace: journal.root,
      originPanelId: context.panelId, parentTaskId: context.taskId, parentRunId: context.runId,
      status: 'queued', createdAt: now, updatedAt: now };
    this.commit(journal, [...journal.records, task]);
    this.enqueue(journal, task);
    const saved = this.get(task.id)!;
    return { ok: saved.status !== 'failed', task: saved, reused: false, error: saved.error };
  }

  private enqueue(journal: Journal, task: TaskRecord): void {
    try { this.queue.enqueue(task); }
    catch (error) {
      this.commit(journal, journal.records.map((record) => record.id === task.id
        ? { ...record, status: 'failed', error: String(error instanceof Error ? error.message : error), updatedAt: Date.now() } : record));
    }
  }

  get(id: string, panelId?: string): TaskRecord | undefined {
    const journal = this.journal();
    const task = journal.records.find((task) => task.id === id);
    return task && this.visible(journal, task, panelId) ? structuredClone(task) : undefined;
  }

  request(requestId: string, panelId: string): TaskRecord | undefined {
    const task = this.journal().records.find((record) => record.originPanelId === panelId && record.requestId === requestId);
    return task ? structuredClone(task) : undefined;
  }

  list(panelId?: string): TaskRecord[] {
    const journal = this.journal();
    return structuredClone(journal.records.filter((task) => this.visible(journal, task, panelId)).slice(-100).reverse());
  }

  begin(id: string, runId: string, ctrl: AbortController): boolean {
    const journal = this.journal();
    const task = journal.records.find((task) => task.id === id);
    if (!task || task.status !== 'queued' || task.workspace !== path.resolve(this.root())) return false;
    this.commit(journal, journal.records.map((task) => task.id === id ? { ...task, status: 'running', runId, startedAt: Date.now(), updatedAt: Date.now() } : task));
    this.active.set(id, { journal, ctrl, runId });
    this.queue.remove([id]);
    return true;
  }

  finish(id: string, runId: string, result: RunResult): void {
    const active = this.active.get(id);
    if (!active || active.runId !== runId) return;
    const { journal, ctrl } = active;
    const task = journal.records.find((task) => task.id === id);
    const status = ctrl.signal.aborted || task?.status === 'cancelling' ? 'cancelled' : result.ok ? 'completed' : 'failed';
    this.commit(journal, journal.records.map((task) => task.id === id ? { ...task, status,
      result: result.content?.slice(0, 8000), error: result.error?.slice(0, 2000), tokens: result.tokens, endedAt: Date.now(), updatedAt: Date.now() } : task));
    this.active.delete(id);
  }

  private family(journal: Journal, roots: string[]): Set<string> {
    const ids = new Set(roots);
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of journal.records) {
        if (task.parentTaskId && ids.has(task.parentTaskId) && !ids.has(task.id)) { ids.add(task.id); changed = true; }
      }
    }
    return ids;
  }

  private cancelTree(journal: Journal, roots: string[]): void {
    const ids = this.family(journal, roots);
    try {
      if (journal.records.some((task) => ids.has(task.id) && activeStatus(task))) {
        this.commit(journal, journal.records.map((task) => ids.has(task.id) && activeStatus(task)
          ? { ...task, status: this.active.has(task.id) ? 'cancelling' : 'cancelled', updatedAt: Date.now() } : task));
      }
      this.queue.remove([...ids]);
    } finally {
      for (const id of ids) this.active.get(id)?.ctrl.abort(new Error('任务已取消'));
    }
  }

  cancel(id: string, panelId?: string) {
    const journal = this.journal();
    const task = journal.records.find((task) => task.id === id);
    if (!task || !this.visible(journal, task, panelId)) return { ok: false, error: '任务不存在或不属于当前面板' };
    this.cancelTree(journal, [id]);
    return { ok: true };
  }

  cancelCorrelation(id: string, panelId: string) {
    const journal = this.journal();
    const tasks = journal.records.filter((task) => task.correlationId === id);
    if (!tasks.some((task) => this.visible(journal, task, panelId))) return { ok: false, error: '未找到关联任务' };
    this.cancelTree(journal, tasks.map((task) => task.id));
    return { ok: true };
  }

  cancelRun(runId: string): void {
    for (const journal of this.journals.values()) {
      const roots = journal.records.filter((task) => task.parentRunId === runId).map((task) => task.id);
      if (roots.length) this.cancelTree(journal, roots);
    }
  }

  delivered(correlationId: string, panelId: string, files: string[]): void {
    const journal = this.journal();
    const matching = journal.records.filter((task) => task.correlationId === correlationId && task.panelId === panelId);
    if (!matching.length) return;
    if (matching.some((task) => ['cancelled', 'cancelling', 'interrupted', 'failed'].includes(task.status))) throw new Error('任务已停止，不能提交交付');
    const checked = files.map((file) => path.resolve(journal.root, file));
    if (!checked.length || checked.some((file) => !fs.existsSync(file) || !fs.statSync(file).isFile())) throw new Error('交付文件不完整或不存在');
    this.commit(journal, journal.records.map((task) => task.correlationId === correlationId && !task.acceptance
      ? { ...task, delivery: { files, at: Date.now() }, updatedAt: Date.now() } : task));
  }

  accept(id: string, panelId: string, note = '') {
    const journal = this.journal();
    const task = journal.records.find((task) => task.id === id);
    if (!task || !this.visible(journal, task, panelId) || task.originPanelId !== panelId) return { ok: false, error: '只有发起面板可以确认验收' };
    if (task.status !== 'completed') return { ok: false, error: '会话尚未成功结束' };
    const family = this.family(journal, [id]);
    if (journal.records.some((record) => family.has(record.id) && record.status !== 'completed')) return { ok: false, error: '子任务尚未成功结束' };
    if (task.correlationId && !task.delivery) return { ok: false, error: '尚未提交交付文件' };
    this.commit(journal, journal.records.map((task) => task.id === id ? { ...task, acceptance: { at: Date.now(), note }, updatedAt: Date.now() } : task));
    return { ok: true };
  }

  recover(): void {
    const journal = this.journal();
    const stale = journal.records.some((task) => ['running', 'cancelling'].includes(task.status) && !this.active.has(task.id));
    if (stale) this.commit(journal, journal.records.map((task) => !this.active.has(task.id) && ['running', 'cancelling'].includes(task.status)
      ? { ...task, status: task.status === 'cancelling' ? 'cancelled' : 'interrupted', error: '上次执行中断，未自动重做', updatedAt: Date.now() } : task));
    const stopped = journal.records.filter((task) => ['cancelled', 'interrupted', 'failed'].includes(task.status)).map((task) => task.id);
    if (stopped.length) this.cancelTree(journal, stopped);
    this.queue.remove(journal.records.filter((task) => task.status !== 'queued').map((task) => task.id));
    for (const task of journal.records.filter((task) => task.status === 'queued')) this.enqueue(journal, task);
  }
}
