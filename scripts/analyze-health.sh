#!/bin/bash
# Codex skill: 分析 workspacecord 健康检查日志并提供建议

LOG_FILE="$HOME/.workspacecord/health-check.log"
ERROR_LOG="$HOME/.workspacecord/workspacecord.error.log"

echo "=== workspacecord Health Check Analysis ==="
echo ""

# 显示最近的健康检查记录
echo "📊 Recent Health Checks (last 10):"
tail -20 "$LOG_FILE" | grep "Health Check" -A 3 | tail -40
echo ""

# 检查是否有重启记录
echo "🔄 Recent Restarts:"
grep "Attempting to restart" "$LOG_FILE" | tail -5 || echo "No restarts found"
echo ""

# 检查错误日志
echo "❌ Recent Errors:"
tail -20 "$ERROR_LOG" 2>/dev/null || echo "No errors found"
echo ""

# 当前状态
echo "✅ Current Status:"
workspacecord daemon status
echo ""

# 统计信息
echo "📈 Statistics:"
echo "- Total health checks: $(grep -c "Health Check Started" "$LOG_FILE" 2>/dev/null || echo 0)"
echo "- Failed checks: $(grep -c "not running" "$LOG_FILE" 2>/dev/null || echo 0)"
echo "- Successful restarts: $(grep -c "restarted successfully" "$LOG_FILE" 2>/dev/null || echo 0)"
echo "- Failed restarts: $(grep -c "restart failed" "$LOG_FILE" 2>/dev/null || echo 0)"
