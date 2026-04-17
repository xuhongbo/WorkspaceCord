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

/**
 * Upper bound kept in lock-step with `MAX_PENDING_APPROVALS` in
 * `xstate-session-machine.ts`. The state-machine queue is what users see on
 * the status card; if this store grew beyond that cap, `approve-all` would
 * fire approvals for tool calls the user never saw — a silent safety
 * regression. When the store is full, new requests are auto-rejected so the
 * SDK turn continues instead of blocking forever.
 */
export const MAX_BATCH_APPROVAL_STORE_SIZE = 100;

const store = new Map<string, BatchApprovalEntry[]>();

export type EnqueueResult = 'enqueued' | 'overflow';

export function enqueueBatchApproval(sessionId: string, entry: BatchApprovalEntry): EnqueueResult {
  if (!store.has(sessionId)) store.set(sessionId, []);
  const queue = store.get(sessionId)!;
  if (queue.length >= MAX_BATCH_APPROVAL_STORE_SIZE) {
    return 'overflow';
  }
  queue.push(entry);
  return 'enqueued';
}

/**
 * Remove a single pending entry without resolving its promise. Intended for
 * the abort-listener path that has already settled the waiter out-of-band and
 * just needs to keep the store consistent with the XState queue.
 * Returns true if an entry with the given gateId was found and removed.
 */
export function removeBatchApproval(sessionId: string, gateId: string): boolean {
  const queue = store.get(sessionId);
  if (!queue) return false;
  const idx = queue.findIndex((e) => e.gateId === gateId);
  if (idx === -1) return false;
  queue.splice(idx, 1);
  if (queue.length === 0) store.delete(sessionId);
  return true;
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
