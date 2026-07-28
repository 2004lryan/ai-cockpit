import { $ } from "bun"

const cpuHistory: { t: number; v: number }[] = []
const memHistory: { t: number; v: number }[] = []
let lastSys: any = null
let ticking = false

async function sample() {
  try {
    // CPU: sum of %cpu over logical cores
    const ps = await $`ps -A -o %cpu`.quiet().text()
    let total = 0
    for (const l of ps.split("\n").slice(1)) {
      const v = parseFloat(l)
      if (!Number.isNaN(v)) total += v
    }
    const ncpu = navigatorCores()
    const cpu = Math.min(100, total / ncpu)
    // memory via vm_stat
    const vm = await $`vm_stat`.quiet().text()
    const page = 16384
    const get = (k: string) => {
      const m = vm.match(new RegExp(k + ":\\s+(\\d+)"))
      return m ? parseInt(m[1]) * page : 0
    }
    const free = get("Pages free") + get("Pages purgeable")
    const totalMem = totalMemBytes()
    const used = totalMem - free - get("File-backed pages")
    const now = Date.now()
    cpuHistory.push({ t: now, v: cpu })
    memHistory.push({ t: now, v: used / totalMem })
    while (cpuHistory.length > 30) cpuHistory.shift()
    while (memHistory.length > 30) memHistory.shift()
    lastSys = { cpu, memUsed: used, memTotal: totalMem }
  } catch {}
}

let _cores = 0
function navigatorCores(): number {
  if (!_cores) {
    try {
      _cores = parseInt(require("node:os").cpus().length) || 8
    } catch {
      _cores = 8
    }
  }
  return _cores
}

let _totalMem = 0
function totalMemBytes(): number {
  if (!_totalMem) {
    try {
      _totalMem = require("node:os").totalmem()
    } catch {
      _totalMem = 8 * 2 ** 30
    }
  }
  return _totalMem
}

export function startSampling() {
  if (ticking) return
  ticking = true
  sample()
  setInterval(sample, 2000)
}

export async function getSystem() {
  let battery: { pct: number; charging: boolean } | null = null
  try {
    const b = await $`pmset -g batt`.quiet().text()
    const m = b.match(/(\d+)%/)
    if (m) battery = { pct: parseInt(m[1]), charging: /AC Power|charging/.test(b) }
  } catch {}
  let online = false
  try {
    const r = await $`scutil -r 1.1.1.1`.quiet().text()
    online = r.includes("Reachable")
  } catch {}
  return {
    ...(lastSys || { cpu: 0, memUsed: 0, memTotal: totalMemBytes() }),
    cpuHistory,
    memHistory,
    battery,
    online,
    agents: await runningAgents(),
  }
}

// Detect local running Claude Code / Codex sessions with their cwd (cached 20s — lsof is slow).
let agentsCache: { at: number; data: any[] } = { at: 0, data: [] }
export async function runningAgents(): Promise<{ kind: string; pid: number; cwd: string; cpu: number; startedAt: string }[]> {
  if (Date.now() - agentsCache.at < 20000) return agentsCache.data as any
  const data = await runningAgentsUncached()
  agentsCache = { at: Date.now(), data }
  return data
}

async function runningAgentsUncached(): Promise<{ kind: string; pid: number; cwd: string; cpu: number; startedAt: string }[]> {
  const out: { kind: string; pid: number; cwd: string; cpu: number; startedAt: string }[] = []
  try {
    const ps = await $`ps -axo pid=,pcpu=,etime=,command=`.quiet().text()
    for (const line of ps.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+([\d.]+)\s+([\d:-]+)\s+(.*)$/)
      if (!m) continue
      const cmd = m[4]
      let kind = ""
      const isSelf = cmd.includes("shell-snapshots") || cmd.includes("/bin/zsh") || cmd.includes("mcp-server") || cmd.includes("history-viewer")
      if (!isSelf && /(^|\/)claude($| )/.test(cmd) && !cmd.includes("chrome") && !cmd.includes("Claude.app")) kind = "claude"
      else if (!isSelf && (/(^|\/|bin\/)codex($| )/.test(cmd) || cmd.includes("codex exec")) && !cmd.includes("CodexBar")) kind = "codex"
      if (!kind) continue
      const pid = parseInt(m[1])
      let cwd = ""
      try {
        const lsof = await $`lsof -a -p ${pid} -d cwd -Fn`.quiet().text()
        const n = lsof.split("\n").find((l) => l.startsWith("n"))
        if (n) {
          // lsof escapes non-ASCII as \xNN — rebuild bytes then decode UTF-8
          const raw = n.slice(1)
          const bytes: number[] = []
          for (let i = 0; i < raw.length; i++) {
            if (raw[i] === "\\" && raw[i + 1] === "x") {
              bytes.push(parseInt(raw.slice(i + 2, i + 4), 16))
              i += 3
            } else bytes.push(raw.charCodeAt(i))
          }
          cwd = new TextDecoder("utf-8").decode(new Uint8Array(bytes))
        }
      } catch {}
      out.push({ kind, pid, cwd, cpu: parseFloat(m[2]), startedAt: m[3] })
    }
  } catch {}
  return out
}
