// 自动备份:把 ~/.claude/projects 增量镜像到 ~/.ai-cockpit/backup(只增不删)。
// Claude Code 默认 30 天清理本地 JSONL(settings 里的 cleanupPeriodDays),镜像里的
// 副本不受影响 —— 原件被清掉后,仪表盘继续从镜像读它,会话和金额都不会凭空少一块。
// (Codex 不做自动清理,所以这里只镜像 Claude。)
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, copyFileSync, utimesSync, rmSync, constants } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { CLAUDE_DIR } from "./claude"

const PROJECTS = join(CLAUDE_DIR, "projects")
// 不从 store 里 import APP_DIR:store 要 import 本模块,绕回去就成环了
const MIRROR = join(homedir(), ".ai-cockpit", "backup")
const STATE = join(homedir(), ".ai-cockpit", "backup-state.json")

export interface BackupState {
  lastRun: string
  files: number // 镜像里的会话文件总数
  bytes: number
  copied: number // 本次新增/更新
  ms: number
}

function walk(dir: string, out: string[] = []): string[] {
  let ents: string[]
  try {
    ents = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of ents) {
    const p = join(dir, e)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(p, out)
    else if (e.endsWith(".jsonl")) out.push(p)
  }
  return out
}

// ---- 该不该备份 ----
// 镜像存在的唯一理由是 Claude Code 会按 settings 的 cleanupPeriodDays 清掉本地 JSONL。
// 把那个值调大的人不需要镜像:原件根本不会消失,再存一份只是白占盘(实测能到 GB 级)。
// COCKPIT_BACKUP=0 强制关 / =1 强制开,覆盖下面的自动判断。
const SKIP_ABOVE_DAYS = 90

function cleanupPeriodDays(): number | null {
  // local 覆盖 user,与 Claude Code 自身的优先级一致
  for (const f of ["settings.local.json", "settings.json"]) {
    try {
      const v = JSON.parse(readFileSync(join(CLAUDE_DIR, f), "utf8"))?.cleanupPeriodDays
      if (typeof v === "number") return v
    } catch {}
  }
  return null
}

export function backupPlan(): { run: boolean; why: string } {
  const forced = process.env.COCKPIT_BACKUP
  if (forced === "0") return { run: false, why: "COCKPIT_BACKUP=0" }
  if (forced === "1") return { run: true, why: "COCKPIT_BACKUP=1" }
  const days = cleanupPeriodDays()
  if (days === null) return { run: true, why: "cleanupPeriodDays 未设置(Claude Code 默认 30 天清理)" }
  if (days > SKIP_ABOVE_DAYS) return { run: false, why: `cleanupPeriodDays=${days} > ${SKIP_ABOVE_DAYS},原件不会被清理` }
  return { run: true, why: `cleanupPeriodDays=${days}` }
}

export function mirrorPathFor(file: string): string | null {
  if (!file.startsWith(PROJECTS + "/")) return null
  return join(MIRROR, file.slice(PROJECTS.length + 1))
}

export async function runBackup(): Promise<BackupState> {
  const t0 = Date.now()
  let copied = 0
  for (const src of walk(PROJECTS)) {
    const dest = join(MIRROR, src.slice(PROJECTS.length + 1))
    let s
    try {
      s = statSync(src)
    } catch {
      continue
    }
    let d: ReturnType<typeof statSync> | null = null
    try {
      d = statSync(dest)
    } catch {}
    if (d && d.size === s.size && Math.floor(d.mtimeMs) >= Math.floor(s.mtimeMs)) continue
    try {
      mkdirSync(dirname(dest), { recursive: true })
      // APFS 写时复制克隆:同卷上几乎不占额外空间,原件被清理后副本照样完整
      // (文件系统不支持克隆时会自动退回普通拷贝)
      if (existsSync(dest)) rmSync(dest, { force: true }) // FICLONE 要求目标不存在
      copyFileSync(src, dest, constants.COPYFILE_FICLONE)
      utimesSync(dest, s.atime, s.mtime) // 保住原始时间:过期判断、排序、增量比对都靠它
      copied++
    } catch {}
  }
  let files = 0
  let bytes = 0
  for (const f of walk(MIRROR)) {
    files++
    try {
      bytes += statSync(f).size
    } catch {}
  }
  const state: BackupState = { lastRun: new Date().toISOString(), files, bytes, copied, ms: Date.now() - t0 }
  try {
    await Bun.write(STATE, JSON.stringify(state))
  } catch {}
  return state
}

export async function backupState(): Promise<BackupState | null> {
  try {
    return await Bun.file(STATE).json()
  } catch {
    return null
  }
}

// 原件已被 Claude Code 清理、只剩镜像的会话(只认顶层会话文件,subagents 不算独立会话)
export function orphanBackupFiles(): string[] {
  if (!existsSync(MIRROR)) return []
  return walk(MIRROR).filter((f) => {
    const rel = f.slice(MIRROR.length + 1)
    return rel.split("/").length === 2 && !existsSync(join(PROJECTS, rel))
  })
}

export function isBackedUp(file: string): boolean {
  const m = mirrorPathFor(file)
  return !!m && existsSync(m)
}

// 删除会话时连镜像一起删,否则它会以「已归档」的身份在列表里复活
export function dropBackup(file: string): void {
  const m = mirrorPathFor(file)
  if (!m) return
  try {
    if (existsSync(m)) rmSync(m, { force: true })
    const dir = m.slice(0, -".jsonl".length) // 同名 subagents 目录
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  } catch {}
}
