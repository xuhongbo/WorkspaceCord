# workspacecord 当前的 Codex 会话感知机制分析

## 当前实现：轮询机制

workspacecord 使用 **定时轮询** 来发现和同步 Codex 会话：

```typescript
// src/session-sync.ts
const SYNC_INTERVAL_MS = 30_000; // 30 秒轮询一次

export function startSync(client: Client): void {
  void runSyncSafely(client);
  syncTimer = setInterval(() => void runSyncSafely(client), SYNC_INTERVAL_MS);
}
```

### 工作流程

1. **每 30 秒执行一次**：
   ```typescript
   async function runSync(client: Client) {
     // 1. 读取 ~/.codex/session_index.jsonl
     const codexSessions = await listCodexSessionsForProjects();

     // 2. 对比现有 Discord 频道
     // 3. 创建新频道（如果发现新会话）
   }
   ```

2. **发现机制**：
   - 读取 `~/.codex/session_index.jsonl`
   - 扫描 `~/.codex/sessions/` 目录
   - 匹配项目目录

3. **同步延迟**：
   - 最快：立即发现（如果刚好轮询）
   - 最慢：30 秒延迟
   - 平均：15 秒延迟

## 对比：Clawd 的实时机制

Clawd 使用 **事件驱动 + 轮询混合**：

### Claude Code：事件驱动（零延迟）
- 通过 hooks 系统
- Claude Code 主动触发
- 立即 HTTP POST

### Codex：增量日志监控（1.5 秒延迟）
- 轮询 JSONL 文件
- 但是 **增量读取**，不重复解析
- 1.5 秒轮询间隔（比 workspacecord 快 20 倍）

```javascript
// clawd: codex-log-monitor.js
const POLL_INTERVAL_MS = 1500; // 1.5 秒

this.interval = setInterval(() => this.poll(), POLL_INTERVAL_MS);
```

## 关键差异

| 维度 | workspacecord 当前 | Clawd | 改进空间 |
|------|---------------|-------|---------|
| **轮询间隔** | 30 秒 | 1.5 秒 | **20 倍** |
| **增量读取** | ❌ 每次全量扫描 | ✅ 维护 offset | 避免重复解析 |
| **延迟** | 平均 15 秒 | 平均 0.75 秒 | **20 倍** |
| **CPU 开销** | 高（全量扫描） | 低（增量） | 显著降低 |

## 改进建议

### 1. 缩短轮询间隔（立即可做）

```typescript
// src/config.ts
sessionSyncIntervalMs: optionalInt('SESSION_SYNC_INTERVAL_MS', 1500), // 从 30s 改为 1.5s
```

**收益**：延迟从 15 秒降低到 0.75 秒

### 2. 使用已实现的 CodexLogMonitor（推荐）

我们已经实现了 clawd 的增量监控器：

```typescript
// src/monitors/codex-log-monitor.ts
const monitor = new CodexLogMonitor(baseDir, (sessionId, state, event, extra) => {
  // 实时更新状态
});
monitor.start();
```

**收益**：
- 增量读取，避免重复解析
- 1.5 秒轮询
- 启发式权限检测
- 自动清理失活会话

## 重要发现：workspacecord 的双重机制

workspacecord 实际上有 **两种会话感知方式**：

### 1. Discord 发起的会话（实时）

```
Discord 消息 → bot 接收 → 调用 provider.sendPrompt() → 流式事件 → 实时更新 Discord
```

**零延迟**：因为 workspacecord 自己创建并控制会话，直接消费 Provider 的流式事件。

### 2. 本地 CLI 发起的会话（轮询）

```
用户在终端运行 codex → 创建会话 → 30 秒后 workspacecord 轮询发现 → 创建 Discord 频道
```

**30 秒延迟**：因为 workspacecord 不知道会话何时创建，只能定期扫描。

## 核心问题与解决方案

### 问题
本地 CLI 会话无法实时同步到 Discord（30 秒延迟）

### 解决方案：Hook 系统

参考 clawd，使用 Claude Code Hooks 实现本地 → Discord 的实时同步：

```
本地 CLI → Hook 触发 → HTTP POST → workspacecord → Discord 实时更新
```

这样就能实现 **双向实时同步**：
- Discord → 本地：已有（流式事件）
- 本地 → Discord：通过 Hook 实现

## 总结

### workspacecord 当前状态

1. **Discord 发起的会话**：✅ 实时（流式事件）
2. **本地 CLI 会话**：❌ 30 秒延迟（轮询）

### 改进路径

**短期（立即可做）**：
- 缩短轮询间隔到 1.5 秒
- 使用已实现的 CodexLogMonitor

**长期（最佳方案）**：
- 实现 Hook 系统
- 实现本地 → Discord 实时同步
- 达到 clawd 的零延迟体验

详细 Hook 实现方案见：`clawd-realtime-mechanism.md`
