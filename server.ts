// AI Cockpit — unified local dashboard for Claude Code / Codex / Fusion history,
// cost analytics, archive management and a menu-bar feed.
import { watch } from "node:fs"
import { existsSync, mkdirSync } from "node:fs"
import { join, dirname, basename } from "node:path"
import { homedir } from "node:os"
import index from "./web/index.html"
import {
  scanAll,
  groupByFolder,
  setRename,
  setHidden,
  setFolderHidden,
  isFolderHidden,
  setFolderAlias,
  ensureMetadata,
  saveMetadata,
  APP_DIR,
  shortPath,
} from "./src/store"
import { runBackup, backupState, isBackedUp, backupPlan } from "./src/backup"
import { buildOverview, type Range } from "./src/stats"
import { historySessions, earliestClaudeDay } from "./src/history"
import { loadClaudeSession, listClaudeFiles, CLAUDE_DIR } from "./src/claude"
import { loadCodexSession, CODEX_DIR } from "./src/codex"
import { loadFusionSession, mineHistoricalFusion, FUSION_LOG_DIR } from "./src/fusion"
import { repoStatus, repoUpdate } from "./src/repos"
import { listSkills, generateZh } from "./src/skills"
import { getSystem, startSampling, runningAgents } from "./src/system"
import {
  resumeCommand,
  openInTerminal,
  deleteSession,
  listArchives,
  createArchive,
  deleteArchive,
  expiringSessions,
  exportHTML,
  exportText,
} from "./src/manage"
import { stageSummary } from "./src/summary"
import { getPersonalContext } from "./src/personal"
import { findPricing } from "./src/pricing"
import type { SessionSummary } from "./src/types"

const PORT = Number(process.env.PORT || 4777)
mkdirSync(APP_DIR, { recursive: true })
startSampling()

// 自动备份:起来 20 秒后跑一次,之后每 6 小时一次(增量,只增不删;30 天清理窗口绰绰有余)。
// 原件不会被清理的机器直接跳过 —— 判据见 backupPlan()。手动"立即备份"按钮不受影响。
const backup = backupPlan()
if (backup.run) {
  setTimeout(() => {
    runBackup()
      .then((s) => console.log(`📦 auto-backup: +${s.copied} → ${s.files} files (${(s.bytes / 2 ** 20).toFixed(0)} MB, ${s.ms}ms)`))
      .catch(() => {})
  }, 20_000)
  setInterval(() => {
    runBackup().catch(() => {})
  }, 6 * 3600 * 1000)
} else {
  console.log(`📦 auto-backup: 已跳过(${backup.why})。需要时可手动备份,或设 COCKPIT_BACKUP=1 强制开启`)
}

// harvest historical /fusion runs from Claude logs (idempotent, background)
mineHistoricalFusion(listClaudeFiles())
  .then((n) => n && console.log(`⚖️  mined ${n} historical fusion runs`))
  .catch(() => {})

// ---------- live refresh (SSE) ----------
const sseClients = new Set<ReadableStreamDefaultController>()
let notifyTimer: Timer | null = null
function notifyChange() {
  if (notifyTimer) return
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    for (const c of sseClients) {
      try {
        c.enqueue(`data: refresh\n\n`)
      } catch {}
    }
  }, 1500)
}
for (const dir of [join(CLAUDE_DIR, "projects"), join(CODEX_DIR, "sessions"), FUSION_LOG_DIR]) {
  if (!existsSync(dir)) continue
  try {
    watch(dir, { recursive: true }, () => notifyChange())
  } catch {}
}

// ---------- notifications (threshold / depletion / reset) ----------
const notifyState = { lastDayCost: 0, warned50: false, warned80: false, lastWindowId: "" }
async function macNotify(title: string, body: string) {
  try {
    Bun.spawnSync(["osascript", "-e", `display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`])
  } catch {}
}
const DAILY_BUDGET = Number(process.env.COCKPIT_DAILY_BUDGET || 200) // USD, notification thresholds

async function checkThresholds(sessions: SessionSummary[]) {
  const now = new Date()
  const dk = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
  let today = 0
  let latest = 0
  for (const s of sessions) {
    today += s.daily[dk]?.cost || 0
    const e = Date.parse(s.end)
    if (e > latest) latest = e
  }
  if (today > DAILY_BUDGET * 0.5 && !notifyState.warned50) {
    notifyState.warned50 = true
    macNotify("AI Cockpit · 阈值预警", `今日已消耗 $${today.toFixed(2)},超过日预算 50%`)
  }
  if (today > DAILY_BUDGET * 0.8 && !notifyState.warned80) {
    notifyState.warned80 = true
    macNotify("AI Cockpit · 阈值预警", `今日已消耗 $${today.toFixed(2)},超过日预算 80% ⚠️`)
  }
  // 5h session window reset detection (window = floor(latestActivity / 5h))
  const winId = latest ? String(Math.floor(latest / (5 * 3600 * 1000))) : ""
  if (winId && notifyState.lastWindowId && winId !== notifyState.lastWindowId) {
    macNotify("AI Cockpit · 额度窗口已重置 🎉", "新的 5 小时窗口开始了,放心跑任务吧")
    for (const c of sseClients) {
      try {
        c.enqueue(`data: confetti\n\n`)
      } catch {}
    }
  }
  if (winId) notifyState.lastWindowId = winId
  if (dk !== String(notifyState.lastDayCost)) {
    // new day resets warnings
  }
}
setInterval(async () => {
  try {
    const s = await scanAll()
    checkThresholds(s)
  } catch {}
}, 120000)

// ---------- helpers ----------
const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } })

async function loadSession(provider: string, file: string) {
  if (provider === "claude") return loadClaudeSession(file)
  if (provider === "codex") return loadCodexSession(file)
  return loadFusionSession(file)
}

// 列表行用的精简 session(会话浏览器和「已隐藏」共用同一套字段/同一套行 UI)
const lightSession = (s: SessionSummary, root: string) => ({
  // 项目内的子目录显示相对路径;从外面并进来的(scratchpad / 手动并入)标 ⤴ + 目录名
  subdir:
    s.cwd === root ? "" : s.cwd.startsWith(root + "/") ? s.cwd.slice(root.length + 1) : "⤴ " + (basename(s.cwd) || s.cwd),
  id: s.id,
  provider: s.provider,
  file: s.file,
  title: s.displayName || s.title,
  start: s.start,
  end: s.end,
  msgCount: s.msgCount,
  models: s.models,
  gitBranch: s.gitBranch,
  entrypoint: s.entrypoint,
  costUSD: s.costUSD,
  tokens: s.tokens,
  hasSubagents: s.hasSubagents,
  archived: s.archived,
  cwd: s.cwd,
})

const sumTokens = (list: SessionSummary[]) => list.reduce((n, s) => n + s.tokens.input + s.tokens.output + s.tokens.cacheWrite + s.tokens.cacheRead, 0)

function guardFile(file: string): boolean {
  // only allow reading session files from known roots
  const roots = [CLAUDE_DIR, CODEX_DIR, FUSION_LOG_DIR, APP_DIR, homedir() + "/.fusion"]
  return roots.some((r) => file.startsWith(r)) && !file.includes("..")
}

// ---------- server ----------
const server = Bun.serve({
  port: PORT,
  idleTimeout: 120,
  routes: {
    "/": index,
  },
  async fetch(req) {
    const url = new URL(req.url)
    const p = url.pathname

    if (p === "/events") {
      let ctrl: ReadableStreamDefaultController
      const stream = new ReadableStream({
        start(c) {
          ctrl = c
          sseClients.add(c)
          c.enqueue(`data: hello\n\n`)
        },
        cancel() {
          sseClients.delete(ctrl)
        },
      })
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      })
    }

    if (p === "/api/overview") {
      const range = (url.searchParams.get("range") || "7d") as Range
      const sessions = await scanAll()
      // 磁盘之外的更早历史(Claude 30 天清理前的部分)由 Tokipet 账本补齐
      const hist = await historySessions(earliestClaudeDay(sessions))
      return json(buildOverview(hist.length ? [...sessions, ...hist] : sessions, range))
    }

    if (p === "/api/folders") {
      const sessions = await scanAll()
      const q = (url.searchParams.get("q") || "").toLowerCase()
      const date = url.searchParams.get("date") || "all"
      // hide CodexBar's usage-probe sessions from the browser (kept in stats)
      let filtered = sessions.filter((s) => !s.cwd.includes("CodexBar/ClaudeProbe"))
      if (q)
        filtered = filtered.filter(
          (s) =>
            (s.displayName || s.title).toLowerCase().includes(q) ||
            s.cwd.toLowerCase().includes(q) ||
            (s.gitBranch || "").toLowerCase().includes(q)
        )
      if (date !== "all") {
        const now = new Date()
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        const day = 86400000
        const dow = (today.getDay() + 6) % 7 // Monday=0
        let lo = 0,
          hi = Infinity
        if (date === "today") lo = +today
        else if (date === "yesterday") {
          lo = +today - day
          hi = +today
        } else if (date === "thisweek") lo = +today - dow * day
        else if (date === "lastweek") {
          lo = +today - (dow + 7) * day
          hi = +today - dow * day
        } else if (date === "thismonth") lo = +new Date(now.getFullYear(), now.getMonth(), 1)
        filtered = filtered.filter((s) => {
          const t = Date.parse(s.end)
          return t >= lo && t < hi
        })
      }
      // 隐藏的会话仍参与分组统计(文件夹汇总保持真实),只是不进列表行;
      // 整个文件夹被隐藏、或里面的会话被逐条隐藏光了,就整组不出现(别留空壳行)
      const groups = groupByFolder(filtered).filter((g) => !isFolderHidden(g.cwd) && g.sessions.some((s) => !s.hidden))
      // strip heavy fields for the list payload
      const light = groups.map((g) => ({
        ...g,
        hiddenCount: g.sessions.filter((s) => s.hidden).length,
        sessions: g.sessions.filter((s) => !s.hidden).map((s) => lightSession(s, g.cwd)),
      }))
      return json({ folders: light })
    }

    // 所有项目根(不受搜索/日期筛选影响):给「并入项目」的下拉用
    if (p === "/api/projects") {
      const groups = groupByFolder(await scanAll())
      return json({
        projects: groups
          .map((g) => ({ cwd: g.cwd, name: g.name, shortPath: g.shortPath, n: g.sessions.length }))
          .sort((a, b) => b.n - a.n),
      })
    }

    // 已隐藏的会话:和会话浏览器同一套结构(文件夹分组 + 可展开的会话行)
    if (p === "/api/hidden") {
      const sessions = await scanAll()
      const groups = groupByFolder(sessions)
      const out = []
      for (const g of groups) {
        // 整个文件夹隐藏 = 显式隐藏的 + 会话被逐条隐藏光的(两者都当整体处理)
        const whole = isFolderHidden(g.cwd) || g.sessions.every((s) => s.hidden)
        const rows = whole ? g.sessions : g.sessions.filter((s) => s.hidden)
        if (!rows.length) continue
        out.push({
          cwd: g.cwd,
          name: g.name,
          shortPath: g.shortPath,
          providers: [...new Set(rows.map((s) => s.provider))],
          whole,
          costUSD: rows.reduce((n, s) => n + s.costUSD, 0), // 只算隐藏掉的那部分
          tokens: sumTokens(rows),
          lastActive: rows.reduce((t, s) => (s.end > t ? s.end : t), ""),
          sessions: rows.map((s) => lightSession(s, g.cwd)),
        })
      }
      out.sort((a, b) => (a.lastActive < b.lastActive ? 1 : -1))
      return json({ folders: out })
    }

    if (p === "/api/session") {
      const file = url.searchParams.get("file") || ""
      const provider = url.searchParams.get("provider") || "claude"
      if (!guardFile(file) || !existsSync(file)) return json({ error: "not found" }, 404)
      if (file.endsWith(".csv"))
        return json({
          total: 1,
          from: 0,
          msgs: [{ idx: 0, role: "info", blocks: [{ t: "info", text: "🧾 这是第三方中转账单的聚合记录(实录成本),没有对话内容。明细见 ~/.ai-cockpit/relay-logs/ 下的 CSV。" }] }],
          subagents: [],
          stat: null,
        })
      const { msgs, subagents } = await loadSession(provider, file)
      const offset = Number(url.searchParams.get("offset") || -1)
      const limit = Number(url.searchParams.get("limit") || 200)
      let slice = msgs
      let from = 0
      if (msgs.length > limit) {
        from = offset >= 0 ? offset : Math.max(0, msgs.length - limit)
        slice = msgs.slice(from, from + limit)
      }
      // per-session stats card data
      const all = await scanAll()
      const sum = all.find((s) => s.file === file)
      const pr = sum ? findPricing(sum.models[0] || "") : null
      const dsum = (k: "ci" | "co" | "ccw" | "ccr") => (sum ? Object.values(sum.daily).reduce((a, d) => a + ((d as any)[k] ?? NaN), 0) : NaN)
      const co = dsum("co"), ci = dsum("ci"), ccw = dsum("ccw"), ccr = dsum("ccr")
      const stat = sum
        ? {
            cost: sum.costUSD,
            tokens: sum.tokens,
            comp: {
              out: { tok: sum.tokens.output, cost: Number.isFinite(co) ? co : (sum.tokens.output / 1e6) * pr!.output },
              inp: { tok: sum.tokens.input, cost: Number.isFinite(ci) ? ci : (sum.tokens.input / 1e6) * pr!.input },
              cw: { tok: sum.tokens.cacheWrite, cost: Number.isFinite(ccw) ? ccw : (sum.tokens.cacheWrite / 1e6) * pr!.cacheWrite },
              cr: { tok: sum.tokens.cacheRead, cost: Number.isFinite(ccr) ? ccr : (sum.tokens.cacheRead / 1e6) * pr!.cacheRead },
            },
            apiCalls: sum.apiCalls || 0,
            perModel: Object.entries(sum.perModel)
              .filter(([m]) => !m.startsWith("<"))
              .map(([m, v]) => ({ model: m, ...v }))
              .sort((a, b) => b.cost - a.cost),
            branches: sum.gitBranch ? [sum.gitBranch] : [],
            daily: sum.daily,
            start: sum.start,
            end: sum.end,
          }
        : null
      return json({ total: msgs.length, from, msgs: slice, subagents, stat })
    }

    if (p === "/api/search") {
      const q = (url.searchParams.get("q") || "").toLowerCase()
      if (q.length < 2) return json({ results: [] })
      const all = await scanAll()
      groupByFolder(all) // 给 session 打上 root,好按隐藏的文件夹过滤
      const sessions = all.filter((s) => !s.cwd.includes("CodexBar/ClaudeProbe") && !s.hidden && !isFolderHidden(s.root || s.cwd))
      const results: any[] = []
      outer: for (const s of sessions) {
        try {
          const text = await Bun.file(s.file).text()
          const lower = text.toLowerCase()
          let pos = 0
          let hits = 0
          while (hits < 3) {
            const i = lower.indexOf(q, pos)
            if (i < 0) break
            const ctx = text.slice(Math.max(0, i - 80), i + 120).replace(/\s+/g, " ")
            // best-effort message index: count '"type":"user"|"assistant"' before hit
            results.push({
              provider: s.provider,
              file: s.file,
              id: s.id,
              title: s.displayName || s.title,
              folder: s.cwd.split("/").pop(),
              cwd: s.cwd,
              end: s.end,
              context: ctx,
            })
            hits++
            pos = i + q.length
            if (results.length >= 60) break outer
          }
        } catch {}
      }
      return json({ results })
    }

    if (p === "/api/system") return json(await getSystem())

    if (p === "/api/personal") {
      const range = (url.searchParams.get("range") || "7d") as Range
      return json(getPersonalContext(range))
    }

    if (p === "/api/repos") return json({ repos: await repoStatus() })

    // GET variant for menubar one-click update (avoids quote-nesting in SwiftBar params)
    if (p === "/api/repo-update") {
      const path = url.searchParams.get("path") || ""
      return json(await repoUpdate(path))
    }

    if (p === "/api/skills") {
      if (url.searchParams.get("gen") === "1") generateZh().catch(() => {})
      return json({ skills: await listSkills() })
    }

    if (p === "/api/summary") {
      const range = (url.searchParams.get("range") || "7d") as Range
      const force = url.searchParams.get("force") === "1"
      const sessions = await scanAll()
      return json(await stageSummary(sessions, range, force))
    }

    if (p === "/api/archives") {
      const sessions = await scanAll()
      return json({
        archives: listArchives(),
        expiring: expiringSessions(sessions).map((s) => ({ ...s, backed: isBackedUp(s.file) })),
        backup: await backupState(),
      })
    }

    if (p === "/api/menubar") {
      const sessions = await scanAll()
      const ov = buildOverview(sessions, "today")
      const ov7 = buildOverview(sessions, "7d")
      let latest = 0
      for (const s of sessions) {
        const e = Date.parse(s.end)
        if (e > latest) latest = e
      }
      const winStart = latest ? Math.floor(latest / (5 * 3600 * 1000)) * 5 * 3600 * 1000 : Date.now()
      const winEnd = winStart + 5 * 3600 * 1000
      return json({
        today: ov.listCost,
        todayTok: ov.totalTokens,
        d7: ov7.listCost,
        d7Tok: ov7.totalTokens,
        monthToDate: ov.pace.monthToDate,
        monthToDateTok: (ov.pace as any).monthToDateTok || 0,
        projMonth: ov.pace.projMonth,
        projMonthTok: (ov.pace as any).projMonthTok || 0,
        avg7: ov.pace.avg7,
        avg7Tok: (ov.pace as any).avg7Tok || 0,
        budget: DAILY_BUDGET,
        windowEndsInMin: Math.max(0, Math.round((winEnd - Date.now()) / 60000)),
        agents: await runningAgents(),
        topFolders: ov.folders.slice(0, 5).map((f) => ({ name: f.name, cost: f.cost, tok: (f as any).tokens || 0 })),
      })
    }

    if (req.method === "POST" && p === "/api/action") {
      const body: any = await req.json()
      const t = body.type
      try {
        await ensureMetadata() // 别在 metadata 还没读盘时就改它
        if (t === "backup-now") return json(await runBackup())
        if (t === "resume-cmd") return json({ cmd: resumeCommand(body) })
        if (t === "open-terminal") {
          for (const s of body.sessions || [body]) await openInTerminal(resumeCommand(s))
          return json({ ok: true })
        }
        if (t === "rename") {
          setRename(body.provider, body.id, body.name || "")
          await saveMetadata()
          return json({ ok: true })
        }
        // 隐藏/取消隐藏(可批量):只动 metadata.json,不碰 JSONL,统计不变
        if (t === "hide") {
          const hidden = body.hidden !== false
          for (const s of body.sessions || [body]) setHidden(s.provider, s.id, hidden)
          await saveMetadata()
          return json({ ok: true })
        }
        if (t === "hide-folder") {
          const hidden = body.hidden !== false
          setFolderHidden(body.cwd, hidden)
          // 恢复文件夹时把里面逐条隐藏的会话也一起放出来,免得取消了还是空的
          if (!hidden && body.clearSessions !== false) {
            const groups = groupByFolder(await scanAll())
            for (const g of groups) if (g.cwd === body.cwd) for (const s of g.sessions) setHidden(s.provider, s.id, false)
          }
          await saveMetadata()
          return json({ ok: true })
        }
        // 把一个游离目录并进某个项目(to 为空 = 撤销并入);只动 metadata.json
        if (t === "merge-folder") {
          for (const from of body.from ? [body.from] : body.sources || []) setFolderAlias(from, body.to || "")
          await saveMetadata()
          return json({ ok: true })
        }
        if (t === "delete") {
          if (!guardFile(body.file)) return json({ error: "bad path" }, 400)
          // 文件没了就别在隐藏名单里留残条目
          if (body.provider && body.id) setHidden(body.provider, body.id, false)
          const ok = deleteSession(body.file)
          await saveMetadata()
          return json({ ok })
        }
        if (t === "repo-update") return json(await repoUpdate(body.path))
        if (t === "archive-create") return json(createArchive(body.name))
        if (t === "archive-delete") return json({ ok: deleteArchive(body.name) })
        if (t === "reveal") {
          Bun.spawnSync(["open", "-R", body.file])
          return json({ ok: true })
        }
        if (t === "focus-terminal") {
          // bring Terminal/iTerm to front (best effort by pid → app)
          Bun.spawnSync(["osascript", "-e", 'tell application "Terminal" to activate'])
          return json({ ok: true })
        }
      } catch (e: any) {
        return json({ error: String(e) }, 500)
      }
    }

    if (req.method === "POST" && p === "/api/export") {
      const body: any = await req.json()
      if (!guardFile(body.file)) return json({ error: "bad path" }, 400)
      const { msgs } = await loadSession(body.provider, body.file)
      const meta = { id: body.id, provider: body.provider, cwd: body.cwd, start: body.start, end: body.end, title: body.title }
      const opts = { user: true, assistant: true, tools: false, thinking: false, system: false, ...(body.options || {}) }
      const content = body.format === "html" ? exportHTML(msgs, meta, opts) : exportText(msgs, meta, opts)
      return new Response(content, {
        headers: {
          "Content-Type": body.format === "html" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="session-${(body.id || "x").slice(0, 8)}.${body.format === "html" ? "html" : "txt"}"`,
        },
      })
    }

    return new Response("Not found", { status: 404 })
  },
})

console.log(`🛩  AI Cockpit running at http://localhost:${server.port}`)
