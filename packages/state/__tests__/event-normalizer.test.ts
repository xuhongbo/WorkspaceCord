import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  normalizeClaudeEvent,
  normalizeCodexEvent,
  isPlatformEvent,
  toPlatformEvent,
  mapPlatformEventToState,
} from '../src/event-normalizer.ts';

describe('event-normalizer', () => {
  describe('normalizeClaudeEvent', () => {
    it('maps text_delta to thinking_started', () => {
      const event = normalizeClaudeEvent({ type: 'text_delta' } as any, 'sess-1');

      expect(event?.type).toBe('thinking_started');
      expect(event?.sessionId).toBe('sess-1');
      expect(event?.source).toBe('claude');
      expect(event?.stateSource).toBe('formal');
    });

    it('maps ask_user to awaiting_human', () => {
      const event = normalizeClaudeEvent({ type: 'ask_user' } as any, 'sess-1');
      expect(event?.type).toBe('awaiting_human');
    });

    it('maps result to completed', () => {
      const event = normalizeClaudeEvent({ type: 'result' } as any, 'sess-1');
      expect(event?.type).toBe('completed');
    });

    it('maps error to errored', () => {
      const event = normalizeClaudeEvent({ type: 'error' } as any, 'sess-1');
      expect(event?.type).toBe('errored');
    });

    it('maps session_init to session_started', () => {
      const event = normalizeClaudeEvent({ type: 'session_init' } as any, 'sess-1');
      expect(event?.type).toBe('session_started');
    });

    it('returns null for unmapped event type', () => {
      const event = normalizeClaudeEvent({ type: 'unknown_type' } as any, 'sess-1');
      expect(event).toBeNull();
    });
  });

  describe('normalizeCodexEvent', () => {
    it('maps session_meta to session_started', () => {
      const event = normalizeCodexEvent('session_meta', 'sess-1', {});
      expect(event?.type).toBe('session_started');
      expect(event?.source).toBe('codex');
    });

    it('maps codex-permission to awaiting_human with inferred stateSource', () => {
      const event = normalizeCodexEvent('codex-permission', 'sess-1', {});
      expect(event?.type).toBe('awaiting_human');
      expect(event?.stateSource).toBe('inferred');
      expect(event?.confidence).toBe('medium');
    });

    it('maps event_msg:task_complete to completed', () => {
      const event = normalizeCodexEvent('event_msg:task_complete', 'sess-1', {});
      expect(event?.type).toBe('completed');
    });

    it('returns null for unmapped event key', () => {
      const event = normalizeCodexEvent('unknown_event', 'sess-1', {});
      expect(event).toBeNull();
    });

    it('prefers observedState mapping for codex-permission', () => {
      const event = normalizeCodexEvent('some_other', 'sess-1', { observedState: 'codex-permission' });
      expect(event?.type).toBe('awaiting_human');
      expect(event?.stateSource).toBe('inferred');
    });

    it('maps observedState idle to session_idle', () => {
      const event = normalizeCodexEvent('ignored', 'sess-1', { observedState: 'idle' });
      expect(event?.type).toBe('session_idle');
    });
  });

  describe('isPlatformEvent', () => {
    it('returns true for valid platform event', () => {
      const event = {
        type: 'thinking_started',
        sessionId: 's1',
        source: 'claude',
        stateSource: 'formal',
        confidence: 'high',
        timestamp: Date.now(),
      };
      expect(isPlatformEvent(event)).toBe(true);
    });

    it('returns false for missing type', () => {
      expect(isPlatformEvent({ sessionId: 's1', source: 'claude', confidence: 'high', timestamp: 1 })).toBe(false);
    });

    it('returns false for invalid source', () => {
      expect(isPlatformEvent({ type: 'x', sessionId: 's1', source: 'unknown', confidence: 'high', timestamp: 1 })).toBe(false);
    });

    it('returns false for missing timestamp', () => {
      expect(isPlatformEvent({ type: 'x', sessionId: 's1', source: 'claude', confidence: 'high' })).toBe(false);
    });
  });

  describe('toPlatformEvent', () => {
    it('passes through already-valid platform events', () => {
      const input = {
        type: 'thinking_started',
        sessionId: 's1',
        source: 'claude',
        stateSource: 'formal',
        confidence: 'high',
        timestamp: 123,
      };
      const result = toPlatformEvent(input, 's1');
      expect(result?.type).toBe('thinking_started');
    });

    it('normalizes Claude provider events', () => {
      const result = toPlatformEvent({ type: 'text_delta' } as any, 'sess-1');
      expect(result?.type).toBe('thinking_started');
    });
  });

  describe('mapPlatformEventToState', () => {
    it('maps platform event types to unified state', () => {
      expect(mapPlatformEventToState('thinking_started')).toBe('thinking');
      expect(mapPlatformEventToState('work_started')).toBe('working');
      expect(mapPlatformEventToState('awaiting_human')).toBe('awaiting_human');
      expect(mapPlatformEventToState('completed')).toBe('completed');
      expect(mapPlatformEventToState('errored')).toBe('error');
    });

    it('maps session_started to idle', () => {
      expect(mapPlatformEventToState('session_started')).toBe('idle');
    });
  });
});
