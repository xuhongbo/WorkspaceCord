import { describe, expect, it, vi } from 'vitest';

import { GateCoordinator } from '../src/state/gate-coordinator.ts';
import { HumanGateRegistry } from '../src/state/human-gate.ts';

function createCoordinator(): {
  registry: HumanGateRegistry;
  coordinator: GateCoordinator;
} {
  const registry = new HumanGateRegistry();
  return {
    registry,
    coordinator: new GateCoordinator(registry),
  };
}

describe('GateCoordinator', () => {
  it('重启失效时会返回所有需要更新的 Discord 消息', () => {
    const { registry, coordinator } = createCoordinator();

    const gate1 = coordinator.createGate({
      sessionId: 'session-1',
      provider: 'claude',
      type: 'binary_approval',
      isBlocking: true,
      supportsRemoteDecision: true,
      summary: '门控 1',
      turn: 1,
    });
    const gate2 = coordinator.createGate({
      sessionId: 'session-2',
      provider: 'codex',
      type: 'binary_approval',
      isBlocking: true,
      supportsRemoteDecision: true,
      summary: '门控 2',
      turn: 1,
    });

    registry.update(gate1.id, gate1.version, { discordMessageId: 'msg-1' });
    const updatedGate2 = registry.get(gate2.id)!;
    registry.update(updatedGate2.id, updatedGate2.version, { discordMessageId: 'msg-2' });

    const invalidated = coordinator.invalidateAllOnRestart();

    expect(invalidated).toEqual(
      expect.arrayContaining([
        { gateId: gate1.id, discordMessageId: 'msg-1' },
        { gateId: gate2.id, discordMessageId: 'msg-2' },
      ]),
    );
    expect(invalidated).toHaveLength(2);
  });

  it('Discord 处理门控时会触发回执句柄', async () => {
    const { coordinator } = createCoordinator();
    const gate = coordinator.createGate({
      sessionId: 'session-1',
      provider: 'claude',
      type: 'binary_approval',
      isBlocking: true,
      supportsRemoteDecision: true,
      summary: '门控',
      turn: 1,
    });

    const onResolve = vi.fn();
    const onReject = vi.fn();
    coordinator.registerReceiptHandle(gate.id, {
      type: 'claude',
      sessionId: 'session-1',
      resolve: onResolve,
      reject: onReject,
    });

    const result = await coordinator.resolveFromDiscord(gate.id, 'approve');
    expect(result.success).toBe(true);
    expect(onResolve).toHaveBeenCalledWith('approve', 'discord');
    expect(onReject).not.toHaveBeenCalled();
  });

  it('终端处理门控时会触发回执句柄', () => {
    const { coordinator } = createCoordinator();
    const gate = coordinator.createGate({
      sessionId: 'session-2',
      provider: 'codex',
      type: 'binary_approval',
      isBlocking: true,
      supportsRemoteDecision: true,
      summary: '门控',
      turn: 1,
    });

    const onResolve = vi.fn();
    const onReject = vi.fn();
    coordinator.registerReceiptHandle(gate.id, {
      type: 'codex',
      sessionId: 'session-2',
      resolve: onResolve,
      reject: onReject,
    });

    const result = coordinator.notifyTerminalResolved(gate.id, 'reject');
    expect(result.success).toBe(true);
    expect(onResolve).toHaveBeenCalledWith('reject', 'terminal');
    expect(onReject).not.toHaveBeenCalled();
  });
});
