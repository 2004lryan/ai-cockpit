# 🛩️ AI Cockpit

A local dashboard for your AI coding assistants. It reads the session logs that
**Claude Code** and **Codex CLI** already write to disk, and turns them into one page:
what you worked on, what it cost, what is running right now.

**macOS · Bun · single-file binary · everything stays on your machine.**

There is no account, no telemetry, and no outbound request except the ones you trigger
yourself (`git pull` on repos you listed, and a local `claude -p` call if you ask for a
written summary).

> Built for my own workflow first, then cleaned up for release. It is macOS-only, it has
> no test suite, and some defaults (pricing tables, budget thresholds) reflect how I use
> these tools. Issues and PRs welcome.

---

## What you get

- **Usage & cost** — tokens, list-price cost, cache hit rate and how much caching saved
  you. Broken down by model, by session, by agent, by day, by hour-of-week.
- **Session browser** — Claude Code and Codex sessions merged per folder, with badges,
  branch, model, message count and cost. Full-text search, date filters, and a detail
  view that renders thinking blocks, tool cards, ANSI colour, diffs, todo changes,
  sub-agents and images. Large sessions stay responsive (paged + virtualised, search runs
  in a Web Worker).
- **Session management** — copy the resume command, reopen several sessions in separate
  terminals, rename, batch-delete to Trash, reveal in Finder.
- **Archive** — one click to copy every Claude session into `~/.ai-cockpit/archives/`,
  because Claude Code prunes its own logs after 30 days. Includes an "expiring soon" list.
  A background mirror keeps that safety net current — but it **turns itself off** if your
  `cleanupPeriodDays` is above 90 days, since nothing is being pruned and the mirror would
  just be a second copy of files you already have (easily gigabytes). Force it either way
  with `COCKPIT_BACKUP=1` / `COCKPIT_BACKUP=0`; the manual archive button always works.
- **Live system panel** — CPU / memory / battery / network, plus the Claude and Codex
  sessions running right now (click one to focus its terminal).
- **Menu bar widget** (optional, needs [SwiftBar](https://github.com/swiftbar/SwiftBar)) —
  today's spend, budget percentage, 5-hour window reset countdown, pace, top folders,
  running agents, and one-click `git pull --rebase --autostash` for repos you list.
- **Stage summary** — asks your local `claude -p` to write "what did I actually do this
  period" from the session digest.

---

## Requirements

- macOS 12+
- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- Optional: [SwiftBar](https://github.com/swiftbar/SwiftBar) for the menu-bar widget
- Optional: Claude Code on `PATH` for the stage summary

## Run it

```bash
git clone https://github.com/2004lryan/ai-cockpit.git
cd ai-cockpit
bun install
bun run start          # → http://localhost:4777
```

Install it as a real app instead:

```bash
./build-app.sh         # compiles a single-file binary into /Applications/AI Cockpit.app
./install-autostart.sh # LaunchAgent so the server comes up at login
```

`build-app.sh` also drops the menu-bar script inside the `.app` bundle and points the
SwiftBar symlink at it, so moving or renaming this repo will not break the widget.

---

## Privacy

**Default install: the only thing read is AI-assistant session logs.**

| | Read by default | Notes |
|---|---|---|
| `~/.claude/projects/**/*.jsonl` | ✅ | Claude Code sessions — the whole point of the tool |
| `~/.codex/sessions/**/rollout-*.jsonl` | ✅ | Codex CLI sessions |
| `~/.fusion/logs/**/*.json` | ✅ | Only exists if you use the optional fusion integration |
| Browser history (Chrome/Edge/Brave/Arc/Safari) | ❌ opt-in | `COCKPIT_PERSONAL=1` |
| Screen Time / app foreground time (`knowledgeC.db`) | ❌ opt-in | `COCKPIT_PERSONAL=1` |
| WeChat / QQ activity | ❌ opt-in | `COCKPIT_PERSONAL=1` |

The last three are the "personal context" collectors. They exist so the stage summary can
say *"you spent 6h in the editor and 2h in a browser"* instead of only talking about
tokens. **They are off unless you explicitly set `COCKPIT_PERSONAL=1`** — see
`src/personal.ts`, which short-circuits before any collector runs.

If you do turn them on:

- **Chat content is never read.** WeChat and QQ message stores are SQLCipher-encrypted and
  this tool makes no attempt to decrypt them. What it reports is presence, how many
  message databases exist, and the newest database mtime as a "last active" proxy —
  timestamps only, no text. See `src/im.ts`.
- Browser history is read from a **temporary copy** of the SQLite file (the browser holds
  a lock on the original) and the copy is deleted afterwards. Read-only, never written back.
- Safari and Screen Time need Full Disk Access. If you do not grant it, those two sources
  are simply missing and everything else still works.
- The aggregated digest is passed to your **local** `claude -p` process when you request a
  stage summary. That call goes to Anthropic like any other Claude Code prompt — if you
  do not want that, do not enable the collectors, or do not use the summary button.

Nothing is uploaded anywhere else. All caches and archives live under `~/.ai-cockpit/`.

---

## Configuration

All optional, all environment variables:

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4777` | HTTP port |
| `COCKPIT_PERSONAL` | unset | `1` enables the browser / Screen Time / IM collectors (see Privacy) |
| `COCKPIT_DAILY_BUDGET` | `200` | Daily spend in USD; drives the 50% / 80% notifications |
| `COCKPIT_BACKUP` | auto | `0` / `1` to force the background session mirror off / on. Auto = off when `cleanupPeriodDays` > 90 |
| `FUSION_LOG_DIR` | `~/.fusion/logs` | Where to look for fusion run logs |

`launchd` does not inherit your shell environment, so for the autostart service these have to
be baked into the plist. `install-autostart.sh` passes through whichever of the four are set
when you run it — re-run it with new values to change the configuration, or with none to
reset everything to defaults:

```bash
COCKPIT_PERSONAL=1 COCKPIT_DAILY_BUDGET=50 ./install-autostart.sh
```

⚠️ **Full Disk Access is per-binary, and re-signing revokes it.** The LaunchAgent runs
`/Applications/AI Cockpit.app/Contents/MacOS/ai-cockpit-server` directly, so that binary —
not just the `.app` — is what needs FDA in System Settings → Privacy & Security. Since
`build-app.sh` ad-hoc re-signs on every build, a rebuild can invalidate an existing grant. If
`COCKPIT_PERSONAL=1` is set but browsing and Screen Time come back empty (`fdaMissing: true`
on `/api/personal`), that is what happened.

Files it writes, all under `~/.ai-cockpit/`:

| File | Purpose |
|---|---|
| `scan-cache.json` | Incremental scan cache (keyed on mtime + size) |
| `archives/` | Your archived Claude sessions |
| `repos.json` | Repos shown in the menu-bar updater (defaults to git repos under `~/skills`) |
| `skill-zh.json` | Cached one-line skill descriptions |
| `history-baseline.json` | Optional pre-disk usage baseline (see below) |
| `relay-pricing.json` | Optional per-model relay prices that override the built-in table |

---

## How cost is computed

Costs use each model's official list price (`src/pricing.ts`) and line up with
[ccusage](https://github.com/ryoppippi/ccusage) to within 2%:

- Sub-agent (`<session>/subagents/agent-*.jsonl`) and sidechain usage is attributed to the
  parent session.
- Cache writes are priced separately for 5m and 1h TTL (Claude Code defaults to 1h, where
  the write price is 2× the input price).
- For Codex, billed input = `input − cached`; token accounting matches ccusage and prices
  come from the LiteLLM table.
- The cost-composition card splits by the real model recorded on each API entry, so the
  cards are internally consistent rather than approximated from a session-level model tag.

Two optional inputs:

- **History baseline** — Claude Code deletes sessions after 30 days. If you happen to have
  a [Tokipet](https://tokipet.app) ledger, the portion *older* than your oldest on-disk
  session is folded in to fill the gap, and snapshotted so it survives uninstalling Tokipet.
- **Relay pricing** — if you route some models through a third-party relay, its prices are
  not the official ones. Export the relay's billing CSV and run
  `bun scripts/calibrate.ts <bill.csv>` (add `--apply` to write the calibrated table).

---

## Optional: fusion logging

If you use a multi-model review skill, have it write one JSON per run into
`~/.fusion/logs/YYYY/MM/fusion-*.json` (question plus each model's full answer) and
Cockpit will file those runs under the folder they were launched from and price them with
the relay table. Nothing in this repo depends on it — the panel is simply empty if the
directory does not exist.

---

## 中文说明

本地运行的 AI 编程助手驾驶舱：把 **Claude Code / Codex / Fusion 多模型评审**的历史、
成本、系统状态合并到一个单页仪表盘，并配菜单栏组件。**数据不出机器。**

> ⚠️ **隐私默认口径**：全新安装只读 AI 助手的会话日志。浏览器历史、屏幕使用时间、
> 微信/QQ 活跃度这三类采集器**默认关闭**，须显式设 `COCKPIT_PERSONAL=1` 才启用；
> 即便启用，**聊天内容一律不解密、不读取**，只看数据库时间戳与前台时长。

### 启动

**作为应用**：双击 `/Applications/AI Cockpit.app` —— 自动确保后台服务在跑并打开仪表盘。
服务本体是单文件二进制（app 内的 `ai-cockpit-server`，bun compile 产物），登录自启（LaunchAgent）。

```bash
bun install
bun run start          # 开发模式直接跑源码 → http://localhost:4777
./build-app.sh         # 改代码后重新打包 .app（并热切换 LaunchAgent 到新二进制）
./install-autostart.sh # 重装登录自启动（优先用 .app 里的二进制）
```

### 功能地图

**总览仪表盘（单页，Today/7d/30d/3m/1y/All）**
- 概览卡：总 tokens · List 成本 · 缓存效率（命中率 + 省下多少钱）
- 成本洞察：输出/输入/缓存写/缓存读 构成条 + 明细
- 节奏：近 7 日均 · 本月至今 · 预估全月；产出等效工时（METR 折算，娱乐向）
- 模型成本占比（+「太多花在 Opus」提示）· 高耗会话下钻 · 按 agent 分布
- 每日明细堆叠柱状图 · 高峰时段（星期×小时）热力图 · 活跃度 17 周贡献格
- Top 仓库/文件夹（活跃时长 + 成本，点击直达浏览器）
- 实时系统：CPU/内存曲线 · 电池 · 网络 · **正在运行的 Claude/Codex 会话**（点击聚焦终端）
- 阶段总结：调用本机 `claude -p` 总结「这段时间我用 AI 干了什么」

**会话浏览器（按文件夹合并，不分 CC/CX）**
- 同一文件夹下混排 Claude Code / Codex / Fusion 会话，徽章区分；显示分支、模型、消息数、成本
- `/` 聚焦搜索（标题/目录/分支 + 全文命中直达）· `d` 循环日期过滤（今天/昨天/本周/上周/本月）
- 会话详情：角色彩标 · TOC 目录 · 分页加载 + content-visibility 虚拟化（万条消息不卡）
- 渲染器：thinking / 工具卡片 / ANSI 终端色 / 图片缩放 / Todo 对比 / diff / Workflow 卡 /
  子代理（可点入）/ Fusion 多模型面板 / 每条消息 token·成本·耗时
- `o` 导出选项（勾选 用户/助手/工具/思考/系统）→ HTML / 纯文本
- 会话内搜索走 Web Worker，大会话不冻结
- 管理：复制 Resume 命令 · 多选各开终端恢复 · 重命名 · 批量删除（进废纸篓）· Finder 显示

**归档备份**
- 一键备份全部 Claude 会话到 `~/.ai-cockpit/archives/`，防 30 天自动清理
- 「即将过期」列表（5 天内将被清理的会话）

**Fusion 记录**
- 若你的多模型评审脚本把每次运行写成 `~/.fusion/logs/YYYY/MM/fusion-*.json`
  （问题 + 各模型完整回答），Cockpit 会按发起目录归入对应文件夹并用中转价目计价。
  本仓库不依赖它，目录不存在时面板为空。

**GitHub 仓库一键更新（菜单栏）**
- 配置文件 `~/.ai-cockpit/repos.json`（默认自动收录 `~/skills` 下的各 git 子仓库）
- 菜单栏显示每个仓库的分支 / 落后提交数 / 本地改动 / 最后提交时间，点击即 `pull --rebase --autostash`
  （存在 `upstream` 远端的 fork 会先合并 upstream），完成后系统通知

**Skills 技能库（仪表盘底部）**
- 扫描 `~/.claude/skills` 与 `~/.codex/skills`，以 "Claude Code" / "Codex" 徽章标注归属，可筛选
- 每行：名称 + 归属徽章 + 一句话中文简介（haiku 生成，缓存 `~/.ai-cockpit/skill-zh.json`）；
  点击展开完整原始说明

**菜单栏（SwiftBar）**
- 脚本随 `./build-app.sh` 打进 `AI Cockpit.app/Contents/Resources/`，SwiftBar 插件目录里的软链指向
  app 内那份（而非本仓库），所以仓库改名/搬家不会断链
- **每次打开 app 自动自检菜单栏**：修复断链 → 从 `DisabledPlugins` 里解禁 → SwiftBar 没跑就拉起
  （改动了配置才会重启 SwiftBar；没装 SwiftBar 则静默跳过）。状态栏丢了，打开一次 app 就回来
- 每分钟刷新：图标显示今日消费 + 迷你用量条；下拉：预算百分比 · 5h 窗口重置倒计时 · 配速（超速/富余）·
  近 7 天/本月/预估全月 · Top 文件夹 · 运行中的 Agent 会话（点击聚焦终端）
- 服务端每 2 分钟检查：日预算 50%/80% 阈值通知（`COCKPIT_DAILY_BUDGET` 环境变量，默认 $200）、
  5h 窗口重置通知 + 网页端五彩纸屑 🎉

### 数据源

| 来源 | 路径 | 默认 |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl`（+ subagents） | ✅ |
| Codex CLI | `~/.codex/sessions/**/rollout-*.jsonl` | ✅ |
| Fusion | `~/.fusion/logs/**/*.json` | ✅（可选功能，目录不存在即为空） |
| 历史基线 | Tokipet 账本 `usage_events`（只取磁盘最早日期之前的部分，补 Claude 30 天自动清理造成的缺口） | 可选 |
| 扫描缓存 | `~/.ai-cockpit/scan-cache.json`（按 mtime+size 增量） | — |
| 浏览器 / 屏幕使用时间 / IM 活跃度 | 见上方隐私表 | ❌ 需 `COCKPIT_PERSONAL=1` |

### 成本口径

成本按各模型官方 list price 折算（定价表见 `src/pricing.ts`），与 ccusage 口径对齐（差异 <2%）：
- 子代理（`<session>/subagents/agent-*.jsonl`）与 sidechain 的用量都计入所属会话
- 缓存写按 5m/1h 分开计价（Claude Code 默认 1h TTL：写入价 = 输入价 ×2）
- Codex 计费输入 = input − cached；token 口径与 ccusage 完全一致，价目取 LiteLLM 官方表
- 「成本构成」在扫描时按每条 API 记录的真实模型精确拆分，各卡片数值严格自洽

**Fusion 成本校准**：fusion 成本 = 估算 tokens（字符÷3.2）× **中转实付单价**（用第三方账单反推，
见 `src/pricing.ts` 的 `RELAY_PRICING`）。核对方式：导出中转账单 CSV 后运行
`bun scripts/calibrate.ts <bill.csv>`（加 `--apply` 自动更新单价表）。

---

## License

MIT — see [LICENSE](LICENSE).
