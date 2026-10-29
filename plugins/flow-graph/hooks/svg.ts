import type { AgentNode, ChildKind, Loop, LoopStage, Run, Status } from '../types'
import { runStatus } from './flow'

export const VIOLET = '#B138C1'
export const STATUS_COLOR: Record<Status, string> = { running: '#378ADD', ok: '#1D9E75', error: '#E5484D' }
export const STATUS_LABEL: Record<Status, string> = { running: 'running', ok: 'ok', error: 'error' }
const KIND_COLOR: Record<ChildKind, string> = { skill: VIOLET, mcp: '#BA7517' }
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
// The engine refuses an Svg taller than 4096px.
const MAX_HEIGHT = 4096
const HEADER = 40
const ROW = 40
const LEGEND = 28
const CSS = `<style>.t{fill:#1f1f1f}.s{fill:#6b6b68}.bg{fill:#f4f3f0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.bg{fill:#262625}}</style>`

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

function curve(x1: number, y1: number, x2: number, y2: number, color: string): string {
  const mid = (x1 + x2) / 2
  return `<path d="M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="1.5" stroke-opacity="0.7"/>`
}

function dot(x: number, y: number, color: string, isRunning: boolean): string {
  const blink = isRunning ? '<animate attributeName="opacity" values="1;0.25;1" dur="1.2s" repeatCount="indefinite"/>' : ''
  return `<circle cx="${x}" cy="${y}" r="4" fill="${color}">${blink}</circle>`
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
  const agentW = Math.round(W * 0.36)
  const childX = Math.round(W * 0.72)
  const childW = W - childX - 8
  const rootY = HEADER + (Math.max(1, used) * ROW) / 2
  const done = run.agents.filter(a => a.status !== 'running').length

  const parts: string[] = [
    `<rect x="0" y="0" width="${W}" height="${HEADER - 8}" rx="6" class="bg"/>`,
    `<rect x="0" y="0" width="4" height="${HEADER - 8}" rx="2" fill="${VIOLET}"/>`,
    label(12, 21, fit(run.name, W - 190, 14), 14, 't', ' font-weight="600"'),
    label(W - 10, 21, `${done}/${run.agents.length} agents · ${STATUS_LABEL[status]}`, 12, 's', ' text-anchor="end"'),
    `<rect x="8" y="${rootY - 16}" width="${rootW - 8}" height="32" rx="8" fill="${VIOLET}" fill-opacity="0.15" stroke="${VIOLET}" stroke-width="1.5"/>`,
    label(16, rootY + 4, fit(run.name, rootW - 24, 12), 12, 't', ' font-weight="600"'),
  ]
  if (shown.length === 0) parts.push(label(agentX, rootY + 4, 'waiting for agents…', 12, 's'))

  let y = HEADER
  for (const agent of shown) {
    const rows = Math.max(1, agent.children.length)
    const midY = y + (rows * ROW) / 2
    const color = STATUS_COLOR[agent.status]
    const counts = countsLine(agent)
    parts.push(
      curve(rootW, rootY, agentX, midY, color),
      `<rect x="${agentX}" y="${midY - 16}" width="${agentW}" height="32" rx="8" fill="${color}" fill-opacity="0.15" stroke="${color}" stroke-width="1.5"/>`,
      label(agentX + 10, counts ? midY - 2 : midY + 4, fit(`${agent.index}. ${agent.name}`, agentW - 30, 12), 12, 't', ' font-weight="600"'),
      dot(agentX + agentW - 10, midY, color, agent.status === 'running'),
    )
    if (counts) parts.push(label(agentX + 10, midY + 11, fit(counts, agentW - 20, 10), 10, 's'))
    agent.children.forEach((child, i) => {
      const cy = y + i * ROW + ROW / 2
      const kind = KIND_COLOR[child.kind]
      const text = `${child.kind === 'skill' ? 'skill' : 'MCP'} · ${child.name}${child.calls > 1 ? ` ×${child.calls}` : ''}`
      parts.push(
        curve(agentX + agentW, midY, childX, cy, kind),
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
export const LOOP_HEIGHT = 280

export function clockText(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function nextText(loop: Loop): string {
  // The scheduler runs a cron job up to half its period late.
  if (loop.nextAt === null) return 'next: —'
  return `next ${loop.cron ? '~' : ''}${clockText(loop.nextAt)}`
}

export function loopSvg(W: number, loop: Loop): string {
  const cx = W / 2
  const cy = 135
  const r = 85
  const points = STAGES.map((stage, i) => {
    const angle = -Math.PI / 2 + (i * Math.PI) / 2
    return { stage, angle, x: (cx + r * Math.cos(angle)).toFixed(1), y: (cy + r * Math.sin(angle)).toFixed(1) }
  })
  const at = (angle: number) => `${(cx + r * Math.cos(angle)).toFixed(1)} ${(cy + r * Math.sin(angle)).toFixed(1)}`
  const parts: string[] = [
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${VIOLET}"/></marker></defs>`,
  ]
  for (const p of points) {
    // A gap at each end keeps the arrowhead off the next stage's dot.
    const isActive = p.stage === loop.stage
    parts.push(
      `<path d="M${at(p.angle + 0.32)} A${r} ${r} 0 0 1 ${at(p.angle + Math.PI / 2 - 0.32)}" fill="none" stroke="${VIOLET}" stroke-width="${isActive ? 3 : 1.5}" stroke-opacity="${isActive ? 1 : 0.45}" marker-end="url(#arrow)"/>`,
    )
  }
  for (const p of points) {
    const isActive = p.stage === loop.stage
    const lx = (cx + (r + 34) * Math.cos(p.angle)).toFixed(1)
    const ly = (cy + (r + 34) * Math.sin(p.angle) + 4).toFixed(1)
    if (isActive) {
      parts.push(
        `<circle cx="${p.x}" cy="${p.y}" r="16" fill="${VIOLET}" fill-opacity="0.2"><animate attributeName="r" values="12;20;12" dur="1.4s" repeatCount="indefinite"/></circle>`,
      )
    }
    parts.push(
      `<circle cx="${p.x}" cy="${p.y}" r="${isActive ? 10 : 7}" fill="${isActive ? VIOLET : 'none'}" stroke="${VIOLET}" stroke-width="2"/>`,
      `<text class="${isActive ? 't' : 's'}" x="${lx}" y="${ly}" font-family="${FONT}" font-size="${isActive ? 13 : 12}" text-anchor="middle"${isActive ? ' font-weight="700"' : ''}>${STAGE_LABEL[p.stage]}</text>`,
    )
  }
  parts.push(
    label(cx, cy - 4, `round ${loop.round}`, 16, 't', ' text-anchor="middle" font-weight="700"'),
    label(cx, cy + 16, nextText(loop), 12, 's', ' text-anchor="middle"'),
    label(cx, LOOP_HEIGHT - 10, `current stage: ${STAGE_LABEL[loop.stage]}`, 12, 's', ' text-anchor="middle"'),
  )
  return svg(W, LOOP_HEIGHT, parts.join('\n'))
}
