# workspacecord 全局配置与项目挂载设计

> **状态更新（2026-03-31）：设计约束仍有效，但产品表面已演化。**
>
> 这份设计文档确立的核心约束仍然成立：
>
> - 配置走全局存储
> - 项目必须显式挂载
> - 远程能力必须受已挂载项目边界约束
> - 本地会话只同步属于已挂载项目的内容
>
> 但具体交互表面已经发生演化：
>
> - 命令名已从 `workspacecord` 演化为 `workspacecord`
> - 文中多处出现的 `/session new` / `/session resume` 不再是当前主命令面；当前以 `/project setup` 绑定项目，以 `/agent spawn` 创建主代理会话
> - 文中提到的 Discord `/project list` 没有成为最终产品的一部分；项目查看主要依赖 Discord 分类结构和本地 `workspacecord project list`
>
> 因此，阅读本文时请优先提取“边界与约束”，不要把旧交互名词直接当作当前实现要求。

日期：2026-03-26

## 产品定位

workspacecord 的目标形态是一个**全局安装的命令行工具**（`npm install -g workspacecord`），以后台常驻服务的方式运行，通过 Discord 管理本地机器上的 AI 编程助手会话。所有设计决策都围绕这个前提展开：配置全局化、项目显式挂载、本地 CLI 会话自动同步到 Discord。

## 背景

当前 `workspacecord` 的运行与配置模型以当前工作目录中的 `.env` 为中心，并且在远程创建会话时，会根据目录名推导项目名并自动创建或复用 `Discord` 分类。

这套模型在"仓库内本地启动、前台运行"场景下可用，但不适合下面的目标：

- 作为 `npm install -g` 的全局包使用
- 通过后台常驻服务运行，而不是依赖某个前台终端
- 配置放在固定全局位置，而不是绑定某个目录下的 `.env`
- 项目由用户显式挂载，而不是在远程创建会话时隐式推导
- 远程创建会话必须绑定到已挂载项目
- 本地 CLI 会话自动同步到 Discord

## 目标

### 主要目标

1. 把机器人级配置从 `.env` 迁移到固定全局位置。
2. 新增 `workspacecord config ...` 命令管理全局配置。
3. 新增 `workspacecord project init`，在当前目录显式挂载项目。
4. 远程新建会话时必须选择已挂载项目。
5. 本地 CLI 会话（`claude`、`codex` 命令创建）自动同步到 Discord。
6. 已挂载项目复用同一个 `Discord` 分类，不因新会话重复创建分类。
7. 后台服务不再依赖"当前目录有 `.env`"。

### 非目标

1. 不设计多实例服务。
2. 不要求所有本地目录都先注册成项目。
3. 不在本次改造中引入复杂权限分层。
4. 不默认删除 `Discord` 上已有分类或频道。
5. 不提供 `.env` 迁移工具（无现有用户）。
6. 不在第一阶段同步本地会话的历史消息到 Discord（仅发现 + 创建频道 + 可 resume）。

## 总体方案

采用"全局单实例服务 + 全局配置 + 显式项目挂载 + 远程按项目创建会话 + 本地会话自动同步"的模型。

### 核心原则

- 配置是全局的，不绑定当前目录。
- 项目挂载是显式动作，由用户在本地项目目录中执行（`cd` 到目录后 `init`，不接受路径参数，防止输入错误）。
- 远程会话必须归属于某个已挂载项目。
- 本地 CLI 会话自动同步到对应项目的 Discord 分类下。

## 配置设计

### 存储方式

使用 `Configstore` 保存全局配置。

推荐直接使用其默认配置路径，不额外自定义路径。这样可以获得跨平台的一致行为，并符合全局命令行工具的预期。

全局配置中保存：

- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID`
- `ALLOWED_USERS`
- `ALLOW_ALL_USERS`
- `CODEX_SANDBOX_MODE`
- `CODEX_APPROVAL_POLICY`
- `CODEX_NETWORK_ACCESS_ENABLED`
- `MESSAGE_RETENTION_DAYS`
- `RATE_LIMIT_MS`

### 明确移除

移除 `DEFAULT_DIRECTORY` 和 `ALLOWED_PATHS`。

原因：

- `DEFAULT_DIRECTORY`：全局默认目录与"显式项目挂载"模型冲突，远程模型改为"选择已挂载项目"后不再需要
- `ALLOWED_PATHS`：所有项目都是用户手动 `init` 挂载的，路径白名单不再必要

### 配置命令

新增：

```bash
workspacecord config setup
workspacecord config get <key>
workspacecord config set <key> <value>
workspacecord config unset <key>
workspacecord config list
workspacecord config path
```

### 行为说明

- `config setup`
  - 交互式设置全局配置
  - 替代当前 `.env` 向导
- `config get`
  - 读取单个配置项
- `config set`
  - 写入单个配置项，并做值校验
- `config unset`
  - 删除某个可选配置项
- `config list`
  - 列出当前配置
  - 敏感值如 `DISCORD_TOKEN` 需要打码
- `config path`
  - 输出实际配置文件路径

## 项目挂载设计

### 项目定义

项目是"用户显式挂载的本地目录"，并与 `Discord` 上的分类建立稳定绑定。

项目字段：

- `id`
- `name`
- `path`
- `discordCategoryId`（可为空，懒创建）
- `discordCategoryName`
- `logChannelId`（可为空，懒创建）
- `createdAt`
- `updatedAt`

其中：

- `path` 为绝对路径
- `path` 必须全局唯一
- `name` 默认取当前目录名，但允许通过 `--name` 显式覆盖

### 项目命令

新增：

```bash
workspacecord project init
workspacecord project init --name my-api
workspacecord project list
workspacecord project info
workspacecord project rename <new-name>
workspacecord project remove
```

注意：`project init` 只支持在当前目录执行，不接受路径参数，防止输入错误。

### `project init`

在当前目录执行，完成：

1. 计算当前目录绝对路径
2. 读取目录名作为默认项目名
3. 若传入 `--name`，则使用显式名称
4. 检查该路径是否已经挂载
5. 将项目写入全局项目注册表（`discordCategoryId` 暂为空）
6. 尝试连接 Discord 创建分类和 `project-logs` 频道
   - 若 bot 在线：创建成功，回填 `discordCategoryId` 和 `logChannelId`
   - 若 bot 离线：提示用户 "Project registered locally. Discord category will be created when the bot starts."

如果当前目录已经挂载，则直接返回已有项目结果，不重复创建。

### Discord 分类懒创建

当 `discordCategoryId` 为空时，以下时机触发创建：

- bot 启动时扫描项目注册表，为缺失分类的项目补建
- 远程 `/session new` 选择该项目时

### `project rename`

重命名已挂载项目：

1. 更新项目注册表中的 `name`
2. 若 Discord 分类已创建，同步重命名分类名称

### `project list`

列出所有已挂载项目，包括：

- 名称
- 路径
- 分类名
- Discord 状态（已创建 / 待创建）

### `project info`

显示当前目录对应项目的详细信息。

### `project remove`

移除本地挂载关系，但默认不删除 `Discord` 上的分类和频道。

原因：

- 删除远程资源风险高
- 用户可能仍希望保留历史会话与日志

## 远程会话模型

### 基本规则

远程新建会话必须选择已挂载项目。

即：

- 远程不能直接指定任意本地路径
- 远程不能创建游离会话
- 远程创建流程必须先选项目，再创建会话

### 建议流程

远程 `/session new`：

1. 从已挂载项目列表中选择项目
2. 输入会话名称
3. 选择提供方、模式、模型与策略
4. 在所选项目对应分类下创建频道（若分类尚未创建，此时懒创建）
5. 用该项目的本地路径创建会话

### 结果

同一个项目下的新会话：

- 复用同一个 `Discord` 分类
- 不再重复新建分类

## 本地会话自动同步

### 定义

本地会话是指用户在已挂载项目目录下，通过 `claude` 或 `codex` CLI 命令直接创建的会话。这些会话应自动同步到 Discord，在对应项目分类下创建频道。

### 同步机制：轮询

bot 运行时，每 30 秒轮询一次已挂载项目的本地会话列表，发现新会话后自动在 Discord 创建频道。

### Claude 会话发现

使用 Claude Agent SDK 提供的 `listSessions` API：

```typescript
import { listSessions } from '@anthropic-ai/claude-agent-sdk';

// 按项目目录查询
const sessions = await listSessions({ dir: '/path/to/project' });
// 返回: SDKSessionInfo[]
// 关键字段: sessionId, summary, lastModified, cwd, gitBranch, createdAt
```

### Codex 会话发现

Codex 改为基于索引文件和真实会话文件做两阶段发现。

#### 第一步：读取候选会话索引

读取 `session_index.jsonl`，把它当作候选会话入口。当前阶段只依赖其中三个字段：

| 字段          | 说明                                |
| ------------- | ----------------------------------- |
| `id`          | 会话唯一标识，用于定位真实会话文件  |
| `thread_name` | 会话标题候选，用于 Discord 频道命名 |
| `updated_at`  | 最近活动时间，用于排序或去重时参考  |

索引记录缺少 `id` 时直接跳过。

#### 第二步：定位真实会话文件

根据索引里的 `id`，在 `sessions/**/*.jsonl` 中定位对应会话文件。这里不要求文件名或目录名直接包含 `id`；允许扫描文件内容匹配会话 `id`。

#### 第三步：读取首条 `session_meta`

定位到会话文件后，只读取首条记录，并要求：

- 首条记录类型必须是 `session_meta`
- 必须存在 `session_meta.payload.cwd`

只要任一条件不满足，该会话就直接跳过，不进入同步。

#### 第四步：按已挂载项目过滤

`session_meta.payload.cwd` 是 Codex 会话项目归属的唯一判断依据。同步规则是：

- 仅当 `cwd` 位于某个已挂载项目根目录之下时，才允许同步
- 这里不是路径完全相等匹配，而是“项目根目录前缀包含该 `cwd`”
- 若 `cwd` 不属于任何已挂载项目，则直接跳过

### 同步流程

```
定时任务（每 30s）
  ↓
读取已挂载项目列表
  ↓
Claude: listSessions({ dir: project.path })
Codex: 读取 session_index.jsonl
          ↓
        根据 id 扫描 sessions/**/*.jsonl
          ↓
        读取首条 session_meta.payload.cwd
          ↓
        过滤出 cwd 位于已挂载项目根目录之下的会话
  ↓
对比已注册会话（sessions.json），过滤出新会话
  ↓
对每个新会话：
  1. 在项目 Discord 分类下创建频道
     - Claude: #claude-{summary 截断}
     - Codex:  #codex-{thread_name 截断}
  2. 注册到 sessions.json
     - 关联 providerSessionId
     - 关联 channelId
     - 标记 source: 'local-sync'
  ↓
用户在 Discord 频道发消息时，通过 resume 接续对话
```

### 第一阶段限制

- 只做"发现 + 创建频道 + 可 resume"
- 不同步历史消息到 Discord
- 用户在 Discord 频道发第一条消息时，通过 provider 的 resume 机制接续对话
- Codex 会话文件无法定位、首条不是 `session_meta`、或缺少 `session_meta.payload.cwd` 时直接跳过
- 跳过单个 Codex 会话不应中断整轮同步

### 历史消息同步（推迟到后续迭代）

推迟原因：

- Claude 的 `getSessionMessages()` 返回 `{ message: unknown }`，需要写格式转换器
- Codex 的真实历史存储在 `sessions/**/*.jsonl` 中，仍需把离线记录格式转换成统一的实时事件/Discord 消息格式
- Discord 有消息速率限制，批量发送需要排队
- 工具调用输出可能很长，需要截断策略

## 后台服务设计

### 现状判断

当前 `macOS` 的后台方案基于：

- `LaunchAgent`
- `launchctl load/unload`
- `RunAtLoad = true`
- `KeepAlive.SuccessfulExit = false`

这套机制足以支持：

- 登录后自动启动
- 异常退出自动拉起
- 脱离终端长期运行

对于"单用户机器上常驻一个机器人"的目标来说，这个保活策略是够用的。

### 结论

本次改造无需优先替换后台保活机制；优先级更高的是解除其对当前目录 `.env` 的依赖。

### 服务运行方式

后台服务应从全局配置与全局项目表读取状态，而不是从当前工作目录读取 `.env`。

因此：

- `workspacecord daemon install` 不再要求当前目录存在 `.env`
- 服务 `WorkingDirectory` 应改为稳定目录（如 `~/.workspacecord`），而不是某个项目目录
- 会话索引、项目注册表、全局配置均应存于固定全局位置

## 数据存储边界

所有数据存储在 `Configstore` 默认路径下（全局配置）和 `~/.workspacecord/` 下（项目与会话数据）。

### 1. 全局配置

由 `Configstore` 管理，存储机器人级运行参数与认证配置。

### 2. 项目注册表

`~/.workspacecord/ps.json`

已挂载项目列表。

### 3. 会话注册表

`~/.workspacecord/sessions.json`

会话与下列信息的映射关系：

- `Discord` 频道
- 项目
- 提供方
- 提供方会话编号
- 模式
- 来源（`remote` / `local-sync`）
- 统计信息

## 兼容与迁移

不提供迁移工具。项目尚未上线，无现有用户需要迁移。

`.env` 不再作为运行时主配置来源。新用户直接使用 `workspacecord config setup`。

当前"根据目录名自动推导项目名并自动创建分类"的逻辑应移除，替换为显式项目挂载模型。

## 命令语义调整

### 需要新增

- `workspacecord config ...`（setup / get / set / unset / list / path）
- `workspacecord project ...`（init / list / info / rename / remove）

### 需要调整

- 本地 `setup` 应迁移或并入 `config setup`
- 后台 `daemon install` 改为读取全局配置
- 远程 `/session new` 改为必须选择已挂载项目

### 需要保留

- 会话继续与恢复
- `/session attach`
- 项目人格、技能、`MCP`
- 后台服务安装、卸载、状态查看

### Discord 命令

新增：

- `/project list` — 查看已挂载项目列表（补充，虽然 Discord 分类已自然呈现项目结构，但提供命令方便查看完整信息）

## 错误处理

### 配置错误

- 缺失必填配置时，启动失败并提示用户执行 `workspacecord config setup`
- 配置值非法时，命令级报错并给出可接受值

### 项目挂载错误

- 当前目录不存在或无权限访问
- 项目路径已被其他项目占用
- `Discord` 分类创建失败（bot 离线时降级为本地注册）
- `project-logs` 创建失败

### 远程新建会话错误

- 没有任何已挂载项目可选
- 选择的项目对应路径不存在
- 项目分类被手动删除且无法恢复

### 本地会话同步错误

- Claude SDK `listSessions` 调用失败（跳过本轮，下次重试）
- Codex `session_index.jsonl` 缺失、会话文件缺失或元数据不完整时跳过对应会话
- Discord 频道创建失败（记录日志，下次重试）

## 测试策略

至少覆盖以下场景：

1. 全局配置读写、列举、路径输出
2. 敏感配置遮罩显示
3. 项目初始化（bot 在线时创建分类）
4. 项目初始化（bot 离线时本地注册 + 懒创建）
5. 相同路径重复初始化的幂等行为
6. 项目重命名同步 Discord 分类名
7. 远程创建会话必须选择项目
8. 后台服务脱离 `.env` 后能正常安装与启动
9. 本地 Claude 会话自动发现与频道创建
10. 本地 Codex 会话自动发现与频道创建
11. 已同步会话通过 Discord 消息 resume 对话

## 推荐实施顺序

1. 引入 `Configstore`，替换 `.env` 主路径
2. 新增 `workspacecord config ...` 命令
3. 新增项目注册表与 `project init / list / info / rename / remove`
4. 重构远程 `/session new` 的项目选择流程
5. 实现本地会话自动同步（Claude + Codex 轮询发现 + 频道创建）
6. 调整后台服务安装逻辑为全局模式
7. 清理旧的 `DEFAULT_DIRECTORY`、`ALLOWED_PATHS` 与目录推导逻辑

## 最终结论

推荐采用以下最终方案：

- 使用 `Configstore` 管理全局单实例配置
- 新增 `workspacecord config ...` 命令
- 新增 `workspacecord project init [--name ...] / rename / remove`
- 远程新建会话必须选择已挂载项目
- 本地 CLI 会话（Claude + Codex）自动同步到 Discord
- 已挂载项目复用同一个 `Discord` 分类
- 后台服务继续使用现有保活机制，但改为完全依赖全局配置与全局状态
- 移除 `DEFAULT_DIRECTORY` 和 `ALLOWED_PATHS`

这套方案在保持当前后台能力的同时，能把产品模型从"仓库内机器人"升级为"全局安装、后台常驻、项目显式挂载、本地会话自动同步"的本地服务。
