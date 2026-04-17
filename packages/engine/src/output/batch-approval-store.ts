/**
 * Per-session store of unresolved permission requests that have been
 * deferred via batch-approval mode. Each entry holds the Promise resolver
 * for a pending canUseTool() call — when the user fires /agent batch
 * action=approve-all (or reject-all), we drain the queue and resolve each
 * promise so the corresponding SDK turn resumes.
 *
 * Works for both Claude and Codex providers since it sits on the
 * canUseTool contract shared by both.
 */

export type BatchAction = 'approve' | 'reject';

export interface BatchApprovalEntry {
  gateId: string;
  toolUseID: string;
  toolName: string;
  detail: string;
  timestamp: number;
  resolve: (action: BatchAction) => void;
}

const store = new Map<string, BatchApprovalEntry[]>();

export function enqueueBatchApproval(sessionId: string, entry: BatchApprovalEntry): void {
  if (!store.has(sessionId)) store.set(sessionId, []);
  store.get(sessionId)!.push(entry);
}

export function drainBatchApprovals(sessionId: string, action: BatchAction): number {
  const queue = store.get(sessionId);
  if (!queue || queue.length === 0) return 0;
  const count = queue.length;
  for (const entry of queue) {
    try {
      entry.resolve(action);
    } catch (err) {
      console.warn(
        `[batch-approval-store] failed to resolve ${entry.gateId}: ${(err as Error).message}`,
      );
    }
  }
  store.delete(sessionId);
  return count;
}

export function getBatchApprovalQueue(sessionId: string): BatchApprovalEntry[] {
  return store.get(sessionId) ?? [];
}

export function getBatchApprovalCount(sessionId: string): number {
  return store.get(sessionId)?.length ?? 0;
}

export function clearBatchApprovalStore(sessionId: string): void {
  // Resolve with reject so hanging SDK turns can exit cleanly.
  drainBatchApprovals(sessionId, 'reject');
}
