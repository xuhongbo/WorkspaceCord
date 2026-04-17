import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GateService as GateManager } from '../src/gate-service.ts';
import { HumanGateRegistry } from '../src/human-gate.ts';
import { EventBus } from '@workspacecord/core';
import type { EventType } from '@workspacecord/core';

vi.mock('../../persistence.ts', () => ({
  Store: class {
    async read() { return null; }
    async write() {}
  },
}));

describe('GateManager', () => {
  let gateManager: GateManager;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
    const registry = new HumanGateRegistry();
    gateManager = new GateManager(registry, eventBus);
  });

  afterEach(() => {
    // Safety net: restore real timers in case a test that uses fake timers fails mid-way
    vi.useRealTimers();
  });

  describe('createGate', () => {
    it('creates a pending gate', () => {
      const gate = gateManager.createGate({
        sessionId: 'sess-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'Approve file deletion',
        turn: 1,
      });

      expect(gate.status).toBe('pending');
      expect(gate.sessionId).toBe('sess-1');
      expect(gate.isBlocking).toBe(true);
    });

    it('emits gate.created event', () => {
      const handler = vi.fn();
      eventBus.on('gate.created' as EventType<{ gateId: string }>, handler);

      gateManager.createGate({
        sessionId: 'sess-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'Test',
        turn: 1,
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].payload.gateId).toBeDefined();
    });
  });

  describe('bindDiscordMessage', () => {
    it('binds message ID to gate', () => {
      const gate = gateManager.createGate({
        sessionId: 'sess-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'Test',
        turn: 1,
      });

      const result = gateManager.bindDiscordMessage(gate.id, 'msg-123');
      expect(result).toBe(true);

      const updated = gateManager.getGate(gate.id);
      expect(updated?.discordMessageId).toBe('msg-123');
    });
  });

  describe('resolveGate', () => {
    it('resolves gate from discord with approve', async () => {
      const gate = gateManager.createGate({
        sessionId: 'sess-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'Test',
        turn: 1,
      });

      const result = await gateManager.resolveGateFromDiscord(gate.id, 'approve');
      expect(result.success).toBe(true);

      const updated = gateManager.getGate(gate.id);
      expect(updated?.status).toBe('approved');
      expect(updated?.resolvedBy).toBe('discord');
    });

    it('resolves gate from discord with reject', async () => {
      const gate = gateManager.createGate({
        sessionId: 'sess-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'Test',
        turn: 1,
      });

      await gateManager.resolveGateFromDiscord(gate.id, 'reject');

      const updated = gateManager.getGate(gate.id);
      expect(updated?.status).toBe('rejected');
    });

    it('returns error for already resolved gate', async () => {
      const gate = gateManager.createGate({
        sessionId: 'sess-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'Test',
        turn: 1,
      });

      await gateManager.resolveGateFromDiscord(gate.id, 'approve');
      const result = await gateManager.resolveGateFromDiscord(gate.id, 'approve');

      expect(result.success).toBe(false);
      expect(result.message).toContain('已被处理');
    });

    it('emits gate.resolved event', async () => {
      const handler = vi.fn();
      eventBus.on('gate.resolved' as EventType<{ gateId: string }>, handler);

      const gate = gateManager.createGate({
        sessionId: 'sess-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'Test',
        turn: 1,
      });

      await gateManager.resolveGateFromDiscord(gate.id, 'approve');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].payload.gateId).toBe(gate.id);
    });
  });

  describe('receipt handles', () => {
    it('resolves gate via receipt handle', async () => {
      const gate = gateManager.createGate({
        sessionId: 'sess-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'Test',
        turn: 1,
      });

      const result = await new Promise<{ action: string; source: string }>((resolve) => {
        gateManager.registerReceiptHandle(gate.id, {
          type: 'claude',
          sessionId: 'sess-1',
          resolve: (action, source) => resolve({ action, source }),
          reject: () => resolve({ action: 'rejected', source: 'timeout' }),
        });

        void gateManager.resolveGateFromDiscord(gate.id, 'approve');
      });

      expect(result.action).toBe('approve');
      expect(result.source).toBe('discord');
    });

    it('rejects receipt handle on timeout', async () => {
      vi.useFakeTimers();

      const gate = gateManager.createGate({
        sessionId: 'sess-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'Test',
        turn: 1,
      });

      const result = await new Promise<{ action: string; source: string }>((resolve) => {
        gateManager.registerReceiptHandle(gate.id, {
          type: 'claude',
          sessionId: 'sess-1',
          resolve: (action, source) => resolve({ action, source }),
          reject: (reason) => resolve({ action: 'rejected', source: reason }),
        });

        // Advance timers past the 5-minute timeout
        vi.advanceTimersByTime(6 * 60 * 1000);
      });

      vi.useRealTimers();
    });
  });

  describe('invalidateAllOnRestart', () => {
    it('invalidates all pending gates', () => {
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

      const invalidated = gateManager.invalidateAllOnRestart();
      expect(invalidated.length).toBe(2);
    });

    it('returns gates with discord message IDs for UI update', () => {
      const gate = gateManager.createGate({
        sessionId: 'sess-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'Test',
        turn: 1,
      });
      gateManager.bindDiscordMessage(gate.id, 'msg-123');

      const result = gateManager.invalidateAllOnRestart();
      const withDiscord = result.find((g) => g.gateId === gate.id);
      expect(withDiscord?.discordMessageId).toBe('msg-123');
    });
  });

  describe('getActiveGateForSession', () => {
    it('returns the active gate for a session', () => {
      const gate = gateManager.createGate({
        sessionId: 'sess-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'Test',
        turn: 1,
      });

      const active = gateManager.getActiveGateForSession('sess-1');
      expect(active?.id).toBe(gate.id);
    });

    it('returns undefined for session with no gates', () => {
      expect(gateManager.getActiveGateForSession('nonexistent')).toBeUndefined();
    });
  });

  describe('cleanup and archive', () => {
    it('cleans up expired gates (manual path when no remote timer)', () => {
      vi.useFakeTimers();

      // supportsRemoteDecision=false → 不挂 5 分钟自动超时定时器,
      // 由 cleanupExpired(manual) 负责标记为 expired
      gateManager.createGate({
        sessionId: 'sess-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: false,
        summary: 'Old gate',
        turn: 1,
      });

      vi.advanceTimersByTime(6 * 60 * 1000); // 6 minutes
      const cleaned = gateManager.cleanupExpired();
      expect(cleaned).toBe(1);

      vi.useRealTimers();
    });
  });
});
