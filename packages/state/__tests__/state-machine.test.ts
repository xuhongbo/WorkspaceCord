import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StateMachine } from '../src/state-machine.ts';

describe('StateMachine', () => {
  let sm: StateMachine;

  beforeEach(() => {
    vi.useFakeTimers();
    sm = new StateMachine();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getState', () => {
    it('creates default state for new session', () => {
      const state = sm.getState('sess-1');

      expect(state.lifecycle).toBe('initializing');
      expect(state.execution).toBeNull();
      expect(state.gate).toBeNull();
      expect(state.displayState).toBe('idle');
      expect(state.turn).toBe(0);
    });

    it('returns same state on subsequent calls', () => {
      const a = sm.getState('sess-1');
      const b = sm.getState('sess-1');
      expect(a).toBe(b);
    });
  });

  describe('transition — lifecycle', () => {
    it('transitions from initializing to active', () => {
      const result = sm.transition('sess-1', 'session_started', {
        lifecycle: 'active',
        execution: 'idle',
      }, {
        displayState: 'idle',
      });

      expect(result.success).toBe(true);
      expect(result.state.lifecycle).toBe('active');
      expect(result.state.execution).toBe('idle');
    });

    it('rejects invalid lifecycle transition', () => {
      sm.transition('sess-1', 'start', { lifecycle: 'active', execution: 'idle' }, { displayState: 'idle' });
      const result = sm.transition('sess-1', 'bad', { lifecycle: 'initializing' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('非法');
    });

    it('allows error from active state', () => {
      sm.transition('sess-1', 'session_started', { lifecycle: 'active', execution: 'idle' }, { displayState: 'idle' });
      const result = sm.transition('sess-1', 'error', { lifecycle: 'error' }, { displayState: 'error' });

      expect(result.success).toBe(true);
      expect(result.state.lifecycle).toBe('error');
      expect(result.state.displayState).toBe('error');
    });

    it('is idempotent when full state does not change', () => {
      sm.transition('sess-1', 'start', { lifecycle: 'active', execution: 'idle' }, { displayState: 'idle' });
      const before = sm.getTransitionHistory('sess-1').length;
      const result = sm.transition('sess-1', 'noop', { lifecycle: 'active', execution: 'idle' }, { displayState: 'idle' });

      expect(result.success).toBe(true);
      expect(sm.getTransitionHistory('sess-1')).toHaveLength(before);
    });
  });

  describe('transition — execution state', () => {
    beforeEach(() => {
      sm.transition('sess-1', 'start', { lifecycle: 'active', execution: 'idle' }, { displayState: 'idle' });
    });

    it('transitions idle -> thinking', () => {
      const result = sm.transition('sess-1', 'thinking', { execution: 'thinking' }, { displayState: 'thinking' });
      expect(result.success).toBe(true);
      expect(result.state.execution).toBe('thinking');
    });

    it('rejects idle -> streaming_output', () => {
      const result = sm.transition('sess-1', 'stream', { execution: 'streaming_output' }, { displayState: 'working' });
      expect(result.success).toBe(false);
    });

    it('clears execution state when lifecycle is not active', () => {
      const result = sm.transition('sess-1', 'paused', { lifecycle: 'paused' }, { displayState: 'stalled' });

      expect(result.success).toBe(true);
      expect(result.state.lifecycle).toBe('paused');
      expect(result.state.execution).toBeNull();
    });

    it('rejects non-null execution when lifecycle is not active', () => {
      sm.transition('sess-1', 'done', { lifecycle: 'completed' }, { displayState: 'completed' });
      const result = sm.transition('sess-1', 'bad', { execution: 'thinking' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('仅在 lifecycle=active 时有效');
    });
  });

  describe('turn helpers', () => {
    it('setTurn writes into single state source', () => {
      const projection = sm.setTurn('sess-1', 3);
      const state = sm.getState('sess-1');

      expect(projection.turn).toBe(3);
      expect(state.turn).toBe(3);
    });

    it('incrementTurn increments turn and clears humanResolved', () => {
      sm.transition('sess-1', 'approved', { lifecycle: 'active', execution: 'tool_executing', gate: 'approved' }, {
        displayState: 'working',
        humanResolved: true,
        turn: 1,
      });

      const projection = sm.incrementTurn('sess-1');

      expect(projection.turn).toBe(2);
      expect(projection.humanResolved).toBe(false);
    });

    it('advanceTurnToIdle increments turn and settles to idle projection', () => {
      sm.transition('sess-1', 'working', { lifecycle: 'active', execution: 'tool_executing', gate: 'approved' }, {
        displayState: 'working',
        humanResolved: true,
        turn: 2,
        phase: '执行中',
      });

      const projection = sm.advanceTurnToIdle('sess-1');
      const state = sm.getState('sess-1');

      expect(projection.turn).toBe(3);
      expect(projection.state).toBe('idle');
      expect(projection.humanResolved).toBe(false);
      expect(state.execution).toBe('idle');
      expect(state.gate).toBeNull();
    });
  });

  describe('transition history', () => {
    it('records transitions', () => {
      sm.transition('sess-1', 'start', { lifecycle: 'active', execution: 'idle' }, { displayState: 'idle' });
      sm.transition('sess-1', 'pause', { lifecycle: 'paused' }, { displayState: 'stalled' });

      const history = sm.getTransitionHistory('sess-1');
      expect(history).toHaveLength(2);
      expect(history[0].event).toBe('start');
      expect(history[1].event).toBe('pause');
    });

    it('limits history to 100 entries', () => {
      for (let i = 0; i < 150; i++) {
        const toError = i % 2 === 0;
        sm.transition(
          'sess-1',
          toError ? 'error' : 'recover',
          { lifecycle: toError ? 'error' : 'active', execution: toError ? null : 'idle' },
          { displayState: toError ? 'error' : 'idle' },
        );
      }

      const history = sm.getTransitionHistory('sess-1');
      expect(history.length).toBeLessThanOrEqual(100);
    });
  });

  describe('resolveDisplayState', () => {
    it('returns highest priority state', () => {
      sm.transition('s1', 'idle', {}, { displayState: 'idle' });
      sm.transition('s2', 'error', { lifecycle: 'error' }, { displayState: 'error' });

      const display = sm.resolveDisplayState();
      expect(display).toBe('error');
    });

    it('returns idle when no sessions', () => {
      expect(sm.resolveDisplayState()).toBe('idle');
    });
  });

  describe('shouldTransition', () => {
    it('allows transition when target has higher priority', () => {
      expect(sm.shouldTransition('idle', 'error')).toBe(true);
    });

    it('blocks lower priority when source is formal and target is inferred', () => {
      expect(sm.shouldTransition('error', 'idle', 'formal', 'inferred')).toBe(false);
    });
  });

  describe('getStateLabel / getStateColor', () => {
    it('returns Chinese label', () => {
      expect(sm.getStateLabel('idle')).toBe('待命');
      expect(sm.getStateLabel('error')).toBe('出现异常');
    });

    it('returns color code', () => {
      expect(sm.getStateColor('error')).toBe(0xe74c3c);
      expect(sm.getStateColor('idle')).toBe(0x808080);
    });
  });

  describe('applyPlatformEvent', () => {
    it('maps session_started to active idle and increments turn', () => {
      const snap = sm.applyPlatformEvent({
        type: 'session_started',
        sessionId: 'sess-1',
        source: 'claude',
        stateSource: 'formal',
        confidence: 'high',
        timestamp: Date.now(),
      });

      const state = sm.getState('sess-1');
      expect(snap.state).toBe('idle');
      expect(snap.turn).toBe(1);
      expect(state.lifecycle).toBe('active');
      expect(state.execution).toBe('idle');
    });

    it('maps thinking_started to thinking state', () => {
      sm.applyPlatformEvent({
        type: 'session_started',
        sessionId: 'sess-1',
        source: 'claude',
        stateSource: 'formal',
        confidence: 'high',
        timestamp: Date.now(),
      });

      const snap = sm.applyPlatformEvent({
        type: 'thinking_started',
        sessionId: 'sess-1',
        source: 'claude',
        stateSource: 'formal',
        confidence: 'high',
        timestamp: Date.now(),
      });

      expect(snap.state).toBe('thinking');
      expect(sm.getState('sess-1').execution).toBe('thinking');
    });

    it('maps awaiting_human and sets pending gate', () => {
      sm.applyPlatformEvent({
        type: 'awaiting_human',
        sessionId: 'sess-1',
        source: 'claude',
        stateSource: 'formal',
        confidence: 'high',
        timestamp: Date.now(),
      });

      const state = sm.getState('sess-1');
      const panelProjection = sm.getPanelProjection('sess-1');
      expect(panelProjection.state).toBe('awaiting_human');
      expect(panelProjection.isWaitingHuman).toBe(true);
      expect(state.lifecycle).toBe('waiting_human');
      expect(state.gate).toBe('pending');
    });

    it('maps completed and registers idle reset timer', () => {
      const snap = sm.applyPlatformEvent({
        type: 'completed',
        sessionId: 'sess-1',
        source: 'claude',
        stateSource: 'formal',
        confidence: 'high',
        timestamp: Date.now(),
      });

      expect(snap.state).toBe('completed');
      expect(sm.getState('sess-1').lifecycle).toBe('completed');
      // P2 重构后:定时器由 XState after.3000 内置管理,wrapper 仅保留 token 用于幂等
      expect((sm as unknown as { completedTimerTokens: Map<string, number> }).completedTimerTokens.size).toBe(1);
    });

    it('maps errored and sets lifecycle error', () => {
      sm.applyPlatformEvent({
        type: 'errored',
        sessionId: 'sess-1',
        source: 'claude',
        stateSource: 'formal',
        confidence: 'high',
        timestamp: Date.now(),
      });

      const panelProjection = sm.getPanelProjection('sess-1');
      expect(panelProjection.state).toBe('error');
      expect(panelProjection.isError).toBe(true);
      expect(sm.getState('sess-1').lifecycle).toBe('error');
    });

    it('session_ended invalidates pending gate', () => {
      sm.applyPlatformEvent({
        type: 'awaiting_human',
        sessionId: 'sess-1',
        source: 'claude',
        stateSource: 'formal',
        confidence: 'high',
        timestamp: Date.now(),
      });

      const snap = sm.applyPlatformEvent({
        type: 'session_ended',
        sessionId: 'sess-1',
        source: 'claude',
        stateSource: 'formal',
        confidence: 'high',
        timestamp: Date.now(),
      });

      expect(snap.state).toBe('offline');
      expect(sm.getState('sess-1').gate).toBe('invalidated');
    });

    it('respects token validation for session_idle', () => {
      sm.applyPlatformEvent({
        type: 'completed',
        sessionId: 'sess-1',
        source: 'claude',
        stateSource: 'formal',
        confidence: 'high',
        timestamp: Date.now(),
      });

      const snap = sm.applyPlatformEvent({
        type: 'session_idle',
        sessionId: 'sess-1',
        source: 'claude',
        stateSource: 'formal',
        confidence: 'high',
        timestamp: Date.now(),
        metadata: { idleTimerToken: 999, turn: 0 },
      });

      expect(snap.state).toBe('completed');
    });

    it('respects turn validation for session_idle', () => {
      sm.applyPlatformEvent({
        type: 'completed',
        sessionId: 'sess-1',
        source: 'claude',
        stateSource: 'formal',
        confidence: 'high',
        timestamp: Date.now(),
      });
      const activeToken = (sm as any).completedTimerTokens.get('sess-1');

      const snap = sm.applyPlatformEvent({
        type: 'session_idle',
        sessionId: 'sess-1',
        source: 'claude',
        stateSource: 'formal',
        confidence: 'high',
        timestamp: Date.now(),
        metadata: { idleTimerToken: activeToken, turn: 999 },
      });

      expect(snap.state).toBe('completed');
    });

    it('does not increment turn on repeated session_started', () => {
      sm.applyPlatformEvent({
        type: 'session_started',
        sessionId: 'sess-1',
        source: 'claude',
        stateSource: 'formal',
        confidence: 'high',
        timestamp: Date.now(),
      });
      sm.applyPlatformEvent({
        type: 'session_started',
        sessionId: 'sess-1',
        source: 'claude',
        stateSource: 'formal',
        confidence: 'high',
        timestamp: Date.now(),
      });

      const projection = sm.getSnapshot('sess-1');
      expect(projection.turn).toBe(1);
    });
  });

  describe('clearSession', () => {
    it('removes session state', () => {
      sm.transition('sess-1', 'start', { lifecycle: 'active', execution: 'idle' }, { displayState: 'idle' });
      sm.clearSession('sess-1');

      const state = sm.getState('sess-1');
      expect(state.lifecycle).toBe('initializing');
      expect(sm.getSessionCount()).toBe(1);
    });
  });
});
