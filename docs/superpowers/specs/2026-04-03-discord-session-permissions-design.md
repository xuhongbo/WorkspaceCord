# Discord Session Permissions Design

**Goal:** 让 `Discord` 侧创建与管理的 `Claude` / `Codex` 会话都具备完整、可持久化、可修改的会话级权限配置，并让 `Codex` 默认开启联网与搜索。

## Scope

- 本次覆盖 `Discord` 入口创建的主会话与后续会话级权限修改。
- 本次同时覆盖 `Claude` 与 `Codex`，但两者可配置项不同。
- 权限配置必须写入会话持久化数据，服务重启后仍然生效。
- 已存在会话必须支持在 `Discord` 中修改权限，而不要求重新建会话。
- 本次不改变底层提供方本身的权限能力边界，只管理 `workspacecord` 对这些能力的暴露与会话级覆盖。

## Non-Goals

- 不在本次引入全新的权限系统后端或独立权限数据库。
- 不在本次为非 `Discord` 入口创建的外部会话补做完整交互式权限编辑面板。
- 不在本次实现真正“根据前一个选项动态隐藏 slash command 参数”的前端行为；`Discord` 原生命令定义不支持这一能力。

## Design

### 方案选择

本次采用“统一会话级权限模型 + provider 分流生效”的方案。

- 命令层保留统一入口：`/agent spawn`
- 新增统一修改入口：`/agent permissions`
- 会话数据层统一保存 provider 相关权限字段
- 运行时按当前会话的 `provider` 计算最终生效权限

这样可以同时满足：

- 新建会话即可指定权限
- 已有会话可修改权限
- 权限修改会持久化
- 后续继续对话、恢复、监督轮次都使用最新权限

### 命令与交互模型

#### `/agent spawn`

保留现有主入口，并扩展为完整权限参数集：

共同参数：

- `label`
- `provider`
- `mode`
- `directory`

`Claude` 参数：

- `claude-permissions`
  - `normal`
  - `bypass`

`Codex` 参数：

- `codex-sandbox`
  - `read-only`
  - `workspace-write`
  - `danger-full-access`
- `codex-approval`
  - `never`
  - `on-request`
  - `on-failure`
  - `untrusted`
- `codex-bypass`
  - `off`
  - `on`

本次不把 `network` 与 `web search` 作为每次都要手选的参数暴露给用户，而是直接把 `Codex` 默认值调整为：

- `networkAccessEnabled = true`
- `webSearchMode = live`

理由：用户明确要求“默认都应该允许联网和搜索”，且本次重点是把安全相关权限集完整暴露出来。

#### `/agent permissions`

新增会话级权限修改命令，用于当前会话频道内调整权限。

- 当前会话是 `Claude` 时，只接受并应用 `claude-permissions`
- 当前会话是 `Codex` 时，只接受并应用 `codex-sandbox`、`codex-approval`、`codex-bypass`

由于 `Discord` slash command 无法基于前一个选项动态裁剪参数，命令定义层仍会静态暴露相关参数；处理层按当前 provider 做校验与忽略。

### 数据模型

在 `ThreadSession` 中新增会话级 `Codex` 权限字段，并保留现有 `Claude` 字段。

新增字段：

- `codexSandboxMode?`
- `codexApprovalPolicy?`
- `codexBypass?`
- `codexNetworkAccessEnabled?`
- `codexWebSearchMode?`

保留字段：

- `claudePermissionMode?`

字段语义：

- 字段为 `undefined`：表示当前会话未显式覆盖，继续使用全局默认
- 字段有值：表示当前会话显式覆盖全局默认

这些字段属于会话持久化模型的一部分，必须进入会话保存与恢复链路。

### 创建、修改与持久化

#### 创建会话

`createSession(...)` 扩展接受新的会话级权限参数，并在构造 `ThreadSession` 时写入内存对象，随后通过现有保存链路立即落盘。

#### 修改已有会话

新增专门的会话级权限更新入口，例如：

- `updateSessionPermissions(sessionId, patch)`

该入口负责：

- 校验当前会话 provider
- 只写入与该 provider 相关的字段
- 更新时间戳
- 立即触发持久化

#### 服务重启恢复

会话反序列化时，新增字段与现有字段一起读回；后续 `continue`、`monitor`、普通消息发送都基于恢复后的最新权限配置运行。

### 运行时优先级

运行时最终权限按以下顺序计算：

1. 会话级显式设置
2. `bypass` 展开的强覆盖结果
3. 全局默认配置
4. 代码兜底默认值

#### `Codex bypass`

当 `codexBypass = on` 时，最终生效权限强制覆盖为：

- `sandboxMode = danger-full-access`
- `approvalPolicy = never`
- `networkAccessEnabled = true`
- `webSearchMode = live`

也就是说，`Codex bypass` 是“全开快捷开关”。即使同时传入了更保守的 `sandbox` 或 `approval`，最终仍以 `bypass` 展开值为准。

#### `Claude bypass`

`Claude` 保持现有语义：

- `normal`：需要确认的普通权限模式
- `bypass`：完全自主的高权限模式

#### `auto` 模式兼容

现有逻辑中，`auto` 模式会对审批做更激进的自动化处理；本次设计要求在不破坏现有自动模式语义的前提下，把会话级权限计算统一收敛到同一个解析层中，避免出现一部分走 `config`、另一部分走 `session` 的分叉。

### 默认值策略

本次明确调整 `Codex` 默认行为：

- 全局默认 `networkAccessEnabled` 改为 `true`
- 全局默认 `webSearchMode` 改为 `live`

`Codex` 的 `sandboxMode` 与 `approvalPolicy` 仍保留全局配置默认入口，但允许会话级覆盖。

`Claude` 继续保留现有默认权限模式，但新增“已有会话可修改”的能力。

### 命令回显与状态展示

#### 新建会话回显

`/agent spawn` 成功后，回显除了现有字段外，还应新增权限摘要。

`Claude` 显示：

- `Claude 权限: normal / bypass`

`Codex` 显示：

- `Sandbox`
- `Approval`
- `Bypass`
- `Network`
- `Search`

当 `codexBypass = on` 时，回显展示最终生效值，而不是仅展示原始输入值。

#### 修改权限回显

`/agent permissions` 成功后发送新的权限摘要消息：

- 若当前会话空闲：提示“已更新并立即生效”
- 若当前会话正在生成：提示“已保存，将在下一轮生效”

#### 状态卡

常驻状态卡增加一行简要权限摘要：

- `Claude`：显示 `normal` 或 `bypass`
- `Codex`：显示 `sandbox | approval | network | search` 的精简组合
- 若 `codexBypass = on`：可直接显示为 `bypass`

状态卡只展示摘要，不承载完整说明，避免过长。

### 错误处理与兼容规则

- 当前 provider 为 `Claude` 时，传入 `Codex` 参数：忽略并提示
- 当前 provider 为 `Codex` 时，传入 `Claude` 参数：忽略并提示
- `bypass=on` 时允许同时传其它字段，但最终展示与运行都以 `bypass` 展开结果为准
- 未显式设置的新字段必须与历史会话兼容，旧会话加载时不报错，继续走默认回退逻辑

## Files

- `/Users/ld/Documents/github/agentcord/src/commands.ts`
- `/Users/ld/Documents/github/agentcord/src/command-handlers.ts`
- `/Users/ld/Documents/github/agentcord/src/thread-manager.ts`
- `/Users/ld/Documents/github/agentcord/src/types.ts`
- `/Users/ld/Documents/github/agentcord/src/config.ts`
- `/Users/ld/Documents/github/agentcord/src/global-config.ts`
- `/Users/ld/Documents/github/agentcord/src/discord/status-card.ts`
- `/Users/ld/Documents/github/agentcord/test/commands-contract.test.ts`
- `/Users/ld/Documents/github/agentcord/test/command-handlers.test.ts`
- `/Users/ld/Documents/github/agentcord/test/command-handlers-matrix.test.ts`
- `/Users/ld/Documents/github/agentcord/test/thread-manager-*.test.ts`
- `/Users/ld/Documents/github/agentcord/test/status-card.test.ts`
- `/Users/ld/Documents/github/agentcord/.env.example`

## Verification

- `spawn` 命令定义包含新的 `Codex` 与 `Claude` 权限参数
- 新增 `/agent permissions` 命令可注册并被路由
- 新建 `Claude` 会话时权限字段会写入并持久化
- 新建 `Codex` 会话时权限字段会写入并持久化
- 修改已有会话权限后，重启服务仍保留修改结果
- `Codex bypass=on` 时最终权限解析为全开组合
- `Codex` 默认联网为开启，默认搜索为 `live`
- 提供方不匹配的参数会被忽略且不会污染会话数据
- 正在生成中的会话修改权限后，不打断当前轮，并在下一轮使用新权限
- 状态卡与命令回显都能正确展示最终生效权限摘要
