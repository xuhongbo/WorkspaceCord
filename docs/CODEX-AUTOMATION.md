# Codex Automation: workspacecord 服务健康检查

## 配置说明

这是一个用于 Codex 桌面应用的 automation 配置，每小时检查 workspacecord 服务状态并自动重启（如果需要）。

## 在 Codex 桌面应用中设置

### 1. 打开 Codex 桌面应用

```bash
codex app /Users/ld/Documents/github/workspacecord
```

### 2. 创建 Automation

在 Codex 应用侧边栏点击 **Automations** → **New Automation**

### 3. 配置参数

**Name**: `workspacecord-health-check`

**Schedule**: `Hourly` (或使用 cron: `0 * * * *`)

**Sandbox Mode**: `workspace-write` (推荐) 或 `danger-full-access` (如果需要重启服务)

**Prompt**:

```
检查 workspacecord Discord bot 服务的健康状态并在需要时重新部署：

## 第一步：健康检查

1. 运行健康检查脚本：
   bash ~/Documents/github/workspacecord/scripts/health-check.sh

2. 分析输出：
   - 如果显示 "✅ All systems operational"，报告服务正常
   - 如果显示 "❌" 或 "⚠️"，说明服务异常，继续下一步

## 第二步：如果服务异常，执行完整部署流程

如果健康检查失败或服务无法重启，执行以下完整部署步骤：

1. 进入项目目录：
   cd ~/Documents/github/workspacecord

2. 更新 SDK 依赖（确保和本地 CLI 版本兼容）：
   pnpm update @anthropic-ai/claude-agent-sdk @openai/codex-sdk

3. 构建项目：
   pnpm build

4. 创建安装包：
   pnpm pack

5. 全局安装（使用完整路径）：
   pnpm install -g ~/Documents/github/workspacecord/workspacecord-*.tgz

6. 重启 daemon 服务：
   workspacecord daemon uninstall && workspacecord daemon install

7. 验证部署：
   sleep 3 && workspacecord daemon status

8. 清理安装包：
   rm ~/Documents/github/workspacecord/workspacecord-*.tgz

## 第三步：生成报告

生成详细的状态报告，包括：
- 服务状态（运行中/已重启/已重新部署/失败）
- Daemon PID
- Bot 进程 PID
- 执行的操作（健康检查/自动重启/完整部署）
- 任何错误或警告
- 最近的日志摘要（最后 10 行）

请将报告格式化为 markdown，便于审查。
```

**Review Queue**: `true` (启用审查队列，让你确认每次运行结果)

### 4. 高级配置（可选）

如果需要更精细的控制，可以在项目的 `.codex/` 目录创建配置文件：

**文件**: `/Users/ld/Documents/github/workspacecord/.codex/automations/health-check.toml`

```toml
[automation]
name = "workspacecord-health-check"
schedule = "0 * * * *"  # 每小时执行
enabled = true
review_required = true

[automation.sandbox]
mode = "workspace-write"
allowed_commands = [
    "bash",
    "tail",
    "workspacecord",
    "launchctl"
]

[automation.prompt]
content = """
检查 workspacecord 服务健康状态，必要时重新部署。

执行步骤：
1. 运行健康检查脚本
2. 如果服务正常，生成状态报告
3. 如果服务异常且自动重启失败，执行完整部署流程：
   - pnpm update (更新 SDK 依赖)
   - pnpm build
   - pnpm pack
   - pnpm install -g (使用完整路径)
   - workspacecord daemon uninstall && install
   - 验证部署成功
4. 生成详细报告
"""
```

## 替代方案：使用 Skill

如果你想更灵活地手动触发检查，可以创建一个 Codex Skill：

**文件**: `~/.codex/skills/workspacecord-monitor/SKILL.md`

```markdown
---
name: workspacecord-monitor
description: 检查 workspacecord Discord bot 服务状态并自动修复
---

# workspacecord 服务监控

检查 workspacecord Discord bot 的健康状态。

## 使用方法

在 Codex 中输入：
\`\`\`
$workspacecord-monitor
\`\`\`

## 执行步骤

1. 运行健康检查脚本
2. 分析服务状态
3. 如果需要，自动重启服务
4. 如果重启失败，执行完整部署流程：
   - 构建项目 (pnpm build)
   - 打包 (pnpm pack)
   - 全局安装 (pnpm install -g)
   - 重启 daemon
5. 生成状态报告
```

然后在 `config.toml` 中启用：

```toml
[[skills.config]]
path = "/Users/ld/.codex/skills/workspacecord-monitor/SKILL.md"
enabled = true
```

## 监控日志

Automation 运行后，可以在以下位置查看：

- **Codex 审查队列**：在 Codex 应用中查看每次运行的结果
- **健康检查日志**：`~/.workspacecord/health-check.log`
- **Bot 日志**：`~/.workspacecord/workspacecord.log`

## 注意事项

1. **审查队列很重要**：每次 automation 运行后都会进入审查队列，你需要手动批准或拒绝
2. **沙箱限制**：如果使用 `workspace-write` 模式，可能无法执行某些系统命令（如 `launchctl`）
3. **与 launchd 配合**：Codex automation 和 launchd 健康检查可以同时运行，互为补充
4. **Worktree 清理**：Codex 会为每次运行创建 worktree，记得定期清理已审查的运行

## 推荐配置

**最佳实践**：同时使用两种方式

- **launchd 定时任务**（已配置）：系统级保障，每小时自动检查和重启
- **Codex automation**：提供 AI 分析和智能报告，帮助你理解服务状态

这样既有可靠的自动化保障，又有智能的分析和建议。
