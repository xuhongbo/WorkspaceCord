#!/bin/bash
# workspacecord 健康检查和自动重启脚本
# 用途：检查 daemon 服务是否存活，如果挂了就自动重启，重启失败则执行完整部署

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${WORKSPACECORD_PROJECT_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
DATA_DIR="${WORKSPACECORD_DATA_DIR:-$HOME/.workspacecord}"
export PATH="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}:$HOME/.npm-global/bin:$HOME/Library/pnpm:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

LOG_FILE="$DATA_DIR/health-check.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

mkdir -p "$DATA_DIR"

log() {
    echo "[$TIMESTAMP] $1" | tee -a "$LOG_FILE"
}

resolve_cli() {
    if [ -n "${WORKSPACECORD_CLI:-}" ]; then
        if [ -x "${WORKSPACECORD_CLI}" ]; then
            echo "${WORKSPACECORD_CLI}"
            return 0
        fi
        if command -v "${WORKSPACECORD_CLI}" >/dev/null 2>&1; then
            command -v "${WORKSPACECORD_CLI}"
            return 0
        fi
    fi

    for candidate in workspacecord threadcord; do
        if command -v "$candidate" >/dev/null 2>&1; then
            command -v "$candidate"
            return 0
        fi
    done

    return 1
}

resolve_package_name() {
    if [ ! -f "$PROJECT_DIR/package.json" ]; then
        return 1
    fi

    node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).name)" "$PROJECT_DIR/package.json"
}

PACKAGE_NAME="$(resolve_package_name || true)"

# 检查 daemon 是否在运行
check_daemon() {
    local launchctl_output
    launchctl_output="$(launchctl list 2>/dev/null || true)"

    if printf '%s\n' "$launchctl_output" | grep -q "com.workspacecord"; then
        # 检查进程是否真的在运行
        local pid
        pid=$(printf '%s\n' "$launchctl_output" | awk '$3 == "com.workspacecord" { print $1; exit }')
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
    local lock_file="$DATA_DIR/bot.lock"

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

    local cli_bin
    cli_bin="$(resolve_cli || true)"

    if [ -z "$cli_bin" ]; then
        log "❌ CLI command not found (tried workspacecord/threadcord)"
        return 1
    fi

    # 卸载旧的 daemon
    "$cli_bin" daemon uninstall 2>&1 | tee -a "$LOG_FILE"

    # 清理锁文件
    rm -f "$DATA_DIR/bot.lock"

    # 重新安装并启动 daemon
    "$cli_bin" daemon install 2>&1 | tee -a "$LOG_FILE"

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

    local project_dir="$PROJECT_DIR"

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
    rm -f "$project_dir"/*.tgz
    if ! pnpm pack 2>&1 | tee -a "$LOG_FILE"; then
        log "❌ Pack failed"
        return 1
    fi

    # 4. 全局安装
    log "📦 Installing globally..."
    local tgz_file=""
    if [ -n "$PACKAGE_NAME" ]; then
        tgz_file=$(find "$project_dir" -maxdepth 1 -type f -name "${PACKAGE_NAME}-*.tgz" -print | head -1)
        tgz_file="${tgz_file#$project_dir/}"
    fi
    if [ -z "$tgz_file" ]; then
        tgz_file=$(find "$project_dir" -maxdepth 1 -type f -name '*.tgz' -print | head -1)
        tgz_file="${tgz_file#$project_dir/}"
    fi
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
    local cli_bin
    cli_bin="$(resolve_cli || true)"
    if [ -z "$cli_bin" ]; then
        log "❌ CLI command not found (tried workspacecord/threadcord)"
        return 1
    fi
    "$cli_bin" daemon uninstall 2>&1 | tee -a "$LOG_FILE"
    rm -f "$DATA_DIR/bot.lock"
    "$cli_bin" daemon install 2>&1 | tee -a "$LOG_FILE"

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
