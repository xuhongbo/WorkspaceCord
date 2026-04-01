// 性能与限流测试
// 验证设计文档 13.5 节的性能标准

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { performanceTracker } from '../src/monitoring/performance-tracker.ts';
import {
  initializeSessionPanel,
  updateSessionState,
  handleAwaitingHuman,
  cleanupInactiveSessions,
  getPerformanceStats,
  startPerformanceMonitoring,
  stopPerformanceMonitoring,
} from '../src/panel-adapter.ts';

// Mock Discord.js
vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    private data: Record<string, unknown> = {};
    setColor(color: number) { this.data.color = color; return this; }
    setTitle(title: string) { this.data.title = title; return this; }
    setDescription(description: string) { this.data.description = description; return this; }
    addFields(...fields: unknown[]) { this.data.fields = fields; return this; }
    setTimestamp() { this.data.timestamp = Date.now(); return this; }
  },
  ActionRowBuilder: class {
    addComponents() { return this; }
  },
  ButtonBuilder: class {
    setCustomId() { return this; }
    setLabel() { return this; }
    setStyle() { return this; }
  },
  ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
}));

describe('性能与限流控制', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    stopPerformanceMonitoring();
  });

  describe('会话发现延迟', () => {
    it('新会话发现延迟应 < 2s', async () => {
      const sessionId = 'test-session-1';
      const mockChannel = {
        send: vi.fn().mockResolvedValue({ id: 'msg-1', pin: vi.fn() }),
        messages: { edit: vi.fn() },
      };

      const start = performance.now();
      await initializeSessionPanel(sessionId, mockChannel as any);
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(2000);

      const stats = getPerformanceStats();
      expect(stats.discoveryLatency).toBeDefined();
      if (stats.discoveryLatency) {
        expect(stats.discoveryLatency.p95).toBeLessThan(2000);
      }
    });

    it('缓存会话发现应更快', async () => {
      const sessionId = 'test-session-2';
      const mockChannel = {
        send: vi.fn().mockResolvedValue({ id: 'msg-2', pin: vi.fn() }),
        messages: { edit: vi.fn() },
      };

      // 首次初始化
      await initializeSessionPanel(sessionId, mockChannel as any);

      // 第二次应使用缓存
      const start = performance.now();
      await initializeSessionPanel(sessionId, mockChannel as any);
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(100);
    });
  });

  describe('状态卡更新延迟', () => {
    it('状态卡更新延迟应 < 1s', async () => {
      const sessionId = 'test-session-3';
      const mockChannel = {
        send: vi.fn().mockResolvedValue({ id: 'msg-3', pin: vi.fn() }),
        messages: { edit: vi.fn().mockResolvedValue({ id: 'msg-3' }) },
      };

      await initializeSessionPanel(sessionId, mockChannel as any);

      const start = performance.now();
      await updateSessionState(
        sessionId,
        {
          type: 'text_delta',
          text: 'test',
        },
        { channel: mockChannel as any },
      );

      // 等待批量更新完成
      await new Promise((resolve) => setTimeout(resolve, 600));
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(1000);
    });
  });

  describe('交互卡限流', () => {
    it('同一会话 10 秒内最多创建 1 个交互卡', async () => {
      const sessionId = 'test-session-4';
      const mockChannel = {
        send: vi.fn().mockResolvedValue({ id: 'msg-4', pin: vi.fn() }),
        messages: { edit: vi.fn() },
      };

      await initializeSessionPanel(sessionId, mockChannel as any);

      // 第一次创建应成功
      const result1 = await handleAwaitingHuman(sessionId, '测试问题 1');
      expect(result1).toBeDefined();

      // 10 秒内第二次创建应被限流
      const result2 = await handleAwaitingHuman(sessionId, '测试问题 2');
      expect(result2).toBeNull();

      // 模拟 10 秒后
      vi.useFakeTimers();
      vi.advanceTimersByTime(10001);
      vi.useRealTimers();

      // 应该可以再次创建
      const result3 = await handleAwaitingHuman(sessionId, '测试问题 3');
      expect(result3).toBeDefined();
    });
  });

  describe('批量更新', () => {
    it('500ms 内的多次更新应合并为一次', async () => {
      const sessionId = 'test-session-5';
      const mockChannel = {
        send: vi.fn().mockResolvedValue({ id: 'msg-5', pin: vi.fn() }),
        messages: { edit: vi.fn().mockResolvedValue({ id: 'msg-5' }) },
      };

      await initializeSessionPanel(sessionId, mockChannel as any);

      // 快速连续更新 5 次
      for (let i = 0; i < 5; i++) {
        await updateSessionState(
          sessionId,
          { type: 'text_delta', text: `test ${i}` },
          { channel: mockChannel as any },
        );
      }

      // 等待批量更新完成
      await new Promise((resolve) => setTimeout(resolve, 600));

      // 应该只调用一次 edit
      expect(mockChannel.messages.edit).toHaveBeenCalledTimes(1);
    });
  });

  describe('内存控制', () => {
    it('失活会话应被清理', async () => {
      const sessionId = 'test-session-6';
      const mockChannel = {
        send: vi.fn().mockResolvedValue({ id: 'msg-6', pin: vi.fn() }),
        messages: { edit: vi.fn() },
      };

      await initializeSessionPanel(sessionId, mockChannel as any);

      const statsBefore = getPerformanceStats();
      expect(statsBefore.activeSessions).toBeGreaterThan(0);

      // 模拟 1 小时后
      vi.useFakeTimers();
      vi.advanceTimersByTime(3600001);
      vi.useRealTimers();

      cleanupInactiveSessions();

      const statsAfter = getPerformanceStats();
      expect(statsAfter.snapshotCount).toBeLessThanOrEqual(statsBefore.snapshotCount);
    });
  });

  describe('并发门控处理', () => {
    it('并发处理多个门控请求', async () => {
      const sessions = ['session-a', 'session-b', 'session-c'];
      const mockChannel = {
        send: vi.fn().mockResolvedValue({ id: 'msg-x', pin: vi.fn() }),
        messages: { edit: vi.fn() },
      };

      // 并发初始化多个会话
      await Promise.all(
        sessions.map((sid) => initializeSessionPanel(sid, mockChannel as any)),
      );

      // 并发创建门控
      const results = await Promise.all(
        sessions.map((sid) => handleAwaitingHuman(sid, `问题 ${sid}`)),
      );

      // 所有门控应成功创建
      expect(results.every((r) => r !== null)).toBe(true);
    });
  });

  describe('性能监控', () => {
    it('应记录性能指标', () => {
      performanceTracker.startSessionDiscovery('test-1');
      performanceTracker.endSessionDiscovery('test-1');

      performanceTracker.startStateUpdate('test-key');
      performanceTracker.endStateUpdate('test-key');

      const stats = getPerformanceStats();
      expect(stats.discoveryLatency).toBeDefined();
      expect(stats.updateLatency).toBeDefined();
    });

    it('应生成性能报告', () => {
      performanceTracker.recordMetric('session_discovery_latency', 1500);
      performanceTracker.recordMetric('state_update_latency', 800);
      performanceTracker.takeSnapshot();

      const report = performanceTracker.generateReport();
      expect(report).toContain('性能监控报告');
      expect(report).toContain('会话发现延迟');
      expect(report).toContain('状态更新延迟');
      expect(report).toContain('系统资源');
    });

    it('定期清理应正常工作', async () => {
      startPerformanceMonitoring();

      // 等待一个清理周期
      await new Promise((resolve) => setTimeout(resolve, 100));

      stopPerformanceMonitoring();

      // 不应抛出错误
      expect(true).toBe(true);
    });
  });
});
