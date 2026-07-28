#!/bin/bash
# <xbar.title>AI Cockpit</xbar.title>
# <xbar.desc>今日 AI 消费 / 配速 / 5h 窗口倒计时 / Agent 会话 / 仓库更新 / Skills</xbar.desc>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>

python3 - <<'PYEOF'
import json, urllib.request, subprocess

API = "http://localhost:4777"
# 本机服务直连,绕过系统 HTTP 代理(否则 502)
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
urllib.request.install_opener(_opener)
INK = "#2b2620,#e8e3da"      # 正文(浅色,深色)
MUT = "#6f6558,#a89c8e"      # 次要
RED = "#d43d2a,#ff6b57"
GRN = "#3c9d52,#5fc476"

def get(path, timeout=25):
    try:
        with urllib.request.urlopen(API + path, timeout=timeout) as r:
            return json.load(r)
    except Exception:
        return None

d = get("/api/menubar")
if not d:
    print("🛩 –")
    print("---")
    print(f"AI Cockpit 服务未运行 | color={RED}")
    print("启动服务 | bash=/bin/bash param1=-c param2='launchctl kickstart gui/501/app.aicockpit.server' terminal=false refresh=true")
    raise SystemExit

today = d.get("today", 0); budget = d.get("budget", 200) or 200
pct = min(100, round(today / budget * 100))
filled = round(pct / 100 * 8)
bar = "▰" * filled + "▱" * (8 - filled)
mins = d.get("windowEndsInMin", 0)
agents = d.get("agents", [])
live = sum(1 for a in agents if a.get("cpu", 0) > 3)
icon = "🔥" if pct >= 80 else "🛩"

print(f"{icon} ${today:.0f} {bar}")
print("---")
def tokfmt(v):
    v = v or 0
    if v >= 1e9: return f"{v/1e9:.2f}B"
    if v >= 1e6: return f"{v/1e6:.1f}M"
    if v >= 1e3: return f"{v/1e3:.0f}k"
    return str(int(v))

print(f"今日消费  ${today:.2f} / 预算 ${budget:.0f}({pct}%) | font=Menlo color={INK}")
print(f"今日 tokens  ≈{tokfmt(d.get('todayTok'))} | font=Menlo color={INK}")
print(f"5h 窗口重置  {mins//60}h {mins%60}m 后 | font=Menlo color={INK}")
avg7 = d.get("avg7", 0)
if avg7 > 0:
    ratio = today / avg7
    if ratio > 1.15:
        print(f"配速  超过 7 日均值 {round((ratio-1)*100)}% — 会提前用完 | font=Menlo color={RED}")
    elif ratio < 0.85:
        print(f"配速  低于 7 日均值 {round((1-ratio)*100)}% — 有富余 | font=Menlo color={GRN}")
    else:
        print(f"配速  On pace | font=Menlo color={GRN}")
print("---")
print(f"近 7 天  ${d.get('d7',0):.2f} · ≈{tokfmt(d.get('d7Tok'))} tok | color={INK} font=Menlo")
print(f"本月至今  ${d.get('monthToDate',0):.2f} · ≈{tokfmt(d.get('monthToDateTok'))} tok | color={INK} font=Menlo")
print(f"预估全月  ${d.get('projMonth',0):.2f} · ≈{tokfmt(d.get('projMonthTok'))} tok | color={RED} font=Menlo")

tf = d.get("topFolders", [])
if tf:
    print("---")
    print(f"Top 文件夹(本日) | color={MUT}")
    for f in tf:
        print(f"{f['name']}  ≈{tokfmt(f.get('tok'))} tok · ${f['cost']:.2f} | font=Menlo color={INK} href={API}")

if agents:
    print("---")
    print(f"运行中的 Agent 会话({live} 活跃 / {len(agents)}) | color={MUT}")
    for a in agents:
        dot = "●" if a.get("cpu", 0) > 3 else "○"
        name = (a.get("cwd") or "?").rstrip("/").split("/")[-1] or "?"
        kind = "Claude" if a["kind"] == "claude" else "Codex"
        col = GRN if a.get("cpu", 0) > 3 else MUT
        print(f"{dot} {kind} · {name} | color={col} bash=/usr/bin/osascript param1=-e param2='tell application \"Terminal\" to activate' terminal=false")

# ---- GitHub 仓库一键更新 ----
rp = get("/api/repos", timeout=20)
if rp and rp.get("repos"):
    print("---")
    print(f"GitHub 仓库 | color={MUT}")
    for r in rp["repos"]:
        if r.get("error"):
            print(f"⚠️ {r['name']} — {r['error']} | color={RED}")
            continue
        behind = r.get("behind", 0)
        mark = f"⬇︎{behind} 落后" if behind else "✓ 最新"
        dirty = " ✎本地未提交" if r.get("dirty") else ""
        from urllib.parse import quote
        cmd = f"curl -s '{API}/api/repo-update?path={quote(r['path'])}'"
        col = INK if behind else MUT
        print(f"{r['name']}  {r.get('branch','')} · {mark}{dirty} · {r.get('last','')} — 点击更新 | font=Menlo color={col} bash=/bin/bash param1=-c param2=\"{cmd}\" terminal=false refresh=true")

print("---")
print(f"Skills 技能库(见仪表盘底部) | href={API} color={INK}")
print(f"打开 AI Cockpit 仪表盘 | href={API} color={INK}")
print("刷新 | refresh=true color=" + INK)
PYEOF
