// 用第三方中转账单 CSV 核对/校准 fusion 成本估算。
//   bun scripts/calibrate.ts ~/Downloads/token-logs-xxx.csv [--apply]
// 输出:1) 从账单反推的每模型真实单价 vs 当前定价表
//      2) 按天:账单实付 vs Cockpit 对 fusion 会话的估算
// --apply 会把反推出的单价写入 ~/.ai-cockpit/relay-pricing.json(重启服务生效)
import { join } from "node:path"
import { homedir } from "node:os"
import { findRelayPricing } from "../src/pricing"
import { listFusionFiles, scanFusionFile } from "../src/fusion"

const CNY_PER_USD = Number(process.env.COCKPIT_CNY_RATE || 7.2)
const QUOTA = Number(process.env.COCKPIT_RELAY_QUOTA_UNIT || 500000)

const csvPath = process.argv[2]
const apply = process.argv.includes("--apply")
if (!csvPath) {
  console.log("用法: bun scripts/calibrate.ts <账单.csv> [--apply]")
  process.exit(1)
}

function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ""
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') inQ = false
      else cur += ch
    } else if (ch === '"') inQ = true
    else if (ch === ",") {
      out.push(cur)
      cur = ""
    } else cur += ch
  }
  out.push(cur)
  return out
}

const text = await Bun.file(csvPath).text()
const lines = text.split("\n").filter((l) => l.trim())
const header = parseCsvLine(lines[0])
const idx = (k: string) => header.indexOf(k)

interface Agg {
  cost: number
  w: number
  cr: number
  cacheRatio: number
  days: Record<string, number>
}
const agg = new Map<string, Agg>()
const dayTotal: Record<string, number> = {}

for (let i = 1; i < lines.length; i++) {
  const v = parseCsvLine(lines[i])
  const model = v[idx("model_name")]
  const quota = parseInt(v[idx("quota")] || "0")
  const pt = parseInt(v[idx("prompt_tokens")] || "0")
  const ct = parseInt(v[idx("completion_tokens")] || "0")
  const created = parseInt(v[idx("created_at")] || "0")
  let other: any = {}
  try {
    other = JSON.parse(v[idx("other")] || "{}")
  } catch {}
  const cr = other.completion_ratio ?? 2
  const cache = other.cache_tokens ?? 0
  const cacheRatio = other.cache_ratio ?? 1
  const usd = quota / QUOTA / CNY_PER_USD
  const d = new Date(created * 1000)
  const dk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  const a = agg.get(model) || { cost: 0, w: 0, cr, cacheRatio, days: {} }
  a.cost += usd
  a.w += pt - cache + cache * cacheRatio + ct * cr
  a.days[dk] = (a.days[dk] || 0) + usd
  agg.set(model, a)
  dayTotal[dk] = (dayTotal[dk] || 0) + usd
}

console.log("═══ 1) 账单反推单价 vs 当前定价 (USD / 1M tok) ═══")
console.log("model                    实测输入   实测输出 | 当前输入   当前输出   偏差")
const derived: Record<string, any> = {}
for (const [m, a] of [...agg.entries()].sort((x, y) => y[1].cost - x[1].cost)) {
  if (!a.w) continue
  const pin = (a.cost / a.w) * 1e6
  const cur = findRelayPricing(m)
  const dev = cur.input ? ((pin - cur.input) / cur.input) * 100 : 0
  derived[m.toLowerCase()] = {
    input: +pin.toFixed(3),
    output: +(pin * a.cr).toFixed(3),
    cacheWrite: 0,
    cacheRead: +(pin * a.cacheRatio).toFixed(4),
  }
  console.log(
    `${m.padEnd(24)} ${pin.toFixed(2).padStart(8)} ${(pin * a.cr).toFixed(2).padStart(10)} | ${String(cur.input).padStart(8)} ${String(cur.output).padStart(10)}   ${dev > 0 ? "+" : ""}${dev.toFixed(0)}%`
  )
}

console.log("\n═══ 2) 按天核对:账单实付 vs Cockpit fusion 估算 ═══")
const est: Record<string, number> = {}
for (const f of listFusionFiles()) {
  const s = await scanFusionFile(f)
  if (!s) continue
  for (const [dk, d] of Object.entries(s.daily)) est[dk] = (est[dk] || 0) + d.cost
}
console.log("日期          账单实付$    估算$      备注")
for (const dk of Object.keys(dayTotal).sort()) {
  const e = est[dk] || 0
  const t = dayTotal[dk]
  const note = e === 0 ? "(该日中转调用不是 fusion 或未留档)" : Math.abs(e - t) / t < 0.35 ? "✓ 基本吻合" : "⚠ 偏差较大"
  console.log(`${dk}   ${t.toFixed(3).padStart(9)} ${e.toFixed(3).padStart(9)}    ${note}`)
}

if (apply) {
  const dest = join(homedir(), ".ai-cockpit", "relay-pricing.json")
  let existing: Record<string, any> = {}
  try {
    existing = await Bun.file(dest).json()
  } catch {}
  await Bun.write(dest, JSON.stringify({ ...existing, ...derived }, null, 2))
  console.log(`\n✅ 已写入 ${dest}(${Object.keys(derived).length} 个模型)。重启服务并清扫描缓存后生效:`)
  console.log("   rm ~/.ai-cockpit/scan-cache-v3.json && launchctl kickstart -k gui/501/app.aicockpit.server")
} else {
  console.log("\n(加 --apply 可把实测单价写入 ~/.ai-cockpit/relay-pricing.json)")
}
