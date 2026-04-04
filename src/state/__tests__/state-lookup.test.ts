import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GateManager } from '../gate-manager.ts';
import { HumanGateRegistry } from '../human-gate.ts';
import { StateLookup } from '../state-lookup.ts';
import { EventBus } from '../../core/event-bus.ts';

vi.mock('../../persistence.ts', () => ({
  Store: class {
    async read() { return null; }
    async write() {}
  },
}));

describe('StateLookup', () => {
  let stateLookup: StateLookup;
  let gateManager: GateManager;

  beforeEach(() => {
    const eventBus = new EventBus();
    const registry = new HumanGateRegistry();
    gateManager = new GateManager(registry, eventBus);
    stateLookup = new StateLookup(gateManager);
  });

  describe('getActiveGates', () => {
    it('returns all pending gates', () => {
      gateManager.createGate({
        sessionId: 'sess-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'Gate 1',
        turn: 1,
      });
      gateManager.createGate({
        sessionId: 'sess-2',
        provider: 'codex',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'Gate 2',
        turn: 1,
      });

      const active = stateLookup.getActiveGates();
      expect(active.length).toBe(2);
      expect(active.every((g) => g.status === 'pending')).toBe(true);
    });

    it('excludes resolved gates', () => {
      const gate = gateManager.createGate({
        sessionId: 'sess-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'Test',
        turn: 1,
      });

      void gateManager.resolveGateFromDiscord(gate.id, 'approve');

      const active = stateLookup.getActiveGates();
      expect(active.length).toBe(0);
    });
  });

  describe('getGatesBySession', () => {
    it('returns all gates for a session', () => {
      gateManager.createGate({
        sessionId: 'sess-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'Gate 1',
        turn: 1,
      });
      gateManager.createGate({
        sessionId: 'sess-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'Gate 2',
        turn: 2,
      });
      gateManager.createGate({
        sessionId: 'sess-2',
        provider: 'codex',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'Other session',
        turn: 1,
      });

      const gates = stateLookup.getGatesBySession('sess-1');
      expect(gates.length).toBe(2);
      expect(gates.every((g) => g.sessionId === 'sess-1')).toBe(true);
    });

    it('returns empty array for unknown session', () => {
      expect(stateLookup.getGatesBySession('nonexistent')).toEqual([]);
    });
  });

  describe('getGateStats', () => {
    it('returns aggregated statistics', () => {
      gateManager.createGate({
        sessionId: 'sess-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'Pending',
        turn: 1,
      });
      const gate2 = gateManager.createGate({
        sessionId: 'sess-2',
        provider: 'codex',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'Approved',
        turn: 1,
      });
      const gate3 = gateManager.createGate({
        sessionId: 'sess-3',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'Rejected',
        turn: 1,
      });

      void gateManager.resolveGateFromDiscord(gate2.id, 'approve');
      void gateManager.resolveGateFromDiscord(gate3.id, 'reject');

      const stats = stateLookup.getGateStats();
      expect(stats).toEqual({
        total: 3,
        pending: 1,
        approved: 1,
        rejected: 1,
        expired: 0,
        invalidated: 0,
      });
    });
  });

  describe('getSessionState', () => {
    it('returns full session state summary', () => {
      gateManager.createGate({
        sessionId: 'sess-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'Active gate',
        turn: 2,
      });

      const state = stateLookup.getSessionState('sess-1');
      expect(state.sessionId).toBe('sess-1');
      expect(state.activeGateCount).toBe(1);
      expect(state.totalGateCount).toBe(1);
      expect(state.hasPendingGates).toBe(true);
    });

    it('returns zero counts for unknown session', () => {
      const state = stateLookup.getSessionState('nonexistent');
      expect(state.sessionId).toBe('nonexistent');
      expect(state.activeGateCount).toBe(0);
      expect(state.hasPendingGates).toBe(false);
    });
  });
});
