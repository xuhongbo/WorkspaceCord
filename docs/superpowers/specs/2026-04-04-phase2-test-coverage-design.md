# Phase 2: Core Business Pipeline Test Coverage

## Goal

为核心业务链路模块编写单元测试，覆盖 Provider 抽象、会话执行链路、Discord 基础设施层，目标全量覆盖率提升至 70%+。

## Scope

10 个模块，预计 ~130+ 测试用例：

### Layer A — Provider 抽象层
| 模块 | 行数 | 当前覆盖率 | 预计用例 | Mock 目标 |
|------|------|-----------|---------|----------|
| claude-provider.ts | 309 | 2.67% | ~15 | @anthropic-ai/claude-agent-sdk |
| codex-provider.ts | 339 | 35.61% | ~15 | @openai/codex-sdk |

### Layer B — 会话执行链路
| 模块 | 行数 | 当前覆盖率 | 预计用例 | Mock 目标 |
|------|------|-----------|---------|----------|
| session-executor.ts | 1378 | 56.65% | ~20 | Provider, Discord, session-registry |
| thread-manager.ts | 512 | 49.4% | ~20 | Provider, config, project-manager |
| output-handler.ts | 789 | 已有测试 | ~10 | Discord Channel |

### Layer C — 基础设施/辅助
| 模块 | 行数 | 当前覆盖率 | 预计用例 | Mock 目标 |
|------|------|-----------|---------|----------|
| session-registry.ts | 731 | 70.12% | ~15 | 内部依赖 |
| attachment-inbox.ts | 279 | 78.44% | ~10 | Discord |
| bot-services-orchestrator.ts | 243 | 0% | ~10 | Discord, 内部依赖 |
| subagent-manager.ts | 141 | 17.02% | ~8 | 内部依赖 |
| cli/codex-launcher.ts | 174 | 35.71% | ~8 | 内部依赖 |

## Testing Strategy

### Provider Tests
- Mock SDK 的 `query()` 和 `runStreamed()` 返回预定义事件流
- 验证事件类型映射、错误处理、系统提示词注入、成本统计
- 使用 AsyncGenerator 的 mock 来模拟流式输出

### Session Executor Tests
- Mock Provider 返回预定义 ProviderEvent stream
- 验证事件到 Discord 的转换、限流、状态更新、monitor 模式
- 按功能拆分为多个 describe 块：auto 模式、plan 模式、monitor 模式

### Thread Manager Tests
- Mock Provider 和 config
- 验证会话创建、系统提示词构建、Discord 频道管理

### Output Handler Tests
- 已有部分测试，补充覆盖：文件变更、命令执行、任务进度等事件类型

### Session Registry Tests
- Mock 内部依赖（persistence、config）
- 验证 CRUD、权限管理、会话查询方法

### Infrastructure Tests
- 每个模块独立 mock，验证核心功能路径

## Acceptance Criteria

1. `pnpm test` 全部通过（预计 600+ 用例）
2. 全量覆盖率：statements >= 65%, lines >= 65%, branches >= 50%
3. vitest 阈值提升至：lines 65%, functions 60%, branches 50%, statements 65%
4. 每个模块 >= 70% 行覆盖率
