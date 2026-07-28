// Personal local-context aggregator: browser + device usage + IM activity for a range.
// Consumed by /api/personal (dashboard) and folded into the stage summary.
//
// OPT-IN — off unless COCKPIT_PERSONAL=1. Everything below reads local personal data
// (browsing history, Screen Time, IM database timestamps), so it stays disabled by
// default: a fresh install only ever looks at AI-assistant session logs.
import { getBrowserActivity, type BrowserActivity } from "./browser"
import { getAppUsage, type AppUsage } from "./usage"
import { getImActivity } from "./im"
import { rangeStart, type Range } from "./stats"

export const PERSONAL_ENABLED = process.env.COCKPIT_PERSONAL === "1"

export interface PersonalContext {
  range: Range
  enabled: boolean // false -> collectors never ran; every field below is empty
  browser: BrowserActivity
  usage: AppUsage
  im: ReturnType<typeof getImActivity>
  fdaMissing: boolean // Safari/Screen Time unreadable -> Full Disk Access not granted
}

let cache: { key: string; at: number; data: PersonalContext } | null = null

const emptyContext = (range: Range): PersonalContext => ({
  range,
  enabled: false,
  browser: { total: 0, browsers: {}, topDomains: [], hourly: Array(24).fill(0), daily: {}, recent: [], fda: false },
  usage: { apps: [], daily: {}, hourly: Array(24).fill(0), totalSeconds: 0, perApp: {}, fda: false },
  im: [],
  fdaMissing: false,
})

export function getPersonalContext(range: Range): PersonalContext {
  if (!PERSONAL_ENABLED) return emptyContext(range)
  const key = range
  // 2-min cache: SQLite copies + walks are not free
  if (cache && cache.key === key && Date.now() - cache.at < 120000) return cache.data

  const since = rangeStart(range)
  const browser = getBrowserActivity(since)
  const usage = getAppUsage(since)
  const im = getImActivity(usage.perApp)
  const fdaMissing = !usage.fda || !browser.fda

  const data: PersonalContext = { range, enabled: true, browser, usage, im, fdaMissing }
  cache = { key, at: Date.now(), data }
  return data
}

const fmtDur = (s: number) => {
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  return h ? `${h}h${m ? m + "m" : ""}` : `${m}m`
}

// Compact human-readable digest injected into the stage-summary prompt.
// Empty string when COCKPIT_PERSONAL is not set — the summary prompt then omits the
// whole "local activity" half (see summary.ts).
export function personalDigest(range: Range): string {
  if (!PERSONAL_ENABLED) return ""
  const p = getPersonalContext(range)
  const lines: string[] = []

  // Device usage
  if (p.usage.apps.length) {
    const top = p.usage.apps.slice(0, 12).map((a) => `${a.label} ${fmtDur(a.seconds)}`)
    lines.push(`【设备使用时长】总前台 ${fmtDur(p.usage.totalSeconds)};各 app:\n  ${top.join(" · ")}`)
  }

  // Browsing
  if (p.browser.total) {
    const doms = p.browser.topDomains.slice(0, 15).map((d) => `${d.domain}(${d.n})`)
    const byBrowser = Object.entries(p.browser.browsers).map(([b, n]) => `${b} ${n}`).join(" / ")
    lines.push(`【浏览器访问】共 ${p.browser.total} 次(${byBrowser});高频域名:\n  ${doms.join(" · ")}`)
  }

  // IM (activity signal only, no chat content)
  const imLines = p.im
    .filter((i) => i.installed)
    .map((i) => {
      const last = i.lastActive ? new Date(i.lastActive).toLocaleString("zh-CN", { hour12: false }) : "未知"
      return `${i.app}: 前台 ${fmtDur(i.usageSeconds)}, 最近有聊天写入 ${last}（消息库加密，未读内容）`
    })
  if (imLines.length) lines.push(`【即时通讯活跃度】\n  ${imLines.join("\n  ")}`)

  if (p.fdaMissing) lines.push(`（注：未授予完全磁盘访问权限，Safari/Screen Time 数据可能缺失）`)

  return lines.join("\n")
}
