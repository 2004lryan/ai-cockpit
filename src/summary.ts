import { join } from "node:path"
import { APP_DIR, groupByFolder } from "./store"
import type { SessionSummary } from "./types"
import type { Range } from "./stats"
import { rangeStart } from "./stats"
import { personalDigest } from "./personal"

const CACHE = join(APP_DIR, "summaries.json")
let cache: Record<string, { at: number; text: string }> = {}
let loaded = false

async function load() {
  if (loaded) return
  loaded = true
  try {
    cache = await Bun.file(CACHE).json()
  } catch {}
}

// "阶段总结: 我都用 AI 干了什么" — digest sessions in range, ask local claude CLI.
export async function stageSummary(sessions: SessionSummary[], range: Range, force = false): Promise<{ text: string; cached: boolean }> {
  await load()
  const key = range
  const fresh = cache[key] && Date.now() - cache[key].at < 6 * 3600 * 1000
  if (fresh && !force) return { text: cache[key].text, cached: true }

  const startMs = rangeStart(range)
  const inRange = sessions.filter((s) => Date.parse(s.end) >= startMs)
  if (!inRange.length) return { text: "该时间段内没有 AI 会话记录。", cached: false }

  groupByFolder(inRange) // 只为把 s.root(项目根)填上
  const byFolder = new Map<string, { titles: string[]; cost: number; n: number }>()
  for (const s of inRange) {
    // 按项目根归并(root 由 groupByFolder 填):scratchpad / 并入的目录不单独算一项
    const base = s.root || s.cwd
    const f = base.split("/").pop() || base
    const g = byFolder.get(f) || { titles: [], cost: 0, n: 0 }
    if (g.titles.length < 8) g.titles.push((s.displayName || s.title).slice(0, 50))
    g.cost += s.costUSD
    g.n++
    byFolder.set(f, g)
  }
  const digest = [...byFolder.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, 24)
    .map(([f, g]) => `【${f}】${g.n} 个会话, $${g.cost.toFixed(2)}\n  - ${g.titles.join("\n  - ")}`)
    .join("\n")

  // Local-machine context (browser / device usage / IM activity). Best-effort; empty if
  // Full Disk Access isn't granted or nothing is available.
  let personal = ""
  try {
    personal = personalDigest(range)
  } catch {}

  const prompt =
    `以下是我最近(${range})的数字活动记录,分两部分。\n\n` +
    `# 第一部分:AI 编程助手会话(Claude Code / Codex / Fusion),按项目分组、附成本\n${digest}\n\n` +
    (personal ? `# 第二部分:本机活动(浏览器 / 设备使用时长 / 即时通讯活跃度)\n${personal}\n\n` : "") +
    `请用中文 Markdown 写一份详细的"阶段总结",结构如下:\n` +
    `## 总览\n一小段话概括这段时间我的整体状态:既有编程工作重心,也结合本机活动看时间都花在哪。\n` +
    `## 各项目进展\n每个主要 AI 编程项目一个 **加粗小标题** + 2-4 条要点(做了什么、进展到哪一步、大致花费)。\n` +
    (personal ? `## 时间与注意力分布\n结合设备使用时长、浏览高频域名、IM 活跃度,2-4 条要点(时间花在哪、专注还是分散、作息规律)。注意:微信/QQ 聊天内容是加密的、我读不到,只能看活跃时段与时长,不要编造聊天细节。\n` : "") +
    `## 花费与效率观察\n2-3 条要点(钱花在哪、哪些用法值得优化)。\n` +
    `## 下一步建议\n2-3 条要点。\n` +
    `要求:基于给出的记录合理推断但不要编造具体细节;直接输出 Markdown,不要客套话。`

  try {
    const home = process.env.HOME || ""
    const candidates = [`${home}/.local/bin/claude`, `${home}/.npm-global/bin/claude`, "/usr/local/bin/claude", "/opt/homebrew/bin/claude", "claude"]
    let bin = "claude"
    for (const c of candidates) {
      if (c === "claude" || (await Bun.file(c).exists())) {
        bin = c
        break
      }
    }
    const proc = Bun.spawn([bin, "-p", prompt, "--model", "sonnet"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: `${home}/.local/bin:${home}/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}` },
    })
    const timeout = setTimeout(() => proc.kill(), 90000)
    const text = await new Response(proc.stdout).text()
    clearTimeout(timeout)
    const clean = text.trim()
    if (clean) {
      cache[key] = { at: Date.now(), text: clean }
      await Bun.write(CACHE, JSON.stringify(cache))
      return { text: clean, cached: false }
    }
  } catch {}
  return { text: "生成总结失败(需要本机可用的 claude CLI)。以下为原始摘要:\n\n" + digest, cached: false }
}
