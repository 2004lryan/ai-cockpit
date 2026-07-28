// AI Cockpit 原生窗口壳:确保后台服务在跑,然后在自己的窗口里渲染仪表盘(WKWebView)。
import Cocoa
import WebKit

let PORT = ProcessInfo.processInfo.environment["PORT"] ?? "4777"
let HOME = "http://localhost:\(PORT)"

func serverUp() -> Bool {
  var ok = false
  let sem = DispatchSemaphore(value: 0)
  var req = URLRequest(url: URL(string: HOME)!, timeoutInterval: 1.5)
  req.httpMethod = "HEAD"
  URLSession.shared.dataTask(with: req) { _, r, _ in
    if let h = r as? HTTPURLResponse, h.statusCode < 500 { ok = true }
    sem.signal()
  }.resume()
  sem.wait()
  return ok
}

func ensureServer() {
  if serverUp() { return }
  // 优先踢 LaunchAgent;没有再直接拉起 app 内的二进制
  let kick = Process()
  kick.executableURL = URL(fileURLWithPath: "/bin/launchctl")
  kick.arguments = ["kickstart", "gui/\(getuid())/app.aicockpit.server"]
  try? kick.run()
  kick.waitUntilExit()
  if kick.terminationStatus != 0 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: Bundle.main.bundlePath + "/Contents/MacOS/ai-cockpit-server")
    try? p.run()
  }
  for _ in 0..<60 {
    if serverUp() { return }
    usleep(300_000)
  }
}

// 自检菜单栏组件:软链指向 app 内的脚本(仓库搬家也不会断)、插件没被禁用、SwiftBar 在跑。
func ensureMenubar() {
  let fm = FileManager.default
  let ws = NSWorkspace.shared
  guard ws.urlForApplication(withBundleIdentifier: "com.ameba.SwiftBar") != nil else { return }
  let src = Bundle.main.bundlePath + "/Contents/Resources/ai-cockpit.1m.sh"
  guard fm.fileExists(atPath: src) else { return }

  let dir = NSHomeDirectory() + "/Library/Application Support/SwiftBar/Plugins"
  let link = dir + "/ai-cockpit.1m.sh"
  var changed = false
  try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
  if (try? fm.destinationOfSymbolicLink(atPath: link)) != src {
    try? fm.removeItem(atPath: link)   // 断链/旧路径/普通文件都先清掉
    try? fm.createSymbolicLink(atPath: link, withDestinationPath: src)
    changed = true
  }

  if let d = UserDefaults(suiteName: "com.ameba.SwiftBar") {
    if (d.string(forKey: "PluginDirectory") ?? "").isEmpty {
      d.set(dir, forKey: "PluginDirectory"); changed = true
    }
    let disabled = (d.array(forKey: "DisabledPlugins") as? [String]) ?? []
    if disabled.contains(where: { $0.hasPrefix("ai-cockpit") }) {
      d.set(disabled.filter { !$0.hasPrefix("ai-cockpit") }, forKey: "DisabledPlugins")
      changed = true
    }
    d.synchronize()
  }

  let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.ameba.SwiftBar")
  if running.isEmpty {
    launchSwiftBar()
  } else if changed {                  // 改了配置才重启,平时不打扰
    running.forEach { $0.terminate() }
    for _ in 0..<20 {
      if NSRunningApplication.runningApplications(withBundleIdentifier: "com.ameba.SwiftBar").isEmpty { break }
      usleep(200_000)
    }
    launchSwiftBar()
  }
}

func launchSwiftBar() {
  guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.ameba.SwiftBar") else { return }
  let cfg = NSWorkspace.OpenConfiguration()
  cfg.activates = false               // 别把焦点从仪表盘抢走
  NSWorkspace.shared.openApplication(at: url, configuration: cfg)
}

class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate {
  var window: NSWindow!
  var webView: WKWebView!

  func applicationDidFinishLaunching(_ n: Notification) {
    ensureServer()
    let rect = NSRect(x: 0, y: 0, width: 1440, height: 920)
    window = NSWindow(contentRect: rect, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = "AI Cockpit"
    window.minSize = NSSize(width: 900, height: 600)
    window.center()
    window.setFrameAutosaveName("AICockpitMain")
    let cfg = WKWebViewConfiguration()
    cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
    webView = WKWebView(frame: rect, configuration: cfg)
    webView.uiDelegate = self          // 不接管的话 alert/confirm/prompt 全是空操作
    webView.autoresizingMask = [.width, .height]
    window.contentView = webView
    webView.load(URLRequest(url: URL(string: HOME)!))
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    DispatchQueue.global(qos: .utility).async { ensureMenubar() }  // 不挡窗口显示
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }

  // 已在运行时再点图标/Dock:把窗口拿回来,顺便再自检一次菜单栏
  func applicationShouldHandleReopen(_ s: NSApplication, hasVisibleWindows f: Bool) -> Bool {
    if !f { window.makeKeyAndOrderFront(nil) }
    NSApp.activate(ignoringOtherApps: true)
    DispatchQueue.global(qos: .utility).async { ensureMenubar() }
    return true
  }

  @objc func reload(_ sender: Any?) { webView.reload() }

  // ---- JS 对话框(WKWebView 必须自己弹,否则 confirm 恒 false、prompt 恒 null,
  //      删除/重命名这类按钮点了会毫无反应)----
  func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage msg: String,
               initiatedByFrame f: WKFrameInfo, completionHandler done: @escaping () -> Void) {
    let a = NSAlert()
    a.messageText = msg
    a.addButton(withTitle: "好")
    a.beginSheetModal(for: window) { _ in done() }
  }

  func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage msg: String,
               initiatedByFrame f: WKFrameInfo, completionHandler done: @escaping (Bool) -> Void) {
    let a = NSAlert()
    a.messageText = msg
    a.addButton(withTitle: "确定")
    a.addButton(withTitle: "取消")
    a.beginSheetModal(for: window) { r in done(r == .alertFirstButtonReturn) }
  }

  func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
               defaultText: String?, initiatedByFrame f: WKFrameInfo,
               completionHandler done: @escaping (String?) -> Void) {
    let a = NSAlert()
    a.messageText = prompt
    a.addButton(withTitle: "确定")
    a.addButton(withTitle: "取消")
    let tf = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
    tf.stringValue = defaultText ?? ""
    a.accessoryView = tf
    a.layout()
    a.window.initialFirstResponder = tf
    a.beginSheetModal(for: window) { r in done(r == .alertFirstButtonReturn ? tf.stringValue : nil) }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate

// 菜单:Cmd+Q/W、编辑(拷贝粘贴)、Cmd+R 刷新
let mainMenu = NSMenu()
let appItem = NSMenuItem()
mainMenu.addItem(appItem)
let appMenu = NSMenu()
appMenu.addItem(withTitle: "关于 AI Cockpit", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
appMenu.addItem(NSMenuItem.separator())
appMenu.addItem(withTitle: "隐藏", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
appMenu.addItem(withTitle: "退出 AI Cockpit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
appItem.submenu = appMenu

let editItem = NSMenuItem()
mainMenu.addItem(editItem)
let editMenu = NSMenu(title: "编辑")
editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
editMenu.addItem(NSMenuItem.separator())
editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
editItem.submenu = editMenu

let viewItem = NSMenuItem()
mainMenu.addItem(viewItem)
let viewMenu = NSMenu(title: "显示")
viewMenu.addItem(withTitle: "刷新", action: #selector(AppDelegate.reload(_:)), keyEquivalent: "r")
viewItem.submenu = viewMenu

let winItem = NSMenuItem()
mainMenu.addItem(winItem)
let winMenu = NSMenu(title: "窗口")
winMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
winMenu.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
winItem.submenu = winMenu

app.mainMenu = mainMenu
app.run()
