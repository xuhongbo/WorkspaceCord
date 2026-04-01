#!/bin/bash
# workspacecord 健康检查和自动重启脚本
# 用途：检查 daemon 服务是否存活，如果挂了就自动重启，重启失败则执行完整部署

set -e

LOG_FILE="$HOME/.workspacecord/health-check.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

log() {
    echo "[$TIMESTAMP] $1" | tee -a "$LOG_FILE"
}

# 检查 daemon 是否在运行
check_daemon() {
    if launchctl list | grep -q "com.workspacecord"; then
        # 检查进程是否真的在运行
        local pid=$(launchctl list | grep com.workspacecord | awk '{print $1}')
        if [ "$pid" != "-" ] && [ -n "$pid" ]; then
            log "✅ Daemon is running (PID: $pid)"
            return 0
        fi
    fi
    log "❌ Daemon is not running"
    return 1
}

# 检查 bot 是否响应（通过检查锁文件和进程）
check_bot_alive() {
    local lock_file="$HOME/.workspacecord/bot.lock"

    if [ ! -f "$lock_file" ]; then
        log "⚠️  Lock file not found"
        return 1
    fi

    local pid=$(cat "$lock_file")
    if ps -p "$pid" > /dev/null 2>&1; then
        log "✅ Bot process is alive (PID: $pid)"
        return 0
    else
        log "❌ Bot process is dead (stale PID: $pid)"
        return 1
    fi
}

# 重启服务
restart_service() {
    log "🔄 Attempting to restart service..."

    # 卸载旧的 daemon
    workspacecord daemon uninstall 2>&1 | tee -a "$LOG_FILE"

    # 清理锁文件
    rm -f "$HOME/.workspacecord/bot.lock"

    # 重新安装并启动 daemon
    workspacecord daemon install 2>&1 | tee -a "$LOG_FILE"

    # 等待 5 秒让服务启动
    sleep 5

    # 验证重启是否成功
    if check_daemon && check_bot_alive; then
        log "✅ Service restarted successfully"
        return 0
    else
        log "❌ Service restart failed, attempting full deployment..."
        return 1
    fi
}

# 完整部署流程（当简单重启失败时使用）
full_deployment() {
    log "🚀 Starting full deployment process..."

    local project_dir="$HOME/Documents/github/workspacecord"

    # 检查项目目录是否存在
    if [ ! -d "$project_dir" ]; then
        log "❌ Project directory not found: $project_dir"
        return 1
    fi

    cd "$project_dir" || {
        log "❌ Failed to enter project directory"
        return 1
    }

    # 1. 更新 SDK 依赖（跟上本地 CLI 版本）
    log "📦 Updating SDK dependencies..."
    pnpm update @anthropic-ai/claude-agent-sdk @openai/codex-sdk 2>&1 | tee -a "$LOG_FILE" || true

    # 2. 构建项目
    log "📦 Building project..."
    if ! pnpm build 2>&1 | tee -a "$LOG_FILE"; then
        log "❌ Build failed"
        return 1
    fi

    # 3. 创建安装包
    log "📦 Creating package..."
    if ! pnpm pack 2>&1 | tee -a "$LOG_FILE"; then
        log "❌ Pack failed"
        return 1
    fi

    # 4. 全局安装
    log "📦 Installing globally..."
    local tgz_file=$(ls workspacecord-*.tgz 2>/dev/null | head -1)
    if [ -z "$tgz_file" ]; then
        log "❌ Package file not found"
        return 1
    fi

    if ! pnpm install -g "$project_dir/$tgz_file" 2>&1 | tee -a "$LOG_FILE"; then
        log "❌ Global install failed"
        rm -f "$tgz_file"
        return 1
    fi

    # 5. 清理安装包
    rm -f "$tgz_file"

    # 6. 重启 daemon
    log "🔄 Restarting daemon..."
    workspacecord daemon uninstall 2>&1 | tee -a "$LOG_FILE"
    rm -f "$HOME/.workspacecord/bot.lock"
    workspacecord daemon install 2>&1 | tee -a "$LOG_FILE"

    # 7. 等待并验证
    sleep 5

    if check_daemon && check_bot_alive; then
        log "✅ Full deployment completed successfully"
        return 0
    else
        log "❌ Full deployment failed"
        return 1
    fi
}

# 主逻辑
main() {
    log "=== Health Check Started ==="

    if check_daemon; then
        if check_bot_alive; then
            log "✅ All systems operational"
            exit 0
        else
            log "⚠️  Daemon running but bot process is dead"
            if restart_service; then
                exit 0
            else
                log "⚠️  Simple restart failed, trying full deployment..."
                full_deployment
                exit $?
            fi
        fi
    else
        log "⚠️  Daemon is not running"
        if restart_service; then
            exit 0
        else
            log "⚠️  Simple restart failed, trying full deployment..."
            full_deployment
            exit $?
        fi
    fi

    log "=== Health Check Completed ==="
}

main
