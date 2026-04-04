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
});
