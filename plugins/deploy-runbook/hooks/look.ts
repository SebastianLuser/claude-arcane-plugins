// The desktop drawings of the runbook, in the "Mods de Claude" deck's look: warm paper by day,
// night and chalk by dark, coral accents, serif titles and spaced mono eyebrows.
import type { Consumer, MigrationInfo, MigrationMode, NewVar, Report, Risk, Step } from '../types'

export const CORAL = '#D97757'
const GREEN = '#5FAE7A'
const RED = '#D9544A'
const AMBER = '#D69E2E'
const DISPLAY = "Newsreader,Georgia,'Times New Roman',serif"
const BODY = "Geist,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
const MONO = "'Geist Mono',ui-monospace,'Cascadia Code',Consolas,monospace"
const CSS = `<style>
.t{fill:#1E1B18}.s{fill:#5E574F}.m{fill:#8C8378}.tile{fill:#F2EDE4}.ln{stroke:#DDD4C6}
.card{fill:#FBF8F2;stroke:#DDD4C6}.card.on{stroke:${CORAL};fill:#FDF3EC}
@media (prefers-color-scheme: dark){.t{fill:#EDE6DA}.s{fill:#A69C8F}.m{fill:#7A7066}.tile{fill:#2B2621}.ln{stroke:#3A342D}
.card{fill:#24201C;stroke:#3A342D}.card.on{fill:#2B1F19}}
</style>`
// The engine refuses an Svg taller than 4096px.
const MAX_H = 4096

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const xml = (text: string) => text.replace(/[&<>"']/g, c => ESCAPES[c] ?? c)

// Rough advance of the fonts, in em; mono is even.
const charEm = (ch: string) => (/[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-Zmw@%]/.test(ch) ? 0.7 : 0.55)
const width = (text: string, size: number, mono = false) => (mono ? text.length * size * 0.6 : [...text].reduce((w, ch) => w + charEm(ch) * size, 0))

export function fit(text: string, size: number, maxW: number, mono = false): string {
  if (width(text, size, mono) <= maxW) return text
  let out = ''
  for (const ch of text) {
    if (width(`${out}${ch}…`, size, mono) > maxW) break
    out += ch
  }
  return `${out}…`
}

export function wrap(text: string, size: number, maxW: number, max: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if (width(next, size) <= maxW) line = next
    else {
      if (line) lines.push(line)
      line = fit(word, size, maxW)
    }
  }
  if (line) lines.push(line)
  if (lines.length > max) {
    lines.length = max
    lines[max - 1] = fit(`${lines[max - 1]} …`, size, maxW)
  }
  return lines
}

const svg = (W: number, H: number, body: string) => {
  const h = Math.min(MAX_H, Math.ceil(H))
  return { source: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}">${CSS}${body}</svg>`, height: h }
}

const eyebrow = (x: number, y: number, text: string, fill = CORAL, maxW = 9999, anchor = '') =>
  `<text x="${x}" y="${y}" fill="${fill}" font-family="${MONO}" font-size="9.5" letter-spacing="1.3"${anchor ? ` text-anchor="${anchor}"` : ''}>${xml(fit(text.toUpperCase(), 11.5, maxW, true))}</text>`

const card = (W: number, H: number, on = false) => `<rect class="card${on ? ' on' : ''}" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12"/>`

// Lines of a command on a tile, in mono; returns the markup and the height it took.
function commandTile(x: number, y: number, w: number, command: string, max = 8): { body: string; height: number } {
  const lines = command.split('\n').slice(0, max)
  const h = lines.length * 16 + 12
  const body = `<rect class="tile" x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/>${lines
    .map((l, i) => `<text class="t" x="${x + 10}" y="${y + 19 + i * 16}" font-family="${MONO}" font-size="11"><tspan fill="${CORAL}">$ </tspan>${xml(fit(l, 11, w - 34, true))}</text>`)
    .join('')}`
  return { body, height: h }
}

/** The branch and what it carries: the top of the pane. */
export function headerSvg(W: number, r: Report) {
  const { info } = r
  const pushed = info.unpushed === null ? 'not pushed yet' : info.unpushed === 0 ? 'pushed' : `${info.unpushed} not pushed`
  const high = r.risks.filter(k => k.level === 'high').length
  const chips: [string, string][] = [
    [`${r.migrations.length} migration${r.migrations.length === 1 ? '' : 's'}`, CORAL],
    [`${r.vars.length} variable${r.vars.length === 1 ? '' : 's'}`, CORAL],
    ...(r.risks.length ? [[`${r.risks.length} risk${r.risks.length === 1 ? '' : 's'}`, high ? RED : AMBER] as [string, string]] : []),
    ...(r.envs?.length ? [[r.envs.join(' · '), '#8C8378'] as [string, string]] : []),
  ]
  let x = 0
  const pills = chips
    .map(([text, color]) => {
      // Mono at 9.5px advances 5.7px a glyph, plus the 1.3px letter spacing.
      const w = text.length * 7 + 18
      if (x + w > W) return ''
      const out = `<rect x="${x + 0.5}" y="72.5" width="${w}" height="20" rx="10" fill="${color}" fill-opacity=".12" stroke="${color}" stroke-opacity=".6"/>${eyebrow(x + w / 2 + 0.5, 86, text, color, 9999, 'middle')}`
      x += w + 6
      return out
    })
    .join('')
  return svg(
    W,
    98,
    `${eyebrow(0, 12, `Deploy · ${r.repo}`)}
<text class="t" x="0" y="40" font-family="${DISPLAY}" font-size="24">${xml(fit(r.branch, 24, W))}</text>
<text class="s" x="0" y="60" font-family="${BODY}" font-size="12">${xml(fit(`against ${r.base} · ${info.commits} commit${info.commits === 1 ? '' : 's'} · ${info.files} file${info.files === 1 ? '' : 's'} changed · ${pushed}`, 12, W))}</text>
${pills}`,
  )
}

/** A section's title: a coral number and a serif name, as the deck's slides open. */
export function sectionSvg(W: number, n: number, title: string, note = '') {
  return svg(
    W,
    34,
    `${eyebrow(0, 22, String(n).padStart(2, '0'))}
<text class="t" x="26" y="24" font-family="${DISPLAY}" font-style="italic" font-size="19">${xml(title)}</text>
${note ? `<text class="m" x="${W}" y="23" text-anchor="end" font-family="${MONO}" font-size="10.5">${xml(note)}</text>` : ''}`,
  )
}

export function stepSvg(W: number, i: number, step: Step, isDone: boolean) {
  const X = 46
  const inner = W - X - 14
  const title = wrap(step.text, 15, inner, 2)
  let y = 26
  const parts = [
    isDone
      ? `<circle cx="23" cy="24" r="11" fill="${GREEN}"/><path d="M18 24l3.5 3.5 6.5-7" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
      : `<circle cx="23" cy="24" r="10.5" fill="none" stroke="${CORAL}" stroke-width="1.5"/><text x="23" y="28" fill="${CORAL}" text-anchor="middle" font-family="${MONO}" font-size="11">${i + 1}</text>`,
  ]
  for (const line of title) {
    parts.push(`<text ${isDone ? 'class="m" text-decoration="line-through"' : 'class="t"'} x="${X}" y="${y + 2}" font-family="${DISPLAY}" font-size="15">${xml(line)}</text>`)
    y += 19
  }
  if (step.detail) {
    for (const line of wrap(step.detail, 11.5, inner, 2)) {
      parts.push(`<text class="s" x="${X}" y="${y}" font-family="${BODY}" font-size="11.5">${xml(line)}</text>`)
      y += 15
    }
  }
  if (step.command && !isDone) {
    const tile = commandTile(X, y - 4, inner, step.command)
    parts.push(tile.body)
    y += tile.height + 2
  }
  const H = y + 6
  return svg(W, H, `${card(W, H, !isDone && i === 0)}${parts.join('')}`)
}

/** Every variable against every environment: what to load where. */
export function matrixSvg(W: number, vars: NewVar[], envs: string[]) {
  const cols = envs.length > 0 ? envs : ['every environment']
  const nameW = Math.min(230, Math.max(140, W * 0.42))
  const colW = (W - nameW - 16) / cols.length
  const ROW = 40
  const parts: string[] = []
  cols.forEach((env, c) => parts.push(eyebrow(nameW + c * colW + colW / 2, 22, env, '#8C8378', colW - 6, 'middle')))
  parts.push(eyebrow(14, 22, 'Variable', '#8C8378'))
  vars.forEach((v, r) => {
    const y = 34 + r * ROW
    const isRemoved = v.status === 'removed'
    parts.push(`<line class="ln" x1="10" y1="${y}" x2="${W - 10}" y2="${y}"/>`)
    parts.push(`<text class="t" x="14" y="${y + 18}" font-family="${MONO}" font-size="12"${isRemoved ? ' text-decoration="line-through"' : ''}>${xml(fit(v.name, 12, nameW - 20, true))}</text>`)
    const tag = isRemoved ? 'removed' : v.fallback != null ? 'optional' : 'required'
    parts.push(eyebrow(14, y + 32, `${tag} · ${v.target ?? 'where?'}`, isRemoved ? RED : v.target ? GREEN : AMBER, nameW - 20))
    cols.forEach((env, c) => {
      const cx = nameW + c * colW + colW / 2
      const isIn = envs.length === 0 || (v.envs ?? envs).includes(env)
      if (!isIn) {
        parts.push(`<text class="m" x="${cx}" y="${y + 24}" text-anchor="middle" font-family="${MONO}" font-size="12">—</text>`)
        return
      }
      const color = isRemoved ? RED : CORAL
      const mark = isRemoved
        ? `<path d="M${cx - 4} ${y + 16}l8 8M${cx + 4} ${y + 16}l-8 8" stroke="${color}" stroke-width="2" stroke-linecap="round"/>`
        : v.fallback != null
          ? `<circle cx="${cx}" cy="${y + 20}" r="5" fill="none" stroke="${color}" stroke-width="1.6"/>`
          : `<circle cx="${cx}" cy="${y + 20}" r="5.5" fill="${color}"/>`
      parts.push(mark)
    })
  })
  const legendY = 34 + vars.length * ROW + 18
  const legend: [string, string][] = [
    [`<circle cx="6" cy="-3" r="5" fill="${CORAL}"/>`, 'load it'],
    [`<circle cx="6" cy="-3" r="4.5" fill="none" stroke="${CORAL}" stroke-width="1.6"/>`, 'optional'],
    [`<path d="M2 -7l8 8M10 -7l-8 8" stroke="${RED}" stroke-width="2" stroke-linecap="round"/>`, 'delete it'],
  ]
  let lx = 14
  for (const [icon, text] of legend) {
    parts.push(`<g transform="translate(${lx},${legendY})">${icon}<text class="s" x="16" y="1" font-family="${BODY}" font-size="11">${text}</text></g>`)
    lx += 30 + width(text, 11)
  }
  const H = legendY + 14
  return svg(W, H, `${card(W, H)}${parts.join('')}`)
}

/** One variable, opened: where it goes, whether it is needed, where the code reads it, and how to load it. */
export function varSvg(W: number, v: NewVar) {
  const X = 18
  const inner = W - X - 14
  const parts: string[] = []
  let y = 24
  const row = (label: string, value: string, color = '') => {
    parts.push(eyebrow(X, y, label, '#8C8378'))
    for (const line of wrap(value, 12.5, inner - 96, 3)) {
      parts.push(`<text ${color ? `fill="${color}"` : 'class="t"'} x="${X + 96}" y="${y + 1}" font-family="${BODY}" font-size="12.5">${xml(line)}</text>`)
      y += 17
    }
    y += 5
  }
  const isRemoved = v.status === 'removed'
  row('Where', `${v.target ?? 'not detected'}${v.envs?.length ? ` · ${v.envs.join(', ')}` : ''}`, v.target ? '' : AMBER)
  if (!isRemoved) {
    row('Needed', v.fallback != null ? `Optional: the code falls back to "${v.fallback}"` : 'Required: the code has no fallback', v.fallback != null ? '' : CORAL)
    row('Example', v.examples?.length ? `Listed in ${v.examples.join(', ')}` : 'No example env file lists it')
  } else {
    row('Status', 'The branch stops reading it: delete it after the deploy', RED)
  }
  const reads = (v.uses ?? []).filter(u => !/\.env/.test(u.file)).slice(0, 6)
  if (reads.length) {
    parts.push(eyebrow(X, y, 'Read in', '#8C8378'))
    y += 4
    for (const use of reads) {
      parts.push(`<text class="m" x="${X}" y="${y + 14}" font-family="${MONO}" font-size="10.5">${xml(fit(`${use.file}${use.line ? `:${use.line}` : ''}`, 10.5, inner, true))}</text>`)
      parts.push(`<text class="t" x="${X}" y="${y + 29}" font-family="${MONO}" font-size="11">${xml(fit(use.code, 11, inner, true))}</text>`)
      y += 36
    }
    y += 14
  }
  if (v.command) {
    parts.push(eyebrow(X, y, isRemoved ? 'To delete it' : 'To load it', '#8C8378'))
    const tile = commandTile(X, y + 8, inner, v.command)
    parts.push(tile.body)
    y += tile.height + 22
  }
  const H = y
  return svg(W, H, `${card(W, H)}<rect x="0.5" y="12" width="3" height="${Math.max(0, H - 24)}" rx="1.5" fill="${CORAL}"/>${parts.join('')}`)
}

/** How the repo applies its migrations, with the command when it names one. */
export function modeSvg(W: number, mode: MigrationMode) {
  const X = 18
  const inner = W - X - 14
  const isByHand = mode.kind === 'manual' || mode.kind === 'unknown'
  const parts = [eyebrow(X, 24, isByHand ? 'By hand' : 'On their own', isByHand ? AMBER : GREEN)]
  let y = 46
  for (const line of wrap(mode.text, 15, inner, 3)) {
    parts.push(`<text class="t" x="${X}" y="${y}" font-family="${DISPLAY}" font-size="15">${xml(line)}</text>`)
    y += 20
  }
  if (mode.source) {
    parts.push(`<text class="m" x="${X}" y="${y}" font-family="${MONO}" font-size="10.5">${xml(fit(`from ${mode.source}`, 10.5, inner, true))}</text>`)
    y += 12
  }
  if (mode.command) {
    const tile = commandTile(X, y, inner, mode.command)
    parts.push(tile.body)
    y += tile.height + 4
  }
  const H = y + 12
  return svg(W, H, `${card(W, H)}${parts.join('')}`)
}

/** One migration explained: what it does, what could go wrong and whether it can be undone. */
export function migrationSvg(W: number, m: MigrationInfo, risks: Risk[]) {
  const X = 18
  const inner = W - X - 14
  const name = m.path.split('/').pop() ?? m.path
  const parts = [eyebrow(X, 24, name, CORAL, inner - 90)]
  parts.push(
    m.hasDown
      ? eyebrow(W - 14, 24, '↺ undoable', GREEN, 90, 'end')
      : eyebrow(W - 14, 24, 'no down', AMBER, 90, 'end'),
  )
  let y = 46
  const lines = m.summary.length > 0 ? m.summary : ['Nothing it does was read: open the SQL']
  for (const s of lines.slice(0, 12)) {
    parts.push(`<circle cx="${X + 3}" cy="${y - 4}" r="2.5" fill="${CORAL}"/>`)
    for (const [k, line] of wrap(s, 13, inner - 14, 2).entries()) {
      parts.push(`<text class="t" x="${X + 14}" y="${y}" font-family="${BODY}" font-size="13">${xml(line)}</text>`)
      y += k === 0 ? 18 : 17
    }
  }
  if (risks.length) {
    y += 4
    for (const risk of risks.filter(r => !/^No down migration/.test(r.text)).slice(0, 6)) {
      const color = risk.level === 'high' ? RED : AMBER
      const rows = wrap(risk.text, 12, inner - 34, 2)
      const h = rows.length * 16 + 10
      parts.push(`<rect x="${X}" y="${y - 2}" width="${inner}" height="${h}" rx="8" fill="${color}" fill-opacity=".1"/>`)
      parts.push(`<text x="${X + 10}" y="${y + 13}" fill="${color}" font-family="${BODY}" font-size="12">▲</text>`)
      rows.forEach((line, k) => parts.push(`<text x="${X + 26}" y="${y + 13 + k * 16}" fill="${color}" font-family="${BODY}" font-size="12">${xml(line)}</text>`))
      y += h + 6
    }
  }
  const H = y + 8
  return svg(W, H, `${card(W, H)}${parts.join('')}`)
}

/** The migration's SQL, as written. */
export function sqlSvg(W: number, sql: string) {
  const lines = sql.replace(/\t/g, '  ').split('\n')
  const shown = lines.slice(0, 60)
  const H = shown.length * 15 + 22 + (lines.length > shown.length ? 15 : 0)
  return svg(
    W,
    H,
    `<rect class="tile" x="0" y="0" width="${W}" height="${H}" rx="10"/>${shown
      .map((l, i) => `<text class="${/^\s*--/.test(l) ? 'm' : 't'}" x="12" y="${20 + i * 15}" font-family="${MONO}" font-size="11" xml:space="preserve">${xml(fit(l, 11, W - 24, true))}</text>`)
      .join('')}${lines.length > shown.length ? `<text class="m" x="12" y="${20 + shown.length * 15}" font-family="${MONO}" font-size="11">… ${lines.length - shown.length} more lines</text>` : ''}`,
  )
}

/** Repos next to this one that read its database or call it. */
export function consumersSvg(W: number, consumers: Consumer[]) {
  const parts: string[] = []
  consumers.forEach((c, i) => {
    const y = 14 + i * 44
    if (i > 0) parts.push(`<line class="ln" x1="14" y1="${y - 6}" x2="${W - 14}" y2="${y - 6}"/>`)
    parts.push(`<circle cx="22" cy="${y + 13}" r="4" fill="${c.kind === 'db' ? CORAL : '#8C8378'}"/>`)
    parts.push(`<text class="t" x="36" y="${y + 17}" font-family="${DISPLAY}" font-size="15">${xml(fit(c.repo, 15, W * 0.45))}</text>`)
    parts.push(`<text class="s" x="${W - 14}" y="${y + 16}" text-anchor="end" font-family="${BODY}" font-size="11.5">${xml(fit(`${c.kind === 'db' ? 'reads this database' : 'calls this service'} · ${c.file}`, 11.5, W * 0.5))}</text>`)
  })
  const H = 14 + consumers.length * 44
  return svg(W, H, `${card(W, H)}${parts.join('')}`)
}
