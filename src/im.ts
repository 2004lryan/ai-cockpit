// IM (WeChat / QQ) activity — WITHOUT decrypting chats.
// Message stores are SQLCipher-encrypted; we never touch their content. Instead we report:
//   - presence + how many message DBs exist
//   - last-active proxy = newest message-DB mtime (a chat wrote to disk)
//   - foreground time from knowledgeC app usage (passed in from usage.ts)
import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const HOME = homedir()

interface ImApp {
  app: string // "微信" | "QQ"
  bundle: string
  installed: boolean
  encrypted: boolean // message store is encrypted (chat content unreadable)
  messageDbs: number
  lastActive: number | null // ms epoch — newest message-db mtime
  usageSeconds: number // foreground time in range (from knowledgeC)
}

// recursively collect files matching a predicate, depth-limited to keep it cheap
function walk(dir: string, match: (name: string) => boolean, depth = 6, out: string[] = []): string[] {
  if (depth < 0 || !existsSync(dir)) return out
  let entries: ReturnType<typeof readdirSync>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) walk(full, match, depth - 1, out)
    else if (match(e.name)) out.push(full)
  }
  return out
}

function newestMtime(files: string[]): number | null {
  let m: number | null = null
  for (const f of files) {
    try {
      const t = statSync(f).mtimeMs
      if (m === null || t > m) m = t
    } catch {}
  }
  return m
}

export function getImActivity(perAppUsage: Record<string, number>): ImApp[] {
  const out: ImApp[] = []

  // ---- WeChat ----
  const wxRoot = join(HOME, "Library/Containers/com.tencent.xinWeChat")
  {
    const installed = existsSync(wxRoot)
    let dbs: string[] = []
    let mtimeFiles: string[] = []
    if (installed) {
      const support = join(wxRoot, "Data/Library/Application Support/com.tencent.xinWeChat")
      // count real .db files; but track -wal/-shm sidecars too for lastActive (live writes land there)
      mtimeFiles = walk(support, (n) => /^msg_\d+\.db(-wal|-shm)?$/.test(n))
      dbs = mtimeFiles.filter((f) => f.endsWith(".db"))
    }
    out.push({
      app: "微信",
      bundle: "com.tencent.xinWeChat",
      installed,
      encrypted: dbs.length > 0, // WeChat message stores are always SQLCipher
      messageDbs: dbs.length,
      lastActive: newestMtime(mtimeFiles),
      usageSeconds: perAppUsage["com.tencent.xinWeChat"] || 0,
    })
  }

  // ---- QQ (NT architecture) ----
  const qqRoot = join(HOME, "Library/Containers/com.tencent.qq")
  {
    const installed = existsSync(qqRoot)
    let dbs: string[] = []
    if (installed) {
      const support = join(qqRoot, "Data/Library/Application Support/QQ")
      // NT QQ keeps message data under nt_qq_*/nt_db and nt_data
      dbs = walk(support, (n) => n.endsWith(".db") && (n.includes("msg") || n.startsWith("nt_")))
    }
    out.push({
      app: "QQ",
      bundle: "com.tencent.qq",
      installed,
      encrypted: dbs.length > 0,
      messageDbs: dbs.length,
      lastActive: newestMtime(dbs),
      usageSeconds: perAppUsage["com.tencent.qq"] || 0,
    })
  }

  return out
}
