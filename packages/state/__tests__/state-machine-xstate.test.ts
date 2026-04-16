import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateMachine } from '../src/state-machine.ts';
import {
  sessionMachine,
  isLifecycleTransitionAllowed,
  isExecutionTransitionAllowed,
} from '../src/xstate-session-machine.ts';
import { createActor } from 'xstate';

describe('xstate-session-machine transition guards', () => {
  it('lifecycle guard matches legacy table exactly', () => {
    // 六个生命周期之间的合法边必须与原手写表一致
    expect(isLifecycleTransitionAllowed('initializing', 'active')).toBe(true);
    expect(isLifecycleTransitionAllowed('initializing', 'paused')).toBe(true);
    expect(isLifecycleTransitionAllowed('active', 'waiting_human')).toBe(true);
    expect(isLifecycleTransitionAllowed('active', 'completed')).toBe(true);
    expect(isLifecycleTransitionAllowed('completed', 'active')).toBe(true);
    expect(isLifecycleTransitionAllowed('error', 'completed')).toBe(true);

    // 典型非法路径
    expect(isLifecycleTransitionAllowed('waiting_human', 'completed')).toBe(false);
    expect(isLifecycleTransitionAllowed('paused', 'waiting_human')).toBe(false);
    expect(isLifecycleTransitionAllowed('completed', 'error')).toBe(false);
    expect(isLifecycleTransitionAllowed('completed', 'waiting_human')).toBe(false);
  });

  it('execution guard allows null on both ends (入场 / 离场)', () => {
    expect(isExecutionTransitionAllowed(null, 'thinking')).toBe(true);
    expect(isExecutionTransitionAllowed('thinking', null)).toBe(true);

    expect(isExecutionTransitionAllowed('idle', 'streaming_output')).toBe(false);
    expect(isExecutionTransitionAllowed('thinking', 'idle')).toBe(true);
    expect(isExecutionTransitionAllowed('tool_executing', 'streaming_output')).toBe(true);
  });
});

describe('xstate actor', () => {
  it('parallel lifecycle + execution states advance independently', () => {
    const actor = createActor(sessionMachine);
    actor.start();

    actor.send({
      type: 'SET_LIFECYCLE',
      lifecycle: 'active',
      updatedAt: 1,
    });
    const snap1 = actor.getSnapshot();
    expect((snap1.value as { lifecycle: string }).lifecycle).toBe('active');

    actor.send({
      type: 'SET_EXECUTION',
      execution: 'thinking',
      updatedAt: 2,
    });
    const snap2 = actor.getSnapshot();
    expect((snap2.value as { execution: string }).execution).toBe('thinking');
    // lifecycle 不受影响
    expect((snap2.value as { lifecycle: string }).lifecycle).toBe('active');

    actor.stop();
  });

  it('after 3s auto-idle timer fires on completed state', () => {
    vi.useFakeTimers();
    const actor = createActor(sessionMachine);
    actor.start();
    actor.send({
      type: 'SET_LIFECYCLE',
      lifecycle: 'completed',
      displayState: 'completed',
      updatedAt: 1,
    });

    // 内部的 after.3000 会将 displayState 回落到 idle(markAutoIdle)
    vi.advanceTimersByTime(3000);

    const snap = actor.getSnapshot();
    expect(snap.context.displayState).toBe('idle');
    actor.stop();
    vi.useRealTimers();
  });

  it('illegal SET_LIFECYCLE is silently ignored (guard rejects)', () => {
    const actor = createActor(sessionMachine);
    actor.start();
    actor.send({ type: 'SET_LIFECYCLE', lifecycle: 'waiting_human', updatedAt: 1 });
    // initializing → waiting_human 合法
    expect((actor.getSnapshot().value as { lifecycle: string }).lifecycle).toBe('waiting_human');

    // waiting_human → completed 非法;机器内 guard 全部 false → 忽略
    actor.send({ type: 'SET_LIFECYCLE', lifecycle: 'completed', updatedAt: 2 });
    expect((actor.getSnapshot().value as { lifecycle: string }).lifecycle).toBe('waiting_human');
    actor.stop();
  });
});

describe('StateMachine turn-state persister (P2)', () => {
  let sm: StateMachine;
  let persistCalls: Array<{ sessionId: string; projection: { turn: number; humanResolved: boolean } }>;

  beforeEach(() => {
    sm = new StateMachine();
    persistCalls = [];
    sm.registerTurnStatePersister((sessionId, projection) => {
      persistCalls.push({ sessionId, projection });
    });
  });

  afterEach(() => {
    sm.clearSession('sess-A');
    sm.clearSession('sess-B');
  });

  it('fires persister when turn changes via setTurn', () => {
    sm.setTurn('sess-A', 5, 'test');
    expect(persistCalls).toHaveLength(1);
    expect(persistCalls[0]).toEqual({
      sessionId: 'sess-A',
      projection: { turn: 5, humanResolved: false },
    });
  });

  it('fires persister when humanResolved changes via setHumanResolved', () => {
    // 先走到一个已决断状态
    sm.setHumanResolved('sess-A', true);
    expect(persistCalls.some((c) => c.projection.humanResolved === true)).toBe(true);
  });

  it('does not fire persister when transition keeps turn and humanResolved unchanged', () => {
    sm.setTurn('sess-A', 3, 'initial');
    persistCalls.length = 0;

    sm.transition(
      'sess-A',
      'display_update_only',
      {},
      { displayState: 'thinking', turn: 3, humanResolved: false },
    );
    expect(persistCalls).toHaveLength(0);
  });

  it('fires persister exactly once per real change, not per call', () => {
    sm.setTurn('sess-A', 1, 'first');
    sm.setTurn('sess-A', 1, 'idempotent'); // same turn → no-op
    sm.setTurn('sess-A', 2, 'bump');
    expect(persistCalls).toHaveLength(2);
  });

  it('persister errors are caught and do not abort transitions', () => {
    const throwingSm = new StateMachine();
    throwingSm.registerTurnStatePersister(() => {
      throw new Error('disk full');
    });
    // 不应抛出;状态仍然应该切到期望值
    expect(() => throwingSm.setTurn('sess-B', 9, 'test')).not.toThrow();
    expect(throwingSm.getSnapshot('sess-B').turn).toBe(9);
    throwingSm.clearSession('sess-B');
  });

  it('setHumanResolved is a no-op if value already matches', () => {
    sm.setHumanResolved('sess-A', false); // default is false → no change
    expect(persistCalls).toHaveLength(0);
    sm.setHumanResolved('sess-A', true);
    expect(persistCalls).toHaveLength(1);
    sm.setHumanResolved('sess-A', true); // second call with same value → no-op
    expect(persistCalls).toHaveLength(1);
  });

  it('advanceTurnToIdle triggers one persister call with incremented turn', () => {
    sm.setTurn('sess-A', 0, 'init');
    persistCalls.length = 0;
    sm.advanceTurnToIdle('sess-A');
    // 可能经过 increment + settle 两次变更;turn 应最终为 1
    const finalCall = persistCalls.at(-1);
    expect(finalCall?.projection.turn).toBe(1);
    expect(finalCall?.projection.humanResolved).toBe(false);
  });

  it('unregister (pass null) disables future persistence callbacks', () => {
    sm.setTurn('sess-A', 1, 'first');
    expect(persistCalls).toHaveLength(1);
    sm.registerTurnStatePersister(null);
    sm.setTurn('sess-A', 2, 'second');
    expect(persistCalls).toHaveLength(1);
  });
});
