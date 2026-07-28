import { readdirSync, statSync, existsSync } from "node:fs"
import { join, basename } from "node:path"
import { homedir } from "node:os"
import type { Msg, SessionSummary } from "./types"
import { costUSD, relayCostUSD, estTokens, findPricing, findRelayPricing } from "./pricing"

export const FUSION_LOG_DIR = process.env.FUSION_LOG_DIR || join(homedir(), ".fusion", "logs")
const API_JSON = join(homedir(), ".claude", "skills", "fusion", "api.json")

// MODELn -> real model name, read from the fusion skill's api.json (names only).
let keyToModel: Record<string, string> | null = null
export async function fusionModelMap(): Promise<Record<string, string>> {
  if (keyToModel && Object.keys(keyToModel).length) return keyToModel
  const map: Record<string, string> = {}
  try {
    const d: any = await Bun.file(API_JSON).json()
    for (const [k, v] of Object.entries<any>(d)) {
      if (v && typeof v === "object") {
        const m = v.MODEL || v.model || v.name
        if (typeof m === "string") map[k] = m
      }
    }
  } catch {}
  if (Object.keys(map).length) keyToModel = map
  return map
}

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
    else if (e.endsWith(".json")) out.push(p)
  }
}

export function listFusionFiles(): string[] {
  const out: string[] = []
  if (existsSync(FUSION_LOG_DIR)) walk(FUSION_LOG_DIR, out)
  return out
}

function dayKey(ts: string): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
function hourKey(ts: string): string {
  const d = new Date(ts)
  return `${dayKey(ts)}-${String(d.getHours()).padStart(2, "0")}`
}

// Strip the "### MODELn (name)" header if present, keep body.
function cleanBody(text: string): string {
  return String(text || "").replace(/^###\s*MODEL\d+\s*\([^)]*\)\s*\n?/, "")
}

export async function scanFusionFile(file: string): Promise<SessionSummary | null> {
  let d: any
  try {
    d = await Bun.file(file).json()
  } catch {
    return null
  }
  if (!d?.timestamp) return null
  const map = await fusionModelMap()
  const models = d.models || {}
  const keys = Object.keys(models)
  const q = String(d.question || "")
  const inTokEach = estTokens(q)
  let cost = 0
  let outTok = 0
  let ciSum = 0
  let coSum = 0
  const perModel: SessionSummary["perModel"] = {}
  const ts = d.timestamp
  const dk = dayKey(ts)
  const hk = hourKey(ts)
  const dt = new Date(ts)
  const dowh = `${dt.getDay()}-${dt.getHours()}`
  const daily: SessionSummary["daily"] = { [dk]: { cost: 0, tokens: 0, out: 0, inp: 0, cw: 0, cr: 0 } }
  const hourly: SessionSummary["hourly"] = {}
  const hourAbs: SessionSummary["hourAbs"] = {}

  for (const k of keys) {
    const name = map[k] || k
    const body = cleanBody(String(models[k] || ""))
    const oT = estTokens(body)
    // MODEL0(本机 Claude 订阅直连)按官方牌价折算价值;其余按"中转实付价"(账单校准)
    const isLocal = /fable|opus/.test(name.toLowerCase())
    const c = isLocal ? costUSD(name, inTokEach, oT, 0, 0) : relayCostUSD(name, inTokEach, oT)
    const pp = isLocal ? findPricing(name) : findRelayPricing(name)
    ciSum += (inTokEach / 1e6) * pp.input
    coSum += (oT / 1e6) * pp.output
    cost += c
    outTok += oT
    const pm = (perModel[name] ||= { cost: 0, tokens: 0 })
    pm.cost += c
    pm.tokens += inTokEach + oT
  }
  const totTok = inTokEach * keys.length + outTok
  daily[dk] = { cost, tokens: totTok, out: outTok, inp: inTokEach * keys.length, cw: 0, cr: 0, ci: ciSum, co: coSum, ccw: 0, ccr: 0, nc: cost }
  hourly[dowh] = { c: cost, t: totTok }
  hourAbs[hk] = { c: cost, t: totTok }

  const qc = q.replace(/\s+/g, " ").trim()
  return {
    id: d.id || basename(file, ".json"),
    provider: "fusion",
    file,
    cwd: d.cwd || "unknown",
    title: `⚖️ Fusion×${keys.length}: ${qc.slice(0, 50)}`,
    start: ts,
    end: ts,
    msgCount: keys.length + 1,
    models: keys.map((k) => map[k] || k),
    tokens: { input: inTokEach * keys.length, output: outTok, cacheWrite: 0, cacheRead: 0 },
    costUSD: cost,
    hasSubagents: false,
    daily,
    hourly,
    hourAbs,
    perModel,
    activeMs: 5 * 60 * 1000, // 一次评审按 5 分钟活跃计
    blocks: 1,
    apiCalls: keys.length,
  }
}

export async function loadFusionSession(file: string): Promise<{ msgs: Msg[]; subagents: [] }> {
  const d: any = await Bun.file(file).json()
  const map = await fusionModelMap()
  const named: Record<string, string> = {}
  for (const [k, v] of Object.entries<any>(d.models || {})) named[map[k] ? `${map[k]}` : k] = cleanBody(String(v))
  const msgs: Msg[] = []
  msgs.push({ idx: 0, role: "user", ts: d.timestamp, blocks: [{ t: "text", text: String(d.question || "") }] })
  msgs.push({
    idx: 1,
    role: "assistant",
    ts: d.timestamp,
    blocks: [{ t: "fusion_panel", models: named, question: String(d.question || "") }],
  })
  return { msgs, subagents: [] }
}

// ---- retro-miner: harvest historical /fusion runs out of Claude Code session logs ----
// Writes one JSON per run into ~/.fusion/logs/imported/, idempotent by run key.
export async function mineHistoricalFusion(claudeFiles: string[]): Promise<number> {
  const outDir = join(FUSION_LOG_DIR, "imported")
  const { mkdirSync } = await import("node:fs")
  mkdirSync(outDir, { recursive: true })
  let written = 0
  for (const f of claudeFiles) {
    let text: string
    try {
      text = await Bun.file(f).text()
    } catch {
      continue
    }
    if (!text.includes("fusion_run.sh")) continue
    const pend = new Map<string, { cmd: string; ts?: string; cwd?: string }>()
    for (const line of text.split("\n")) {
      if (!line) continue
      let d: any
      try {
        d = JSON.parse(line)
      } catch {
        continue
      }
      const c = d.message?.content
      if (!Array.isArray(c)) continue
      for (const it of c) {
        if (it.type === "tool_use" && it.name === "Bash") {
          const cmd = String(it.input?.command || "")
          // 任何 fusion_run.sh 调用都候选(FUSION_FILES/FUSION_ONLY_KEYS 等新式前缀也算),
          // 真伪由结果里是否有 ≥2 个 MODEL 段来判定
          if (cmd.includes("fusion_run.sh")) pend.set(it.id, { cmd, ts: d.timestamp, cwd: d.cwd })
        }
        if (it.type === "tool_result" && pend.has(it.tool_use_id)) {
          const meta = pend.get(it.tool_use_id)!
          pend.delete(it.tool_use_id)
          let t = it.content
          if (Array.isArray(t)) t = t.map((p: any) => p?.text || "").join("")
          t = String(t || "")
          // 大输出被 Claude Code 收纳成 <persisted-output> 存根,真身在 tool-results/*.txt
          const stub = t.match(/Full output saved to: (\/[^\n]+?\.txt)/)
          if (stub && existsSync(stub[1])) {
            try {
              t = await Bun.file(stub[1]).text()
            } catch {}
          }
          // parse "### MODELn (name)" sections
          const sections = [...t.matchAll(/^### (MODEL\d+) \(([^)]+)\)$/gm)]
          if (sections.length < 2) continue // not a real panel output
          // key by the REAL model name from the header — old runs used a different
          // MODELn ordering than today's api.json, so MODELn keys would mismap.
          const models: Record<string, string> = {}
          for (let i = 0; i < sections.length; i++) {
            const s = sections[i]
            const start = (s.index || 0) + s[0].length
            const end = i + 1 < sections.length ? sections[i + 1].index : t.length
            models[s[2] || s[1]] = t.slice(start, end).trim().slice(0, 200000)
          }
          // question: heredoc body, or quoted arg
          let q = ""
          const hd = meta.cmd.match(/<<'?FUSION_PROMPT_EOF'?\n([\s\S]*?)\nFUSION_PROMPT_EOF/)
          if (hd) q = hd[1]
          else {
            const arg = meta.cmd.match(/fusion_run\.sh\s+"([\s\S]{4,2000}?)"/)
            if (arg) q = arg[1]
          }
          const ts = meta.ts || d.timestamp || new Date().toISOString()
          const id = "fusion-import-" + Bun.hash(f + it.tool_use_id).toString(36)
          const dest = join(outDir, id + ".json")
          if (existsSync(dest)) continue
          await Bun.write(dest, JSON.stringify({ id, timestamp: ts, cwd: meta.cwd || "unknown", question: q.slice(0, 20000), models, imported: true }))
          written++
        }
      }
    }
  }
  return written
}
