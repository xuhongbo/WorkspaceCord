# workspacecord

[![CI](https://github.com/xuhongbo/WorkspaceCord/actions/workflows/ci.yml/badge.svg)](https://github.com/xuhongbo/WorkspaceCord/actions/workflows/ci.yml)
[![npm version](https://badge.fury.io/js/workspacecord.svg)](https://www.npmjs.com/package/workspacecord)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.6.0-brightgreen)](https://nodejs.org)

> 通过 Discord 在本机项目上运行和管理多代理编程会话。

[English README](./README.md)

> 仓库名：`workspacecord`  
> 命令行与包名：`workspacecord`

## 概览

`workspacecord` 把 Discord 结构映射到本地开发流程：

```text
Discord Server
└─ Category = Project
   ├─ #history (Forum) = Archived Sessions
   └─ #claude-fix-login = Main Agent Session
      └─ [sub:codex] benchmark = Subagent Thread
```

- `Category` 表示一个已挂载的本地项目。
- `TextChannel` 表示一个主代理会话。
- `Thread` 表示一个子代理。
- `#history` Forum 用于存放归档会话。

## 特性

- 使用 `workspacecord project init` 显式挂载本地项目
- 使用 `/project setup` 在 Discord 中绑定项目
- 主会话频道与子代理线程模型
- 会话自动归档到 `#history`
- 项目级人格、可复用技能和 MCP 服务注册管理
- 同时支持 Claude 与 Codex 提供方
- `monitor` 模式可持续推进直到任务完成
- 托管会话支持 Discord 远程人工审批 / 门控处理
- 支持本地托管 `Codex` 启动与自动会话发现 / 同步
- 使用全局配置存储，不依赖项目内 `.env`
- 支持守护进程安装与后台管理

## 环境要求

- `Node >= 22.6.0`
- `pnpm`
- 一个可用的 Discord 应用、机器人令牌、客户端编号与服务器编号

## 文件位置

- **配置文件**: `~/.config/workspacecord/config.json` - 全局配置
- **数据目录**: `~/.workspacecord/` - 项目、会话和日志

## 安装

```bash
pnpm install
pnpm build
pnpm link --global
```

安装后可使用全局命令或短别名：

```bash
workspacecord  # 完整命令
wsc            # 短别名
```

## 快速开始

### 1. 配置全局凭据

```bash
workspacecord config setup
```

也可以直接写入：

```bash
workspacecord config set DISCORD_TOKEN <token>
workspacecord config set DISCORD_CLIENT_ID <client-id>
workspacecord config set DISCORD_GUILD_ID <guild-id>
workspacecord config set ALLOW_ALL_USERS true
```

### 2. 挂载本地项目

在目标项目目录中执行：

```bash
workspacecord project init --name my-project
```

### 3. 启动机器人

```bash
workspacecord
```

### 4. 在 Discord 中绑定项目

在目标 Category 下你希望作为“新会话控制频道”的那个文本频道执行：

```text
/project setup project:my-project
```

绑定成功后会自动创建或复用 `#history` Forum，并把当前频道记录为 `/agent spawn` 的专用控制频道。

## 主要命令

### 本地 CLI

**配置管理：**
```bash
workspacecord config setup              # 交互式配置向导
workspacecord config get <key>          # 读取配置值
workspacecord config set <key> <value>  # 写入配置值
workspacecord config list               # 列出所有配置
workspacecord config path               # 显示配置文件路径
```

**项目管理：**
```bash
workspacecord project init [--name <name>]  # 将当前目录挂载为项目
workspacecord project list                  # 列出所有已挂载项目
workspacecord project info                  # 显示当前项目信息
workspacecord project rename <new-name>     # 重命名当前项目
workspacecord project remove                # 卸载当前项目
```

**守护进程管理：**
```bash
workspacecord daemon install    # 安装为系统守护进程（开机自启）
workspacecord daemon uninstall  # 卸载守护进程（别名：remove）
workspacecord daemon status     # 查看守护进程状态
```

**高级功能：**
```bash
workspacecord codex [options]   # 启动托管的 Codex 会话（支持远程审批）
```

**注意：** 所有命令都支持短别名 `wsc`。例如：`wsc config list`

### Discord Slash Commands

- `/project setup`：把当前 Category 绑定到已挂载项目，并把当前频道设为控制频道
- `/project info`：查看项目绑定信息
- `/agent spawn`：在项目控制频道中创建主代理会话频道
- `/agent archive`：把当前会话归档到 `#history`
- `/agent mode` / `/agent goal` / `/agent persona` / `/agent model`
- `/subagent run`：在当前主会话下创建子代理线程
- `/subagent list`：查看当前会话的子代理
- `/shell run` / `/shell processes` / `/shell kill`


## 能力矩阵

| 能力 | 状态 | 入口 |
|---|---|---|
| 全局配置 | 稳定 | `workspacecord config *` |
| 显式本地项目挂载 | 稳定 | `workspacecord project *` |
| Discord 分类绑定 | 稳定 | `/project setup`, `/project info` |
| 项目级人格 | 可用 | `/project personality`, `/project personality-clear` |
| 项目级可复用技能 | 可用 | `/project skill-add`, `/project skill-list`, `/project skill-run` |
| 项目级 MCP 注册表 | 可用 | `/project mcp-add`, `/project mcp-list`, `/project mcp-remove` |
| 主代理会话 | 稳定 | `/agent spawn`, `/agent list`, `/agent archive`, `/agent cleanup` |
| 子代理线程 | 稳定 | `/subagent run`, `/subagent list` |
| 会话执行模式 | 稳定 | `/agent mode`, `/agent goal`, `/agent verbose` |
| 远程人工审批 / 门控 | 可用 | 交互卡、`monitor` 模式、Claude 权限处理 |
| 本地托管 Codex 启动 | 可用 | `workspacecord codex` |
| 本地会话发现 / 同步 | 可用 | hook / codex-log / sync 恢复路径 |
| 从 Discord 执行 shell | 可用 | `/shell run`, `/shell processes`, `/shell kill` |
| 历史归档 | 稳定 | `#history`, `/agent archive` |
| 守护进程安装 / 后台运行 | 可用 | `workspacecord daemon *` |

## 运行时架构

当前主运行路径：

```text
bot.ts
  -> BotEventRouter
    -> command handlers / button handler / message handler
      -> thread-manager façade
        -> session-registry / session runtime / state machine / panel adapter
          -> Discord delivery + status cards + summaries
```

这意味着 Discord 只是控制平面；真正的项目状态、provider 会话、审批、输出渲染都发生在运行 `workspacecord` 的本机上。

## 开发与验证

建议先运行基础验证：

```bash
pnpm typecheck
pnpm build
pnpm test
```

更多脚本：

```bash
pnpm test:integration:smoke
pnpm test:multi-session:smoke
pnpm test:session-sync:smoke
pnpm test:monitor:e2e
pnpm test:acceptance:local
```

另见：[`docs/ACCEPTANCE.md`](./docs/ACCEPTANCE.md)

## 贡献

欢迎贡献！请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md) 了解行为准则和提交流程。

## 许可证

本项目采用 MIT 许可证 - 详见 [LICENSE](./LICENSE) 文件。

## 致谢

本项目受以下项目启发：
- [agentcord](https://github.com/radu2lupu/agentcord) - AI 代理的 Discord 集成
- [clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk) - Claude 桌面集成
