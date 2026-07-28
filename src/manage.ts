import { existsSync, mkdirSync, readdirSync, statSync, cpSync, rmSync } from "node:fs"
import { join, basename, dirname } from "node:path"
import { homedir } from "node:os"
import { $ } from "bun"
import { APP_DIR } from "./store"
import { CLAUDE_DIR } from "./claude"
import { dropBackup } from "./backup"
import type { SessionSummary } from "./types"

const ARCHIVE_DIR = join(APP_DIR, "archives")

export function resumeCommand(s: { provider: string; id: string; cwd: string }): string {
  const cd = s.cwd && s.cwd !== "unknown" ? `cd '${s.cwd.replace(/'/g, `'\\''`)}' && ` : ""
  if (s.provider === "codex") return `${cd}codex resume ${s.id}`
  return `${cd}claude --resume ${s.id}`
}

export async function openInTerminal(cmd: string): Promise<void> {
  const esc = cmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  await $`osascript -e ${'tell application "Terminal"\nactivate\ndo script "' + esc + '"\nend tell'}`.quiet()
}

export function deleteSession(file: string): boolean {
  // move to Trash via Finder for recoverability
  try {
    dropBackup(file) // 镜像里的副本一起删,否则它会以「已归档」身份复活
    const esc = file.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    Bun.spawnSync(["osascript", "-e", `tell application "Finder" to delete POSIX file "${esc}"`])
    if (existsSync(file)) rmSync(file)
    // remove subagents dir if present
    const dir = file.slice(0, -".jsonl".length)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

// ---- Archive ----
export function listArchives() {
  if (!existsSync(ARCHIVE_DIR)) return []
  return readdirSync(ARCHIVE_DIR)
    .filter((d) => {
      try {
        return statSync(join(ARCHIVE_DIR, d)).isDirectory()
      } catch {
        return false
      }
    })
    .map((d) => {
      const p = join(ARCHIVE_DIR, d)
      let files = 0
      let bytes = 0
      const walk = (dir: string) => {
        for (const e of readdirSync(dir)) {
          const fp = join(dir, e)
          const st = statSync(fp)
          if (st.isDirectory()) walk(fp)
          else {
            files++
            bytes += st.size
          }
        }
      }
      try {
        walk(p)
      } catch {}
      return { name: d, files, bytes, created: statSync(p).birthtime.toISOString() }
    })
    .sort((a, b) => (a.created < b.created ? 1 : -1))
}

export function createArchive(name?: string): { name: string; files: number } {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")
  const dirName = (name || `backup-${stamp}`).replace(/[^\w一-鿿.-]+/g, "_")
  const dest = join(ARCHIVE_DIR, dirName)
  mkdirSync(dest, { recursive: true })
  const projects = join(CLAUDE_DIR, "projects")
  let files = 0
  if (existsSync(projects)) {
    for (const proj of readdirSync(projects)) {
      const src = join(projects, proj)
      try {
        if (!statSync(src).isDirectory()) continue
        cpSync(src, join(dest, proj), { recursive: true })
        files += readdirSync(src).filter((f) => f.endsWith(".jsonl")).length
      } catch {}
    }
  }
  return { name: dirName, files }
}

export function deleteArchive(name: string): boolean {
  const p = join(ARCHIVE_DIR, name.replace(/[/\\]/g, ""))
  if (!existsSync(p)) return false
  rmSync(p, { recursive: true, force: true })
  return true
}

// Sessions the Claude Code auto-cleanup (default 30 days) will remove soon.
export function expiringSessions(sessions: SessionSummary[], cleanupDays = 30, soonDays = 5) {
  const now = Date.now()
  return sessions
    .filter((s) => s.provider === "claude")
    .map((s) => {
      const ageDays = (now - Date.parse(s.end)) / 86400000
      return { ...s, daysLeft: Math.ceil(cleanupDays - ageDays) }
    })
    .filter((s) => s.daysLeft > 0 && s.daysLeft <= soonDays)
    .sort((a, b) => a.daysLeft - b.daysLeft)
    .map((s) => ({ id: s.id, title: s.displayName || s.title, folder: basename(dirname(s.file)), end: s.end, daysLeft: s.daysLeft, file: s.file, provider: s.provider }))
}

// ---- Export (single session → HTML / text) ----
export function exportText(msgs: any[], meta: any, opts: any): string {
  const lines: string[] = []
  lines.push("=".repeat(60))
  lines.push(`Session: ${meta.id}`)
  lines.push(`Provider: ${meta.provider}  Folder: ${meta.cwd}`)
  lines.push(`Date: ${meta.start} → ${meta.end}`)
  lines.push("=".repeat(60))
  for (const m of msgs) {
    if (m.role === "user" && !opts.user) continue
    if (m.role === "assistant" && !opts.assistant) continue
    if (m.role === "system" && !opts.system) continue
    for (const b of m.blocks) {
      if (b.t === "thinking" && !opts.thinking) continue
      if ((b.t === "tool_use" || b.t === "tool_result") && !opts.tools) continue
      const tag = m.role.toUpperCase() + (b.t === "thinking" ? "·THINK" : b.t.startsWith("tool") ? "·TOOL" : "")
      lines.push(`\n[${tag}] ${m.ts || ""}`)
      if (b.t === "tool_use") lines.push(`Tool: ${b.name}\n${b.input}`)
      else if (b.t === "tool_result") lines.push(b.text)
      else if ("text" in b) lines.push((b as any).text)
      lines.push("-".repeat(40))
    }
  }
  return lines.join("\n")
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export function exportHTML(msgs: any[], meta: any, opts: any): string {
  const parts: string[] = []
  for (const m of msgs) {
    if (m.role === "user" && !opts.user) continue
    if (m.role === "assistant" && !opts.assistant) continue
    if (m.role === "system" && !opts.system) continue
    const inner: string[] = []
    for (const b of m.blocks) {
      if (b.t === "thinking" && !opts.thinking) continue
      if ((b.t === "tool_use" || b.t === "tool_result") && !opts.tools) continue
      if (b.t === "text") inner.push(`<div class="txt">${esc(b.text)}</div>`)
      else if (b.t === "thinking") inner.push(`<div class="think">💭 ${esc(b.text)}</div>`)
      else if (b.t === "tool_use") inner.push(`<div class="tool"><b>🔧 ${esc(b.name)}</b><pre>${esc(b.input)}</pre></div>`)
      else if (b.t === "tool_result") inner.push(`<div class="result"><pre>${esc(b.text.slice(0, 5000))}</pre></div>`)
      else if (b.t === "image") inner.push(`<img src="${b.src}" style="max-width:100%">`)
    }
    if (!inner.length) continue
    parts.push(`<div class="msg ${m.role}"><div class="role">${m.role}${m.model ? ` · ${esc(m.model)}` : ""}${m.ts ? ` · ${m.ts.slice(0, 19).replace("T", " ")}` : ""}</div>${inner.join("")}</div>`)
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(meta.id)}</title><style>
body{font-family:-apple-system,'PingFang SC',sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;background:#faf7f2;color:#2b2620}
.msg{border-radius:12px;padding:12px 16px;margin:10px 0;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.msg.user{background:#eef5ee;margin-left:8%}.msg.assistant{margin-right:8%}.msg.system{opacity:.65}
.role{font-size:12px;color:#8a7f70;margin-bottom:6px;font-weight:600;text-transform:uppercase}
.txt{white-space:pre-wrap;line-height:1.6}.think{white-space:pre-wrap;color:#8a7f70;font-style:italic;border-left:3px solid #d8cdbd;padding-left:10px;margin:6px 0}
.tool{background:#fdf3e7;border-radius:8px;padding:8px;margin:6px 0}.result{background:#f4f1ec;border-radius:8px;padding:8px;margin:6px 0}
pre{white-space:pre-wrap;word-break:break-all;font-size:12px;margin:4px 0;font-family:ui-monospace,monospace}
h1{font-size:20px}</style></head><body>
<h1>🛩️ ${esc(meta.title || meta.id)}</h1>
<p style="color:#8a7f70;font-size:13px">${esc(meta.provider)} · ${esc(meta.cwd)} · ${esc(meta.start?.slice(0, 10) || "")}</p>
${parts.join("\n")}
<p style="color:#b5a897;font-size:12px;text-align:center;margin-top:2rem">Generated by AI Cockpit</p>
</body></html>`
}
