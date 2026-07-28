#!/bin/bash
# Install AI Cockpit as a LaunchAgent so the server starts on login.
# 优先使用 /Applications/AI Cockpit.app 里的单文件二进制(./build-app.sh 生成);
# 没有的话退回用 bun 直接跑源码。
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="/Applications/AI Cockpit.app/Contents/MacOS/ai-cockpit-server"
PLIST=~/Library/LaunchAgents/app.aicockpit.server.plist
mkdir -p ~/Library/LaunchAgents

if [ -x "$BIN" ]; then
  PROG="<string>$BIN</string>"
else
  BUN="$(command -v bun || echo /usr/local/bin/bun)"
  PROG="<string>$BUN</string><string>run</string><string>$DIR/server.ts</string>"
fi

# launchd 不继承你的 shell 环境,所以配置只能写死进 plist。这里把安装时设置的
# Cockpit 变量透传进去,例如:  COCKPIT_PERSONAL=1 ./install-autostart.sh
# 想改配置就带着新值重跑本脚本;不带任何变量重跑 = 全部回到默认值。
EXTRA_ENV=""
for v in COCKPIT_PERSONAL COCKPIT_DAILY_BUDGET PORT FUSION_LOG_DIR; do
  eval "val=\${$v-}"
  if [ -n "$val" ]; then
    EXTRA_ENV="$EXTRA_ENV
    <key>$v</key><string>$val</string>"
    echo "▸ 透传 $v=$val"
  fi
done

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>app.aicockpit.server</string>
  <key>ProgramArguments</key>
  <array>
    $PROG
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>$EXTRA_ENV
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/ai-cockpit.log</string>
  <key>StandardErrorPath</key><string>/tmp/ai-cockpit.err</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/app.aicockpit.server" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✅ 已安装自启动: $PLIST"
echo "   卸载: launchctl bootout gui/\$(id -u)/app.aicockpit.server && rm $PLIST"
