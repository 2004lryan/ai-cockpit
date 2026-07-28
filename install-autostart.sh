#!/bin/bash
# Install AI Cockpit as a LaunchAgent so the server starts on login.
# 优先使用 /Applications/AI Cockpit.app 里的单文件二进制(./build-app.sh 生成);
# 没有的话退回用 bun 直接跑源码。
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="/Applications/AI Cockpit.app/Contents/MacOS/ai-cockpit-server"
PLIST=~/Library/LaunchAgents/app.aicockpit.server.plist
mkdir -p ~/Library/LaunchAgents

# COCKPIT_FROM_SOURCE=1 强制用 bun 跑源码,不用打包好的二进制。
# 为什么会需要它:build-app.sh 产出的是 ad-hoc 临时签名,而 macOS 不给「临时签名
# + launchd 启动」的进程认完全磁盘访问 —— 表现为个人上下文采集器在自启服务里永远
# 读不到东西(从终端手跑却正常,因为那时的责任进程是终端)。改用 bun(正式开发者
# 签名)跑源码、把 FDA 授给 bun 本体即可,且此后改代码不会再让授权失效。
if [ -x "$BIN" ] && [ "${COCKPIT_FROM_SOURCE:-}" != "1" ]; then
  PROG="<string>$BIN</string>"
  echo "▸ 运行方式:打包二进制 $BIN"
else
  BUN="$(command -v bun || echo /usr/local/bin/bun)"
  BUN="$(readlink -f "$BUN" 2>/dev/null || echo "$BUN")"  # TCC 认真实文件,不认软链
  PROG="<string>$BUN</string><string>run</string><string>$DIR/server.ts</string>"
  echo "▸ 运行方式:源码 $BUN run $DIR/server.ts"
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
