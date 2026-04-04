import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StateMachine } from '../src/state/state-machine.ts';

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
    });

    it('returns same state on subsequent calls', () => {
      const a = sm.getState('sess-1');
      const b = sm.getState('sess-1');
      expect(a).toBe(b);
    });
  });

  describe('transition — lifecycle', () => {
    it('transitions from initializing to active', () => {
      const result = sm.transition('sess-1', 'session_started', { lifecycle: 'active' });

      expect(result.success).toBe(true);
      expect(result.state.lifecycle).toBe('active');
    });

    it('rejects invalid lifecycle transition', () => {
      sm.getState('sess-1'); // create default (initializing)
      const result = sm.transition('sess-1', 'bad', { lifecycle: 'completed' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('非法');
    });

    it('allows error from any state', () => {
      sm.transition('sess-1', 'session_started', { lifecycle: 'active' });
      const result = sm.transition('sess-1', 'error', { lifecycle: 'error' });

      expect(result.success).toBe(true);
      expect(result.state.lifecycle).toBe('error');
    });

    it('is idempotent — same state returns success without change', () => {
      sm.transition('sess-1', 'start', { lifecycle: 'active' });
      const result = sm.transition('sess-1', 'noop', { lifecycle: 'active' });

      expect(result.success).toBe(true);
    });
  });

  describe('transition — execution state', () => {
    beforeEach(() => {
      sm.transition('sess-1', 'start', { lifecycle: 'active', execution: 'idle' });
    });

    it('transitions idle -> thinking', () => {
      const result = sm.transition('sess-1', 'thinking', { execution: 'thinking' });
      expect(result.success).toBe(true);
      expect(result.state.execution).toBe('thinking');
    });

    it('rejects idle -> streaming_output (must go through thinking or tool_executing)', () => {
      // Reset to idle
      sm.transition('sess-1', 'reset', { execution: 'idle' });
      const result = sm.transition('sess-1', 'stream', { execution: 'streaming_output' });

      expect(result.success).toBe(false);
    });

    it('clears execution state when lifecycle is not active', () => {
      const result = sm.transition('sess-1', 'paused', { lifecycle: 'paused' });

      expect(result.success).toBe(true);
      expect(result.state.lifecycle).toBe('paused');
      expect(result.state.execution).toBeNull();
    });

    it('rejects non-null execution when lifecycle is not active', () => {
      sm.transition('sess-1', 'done', { lifecycle: 'completed' });
      const result = sm.transition('sess-1', 'bad', { execution: 'thinking' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('仅在 lifecycle=active 时有效');
    });
  });

  describe('transition history', () => {
    it('records transitions', () => {
      sm.transition('sess-1', 'start', { lifecycle: 'active' });
      sm.transition('sess-1', 'pause', { lifecycle: 'paused' });

      const history = sm.getTransitionHistory('sess-1');
      expect(history).toHaveLength(2);
      expect(history[0].event).toBe('start');
      expect(history[1].event).toBe('pause');
    });

    it('limits history to 100 entries', () => {
      for (let i = 0; i < 150; i++) {
        const target = i % 2 === 0 ? 'active' : 'error';
        if (target === 'error') {
          sm.transition('sess-1', 'e', { lifecycle: 'error' });
        } else {
          sm.transition('sess-1', 'r', { lifecycle: 'active' });
        }
      }

      const history = sm.getTransitionHistory('sess-1');
      expect(history.length).toBeLessThanOrEqual(100);
    });
  });

  describe('clearSession', () => {
    it('removes session state', () => {
      sm.transition('sess-1', 'start', { lifecycle: 'active' });
      sm.clearSession('sess-1');

      const state = sm.getState('sess-1');
      expect(state.lifecycle).toBe('initializing'); // recreated as default
    });
  });

  describe('legacy snapshot API', () => {
    it('creates default snapshot', () => {
      const snap = sm.ensureSession('sess-1');

      expect(snap.state).toBe('idle');
      expect(snap.turn).toBe(0);
      expect(snap.isCompleted).toBe(false);
    });

    it('increments turn', () => {
      sm.incrementTurn('sess-1');
      const snap = sm.getSession('sess-1');
      expect(snap?.turn).toBe(1);
    });
  });

  describe('resolveDisplayState', () => {
    it('returns highest priority state', () => {
      sm.ensureSession('s1');
      sm.updateSession('s1', { state: 'idle' });
      sm.ensureSession('s2');
      sm.updateSession('s2', { state: 'error' });

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
    it('maps session_started to idle state and increments turn', () => {
      const event = {
        type: 'session_started' as const,
        sessionId: 'sess-1',
        source: 'claude' as const,
        stateSource: 'formal' as const,
        confidence: 'high' as const,
        timestamp: Date.now(),
      };

      const snap = sm.applyPlatformEvent(event);

      expect(snap.state).toBe('idle');
      expect(snap.turn).toBe(1);
    });

    it('maps thinking_started to thinking state', () => {
      const event = {
        type: 'thinking_started' as const,
        sessionId: 'sess-1',
        source: 'claude' as const,
        stateSource: 'formal' as const,
        confidence: 'high' as const,
        timestamp: Date.now(),
      };

      const snap = sm.applyPlatformEvent(event);
      expect(snap.state).toBe('thinking');
    });

    it('maps awaiting_human and sets isWaitingHuman', () => {
      const event = {
        type: 'awaiting_human' as const,
        sessionId: 'sess-1',
        source: 'claude' as const,
        stateSource: 'formal' as const,
        confidence: 'high' as const,
        timestamp: Date.now(),
      };

      const snap = sm.applyPlatformEvent(event);
      expect(snap.state).toBe('awaiting_human');
      expect(snap.isWaitingHuman).toBe(true);
    });

    it('maps completed and sets isCompleted', () => {
      const event = {
        type: 'completed' as const,
        sessionId: 'sess-1',
        source: 'claude' as const,
        stateSource: 'formal' as const,
        confidence: 'high' as const,
        timestamp: Date.now(),
      };

      const snap = sm.applyPlatformEvent(event);
      expect(snap.state).toBe('completed');
      expect(snap.isCompleted).toBe(true);
    });

    it('maps errored and sets isError', () => {
      const event = {
        type: 'errored' as const,
        sessionId: 'sess-1',
        source: 'claude' as const,
        stateSource: 'formal' as const,
        confidence: 'high' as const,
        timestamp: Date.now(),
      };

      const snap = sm.applyPlatformEvent(event);
      expect(snap.state).toBe('error');
      expect(snap.isError).toBe(true);
    });

    it('clears isWaitingHuman on session_ended', () => {
      sm.applyPlatformEvent({
        type: 'awaiting_human' as const, sessionId: 'sess-1', source: 'claude',
        stateSource: 'formal' as const, confidence: 'high' as const, timestamp: Date.now(),
      });

      sm.applyPlatformEvent({
        type: 'session_ended' as const, sessionId: 'sess-1', source: 'claude',
        stateSource: 'formal' as const, confidence: 'high' as const, timestamp: Date.now(),
      });

      const snap = sm.getSession('sess-1');
      expect(snap?.isWaitingHuman).toBe(false);
    });

    it('respects token validation for session_idle — rejects mismatched token', () => {
      // First set to completed to establish a timer token
      sm.applyPlatformEvent({
        type: 'completed' as const, sessionId: 'sess-1', source: 'claude',
        stateSource: 'formal' as const, confidence: 'high' as const, timestamp: Date.now(),
      });

      // Try to transition to session_idle with wrong token
      const snap = sm.applyPlatformEvent({
        type: 'session_idle' as const, sessionId: 'sess-1', source: 'claude',
        stateSource: 'formal' as const, confidence: 'high' as const,
        timestamp: Date.now(), metadata: { idleTimerToken: 999, turn: 0 },
      });

      // Should remain completed because token doesn't match
      expect(snap.state).toBe('completed');
    });

    it('respects turn validation for session_idle — rejects mismatched turn', () => {
      // Set to completed
      sm.applyPlatformEvent({
        type: 'completed' as const, sessionId: 'sess-1', source: 'claude',
        stateSource: 'formal' as const, confidence: 'high' as const, timestamp: Date.now(),
      });
      const snap = sm.getSession('sess-1');
      const activeToken = (sm as any).completedTimerTokens.get('sess-1');

      // session_idle with matching token but wrong turn
      const result = sm.applyPlatformEvent({
        type: 'session_idle' as const, sessionId: 'sess-1', source: 'claude',
        stateSource: 'formal' as const, confidence: 'high' as const,
        timestamp: Date.now(), metadata: { idleTimerToken: activeToken, turn: 999 },
      });

      expect(result.state).toBe('completed');
    });

    it('does not increment turn on session_started when turn already > 0', () => {
      const event = {
        type: 'session_started' as const, sessionId: 'sess-1', source: 'claude',
        stateSource: 'formal' as const, confidence: 'high' as const, timestamp: Date.now(),
      };
      sm.applyPlatformEvent(event);
      sm.applyPlatformEvent({
        type: 'session_started' as const, sessionId: 'sess-1', source: 'claude',
        stateSource: 'formal' as const, confidence: 'high' as const, timestamp: Date.now(),
      });

      const snap = sm.getSession('sess-1');
      expect(snap?.turn).toBe(1); // Only incremented once
    });
  });
});
