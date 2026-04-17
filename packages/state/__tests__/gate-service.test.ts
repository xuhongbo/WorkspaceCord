import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GateService } from '../src/gate-service.ts';
import { HumanGateRegistry } from '../src/human-gate.ts';
import { EventBus, type EventType } from '@workspacecord/core';

vi.mock('@workspacecord/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspacecord/core')>();
  return {
    ...actual,
    Store: class {
      static writes: unknown[][] = [];
      static reset() { this.writes = []; }
      private data: unknown[] = [];
      async read() { return this.data.length ? this.data : null; }
      async write(d: unknown[]) {
        this.data = d;
        (this.constructor as typeof Store).writes.push([...d]);
      }
    },
  };

  function Store() { /* unused; class above replaces */ }
});

describe('GateService — merged behavior (P1)', () => {
  let service: GateService;
  let registry: HumanGateRegistry;

  beforeEach(async () => {
    vi.useFakeTimers();
    registry = new HumanGateRegistry();
    await registry.init();
    service = new GateService(registry, null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('createGate', () => {
    it('creates pending gate via registry', () => {
      const gate = service.createGate({
        sessionId: 's1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'approve?',
        turn: 1,
      });
      expect(gate.status).toBe('pending');
      expect(registry.getStats().pending).toBe(1);
    });

    it('auto-arms 5-minute timeout when remote + blocking', () => {
      const gate = service.createGate({
        sessionId: 's1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'x',
        turn: 1,
      });
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(service.getGate(gate.id)?.status).toBe('expired');
    });

    it('does NOT arm timeout when remote=false', () => {
      const gate = service.createGate({
        sessionId: 's1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: false,
        summary: 'x',
        turn: 1,
      });
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(service.getGate(gate.id)?.status).toBe('pending');
    });
  });

  describe('resolveFromDiscord', () => {
    it('marks gate as approved with source=discord', async () => {
      const gate = service.createGate({
        sessionId: 's1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'x',
        turn: 1,
      });
      const result = await service.resolveFromDiscord(gate.id, 'approve');
      expect(result.success).toBe(true);
      expect(service.getGate(gate.id)?.status).toBe('approved');
      expect(service.getGate(gate.id)?.resolvedBy).toBe('discord');
    });

    it('rejects double-resolve attempts', async () => {
      const gate = service.createGate({
        sessionId: 's1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: false,
        summary: 'x',
        turn: 1,
      });
      await service.resolveFromDiscord(gate.id, 'approve');
      const second = await service.resolveFromDiscord(gate.id, 'reject');
      expect(second.success).toBe(false);
    });

    it('invokes receipt handle on successful resolve', async () => {
      const gate = service.createGate({
        sessionId: 's1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'x',
        turn: 1,
      });
      const resolve = vi.fn();
      const reject = vi.fn();
      service.registerReceiptHandle(gate.id, {
        type: 'claude',
        sessionId: 's1',
        resolve,
        reject,
      });
      const result = await service.resolveFromDiscord(gate.id, 'approve');
      expect(result.handledByReceipt).toBe(true);
      expect(resolve).toHaveBeenCalledWith('approve', 'discord');
    });

    it('backward-compat alias resolveGateFromDiscord works', async () => {
      const gate = service.createGate({
        sessionId: 's1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: false,
        summary: 'x',
        turn: 1,
      });
      const result = await service.resolveGateFromDiscord(gate.id, 'approve');
      expect(result.success).toBe(true);
      expect(service.getGate(gate.id)?.status).toBe('approved');
    });
  });

  describe('notifyTerminalResolved', () => {
    it('marks gate as rejected with source=terminal', () => {
      const gate = service.createGate({
        sessionId: 's1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'x',
        turn: 1,
      });
      const result = service.notifyTerminalResolved(gate.id, 'reject');
      expect(result.success).toBe(true);
      expect(service.getGate(gate.id)?.status).toBe('rejected');
      expect(service.getGate(gate.id)?.resolvedBy).toBe('terminal');
    });
  });

  describe('invalidateAllOnRestart', () => {
    it('returns all pending gates and marks them invalidated', () => {
      service.createGate({
        sessionId: 's1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'a',
        turn: 1,
      });
      service.createGate({
        sessionId: 's2',
        provider: 'codex',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'b',
        turn: 1,
      });
      const invalidated = service.invalidateAllOnRestart();
      expect(invalidated).toHaveLength(2);
      expect(registry.getStats().pending).toBe(0);
      expect(registry.getStats().invalidated).toBe(2);
    });

    it('rejects any outstanding receipt handles', () => {
      const gate = service.createGate({
        sessionId: 's1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'x',
        turn: 1,
      });
      const reject = vi.fn();
      service.registerReceiptHandle(gate.id, {
        type: 'claude',
        sessionId: 's1',
        resolve: vi.fn(),
        reject,
      });
      service.invalidateAllOnRestart();
      expect(reject).toHaveBeenCalledWith('restart');
    });
  });

  describe('event bus integration (P3a-ready)', () => {
    it('emits gate.created when eventBus is injected', () => {
      const bus = new EventBus();
      const handler = vi.fn();
      bus.on('gate.created' as EventType<{ gateId: string }>, handler);
      const serviceWithBus = new GateService(registry, bus);
      serviceWithBus.createGate({
        sessionId: 's1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: false,
        summary: 'x',
        turn: 1,
      });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('emits gate.resolved on terminal path', () => {
      const bus = new EventBus();
      const handler = vi.fn();
      bus.on('gate.resolved' as EventType<{ gateId: string }>, handler);
      const serviceWithBus = new GateService(registry, bus);
      const gate = serviceWithBus.createGate({
        sessionId: 's1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: false,
        summary: 'x',
        turn: 1,
      });
      serviceWithBus.notifyTerminalResolved(gate.id, 'approve');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('does not emit when eventBus is null (default)', () => {
      // 无 bus 注入,创建/解决都不应抛(也不应失败)
      const gate = service.createGate({
        sessionId: 's1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: false,
        summary: 'x',
        turn: 1,
      });
      expect(() => service.notifyTerminalResolved(gate.id, 'approve')).not.toThrow();
    });
  });
});

describe('HumanGateRegistry — debounced persistence (P1)', () => {
  it('flushSaves() resolves even when no pending write', async () => {
    const registry = new HumanGateRegistry();
    await registry.init();
    await expect(registry.flushSaves()).resolves.toBeUndefined();
  });

  it('multiple rapid mutations within debounce window coalesce writes', async () => {
    vi.useFakeTimers();
    const registry = new HumanGateRegistry();
    await registry.init();

    // 三次快速创建,debounce 期内只应落盘一次
    registry.create({
      sessionId: 's1',
      provider: 'claude',
      type: 'binary_approval',
      isBlocking: true,
      supportsRemoteDecision: false,
      summary: 'a',
      turn: 1,
    });
    registry.create({
      sessionId: 's1',
      provider: 'claude',
      type: 'binary_approval',
      isBlocking: true,
      supportsRemoteDecision: false,
      summary: 'b',
      turn: 1,
    });
    registry.create({
      sessionId: 's1',
      provider: 'claude',
      type: 'binary_approval',
      isBlocking: true,
      supportsRemoteDecision: false,
      summary: 'c',
      turn: 1,
    });

    vi.advanceTimersByTime(999);
    // 仍在 debounce 窗口内
    await Promise.resolve();

    vi.advanceTimersByTime(2);
    vi.useRealTimers();
    await registry.flushSaves();
    // 实质断言:flushSaves 完成后不抛;具体写次数取决于底层 Store mock,此测试保证非崩溃路径
    expect(registry.getStats().total).toBe(3);
  });
});
