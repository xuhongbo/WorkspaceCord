import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('expandable-store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // We import dynamically after faking timers so the setInterval in module scope
  // uses the fake clock.
  async function loadModule() {
    vi.resetModules();
    return await import('../src/output/expandable-store.ts');
  }

  describe('storeExpandable', () => {
    it('returns a unique id starting with exp_', async () => {
      const { storeExpandable } = await loadModule();
      const id = storeExpandable('hello');
      expect(id).toMatch(/^exp_\d+$/);
    });

    it('returns incrementing ids', async () => {
      const { storeExpandable } = await loadModule();
      const id1 = storeExpandable('a');
      const id2 = storeExpandable('b');
      const num1 = parseInt(id1.replace('exp_', ''), 10);
      const num2 = parseInt(id2.replace('exp_', ''), 10);
      expect(num2).toBe(num1 + 1);
    });
  });

  describe('getExpandableContent', () => {
    it('returns undefined for unknown id', async () => {
      const { getExpandableContent } = await loadModule();
      expect(getExpandableContent('exp_999999')).toBeUndefined();
    });

    it('retrieves stored content by id', async () => {
      const { storeExpandable, getExpandableContent } = await loadModule();
      const id = storeExpandable('my content');
      expect(getExpandableContent(id)).toBe('my content');
    });
  });

  describe('TTL cleanup', () => {
    it('removes entries older than 10 minutes after cleanup runs', async () => {
      const { storeExpandable, getExpandableContent } = await loadModule();
      const id = storeExpandable('temporary');
      expect(getExpandableContent(id)).toBe('temporary');

      // Advance past the 10-minute TTL; cleanup runs every 5 min,
      // so we need to reach a 5-min interval tick where the entry is >10 min old.
      // At 10 min: 10-0 = 10, not > 10 (strict). At 15 min: 15-0 = 15 > 10.
      vi.advanceTimersByTime(15 * 60 * 1000);

      expect(getExpandableContent(id)).toBeUndefined();
    });

    it('keeps entries that are not yet expired', async () => {
      const { storeExpandable, getExpandableContent } = await loadModule();
      const id = storeExpandable('still fresh');

      // Advance 5 minutes — triggers cleanup but entry is only 5 min old (TTL=10)
      vi.advanceTimersByTime(5 * 60 * 1000);

      expect(getExpandableContent(id)).toBe('still fresh');
    });
  });
});
