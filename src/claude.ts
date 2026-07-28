import { readdirSync, statSync, existsSync } from "node:fs"
import { join, basename } from "node:path"
import { homedir } from "node:os"
import type { Msg, MsgBlock, SessionSummary, TokenTotals } from "./types"
import { costUSD, findPricing } from "./pricing"

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
const PROJECTS = join(CLAUDE_DIR, "projects")

function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
}

function dayKey(ts: string): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export function listClaudeFiles(): string[] {
  if (!existsSync(PROJECTS)) return []
  const out: string[] = []
  for (const dir of readdirSync(PROJECTS)) {
    const p = join(PROJECTS, dir)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    for (const f of readdirSync(p)) {
      if (f.endsWith(".jsonl")) out.push(join(p, f))
    }
  }
  return out
}

function isNoiseUserText(s: string): boolean {
  const t = s.trimStart()
  return t.startsWith("<") || t.startsWith("Caveat:") || t.startsWith("[Request interrupted")
}

// Lightweight scan for the session list + dashboard aggregates.
export async function scanClaudeFile(file: string): Promise<SessionSummary | null> {
  const text = await Bun.file(file).text()
  if (!text) return null
  const lines = text.split("\n")
  const tokens = emptyTokens()
  let cost = 0
  let title = ""
  let cwd = ""
  let branch = ""
  let entrypoint = ""
  let start = ""
  let end = ""
  let msgCount = 0
  const models = new Set<string>()
  const seenUsage = new Set<string>()
  const daily: SessionSummary["daily"] = {}
  const hourly: SessionSummary["hourly"] = {}
  const hourAbs: NonNullable<SessionSummary["hourAbs"]> = {}
  const perModel: SessionSummary["perModel"] = {}
  let activeMs = 0
  let blocks = 1
  let lastTs = 0
  const toolCounts: Record<string, number> = {}
  let sessionId = basename(file, ".jsonl")

  // usage accumulation shared by main transcript, sidechain lines, and subagent files
  const addUsage = (d: any) => {
    const m = d.message
    const u = m?.usage
    const mid = m?.id || d.requestId || d.uuid
    if (!u || !mid || seenUsage.has(mid)) return
    seenUsage.add(mid)
    const inp = u.input_tokens || 0
    const out = u.output_tokens || 0
    const cw = u.cache_creation_input_tokens || 0
    const cr = u.cache_read_input_tokens || 0
    // Claude Code 默认 1h 缓存 TTL:1h 写入价 = input×2,5m 写入价 = input×1.25
    const cw1h = u.cache_creation?.ephemeral_1h_input_tokens || 0
    const cw5m = u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, cw - cw1h)
    const model = m.model || "unknown"
    if (m.model) models.add(m.model)
    tokens.input += inp
    tokens.output += out
    tokens.cacheWrite += cw
    tokens.cacheRead += cr
    const c = typeof d.costUSD === "number" ? d.costUSD : costUSD(model, inp, out, cw5m, cr, cw1h)
    cost += c
    const pm = (perModel[model] ||= { cost: 0, tokens: 0 })
    pm.cost += c
    pm.tokens += inp + out + cw + cr
    const ts: string | undefined = d.timestamp
    if (!ts) return
    const p = findPricing(model)
    const dk = dayKey(ts)
    const day = (daily[dk] ||= { cost: 0, tokens: 0, out: 0, inp: 0, cw: 0, cr: 0 })
    const tok = inp + out + cw + cr
    day.cost += c
    day.tokens += tok
    day.out += out
    day.inp += inp
    day.cw += cw
    day.cr += cr
    day.ci = (day.ci || 0) + (inp / 1e6) * p.input
    day.co = (day.co || 0) + (out / 1e6) * p.output
    day.ccw = (day.ccw || 0) + (cw5m / 1e6) * p.cacheWrite + (cw1h / 1e6) * p.input * 2
    day.ccr = (day.ccr || 0) + (cr / 1e6) * p.cacheRead
    day.nc = (day.nc || 0) + ((inp + cw + cr) / 1e6) * p.input + (out / 1e6) * p.output
    const dt = new Date(ts)
    const hk = `${dt.getDay()}-${dt.getHours()}`
    const h = (hourly[hk] ||= { c: 0, t: 0 })
    h.c += c
    h.t += tok
    const ak = `${dk}-${String(dt.getHours()).padStart(2, "0")}`
    const ha = (hourAbs[ak] ||= { c: 0, t: 0 })
    ha.c += c
    ha.t += tok
  }

  for (const line of lines) {
    if (!line) continue
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    const t = d.type
    if (t !== "user" && t !== "assistant") continue
    if (t === "assistant") addUsage(d) // sidechain(子代理)的用量也计费
    if (d.isSidechain) continue // 但不参与标题/消息数/活跃时长
    const ts: string | undefined = d.timestamp
    if (ts) {
      if (!start) start = ts
      end = ts
      const ms = Date.parse(ts)
      if (lastTs) {
        const gap = ms - lastTs
        if (gap > 0 && gap < 10 * 60 * 1000) activeMs += gap
        if (gap > 30 * 60 * 1000) blocks++
      }
      lastTs = ms
    }
    if (d.cwd) cwd = d.cwd
    if (d.gitBranch) branch = d.gitBranch
    if (d.entrypoint) entrypoint = d.entrypoint
    if (d.sessionId) sessionId = d.sessionId
    msgCount++
    if (t === "user" && !title) {
      const c = d.message?.content
      const s = typeof c === "string" ? c : Array.isArray(c) ? c.find((x: any) => x.type === "text")?.text || "" : ""
      if (s && !isNoiseUserText(s) && !s.includes("<command-name>")) title = s.replace(/\s+/g, " ").slice(0, 60)
    }
    if (t === "assistant") {
      const m = d.message
      if (Array.isArray(m?.content))
        for (const it of m.content) if (it?.type === "tool_use" && it.name) toolCounts[it.name] = (toolCounts[it.name] || 0) + 1
    }
  }
  if (!start) return null

  // subagent transcripts burn real tokens too — fold their usage into this session
  const dir = file.slice(0, -".jsonl".length)
  const subDir = join(dir, "subagents")
  const hasSubagents = existsSync(subDir)
  if (hasSubagents) {
    let subs: string[] = []
    try {
      subs = readdirSync(subDir)
    } catch {}
    for (const f of subs) {
      if (!f.endsWith(".jsonl")) continue
      let stext = ""
      try {
        stext = await Bun.file(join(subDir, f)).text()
      } catch {
        continue
      }
      for (const line of stext.split("\n")) {
        if (!line) continue
        let d: any
        try {
          d = JSON.parse(line)
        } catch {
          continue
        }
        if (d.type === "assistant") addUsage(d)
      }
    }
  }
  return {
    id: sessionId,
    provider: "claude",
    file,
    cwd: cwd || "unknown",
    title: title || "(无标题)",
    start,
    end,
    msgCount,
    models: [...models],
    gitBranch: branch || undefined,
    entrypoint: entrypoint || undefined,
    tokens,
    costUSD: cost,
    hasSubagents,
    daily,
    hourly,
    hourAbs,
    perModel,
    activeMs,
    blocks,
    apiCalls: seenUsage.size,
    tools: toolCounts,
  }
}

function pushToolResultText(blocks: MsgBlock[], item: any, nameById: Map<string, string>) {
  const name = nameById.get(item.tool_use_id)
  let text = ""
  const imgs: string[] = []
  const c = item.content
  if (typeof c === "string") text = c
  else if (Array.isArray(c)) {
    for (const p of c) {
      if (p.type === "text") text += p.text + "\n"
      else if (p.type === "image" && p.source?.data) imgs.push(`data:${p.source.media_type || "image/png"};base64,${p.source.data}`)
    }
  }
  blocks.push({ t: "tool_result", name, text: text.slice(0, 200000), isError: !!item.is_error, imgs: imgs.length ? imgs : undefined })
}

// Full parse for the detail view.
export async function loadClaudeSession(file: string): Promise<{ msgs: Msg[]; subagents: { id: string; file: string }[] }> {
  const text = await Bun.file(file).text()
  const lines = text.split("\n")
  const msgs: Msg[] = []
  const nameById = new Map<string, string>()
  const usageSeen = new Set<string>()
  let idx = 0
  for (const line of lines) {
    if (!line) continue
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    const t = d.type
    if (t === "summary" && d.summary) {
      msgs.push({ idx: idx++, role: "info", blocks: [{ t: "info", text: `📌 ${d.summary}` }] })
      continue
    }
    if (t === "system" && typeof d.content === "string") {
      msgs.push({ idx: idx++, role: "system", ts: d.timestamp, blocks: [{ t: "text", text: d.content }] })
      continue
    }
    if (t !== "user" && t !== "assistant") continue
    const m = d.message
    if (!m) continue
    const blocks: MsgBlock[] = []
    const c = m.content

    // toolUseResult extras (todo diff / structured patch) attach to user lines
    const tur = d.toolUseResult
    if (tur && typeof tur === "object") {
      if (tur.oldTodos || tur.newTodos) blocks.push({ t: "todo", oldTodos: tur.oldTodos || [], newTodos: tur.newTodos || [] })
      else if (Array.isArray(tur.structuredPatch) && tur.filePath) {
        const diff = tur.structuredPatch.map((h: any) => (h.lines || []).join("\n")).join("\n···\n")
        blocks.push({ t: "patch", file: tur.filePath, diff })
      }
    }

    if (typeof c === "string") {
      if (c.trim()) blocks.push({ t: "text", text: c })
    } else if (Array.isArray(c)) {
      for (const item of c) {
        switch (item.type) {
          case "text":
            if (item.text?.trim()) blocks.push({ t: "text", text: item.text })
            break
          case "thinking":
            if (item.thinking?.trim()) blocks.push({ t: "thinking", text: item.thinking })
            break
          case "redacted_thinking":
            blocks.push({ t: "thinking", text: "（已加密的思维内容）" })
            break
          case "tool_use": {
            if (item.name && item.id) nameById.set(item.id, item.name)
            let input = ""
            try {
              input = JSON.stringify(item.input, null, 2)
            } catch {
              input = String(item.input)
            }
            blocks.push({
              t: "tool_use",
              name: item.name || "tool",
              input: input.slice(0, 100000),
              id: item.id,
              workflow: item.name === "Workflow",
            })
            break
          }
          case "tool_result":
            pushToolResultText(blocks, item, nameById)
            break
          case "image":
            if (item.source?.data) blocks.push({ t: "image", src: `data:${item.source.media_type || "image/png"};base64,${item.source.data}` })
            else if (item.source?.url) blocks.push({ t: "image", src: item.source.url })
            break
          case "server_tool_use":
            blocks.push({ t: "tool_use", name: `🌐 ${item.name || "server_tool"}`, input: JSON.stringify(item.input || {}, null, 2) })
            break
          case "web_search_tool_result":
          case "web_fetch_tool_result":
          case "code_execution_tool_result":
          case "bash_code_execution_tool_result":
          case "text_editor_code_execution_tool_result":
          case "tool_search_tool_result":
          case "mcp_tool_result": {
            let txt = ""
            try {
              txt = typeof item.content === "string" ? item.content : JSON.stringify(item.content, null, 2)
            } catch {
              txt = "(unrenderable)"
            }
            blocks.push({ t: "websearch", text: txt.slice(0, 60000), query: item.type })
            break
          }
          case "mcp_tool_use":
            blocks.push({ t: "tool_use", name: `MCP:${item.name || ""}`, input: JSON.stringify(item.input || {}, null, 2) })
            break
        }
      }
    }
    if (!blocks.length) continue
    const msg: Msg = {
      idx: idx++,
      uuid: d.uuid,
      role: m.role === "assistant" ? "assistant" : "user",
      ts: d.timestamp,
      model: m.model,
      blocks,
      isSidechain: !!d.isSidechain,
    }
    const u = m.usage
    const mid = m.id || d.requestId || d.uuid
    if (m.role === "assistant" && u && mid && !usageSeen.has(mid)) {
      usageSeen.add(mid)
      const inp = u.input_tokens || 0
      const out = u.output_tokens || 0
      const cw = u.cache_creation_input_tokens || 0
      const cr = u.cache_read_input_tokens || 0
      msg.usage = {
        input: inp,
        output: out,
        cacheWrite: cw,
        cacheRead: cr,
        costUSD: typeof d.costUSD === "number" ? d.costUSD : costUSD(m.model || "", inp, out, cw, cr),
        durationMs: d.durationMs,
      }
    }
    msgs.push(msg)
  }

  // subagent transcripts, if present
  const subagents: { id: string; file: string }[] = []
  const dir = file.slice(0, -".jsonl".length)
  const subDir = join(dir, "subagents")
  if (existsSync(subDir)) {
    for (const f of readdirSync(subDir)) {
      if (f.endsWith(".jsonl")) subagents.push({ id: f.replace(/^agent-|\.jsonl$/g, ""), file: join(subDir, f) })
    }
  }
  return { msgs, subagents }
}
