import { describe, it, expect, beforeEach } from 'vitest';
import {
  enqueueBatchApproval,
  drainBatchApprovals,
  getBatchApprovalCount,
  getBatchApprovalQueue,
  clearBatchApprovalStore,
  MAX_BATCH_APPROVAL_STORE_SIZE,
  type BatchApprovalEntry,
} from '../src/output/batch-approval-store.ts';

function makeEntry(overrides: Partial<BatchApprovalEntry> = {}): BatchApprovalEntry {
  return {
    gateId: 'g1',
    toolUseID: 'tu-1',
    toolName: 'Bash',
    detail: 'rm -rf',
    timestamp: 123,
    resolve: () => {},
    ...overrides,
  };
}

describe('batch-approval-store', () => {
  beforeEach(() => {
    clearBatchApprovalStore('s1');
    clearBatchApprovalStore('s2');
  });

  it('enqueue + count + queue returns pending items', () => {
    expect(enqueueBatchApproval('s1', makeEntry({ gateId: 'g1' }))).toBe('enqueued');
    expect(enqueueBatchApproval('s1', makeEntry({ gateId: 'g2' }))).toBe('enqueued');
    expect(getBatchApprovalCount('s1')).toBe(2);
    expect(getBatchApprovalQueue('s1').map((e) => e.gateId)).toEqual(['g1', 'g2']);
  });

  it('returns overflow and drops the entry once the queue is full', () => {
    for (let i = 0; i < MAX_BATCH_APPROVAL_STORE_SIZE; i++) {
      expect(enqueueBatchApproval('s1', makeEntry({ gateId: `g${i}` }))).toBe('enqueued');
    }
    expect(getBatchApprovalCount('s1')).toBe(MAX_BATCH_APPROVAL_STORE_SIZE);
    const result = enqueueBatchApproval('s1', makeEntry({ gateId: 'overflow' }));
    expect(result).toBe('overflow');
    expect(getBatchApprovalCount('s1')).toBe(MAX_BATCH_APPROVAL_STORE_SIZE);
    expect(getBatchApprovalQueue('s1').every((e) => e.gateId !== 'overflow')).toBe(true);
  });

  it('drainBatchApprovals calls every resolver with the given action', () => {
    const calls: string[] = [];
    enqueueBatchApproval('s1', makeEntry({ gateId: 'g1', resolve: (a) => calls.push(`g1:${a}`) }));
    enqueueBatchApproval('s1', makeEntry({ gateId: 'g2', resolve: (a) => calls.push(`g2:${a}`) }));

    const drained = drainBatchApprovals('s1', 'approve');
    expect(drained).toBe(2);
    expect(calls).toEqual(['g1:approve', 'g2:approve']);
    expect(getBatchApprovalCount('s1')).toBe(0);
  });

  it('rejects only for the session drained, leaves others intact', () => {
    const calls: string[] = [];
    enqueueBatchApproval('s1', makeEntry({ resolve: (a) => calls.push(`s1:${a}`) }));
    enqueueBatchApproval('s2', makeEntry({ resolve: (a) => calls.push(`s2:${a}`) }));

    drainBatchApprovals('s1', 'reject');
    expect(calls).toEqual(['s1:reject']);
    expect(getBatchApprovalCount('s2')).toBe(1);
  });

  it('draining an empty queue returns 0 and is safe', () => {
    expect(drainBatchApprovals('nobody', 'approve')).toBe(0);
  });

  it('clearBatchApprovalStore rejects all pending (for cleanup on mode-off)', () => {
    const calls: string[] = [];
    enqueueBatchApproval('s1', makeEntry({ resolve: (a) => calls.push(a) }));
    enqueueBatchApproval('s1', makeEntry({ resolve: (a) => calls.push(a) }));
    clearBatchApprovalStore('s1');
    expect(calls).toEqual(['reject', 'reject']);
    expect(getBatchApprovalCount('s1')).toBe(0);
  });

  it('after overflow + clear, a fresh enqueue is accepted again (no zombie retention)', () => {
    for (let i = 0; i < MAX_BATCH_APPROVAL_STORE_SIZE; i++) {
      enqueueBatchApproval('s1', makeEntry({ gateId: `g${i}` }));
    }
    expect(enqueueBatchApproval('s1', makeEntry({ gateId: 'would-overflow' }))).toBe('overflow');
    clearBatchApprovalStore('s1');
    expect(getBatchApprovalCount('s1')).toBe(0);
    expect(enqueueBatchApproval('s1', makeEntry({ gateId: 'fresh' }))).toBe('enqueued');
  });
});
