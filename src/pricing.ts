// Model pricing (USD per 1M tokens). Longest-key-first substring match.
export interface ModelPricing {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-fable-5": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1.0 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-sonnet-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  "claude-3-5-sonnet": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-3-5-haiku": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  // OpenAI (Codex CLI): no cache-write charge; cacheRead = 10% of input
  "gpt-5.6-sol": { input: 5, output: 30, cacheWrite: 0, cacheRead: 0.5 },
  "gpt-5.6-terra": { input: 2.5, output: 15, cacheWrite: 0, cacheRead: 0.25 },
  "gpt-5.6-luna": { input: 1, output: 6, cacheWrite: 0, cacheRead: 0.1 },
  "gpt-5.6": { input: 5, output: 30, cacheWrite: 0, cacheRead: 0.5 },
  "gpt-5.5": { input: 5, output: 30, cacheWrite: 0, cacheRead: 0.5 },
  "gpt-5.4": { input: 2.5, output: 15, cacheWrite: 0, cacheRead: 0.25 },
  "gpt-5": { input: 2.5, output: 15, cacheWrite: 0, cacheRead: 0.25 },
  "o4-mini": { input: 1.1, output: 4.4, cacheWrite: 0, cacheRead: 0.11 },
  "codex-mini": { input: 1.5, output: 6, cacheWrite: 0, cacheRead: 0.15 },
  "gemini-2.5-pro": { input: 1.25, output: 10, cacheWrite: 0, cacheRead: 0 },
  "gemini-2.5-flash": { input: 0.15, output: 0.6, cacheWrite: 0, cacheRead: 0 },
  "gemini-3.5-flash": { input: 1.5, output: 9, cacheWrite: 0, cacheRead: 0.15 },
  // CCR / 直连第三方(官方牌价,LiteLLM 口径;fusion 走中转的另见 RELAY_PRICING)
  "deepseek-v4-pro": { input: 0.435, output: 0.87, cacheWrite: 0, cacheRead: 0.045 },
  "deepseek-v4-flash": { input: 0.1, output: 0.3, cacheWrite: 0, cacheRead: 0.01 },
  "deepseek": { input: 0.5, output: 1.5, cacheWrite: 0, cacheRead: 0.05 },
  "glm-5.2": { input: 0.6, output: 2.2, cacheWrite: 0, cacheRead: 0.06 },
}

// ---- Fusion 中转实付价(USD/1M)----
// 由第三方账单 CSV 校准得出(scripts/calibrate.ts),中转商有加价,和官方牌价不同。
// ~/.ai-cockpit/relay-pricing.json 里的条目会覆盖这里的默认值。
const RELAY_PRICING_DEFAULT: Record<string, ModelPricing> = {
  // 2026-07-23 用 gpt-agent.cc 账单校准
  "kimi-k3": { input: 7.42, output: 37.08, cacheWrite: 0, cacheRead: 0.742 },
  "qwen3.8-max": { input: 2.89, output: 14.46, cacheWrite: 0, cacheRead: 0.289 },
  "deepseek-v4-pro": { input: 3.33, output: 6.67, cacheWrite: 0, cacheRead: 0.333 },
  "glm-5.2": { input: 2.47, output: 12.37, cacheWrite: 0, cacheRead: 0.247 },
  "kimi-k2.7": { input: 1.65, output: 8.25, cacheWrite: 0, cacheRead: 0.165 },
  "qwen3.7-plus": { input: 1.11, output: 5.56, cacheWrite: 0, cacheRead: 0.111 },
  "mimo-v2.5-pro": { input: 0.96, output: 4.82, cacheWrite: 0, cacheRead: 0.096 },
  "grok-4.5": { input: 0.83, output: 2.5, cacheWrite: 0, cacheRead: 0.208 },
  "hy3": { input: 0.31, output: 1.53, cacheWrite: 0, cacheRead: 0.031 },
  "minimax-m3": { input: 0.29, output: 1.45, cacheWrite: 0, cacheRead: 0.029 },
  "claude-sonnet-4-6": { input: 0.26, output: 1.31, cacheWrite: 0, cacheRead: 0.026 },
  // ruoli.dev 侧尚未校准(导出其账单后跑 bun scripts/calibrate.ts 即可)
  "gpt-5.6-sol": { input: 5, output: 30, cacheWrite: 0, cacheRead: 0.5 },
  "gpt-5.6-terra": { input: 2.5, output: 15, cacheWrite: 0, cacheRead: 0.25 },
  "gemini-3.5-flash": { input: 0.3, output: 2.5, cacheWrite: 0, cacheRead: 0.03 },
}

let relayOverrides: Record<string, ModelPricing> = {}
try {
  const fs = require("node:fs")
  const p = `${process.env.HOME}/.ai-cockpit/relay-pricing.json`
  if (fs.existsSync(p)) relayOverrides = JSON.parse(fs.readFileSync(p, "utf-8"))
} catch {}

export function findRelayPricing(model: string): ModelPricing {
  const m = (model || "").toLowerCase()
  for (const table of [relayOverrides, RELAY_PRICING_DEFAULT]) {
    for (const [k, v] of Object.entries(table)) if (m === k.toLowerCase() || m.includes(k.toLowerCase())) return v
  }
  return findPricing(model)
}

export function relayCostUSD(model: string, inTok: number, outTok: number): number {
  const p = findRelayPricing(model)
  return (inTok / 1e6) * p.input + (outTok / 1e6) * p.output
}

// Rough token estimate for fusion panel text (mixed zh/en): ~3.2 chars/token.
export function estTokens(text: string): number {
  return Math.ceil((text || "").length / 3.2)
}

const DEFAULT_PRICING: ModelPricing = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 }
const SORTED = Object.entries(MODEL_PRICING).sort((a, b) => b[0].length - a[0].length)

export function findPricing(model: string): ModelPricing {
  const m = (model || "").toLowerCase()
  for (const [k, v] of SORTED) if (m.includes(k)) return v
  return DEFAULT_PRICING
}

// cw = 5 分钟缓存写(input×1.25),cw1h = 1 小时缓存写(input×2,Claude Code 默认 1h TTL)
export function costUSD(model: string, inTok: number, outTok: number, cw: number, cr: number, cw1h = 0): number {
  const p = findPricing(model)
  return (
    (inTok / 1e6) * p.input +
    (outTok / 1e6) * p.output +
    (cw / 1e6) * p.cacheWrite +
    (cw1h / 1e6) * p.input * 2 +
    (cr / 1e6) * p.cacheRead
  )
}

// METR-style rough task-length factor (minutes of human-equivalent work per
// work block, by model tier) — used for the playful "产出等效工时" estimate.
export function equivMinutesPerBlock(model: string): number {
  const m = (model || "").toLowerCase()
  if (m.includes("fable") || m.includes("opus")) return 240
  if (m.includes("sonnet") || m.includes("gpt-5")) return 150
  if (m.includes("haiku") || m.includes("mini")) return 60
  return 120
}
