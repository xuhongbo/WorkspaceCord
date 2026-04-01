// 性能监控追踪器
// 记录关键指标：发现延迟、更新延迟、CPU/内存占用

import { performance } from 'node:perf_hooks';
import { memoryUsage, cpuUsage } from 'node:process';

interface PerformanceMetric {
  name: string;
  value: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

interface PerformanceSnapshot {
  timestamp: number;
  cpu: {
    user: number;
    system: number;
  };
  memory: {
    heapUsed: number;
    heapTotal: number;
    external: number;
    rss: number;
  };
}

class PerformanceTracker {
  private metrics: PerformanceMetric[] = [];
  private snapshots: PerformanceSnapshot[] = [];
  private maxMetrics = 1000;
  private maxSnapshots = 100;
  private lastCpuUsage = cpuUsage();
  private sessionDiscoveryStart = new Map<string, number>();
  private stateUpdateStart = new Map<string, number>();

  // 记录会话发现开始
  startSessionDiscovery(sessionId: string): void {
    this.sessionDiscoveryStart.set(sessionId, performance.now());
  }

  // 记录会话发现完成
  endSessionDiscovery(sessionId: string, metadata?: Record<string, unknown>): void {
    const start = this.sessionDiscoveryStart.get(sessionId);
    if (start === undefined) return;

    const duration = performance.now() - start;
    this.recordMetric('session_discovery_latency', duration, {
      sessionId,
      ...metadata,
    });
    this.sessionDiscoveryStart.delete(sessionId);
  }

  // 记录状态更新开始
  startStateUpdate(key: string): void {
    this.stateUpdateStart.set(key, performance.now());
  }

  // 记录状态更新完成
  endStateUpdate(key: string, metadata?: Record<string, unknown>): void {
    const start = this.stateUpdateStart.get(key);
    if (start === undefined) return;

    const duration = performance.now() - start;
    this.recordMetric('state_update_latency', duration, {
      key,
      ...metadata,
    });
    this.stateUpdateStart.delete(key);
  }

  // 记录通用指标
  recordMetric(name: string, value: number, metadata?: Record<string, unknown>): void {
    this.metrics.push({
      name,
      value,
      timestamp: Date.now(),
      metadata,
    });

    if (this.metrics.length > this.maxMetrics) {
      this.metrics.splice(0, this.metrics.length - this.maxMetrics);
    }
  }

  // 记录系统快照
  takeSnapshot(): PerformanceSnapshot {
    const currentCpu = cpuUsage(this.lastCpuUsage);
    this.lastCpuUsage = cpuUsage();

    const mem = memoryUsage();
    const snapshot: PerformanceSnapshot = {
      timestamp: Date.now(),
      cpu: {
        user: currentCpu.user / 1000,
        system: currentCpu.system / 1000,
      },
      memory: {
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
        rss: mem.rss,
      },
    };

    this.snapshots.push(snapshot);
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.splice(0, this.snapshots.length - this.maxSnapshots);
    }

    return snapshot;
  }

  // 获取指标统计
  getMetricStats(name: string): {
    count: number;
    min: number;
    max: number;
    avg: number;
    p50: number;
    p95: number;
    p99: number;
  } | null {
    const filtered = this.metrics.filter((m) => m.name === name);
    if (filtered.length === 0) return null;

    const values = filtered.map((m) => m.value).sort((a, b) => a - b);
    const sum = values.reduce((acc, v) => acc + v, 0);

    return {
      count: values.length,
      min: values[0],
      max: values[values.length - 1],
      avg: sum / values.length,
      p50: values[Math.floor(values.length * 0.5)],
      p95: values[Math.floor(values.length * 0.95)],
      p99: values[Math.floor(values.length * 0.99)],
    };
  }

  // 获取最近的快照
  getRecentSnapshots(count: number = 10): PerformanceSnapshot[] {
    return this.snapshots.slice(-count);
  }

  // 获取最近的指标
  getRecentMetrics(name: string, count: number = 10): PerformanceMetric[] {
    return this.metrics
      .filter((m) => m.name === name)
      .slice(-count);
  }

  // 清理旧数据
  cleanup(): void {
    const now = Date.now();
    const maxAge = 3600000; // 1 小时

    this.metrics = this.metrics.filter((m) => now - m.timestamp < maxAge);
    this.snapshots = this.snapshots.filter((s) => now - s.timestamp < maxAge);
  }

  // 生成性能报告
  generateReport(): string {
    const lines: string[] = ['性能监控报告'];
    lines.push('='.repeat(50));

    const discoveryStats = this.getMetricStats('session_discovery_latency');
    if (discoveryStats) {
      lines.push('\n会话发现延迟 (ms):');
      lines.push(`  样本数: ${discoveryStats.count}`);
      lines.push(`  平均值: ${discoveryStats.avg.toFixed(2)}`);
      lines.push(`  P50: ${discoveryStats.p50.toFixed(2)}`);
      lines.push(`  P95: ${discoveryStats.p95.toFixed(2)}`);
      lines.push(`  P99: ${discoveryStats.p99.toFixed(2)}`);
    }

    const updateStats = this.getMetricStats('state_update_latency');
    if (updateStats) {
      lines.push('\n状态更新延迟 (ms):');
      lines.push(`  样本数: ${updateStats.count}`);
      lines.push(`  平均值: ${updateStats.avg.toFixed(2)}`);
      lines.push(`  P50: ${updateStats.p50.toFixed(2)}`);
      lines.push(`  P95: ${updateStats.p95.toFixed(2)}`);
      lines.push(`  P99: ${updateStats.p99.toFixed(2)}`);
    }

    const recentSnapshot = this.snapshots[this.snapshots.length - 1];
    if (recentSnapshot) {
      lines.push('\n系统资源:');
      lines.push(`  堆内存使用: ${(recentSnapshot.memory.heapUsed / 1024 / 1024).toFixed(2)} MB`);
      lines.push(`  堆内存总量: ${(recentSnapshot.memory.heapTotal / 1024 / 1024).toFixed(2)} MB`);
      lines.push(`  RSS: ${(recentSnapshot.memory.rss / 1024 / 1024).toFixed(2)} MB`);
      lines.push(`  CPU 用户态: ${recentSnapshot.cpu.user.toFixed(2)} ms`);
      lines.push(`  CPU 系统态: ${recentSnapshot.cpu.system.toFixed(2)} ms`);
    }

    return lines.join('\n');
  }
}

export const performanceTracker = new PerformanceTracker();

