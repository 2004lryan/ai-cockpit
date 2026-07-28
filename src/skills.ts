import { readdirSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { APP_DIR } from "./store"

const HOME = homedir()
const CC_DIR = join(HOME, ".claude", "skills")
const CX_DIR = join(HOME, ".codex", "skills")
const CACHE = join(APP_DIR, "skill-zh.json")

export interface SkillInfo {
  name: string
  desc: string // skill 自带的完整说明(frontmatter description)
  zh?: string // AI 生成的一句话中文简介
  tags: string[] // cc / cx
}

function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return {}
  const out: any = {}
  const nm = m[1].match(/^name:\s*(.+)$/m)
  if (nm) out.name = nm[1].trim().replace(/^["']|["']$/g, "")
  const dm = m[1].match(/^description:\s*([\s\S]*?)(?=\n\w+:|$)/m)
  if (dm) out.description = dm[1].replace(/\s+/g, " ").trim()
  return out
}

function scanDir(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir)) {
    const f = join(dir, e, "SKILL.md")
    try {
      if (!statSync(join(dir, e)).isDirectory() || !existsSync(f)) continue
      const md = require("node:fs").readFileSync(f, "utf-8").slice(0, 8000)
      const fm = parseFrontmatter(md)
      out.set(fm.name || e, fm.description || "")
    } catch {}
  }
  return out
}

export async function listSkills(): Promise<SkillInfo[]> {
  const cc = scanDir(CC_DIR)
  const cx = scanDir(CX_DIR)
  let zh: Record<string, string> = {}
  try {
    zh = await Bun.file(CACHE).json()
  } catch {}
  const names = new Set([...cc.keys(), ...cx.keys()].filter((n) => n && n.trim()))
  const out: SkillInfo[] = []
  for (const n of [...names].sort()) {
    const tags: string[] = []
    if (cc.has(n)) tags.push("cc")
    if (cx.has(n)) tags.push("cx")
    out.push({ name: n, desc: cc.get(n) || cx.get(n) || "", zh: zh[n], tags })
  }
  return out
}

// Generate one-line Chinese summaries for skills missing them (single claude call).
let generating = false
export async function generateZh(): Promise<{ ok: boolean; generated: number; running?: boolean }> {
  if (generating) return { ok: false, generated: 0, running: true }
  generating = true
  try {
    const skills = await listSkills()
    const missing = skills.filter((s) => !s.zh && s.desc)
    if (!missing.length) return { ok: true, generated: 0 }
    const batch = missing.slice(0, 150).map((s) => ({ name: s.name, desc: s.desc.slice(0, 260) }))
    const prompt =
      `下面是一批 AI 编程助手 skill 的名称和英文/中文说明。给每个 skill 写一句 ≤22 字的中文简介(说清它是干什么用的),` +
      `只输出 JSON 对象 {"skill名": "中文简介", ...},不要其他文字。\n\n` +
      JSON.stringify(batch, null, 0)
    const bin = [`${HOME}/.local/bin/claude`, "/opt/homebrew/bin/claude", "claude"].find((c) => c === "claude" || existsSync(c))!
    const proc = Bun.spawn([bin, "-p", prompt, "--model", "haiku"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: `${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}` },
    })
    const timeout = setTimeout(() => proc.kill(), 180000)
    const text = await new Response(proc.stdout).text()
    clearTimeout(timeout)
    const jm = text.match(/\{[\s\S]*\}/)
    if (!jm) return { ok: false, generated: 0 }
    const parsed = JSON.parse(jm[0])
    let zh: Record<string, string> = {}
    try {
      zh = await Bun.file(CACHE).json()
    } catch {}
    let n = 0
    for (const [k, v] of Object.entries(parsed))
      if (typeof v === "string" && v.trim()) {
        zh[k] = v.trim()
        n++
      }
    await Bun.write(CACHE, JSON.stringify(zh, null, 2))
    return { ok: true, generated: n }
  } catch {
    return { ok: false, generated: 0 }
  } finally {
    generating = false
  }
}
