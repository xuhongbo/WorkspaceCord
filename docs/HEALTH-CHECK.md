# workspacecord 服务健康检查和自动重启

## 任务目标

每小时检查一次 workspacecord Discord bot 服务是否正常运行，如果服务挂了就自动重启。

## 检查项

1. **daemon 服务状态**：检查 launchd 中的 `com.workspacecord` 服务是否在运行
2. **bot 进程存活**：检查 bot 进程是否真的在运行（通过锁文件和进程 ID）

## 自动重启流程

如果检测到服务异常，按以下步骤重启：

1. 卸载旧的 daemon 服务

   ```bash
   workspacecord daemon uninstall
   ```

2. 清理锁文件

   ```bash
   rm -f ~/.workspacecord/bot.lock
   ```

3. 重新安装并启动 daemon

   ```bash
   workspacecord daemon install
   ```

4. 等待 5 秒让服务完全启动

5. 验证重启是否成功

## 执行方式

### 方式 1：手动执行（测试用）

```bash
bash ~/Documents/github/workspacecord/scripts/health-check.sh
```

### 方式 2：安装定时任务（推荐）

```bash
bash ~/Documents/github/workspacecord/scripts/setup-health-check-cron.sh
```

这会创建一个 launchd 任务，每小时自动执行一次健康检查。

## 日志位置

- **健康检查日志**：`~/.workspacecord/health-check.log`
- **定时任务输出**：`~/.workspacecord/health-check-cron.log`
- **定时任务错误**：`~/.workspacecord/health-check-cron.error.log`

## 查看日志

```bash
# 查看最近的健康检查记录
tail -50 ~/.workspacecord/health-check.log

# 实时监控健康检查
tail -f ~/.workspacecord/health-check.log
```

## 卸载定时任务

```bash
launchctl unload ~/Library/LaunchAgents/com.workspacecord.health-check.plist
rm ~/Library/LaunchAgents/com.workspacecord.health-check.plist
```

## 验证定时任务是否运行

```bash
launchctl list | grep workspacecord
```

应该看到两个服务：

- `com.workspacecord` - 主服务
- `com.workspacecord.health-check` - 健康检查任务

## 注意事项

1. 健康检查脚本会自动记录所有操作到日志文件
2. 如果重启失败，会在日志中记录错误信息
3. 定时任务每小时执行一次，不会在系统启动时立即执行
4. 脚本使用 `set -e`，遇到错误会立即退出并记录
