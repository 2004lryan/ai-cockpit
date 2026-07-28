// Browser history collector — Chromium-family (Chrome/Edge/Brave/Arc) + Safari.
// Read-only; DBs are copied to a temp file first because the browser holds a lock.
import { Database } from "bun:sqlite"
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"

export interface Visit {
  ts: number // ms epoch
  url: string
  title: string
  browser: string
}
export interface BrowserActivity {
  total: number
  browsers: Record<string, number> // browser -> visit count
  topDomains: { domain: string; n: number }[]
  hourly: number[] // 24 buckets (local hour) -> visit count
  daily: Record<string, number> // YYYY-MM-DD -> count
  recent: Visit[] // most recent visits (capped)
  fda: boolean // did Safari read succeed (proxy for Full Disk Access)
}

const HOME = homedir()
// Chromium epoch: microseconds since 1601-01-01. Safari/CFAbsoluteTime: seconds since 2001-01-01.
const CHROME_EPOCH_OFFSET_MS = 11644473600000
const COCOA_EPOCH_OFFSET_S = 978307200

// Chromium bases -> label. We look for `**/History` a couple levels deep per base.
const CHROMIUM: Record<string, string> = {
  "Library/Application Support/Google/Chrome": "Chrome",
  "Library/Application Support/Microsoft Edge": "Edge",
  "Library/Application Support/BraveSoftware/Brave-Browser": "Brave",
  "Library/Application Support/Arc/User Data": "Arc",
}

function findHistoryDbs(base: string): string[] {
  const root = join(HOME, base)
  if (!existsSync(root)) return []
  const found: string[] = []
  const direct = join(root, "History")
  if (existsSync(direct)) found.push(direct)
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      // skip noise profiles that never hold real browsing
      if (entry.name === "System Profile" || entry.name === "Guest Profile") continue
      const cand = join(root, entry.name, "History")
      if (existsSync(cand)) found.push(cand)
    }
  } catch {}
  return found
}

function openCopy(src: string, tmp: string): Database | null {
  try {
    // copy the main db + WAL/SHM sidecars so a mid-write snapshot stays consistent
    copyFileSync(src, tmp)
    for (const ext of ["-wal", "-shm"]) {
      if (existsSync(src + ext)) {
        try {
          copyFileSync(src + ext, tmp + ext)
        } catch {}
      }
    }
    return new Database(tmp, { readonly: true })
  } catch {
    return null
  }
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}

export function getBrowserActivity(sinceMs: number, recentCap = 60): BrowserActivity {
  const tmpRoot = mkdtempSync(join(tmpdir(), "cockpit-hist-"))
  const visits: Visit[] = []
  let fda = true
  let i = 0

  const push = (v: Visit) => {
    if (v.ts >= sinceMs && v.url && !v.url.startsWith("chrome://") && !v.url.startsWith("about:")) visits.push(v)
  }

  try {
    // ---- Chromium family ----
    for (const [base, label] of Object.entries(CHROMIUM)) {
      for (const dbPath of findHistoryDbs(base)) {
        const tmp = join(tmpRoot, `c${i++}.db`)
        const db = openCopy(dbPath, tmp)
        if (!db) continue
        try {
          // last_visit_time is microseconds since 1601
          const minChrome = (sinceMs + CHROME_EPOCH_OFFSET_MS) * 1000
          const rows = db
            .query("SELECT url, title, last_visit_time AS t FROM urls WHERE last_visit_time > ? ORDER BY last_visit_time DESC LIMIT 4000")
            .all(minChrome) as { url: string; title: string; t: number }[]
          for (const r of rows) push({ ts: r.t / 1000 - CHROME_EPOCH_OFFSET_MS, url: r.url, title: r.title || "", browser: label })
        } catch {} finally {
          db.close()
        }
      }
    }

    // ---- Safari (needs Full Disk Access) ----
    const safari = join(HOME, "Library/Safari/History.db")
    if (existsSync(safari)) {
      const tmp = join(tmpRoot, "safari.db")
      const db = openCopy(safari, tmp)
      if (!db) fda = false
      else {
        try {
          const minCocoa = sinceMs / 1000 - COCOA_EPOCH_OFFSET_S
          const rows = db
            .query(
              `SELECT i.url AS url, v.title AS title, v.visit_time AS t
               FROM history_visits v JOIN history_items i ON i.id = v.history_item
               WHERE v.visit_time > ? ORDER BY v.visit_time DESC LIMIT 4000`
            )
            .all(minCocoa) as { url: string; title: string; t: number }[]
          for (const r of rows) push({ ts: (r.t + COCOA_EPOCH_OFFSET_S) * 1000, url: r.url, title: r.title || "", browser: "Safari" })
        } catch {
          fda = false
        } finally {
          db.close()
        }
      }
    }
  } finally {
    try {
      rmSync(tmpRoot, { recursive: true, force: true })
    } catch {}
  }

  visits.sort((a, b) => b.ts - a.ts)

  const browsers: Record<string, number> = {}
  const domains = new Map<string, number>()
  const hourly = new Array(24).fill(0)
  const daily: Record<string, number> = {}
  for (const v of visits) {
    browsers[v.browser] = (browsers[v.browser] || 0) + 1
    const d = domainOf(v.url)
    if (d) domains.set(d, (domains.get(d) || 0) + 1)
    const dt = new Date(v.ts)
    hourly[dt.getHours()]++
    const dk = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`
    daily[dk] = (daily[dk] || 0) + 1
  }
  const topDomains = [...domains.entries()].map(([domain, n]) => ({ domain, n })).sort((a, b) => b.n - a.n).slice(0, 25)

  return { total: visits.length, browsers, topDomains, hourly, daily, recent: visits.slice(0, recentCap), fda }
}
