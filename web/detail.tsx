import React, { useEffect, useMemo, useRef, useState } from "react"
import { AGENT_NAMES, COMP_COLORS, ansiToHtml, fmt$, fmtDate, fmtTok, mdLite } from "./bits"

// per-session stats card (总成本 / Tokens / API 调用 / 成本构成 / 模型成本 / 分支)
function SessionStats({ stat }: { stat: any }) {
  if (!stat) return null
  const totTok = stat.tokens.input + stat.tokens.output + stat.tokens.cacheWrite + stat.tokens.cacheRead
  const compTotal = stat.comp ? stat.comp.out.cost + stat.comp.inp.cost + stat.comp.cw.cost + stat.comp.cr.cost : 0
  const maxMTok = stat.perModel?.length ? Math.max(...stat.perModel.map((m: any) => m.tokens || 0), 1) : 1
  const totModelTok = stat.perModel?.reduce((a: number, m: any) => a + (m.tokens || 0), 0) || 0
  return (
    <div className="msg" style={{ background: "#fffdf8" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
        <div style={{ background: "#f7f4ee", borderRadius: 10, padding: "10px 14px" }}>
          <div style={{ fontSize: 11.5, color: "var(--ink3)" }}>总成本</div>
          <div style={{ fontSize: 21, fontWeight: 700 }}>{fmt$(stat.cost)}</div>
        </div>
        <div style={{ background: "#f7f4ee", borderRadius: 10, padding: "10px 14px" }}>
          <div style={{ fontSize: 11.5, color: "var(--ink3)" }}>Tokens</div>
          <div style={{ fontSize: 21, fontWeight: 700 }}>{fmtTok(totTok)}</div>
        </div>
        <div style={{ background: "#f7f4ee", borderRadius: 10, padding: "10px 14px" }}>
          <div style={{ fontSize: 11.5, color: "var(--ink3)" }}>API 调用</div>
          <div style={{ fontSize: 21, fontWeight: 700 }}>{stat.apiCalls}</div>
        </div>
      </div>
      {stat.comp && compTotal > 0 && (
        <>
          <div style={{ fontSize: 12, fontWeight: 700, margin: "6px 0 4px" }}>成本构成</div>
          <div className="stackbar">
            {(["out", "inp", "cw", "cr"] as const).map((k) => (
              <div key={k} style={{ width: `${Math.max(1, (stat.comp[k].cost / compTotal) * 100)}%`, background: (COMP_COLORS as any)[k] }} />
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
                <span className="tk">{fmtTok(stat.comp[k].tok)} tok</span>
                <span className="ct">{fmt$(stat.comp[k].cost)}</span>
                <span className="pc">{Math.round((stat.comp[k].cost / compTotal) * 100)}%</span>
              </div>
            ))}
          </div>
        </>
      )}
      {stat.perModel?.length > 0 && (
        <>
          <div style={{ fontSize: 12, fontWeight: 700, margin: "10px 0 2px" }}>按模型分布(tokens 为准)</div>
          {[...stat.perModel]
            .sort((a: any, b: any) => (b.tokens || 0) - (a.tokens || 0))
            .map((m: any) => (
              <div key={m.model} className="rowbar">
                <div className="lbl">{m.model}</div>
                <div className="track">
                  <div className="fill" style={{ width: `${Math.max(1, ((m.tokens || 0) / maxMTok) * 100)}%`, background: "#d9702a" }} />
                </div>
                <div className="val">{fmtTok(m.tokens || 0)} tok</div>
                <div className="val" style={{ color: "var(--ink3)" }}>{fmt$(m.cost)}</div>
                <div className="pct">{totModelTok ? Math.round(((m.tokens || 0) / totModelTok) * 100) : 0}%</div>
              </div>
            ))}
        </>
      )}
      {stat.branches?.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 700, marginRight: 8 }}>涉及的 Git 分支</span>
          {stat.branches.map((b: string) => (
            <span key={b} className="badge branch">🌿 {b}</span>
          ))}
        </div>
      )}
    </div>
  )
}

type Sel = { provider: string; file: string; id: string; title: string; cwd: string; start?: string; end?: string; gitBranch?: string; models?: string[] }

// ---------- block renderers ----------
function ToolUse({ b }: { b: any }) {
  if (b.workflow)
    return (
      <div className="wfcard">
        <details className="coll">
          <summary>
            ⚙️ <b>Workflow 编排</b> — 多代理工作流脚本(点击展开)
          </summary>
          <pre>{b.input}</pre>
        </details>
      </div>
    )
  return (
    <div className="toolcard">
      <details className="coll">
        <summary>
          🔧 <span className="tn">{b.name}</span>
        </summary>
        <pre>{b.input}</pre>
      </details>
    </div>
  )
}

function ToolResult({ b, onZoom }: { b: any; onZoom: (src: string) => void }) {
  const hasAnsi = b.text.includes("\x1b[")
  const preview = b.text.length > 400 ? b.text.slice(0, 400) + ` …(共 ${b.text.length} 字符)` : b.text
  return (
    <div className={`coll ${b.isError ? "err" : ""}`}>
      <details>
        <summary>
          {b.isError ? "❌" : "↩︎"} 结果{b.name ? <span className="tn"> {b.name}</span> : null}
          <span style={{ opacity: 0.6 }}> · {b.text.length > 400 ? `${(b.text.length / 1000).toFixed(1)}k 字符` : "短输出"}</span>
        </summary>
        {hasAnsi ? <pre className="anstxt" dangerouslySetInnerHTML={{ __html: ansiToHtml(b.text) }} /> : <pre>{b.text}</pre>}
      </details>
      {!b.text ? null : b.text.length <= 400 ? null : <pre style={{ opacity: 0.85 }}>{hasAnsi ? preview.replace(/\x1b\[[0-9;]*m/g, "") : preview}</pre>}
      {b.imgs?.map((src: string, i: number) => (
        <img key={i} className="msgimg" src={src} onClick={() => onZoom(src)} />
      ))}
    </div>
  )
}

function TodoDiff({ b }: { b: any }) {
  const li = (t: any, i: number) => (
    <li key={i} className={t.status === "completed" ? "done" : t.status === "in_progress" ? "prog" : ""}>
      {t.status === "completed" ? "✓ " : t.status === "in_progress" ? "▸ " : "○ "}
      {t.content || t.activeForm}
    </li>
  )
  return (
    <div className="todo2">
      <div className="box">
        <h4>之前</h4>
        <ul style={{ margin: 0, paddingLeft: 16, listStyle: "none" }}>{(b.oldTodos || []).map(li)}</ul>
      </div>
      <div className="box">
        <h4>之后</h4>
        <ul style={{ margin: 0, paddingLeft: 16, listStyle: "none" }}>{(b.newTodos || []).map(li)}</ul>
      </div>
    </div>
  )
}

function PatchView({ b }: { b: any }) {
  const lines = b.diff.split("\n").map((l: string, i: number) => {
    if (l.startsWith("+")) return <span key={i} className="add">{l}</span>
    if (l.startsWith("-")) return <span key={i} className="del">{l}</span>
    return <span key={i}>{l + "\n"}</span>
  })
  return (
    <details className="coll" open={b.diff.length < 1200}>
      <summary>
        📝 文件修改 <span className="tn">{b.file.split("/").pop()}</span> <span style={{ opacity: 0.55 }}>{b.file}</span>
      </summary>
      <div className="difftxt">{lines}</div>
    </details>
  )
}

function FusionPanel({ b }: { b: any }) {
  const keys = Object.keys(b.models || {})
  const [on, setOn] = useState(keys[0] || "")
  return (
    <div>
      <div style={{ fontSize: 12.5, color: "#8036a0", fontWeight: 600, marginBottom: 4 }}>⚖️ Fusion 多模型评审 · {keys.length} 个模型</div>
      <div className="fusiontabs">
        {keys.map((k) => (
          <button key={k} className={k === on ? "on" : ""} onClick={() => setOn(k)}>
            {k}
          </button>
        ))}
      </div>
      <div className="mtxt" style={{ maxHeight: 480, overflowY: "auto", background: "#faf6fd", borderRadius: 8, padding: 10 }}>
        {mdLite(String(b.models[on] || ""))}
      </div>
    </div>
  )
}

export function MsgView({ m, show, onZoom, hit }: { m: any; show: { thinking: boolean; tools: boolean; system: boolean }; onZoom: (s: string) => void; hit?: boolean }) {
  if (m.role === "system" && !show.system) return null
  const blocks = m.blocks.filter((b: any) => {
    if (b.t === "thinking") return show.thinking
    if (b.t === "tool_use" || b.t === "tool_result" || b.t === "websearch") return show.tools
    return true
  })
  if (!blocks.length) return null
  return (
    <div className={`msg ${m.role}${hit ? " searchhit" : ""}`} id={`msg-${m.idx}`}>
      <div className="mh">
        <span className={`rolechip ${m.role}`}>{m.role === "user" ? "USER" : m.role === "assistant" ? "ASSISTANT" : m.role.toUpperCase()}</span>
        {m.model && <span>{m.model}</span>}
        {m.ts && <span>{fmtDate(m.ts)}</span>}
        {m.isSidechain && <span className="badge gray">子链</span>}
      </div>
      {blocks.map((b: any, i: number) => {
        switch (b.t) {
          case "text":
            return (
              <div key={i} className="mtxt">
                {mdLite(b.text)}
              </div>
            )
          case "thinking":
            return (
              <div key={i} className="think">
                💭 {b.text.length > 600 ? (
                  <details>
                    <summary style={{ cursor: "pointer" }}>{b.text.slice(0, 200)}…(展开全部思考)</summary>
                    {b.text}
                  </details>
                ) : (
                  b.text
                )}
              </div>
            )
          case "tool_use":
            return <ToolUse key={i} b={b} />
          case "tool_result":
            return <ToolResult key={i} b={b} onZoom={onZoom} />
          case "image":
            return <img key={i} className="msgimg" src={b.src} onClick={() => onZoom(b.src)} />
          case "todo":
            return <TodoDiff key={i} b={b} />
          case "patch":
            return <PatchView key={i} b={b} />
          case "websearch":
            return (
              <details key={i} className="coll">
                <summary>🌐 {b.query || "web 结果"}</summary>
                <pre>{b.text}</pre>
              </details>
            )
          case "fusion_panel":
            return <FusionPanel key={i} b={b} />
          case "info":
            return (
              <div key={i} className="muted">
                {b.text}
              </div>
            )
          default:
            return null
        }
      })}
      {m.usage && (
        <div className="usage">
          <span>输入 {fmtTok(m.usage.input)}</span>
          <span>输出 {fmtTok(m.usage.output)}</span>
          {m.usage.cacheWrite > 0 && <span>缓存写 {fmtTok(m.usage.cacheWrite)}</span>}
          {m.usage.cacheRead > 0 && <span>缓存读 {fmtTok(m.usage.cacheRead)}</span>}
          <span style={{ fontWeight: 600 }}>{fmt$(m.usage.costUSD)}</span>
          {m.usage.durationMs && <span>{(m.usage.durationMs / 1000).toFixed(1)}s</span>}
        </div>
      )}
    </div>
  )
}

// ---------- in-session search worker ----------
function makeWorker(): Worker {
  const code = `
    let docs = [];
    onmessage = (e) => {
      const { type, payload } = e.data;
      if (type === "index") { docs = payload; return; }
      if (type === "search") {
        const q = payload.toLowerCase();
        const hits = [];
        if (q.length >= 1) {
          for (const d of docs) if (d.text.includes(q)) hits.push(d.idx);
        }
        postMessage({ q: payload, hits });
      }
    };`
  return new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })))
}

// ---------- detail panel ----------
export function DetailPanel({ sel, onClose, initialQuery, onHidden }: { sel: Sel; onClose: () => void; initialQuery?: string; onHidden?: () => void }) {
  const [data, setData] = useState<{ total: number; from: number; msgs: any[]; subagents: any[] } | null>(null)
  const [show, setShow] = useState({ thinking: true, tools: true, system: false })
  const [zoomSrc, setZoomSrc] = useState("")
  const [expOpen, setExpOpen] = useState(false)
  const [expOpts, setExpOpts] = useState({ user: true, assistant: true, tools: false, thinking: false, system: false })
  const [q, setQ] = useState(initialQuery || "")
  const [hits, setHits] = useState<number[]>([])
  const [hitPos, setHitPos] = useState(0)
  const [sub, setSub] = useState<Sel | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const msgsRef = useRef<HTMLDivElement>(null)

  const load = async (offset?: number) => {
    const u = new URL("/api/session", location.origin)
    u.searchParams.set("provider", sel.provider)
    u.searchParams.set("file", sel.file)
    if (offset !== undefined) u.searchParams.set("offset", String(offset))
    u.searchParams.set("limit", "300")
    const r = await fetch(u).then((r) => r.json())
    setData((prev) => {
      if (!prev || offset === undefined) return r
      // prepend older page
      return { ...r, msgs: [...r.msgs, ...prev.msgs], from: r.from }
    })
  }
  useEffect(() => {
    setData(null)
    load()
  }, [sel.file])

  // search index
  useEffect(() => {
    if (!data) return
    const w = (workerRef.current ||= makeWorker())
    w.postMessage({
      type: "index",
      payload: data.msgs.map((m) => ({
        idx: m.idx,
        text: m.blocks
          .map((b: any) => ("text" in b ? b.text : b.t === "tool_use" ? b.name + " " + b.input : ""))
          .join(" ")
          .toLowerCase(),
      })),
    })
    w.onmessage = (e) => {
      setHits(e.data.hits)
      setHitPos(0)
      if (e.data.hits.length) jumpTo(e.data.hits[0])
    }
    if (q) w.postMessage({ type: "search", payload: q })
    return () => {}
  }, [data])
  useEffect(() => {
    const w = workerRef.current
    if (w && data) w.postMessage({ type: "search", payload: q })
  }, [q])
  useEffect(() => () => workerRef.current?.terminate(), [])

  const jumpTo = (idx: number) => {
    const el = document.getElementById(`msg-${idx}`)
    if (el) el.scrollIntoView({ block: "center" })
  }
  const nav = (d: number) => {
    if (!hits.length) return
    const np = (hitPos + d + hits.length) % hits.length
    setHitPos(np)
    jumpTo(hits[np])
  }

  const doExport = async (format: "html" | "text") => {
    const r = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...sel, format, options: expOpts }),
    })
    const blob = await r.blob()
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = `session-${sel.id.slice(0, 8)}.${format === "html" ? "html" : "txt"}`
    a.click()
    setExpOpen(false)
  }

  const action = (body: any) => fetch("/api/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json())

  const copyResume = async () => {
    const r = await action({ type: "resume-cmd", provider: sel.provider, id: sel.id, cwd: sel.cwd })
    await navigator.clipboard.writeText(r.cmd)
    alert("已复制:\n" + r.cmd)
  }

  // keyboard: o toggles export, esc closes
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "TEXTAREA") return
      if (e.key === "o") setExpOpen((v) => !v)
      if (e.key === "Escape") (sub ? setSub(null) : onClose())
    }
    window.addEventListener("keydown", h)
    return () => window.removeEventListener("keydown", h)
  }, [sub])

  const toc = useMemo(() => (data ? data.msgs.filter((m) => m.role === "user" && m.blocks.some((b: any) => b.t === "text")) : []), [data])

  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className="panel">
        <div className="panel-hd">
          <div className="ttl">
            <span className={`badge ${sel.provider}`}>{AGENT_NAMES[sel.provider] || sel.provider}</span>
            {sel.title}
          </div>
          <div className="meta">
            <span>📁 {sel.cwd}</span>
            {sel.gitBranch && <span className="badge branch">🌿 {sel.gitBranch}</span>}
            {sel.models?.map((m) => (
              <span key={m} className="badge model">
                {m}
              </span>
            ))}
            <span>{fmtDate(sel.start)} → {fmtDate(sel.end)}</span>
            {data && <span>{data.total} 条消息</span>}
          </div>
          <div className="panel-tools" style={{ position: "relative" }}>
            <span className={`tgl ${show.system ? "on" : ""}`} onClick={() => setShow((s) => ({ ...s, system: !s.system }))}>⚙ System</span>
            <span className={`tgl ${show.thinking ? "on" : ""}`} onClick={() => setShow((s) => ({ ...s, thinking: !s.thinking }))}>💭 Thinking</span>
            <span className={`tgl ${show.tools ? "on" : ""}`} onClick={() => setShow((s) => ({ ...s, tools: !s.tools }))}>🔧 Tools</span>
            <button className="btn sm" onClick={copyResume}>⎘ 复制 Resume</button>
            <button className="btn sm" onClick={() => action({ type: "open-terminal", provider: sel.provider, id: sel.id, cwd: sel.cwd })}>⌨ 终端恢复</button>
            <button className="btn sm" onClick={() => setExpOpen((v) => !v)}>⇩ 导出 (o)</button>
            <button className="btn sm" onClick={() => action({ type: "reveal", file: sel.file })}>📂 显示文件</button>
            <button
              className="btn sm"
              title="从会话列表里拿掉,文件和统计都不动,可在「已隐藏的会话」里恢复"
              onClick={async () => {
                await action({ type: "hide", hidden: true, provider: sel.provider, id: sel.id })
                onHidden?.()
                onClose()
              }}
            >
              🙈 隐藏
            </button>
            <input
              placeholder="会话内搜索…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              style={{ marginLeft: "auto", border: "1px solid var(--line)", borderRadius: 7, padding: "4px 9px", fontSize: 12.5, width: 170 }}
            />
            {q && (
              <span className="muted">
                {hits.length ? `${hitPos + 1}/${hits.length}` : "0"}
                <button className="btn sm" onClick={() => nav(-1)}>↑</button>
                <button className="btn sm" onClick={() => nav(1)}>↓</button>
              </span>
            )}
            <button className="btn sm" onClick={onClose}>✕ 关闭</button>
            {expOpen && (
              <div className="pop" style={{ top: 40, right: 100 }}>
                <b style={{ fontSize: 12.5 }}>导出内容包含:</b>
                {(["user", "assistant", "tools", "thinking", "system"] as const).map((k) => (
                  <label key={k}>
                    <input type="checkbox" checked={(expOpts as any)[k]} onChange={(e) => setExpOpts((o) => ({ ...o, [k]: e.target.checked }))} />
                    {{ user: "用户消息", assistant: "助手消息", tools: "工具调用/结果", thinking: "思考内容", system: "系统消息" }[k]}
                  </label>
                ))}
                <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                  <button className="btn sm primary" onClick={() => doExport("html")}>HTML</button>
                  <button className="btn sm" onClick={() => doExport("text")}>纯文本</button>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="panel-body">
          <div className="toc">
            <div style={{ padding: "4px 12px", fontSize: 11, color: "var(--ink3)", fontWeight: 700 }}>目录 · {toc.length} 个提问</div>
            {toc.map((m) => (
              <div key={m.idx} className="ti u" onClick={() => jumpTo(m.idx)} title={m.blocks.find((b: any) => b.t === "text")?.text?.slice(0, 200)}>
                {m.blocks.find((b: any) => b.t === "text")?.text?.replace(/\s+/g, " ").slice(0, 40)}
              </div>
            ))}
            {data?.subagents?.length ? (
              <>
                <div style={{ padding: "10px 12px 4px", fontSize: 11, color: "var(--ink3)", fontWeight: 700 }}>子代理 · {data.subagents.length}</div>
                {data.subagents.map((s: any) => (
                  <div key={s.file} className="ti" onClick={() => setSub({ provider: "claude", file: s.file, id: s.id, title: `子代理 ${s.id.slice(0, 12)}`, cwd: sel.cwd })}>
                    🤖 {s.id.slice(0, 16)}
                  </div>
                ))}
              </>
            ) : null}
          </div>
          <div className="msgs" ref={msgsRef}>
            {!data && <div className="empty">加载中…</div>}
            {data && <SessionStats stat={(data as any).stat} />}
            {data && data.from > 0 && (
              <button className="btn loadmore" onClick={() => load(Math.max(0, data.from - 300))}>
                ⤒ 加载更早的 {data.from} 条
              </button>
            )}
            {data?.msgs.map((m) => (
              <MsgView key={m.idx} m={m} show={show} onZoom={setZoomSrc} hit={q ? hits[hitPos] === m.idx : false} />
            ))}
          </div>
        </div>
      </div>
      {zoomSrc && (
        <div className="zoom" onClick={() => setZoomSrc("")}>
          <img src={zoomSrc} />
        </div>
      )}
      {sub && <DetailPanel sel={sub} onClose={() => setSub(null)} />}
    </>
  )
}
