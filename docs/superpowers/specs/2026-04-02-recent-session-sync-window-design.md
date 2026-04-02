# Recent Session Sync Window Design

**Goal:** 让本地会话自动同步只补建最近三天内仍然活跃的会话，避免把项目目录下大量历史会话一次性回灌到 Discord。

## Scope

- `Codex` 与 `Claude` 都遵守同一条规则。
- 规则只影响“自动发现并补建到 Discord”的链路。
- 已经存在于 Discord 的活动频道先不做批量清理，本次仅阻止过旧历史会话继续被补建。

## Design

### 统一窗口规则

- 同步层使用“最后活跃时间”判断会话是否在窗口内。
- 时间窗口默认固定为最近 `72` 小时。
- 只有最后活跃时间 `>= now - 72h` 的会话才允许被自动同步。

### 配置化

- 新增统一配置项 `SESSION_SYNC_RECENT_DAYS`
- 默认值为 `3`
- 当值为 `0` 或更小值时，关闭最近窗口限制，允许同步历史会话
- `Claude` 与 `Codex` 共用同一配置，避免双份策略漂移

### Provider 时间来源

- `Claude`：使用 `listSessions(...)` 返回的 `lastModified`
- `Codex`：使用 `session_index.jsonl` 里的 `updated_at`

### Codex 兼容性

实机数据表明 `updated_at` 为 ISO 时间字符串，而现有解析逻辑只接受数字时间戳。为保证三天窗口在 `Codex` 上真正生效，需要把字符串时间解析为毫秒时间戳。

## Files

- `/Users/ld/Documents/github/agentcord/src/session-sync.ts`
- `/Users/ld/Documents/github/agentcord/src/codex-session-discovery.ts`
- `/Users/ld/Documents/github/agentcord/src/config.ts`
- `/Users/ld/Documents/github/agentcord/src/types.ts`
- `/Users/ld/Documents/github/agentcord/.env.example`
- `/Users/ld/Documents/github/agentcord/test/session-sync.test.ts`
- `/Users/ld/Documents/github/agentcord/test/codex-session-discovery.test.ts`

## Verification

- 过期 `Codex` 会话不会被同步
- 过期 `Claude` 会话不会被同步
- 最近三天内的会话仍会被同步
- `SESSION_SYNC_RECENT_DAYS=0` 时，过期会话会重新允许同步
- `Codex` 的 ISO `updated_at` 能正确解析为可比较时间
