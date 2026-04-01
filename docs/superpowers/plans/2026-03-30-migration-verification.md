# 状态机切换验证报告

日期：2026-03-31

## 自动化验证

- 类型检查：✅ 通过（`npm run typecheck`）
- 单元测试：✅ 通过（`npm test`，`22` 个测试文件，`117` 个测试）
- 构建：✅ 通过（`npm run build`）
- 集成冒烟：✅ 通过（`node --experimental-strip-types scripts/integration-smoke.ts`）

## 已验证链路

- `Discord` 登录与已绑定项目复用
- 主会话创建与状态卡置顶
- 子代理线程创建
- `/shell run` 真实执行
- `Claude` 真实生成冒烟
- `Codex` 真实生成冒烟
- `CodexLogMonitor -> 事件归一 -> 会话映射 -> Discord 状态卡更新`
  - 已验证“正在思考”
  - 已验证“正在执行”
- 主会话归档到 `#history`
- `awaiting_human` 统一入口接线
- 按钮校验当前有效交互消息 ID
- 状态机优先级转换与正式/推断状态语义
- 状态卡 `adopt` 后清组件、重试 pin、内容约束校验
- `Store.write()` 并发写串行化，避免注册表持久化竞争
- `monitor-e2e` 失败不再假阳性

## 证据

- 集成报告：`/Users/ld/Documents/github/workspacecord/local-acceptance/workspacecord-integration-report.json`
- 监控桥接：`/Users/ld/Documents/github/workspacecord/src/codex-monitor-bridge.ts`
- 集成脚本：`/Users/ld/Documents/github/workspacecord/scripts/integration-smoke.ts`
- 并发写测试：`/Users/ld/Documents/github/workspacecord/test/persistence.test.ts`
- 状态机测试：`/Users/ld/Documents/github/workspacecord/test/state-machine.test.ts`
- 状态卡测试：`/Users/ld/Documents/github/workspacecord/test/status-card.test.ts`
- 监控器测试：`/Users/ld/Documents/github/workspacecord/test/codex-log-monitor.test.ts`

## 结论

状态机主迁移已完成，主运行路径已切换到 `panel-adapter + state-machine`。

`Claude`、`Codex`、`shell` 与 `Discord` 面板主链路均已完成真实冒烟验证；`Codex` 日志监控驱动状态卡跳转也已通过实证。

本轮补齐后，计划中的关键剩余偏离已经完成修复并重新验证，包括：

- 等待人工闭环接线
- 状态机优先级与推断态语义
- 状态卡接管与展示边界
- `Codex` 监控器直接测试
- 验收脚本假阳性与注册表并发写问题
