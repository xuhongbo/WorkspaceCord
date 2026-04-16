import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GateService as GateCoordinator } from '../src/gate-service.ts';
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

describe('GateCoordinator', () => {
  let coordinator: GateCoordinator;
  let registry: HumanGateRegistry;

  beforeEach(async () => {
    vi.useFakeTimers();
    registry = new HumanGateRegistry();
    await registry.init();
    coordinator = new GateCoordinator(registry);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('createGate', () => {
    it('creates a gate via registry', () => {
      const gate = coordinator.createGate({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Test', turn: 1,
      });

      expect(gate.status).toBe('pending');
      expect(gate.sessionId).toBe('sess-1');
    });
  });

  describe('resolveFromDiscord', () => {
    it('resolves gate with approve action', async () => {
      const gate = coordinator.createGate({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Test', turn: 1,
      });

      const result = await coordinator.resolveFromDiscord(gate.id, 'approve');

      expect(result.success).toBe(true);
      expect(result.handledByReceipt).toBe(false);
    });

    it('notifies receipt handle when one is registered', async () => {
      const gate = coordinator.createGate({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Test', turn: 1,
      });

      let resolvedAction: string | undefined;
      coordinator.registerReceiptHandle(gate.id, {
        type: 'claude',
        sessionId: 'sess-1',
        resolve: (action) => { resolvedAction = action; },
        reject: () => {},
      });

      const result = await coordinator.resolveFromDiscord(gate.id, 'approve');
      expect(result.success).toBe(true);
      expect(result.handledByReceipt).toBe(true);
      expect(resolvedAction).toBe('approve');
    });

    it('returns error for nonexistent gate', async () => {
      const result = await coordinator.resolveFromDiscord('nonexistent', 'approve');
      expect(result.success).toBe(false);
      expect(result.handledByReceipt).toBe(false);
    });

    it('returns error for already-resolved gate', async () => {
      const gate = coordinator.createGate({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Test', turn: 1,
      });
      await coordinator.resolveFromDiscord(gate.id, 'approve');

      const result = await coordinator.resolveFromDiscord(gate.id, 'reject');
      expect(result.success).toBe(false);
      expect(result.message).toBe('门控已被处理');
    });
  });

  describe('notifyTerminalResolved', () => {
    it('resolves gate with terminal action', () => {
      const gate = coordinator.createGate({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Test', turn: 1,
      });

      const result = coordinator.notifyTerminalResolved(gate.id, 'approve');
      expect(result.success).toBe(true);
      expect(result.handledByReceipt).toBe(false);
    });
  });

  describe('receipt handle rejection', () => {
    it('rejects handle when gate is not pending', () => {
      let rejected = false;
      const rejectReason: string[] = [];

      coordinator.registerReceiptHandle('nonexistent', {
        type: 'claude',
        sessionId: 'sess-1',
        resolve: () => {},
        reject: (reason) => { rejected = true; rejectReason.push(reason); },
      });

      expect(rejected).toBe(true);
    });
  });

  describe('getGate / getActiveGateForSession', () => {
    it('retrieves gate by ID', () => {
      const gate = coordinator.createGate({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Test', turn: 1,
      });

      expect(coordinator.getGate(gate.id)?.id).toBe(gate.id);
    });

    it('finds active gate for session', () => {
      const gate = coordinator.createGate({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Test', turn: 1,
      });

      const active = coordinator.getActiveGateForSession('sess-1');
      expect(active?.id).toBe(gate.id);
    });
  });

  describe('invalidateAllOnRestart', () => {
    it('invalidates all pending gates and cleans up', () => {
      coordinator.createGate({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'G1', turn: 1,
      });
      coordinator.createGate({
        sessionId: 'sess-2', provider: 'codex', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'G2', turn: 1,
      });

      const result = coordinator.invalidateAllOnRestart();
      // 统一后 invalidateAllOnRestart 返回所有 pending gate 的摘要
      // （由调用方自行决定是否有 discordMessageId 要处理）
      expect(result).toHaveLength(2);
      expect(result.every((g) => g.discordMessageId === undefined)).toBe(true);

      expect(registry.getStats().pending).toBe(0);
      expect(registry.getStats().invalidated).toBe(2);
    });
  });

  describe('archiveResolved / cleanupExpired', () => {
    it('delegates to registry', () => {
      const count = coordinator.cleanupExpired();
      expect(typeof count).toBe('number');

      const archived = coordinator.archiveResolved(10);
      expect(typeof archived).toBe('number');
    });
  });
});
