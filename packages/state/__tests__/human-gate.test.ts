import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HumanGateRegistry } from '../src/human-gate.ts';

vi.mock('@workspacecord/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspacecord/core')>();
  return {
    ...actual,
    Store: class {
      private data: any[] = [];
      async read() { return this.data.length ? this.data : null; }
      async write(d: any[]) { this.data = d; }
    },
  };
});

describe('HumanGateRegistry', () => {
  let registry: HumanGateRegistry;

  beforeEach(async () => {
    registry = new HumanGateRegistry();
    await registry.init();
  });

  describe('create', () => {
    it('creates a pending gate', () => {
      const gate = registry.create({
        sessionId: 'sess-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'Test gate',
        turn: 1,
      });

      expect(gate.status).toBe('pending');
      expect(gate.sessionId).toBe('sess-1');
      expect(gate.version).toBe(1);
      expect(gate.id).toBeDefined();
    });
  });

  describe('get / getBySession', () => {
    it('retrieves gate by ID', () => {
      const gate = registry.create({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Test', turn: 1,
      });

      const found = registry.get(gate.id);
      expect(found?.id).toBe(gate.id);
    });

    it('returns undefined for missing gate', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('returns all gates for a session', () => {
      registry.create({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'G1', turn: 1,
      });
      registry.create({
        sessionId: 'sess-1', provider: 'claude', type: 'text_question',
        isBlocking: false, supportsRemoteDecision: false, summary: 'G2', turn: 1,
      });

      expect(registry.getBySession('sess-1')).toHaveLength(2);
    });
  });

  describe('getActiveBySession', () => {
    it('returns only pending gates', () => {
      registry.create({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Active', turn: 1,
      });
      const active = registry.create({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Resolved', turn: 1,
      });
      registry.update(active.id, active.version, { status: 'approved' });

      expect(registry.getActiveBySession('sess-1')).toHaveLength(1);
    });
  });

  describe('CAS update', () => {
    it('updates gate with correct version', () => {
      const gate = registry.create({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Test', turn: 1,
      });

      const result = registry.update(gate.id, gate.version, { status: 'approved' });

      expect(result.success).toBe(true);
      expect(result.record?.status).toBe('approved');
      expect(result.record?.version).toBe(gate.version + 1);
    });

    it('rejects version conflict', () => {
      const gate = registry.create({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Test', turn: 1,
      });

      const result = registry.update(gate.id, 999, { status: 'approved' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('version_conflict');
    });

    it('rejects not found', () => {
      const result = registry.update('nonexistent', 1, { status: 'approved' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('not_found');
    });

    it('rejects invalid transition', () => {
      const gate = registry.create({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Test', turn: 1,
      });
      registry.update(gate.id, gate.version, { status: 'approved' });
      const updated = registry.get(gate.id)!;

      const result = registry.update(gate.id, updated.version, { status: 'pending' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('invalid_transition');
    });
  });

  describe('invalidateAll', () => {
    it('invalidates all pending gates', () => {
      registry.create({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'G1', turn: 1,
      });
      registry.create({
        sessionId: 'sess-2', provider: 'codex', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'G2', turn: 1,
      });

      const count = registry.invalidateAll('restart');
      expect(count).toBe(2);

      const stats = registry.getStats();
      expect(stats.pending).toBe(0);
      expect(stats.invalidated).toBe(2);
    });
  });

  describe('delete', () => {
    it('removes gate', () => {
      const gate = registry.create({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Test', turn: 1,
      });

      expect(registry.delete(gate.id)).toBe(true);
      expect(registry.get(gate.id)).toBeUndefined();
    });
  });

  describe('cleanupExpired', () => {
    it('expires old pending gates', async () => {
      vi.useFakeTimers();
      registry.create({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Old', turn: 1,
      });
      vi.advanceTimersByTime(6 * 60 * 1000); // 6 minutes

      const count = registry.cleanupExpired(5 * 60 * 1000);
      expect(count).toBe(1);
      expect(registry.getStats().expired).toBe(1);

      vi.useRealTimers();
    });
  });

  describe('archiveResolved', () => {
    it('removes old resolved gates keeping latest N', () => {
      for (let i = 0; i < 5; i++) {
        const gate = registry.create({
          sessionId: `sess-${i}`, provider: 'claude', type: 'binary_approval',
          isBlocking: true, supportsRemoteDecision: true, summary: `G${i}`, turn: 1,
        });
        registry.update(gate.id, gate.version, { status: 'approved' });
      }

      const archived = registry.archiveResolved(2);
      expect(archived).toBe(3);
      expect(registry.getAll().length).toBe(2);
    });
  });

  describe('getStats', () => {
    it('returns counts by status', () => {
      const g1 = registry.create({
        sessionId: 's1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'G1', turn: 1,
      });
      const g2 = registry.create({
        sessionId: 's2', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'G2', turn: 1,
      });
      registry.update(g1.id, g1.version, { status: 'approved' });

      const stats = registry.getStats();
      expect(stats.total).toBe(2);
      expect(stats.pending).toBe(1);
      expect(stats.approved).toBe(1);
    });
  });
});
