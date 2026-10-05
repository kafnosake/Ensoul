export type JsonSnapshot =
  | { status: 'ready'; data: unknown }
  | { status: 'missing' }
  | { status: 'too_large'; bytes: number; limit: number }
  | { status: 'invalid'; error: string }
  | { status: 'error'; error: string };

export function snapshotFailed(snapshot: JsonSnapshot): boolean {
  return snapshot.status !== 'ready' && snapshot.status !== 'missing';
}

export function validateSnapshot(snapshot: JsonSnapshot, valid: (data: unknown) => boolean, error: string): JsonSnapshot {
  return snapshot.status === 'ready' && !valid(snapshot.data) ? { status: 'invalid', error } : snapshot;
}
