// 人工门控注册表单元测试
// 重点验证 CAS 更新逻辑的并发安全性

import { describe, it, expect, beforeEach } from 'vitest';
import { HumanGateRegistry } from '../src/state/human-gate.js';
import type { HumanGateRecord } from '../src/state/human-gate.js';

describe('HumanGateRegistry', () => {
  let registry: HumanGateRegistry;

  beforeEach(() => {
    registry = new HumanGateRegistry();
  });

  describe('create', () => {
    it('应该创建新门控记录', () => {
      const gate = registry.create({
        sessionId: 'session-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: '测试门控',
        turn: 1,
      });

      expect(gate.id).toBeDefined();
      expect(gate.version).toBe(1);
      expect(gate.status).toBe('pending');
      expect(gate.createdAt).toBeGreaterThan(0);
    });

    it('应该为每个门控生成唯一 ID', () => {
      const gate1 = registry.create({
        sessionId: 'session-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: '门控 1',
        turn: 1,
      });

      const gate2 = registry.create({
        sessionId: 'session-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: '门控 2',
        turn: 1,
      });

      expect(gate1.id).not.toBe(gate2.id);
    });
  });

  describe('get', () => {
    it('应该返回存在的门控记录', () => {
      const created = registry.create({
        sessionId: 'session-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: '测试门控',
        turn: 1,
      });

      const retrieved = registry.get(created.id);
      expect(retrieved).toEqual(created);
    });

    it('应该对不存在的门控返回 undefined', () => {
      const result = registry.get('non-existent-id');
      expect(result).toBeUndefined();
    });
  });

  describe('getBySession', () => {
    it('应该返回指定会话的所有门控', () => {
      registry.create({
        sessionId: 'session-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: '门控 1',
        turn: 1,
      });

      registry.create({
        sessionId: 'session-1',
        provider: 'claude',
        type: 'text_question',
        isBlocking: true,
        supportsRemoteDecision: false,
        summary: '门控 2',
        turn: 1,
      });

      registry.create({
        sessionId: 'session-2',
        provider: 'codex',
        type: 'notification',
        isBlocking: false,
        supportsRemoteDecision: false,
        summary: '门控 3',
        turn: 1,
      });

      const session1Gates = registry.getBySession('session-1');
      expect(session1Gates).toHaveLength(2);
      expect(session1Gates.every((g) => g.sessionId === 'session-1')).toBe(true);
    });
  });

  describe('getActiveBySession', () => {
    it('应该只返回 pending 状态的门控', () => {
      const gate1 = registry.create({
        sessionId: 'session-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: '门控 1',
        turn: 1,
      });

      const gate2 = registry.create({
        sessionId: 'session-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: '门控 2',
        turn: 1,
      });

      // 解决第一个门控
      registry.update(gate1.id, gate1.version, {
        status: 'approved',
        resolvedAt: Date.now(),
        resolvedBy: 'discord',
        resolvedAction: 'approve',
      });

      const active = registry.getActiveBySession('session-1');
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(gate2.id);
    });
  });

  describe('CAS update', () => {
    it('应该在版本号匹配时成功更新', () => {
      const gate = registry.create({
        sessionId: 'session-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: '测试门控',
        turn: 1,
      });

      const result = registry.update(gate.id, gate.version, {
        status: 'approved',
        resolvedAt: Date.now(),
        resolvedBy: 'discord',
        resolvedAction: 'approve',
      });

      expect(result.success).toBe(true);
      expect(result.record?.status).toBe('approved');
      expect(result.record?.version).toBe(2);
    });

    it('应该在版本号不匹配时失败', () => {
      const gate = registry.create({
        sessionId: 'session-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: '测试门控',
        turn: 1,
      });

      // 第一次更新成功
      const result1 = registry.update(gate.id, gate.version, {
        status: 'approved',
        resolvedAt: Date.now(),
        resolvedBy: 'discord',
        resolvedAction: 'approve',
      });
      expect(result1.success).toBe(true);

      // 第二次使用旧版本号更新应该失败
      const result2 = registry.update(gate.id, gate.version, {
        status: 'rejected',
        resolvedAt: Date.now(),
        resolvedBy: 'terminal',
        resolvedAction: 'reject',
      });

      expect(result2.success).toBe(false);
      expect(result2.error).toBe('version_conflict');
    });

    it('应该在门控不存在时失败', () => {
      const result = registry.update('non-existent-id', 1, {
        status: 'approved',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('not_found');
    });

    it('应该拒绝非法状态转换', () => {
      const gate = registry.create({
        sessionId: 'session-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: '测试门控',
        turn: 1,
      });

      // 先解决门控
      const result1 = registry.update(gate.id, gate.version, {
        status: 'approved',
        resolvedAt: Date.now(),
        resolvedBy: 'discord',
        resolvedAction: 'approve',
      });
      expect(result1.success).toBe(true);

      // 尝试从终态转换到其他状态应该失败
      const updated = result1.record!;
      const result2 = registry.update(updated.id, updated.version, {
        status: 'rejected',
      });

      expect(result2.success).toBe(false);
      expect(result2.error).toBe('invalid_transition');
    });
  });

  describe('并发安全性测试', () => {
    it('应该保证只有一个并发更新成功', () => {
      const gate = registry.create({
        sessionId: 'session-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: '测试门控',
        turn: 1,
      });

      // 模拟两个并发操作同时读取版本号
      const version = gate.version;

      // 第一个操作（Discord）
      const result1 = registry.update(gate.id, version, {
        status: 'approved',
        resolvedAt: Date.now(),
        resolvedBy: 'discord',
        resolvedAction: 'approve',
      });

      // 第二个操作（终端）使用相同的版本号
      const result2 = registry.update(gate.id, version, {
        status: 'rejected',
        resolvedAt: Date.now(),
        resolvedBy: 'terminal',
        resolvedAction: 'reject',
      });

      // 只有一个应该成功
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(false);
      expect(result2.error).toBe('version_conflict');

      // 最终状态应该是第一个操作的结果
      const final = registry.get(gate.id);
      expect(final?.status).toBe('approved');
      expect(final?.resolvedBy).toBe('discord');
    });
  });

  describe('invalidateAll', () => {
    it('应该失效所有 pending 状态的门控', () => {
      const gate1 = registry.create({
        sessionId: 'session-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: '门控 1',
        turn: 1,
      });

      const gate2 = registry.create({
        sessionId: 'session-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: '门控 2',
        turn: 1,
      });

      // 解决第一个门控
      registry.update(gate1.id, gate1.version, {
        status: 'approved',
        resolvedAt: Date.now(),
        resolvedBy: 'discord',
        resolvedAction: 'approve',
      });

      const count = registry.invalidateAll('restart');

      expect(count).toBe(1); // 只有 gate2 应该被失效
      expect(registry.get(gate2.id)?.status).toBe('invalidated');
      expect(registry.get(gate2.id)?.resolvedBy).toBe('restart');
      expect(registry.get(gate1.id)?.status).toBe('approved'); // gate1 不受影响
    });
  });

  describe('cleanupExpired', () => {
    it('应该清理超时的门控', () => {
      const gate = registry.create({
        sessionId: 'session-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: '测试门控',
        turn: 1,
      });

      // 模拟超时（设置很短的超时时间）
      const count = registry.cleanupExpired(0);

      expect(count).toBe(1);
      expect(registry.get(gate.id)?.status).toBe('expired');
      expect(registry.get(gate.id)?.resolvedBy).toBe('timeout');
    });

    it('应该不影响已解决的门控', () => {
      const gate = registry.create({
        sessionId: 'session-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: '测试门控',
        turn: 1,
      });

      registry.update(gate.id, gate.version, {
        status: 'approved',
        resolvedAt: Date.now(),
        resolvedBy: 'discord',
        resolvedAction: 'approve',
      });

      const count = registry.cleanupExpired(0);

      expect(count).toBe(0);
      expect(registry.get(gate.id)?.status).toBe('approved');
    });
  });

  describe('archiveResolved', () => {
    it('应该归档超出限制的已解决门控', () => {
      // 创建 5 个门控并解决它们
      for (let i = 0; i < 5; i++) {
        const gate = registry.create({
          sessionId: 'session-1',
          provider: 'claude',
          type: 'binary_approval',
          isBlocking: true,
          supportsRemoteDecision: true,
          summary: `门控 ${i}`,
          turn: 1,
        });

        registry.update(gate.id, gate.version, {
          status: 'approved',
          resolvedAt: Date.now() + i, // 确保时间戳不同
          resolvedBy: 'discord',
          resolvedAction: 'approve',
        });
      }

      const archived = registry.archiveResolved(3);

      expect(archived).toBe(2); // 应该归档 2 个
      expect(registry.getAll()).toHaveLength(3); // 保留 3 个
    });

    it('应该保留最近的门控', () => {
      const gates = [];
      for (let i = 0; i < 3; i++) {
        const gate = registry.create({
          sessionId: 'session-1',
          provider: 'claude',
          type: 'binary_approval',
          isBlocking: true,
          supportsRemoteDecision: true,
          summary: `门控 ${i}`,
          turn: 1,
        });

        registry.update(gate.id, gate.version, {
          status: 'approved',
          resolvedAt: Date.now() + i * 1000,
          resolvedBy: 'discord',
          resolvedAction: 'approve',
        });

        gates.push(gate);
      }

      registry.archiveResolved(1);

      const remaining = registry.getAll();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(gates[2].id); // 应该保留最后一个
    });
  });

  describe('getStats', () => {
    it('应该返回正确的统计信息', () => {
      const gate1 = registry.create({
        sessionId: 'session-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: '门控 1',
        turn: 1,
      });

      const gate2 = registry.create({
        sessionId: 'session-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: '门控 2',
        turn: 1,
      });

      registry.update(gate1.id, gate1.version, {
        status: 'approved',
        resolvedAt: Date.now(),
        resolvedBy: 'discord',
        resolvedAction: 'approve',
      });

      const stats = registry.getStats();

      expect(stats.total).toBe(2);
      expect(stats.pending).toBe(1);
      expect(stats.approved).toBe(1);
      expect(stats.rejected).toBe(0);
    });
  });
});



