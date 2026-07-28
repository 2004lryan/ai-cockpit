import { statSync, existsSync, mkdirSync, readdirSync } from "node:fs"
import { join, basename } from "node:path"
import { homedir } from "node:os"
import type { FolderGroup, SessionSummary } from "./types"
import { listClaudeFiles, scanClaudeFile } from "./claude"
import { orphanBackupFiles } from "./backup"
import { listCodexFiles, scanCodexFile } from "./codex"
import { listFusionFiles, scanFusionFile } from "./fusion"

export const APP_DIR = join(homedir(), ".ai-cockpit")
const CACHE_FILE = join(APP_DIR, "scan-cache-v4.json")
const META_FILE = join(APP_DIR, "metadata.json")

interface CacheEntry {
  mtime: number
  size: number
  summary: SessionSummary | null
}

let cache: Record<string, CacheEntry> = {}
let cacheLoaded = false
let metadata: {
  renames: Record<string, string>
  hiddenFolders: string[]
  hiddenSessions: string[]
  folderAliases: Record<string, string> // 手动并入:源目录 -> 目标项目根
} = { renames: {}, hiddenFolders: [], hiddenSessions: [], folderAliases: {} }
let hiddenSet = new Set<string>()
let hiddenFolderSet = new Set<string>()

async function loadCache() {
  if (cacheLoaded) return
  cacheLoaded = true
  mkdirSync(APP_DIR, { recursive: true })
  try {
    cache = await Bun.file(CACHE_FILE).json()
  } catch {
    cache = {}
  }
  try {
    metadata = await Bun.file(META_FILE).json()
    metadata.renames ||= {}
    metadata.hiddenFolders ||= []
    metadata.hiddenSessions ||= []
    metadata.folderAliases ||= {}
    hiddenSet = new Set(metadata.hiddenSessions)
    hiddenFolderSet = new Set(metadata.hiddenFolders)
  } catch {}
}

let saveTimer: Timer | null = null
function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(async () => {
    saveTimer = null
    try {
      await Bun.write(CACHE_FILE, JSON.stringify(cache))
    } catch {}
  }, 2000)
}

// 改 metadata 之前必须先 await 这个:它是懒加载的(第一次 scanAll 时才读盘),
// 服务刚起来就直接改并保存的话,会拿默认空对象把磁盘上的重命名/隐藏全冲掉
export async function ensureMetadata() {
  await loadCache()
}

export async function saveMetadata() {
  await Bun.write(META_FILE, JSON.stringify(metadata, null, 2))
}

export function setRename(provider: string, id: string, name: string) {
  if (name) metadata.renames[`${provider}:${id}`] = name
  else delete metadata.renames[`${provider}:${id}`]
}

// 隐藏 = 只从会话列表里拿掉,JSONL 原封不动,成本/token 照常进统计(删除才会掉数字)
export function setHidden(provider: string, id: string, hidden: boolean) {
  const k = `${provider}:${id}`
  if (hidden) hiddenSet.add(k)
  else hiddenSet.delete(k)
  metadata.hiddenSessions = [...hiddenSet]
}

export function hiddenCount(): number {
  return hiddenSet.size
}

// 整个项目文件夹隐藏(按分组后的项目根路径记),同样只动 metadata,不碰文件
export function setFolderHidden(cwd: string, hidden: boolean) {
  if (hidden) hiddenFolderSet.add(cwd)
  else hiddenFolderSet.delete(cwd)
  metadata.hiddenFolders = [...hiddenFolderSet]
}

export function isFolderHidden(cwd: string): boolean {
  return hiddenFolderSet.has(cwd)
}

// 手动并入:把一个游离目录(~/aar-020nir 这种从项目里 clone 出去的工作副本)永久归到某个项目根下。
// to 为空 = 撤销并入。同样只动 metadata,不碰任何文件。
export function setFolderAlias(from: string, to: string) {
  if (to && to !== from) metadata.folderAliases[from] = to
  else delete metadata.folderAliases[from]
}

export function folderAliases(): Record<string, string> {
  return metadata.folderAliases
}

let scanning: Promise<SessionSummary[]> | null = null

export async function scanAll(force = false): Promise<SessionSummary[]> {
  if (scanning) return scanning
  scanning = doScan(force).finally(() => {
    scanning = null
  })
  return scanning
}

async function doScan(force: boolean): Promise<SessionSummary[]> {
  await loadCache()
  const jobs: { file: string; kind: "claude" | "codex" | "fusion" }[] = []
  for (const f of listClaudeFiles()) jobs.push({ file: f, kind: "claude" })
  // 原件已被 30 天清理、只剩自动备份的会话:照样扫进来,列表和统计都不断档
  const orphans = new Set(orphanBackupFiles())
  for (const f of orphans) jobs.push({ file: f, kind: "claude" })
  for (const f of listCodexFiles()) jobs.push({ file: f, kind: "codex" })
  for (const f of listFusionFiles()) jobs.push({ file: f, kind: "fusion" })

  const alive = new Set(jobs.map((j) => j.file))
  for (const k of Object.keys(cache)) if (!alive.has(k)) delete cache[k]

  const out: SessionSummary[] = []
  const CONCURRENCY = 8
  let i = 0
  async function worker() {
    while (i < jobs.length) {
      const job = jobs[i++]
      let st: { mtimeMs: number; size: number }
      try {
        st = statSync(job.file)
      } catch {
        continue
      }
      // Claude 会话的子代理文件也计入缓存键,子代理增长时触发重扫
      if (job.kind === "claude") {
        const subDir = job.file.slice(0, -".jsonl".length) + "/subagents"
        if (existsSync(subDir)) {
          let mt = st.mtimeMs
          let sz = st.size
          try {
            for (const f of readdirSync(subDir)) {
              if (!f.endsWith(".jsonl")) continue
              const s2 = statSync(join(subDir, f))
              if (s2.mtimeMs > mt) mt = s2.mtimeMs
              sz += s2.size
            }
          } catch {}
          st = { mtimeMs: mt, size: sz }
        }
      }
      const c = cache[job.file]
      if (!force && c && c.mtime === st.mtimeMs && c.size === st.size) {
        if (c.summary) out.push(c.summary)
        continue
      }
      let summary: SessionSummary | null = null
      try {
        summary =
          job.kind === "claude"
            ? await scanClaudeFile(job.file)
            : job.kind === "codex"
              ? await scanCodexFile(job.file)
              : await scanFusionFile(job.file)
      } catch {}
      cache[job.file] = { mtime: st.mtimeMs, size: st.size, summary }
      scheduleSave()
      if (summary) out.push(summary)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  for (const s of out) {
    // 缓存里是同一个对象引用,取消重命名/取消隐藏时必须显式覆盖,不能只在为真时赋值
    const k = `${s.provider}:${s.id}`
    s.displayName = metadata.renames[k] || undefined
    s.hidden = hiddenSet.has(k)
    s.archived = orphans.has(s.file)
  }
  out.sort((a, b) => (a.end < b.end ? 1 : -1))
  return out
}

const HOME = homedir()

export function shortPath(p: string): string {
  return p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p
}

// ---- Smart project-root inference ----
// 06doc/01manuscript/02sub… style working dirs merge up into their project root:
//   root = child of the DEEPEST "hub" directory on the path,
//   hub = 组织目录:既 fan 出 ≥2 条带会话的子路径,自己又几乎没直接跑过会话
//   (~/Desktop/experiments、~/work/papers 这种)。反过来,一个自己就直接跑了
//   上百个会话的目录是项目本体而不是组织目录 —— 它的子目录要并进来。
//   其他保护:
//   - a cwd that is itself a git repo root stays its own project
//   - generic system dirs never become roots
const PROJECT_MIN_DIRECT = 3 // 直接跑过 ≥3 个会话就认定是项目根,不再往下拆
const BLOCKED_ROOT_NAMES = new Set([
  "Library", "Application Support", "Mobile Documents", "Desktop", "Documents",
  "Downloads", "Users", "Volumes", "private", "tmp", "var", "opt", "home",
])

// ---- cwd 归一化:让"跑到别处去的会话"回到它真正属于的项目 ----
// 1) Claude Code 的 scratchpad:/private/tmp/claude-<uid>/<项目 slug>/<会话 id>/scratchpad/...
//    codex / 子进程 cd 进去之后,会话的 cwd 就变成了那串临时路径,列表里于是冒出
//    audit_r8、aar-020c4p 这种孤儿文件夹。slug 是把真实路径里所有非字母数字换成 "-"
//    (中文全变成 "-",有损),所以优先用中间那段会话 id 反查发起它的 Claude 会话的 cwd,
//    查不到再用 slug 反查(原会话已被清理时兜底)。
// 2) 用户手动并入的目录(metadata.folderAliases)。
const SCRATCHPAD_RE =
  /^\/(?:private\/)?tmp\/claude-\d+\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/

function slugifyPath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, "-")
}

function resolveGroupCwds(sessions: SessionSummary[]) {
  const byId = new Map<string, string>() // Claude 会话 id -> 真实 cwd
  const bySlug = new Map<string, Map<string, number>>() // slug -> {cwd: 会话数}
  for (const s of sessions) {
    const c = s.cwd
    if (!c || !c.startsWith("/") || SCRATCHPAD_RE.test(c)) continue
    if (s.provider === "claude") byId.set(s.id, c)
    const k = slugifyPath(c)
    let m = bySlug.get(k)
    if (!m) bySlug.set(k, (m = new Map()))
    m.set(c, (m.get(c) || 0) + 1)
  }
  const slugBest = new Map<string, string>()
  for (const [k, m] of bySlug) {
    // slug 有损,可能对上多个真实路径 —— 取会话最多的那个
    let best = "",
      n = -1
    for (const [c, cnt] of m) if (cnt > n) ((best = c), (n = cnt))
    slugBest.set(k, best)
  }
  for (const s of sessions) {
    let c = s.cwd
    const m = SCRATCHPAD_RE.exec(c)
    if (m) c = byId.get(m[2]) || slugBest.get(m[1]) || c
    s.groupCwd = applyAlias(c)
  }
}

// 顺着 folderAliases 链走(带环保护),得到最终的项目根
function applyAlias(p: string): string {
  const a = metadata.folderAliases
  let cur = p
  for (let i = 0; i < 8; i++) {
    const next = a[cur]
    if (!next || next === cur) break
    cur = next
  }
  return cur
}

function computeRoots(sessions: SessionSummary[]): Map<string, string> {
  const cwds = new Set(sessions.map((s) => s.groupCwd!).filter((c) => c && c !== "unknown" && c.startsWith("/")))
  const direct = new Map<string, number>() // 每个目录里"直接"跑了多少会话
  for (const s of sessions) if (cwds.has(s.groupCwd!)) direct.set(s.groupCwd!, (direct.get(s.groupCwd!) || 0) + 1)
  const children = new Map<string, Set<string>>()
  for (const cwd of cwds) {
    const parts = cwd.split("/").filter(Boolean)
    let cur = ""
    for (const p of parts) {
      const parent = cur || "/"
      let set = children.get(parent)
      if (!set) children.set(parent, (set = new Set()))
      set.add(p)
      cur = cur + "/" + p
    }
  }
  const roots = new Map<string, string>()
  for (const cwd of cwds) {
    // a git repo root is always its own project
    if (existsSync(join(cwd, ".git"))) {
      roots.set(cwd, cwd)
      continue
    }
    const parts = cwd.split("/").filter(Boolean)
    let root = cwd
    let cur = ""
    for (let i = 0; i < parts.length; i++) {
      const dir = cur || "/"
      const cand = cur + "/" + parts[i] // child of `dir` on this path
      // dir 自己就跑了不少会话 → 它是项目本体,底下的 06doc / idea-stage / 02sub 全部并进来
      const dirName = basename(dir)
      if (
        dir !== "/" &&
        dir !== HOME &&
        (direct.get(dir) || 0) >= PROJECT_MIN_DIRECT &&
        !BLOCKED_ROOT_NAMES.has(dirName) &&
        !dirName.startsWith(".")
      ) {
        root = dir
        break
      }
      const fan = children.get(dir)?.size || 0
      if (
        i < parts.length && // candidate may equal cwd itself
        fan >= 2 &&
        dir !== "/" &&
        dir !== "/Users" &&
        dir !== "/Volumes" &&
        !BLOCKED_ROOT_NAMES.has(parts[i]) &&
        !parts[i].startsWith(".") && // 不把 .claude/.config 这类点目录当项目根
        cand !== HOME
      )
        root = cand // deepest hub wins (keep overwriting)
      cur = cand
    }
    // never merge across a git boundary: if some dir between root and cwd is a repo, use it
    if (root !== cwd) {
      let p = cwd
      while (p.length > root.length) {
        if (existsSync(join(p, ".git"))) {
          root = p
          break
        }
        p = p.slice(0, p.lastIndexOf("/"))
      }
    }
    roots.set(cwd, root)
  }
  return roots
}

// ---- Folder grouping: merge Claude + Codex + Fusion sessions under the project root ----
export function groupByFolder(sessions: SessionSummary[]): FolderGroup[] {
  resolveGroupCwds(sessions)
  const roots = computeRoots(sessions)
  const map = new Map<string, FolderGroup>()
  const merged = new Map<string, Map<string, { cwd: string; name: string; auto?: boolean }>>()
  for (const s of sessions) {
    const pre = roots.get(s.groupCwd!) || s.groupCwd || "unknown" // 智能项目根(套别名之前)
    // 智能项目根之后再过一遍别名:用户并入的是整个项目根时也要生效
    const key = applyAlias(pre)
    s.root = key
    // 记下"这个组里混进了哪些外部目录",UI 里给一个撤销入口
    const note = (cwd: string, auto: boolean) => {
      let m = merged.get(key)
      if (!m) merged.set(key, (m = new Map()))
      if (!m.has(cwd)) m.set(cwd, { cwd, name: basename(cwd) || cwd, auto })
    }
    if (key !== pre) note(pre, false)
    else if (s.groupCwd !== s.cwd) note(s.cwd, metadata.folderAliases[s.cwd] === undefined)
    let g = map.get(key)
    if (!g) {
      g = {
        cwd: key,
        name: basename(key) || key,
        shortPath: shortPath(key),
        sessions: [],
        costUSD: 0,
        tokens: 0,
        activeMs: 0,
        lastActive: "",
        providers: [],
      }
      map.set(key, g)
    }
    g.sessions.push(s)
    g.costUSD += s.costUSD
    g.tokens += s.tokens.input + s.tokens.output + s.tokens.cacheWrite + s.tokens.cacheRead
    g.activeMs += s.activeMs
    if (s.end > g.lastActive) g.lastActive = s.end
    if (!g.providers.includes(s.provider)) g.providers.push(s.provider)
  }
  const out = [...map.values()]
  for (const g of out) {
    g.sessions.sort((a, b) => (a.end < b.end ? 1 : -1)) // 最近使用优先
    const m = merged.get(g.cwd)
    if (m) g.mergedFrom = [...m.values()].sort((a, b) => (a.name < b.name ? -1 : 1))
  }
  out.sort((a, b) => (a.lastActive < b.lastActive ? 1 : -1))
  return out
}
