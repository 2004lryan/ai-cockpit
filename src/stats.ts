import type { SessionSummary } from "./types"
import { equivMinutesPerBlock, findPricing } from "./pricing"
import { groupByFolder, shortPath } from "./store"

export type Range = "today" | "7d" | "30d" | "90d" | "1y" | "all"

export function rangeStart(range: Range): number {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  switch (range) {
    case "today":
      return today
    case "7d":
      return today - 6 * 86400000
    case "30d":
      return today - 29 * 86400000
    case "90d":
      return today - 89 * 86400000
    case "1y":
      return today - 364 * 86400000
    default:
      return 0
  }
}

function inRange(dayKey: string, startMs: number): boolean {
  if (!startMs) return true
  return Date.parse(dayKey + "T23:59:59") >= startMs
}

export function buildOverview(sessions: SessionSummary[], range: Range) {
  const startMs = rangeStart(range)
  let totalTokens = 0
  let listCost = 0
  let inp = 0,
    out = 0,
    cw = 0,
    cr = 0,
    inCost = 0,
    outCost = 0,
    cwCost = 0,
    crCost = 0,
    noCacheCost = 0
  const hourly: Record<string, { c: number; t: number }> = {}
  const perModel: Record<string, { cost: number; tokens: number }> = {}
  const perAgent: Record<string, number> = {}
  const perAgentTok: Record<string, number> = {}
  const perDayAgent: Record<string, Record<string, number>> = {}
  const perDayCost: Record<string, number> = {}
  const perDayTok: Record<string, number> = {}
  const perHourAgent: Record<string, Record<string, number>> = {} // "YYYY-MM-DD-HH" -> agent -> cost
  const perHourTok: Record<string, number> = {} // "YYYY-MM-DD-HH" -> tokens
  const topSessions: { title: string; id: string; provider: string; file: string; tokens: number; cost: number; folder: string; s?: SessionSummary }[] =
    []
  let activeMs = 0
  let blocks = 0
  let equivMin = 0

  for (const s of sessions) {
    let sCost = 0
    let sTok = 0
    for (const [dk, d] of Object.entries(s.daily)) {
      if (!inRange(dk, startMs)) continue
      sCost += d.cost
      sTok += d.tokens
      totalTokens += d.tokens
      listCost += d.cost
      inp += d.inp
      out += d.out
      cw += d.cw
      cr += d.cr
      const model = s.models[0] || ""
      const p = findPricing(model)
      inCost += d.ci ?? (d.inp / 1e6) * p.input
      outCost += d.co ?? (d.out / 1e6) * p.output
      cwCost += d.ccw ?? (d.cw / 1e6) * p.cacheWrite
      crCost += d.ccr ?? (d.cr / 1e6) * p.cacheRead
      noCacheCost += d.nc ?? ((d.cr + d.inp + d.cw) / 1e6) * p.input + (d.out / 1e6) * p.output
      perDayCost[dk] = (perDayCost[dk] || 0) + d.cost
      perDayTok[dk] = (perDayTok[dk] || 0) + d.tokens
      const pda = (perDayAgent[dk] ||= {})
      pda[s.provider] = (pda[s.provider] || 0) + d.cost
    }
    // range-filter approximation for per-model / hourly: include when session overlaps range
    const sessionEnd = Date.parse(s.end)
    if (sessionEnd >= startMs) {
      for (const [m, v] of Object.entries(s.perModel)) {
        const pm = (perModel[m] ||= { cost: 0, tokens: 0 })
        // scale by fraction of session cost inside range
        const frac = s.costUSD > 0 ? sCost / s.costUSD : 1
        pm.cost += v.cost * frac
        pm.tokens += v.tokens * frac
      }
      for (const [hk, v] of Object.entries(s.hourly)) {
        const frac = s.costUSD > 0 ? sCost / s.costUSD : 1
        const cell = (hourly[hk] ||= { c: 0, t: 0 })
        cell.c += (typeof v === "number" ? v : v.c) * frac
        cell.t += (typeof v === "number" ? 0 : v.t) * frac
      }
      if (s.hourAbs)
        for (const [ak, v] of Object.entries(s.hourAbs)) {
          const pha = (perHourAgent[ak] ||= {})
          pha[s.provider] = (pha[s.provider] || 0) + v.c
          perHourTok[ak] = (perHourTok[ak] || 0) + v.t
        }
      const frac = s.costUSD > 0 ? sCost / s.costUSD : startMs === 0 ? 1 : 0
      activeMs += s.activeMs * frac
      blocks += Math.round(s.blocks * frac)
      equivMin += s.blocks * frac * equivMinutesPerBlock(s.models[0] || "")
    }
    perAgent[s.provider] = (perAgent[s.provider] || 0) + sCost
    perAgentTok[s.provider] = (perAgentTok[s.provider] || 0) + sTok
    if ((sCost > 0.01 || sTok > 0) && !s.file.startsWith("history:"))
      topSessions.push({
        title: s.displayName || s.title,
        id: s.id,
        provider: s.provider,
        file: s.file,
        tokens: sTok,
        cost: sCost,
        folder: s.cwd.split("/").pop() || s.cwd, // 下面分组完再按项目根回填
        s,
      })
  }
  topSessions.sort((a, b) => b.tokens - a.tokens) // token 为权威口径

  // cache efficiency
  const cacheHit = inp + cr > 0 ? cr / (inp + cr) : 0
  const cacheSaved = Math.max(0, noCacheCost - listCost)

  // pace (always computed on calendar, independent of range)
  const now = new Date()
  let sum7 = 0
  let sum7Tok = 0
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const dk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    for (const s of sessions) {
      sum7 += s.daily[dk]?.cost || 0
      sum7Tok += s.daily[dk]?.tokens || 0
    }
  }
  const avg7 = sum7 / 7
  const avg7Tok = sum7Tok / 7
  let monthToDate = 0
  let monthToDateTok = 0
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
  for (const s of sessions)
    for (const [dk, d] of Object.entries(s.daily))
      if (dk.startsWith(monthPrefix)) {
        monthToDate += d.cost
        monthToDateTok += d.tokens
      }
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const dayOfMonth = now.getDate()
  const projMonth = dayOfMonth > 0 ? (monthToDate / dayOfMonth) * daysInMonth : 0
  const projMonthTok = dayOfMonth > 0 ? (monthToDateTok / dayOfMonth) * daysInMonth : 0

  // daily/hourly series — Today & 7d resolve to hours, others to days
  const dailySeries: { day: string; byAgent: Record<string, number>; total: number; tok: number }[] = []
  const hourlyMode = range === "today" || range === "7d"
  if (hourlyMode) {
    // 与卡片同口径:自然日(7d = 6 天前 00:00 起),而不是滚动 168 小时
    const nHours = range === "today" ? now.getHours() + 1 : 6 * 24 + now.getHours() + 1
    for (let i = nHours - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() - i)
      const ak = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}`
      const byAgent = perHourAgent[ak] || {}
      const total = Object.values(byAgent).reduce((a, b) => a + b, 0)
      dailySeries.push({ day: `${ak.slice(5, 10)} ${ak.slice(11)}:00`, byAgent, total, tok: perHourTok[ak] || 0 })
    }
  } else {
    const nDays = range === "30d" ? 30 : range === "90d" ? 90 : range === "1y" ? 365 : 0
    if (nDays) {
      for (let i = nDays - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
        const dk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
        dailySeries.push({ day: dk, byAgent: perDayAgent[dk] || {}, total: perDayCost[dk] || 0, tok: perDayTok[dk] || 0 })
      }
    } else {
      const keys = Object.keys(perDayCost).sort()
      for (const dk of keys) dailySeries.push({ day: dk, byAgent: perDayAgent[dk] || {}, total: perDayCost[dk], tok: perDayTok[dk] || 0 })
    }
  }

  // activity grid: last 17 weeks daily cost — always all-time data (not range-filtered),
  // padded back to the previous Sunday so week columns align.
  const allDayCost: Record<string, number> = {}
  const allDayTok: Record<string, number> = {}
  for (const s of sessions)
    for (const [dk, d] of Object.entries(s.daily)) {
      allDayCost[dk] = (allDayCost[dk] || 0) + d.cost
      allDayTok[dk] = (allDayTok[dk] || 0) + d.tokens
    }
  const grid: { day: string; cost: number; tok: number }[] = []
  const gridDays = 17 * 7
  const firstDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (gridDays - 1))
  const pad = firstDay.getDay() // 0=Sunday
  for (let i = gridDays - 1 + pad; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const dk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    grid.push({ day: dk, cost: allDayCost[dk] || 0, tok: allDayTok[dk] || 0 })
  }

  // top folders (within range) — 历史基线没有目录信息,不进文件夹榜
  const folders = groupByFolder(sessions.filter((s) => !s.file.startsWith("history:")))
    .map((g) => {
      let cost = 0
      let tok = 0
      let act = 0
      for (const s of g.sessions) {
        for (const [dk, d] of Object.entries(s.daily))
          if (inRange(dk, startMs)) {
            cost += d.cost
            tok += d.tokens
          }
        if (Date.parse(s.end) >= startMs) act += s.activeMs
      }
      return { name: g.name, cwd: g.cwd, shortPath: shortPath(g.cwd), cost, tokens: tok, activeMs: act, providers: g.providers }
    })
    .filter((f) => f.tokens > 0 || f.cost > 0.005)
    .sort((a, b) => b.tokens - a.tokens)

  // 热门会话的目录名统一按项目根显示(scratchpad/并入目录不要单独露出来)
  for (const t of topSessions) {
    const root = t.s?.root
    if (root) t.folder = root.split("/").pop() || root
    delete t.s
  }

  return {
    range,
    totalTokens,
    listCost,
    composition: {
      out: { tok: out, cost: outCost },
      inp: { tok: inp, cost: inCost },
      cw: { tok: cw, cost: cwCost },
      cr: { tok: cr, cost: crCost },
    },
    cacheHit,
    cacheSaved,
    noCacheCost,
    pace: { avg7, avg7Tok, monthToDate, monthToDateTok, projMonth, projMonthTok, dayOfMonth, daysInMonth },
    perModel: Object.entries(perModel)
      .filter(([m, v]) => !m.startsWith("<") && (v.cost > 0.001 || v.tokens > 0))
      .map(([m, v]) => ({ model: m, ...v }))
      .sort((a, b) => b.cost - a.cost),
    perAgent: Object.entries(perAgent)
      .map(([a, v]) => ({ agent: a, cost: v, tokens: perAgentTok[a] || 0 }))
      .sort((a, b) => b.tokens - a.tokens),
    topSessions: topSessions.slice(0, 10),
    equiv: { minutes: equivMin, blocks, activeMs },
    dailySeries,
    hourly,
    grid,
    folders: folders.slice(0, 12),
  }
}
