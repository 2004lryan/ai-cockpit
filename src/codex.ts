import { readdirSync, statSync, existsSync } from "node:fs"
import { join, basename } from "node:path"
import { homedir } from "node:os"
import type { Msg, MsgBlock, SessionSummary, TokenTotals } from "./types"
import { costUSD, findPricing } from "./pricing"

export const CODEX_DIR = process.env.CODEX_HOME || join(homedir(), ".codex")

function walk(dir: string, out: string[]) {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(p, out)
    else if (e.startsWith("rollout-") && e.endsWith(".jsonl")) out.push(p)
  }
}

export function listCodexFiles(): string[] {
  const out: string[] = []
  for (const sub of ["sessions", "archived_sessions"]) {
    const d = join(CODEX_DIR, sub)
    if (existsSync(d)) walk(d, out)
  }
  return out
}

function dayKey(ts: string): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function isNoiseText(s: string): boolean {
  const t = s.trimStart()
  return (
    t.startsWith("<") ||
    t.startsWith("# AGENTS.md") ||
    t.startsWith("## My request") === false && t.startsWith("#") && t.includes("AGENTS")
  )
}

export async function scanCodexFile(file: string): Promise<SessionSummary | null> {
  const text = await Bun.file(file).text()
  if (!text) return null
  const lines = text.split("\n")
  let id = basename(file, ".jsonl")
  let cwd = ""
  let model = ""
  let start = ""
  let end = ""
  let title = ""
  let msgCount = 0
  let branch = ""
  let entrypoint = ""
  const models = new Set<string>()
  const tokens: TokenTotals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
  let cost = 0
  const daily: SessionSummary["daily"] = {}
  const hourly: SessionSummary["hourly"] = {}
  const hourAbs: NonNullable<SessionSummary["hourAbs"]> = {}
  const perModel: SessionSummary["perModel"] = {}
  let apiCalls = 0
  let activeMs = 0
  let blocks = 1
  let lastTs = 0
  const toolCounts: Record<string, number> = {}

  for (const line of lines) {
    if (!line) continue
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    const ts: string | undefined = d.timestamp
    if (ts) {
      if (!start) start = ts
      end = ts
    }
    const t = d.type
    const p = d.payload
    if (t === "session_meta" && p) {
      if (p.id) id = p.id
      if (p.cwd) cwd = p.cwd
      if (p.originator) entrypoint = p.originator
      if (p.git?.branch) branch = p.git.branch
      continue
    }
    if (t === "turn_context" && p?.model) {
      model = p.model
      models.add(p.model)
      continue
    }
    if (t === "response_item" && p) {
      if (p.type === "message") {
        msgCount++
        if (ts) {
          const ms = Date.parse(ts)
          if (lastTs) {
            const gap = ms - lastTs
            if (gap > 0 && gap < 10 * 60 * 1000) activeMs += gap
            if (gap > 30 * 60 * 1000) blocks++
          }
          lastTs = ms
        }
        if (!title && p.role === "user") {
          const txt = (p.content || []).map((x: any) => x.text || "").join(" ").trim()
          if (txt && !txt.startsWith("<") && !txt.startsWith("# ")) title = txt.replace(/\s+/g, " ").slice(0, 60)
        }
      } else if (p.type === "function_call" || p.type === "reasoning") {
        msgCount++
        if (p.type === "function_call" && p.name) toolCounts[p.name] = (toolCounts[p.name] || 0) + 1
      }
      continue
    }
    if (t === "event_msg" && p?.type === "token_count" && p.info?.last_token_usage) {
      const lu = p.info.last_token_usage
      const inp = lu.input_tokens || 0
      const cached = lu.cached_input_tokens || 0
      const out = (lu.output_tokens || 0) + 0 // reasoning tokens already in output? keep output only
      const billIn = Math.max(0, inp - cached)
      tokens.input += billIn
      tokens.cacheRead += cached
      tokens.output += out
      const mdl = model || "gpt-5"
      const c = costUSD(mdl, billIn, out, 0, cached)
      cost += c
      const pm = (perModel[mdl] ||= { cost: 0, tokens: 0 })
      pm.cost += c
      pm.tokens += inp + out
      apiCalls++
      if (ts) {
        const dk = dayKey(ts)
        const day = (daily[dk] ||= { cost: 0, tokens: 0, out: 0, inp: 0, cw: 0, cr: 0 })
        const tok = inp + out
        day.cost += c
        day.tokens += tok
        day.out += out
        day.inp += billIn
        day.cr += cached
        const pp = findPricing(mdl)
        day.ci = (day.ci || 0) + (billIn / 1e6) * pp.input
        day.co = (day.co || 0) + (out / 1e6) * pp.output
        day.ccr = (day.ccr || 0) + (cached / 1e6) * pp.cacheRead
        day.nc = (day.nc || 0) + ((billIn + cached) / 1e6) * pp.input + (out / 1e6) * pp.output
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
    }
  }
  if (!start || (!msgCount && !cost)) return null
  return {
    id,
    provider: "codex",
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
    hasSubagents: false,
    daily,
    hourly,
    hourAbs,
    perModel,
    activeMs,
    blocks,
    apiCalls,
    tools: toolCounts,
  }
}

export async function loadCodexSession(file: string): Promise<{ msgs: Msg[]; subagents: [] }> {
  const text = await Bun.file(file).text()
  const lines = text.split("\n")
  const msgs: Msg[] = []
  const nameByCall = new Map<string, string>()
  let idx = 0
  let model = ""
  for (const line of lines) {
    if (!line) continue
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d.type === "turn_context" && d.payload?.model) model = d.payload.model
    if (d.type !== "response_item") continue
    const p = d.payload
    if (!p) continue
    const blocks: MsgBlock[] = []
    let role: Msg["role"] = "assistant"
    switch (p.type) {
      case "message": {
        role = p.role === "user" ? "user" : "assistant"
        const txt = (p.content || []).map((x: any) => x.text || "").join("\n").trim()
        if (!txt) continue
        if (role === "user" && (txt.startsWith("<environment_context") || txt.startsWith("<user_instructions") || txt.startsWith("# AGENTS.md"))) {
          msgs.push({ idx: idx++, role: "system", ts: d.timestamp, blocks: [{ t: "text", text: txt }] })
          continue
        }
        blocks.push({ t: "text", text: txt })
        break
      }
      case "reasoning": {
        const txt = (p.summary || []).map((x: any) => x.text || "").join("\n").trim()
        if (!txt) continue
        blocks.push({ t: "thinking", text: txt })
        break
      }
      case "function_call": {
        if (p.call_id && p.name) nameByCall.set(p.call_id, p.name)
        blocks.push({ t: "tool_use", name: p.name || "tool", input: String(p.arguments || "").slice(0, 100000) })
        break
      }
      case "function_call_output": {
        let out = p.output
        if (typeof out === "string") {
          try {
            const j = JSON.parse(out)
            out = j.output ?? out
          } catch {}
        } else if (out && typeof out === "object") {
          out = out.output ?? JSON.stringify(out)
        }
        blocks.push({ t: "tool_result", name: nameByCall.get(p.call_id), text: String(out).slice(0, 200000) })
        role = "user"
        break
      }
      case "local_shell_call":
        blocks.push({ t: "tool_use", name: "shell", input: JSON.stringify(p.action || p, null, 2).slice(0, 100000) })
        break
      case "local_shell_call_output": {
        let out = p.output
        try {
          const j = JSON.parse(out)
          out = j.output ?? out
        } catch {}
        blocks.push({ t: "tool_result", name: "shell", text: String(out).slice(0, 200000) })
        role = "user"
        break
      }
      default:
        continue
    }
    if (!blocks.length) continue
    msgs.push({ idx: idx++, role, ts: d.timestamp, model: role === "assistant" ? model : undefined, blocks })
  }
  return { msgs, subagents: [] }
}
