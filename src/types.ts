export type Provider = "claude" | "codex" | "fusion"

export interface TokenTotals {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

export interface SessionSummary {
  id: string
  provider: Provider
  file: string
  cwd: string
  title: string
  start: string // ISO
  end: string // ISO
  msgCount: number
  models: string[]
  gitBranch?: string
  entrypoint?: string
  tokens: TokenTotals
  costUSD: number
  hasSubagents: boolean
  // pre-aggregated for dashboards (kept small)
  // ci/co/ccw/ccr = 输入/输出/缓存写/缓存读的精确成本(按各自模型单价);nc = 无缓存情形的假想成本
  daily: Record<
    string,
    { cost: number; tokens: number; out: number; inp: number; cw: number; cr: number; ci?: number; co?: number; ccw?: number; ccr?: number; nc?: number }
  >
  hourly: Record<string, { c: number; t: number }> // "dow-hour" -> {cost, tokens}
  hourAbs?: Record<string, { c: number; t: number }> // "YYYY-MM-DD-HH" -> {cost, tokens}
  perModel: Record<string, { cost: number; tokens: number }>
  activeMs: number // sum of <10min gaps
  blocks: number // work blocks separated by >30min
  apiCalls?: number // assistant usage messages (API 调用次数)
  tools?: Record<string, number> // tool_use name -> count
  displayName?: string // app-level rename
  hidden?: boolean // 从会话列表里隐藏(统计照常计入)
  archived?: boolean // 原件已被 Claude Code 清理,现在读的是自动备份里的副本
  root?: string // smart-merged project root (grouping)
  groupCwd?: string // cwd 归一化后的分组用路径(scratchpad 回原项目 / 手动并入)
}

export interface FolderGroup {
  cwd: string
  name: string
  shortPath: string
  sessions: SessionSummary[]
  costUSD: number
  tokens: number
  activeMs: number
  lastActive: string
  providers: Provider[]
  // 被并进来的外部目录(手动并入的才列出,可一键撤销);自动归位的 scratchpad 不算
  mergedFrom?: { cwd: string; name: string; auto?: boolean }[]
}

export interface Msg {
  idx: number
  uuid?: string
  role: "user" | "assistant" | "system" | "info"
  ts?: string
  model?: string
  blocks: MsgBlock[]
  usage?: { input: number; output: number; cacheWrite: number; cacheRead: number; costUSD: number; durationMs?: number }
  isSidechain?: boolean
  agentId?: string // subagent link
}

export type MsgBlock =
  | { t: "text"; text: string }
  | { t: "thinking"; text: string }
  | { t: "tool_use"; name: string; input: string; id?: string; agentFile?: string; workflow?: boolean }
  | { t: "tool_result"; name?: string; text: string; isError?: boolean; imgs?: string[] }
  | { t: "image"; src: string }
  | { t: "todo"; oldTodos: any[]; newTodos: any[] }
  | { t: "patch"; file: string; diff: string }
  | { t: "websearch"; query?: string; text: string }
  | { t: "fusion_panel"; models: Record<string, string>; question: string }
  | { t: "info"; text: string }
