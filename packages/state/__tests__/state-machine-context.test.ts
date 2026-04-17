import { describe, it, expect, beforeEach } from 'vitest';
import { StateMachine } from '../src/state-machine.ts';

describe('StateMachine — SessionContextFields via XState', () => {
  let machine: StateMachine;

  beforeEach(() => {
    machine = new StateMachine();
  });

  it('applyTodoUpdate stores the latest todoList in the snapshot and projection', () => {
    const projection = machine.applyTodoUpdate('s1', [
      { text: 'Write the spec', completed: true },
      { text: 'Run the tests', completed: false },
    ]);

    expect(projection.todoList).toEqual([
      { text: 'Write the spec', completed: true },
      { text: 'Run the tests', completed: false },
    ]);
    expect(projection.todoUpdatedAt).toBeTypeOf('number');

    // Second update replaces the list
    const second = machine.applyTodoUpdate('s1', [
      { text: 'Ship it', completed: true },
    ]);
    expect(second.todoList).toHaveLength(1);
    expect(second.todoList?.[0].text).toBe('Ship it');
  });

  it('applyPermissionDenial pushes newest-first and caps at 5 entries', () => {
    for (let i = 1; i <= 7; i++) {
      machine.applyPermissionDenial('s1', `tool${i}`, `reason${i}`);
    }
    const projection = machine.getSnapshot('s1');
    expect(projection.recentPermissionDenials).toHaveLength(5);
    expect(projection.recentPermissionDenials?.[0].toolName).toBe('tool7');
    expect(projection.recentPermissionDenials?.[4].toolName).toBe('tool3');
  });

  it('removePendingApproval drops one entry by gateId', () => {
    machine.setBatchApprovalMode('s1', true);
    machine.enqueuePendingApproval('s1', { gateId: 'g1', toolName: 'Read', detail: 'file', timestamp: 1 });
    machine.enqueuePendingApproval('s1', { gateId: 'g2', toolName: 'Write', detail: 'file', timestamp: 2 });
    machine.enqueuePendingApproval('s1', { gateId: 'g3', toolName: 'Bash', detail: 'cmd', timestamp: 3 });

    machine.removePendingApproval('s1', 'g2');
    const pending = machine.getSnapshot('s1').pendingApprovals ?? [];
    expect(pending.map((e) => e.gateId)).toEqual(['g1', 'g3']);

    // Missing gateId is a no-op (doesn't throw, queue unchanged)
    machine.removePendingApproval('s1', 'never-existed');
    expect(machine.getSnapshot('s1').pendingApprovals).toHaveLength(2);
  });

  it('setBatchApprovalMode toggles the flag and seeds the queue', () => {
    const enabled = machine.setBatchApprovalMode('s1', true);
    expect(enabled.batchApprovalMode).toBe(true);
    expect(enabled.pendingApprovals).toEqual([]);

    machine.enqueuePendingApproval('s1', {
      gateId: 'g1',
      toolName: 'Write',
      detail: 'write foo.txt',
      timestamp: 123,
    });
    const afterEnqueue = machine.getSnapshot('s1');
    expect(afterEnqueue.pendingApprovals).toHaveLength(1);

    const cleared = machine.clearPendingApprovals('s1');
    expect(cleared.pendingApprovals).toEqual([]);

    // Disabling wipes the queue even if items exist
    machine.enqueuePendingApproval('s1', {
      gateId: 'g2',
      toolName: 'Bash',
      detail: 'rm -rf',
      timestamp: 456,
    });
    const disabled = machine.setBatchApprovalMode('s1', false);
    expect(disabled.batchApprovalMode).toBe(false);
    expect(disabled.pendingApprovals).toEqual([]);
  });

  it('applyPlatformEvent dispatches todo_updated / permission_denied / batch_approval_changed to context updaters', () => {
    machine.applyPlatformEvent({
      type: 'todo_updated',
      sessionId: 's1',
      source: 'claude',
      confidence: 'high',
      timestamp: Date.now(),
      metadata: {
        items: [{ text: 'A', completed: false }],
      },
    });
    expect(machine.getSnapshot('s1').todoList).toEqual([{ text: 'A', completed: false }]);

    machine.applyPlatformEvent({
      type: 'permission_denied',
      sessionId: 's1',
      source: 'claude',
      confidence: 'high',
      timestamp: Date.now(),
      metadata: { toolName: 'Bash', reason: 'sandbox deny' },
    });
    const after = machine.getSnapshot('s1');
    expect(after.recentPermissionDenials?.[0]).toMatchObject({
      toolName: 'Bash',
      reason: 'sandbox deny',
    });

    machine.applyPlatformEvent({
      type: 'batch_approval_changed',
      sessionId: 's1',
      source: 'claude',
      confidence: 'high',
      timestamp: Date.now(),
      metadata: { enabled: true },
    });
    expect(machine.getSnapshot('s1').batchApprovalMode).toBe(true);
  });

  it('context events do not change lifecycle or execution state', () => {
    machine.applyPlatformEvent({
      type: 'work_started',
      sessionId: 's1',
      source: 'claude',
      confidence: 'high',
      timestamp: Date.now(),
    });
    const beforeState = machine.getState('s1').lifecycle;

    machine.applyTodoUpdate('s1', [{ text: 'stay working', completed: false }]);
    expect(machine.getState('s1').lifecycle).toBe(beforeState);
    expect(machine.getSnapshot('s1').todoList).toHaveLength(1);
  });
});
