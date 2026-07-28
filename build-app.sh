#!/bin/bash
# 把 AI Cockpit 打包成 /Applications/AI Cockpit.app(单文件二进制,双击打开仪表盘)。
# 改了代码之后重新运行本脚本即可更新应用;LaunchAgent 会自动用新二进制。
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="/Applications/AI Cockpit.app"

echo "▸ 编译单文件二进制…"
cd "$DIR"
bun build --compile server.ts --outfile dist/ai-cockpit-server

echo "▸ 组装 .app…"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp dist/ai-cockpit-server "$APP/Contents/MacOS/ai-cockpit-server"
[ -f "$DIR/assets/AppIcon.icns" ] && cp "$DIR/assets/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
# 菜单栏脚本随 app 走:SwiftBar 插件软链指向这里,仓库换目录也不会断
cp "$DIR/menubar/ai-cockpit.1m.sh" "$APP/Contents/Resources/ai-cockpit.1m.sh"
chmod +x "$APP/Contents/Resources/ai-cockpit.1m.sh"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>AI Cockpit</string>
  <key>CFBundleDisplayName</key><string>AI Cockpit</string>
  <key>CFBundleIdentifier</key><string>app.aicockpit</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleExecutable</key><string>AI Cockpit</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
</dict></plist>
PLIST

echo "▸ 编译原生窗口壳(WKWebView)…"
xcrun swiftc -O "$DIR/native/main.swift" -o "$APP/Contents/MacOS/AI Cockpit" -framework Cocoa -framework WebKit
/usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity dict" -c "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true" "$APP/Contents/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :NSHighResolutionCapable bool true" "$APP/Contents/Info.plist" 2>/dev/null || true

chmod +x "$APP/Contents/MacOS/AI Cockpit" "$APP/Contents/MacOS/ai-cockpit-server"
codesign --force --deep -s - "$APP" >/dev/null 2>&1 || true
launchctl kickstart -k gui/$(id -u)/app.aicockpit.server 2>/dev/null || true
echo "✅ 完成:$APP(服务已切换到新二进制)"
