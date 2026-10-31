import type { Edge, EdgeKind, Graph, Impact } from '../types'
import { otherEnd } from './classify'

export const KIND_HEX: Record<EdgeKind, string> = { db: '#E5484D', http: '#F5A524', lib: '#8E929A' }
const KIND_NAME: Record<EdgeKind, string> = { db: 'DB', http: 'HTTP', lib: 'lib' }
const VIOLET = '#B138C1'
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
// The engine refuses an Svg taller than 4096px.
const MAX_HEIGHT = 4096
const ROW = 50
const CSS = `<style>
.t{fill:#1f1f1f}.s{fill:#6b6b68}.bg{fill:#f4f3f0}.card{fill:#fff;stroke:#e4e4e1}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.bg{fill:#262625}.card{fill:#1f1f1e;stroke:#333331}}
.fl{stroke-dasharray:5 7;animation:dash 1.2s linear infinite}
.hot{stroke-width:3.5;animation:dash .5s linear infinite,pulse 1s ease-in-out infinite}
.halo{animation:grow 1.6s ease-in-out infinite;transform-box:fill-box;transform-origin:center}
@keyframes dash{to{stroke-dashoffset:-12}}@keyframes pulse{50%{stroke-opacity:.35}}@keyframes grow{50%{transform:scale(1.25);opacity:.35}}
@media (prefers-reduced-motion: reduce){.fl,.hot,.halo{animation:none}}
</style>`

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const xml = (text: string): string => text.replace(/[&<>"']/g, c => ESCAPES[c] ?? c)

const fit = (text: string, width: number, size: number): string => {
  const max = Math.max(3, Math.floor(width / (size * 0.58)))
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${CSS}${body}</svg>`

const label = (x: number, y: number, text: string, size: number, cls: string, extra = ''): string =>
  `<text class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${FONT}" font-size="${size}"${extra}>${xml(text)}</text>`

const legend = (y: number): string => {
  let x = 8
  return (
    [
      ['DB', KIND_HEX.db],
      ['HTTP', KIND_HEX.http],
      ['lib', KIND_HEX.lib],
    ] as const
  )
    .map(([text, color]) => {
      const out = `<line x1="${x}" y1="${y - 4}" x2="${x + 16}" y2="${y - 4}" stroke="${color}" stroke-width="2" class="fl"/>${label(x + 21, y, text, 11, 's')}`
      x += 34 + text.length * 7
      return out
    })
    .join('') + `<circle cx="${x + 6}" cy="${y - 4}" r="5" fill="none" stroke="#8E929A" stroke-dasharray="2 2"/>${label(x + 15, y, 'not cloned', 11, 's')}`
}

const isHot = (edge: Edge, alert: Impact | null): boolean =>
  !!alert && alert.edges.some(e => e.from === edge.from && e.to === edge.to && e.kind === edge.kind && e.via === edge.via)

const TRIGGER_TEXT: Record<Impact['trigger'], string> = {
  migration: 'Migration',
  contract: 'Contract',
  handler: 'Handler',
  config: 'Config',
}

/** One repo in the middle, who uses it on the left, what it uses on the right; an edit's edges glow. */
export function focusSvg(W: number, graph: Graph, repo: string, alert: Impact | null): { source: string; height: number } {
  const room = Math.floor((MAX_HEIGHT - 200) / ROW)
  const users = graph.edges.filter(e => e.to === repo).slice(0, room)
  const uses = graph.edges.filter(e => e.from === repo).slice(0, room)
  const myAlert = alert && alert.repo === repo ? alert : null
  const banner = myAlert ? 52 : 0
  const top = banner + 34
  const rows = Math.max(users.length, uses.length, 2)
  const H = top + rows * ROW + 36
  const cx = W / 2
  const cy = top + (rows * ROW) / 2
  const nodeW = Math.max(110, Math.round(W * 0.3))
  const leftX = 8
  const rightX = W - 8 - nodeW
  const parts: string[] = []

  if (myAlert) {
    const n = new Set(myAlert.edges.map(e => otherEnd(e, repo))).size
    parts.push(
      `<rect x="0" y="0" width="${W}" height="${banner - 10}" rx="8" fill="#E5484D" fill-opacity=".12" stroke="#E5484D" stroke-opacity=".5"/>`,
      `<rect x="0" y="0" width="5" height="${banner - 10}" rx="2" fill="#E5484D" class="halo"/>`,
      label(14, 18, `▲ ${TRIGGER_TEXT[myAlert.trigger]} edited · ${n} ${n === 1 ? 'service' : 'services'} affected`, 13, 't', ' font-weight="700"'),
      label(14, 34, fit(myAlert.file, W - 28, 11), 11, 's'),
    )
  }
  parts.push(
    label(leftX, top - 14, `USED BY · ${users.length}`, 11, 's', ' font-weight="700" letter-spacing=".08em"'),
    label(W - 8, top - 14, `USES · ${uses.length}`, 11, 's', ' font-weight="700" letter-spacing=".08em" text-anchor="end"'),
  )

  const side = (list: Edge[], x: number, isLeft: boolean) =>
    list.forEach((edge, i) => {
      const y = top + (rows * ROW - list.length * ROW) / 2 + i * ROW + ROW / 2
      const color = KIND_HEX[edge.kind]
      const hot = isHot(edge, myAlert)
      // Dashes run the way the dependency points: the user's side towards the used side.
      const from = isLeft ? [x + nodeW, y] : [cx + 30, cy]
      const to = isLeft ? [cx - 30, cy] : [x, y]
      const mid = (from[0]! + to[0]!) / 2
      const d = `M${from[0]} ${from[1]} C${mid} ${from[1]} ${mid} ${to[1]} ${to[0]} ${to[1]}`
      parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-opacity=".85" class="${hot ? 'hot' : 'fl'}"/>`)
      if (hot) parts.push(`<circle r="4" fill="#E5484D"><animateMotion dur="1.2s" repeatCount="indefinite" path="${d}"/></circle>`)
      const name = otherEnd(edge, repo)
      const tip = `${name} ${isLeft ? '→' : '←'} ${repo}: ${KIND_NAME[edge.kind]} via ${edge.via}${edge.isExternal ? ' (not cloned)' : ''}`
      parts.push(
        `<g><title>${xml(tip)}</title>`,
        `<rect x="${x}" y="${y - 19}" width="${nodeW}" height="38" rx="10" class="card"${edge.isExternal ? ' stroke-dasharray="4 3"' : ''}${hot ? ' style="stroke:#E5484D;stroke-width:2"' : ''}/>`,
        `<rect x="${isLeft ? x : x + nodeW - 4}" y="${y - 19}" width="4" height="38" rx="2" fill="${color}"/>`,
        label(x + (isLeft ? 12 : 10), y - 3, fit(name, nodeW - 22, 12), 12, 't', ' font-weight="600"'),
        label(x + (isLeft ? 12 : 10), y + 12, fit(`${KIND_NAME[edge.kind]} · ${edge.via}`, nodeW - 22, 10), 10, 's'),
        '</g>',
      )
    })
  side(users, leftX, true)
  side(uses, rightX, false)
  if (users.length === 0) parts.push(label(leftX, cy + 4, 'nobody', 12, 's'))
  if (uses.length === 0) parts.push(label(W - 8, cy + 4, 'nothing', 12, 's', ' text-anchor="end"'))

  const ring = myAlert ? '#E5484D' : VIOLET
  parts.push(
    `<g><title>${xml(repo)}</title>`,
    `<circle cx="${cx}" cy="${cy}" r="38" fill="${ring}" fill-opacity=".14" class="halo"/>`,
    `<circle cx="${cx}" cy="${cy}" r="30" fill="${ring}" fill-opacity=".2" stroke="${ring}" stroke-width="2"/>`,
    label(cx, cy + 6, String(users.length + uses.length), 16, 't', ' font-weight="700" text-anchor="middle"'),
    label(cx, cy + 54, fit(repo, Math.max(120, W - 2 * nodeW - 40), 12), 12, 't', ' font-weight="700" text-anchor="middle"'),
    '</g>',
    legend(H - 8),
  )
  return { source: svg(W, H, parts.join('\n')), height: H }
}

/** Every connected repo on a ring, sized by how many depend on it, edges flowing between them. */
export function mapSvg(W: number, graph: Graph, alert: Impact | null): { source: string; height: number } {
  const users = (name: string) => graph.edges.filter(e => e.to === name).length
  const degree = (name: string) => graph.edges.filter(e => e.to === name || e.from === name).length
  const names = [...new Set(graph.edges.flatMap(e => [e.from, e.to]))]
    .sort((a, b) => degree(b) - degree(a) || a.localeCompare(b))
    .slice(0, 28)
  const H = Math.round(Math.min(Math.max(W * 0.85, 260), 560))
  const cx = W / 2
  const cy = H / 2 - 8
  const r = Math.min(W / 2 - 90, H / 2 - 40)
  const at = new Map(names.map((name, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, names.length)
    return [name, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle), angle }]
  }))
  const parts: string[] = []
  for (const edge of graph.edges) {
    const a = at.get(edge.from)
    const b = at.get(edge.to)
    if (!a || !b) continue
    const hot = isHot(edge, alert)
    // The curve bends towards the middle so chords between neighbours stay apart.
    const qx = cx + ((a.x + b.x) / 2 - cx) * 0.25
    const qy = cy + ((a.y + b.y) / 2 - cy) * 0.25
    const d = `M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q${qx.toFixed(1)} ${qy.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`
    parts.push(
      `<path d="${d}" fill="none" stroke="${KIND_HEX[edge.kind]}" stroke-width="1.6" stroke-opacity=".7" class="${hot ? 'hot' : 'fl'}"><title>${xml(`${edge.from} → ${edge.to}: ${KIND_NAME[edge.kind]} via ${edge.via}`)}</title></path>`,
    )
  }
  for (const name of names) {
    const p = at.get(name)!
    const n = users(name)
    const radius = 5 + Math.min(n, 6) * 2.5
    const isExternal = graph.edges.some(e => e.to === name && e.isExternal)
    const isHotNode = !!alert && (alert.repo === name || alert.edges.some(e => otherEnd(e, alert.repo) === name))
    const color = isHotNode ? '#E5484D' : VIOLET
    const lx = cx + (r + radius + 8) * Math.cos(p.angle)
    const ly = cy + (r + radius + 8) * Math.sin(p.angle) + 4
    const anchor = Math.abs(Math.cos(p.angle)) < 0.2 ? 'middle' : Math.cos(p.angle) > 0 ? 'start' : 'end'
    parts.push(
      `<g><title>${xml(`${name}: ${n} depend on it`)}</title>`,
      n >= 2 || isHotNode ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${radius + 5}" fill="${color}" fill-opacity=".15" class="halo"/>` : '',
      `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${radius}" fill="${isExternal ? 'none' : color}" fill-opacity="${isExternal ? 1 : 0.85}" stroke="${color}" stroke-width="1.5"${isExternal ? ' stroke-dasharray="2 2"' : ''}/>`,
      n > 0 ? label(p.x, p.y + 4, String(n), 10, '', ` fill="#fff" font-weight="700" text-anchor="middle"`) : '',
      label(lx, ly, fit(name, 90, 11), 11, n >= 2 ? 't' : 's', `${n >= 2 ? ' font-weight="600"' : ''} text-anchor="${anchor}"`),
      '</g>',
    )
  }
  parts.push(
    label(8, 16, `${names.length} services · ${graph.edges.length} connections`, 12, 's', ' font-weight="600"'),
    legend(H - 6),
  )
  return { source: svg(W, H, parts.join('\n')), height: H }
}
