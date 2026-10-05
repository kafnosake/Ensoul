export interface RunningEntry {
  runId: string;
  ctrl: AbortController;
}

export class RunRegistry<T extends RunningEntry> extends Map<string, T> {
  claim(panelId: string, entry: T): boolean {
    if (this.has(panelId)) return false;
    this.set(panelId, entry);
    return true;
  }

  release(panelId: string, runId: string): boolean {
    if (this.get(panelId)?.runId !== runId) return false;
    return this.delete(panelId);
  }

  cancel(panelId: string): boolean {
    const entry = this.get(panelId);
    if (!entry) return false;
    entry.ctrl.abort(new Error('这一轮已停止'));
    return true;
  }
}
