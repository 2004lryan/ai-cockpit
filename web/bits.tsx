import React, { useState, useRef, useCallback } from "react"

// ---------- formatting ----------
export const fmt$ = (v: number) => "$" + (v >= 1000 ? v.toFixed(0) : v >= 100 ? v.toFixed(1) : v.toFixed(2))
export const fmtTok = (v: number) => {
  if (v >= 1e9) return "≈" + (v / 1e9).toFixed(1) + "B"
  if (v >= 1e6) return "≈" + (v / 1e6).toFixed(0) + "M"
  if (v >= 1e3) return "≈" + (v / 1e3).toFixed(0) + "k"
  return String(Math.round(v))
}
export const fmtDur = (ms: number) => {
  const h = Math.floor(ms / 3600000)
  const m = Math.round((ms % 3600000) / 60000)
  return h ? `${h}h ${m}m` : `${m}m`
}
export const fmtDate = (iso?: string) => (iso ? iso.slice(5, 16).replace("T", " ") : "")
export const AGENT_COLORS: Record<string, string> = { claude: "#d9702a", codex: "#3c9d52", fusion: "#c069de" }
export const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", fusion: "Fusion" }
export const COMP_COLORS = { out: "#d9702a", inp: "#2e5fbf", cw: "#c069de", cr: "#3c9d52" }

// ---------- tooltip ----------
export function useTooltip() {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const show = useCallback((e: React.MouseEvent, text: string) => {
    setTip({ x: Math.min(e.clientX + 12, window.innerWidth - 280), y: e.clientY + 14, text })
  }, [])
  const hide = useCallback(() => setTip(null), [])
  const el = tip ? (
    <div className="tooltip" style={{ left: tip.x, top: tip.y }}>
      {tip.text}
    </div>
  ) : null
  return { show, hide, el }
}

// ---------- charts (hand-rolled SVG) ----------
export function Sparkline({ data, color, max: maxIn }: { data: number[]; color: string; max?: number }) {
  const w = 200
  const h = 46
  if (!data.length) return <svg className="chart" viewBox={`0 0 ${w} ${h}`} />
  const max = maxIn ?? Math.max(...data, 1)
  const pts = data.map((v, i) => `${(i / Math.max(1, data.length - 1)) * w},${h - 4 - (v / max) * (h - 10)}`)
  const area = `0,${h} ` + pts.join(" ") + ` ${w},${h}`
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ height: 46 }}>
      <polygon points={area} fill={color} opacity={0.15} />
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
    </svg>
  )
}

export function DailyChart({
  series,
  onTip,
  offTip,
}: {
  series: { day: string; byAgent: Record<string, number>; total: number; tok?: number }[]
  onTip: (e: React.MouseEvent, t: string) => void
  offTip: () => void
}) {
  const w = 1080
  const h = 190
  const padL = 4
  const padB = 20
  const agents = ["claude", "codex", "fusion"]
  const n = series.length
  if (!n) return null
  const max = Math.max(...series.map((s) => s.total), 0.01)
  const bw = Math.min(46, ((w - padL) / n) * 0.72)
  const step = (w - padL) / n
  const nice = max <= 1 ? 1 : Math.ceil(max / 50) * 50 <= max * 1.5 ? Math.ceil(max / 50) * 50 : Math.ceil(max / 10) * 10
  const labelEvery = Math.ceil(n / 9)
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} style={{ maxHeight: 220 }}>
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}>
          <line x1={padL} x2={w} y1={h - padB - f * (h - padB - 12)} y2={h - padB - f * (h - padB - 12)} stroke="#eee7dc" strokeWidth={1} />
          <text x={w - 2} y={h - padB - f * (h - padB - 12) - 3} fontSize={10} fill="#a2968a" textAnchor="end">
            {Math.round(nice * f)}
          </text>
        </g>
      ))}
      {series.map((s, i) => {
        let y = h - padB
        const x = padL + i * step + (step - bw) / 2
        return (
          <g key={s.day} onMouseMove={(e) => onTip(e, `${s.day}\n` + agents.filter((a) => s.byAgent[a]).map((a) => `${AGENT_NAMES[a]}: ${fmt$(s.byAgent[a])}`).join("\n") + `\n合计: ${fmt$(s.total)}${s.tok ? ` · ${fmtTok(s.tok)} tok` : ""}`)} onMouseLeave={offTip}>
            <rect x={x} y={12} width={bw} height={h - padB - 12} fill="transparent" />
            {agents.map((a) => {
              const v = s.byAgent[a] || 0
              if (v <= 0) return null
              const bh = (v / nice) * (h - padB - 12)
              y -= bh
              return <rect key={a} x={x} y={y} width={bw} height={Math.max(0, bh - 1.5)} rx={bh > 6 ? 3 : 1} fill={AGENT_COLORS[a]} />
            })}
            {i % labelEvery === 0 && (
              <text x={x + bw / 2} y={h - 5} fontSize={10} fill="#a2968a" textAnchor="middle">
                {s.day.length > 10 ? s.day.slice(6) : s.day.slice(5).replace("-", "/")}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

const HEAT_RAMP = ["#f3ede4", "#fbe3cb", "#f6c592", "#eb9a52", "#d9702a", "#a94e13"]
export function heatColor(v: number, max: number): string {
  if (v <= 0 || max <= 0) return HEAT_RAMP[0]
  const f = Math.sqrt(v / max)
  return HEAT_RAMP[Math.min(5, 1 + Math.floor(f * 4.999))]
}

const DOWS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

export function HourHeat({ hourly, onTip, offTip }: { hourly: Record<string, { c: number; t: number }>; onTip: any; offTip: any }) {
  const max = Math.max(...Object.values(hourly).map((v) => v.c), 0.001)
  return (
    <div className="heatwrap">
      <table className="heat">
        <tbody>
          <tr>
            <td className="dow"></td>
            {Array.from({ length: 24 }, (_, hi) => (
              <td key={hi} className="hh">
                {hi % 6 === 0 ? hi : ""}
              </td>
            ))}
          </tr>
          {DOWS.map((dn, d) => (
            <tr key={d}>
              <td className="dow">{dn}</td>
              {Array.from({ length: 24 }, (_, hi) => {
                const v = hourly[`${d}-${hi}`] || { c: 0, t: 0 }
                return (
                  <td
                    key={hi}
                    style={{ background: heatColor(v.c, max) }}
                    onMouseMove={(e) => onTip(e, `${dn} ${hi}:00–${(hi + 1) % 24}:00 · ${fmt$(v.c)} · ${fmtTok(v.t)} tok`)}
                    onMouseLeave={offTip}
                  />
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function ContribGrid({ grid, onTip, offTip }: { grid: { day: string; cost: number; tok?: number }[]; onTip: any; offTip: any }) {
  const max = Math.max(...grid.map((g) => g.cost), 0.001)
  const weeks: { day: string; cost: number }[][] = []
  for (let i = 0; i < grid.length; i += 7) weeks.push(grid.slice(i, i + 7))
  return (
    <div className="heatwrap">
      <table className="heat">
        <tbody>
          {Array.from({ length: 7 }, (_, d) => (
            <tr key={d}>
              <td className="dow">{DOWS[d]}</td>
              {weeks.map((wk, wi) => {
                const cell = wk[d]
                if (!cell) return <td key={wi} style={{ background: "transparent" }} />
                return (
                  <td
                    key={wi}
                    style={{ background: heatColor(cell.cost, max) }}
                    onMouseMove={(e) => onTip(e, `${cell.day} · ${fmt$(cell.cost)} · ${fmtTok(cell.tok || 0)} tok`)}
                    onMouseLeave={offTip}
                  />
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="muted" style={{ marginTop: 6, display: "flex", gap: 4, alignItems: "center" }}>
        少
        {HEAT_RAMP.map((c) => (
          <span key={c} style={{ width: 12, height: 12, borderRadius: 3, background: c, display: "inline-block" }} />
        ))}
        多
      </div>
    </div>
  )
}

export function HBar({ label, value, max, color, fmt, pct, extra }: { label: string; value: number; max: number; color: string; fmt: (v: number) => string; pct?: number; extra?: string }) {
  return (
    <div className="rowbar">
      <div className="lbl" title={label}>
        {label}
      </div>
      <div className="track">
        <div className="fill" style={{ width: `${Math.max(1, (value / Math.max(max, 0.0001)) * 100)}%`, background: color }} />
      </div>
      <div className="val">{fmt(value)}</div>
      {extra !== undefined && <div className="val" style={{ color: "var(--ink3)" }}>{extra}</div>}
      {pct !== undefined && <div className="pct">{Math.round(pct * 100)}%</div>}
    </div>
  )
}

// ---------- text rendering ----------
const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export function ansiToHtml(raw: string): string {
  let s = escHtml(raw)
  // colors we style; all other escape sequences stripped
  s = s.replace(/\x1b\[([0-9;]*)m/g, (_m, codes: string) => {
    const cs = codes.split(";").filter(Boolean)
    if (!cs.length || cs.includes("0")) return "</span><span>"
    const cls = cs
      .filter((c) => ["1", "30", "31", "32", "33", "34", "35", "36", "37", "90", "91", "92", "93", "94", "95", "96", "97"].includes(c))
      .map((c) => "ansi-" + c)
      .join(" ")
    return `</span><span class="${cls}">`
  })
  s = s.replace(/\x1b\[[0-9;?]*[A-Za-ln-z]/g, "")
  return "<span>" + s + "</span>"
}

// fuller markdown block renderer (headings / lists / bold / code) for summaries
export function MdBlock({ text }: { text: string }) {
  const lines = text.split("\n")
  const out: React.ReactNode[] = []
  let list: string[] = []
  const flush = () => {
    if (list.length) {
      out.push(
        <ul key={out.length} style={{ margin: "4px 0 10px", paddingLeft: 20 }}>
          {list.map((li, i) => (
            <li key={i} style={{ margin: "3px 0" }} dangerouslySetInnerHTML={{ __html: inline(li) }} />
          ))}
        </ul>
      )
      list = []
    }
  }
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
  for (const l of lines) {
    const t = l.trim()
    if (/^[-*•] /.test(t)) {
      list.push(t.slice(2))
      continue
    }
    flush()
    if (t.startsWith("### ")) out.push(<h4 key={out.length} style={{ margin: "12px 0 4px", fontSize: 13.5 }} dangerouslySetInnerHTML={{ __html: inline(t.slice(4)) }} />)
    else if (t.startsWith("## ")) out.push(<h3 key={out.length} style={{ margin: "14px 0 5px", fontSize: 14.5, color: "var(--orange)" }} dangerouslySetInnerHTML={{ __html: inline(t.slice(3)) }} />)
    else if (t.startsWith("# ")) out.push(<h3 key={out.length} style={{ margin: "14px 0 5px", fontSize: 15 }} dangerouslySetInnerHTML={{ __html: inline(t.slice(2)) }} />)
    else if (t) out.push(<p key={out.length} style={{ margin: "5px 0" }} dangerouslySetInnerHTML={{ __html: inline(t) }} />)
  }
  flush()
  return <div>{out}</div>
}

// minimal markdown: fenced code, inline code, bold, headers
export function mdLite(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const parts = text.split(/```/)
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf("\n")
      const code = nl >= 0 ? part.slice(nl + 1) : part
      out.push(<pre key={i}>{code}</pre>)
    } else {
      const html = escHtml(part)
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
        .replace(/^#{1,4} (.+)$/gm, "<b>$1</b>")
      out.push(<span key={i} dangerouslySetInnerHTML={{ __html: html }} />)
    }
  })
  return out
}
