import type { AgentNode, ChildKind, Loop, LoopStage, Run, Status } from '../types'
import { runStatus } from './flow'

export const VIOLET = '#B138C1'
export const STATUS_COLOR: Record<Status, string> = { running: '#378ADD', ok: '#1D9E75', error: '#E5484D' }
export const STATUS_LABEL: Record<Status, string> = { running: 'running', ok: 'ok', error: 'error' }
const KIND_COLOR: Record<ChildKind, string> = { skill: VIOLET, mcp: '#BA7517' }
const GREY = '#8E929A'
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
// The engine refuses an Svg taller than 4096px.
const MAX_HEIGHT = 4096
const HEADER = 58
const ROW = 44
const LEGEND = 28
// Pure CSS keeps moving between redraws; SMIL needs the pane's interactive Svg.
const CSS = `<style>.t{fill:#1f1f1f}.s{fill:#6b6b68}.bg{fill:#f4f3f0}.card{fill:#fff}.track{stroke:#e4e4e1}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.bg{fill:#262625}.card{fill:#1f1f1e}.track{stroke:#333331}}
.fl{stroke-dasharray:5 6;animation:dash .9s linear infinite}@keyframes dash{to{stroke-dashoffset:-11}}
.spin{transform-box:fill-box;transform-origin:center;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
.live{animation:live 1.2s ease-in-out infinite}@keyframes live{50%{opacity:.35}}
.halo{transform-box:fill-box;transform-origin:center;animation:grow 1.4s ease-in-out infinite}@keyframes grow{50%{transform:scale(1.35);opacity:.3}}
@media (prefers-reduced-motion: reduce){.fl,.spin,.live,.halo,.orbit{animation:none}}</style>`

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function xml(text: string): string {
  return text.replace(/[&<>"']/g, c => ESCAPES[c] ?? c)
}

function fit(text: string, width: number, size: number): string {
  const max = Math.max(3, Math.floor(width / (size * 0.58)))
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function svg(W: number, H: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${CSS}${body}</svg>`
}

function label(x: number, y: number, text: string, size: number, cls: string, extra = ''): string {
  return `<text class="${cls}" x="${x}" y="${y}" font-family="${FONT}" font-size="${size}"${extra}>${xml(text)}</text>`
}

function curve(x1: number, y1: number, x2: number, y2: number, color: string, isFlowing: boolean): string {
  const mid = (x1 + x2) / 2
  return `<path d="M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="${isFlowing ? 2 : 1.5}" stroke-opacity="${isFlowing ? 0.9 : 0.55}"${isFlowing ? ' class="fl"' : ''}/>`
}

// Running: a spinning arc; ok: a check; error: a cross.
function statusIcon(x: number, y: number, status: Status): string {
  const color = STATUS_COLOR[status]
  if (status === 'running') {
    return `<circle cx="${x}" cy="${y}" r="7" fill="none" stroke="${color}" stroke-opacity=".25" stroke-width="2.5"/><path class="spin" d="M${x} ${y - 7} A7 7 0 0 1 ${x + 7} ${y}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>`
  }
  if (status === 'ok') {
    return `<circle cx="${x}" cy="${y}" r="8" fill="${color}"/><path d="M${x - 3.5} ${y}l2.5 2.5 4.5-5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  }
  return `<circle cx="${x}" cy="${y}" r="8" fill="${color}"/><path d="M${x - 3} ${y - 3}l6 6M${x + 3} ${y - 3}l-6 6" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>`
}

function countsLine(agent: AgentNode): string {
  return Object.entries(agent.counts)
    .sort((a, b) => b[1] - a[1])
    .map(([tool, n]) => `${tool} ×${n}`)
    .join(' · ')
}

function legend(x: number, y: number, items: [string, string][]): string {
  let at = x
  return items
    .map(([text, color]) => {
      const out = `<circle cx="${at + 5}" cy="${y - 4}" r="5" fill="${color}"/>${label(at + 14, y, text, 11, 's')}`
      at += 24 + text.length * 7
      return out
    })
    .join('')
}

// One segment per agent in its status color; running ones pulse.
function progressBar(x: number, y: number, w: number, agents: AgentNode[]): string {
  if (agents.length === 0) return `<rect x="${x}" y="${y}" width="${w}" height="6" rx="3" fill="${STATUS_COLOR.running}" fill-opacity=".25" class="live"/>`
  const gap = 2
  const seg = (w - gap * (agents.length - 1)) / agents.length
  return agents
    .map((a, i) => `<rect x="${(x + i * (seg + gap)).toFixed(1)}" y="${y}" width="${Math.max(1, seg).toFixed(1)}" height="6" rx="3" fill="${STATUS_COLOR[a.status]}"${a.status === 'running' ? ' class="live"' : ''}/>`)
    .join('')
}

export function workflowSvg(W: number, run: Run): { source: string; height: number } {
  const status = runStatus(run)
  const room = Math.floor((MAX_HEIGHT - HEADER - LEGEND - ROW) / ROW)
  const shown: AgentNode[] = []
  let used = 0
  for (const agent of run.agents) {
    const rows = Math.max(1, agent.children.length)
    if (used + rows > room) break
    shown.push(agent)
    used += rows
  }
  const hidden = run.agents.length - shown.length
  const H = HEADER + (Math.max(1, used) + (hidden > 0 ? 1 : 0)) * ROW + LEGEND

  const rootW = Math.round(W * 0.22)
  const agentX = Math.round(W * 0.3)
  const agentW = Math.round(W * 0.38)
  const childX = Math.round(W * 0.74)
  const childW = W - childX - 8
  const rootY = HEADER + (Math.max(1, used) * ROW) / 2
  const done = run.agents.filter(a => a.status !== 'running').length
  const isRunning = status === 'running'

  const parts: string[] = [
    `<rect x="0" y="0" width="${W}" height="${HEADER - 12}" rx="8" class="bg"/>`,
    `<rect x="0" y="0" width="4" height="${HEADER - 12}" rx="2" fill="${VIOLET}"/>`,
    label(14, 20, fit(run.name, W - 190, 14), 14, 't', ' font-weight="700"'),
    label(W - 12, 20, `${done}/${run.agents.length} agents · ${STATUS_LABEL[status]}`, 12, 's', ' text-anchor="end"'),
    progressBar(14, 30, W - 26, run.agents),
    isRunning ? `<rect x="6" y="${rootY - 20}" width="${rootW - 4}" height="40" rx="12" fill="${VIOLET}" fill-opacity=".12" class="halo"/>` : '',
    `<rect x="8" y="${rootY - 17}" width="${rootW - 8}" height="34" rx="10" fill="${VIOLET}" fill-opacity="0.15" stroke="${VIOLET}" stroke-width="1.5"/>`,
    label(18, rootY + 4, fit(run.name, rootW - 28, 12), 12, 't', ' font-weight="600"'),
  ]
  if (shown.length === 0) parts.push(label(agentX, rootY + 4, 'waiting for agents…', 12, 's', ' class="live"'))

  let y = HEADER
  for (const agent of shown) {
    const rows = Math.max(1, agent.children.length)
    const midY = y + (rows * ROW) / 2
    const color = STATUS_COLOR[agent.status]
    const counts = countsLine(agent)
    const isLive = agent.status === 'running'
    parts.push(
      curve(rootW, rootY, agentX, midY, color, isLive),
      `<rect x="${agentX}" y="${midY - 17}" width="${agentW}" height="34" rx="10" class="card"/>`,
      `<rect x="${agentX}" y="${midY - 17}" width="${agentW}" height="34" rx="10" fill="${color}" fill-opacity="0.12" stroke="${color}" stroke-width="1.5"/>`,
      statusIcon(agentX + 16, midY, agent.status),
      label(agentX + 30, counts ? midY - 2 : midY + 4, fit(`${agent.index}. ${agent.name}`, agentW - 40, 12), 12, 't', ' font-weight="600"'),
    )
    if (counts) parts.push(label(agentX + 30, midY + 11, fit(counts, agentW - 38, 10), 10, 's'))
    agent.children.forEach((child, i) => {
      const cy = y + i * ROW + ROW / 2
      const kind = KIND_COLOR[child.kind]
      const text = `${child.kind === 'skill' ? 'skill' : 'MCP'} · ${child.name}${child.calls > 1 ? ` ×${child.calls}` : ''}`
      parts.push(
        curve(agentX + agentW, midY, childX, cy, kind, isLive),
        `<rect x="${childX}" y="${cy - 12}" width="${childW}" height="24" rx="12" fill="${kind}" fill-opacity="0.15" stroke="${kind}" stroke-width="1.2"/>`,
        label(childX + 10, cy + 4, fit(text, childW - 16, 11), 11, 't'),
      )
    })
    y += rows * ROW
  }
  if (hidden > 0) parts.push(label(agentX, y + ROW / 2 + 4, `and ${hidden} more agents`, 12, 's'))

  parts.push(
    legend(8, H - 10, [
      ['running', STATUS_COLOR.running],
      ['ok', STATUS_COLOR.ok],
      ['error', STATUS_COLOR.error],
      ['skill', KIND_COLOR.skill],
      ['MCP', KIND_COLOR.mcp],
    ]),
  )
  return { source: svg(W, H, parts.join('\n')), height: H }
}

export const STAGES: LoopStage[] = ['wake', 'work', 'schedule', 'wait']
export const STAGE_LABEL: Record<LoopStage, string> = { wake: 'wake', work: 'work', schedule: 'schedule', wait: 'wait' }
const STAGE_ICON: Record<LoopStage, string> = { wake: '☀', work: '⚙', schedule: '📅', wait: '⏳' }
export const LOOP_HEIGHT = 340
const MAX_DOTS = 24

export function clockText(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function nextText(loop: Loop): string {
  // The scheduler runs a cron job up to half its period late.
  if (loop.nextAt === null) return 'next: —'
  return `next ${loop.cron ? '~' : ''}${clockText(loop.nextAt)}`
}

function inText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `in ${s}s`
  const m = Math.round(s / 60)
  return m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)}h ${m % 60}m`
}

/** The loop's four stages on a ring: a comet circles while it works, an inner ring counts down to the next round. */
export function loopSvg(W: number, loop: Loop, now: number | null = null): string {
  const cx = W / 2
  const cy = 140
  const r = 88
  const isStopped = loop.isStopped === true
  const color = isStopped ? GREY : VIOLET
  const at = (angle: number, radius = r) => `${(cx + radius * Math.cos(angle)).toFixed(1)} ${(cy + radius * Math.sin(angle)).toFixed(1)}`
  const parts: string[] = [
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${color}"/></marker></defs>`,
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" class="track" stroke-width="10" stroke-opacity=".6"/>`,
  ]

  STAGES.forEach((stage, i) => {
    const angle = -Math.PI / 2 + (i * Math.PI) / 2
    const isActive = !isStopped && stage === loop.stage
    // A gap at each end keeps the arrowhead off the next stage's node.
    parts.push(
      `<path d="M${at(angle + 0.3)} A${r} ${r} 0 0 1 ${at(angle + Math.PI / 2 - 0.3)}" fill="none" stroke="${color}" stroke-width="${isActive ? 3 : 1.5}" stroke-opacity="${isActive ? 1 : 0.45}" marker-end="url(#arrow)"/>`,
    )
  })

  // The comet: fast while it wakes or works, slow while it waits.
  if (!isStopped) {
    const period = loop.stage === 'wake' || loop.stage === 'work' ? 2 : 10
    parts.push(
      `<g style="transform-origin:${cx}px ${cy}px;animation:spin ${period}s linear infinite" class="orbit"><circle cx="${cx}" cy="${cy - r}" r="5" fill="${VIOLET}"/><circle cx="${(cx - 9).toFixed(1)}" cy="${(cy - r + 1).toFixed(1)}" r="3.5" fill="${VIOLET}" fill-opacity=".45"/><circle cx="${(cx - 16).toFixed(1)}" cy="${(cy - r + 3).toFixed(1)}" r="2.5" fill="${VIOLET}" fill-opacity=".2"/></g>`,
    )
  }

  // Countdown to the next round: fills from now until nextAt.
  const left = now !== null && loop.nextAt !== null ? loop.nextAt - now : null
  if (!isStopped && left !== null && left > 0) {
    const ir = 58
    const c = (2 * Math.PI * ir).toFixed(1)
    parts.push(
      `<circle cx="${cx}" cy="${cy}" r="${ir}" fill="none" class="track" stroke-width="5"/>`,
      `<circle cx="${cx}" cy="${cy}" r="${ir}" fill="none" stroke="${VIOLET}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c}" transform="rotate(-90 ${cx} ${cy})"><animate attributeName="stroke-dashoffset" from="${c}" to="0" dur="${Math.max(1, Math.round(left / 1000))}s" fill="freeze"/></circle>`,
    )
  }

  STAGES.forEach((stage, i) => {
    const angle = -Math.PI / 2 + (i * Math.PI) / 2
    const isActive = !isStopped && stage === loop.stage
    const [x, y] = at(angle).split(' ')
    const lx = (cx + (r + 40) * Math.cos(angle)).toFixed(1)
    const ly = (cy + (r + 40) * Math.sin(angle) + 4).toFixed(1)
    if (isActive) parts.push(`<circle cx="${x}" cy="${y}" r="20" fill="${VIOLET}" fill-opacity=".22" class="halo"/>`)
    parts.push(
      `<circle cx="${x}" cy="${y}" r="${isActive ? 17 : 14}" fill="${isActive ? VIOLET : 'none'}" stroke="${color}" stroke-width="2" class="${isActive ? '' : 'card'}"/>`,
      `<text x="${x}" y="${(Number(y) + 5).toFixed(1)}" font-size="${isActive ? 15 : 13}" text-anchor="middle"${isActive ? '' : ' opacity=".6"'}>${STAGE_ICON[stage]}</text>`,
      `<text class="${isActive ? 't' : 's'}" x="${lx}" y="${ly}" font-family="${FONT}" font-size="${isActive ? 13 : 12}" text-anchor="middle"${isActive ? ' font-weight="700"' : ''}>${STAGE_LABEL[stage]}</text>`,
    )
  })

  if (isStopped) {
    parts.push(
      label(cx, cy - 4, 'loop ended', 16, 't', ' text-anchor="middle" font-weight="700"'),
      label(cx, cy + 16, `after ${loop.round} ${loop.round === 1 ? 'round' : 'rounds'}`, 12, 's', ' text-anchor="middle"'),
    )
  } else {
    parts.push(
      label(cx, cy - 8, `round ${loop.round}`, 18, 't', ' text-anchor="middle" font-weight="700"'),
      label(cx, cy + 10, nextText(loop), 12, 's', ' text-anchor="middle"'),
    )
    if (left !== null && left > 0) parts.push(label(cx, cy + 26, inText(left), 11, 's', ' text-anchor="middle"'))
  }

  // One dot per round so far; the current one pulses.
  const dots = Math.min(loop.round, MAX_DOTS)
  const startX = cx - ((dots - 1) * 12) / 2
  for (let i = 0; i < dots; i++) {
    const isCurrent = i === dots - 1 && !isStopped
    parts.push(`<circle cx="${(startX + i * 12).toFixed(1)}" cy="${LOOP_HEIGHT - 34}" r="4" fill="${color}"${isCurrent ? ' class="live"' : ' fill-opacity=".7"'}/>`)
  }
  if (loop.round > MAX_DOTS) parts.push(label(startX + dots * 12 + 4, LOOP_HEIGHT - 30, `+${loop.round - MAX_DOTS}`, 11, 's'))
  parts.push(label(cx, LOOP_HEIGHT - 12, isStopped ? 'loop ended' : `current stage: ${STAGE_LABEL[loop.stage]}`, 12, 's', ' text-anchor="middle"'))
  return svg(W, LOOP_HEIGHT, parts.join('\n'))
}
