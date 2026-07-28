import { existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { $ } from "bun"
import { APP_DIR } from "./store"

const CONF = join(APP_DIR, "repos.json")

// launchd 环境没有代理变量;从系统设置读代理给 git 用(访问 GitHub 常需要)
let proxyEnv: Record<string, string> | null = null
async function gitEnv(): Promise<Record<string, string>> {
  if (proxyEnv) return proxyEnv
  const env: Record<string, string> = { ...process.env } as any
  try {
    const p = await $`scutil --proxy`.quiet().text()
    const http = p.match(/HTTPEnable\s*:\s*1[\s\S]*?HTTPProxy\s*:\s*(\S+)[\s\S]*?HTTPPort\s*:\s*(\d+)/)
    const https = p.match(/HTTPSEnable\s*:\s*1[\s\S]*?HTTPSProxy\s*:\s*(\S+)[\s\S]*?HTTPSPort\s*:\s*(\d+)/)
    if (https) env.https_proxy = env.HTTPS_PROXY = `http://${https[1]}:${https[2]}`
    if (http) env.http_proxy = env.HTTP_PROXY = `http://${http[1]}:${http[2]}`
    // SOCKS fallback
    if (!https && !http) {
      const socks = p.match(/SOCKSEnable\s*:\s*1[\s\S]*?SOCKSProxy\s*:\s*(\S+)[\s\S]*?SOCKSPort\s*:\s*(\d+)/)
      if (socks) env.ALL_PROXY = `socks5://${socks[1]}:${socks[2]}`
    }
  } catch {}
  proxyEnv = env
  return env
}

export async function repoList(): Promise<string[]> {
  try {
    const d = await Bun.file(CONF).json()
    if (Array.isArray(d) && d.length) return d
  } catch {}
  // 默认:~/skills 本身若是 git 仓库则收录;否则收录其下的每个 git 子仓库
  const def: string[] = []
  const base = join(homedir(), "skills")
  if (existsSync(join(base, ".git"))) def.push(base)
  else if (existsSync(base)) {
    const { readdirSync } = await import("node:fs")
    for (const e of readdirSync(base)) {
      const p = join(base, e)
      if (existsSync(join(p, ".git"))) def.push(p)
    }
  }
  await Bun.write(CONF, JSON.stringify(def, null, 2))
  return def
}

let statusCache: { at: number; data: any[] } = { at: 0, data: [] }
let lastFetch = 0

export async function repoStatus(force = false) {
  if (!force && Date.now() - statusCache.at < 60000) return statusCache.data
  const repos = await repoList()
  const doFetch = force || Date.now() - lastFetch > 10 * 60 * 1000 // 网络 fetch 最多 10 分钟一次
  if (doFetch) lastFetch = Date.now()
  const out: any[] = []
  for (const r of repos) {
    if (!existsSync(join(r, ".git"))) {
      out.push({ path: r, name: r.split("/").pop(), error: "不是 git 仓库" })
      continue
    }
    try {
      if (doFetch) await $`git -C ${r} fetch --quiet`.env(await gitEnv()).quiet().nothrow()
      const branch = (await $`git -C ${r} rev-parse --abbrev-ref HEAD`.quiet().text()).trim()
      const counts = (await $`git -C ${r} rev-list --left-right --count HEAD...@{u}`.quiet().nothrow().text()).trim()
      const [ahead, behind] = counts.split(/\s+/).map((n) => parseInt(n) || 0)
      const dirty = (await $`git -C ${r} status --porcelain`.quiet().text()).trim().length > 0
      const last = (await $`git -C ${r} log -1 --format=%cr`.quiet().text()).trim()
      out.push({ path: r, name: r.split("/").pop(), branch, ahead, behind, dirty, last })
    } catch (e) {
      out.push({ path: r, name: r.split("/").pop(), error: String(e).slice(0, 100) })
    }
  }
  statusCache = { at: Date.now(), data: out }
  return out
}

export async function repoUpdate(path: string): Promise<{ ok: boolean; output: string; pulled?: number }> {
  const repos = await repoList()
  if (!repos.includes(path)) return { ok: false, output: "仓库不在配置列表中" }
  const name = path.split("/").pop()
  const env = await gitEnv()
  const notify = (msg: string) =>
    Bun.spawnSync(["osascript", "-e", `display notification "${msg.replace(/"/g, '\\"')}" with title "AI Cockpit · 仓库更新"`])
  try {
    let output = ""
    const before = (await $`git -C ${path} rev-parse HEAD`.quiet().text()).trim()
    // 显式 fetch(带代理),这样能明确报告网络问题
    const fr = await $`git -C ${path} fetch --all`.env(env).quiet().nothrow()
    if (fr.exitCode !== 0) {
      const err = fr.stderr.toString().slice(0, 200)
      notify(`${name}: 拉取失败(网络/代理问题)`)
      return { ok: false, output: "git fetch 失败: " + err }
    }
    // fork 同步:若存在 upstream 远端,先合并 upstream
    const remotes = (await $`git -C ${path} remote`.quiet().text()).trim().split("\n")
    if (remotes.includes("upstream")) {
      const branch = (await $`git -C ${path} rev-parse --abbrev-ref HEAD`.quiet().text()).trim()
      output += (await $`git -C ${path} merge upstream/${branch} --no-edit`.env(env).quiet().nothrow()).stdout.toString()
    }
    const r = await $`git -C ${path} pull --rebase --autostash`.env(env).quiet().nothrow()
    output += r.stdout.toString() + r.stderr.toString()
    const ok = r.exitCode === 0
    const after = (await $`git -C ${path} rev-parse HEAD`.quiet().text()).trim()
    let pulled = 0
    if (before !== after) {
      const cnt = (await $`git -C ${path} rev-list --count ${before}..${after}`.quiet().nothrow().text()).trim()
      pulled = parseInt(cnt) || 0
    }
    statusCache.at = 0 // 让菜单栏下次立即取到最新状态
    if (!ok) notify(`${name}: 更新失败(见日志)`)
    else if (pulled > 0) notify(`${name}: 已拉取 ${pulled} 个新提交 ✓`)
    else {
      const dirty = (await $`git -C ${path} status --porcelain`.quiet().nothrow().text()).trim()
      notify(dirty ? `${name}: 远端没有新提交;✎指的是你本地未提交的修改,更新不会动它` : `${name}: 已是最新,远端没有新提交`)
    }
    return { ok, output: output.slice(0, 2000), pulled }
  } catch (e) {
    notify(`${name}: 更新出错`)
    return { ok: false, output: String(e).slice(0, 500) }
  }
}
