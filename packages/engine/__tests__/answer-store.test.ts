import { describe, it, expect, beforeEach } from 'vitest';
import {
  setPendingAnswer,
  getPendingAnswers,
  clearPendingAnswers,
  getQuestionCount,
  setQuestionCount,
} from '../src/output/answer-store.ts';

describe('answer-store', () => {
  const sessionId = 'test-session-1';

  beforeEach(() => {
    clearPendingAnswers(sessionId);
  });

  describe('setPendingAnswer / getPendingAnswers', () => {
    it('returns undefined for unknown session', () => {
      expect(getPendingAnswers('nonexistent')).toBeUndefined();
    });

    it('stores and retrieves a single pending answer', () => {
      setPendingAnswer(sessionId, 0, 'yes');
      const answers = getPendingAnswers(sessionId);
      expect(answers).toBeDefined();
      expect(answers!.get(0)).toBe('yes');
    });

    it('stores multiple answers for same session', () => {
      setPendingAnswer(sessionId, 0, 'yes');
      setPendingAnswer(sessionId, 1, 'no');
      const answers = getPendingAnswers(sessionId);
      expect(answers!.size).toBe(2);
      expect(answers!.get(0)).toBe('yes');
      expect(answers!.get(1)).toBe('no');
    });

    it('overwrites answer for same questionIndex', () => {
      setPendingAnswer(sessionId, 0, 'yes');
      setPendingAnswer(sessionId, 0, 'no');
      expect(getPendingAnswers(sessionId)!.get(0)).toBe('no');
    });

    it('keeps sessions independent', () => {
      const other = 'other-session';
      setPendingAnswer(sessionId, 0, 'a');
      setPendingAnswer(other, 0, 'b');
      expect(getPendingAnswers(sessionId)!.get(0)).toBe('a');
      expect(getPendingAnswers(other)!.get(0)).toBe('b');
      clearPendingAnswers(other);
    });
  });

  describe('clearPendingAnswers', () => {
    it('removes pending answers for a session', () => {
      setPendingAnswer(sessionId, 0, 'yes');
      setQuestionCount(sessionId, 3);
      clearPendingAnswers(sessionId);
      expect(getPendingAnswers(sessionId)).toBeUndefined();
      expect(getQuestionCount(sessionId)).toBe(0);
    });

    it('is safe to call on nonexistent session', () => {
      expect(() => clearPendingAnswers('nonexistent')).not.toThrow();
    });
  });

  describe('getQuestionCount / setQuestionCount', () => {
    it('returns 0 for unknown session', () => {
      expect(getQuestionCount('nonexistent')).toBe(0);
    });

    it('stores and retrieves question count', () => {
      setQuestionCount(sessionId, 5);
      expect(getQuestionCount(sessionId)).toBe(5);
    });

    it('overwrites previous count', () => {
      setQuestionCount(sessionId, 3);
      setQuestionCount(sessionId, 7);
      expect(getQuestionCount(sessionId)).toBe(7);
    });
  });
});
