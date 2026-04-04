# Phase 3: Integration + E2E Test Framework

## Goal

为 workspacecord 建立集成测试框架，覆盖 CLI 命令路径、Provider 集成事件流、以及现有 smoke 脚本的自动化迁移。

## Scope

### Layer A — CLI 集成测试 (~15 用例)
- `workspacecord config list/path/set` 命令路径
- `workspacecord project init/list/info` 命令路径
- `workspacecord daemon start/stop/status` 命令路径
- `workspacecord attachment fetch` 命令路径
- `workspacecord codex` 命令参数解析
- Mock Discord Client 和 Provider，验证 CLI → 命令处理器 → 模块的 wiring

### Layer B — Provider 集成事件流 (~20 用例)
- Claude Provider → Session Executor → Output Handler 完整事件流
- Codex Provider → Session Executor → Output Handler 完整事件流
- 覆盖 10+ 种 ProviderEvent 类型的端到端转换：
  - text_delta, tool_start, tool_result, ask_user, task
  - command_execution, file_change, reasoning, todo_list
  - session_init, result, error
- 模拟流式输出序列，验证限流、batch 编辑、状态卡更新
- monitor 模式双代理循环

### Layer C — Smoke 脚本迁移 (~15 用例)
- integration-smoke.ts → vitest 集成测试（mock Discord）
- session-sync-smoke.ts → 自动化同步测试
- monitor-e2e.ts → Codex 日志监控单元测试
- multi-session-smoke.ts → 多会话并发测试
- local-acceptance-suite.ts → CLI 命令冒烟测试

## Testing Strategy

### Architecture
- 新增 `test/integration/` 目录，存放集成测试
- 新增 `vitest.integration.config.ts`（更长超时、不同 mock 策略）
- 新增 `pnpm test:integration` 脚本
- 现有 `scripts/*.ts` 保留作为手动真实环境验证

### Mock Strategy
- CLI 测试：mock daemon.ts 和 config-cli.ts 的内部调用
- Provider 集成：mock SDK 返回预定义事件流，验证完整 pipeline
- Smoke 迁移：将真实 Discord 连接替换为 mock Channel/Guild

### Quality Standards
- 每个测试文件独立 mock，不依赖全局状态
- 使用 vi.useFakeTimers() 控制时间相关测试
- 所有外部依赖（Discord, SDK）必须 mock
- 测试执行时间 < 500ms/个

## Acceptance Criteria

1. `pnpm test` 全部通过（预计 735+ 用例）
2. `pnpm test:integration` 全部通过（预计 50 用例）
3. 全量覆盖率：statements >= 65%, lines >= 65%, branches >= 50%
4. 每个新增测试文件 >= 70% 行覆盖率
