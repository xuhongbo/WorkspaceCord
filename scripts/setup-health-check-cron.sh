#!/bin/bash
# 设置 workspacecord 健康检查定时任务
# 使用 launchd (macOS) 每小时执行一次健康检查

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PLIST_PATH="$HOME/Library/LaunchAgents/com.workspacecord.health-check.plist"
SCRIPT_PATH="$SCRIPT_DIR/health-check.sh"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.workspacecord"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.workspacecord.health-check</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$SCRIPT_PATH</string>
    </array>
    <key>StartInterval</key>
    <integer>3600</integer>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>$HOME/.workspacecord/health-check-cron.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/.workspacecord/health-check-cron.error.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.npm-global/bin:$HOME/Library/pnpm:/opt/homebrew/bin:/usr/local/bin</string>
    </dict>
</dict>
</plist>
EOF

# 加载定时任务
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl unload "$HOME/Library/LaunchAgents/com.threadcord.health-check.plist" 2>/dev/null || true
launchctl load "$PLIST_PATH"

echo "✅ Health check cron job installed"
echo "📍 Plist: $PLIST_PATH"
echo "⏰ Interval: Every 1 hour"
echo "📝 Logs: $HOME/.workspacecord/health-check.log"
echo ""
echo "To test manually: bash $SCRIPT_PATH"
echo "To uninstall: launchctl unload $PLIST_PATH && rm $PLIST_PATH"
