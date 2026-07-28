// 历史基线:Claude Code 默认 30 天清理本地 JSONL,更早的用量已不在磁盘上。
// Tokipet 的 usage_events 账本(SQLite)从安装起持续吸收并永久保存 —— 把其中
// "早于磁盘现存最早一天"的部分并入统计,只补缺口,绝不与磁盘数据重复计数。
// 快照落盘到 ~/.ai-cockpit/history-baseline.json,Tokipet 卸载后仍可用。
import { join } from "node:path"
import { homedir } from "node:os"
import { existsSync } from "node:fs"
import type { SessionSummary } from "./types"
import { findPricing } from "./pricing"

const TOKIPET_DB = join(homedir(), "Library", "Application Support", "Tokipet", "tokipet.sqlite")
const SNAP_FILE = join(homedir(), ".ai-cockpit", "history-baseline.json")

interface Row {
  d: string
  model: string
  i: number
  o: number
  cw: number
  cr: number
  n: number
}

let cached: { at: number; cutoff: string; sessions: SessionSummary[] } | null = null

async function queryRows(): Promise<Row[] | null> {
  if (!existsSync(TOKIPET_DB)) return null
  try {
    const proc = Bun.spawn(
      [
        "sqlite3",
        "-json",
        "-readonly",
        TOKIPET_DB,
        "SELECT date(timestamp,'localtime') d, model, sum(inputTokens) i, sum(outputTokens) o, sum(cacheCreationTokens) cw, sum(cacheReadTokens) cr, count(*) n FROM usage_events WHERE agent='claude-code' GROUP BY d, model ORDER BY d",
      ],
      { stdout: "pipe", stderr: "ignore" }
    )
    const out = await new Response(proc.stdout).text()
    await proc.exited
    if (proc.exitCode !== 0) return null
    const rows = JSON.parse(out || "[]")
    return Array.isArray(rows) && rows.length ? rows : null
  } catch {
    return null
  }
}

// 磁盘上最早的 Claude 数据日(历史基线只取这天之前的部分)
export function earliestClaudeDay(sessions: SessionSummary[]): string {
  let min = ""
  for (const s of sessions) {
    if (s.provider !== "claude") continue
    for (const dk of Object.keys(s.daily)) if (!min || dk < min) min = dk
  }
  return min || new Date().toISOString().slice(0, 10)
}

// 每个历史日合成一条 SessionSummary(provider=claude,file 以 history: 开头,
// stats 里排除出 高耗会话/Top 文件夹,只进总量/每日/模型/热力格)
export async function historySessions(cutoffDay: string): Promise<SessionSummary[]> {
  if (cached && cached.cutoff === cutoffDay && Date.now() - cached.at < 10 * 60_000) return cached.sessions
  let rows = await queryRows()
  if (rows) {
    try {
      await Bun.write(SNAP_FILE, JSON.stringify(rows))
    } catch {}
  } else {
    try {
      rows = await Bun.file(SNAP_FILE).json()
    } catch {}
  }
  const byDay = new Map<string, Row[]>()
  for (const r of rows || []) {
    if (!r.d || r.d >= cutoffDay) continue
    let list = byDay.get(r.d)
    if (!list) byDay.set(r.d, (list = []))
    list.push(r)
  }
  const out: SessionSummary[] = []
  for (const [day, rs] of byDay) {
    const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
    const perModel: SessionSummary["perModel"] = {}
    const models: string[] = []
    let cost = 0
    let ci = 0,
      co = 0,
      ccw = 0,
      ccr = 0,
      nc = 0,
      calls = 0
    for (const r of rs) {
      const p = findPricing(r.model)
      // 历史账本没有 5m/1h 缓存写明细,按 5m 价(input×1.25)保守估算
      const c = (r.i / 1e6) * p.input + (r.o / 1e6) * p.output + (r.cw / 1e6) * p.cacheWrite + (r.cr / 1e6) * p.cacheRead
      cost += c
      ci += (r.i / 1e6) * p.input
      co += (r.o / 1e6) * p.output
      ccw += (r.cw / 1e6) * p.cacheWrite
      ccr += (r.cr / 1e6) * p.cacheRead
      nc += ((r.i + r.cw + r.cr) / 1e6) * p.input + (r.o / 1e6) * p.output
      calls += r.n
      tokens.input += r.i
      tokens.output += r.o
      tokens.cacheWrite += r.cw
      tokens.cacheRead += r.cr
      if (!models.includes(r.model)) models.push(r.model)
      const pm = (perModel[r.model] ||= { cost: 0, tokens: 0 })
      pm.cost += c
      pm.tokens += r.i + r.o + r.cw + r.cr
    }
    const tok = tokens.input + tokens.output + tokens.cacheWrite + tokens.cacheRead
    out.push({
      id: `history-${day}`,
      provider: "claude",
      file: `history:${day}`,
      cwd: "(历史·Tokipet 账本)",
      title: `历史用量 ${day}(磁盘记录已被 Claude 30 天清理)`,
      start: `${day}T12:00:00`,
      end: `${day}T12:00:00`,
      msgCount: 0,
      models,
      tokens,
      costUSD: cost,
      hasSubagents: false,
      daily: { [day]: { cost, tokens: tok, out: tokens.output, inp: tokens.input, cw: tokens.cacheWrite, cr: tokens.cacheRead, ci, co, ccw, ccr, nc } },
      hourly: {},
      hourAbs: {},
      perModel,
      activeMs: 0,
      blocks: 0,
      apiCalls: calls,
    })
  }
  out.sort((a, b) => (a.end < b.end ? 1 : -1))
  cached = { at: Date.now(), cutoff: cutoffDay, sessions: out }
  return out
}
