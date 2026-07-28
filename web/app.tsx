import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import {
  AGENT_COLORS,
  AGENT_NAMES,
  COMP_COLORS,
  ContribGrid,
  DailyChart,
  fmt$,
  fmtDate,
  fmtDur,
  fmtTok,
  HBar,
  HourHeat,
  MdBlock,
  Sparkline,
  useTooltip,
} from "./bits"
import { DetailPanel } from "./detail"

type RangeKey = "today" | "7d" | "30d" | "90d" | "1y" | "all"
const RANGES: [RangeKey, string][] = [
  ["today", "Today"],
  ["7d", "7d"],
  ["30d", "30d"],
  ["90d", "3m"],
  ["1y", "1y"],
  ["all", "All"],
]
const DATE_FILTERS: [string, string][] = [
  ["all", "全部"],
  ["today", "今天"],
  ["yesterday", "昨天"],
  ["thisweek", "本周"],
  ["lastweek", "上周"],
  ["thismonth", "本月"],
]

const post = (body: any) => fetch("/api/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json())

function Confetti({ fire }: { fire: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!fire) return
    const cv = ref.current!
    cv.width = innerWidth
    cv.height = innerHeight
    const ctx = cv.getContext("2d")!
    const colors = ["#d9702a", "#3c9d52", "#2e5fbf", "#c069de", "#eeb529"]
    const ps = Array.from({ length: 160 }, () => ({
      x: Math.random() * cv.width,
      y: -20 - Math.random() * cv.height * 0.5,
      vy: 2 + Math.random() * 4,
      vx: -1.5 + Math.random() * 3,
      r: 4 + Math.random() * 5,
      c: colors[Math.floor(Math.random() * colors.length)],
      a: Math.random() * Math.PI,
    }))
    let n = 0
    let raf = 0
    const tick = () => {
      ctx.clearRect(0, 0, cv.width, cv.height)
      for (const p of ps) {
        p.y += p.vy
        p.x += p.vx + Math.sin(p.a + n / 18) * 1.4
        ctx.fillStyle = p.c
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(p.a + n / 15)
        ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2)
        ctx.restore()
      }
      n++
      if (n < 260) raf = requestAnimationFrame(tick)
      else ctx.clearRect(0, 0, cv.width, cv.height)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [fire])
  return <canvas className="confetti" ref={ref} />
}

function Sec({ title, sub, children }: { title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <>
      <div className="sec">
        <div className="bar" />
        <h2>{title}</h2>
        {sub && <span className="sub">{sub}</span>}
        {children}
      </div>
    </>
  )
}

function SkillsSection() {
  const [skills, setSkills] = useState<any[]>([])
  const [q, setQ] = useState("")
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [gening, setGening] = useState(false)
  const load = () => fetch("/api/skills").then((r) => r.json()).then((r) => setSkills(r.skills || []))
  useEffect(() => {
    load()
  }, [])
  const missing = skills.filter((s) => !s.zh).length
  const shown = q
    ? skills.filter((s) =>
        (s.name + (s.zh || "") + s.desc + s.tags.map((t: string) => (t === "cc" ? "claude code" : "codex")).join(" "))
          .toLowerCase()
          .includes(q.toLowerCase())
      )
    : skills
  return (
    <>
      <Sec title="Skills 技能库" sub={`本机 ${skills.length} 个`}>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <input
            placeholder="筛选 skill…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ border: "1px solid var(--line)", borderRadius: 7, padding: "4px 10px", fontSize: 12.5, width: 160 }}
          />
          {missing > 0 && (
            <button
              className="btn sm"
              disabled={gening}
              onClick={async () => {
                setGening(true)
                await fetch("/api/skills?gen=1")
                setTimeout(() => {
                  load()
                  setGening(false)
                }, 25000)
              }}
            >
              {gening ? "生成中…" : `✨ 补齐中文简介(${missing})`}
            </button>
          )}
        </span>
      </Sec>
      <div className="card">
        {shown.map((s) => {
          const isOpen = open.has(s.name)
          return (
            <div key={s.name} style={{ borderBottom: "1px solid #f5f0e8" }}>
              <div
                className="hotrow"
                onClick={() =>
                  setOpen((o) => {
                    const n = new Set(o)
                    n.has(s.name) ? n.delete(s.name) : n.add(s.name)
                    return n
                  })
                }
              >
                <span style={{ color: "var(--ink3)", width: 10 }}>{isOpen ? "▾" : "▸"}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, fontWeight: 600, flex: "none" }}>{s.name}</span>
                {s.tags.map((t: string) => (
                  <span key={t} className={`badge ${t === "cc" ? "claude" : "codex"}`}>{t === "cc" ? "Claude Code" : "Codex"}</span>
                ))}
                <span className="t" style={{ color: "var(--ink2)" }}>{s.zh || "(待生成中文简介)"}</span>
              </div>
              {isOpen && (
                <div style={{ padding: "2px 12px 10px 30px", fontSize: 12.5, color: "var(--ink2)", lineHeight: 1.7 }}>{s.desc || "(无说明)"}</div>
              )}
            </div>
          )
        })}
        {!shown.length && <div className="empty">没有匹配的 skill</div>}
      </div>
    </>
  )
}

function App() {
  const [range, setRange] = useState<RangeKey>("7d")
  const [ov, setOv] = useState<any>(null)
  const [folders, setFolders] = useState<any[]>([])
  const [sys, setSys] = useState<any>(null)
  const [q, setQ] = useState("")
  const [dateF, setDateF] = useState("all")
  const [globalHits, setGlobalHits] = useState<any[]>([])
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set())
  const [sel, setSel] = useState<any>(null)
  const [selQuery, setSelQuery] = useState("")
  const [checked, setChecked] = useState<Map<string, any>>(new Map())
  const [hiddenFolders, setHiddenFolders] = useState<any[]>([])
  const [mergeFor, setMergeFor] = useState("") // 正在选「并入哪个项目」的文件夹 cwd
  const [projects, setProjects] = useState<any[]>([])
  const [openHidden, setOpenHidden] = useState<Set<string>>(new Set())
  const [hiddenOpen, setHiddenOpen] = useState(false) // 整段默认收起,隐藏的东西不占版面
  const [summary, setSummary] = useState<{ text: string; cached: boolean } | null>(null)
  const [sumLoading, setSumLoading] = useState(false)
  const [confetti, setConfetti] = useState(0)
  const tip = useTooltip()
  const searchRef = useRef<HTMLInputElement>(null)
  const browserRef = useRef<HTMLDivElement>(null)

  const loadOverview = useCallback(() => fetch(`/api/overview?range=${range}`).then((r) => r.json()).then(setOv), [range])
  const loadFolders = useCallback(() => {
    const u = new URL("/api/folders", location.origin)
    if (q) u.searchParams.set("q", q)
    if (dateF !== "all") u.searchParams.set("date", dateF)
    return fetch(u).then((r) => r.json()).then((r) => setFolders(r.folders))
  }, [q, dateF])
  const loadHidden = useCallback(
    () =>
      fetch("/api/hidden")
        .then((r) => r.json())
        .then((r) => setHiddenFolders(r.folders || [])),
    []
  )
  // 并入目标的候选列表不能跟着搜索走,单独拉一份完整的
  const openMerge = useCallback((cwd: string) => {
    setMergeFor(cwd)
    fetch("/api/projects").then((r) => r.json()).then((r) => setProjects(r.projects || []))
  }, [])
  const mergeFolder = useCallback(
    async (from: string, to: string) => {
      setMergeFor("")
      await post({ type: "merge-folder", from, to })
      loadFolders()
      loadHidden()
    },
    [loadFolders, loadHidden]
  )

  useEffect(() => {
    loadOverview()
  }, [range])
  useEffect(() => {
    const t = setTimeout(loadFolders, q ? 250 : 0)
    return () => clearTimeout(t)
  }, [q, dateF])
  useEffect(() => {
    loadHidden()
  }, [])
  useEffect(() => {
    const t = setInterval(() => fetch("/api/system").then((r) => r.json()).then(setSys), 3000)
    fetch("/api/system").then((r) => r.json()).then(setSys)
    return () => clearInterval(t)
  }, [])

  // global content search
  useEffect(() => {
    if (q.length < 2) {
      setGlobalHits([])
      return
    }
    const t = setTimeout(() => fetch(`/api/search?q=${encodeURIComponent(q)}`).then((r) => r.json()).then((r) => setGlobalHits(r.results)), 400)
    return () => clearTimeout(t)
  }, [q])

  // SSE live refresh
  useEffect(() => {
    const es = new EventSource("/events")
    es.onmessage = (e) => {
      if (e.data === "refresh") {
        loadOverview()
        loadFolders()
      }
      if (e.data === "confetti") setConfetti(Date.now())
    }
    return () => es.close()
  }, [loadOverview, loadFolders])

  // keyboard: / focus search, d cycle date filter
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || sel) return
      if (e.key === "/") {
        e.preventDefault()
        browserRef.current?.scrollIntoView({ block: "start" })
        searchRef.current?.focus()
      }
      if (e.key === "d") {
        setDateF((cur) => {
          const i = DATE_FILTERS.findIndex(([k]) => k === cur)
          return DATE_FILTERS[(i + 1) % DATE_FILTERS.length][0]
        })
      }
    }
    window.addEventListener("keydown", h)
    return () => window.removeEventListener("keydown", h)
  }, [sel])

  const openSession = (s: any, query = "") => {
    setSelQuery(query)
    setSel({ provider: s.provider, file: s.file, id: s.id, title: s.title, cwd: s.cwd, start: s.start, end: s.end, gitBranch: s.gitBranch, models: s.models })
  }
  const openByFile = (hit: any) => openSession({ ...hit, title: hit.title, models: [] }, q)

  const toggleCheck = (s: any) => {
    setChecked((m) => {
      const n = new Map(m)
      const k = s.provider + s.id
      if (n.has(k)) n.delete(k)
      else n.set(k, s)
      return n
    })
  }

  const genSummary = async (force = false) => {
    setSumLoading(true)
    try {
      const r = await fetch(`/api/summary?range=${range}${force ? "&force=1" : ""}`).then((r) => r.json())
      setSummary(r)
    } finally {
      setSumLoading(false)
    }
  }

  const comp = ov?.composition
  const compTotal = comp ? comp.out.cost + comp.inp.cost + comp.cw.cost + comp.cr.cost : 0
  const compTok = comp ? comp.out.tok + comp.inp.tok + comp.cw.tok + comp.cr.tok : 0
  const maxModelTok = ov?.perModel?.length ? Math.max(...ov.perModel.map((m: any) => m.tokens)) : 1
  const maxAgentTok = ov?.perAgent?.length ? Math.max(...ov.perAgent.map((a: any) => a.tokens)) : 1
  const maxSes = ov?.topSessions?.[0]?.cost || 1
  const maxFolder = ov?.folders?.[0]?.cost || 1
  const opusShare = useMemo(() => {
    if (!ov?.perModel?.length || !ov.listCost) return null
    const heavy = ov.perModel.filter((m: any) => /opus|fable/.test(m.model))
    const share = heavy.reduce((a: number, m: any) => a + m.cost, 0) / ov.listCost
    return share > 0.5 ? Math.round(share * 100) : null
  }, [ov])

  return (
    <>
      <div className="hdr">
        <h1>
          <span className="logo">🛩️</span> AI Cockpit <span style={{ color: "var(--ink3)", fontWeight: 400, fontSize: 15 }}>总览仪表盘</span>
        </h1>
        <div className="spacer" />
        <button className="btn" onClick={() => { loadOverview(); loadFolders() }}>⟳ 刷新</button>
        <div className="chips">
          {RANGES.map(([k, label]) => (
            <button key={k} className={k === range ? "on" : ""} onClick={() => setRange(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {!ov ? (
        <div className="empty">正在扫描本地会话数据…(首次扫描可能需要一会儿)</div>
      ) : (
        <>
          {/* ======== 概览 ======== */}
          <div className="cards c4">
            <div className="card">
              <div className="k">总 tokens</div>
              <div className="v">{fmtTok(ov.totalTokens)}</div>
              <div className="s">{ov.totalTokens.toLocaleString()}</div>
            </div>
            <div className="card">
              <div className="k">List 成本</div>
              <div className="v">{fmt$(ov.listCost)}</div>
              <div className="s">按各模型官方定价折算</div>
            </div>
            <div className="card">
              <div className="k">缓存效率</div>
              <div className="v green">{Math.round(ov.cacheHit * 100)}%</div>
              <div className="s">
                <span className="hl">缓存省下 ≈{fmt$(ov.cacheSaved)}</span> · 无缓存约需 {fmt$(ov.noCacheCost)}
              </div>
            </div>
            <div className="card">
              <div className="k">范围</div>
              <div className="v">{RANGES.find(([k]) => k === range)?.[1]}</div>
              <div className="s">产出等效 ≈{Math.round(ov.equiv.minutes / 60 / 8)} 工作日 · {ov.equiv.blocks} 个工作段</div>
            </div>
          </div>

          {/* ======== 成本洞察 ======== */}
          <Sec title="成本洞察" sub="钱花在哪、怎么省" />
          <div className="cards c2">
            <div className="card">
              <div className="k">成本构成 · 钱花在哪</div>
              <div className="stackbar" style={{ marginTop: 10 }}>
                {(["out", "inp", "cw", "cr"] as const).map((k) => (
                  <div key={k} style={{ width: `${compTotal ? (comp[k].cost / compTotal) * 100 : 25}%`, background: (COMP_COLORS as any)[k] }} />
                ))}
              </div>
              <div className="legend">
                {(
                  [
                    ["out", "输出"],
                    ["inp", "输入"],
                    ["cw", "缓存写"],
                    ["cr", "缓存读"],
                  ] as const
                ).map(([k, nm]) => (
                  <div className="lg" key={k}>
                    <span className="dot" style={{ background: (COMP_COLORS as any)[k] }} />
                    <span className="nm">{nm}</span>
                    <span className="tk">{fmtTok(comp[k].tok)} tok</span>
                    <span className="ct">{fmt$(comp[k].cost)}</span>
                    <span className="pc">{compTotal ? Math.round((comp[k].cost / compTotal) * 100) : 0}%</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="card">
              <div className="k">节奏</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 10 }}>
                <div>
                  <div className="k">近 7 日均</div>
                  <div className="v" style={{ fontSize: 22 }}>{fmt$(ov.pace.avg7)}</div>
                  <div className="s">{fmtTok(ov.pace.avg7Tok || 0)} tok / 天</div>
                </div>
                <div>
                  <div className="k">本月至今</div>
                  <div className="v" style={{ fontSize: 22 }}>{fmt$(ov.pace.monthToDate)}</div>
                  <div className="s">{fmtTok(ov.pace.monthToDateTok || 0)} tok · day {ov.pace.dayOfMonth}/{ov.pace.daysInMonth}</div>
                </div>
                <div>
                  <div className="k">预估全月</div>
                  <div className="v red" style={{ fontSize: 22 }}>{fmt$(ov.pace.projMonth)}</div>
                  <div className="s">{fmtTok(ov.pace.projMonthTok || 0)} tok at current pace</div>
                </div>
              </div>
              <div style={{ marginTop: 14 }}>
                <div className="k">产出等效工时(METR 折算,娱乐向)</div>
                <div style={{ display: "flex", gap: 18, marginTop: 4 }}>
                  <span><b style={{ fontSize: 18 }}>≈{Math.round(ov.equiv.minutes / 60 / 8)} d</b> <span className="muted">{ov.equiv.blocks} 个工作段</span></span>
                  <span><b style={{ fontSize: 18, color: "var(--red)" }}>{ov.equiv.activeMs ? Math.round(ov.equiv.minutes / (ov.equiv.activeMs / 60000)) : 0}×</b> <span className="muted">对比 AI 活跃</span></span>
                  <span><b style={{ fontSize: 18 }}>{fmtDur(ov.equiv.activeMs)}</b> <span className="muted">AI 活跃时长</span></span>
                </div>
              </div>
            </div>
          </div>

          {/* ======== 模型 / agent / 高耗会话 ======== */}
          <Sec title="按模型分布" sub="以 tokens 为准 · 金额为参考" />
          <div className="card">
            {[...ov.perModel]
              .sort((a: any, b: any) => b.tokens - a.tokens)
              .slice(0, 8)
              .map((m: any) => (
                <HBar
                  key={m.model}
                  label={m.model}
                  value={m.tokens}
                  max={maxModelTok}
                  color="#d9702a"
                  fmt={(v) => `${fmtTok(v)} tok`}
                  extra={fmt$(m.cost)}
                  pct={ov.totalTokens ? m.tokens / ov.totalTokens : 0}
                />
              ))}
            {opusShare && <div className="hint">💡 {opusShare}% 成本花在 Opus/Fable — 简单任务可切 Sonnet/Haiku 省钱</div>}
          </div>

          <Sec title="高耗会话" sub="点击下钻" />
          <div className="card">
            {ov.topSessions.map((s: any) => (
              <div key={s.provider + s.id} className="hotrow" onClick={() => openSession(s)}>
                <span className="dot" style={{ background: AGENT_COLORS[s.provider] }} />
                <span className="t">
                  {s.folder} · <span style={{ color: "var(--ink2)" }}>{s.title.slice(0, 42)}</span>
                </span>
                <span className="m">{fmtTok(s.tokens)}</span>
                <span className="c">{fmt$(s.cost)}</span>
                <span className="arr">›</span>
              </div>
            ))}
            {!ov.topSessions.length && <div className="empty">该范围内没有会话</div>}
          </div>

          <Sec title="按 agent 分布" sub="以 tokens 为准 · 金额为参考" />
          <div className="card">
            {ov.perAgent.map((a: any) => (
              <HBar
                key={a.agent}
                label={AGENT_NAMES[a.agent] || a.agent}
                value={a.tokens}
                max={maxAgentTok}
                color={AGENT_COLORS[a.agent] || "#999"}
                fmt={(v) => `${fmtTok(v)} tok`}
                extra={fmt$(a.cost)}
                pct={ov.totalTokens ? a.tokens / ov.totalTokens : 0}
              />
            ))}
          </div>


          {/* ======== 每日明细 / 热力图 ======== */}
          <Sec title="每日明细" sub="按 agent 堆叠 · 悬停显示 $ 与 tokens" />
          <div className="card">
            <DailyChart series={ov.dailySeries} onTip={tip.show} offTip={tip.hide} />
            <div className="muted" style={{ display: "flex", gap: 14 }}>
              {Object.entries(AGENT_NAMES).map(([k, n]) => (
                <span key={k}>
                  <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 3, background: AGENT_COLORS[k], marginRight: 5 }} />
                  {n}
                </span>
              ))}
            </div>
          </div>

          <Sec title="时段分析" sub="悬停查看消耗与 tokens" />
          <div className="cards c2">
            <div className="card">
              <div className="k" style={{ marginBottom: 8 }}>高峰时段 · 星期 × 小时</div>
              <HourHeat hourly={ov.hourly} onTip={tip.show} offTip={tip.hide} />
            </div>
            <div className="card">
              <div className="k" style={{ marginBottom: 8 }}>活跃度 · 17 周</div>
              <ContribGrid grid={ov.grid} onTip={tip.show} offTip={tip.hide} />
            </div>
          </div>

          {/* ======== Top 仓库 ======== */}
          <Sec title="Top 仓库 / 文件夹" sub="tokens + 活跃时长 + 成本 · 点击展开该文件夹" />
          <div className="card">
            {ov.folders.map((f: any) => (
              <div
                key={f.cwd}
                className="hotrow"
                onClick={() => {
                  setOpenFolders((s) => new Set(s).add(f.cwd))
                  browserRef.current?.scrollIntoView({ block: "start", behavior: "smooth" })
                }}
              >
                <span className="t">
                  {f.name} <span className="muted">{f.shortPath}</span>
                </span>
                {f.providers.map((p: string) => (
                  <span key={p} className={`badge ${p}`}>{AGENT_NAMES[p]}</span>
                ))}
                <span className="m">{fmtTok(f.tokens || 0)} tok</span>
                <span className="m">{fmtDur(f.activeMs)}</span>
                <span className="c">{fmt$(f.cost)}</span>
                <span className="arr">›</span>
              </div>
            ))}
          </div>

          {/* ======== 实时系统 ======== */}
          <Sec title="实时系统" sub="最近 60s · 每 3s 刷新" />
          <div className="syscards">
            <div className="card">
              <div className="k">CPU <b style={{ float: "right" }}>{sys ? Math.round(sys.cpu) : "–"}%</b></div>
              <Sparkline data={(sys?.cpuHistory || []).map((p: any) => p.v)} color="#2e5fbf" max={100} />
            </div>
            <div className="card">
              <div className="k">内存 <b style={{ float: "right" }}>{sys ? Math.round((sys.memUsed / sys.memTotal) * 100) : "–"}%</b></div>
              <Sparkline data={(sys?.memHistory || []).map((p: any) => p.v * 100)} color="#d9702a" max={100} />
              <div className="s">{sys ? `${(sys.memUsed / 2 ** 30).toFixed(1)} / ${Math.round(sys.memTotal / 2 ** 30)} GB` : ""}</div>
            </div>
            <div className="card">
              <div className="k">Battery {sys?.battery?.charging ? "⚡" : ""}</div>
              <div className="v" style={{ fontSize: 24 }}>{sys?.battery ? sys.battery.pct + "%" : "–"}</div>
              <div className="track" style={{ height: 7, background: "#f1ece4", borderRadius: 4, marginTop: 6 }}>
                <div style={{ width: `${sys?.battery?.pct || 0}%`, height: "100%", borderRadius: 4, background: (sys?.battery?.pct || 0) > 20 ? "var(--green)" : "var(--red)" }} />
              </div>
            </div>
            <div className="card">
              <div className="k">Network</div>
              <div className="v" style={{ fontSize: 24, color: sys?.online ? "var(--green)" : "var(--red)" }}>
                ● {sys?.online ? "Online" : "Offline"}
              </div>
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <span className="muted">正在运行的 Agent 会话:</span>{" "}
            {sys?.agents?.length ? (
              sys.agents.map((a: any) => (
                <span key={a.pid} className="agentchip" onClick={() => post({ type: "focus-terminal" })} title={`PID ${a.pid} · CPU ${a.cpu}%`}>
                  <span className={a.cpu > 3 ? "live" : "idle"} />
                  {a.kind === "claude" ? "Claude Code" : "Codex"} · {(a.cwd || "?").split("/").pop()}
                </span>
              ))
            ) : (
              <span className="muted">无</span>
            )}
          </div>

          {/* ======== 阶段总结 ======== */}
          <Sec title="阶段总结" sub="这段时间我都用 AI 干了什么(由本机 claude CLI 生成)">
            <span style={{ marginLeft: "auto" }}>
              <button className="btn sm" disabled={sumLoading} onClick={() => genSummary(!!summary)}>
                {sumLoading ? "生成中…" : summary ? "⟳ 重新生成" : "✨ 生成总结"}
              </button>
            </span>
          </Sec>
          <div className="card">
            {summary ? (
              <div className="summary-box" style={{ whiteSpace: "normal" }}>
                <MdBlock text={summary.text} />
                {summary.cached && <div className="muted" style={{ marginTop: 8 }}>(缓存结果,点"重新生成"刷新)</div>}
              </div>
            ) : (
              <div className="muted">点右上角"生成总结",AI 会根据该时间范围内的会话记录,总结你各项目里用 AI 做了什么。</div>
            )}
          </div>
        </>
      )}

      {/* ======== 会话浏览器(按文件夹合并) ======== */}
      <div ref={browserRef}>
        <Sec title="会话浏览器" sub="按文件夹合并 Claude Code / Codex / Fusion · 快捷键: / 搜索 · d 切换日期" />
      </div>
      <div className="searchbar">
        <input ref={searchRef} placeholder="搜索标题 / 目录 / 分支 / 全文…  ( / )" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="chips">
          {DATE_FILTERS.map(([k, label]) => (
            <button key={k} className={k === dateF ? "on" : ""} onClick={() => setDateF(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {q.length >= 2 && globalHits.length > 0 && (
        <div className="card" style={{ marginBottom: 10 }}>
          <div className="k" style={{ marginBottom: 6 }}>全文命中 · {globalHits.length} 处(点击直达)</div>
          {globalHits.slice(0, 12).map((h, i) => (
            <div key={i} className="hotrow" onClick={() => openByFile(h)}>
              <span className={`badge ${h.provider}`}>{AGENT_NAMES[h.provider]}</span>
              <span className="t">
                {h.folder} · {h.title} <span className="muted">…{h.context.slice(0, 90)}…</span>
              </span>
              <span className="m">{fmtDate(h.end)}</span>
              <span className="arr">›</span>
            </div>
          ))}
        </div>
      )}
      {folders.map((g) => {
        const open = openFolders.has(g.cwd)
        return (
          <div className="folder" key={g.cwd}>
            <div
              className="folder-hd"
              onClick={() =>
                setOpenFolders((s) => {
                  const n = new Set(s)
                  n.has(g.cwd) ? n.delete(g.cwd) : n.add(g.cwd)
                  return n
                })
              }
            >
              <span style={{ color: "var(--ink3)", width: 12 }}>{open ? "▾" : "▸"}</span>
              <span>📁</span>
              <span className="nm">{g.name}</span>
              <span className="pth">{g.shortPath}</span>
              {g.providers.map((p: string) => (
                <span key={p} className={`badge ${p}`}>{AGENT_NAMES[p]}</span>
              ))}
              {g.hiddenCount > 0 && (
                <span className="badge gray" title={`另有 ${g.hiddenCount} 个已隐藏会话,金额仍计入下面的汇总`}>
                  🙈 {g.hiddenCount}
                </span>
              )}
              {(g.mergedFrom || []).map((m: any) => (
                <span
                  key={m.cwd}
                  className="badge merged"
                  title={
                    m.auto
                      ? `${m.cwd}\n(Claude Code 的 scratchpad,自动归到本项目)`
                      : `${m.cwd}\n(手动并入,点 ✕ 撤销)`
                  }
                  onClick={(e) => {
                    e.stopPropagation()
                    if (!m.auto) mergeFolder(m.cwd, "")
                  }}
                >
                  ⤴ {m.name}
                  {!m.auto && " ✕"}
                </span>
              ))}
              <span className="n">
                {g.sessions.length} 个会话 · {fmtTok(g.tokens)} · <b>{fmt$(g.costUSD)}</b>
              </span>
              {mergeFor === g.cwd ? (
                <select
                  className="mergesel"
                  autoFocus
                  defaultValue=""
                  onClick={(e) => e.stopPropagation()}
                  onBlur={() => setMergeFor("")}
                  onChange={(e) => {
                    const to = (e.target as HTMLSelectElement).value
                    if (to) mergeFolder(g.cwd, to)
                    else setMergeFor("")
                  }}
                >
                  <option value="">并入到…</option>
                  {projects
                    .filter((p: any) => p.cwd !== g.cwd)
                    .map((p: any) => (
                      <option key={p.cwd} value={p.cwd}>
                        {p.name} · {p.n} 个会话
                      </option>
                    ))}
                </select>
              ) : (
                <span
                  className="hidebtn"
                  title="把这个文件夹整体并进另一个项目(只改分组,不动文件,随时可撤销)"
                  onClick={(e) => {
                    e.stopPropagation()
                    openMerge(g.cwd)
                  }}
                >
                  ⤵
                </span>
              )}
              <span
                className="hidebtn"
                title="隐藏整个文件夹(成本/token 仍计入统计,可在下面「已隐藏」里恢复)"
                onClick={async (e) => {
                  e.stopPropagation()
                  await post({ type: "hide-folder", cwd: g.cwd, hidden: true })
                  loadFolders()
                  loadHidden()
                }}
              >
                🙈
              </span>
            </div>
            {open &&
              g.sessions.map((s: any) => (
                <div key={s.provider + s.id + s.file} className="sesrow" onClick={() => openSession(s)}>
                  <input type="checkbox" checked={checked.has(s.provider + s.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggleCheck(s)} />
                  <span className={`badge ${s.provider}`}>{s.provider === "claude" ? "CC" : s.provider === "codex" ? "CX" : "FU"}</span>
                  {s.subdir && <span className="badge gray" title={s.cwd}>📂 {s.subdir}</span>}
                  <span className="t">{s.title}</span>
                  {s.gitBranch && s.gitBranch !== "HEAD" && <span className="badge branch">🌿 {s.gitBranch}</span>}
                  {s.models?.[0] && <span className="badge model">{s.models[0]}</span>}
                  {s.hasSubagents && <span title="含子代理">🤖</span>}
                  {s.archived && <span className="badge gray" title="原件已被 Claude Code 清理,现在读的是自动备份里的副本">📦 备份</span>}
                  <span className="meta">{s.msgCount} msg</span>
                  <span className="meta">
                    {fmtTok((s.tokens?.input || 0) + (s.tokens?.output || 0) + (s.tokens?.cacheWrite || 0) + (s.tokens?.cacheRead || 0))} tok
                  </span>
                  <span className="meta">{fmt$(s.costUSD)}</span>
                  <span className="meta">{fmtDate(s.end)}</span>
                </div>
              ))}
          </div>
        )
      })}
      {!folders.length && <div className="empty">没有匹配的会话</div>}

      {/* selection bar */}
      {checked.size > 0 && (
        <div className="selbar">
          <span>已选 {checked.size} 个会话</span>
          <button
            className="btn sm"
            onClick={async () => {
              await post({ type: "open-terminal", sessions: [...checked.values()].map((s) => ({ provider: s.provider, id: s.id, cwd: s.cwd })) })
            }}
          >
            ⌨ 各开一个终端恢复
          </button>
          <button
            className="btn sm"
            onClick={async () => {
              const cmds = await Promise.all([...checked.values()].map((s) => post({ type: "resume-cmd", provider: s.provider, id: s.id, cwd: s.cwd }).then((r) => r.cmd)))
              await navigator.clipboard.writeText(cmds.join("\n"))
              alert("已复制 " + cmds.length + " 条 resume 命令")
            }}
          >
            ⎘ 批量复制 Resume
          </button>
          <button
            className="btn sm"
            onClick={async () => {
              const name = prompt("重命名为(留空恢复原名):", "")
              if (name === null) return
              for (const s of checked.values()) await post({ type: "rename", provider: s.provider, id: s.id, name })
              setChecked(new Map())
              loadFolders()
            }}
          >
            ✎ 重命名
          </button>
          <button
            className="btn sm"
            title="从列表里拿掉,成本/token 仍计入统计,随时可恢复"
            onClick={async () => {
              await post({ type: "hide", hidden: true, sessions: [...checked.values()].map((s) => ({ provider: s.provider, id: s.id })) })
              setChecked(new Map())
              loadFolders()
              loadHidden()
            }}
          >
            🙈 隐藏
          </button>
          <button className="btn sm" onClick={() => setChecked(new Map())}>✕</button>
        </div>
      )}

      {/* ======== 已隐藏的会话(结构同会话浏览器) ======== */}
      {hiddenFolders.length > 0 && (
        <>
          <Sec
            title={`已隐藏 · ${hiddenFolders.length} 个文件夹 / ${hiddenFolders.reduce((n: number, g: any) => n + g.sessions.length, 0)} 个会话`}
            sub="不出现在上面的列表和全文搜索里;JSONL 原封不动,成本/token 照常计入所有统计"
          >
            <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              {hiddenOpen && (
                <button
                  className="btn sm"
                  title="把所有隐藏的文件夹和会话都放回列表"
                  onClick={async () => {
                    for (const g of hiddenFolders) await post({ type: "hide-folder", cwd: g.cwd, hidden: false })
                    loadHidden()
                    loadFolders()
                  }}
                >
                  ↺ 全部取消隐藏
                </button>
              )}
              <button className="btn sm" onClick={() => setHiddenOpen((v) => !v)}>
                {hiddenOpen ? "▾ 收起" : `▸ 展开管理 (${hiddenFolders.length})`}
              </button>
            </span>
          </Sec>
          {hiddenOpen &&
            hiddenFolders.map((g: any) => {
            const open = openHidden.has(g.cwd)
            return (
              <div className="folder hidden-folder" key={g.cwd}>
                <div
                  className="folder-hd"
                  onClick={() =>
                    setOpenHidden((s) => {
                      const n = new Set(s)
                      n.has(g.cwd) ? n.delete(g.cwd) : n.add(g.cwd)
                      return n
                    })
                  }
                >
                  <span style={{ color: "var(--ink3)", width: 12 }}>{open ? "▾" : "▸"}</span>
                  <span>🙈</span>
                  <span className="nm">{g.name}</span>
                  <span className="pth">{g.shortPath}</span>
                  {g.providers.map((p: string) => (
                    <span key={p} className={`badge ${p}`}>{AGENT_NAMES[p]}</span>
                  ))}
                  {!g.whole && <span className="badge gray" title="这个文件夹里还有没被隐藏的会话">部分隐藏</span>}
                  <span className="n">
                    {g.sessions.length} 个会话 · {fmtTok(g.tokens)} · <b>{fmt$(g.costUSD)}</b>
                  </span>
                  <button
                    className="btn sm"
                    onClick={async (e) => {
                      e.stopPropagation()
                      await post({ type: "hide-folder", cwd: g.cwd, hidden: false })
                      loadHidden()
                      loadFolders()
                    }}
                  >
                    ↺ 取消隐藏{g.whole ? "整个文件夹" : "这些会话"}
                  </button>
                </div>
                {open &&
                  g.sessions.map((s: any) => (
                    <div key={s.provider + s.id + s.file} className="sesrow" onClick={() => openSession(s)}>
                      <span className={`badge ${s.provider}`}>{s.provider === "claude" ? "CC" : s.provider === "codex" ? "CX" : "FU"}</span>
                      {s.subdir && <span className="badge gray" title={s.cwd}>📂 {s.subdir}</span>}
                      <span className="t">{s.title}</span>
                      {s.models?.[0] && <span className="badge model">{s.models[0]}</span>}
                      {s.archived && <span className="badge gray" title="原件已被 Claude Code 清理,读的是自动备份副本">📦 备份</span>}
                      <span className="meta">{s.msgCount} msg</span>
                      <span className="meta">
                        {fmtTok((s.tokens?.input || 0) + (s.tokens?.output || 0) + (s.tokens?.cacheWrite || 0) + (s.tokens?.cacheRead || 0))} tok
                      </span>
                      <span className="meta">{fmt$(s.costUSD)}</span>
                      <span className="meta">{fmtDate(s.end)}</span>
                      <button
                        className="btn sm"
                        title="放回会话浏览器"
                        onClick={async (e) => {
                          e.stopPropagation()
                          await post({ type: "hide", hidden: false, provider: s.provider, id: s.id })
                          loadHidden()
                          loadFolders()
                        }}
                      >
                        ↺
                      </button>
                      <button
                        className="btn sm danger"
                        title="真删:文件进废纸篓,它的成本/token 会从所有统计里消失"
                        onClick={async (e) => {
                          e.stopPropagation()
                          if (!confirm(`彻底删除「${s.title}」?\n\nJSONL 移入废纸篓(含自动备份里的副本),resume 不再可用,\n它的 ${fmt$(s.costUSD)} 也会从今日/月度/项目统计里一起消失。`)) return
                          await post({ type: "delete", file: s.file, provider: s.provider, id: s.id })
                          loadHidden()
                          loadFolders()
                          loadOverview()
                        }}
                      >
                        🗑
                      </button>
                    </div>
                  ))}
                </div>
              )
            })}
        </>
      )}

      {/* ======== Skills 技能库 ======== */}
      <SkillsSection />

      <p className="muted" style={{ textAlign: "center", marginTop: 30 }}>
        AI Cockpit · 本地运行,数据不出机器 · 端口 4777 · 菜单栏组件见 menubar/README
      </p>

      {sel && (
        <DetailPanel
          sel={sel}
          onClose={() => setSel(null)}
          initialQuery={selQuery}
          onHidden={() => {
            loadFolders()
            loadHidden()
          }}
        />
      )}
      {tip.el}
      <Confetti fire={confetti} />
    </>
  )
}

createRoot(document.getElementById("root")!).render(<App />)
