// Device usage collector — reads macOS knowledgeC.db (Screen Time backing store).
// Needs Full Disk Access for the running process. Read-only via temp copy.
import { Database } from "bun:sqlite"
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"

const HOME = homedir()
const KNOWLEDGE = join(HOME, "Library/Application Support/Knowledge/knowledgeC.db")
const COCOA_EPOCH_OFFSET_S = 978307200

// Friendly names for common bundle ids (fallback: last dotted segment).
const APP_NAMES: Record<string, string> = {
  "com.tencent.xinWeChat": "微信",
  "com.tencent.qq": "QQ",
  "com.apple.Safari": "Safari",
  "com.google.Chrome": "Chrome",
  "com.microsoft.edgemac": "Edge",
  "company.thebrowser.Browser": "Arc",
  "com.apple.dt.Xcode": "Xcode",
  "com.microsoft.VSCode": "VS Code",
  "com.todesktop.230313mzl4w4u92": "Cursor",
  "com.apple.Terminal": "Terminal",
  "com.googlecode.iterm2": "iTerm",
  "com.tinyspeck.slackmacgap": "Slack",
  "com.hnc.Discord": "Discord",
  "ru.keepcoder.Telegram": "Telegram",
  "com.apple.mail": "Mail",
  "com.apple.MobileSMS": "信息",
  "com.spotify.client": "Spotify",
  "com.apple.Music": "Music",
  "com.figma.Desktop": "Figma",
  "notion.id": "Notion",
  "md.obsidian": "Obsidian",
}

export function appLabel(bundle: string): string {
  return APP_NAMES[bundle] || bundle.split(".").pop() || bundle
}

export interface AppUsage {
  apps: { bundle: string; label: string; seconds: number }[]
  daily: Record<string, number> // YYYY-MM-DD -> total foreground seconds
  hourly: number[] // 24 buckets -> seconds
  totalSeconds: number
  perApp: Record<string, number> // bundle -> seconds (for cross-module lookup, e.g. IM)
  fda: boolean
}

export function getAppUsage(sinceMs: number): AppUsage {
  const empty: AppUsage = { apps: [], daily: {}, hourly: new Array(24).fill(0), totalSeconds: 0, perApp: {}, fda: false }
  if (!existsSync(KNOWLEDGE)) return empty

  const tmpRoot = mkdtempSync(join(tmpdir(), "cockpit-usage-"))
  const tmp = join(tmpRoot, "k.db")
  let db: Database
  try {
    copyFileSync(KNOWLEDGE, tmp)
    for (const ext of ["-wal", "-shm"]) if (existsSync(KNOWLEDGE + ext)) try { copyFileSync(KNOWLEDGE + ext, tmp + ext) } catch {}
    db = new Database(tmp, { readonly: true })
  } catch {
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
    return empty // FDA not granted
  }

  const perApp: Record<string, number> = {}
  const daily: Record<string, number> = {}
  const hourly = new Array(24).fill(0)
  let totalSeconds = 0
  try {
    const minCocoa = sinceMs / 1000 - COCOA_EPOCH_OFFSET_S
    const rows = db
      .query(
        `SELECT ZVALUESTRING AS app, ZSTARTDATE AS s, ZENDDATE AS e
         FROM ZOBJECT
         WHERE ZSTREAMNAME = '/app/usage' AND ZSTARTDATE > ? AND ZVALUESTRING IS NOT NULL`
      )
      .all(minCocoa) as { app: string; s: number; e: number }[]
    for (const r of rows) {
      const dur = (r.e ?? 0) - (r.s ?? 0)
      if (!(dur > 0) || dur > 12 * 3600) continue // drop zero/garbage spans
      perApp[r.app] = (perApp[r.app] || 0) + dur
      totalSeconds += dur
      const startMs = (r.s + COCOA_EPOCH_OFFSET_S) * 1000
      const dt = new Date(startMs)
      hourly[dt.getHours()] += dur
      const dk = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`
      daily[dk] = (daily[dk] || 0) + dur
    }
  } catch {
    // fall through — return whatever we have
  } finally {
    db.close()
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  }

  const apps = Object.entries(perApp)
    .map(([bundle, seconds]) => ({ bundle, label: appLabel(bundle), seconds }))
    .sort((a, b) => b.seconds - a.seconds)

  return { apps, daily, hourly, totalSeconds, perApp, fda: true }
}
