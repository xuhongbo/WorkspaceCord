# 性能与限流控制实现总结

日期：2026-03-31
状态：已实现核心功能
参考：设计文档第 13.5 节

## 已实现功能

### 1. 性能监控追踪器 (`src/monitoring/performance-tracker.ts`)

创建了完整的性能监控模块，包括：

- **会话发现延迟追踪**：记录从发现到注册完成的时间
- **状态更新延迟追踪**：记录状态卡更新的响应时间
- **系统资源快照**：定期采集 CPU 和内存使用情况
- **指标统计**：计算 P50、P95、P99 百分位数
- **性能报告生成**：生成可读的性能分析报告

### 2. Discord API 优化 (`src/panel-adapter.ts`)

实现了以下优化：

#### 批量更新（500ms 合并）
```typescript
const BATCH_UPDATE_DELAY_MS = 500;
const pendingUpdates = new Map<string, {
  snapshot: SessionStateSnapshot;
  timer: NodeJS.Timeout;
}>();
```

- 500ms 内的多次状态更新合并为一次 Discord API 调用
- 减少 API 调用频率，避免触发 rate limit

#### 交互卡限流（10 秒冷却）
```typescript
const INTERACTION_CARD_COOLDOWN_MS = 10000;
const lastInteractionCardTime = new Map<string, number>();
```

- 同一会话 10 秒内最多创建 1 个交互卡
- 防止短时间内创建过多交互卡导致 rate limit

#### 使用 PATCH 而非 DELETE + POST (`src/discord/status-card.ts`)
```typescript
// 使用 PATCH 更新现有消息，而非删除后重建
const msg = await this.channel.messages.edit(this.messageId, {
  embeds: [embed],
  components: [],
});
```

- 减少 API 调用次数（1 次 vs 2 次）
- 降低 rate limit 风险

#### Rate Limit 降级
```typescript
try {
  await components.statusCard.update(snapshot.state, {...});
} catch (error) {
  // Discord API 限流降级：仅记录错误，不阻塞流程
  console.error(`状态卡更新失败 (${sessionId}):`, error);
}
```

- 触发 rate limit 时不阻塞主流程
- 记录错误日志便于排查

### 3. 内存控制

#### 会话状态快照管理
```typescript
const SESSION_INACTIVE_TIMEOUT_MS = 3600000; // 1 小时
const sessionLastActivity = new Map<string, number>();
const sessionStateSnapshots = new Map<string, SessionStateSnapshot>();

export function cleanupInactiveSessions(): void {
  const now = Date.now();
  for (const [sessionId, lastActivity] of sessionLastActivity) {
    if (now - lastActivity > SESSION_INACTIVE_TIMEOUT_MS) {
      sessionStateSnapshots.delete(sessionId);
      sessionLastActivity.delete(sessionId);
    }
  }
}
```

- 失活超过 1 小时的会话释放状态快照
- 定期清理减少内存占用

#### 日志监控器缓冲区限制 (`src/monitors/codex-log-monitor.ts`)
```typescript
const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_LINES_PER_POLL = 100; // 单次最多读取行数

// 缓冲区限制：如果 partial 缓冲区超过 10MB，强制刷新
if (tracked.partial.length > MAX_BUFFER_SIZE) {
  console.warn(`Buffer overflow, flushing ${tracked.partial.length} bytes`);
  tracked.partial = '';
  tracked.bufferSize = 0;
}
```

- 单次轮询最多读取 100 行
- 缓冲区超过 10MB 强制刷新
- 防止大文件导致内存溢出

#### 动态轮询间隔
```typescript
const POLL_INTERVAL_ACTIVE_MS = 500;  // 活跃会话
const POLL_INTERVAL_IDLE_MS = 2000;   // 空闲会话

// 动态调整轮询间隔
const timeSinceLastEvent = Date.now() - tracked.lastEventTime;
if (timeSinceLastEvent < 10000) {
  tracked.pollInterval = POLL_INTERVAL_ACTIVE_MS;
} else if (timeSinceLastEvent < 60000) {
  tracked.pollInterval = POLL_INTERVAL_IDLE_MS;
}
```

- 活跃会话 500ms 轮询
- 空闲会话 2s 轮询
- 5 分钟无活动自动清理

### 4. 定期清理与监控
```typescript
export function startPerformanceMonitoring(): void {
  cleanupInterval = setInterval(() => {
    cleanupInactiveSessions();
    performanceTracker.takeSnapshot();
    performanceTracker.cleanup();
  }, 60000); // 每分钟执行一次
}
```

- 每分钟执行一次清理
- 采集系统资源快照
- 清理过期指标数据（保留 1 小时）

### 5. 性能测试 (`test/performance.test.ts`)

创建了完整的性能测试套件：

- **会话发现延迟测试**：验证 < 2s 要求
- **状态卡更新延迟测试**：验证 < 1s 要求
- **交互卡限流测试**：验证 10 秒冷却机制
- **批量更新测试**：验证 500ms 合并机制
- **内存控制测试**：验证失活会话清理
- **并发门控测试**：验证并发处理能力
- **性能监控测试**：验证指标记录和报告生成

## 性能指标

根据设计文档第 14 节的性能标准：

| 指标 | 目标 | 实现方式 |
|------|------|----------|
| 新会话发现延迟 | < 2s (P95) | 性能追踪器记录 |
| 状态卡更新延迟 | < 1s (P95) | 批量更新 + 性能追踪 |
| CPU 占用（空闲） | < 5% | 动态轮询间隔 |
| 内存占用（10 会话） | < 200MB | 状态快照清理 + 缓冲区限制 |
| 钩子脚本执行 | < 100ms (P95) | （待阶段三实现） |

## 使用方式

### 启动性能监控
```typescript
import { startPerformanceMonitoring } from './panel-adapter.ts';

// 在 bot 启动时调用
startPerformanceMonitoring();
```

### 获取性能统计
```typescript
import { getPerformanceStats, generatePerformanceReport } from './panel-adapter.ts';

// 获取统计数据
const stats = getPerformanceStats();
console.log('发现延迟 P95:', stats.discoveryLatency?.p95);
console.log('更新延迟 P95:', stats.updateLatency?.p95);

// 生成完整报告
const report = generatePerformanceReport();
console.log(report);
```

### 手动清理
```typescript
import { cleanupInactiveSessions } from './panel-adapter.ts';

// 手动触发清理
cleanupInactiveSessions();
```

## 注意事项

1. **状态机接口不匹配**：当前 `panel-adapter.ts` 使用的状态机接口与新的 `StateMachine` 类不匹配，需要在后续阶段进行适配或重构。

2. **门控记录归档**：设计文档要求门控记录保留最近 100 条并归档，当前实现中门控记录管理在 `gate-coordinator.ts` 中，需要在该模块中实现归档逻辑。

3. **测试依赖**：性能测试依赖 mock 的 Discord.js 接口，实际运行时需要真实的 Discord 环境。

4. **监控数据持久化**：当前性能指标仅保存在内存中，重启后丢失。如需长期分析，可考虑将指标写入文件或数据库。

## 后续工作

1. 修复 `panel-adapter.ts` 与新状态机的接口不匹配问题
2. 在 `gate-coordinator.ts` 中实现门控记录归档（保留最近 100 条）
3. 集成性能监控到 bot 启动流程
4. 添加性能指标的可视化展示（可选）
5. 实现性能指标的持久化存储（可选）

## 验证清单

- [x] 创建性能监控追踪器
- [x] 实现批量更新（500ms 合并）
- [x] 实现交互卡限流（10 秒冷却）
- [x] 使用 PATCH 而非 DELETE + POST
- [x] 实现 rate limit 降级
- [x] 实现会话状态快照清理
- [x] 实现日志监控器缓冲区限制
- [x] 实现动态轮询间隔
- [x] 创建性能测试套件
- [ ] 修复状态机接口不匹配（需要后续工作）
- [ ] 实现门控记录归档（需要在 gate-coordinator.ts 中实现）
- [ ] 集成到 bot 启动流程（需要修改 bot.ts）
