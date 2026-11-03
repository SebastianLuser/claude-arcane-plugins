import type { Column, TableChange } from '../types'

export type RowKind = 'added' | 'dropped' | 'changed' | 'same' | 'note'
export type Row = { kind: RowKind; name: string; type: string; ref: string | null }

const COLOR: Record<Exclude<RowKind, 'note'>, string> = { added: '#1D9E75', dropped: '#E5484D', changed: '#D69E2E', same: '#8E929A' }
const VIOLET = '#B138C1'
const MARK: Record<RowKind, string> = { added: '+', dropped: '−', changed: '~', same: '', note: '' }
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
const MONO = "ui-monospace,'Cascadia Mono',Consolas,monospace"
const CSS = `<style>.t{fill:#1f1f1f}.s{fill:#6b6b68}.card{fill:#fff;stroke:#e4e4e1}.head{fill:#f4f3f0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.card{fill:#1f1f1e;stroke:#333331}.head{fill:#262625}}</style>`
const HEADER = 32
const ROW = 22
const GAP = 14
const LEGEND = 26
const MIN_CARD = 260
const MAX_CARD = 380
const MAX_ROWS = 40
// The engine refuses an Svg taller than 4096px.
const MAX_HEIGHT = 4096

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const xml = (text: string) => text.replace(/[&<>"']/g, c => ESCAPES[c] ?? c)

function fit(text: string, width: number, size: number): string {
  const max = Math.max(3, Math.floor(width / (size * 0.6)))
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** The table's columns as they end up, each marked added, dropped, changed or unchanged. */
export function tableRows(table: TableChange): Row[] {
  const refs = new Map(table.foreignKeys.map(fk => [fk.column, fk.table]))
  const ref = (name: string) => refs.get(name) ?? null
  const renamedTo = new Map(table.renamed.map(r => [r.from, r.to]))
  const retyped = new Map((table.retyped ?? []).map(c => [c.name, c.type]))
  const added = table.added.map((c): Row => ({ kind: 'added', name: c.name, type: c.type, ref: ref(c.name) }))
  const before: Column[] | null = table.before ?? null

  if (table.isDropped) {
    return before ? before.map(c => ({ kind: 'dropped', name: c.name, type: c.type, ref: null })) : [{ kind: 'note', name: 'the whole table is dropped', type: '', ref: null }]
  }
  if (table.isNew) {
    // Created on this branch: every column is new, as it ends up after the branch's later changes.
    return table.added
      .filter(c => !table.dropped.includes(c.name))
      .map((c): Row => {
        const name = renamedTo.get(c.name) ?? c.name
        return { kind: 'added', name, type: retyped.get(name) ?? c.type, ref: ref(name) ?? ref(c.name) }
      })
  }
  if (!before) {
    // Its earlier columns are unknown: show what changes only.
    const rows: Row[] = [
      ...table.dropped.map((name): Row => ({ kind: 'dropped', name, type: '', ref: null })),
      ...table.renamed.map((r): Row => ({ kind: 'changed', name: `${r.from} → ${r.to}`, type: '', ref: ref(r.to) })),
      ...[...retyped].map(([name, type]): Row => ({ kind: 'changed', name, type: `→ ${type}`, ref: ref(name) })),
      ...added,
    ]
    return [...rows, { kind: 'note', name: 'other columns not read', type: '', ref: null }]
  }
  const rows = before.map((c): Row => {
    if (table.dropped.includes(c.name)) return { kind: 'dropped', name: c.name, type: c.type, ref: null }
    const to = renamedTo.get(c.name)
    const type = retyped.get(to ?? c.name)
    if (to || type) return { kind: 'changed', name: to ? `${c.name} → ${to}` : c.name, type: type ? `${c.type} → ${type}` : c.type, ref: ref(to ?? c.name) }
    return { kind: 'same', name: c.name, type: c.type, ref: ref(c.name) }
  })
  return [...rows, ...added.filter(a => !before.some(c => c.name === a.name))]
}

function tag(table: TableChange): { text: string; color: string } {
  if (table.isDropped) return { text: 'dropped', color: COLOR.dropped }
  if (table.isNew) return { text: 'new', color: COLOR.added }
  return { text: 'changed', color: COLOR.changed }
}

function card(x: number, y: number, w: number, table: TableChange, rows: Row[]): string {
  const shown = rows.slice(0, MAX_ROWS)
  const more = rows.length - shown.length
  const h = HEADER + (shown.length + (more > 0 ? 1 : 0)) * ROW + 8
  const t = tag(table)
  const pillW = t.text.length * 7 + 16
  const parts = [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" class="card" stroke-width="1"/>`,
    `<rect x="${x}" y="${y}" width="${w}" height="${HEADER}" rx="10" class="head"/>`,
    `<rect x="${x}" y="${y + HEADER - 10}" width="${w}" height="10" class="head"/>`,
    `<rect x="${x}" y="${y}" width="4" height="${h}" rx="2" fill="${t.color}"/>`,
    `<text class="t" x="${x + 14}" y="${y + 21}" font-family="${FONT}" font-size="13" font-weight="700">${xml(fit(table.table, w - pillW - 30, 13))}</text>`,
    `<rect x="${x + w - pillW - 10}" y="${y + 8}" width="${pillW}" height="17" rx="8.5" fill="${t.color}" fill-opacity=".18" stroke="${t.color}" stroke-width="1"/>`,
    `<text x="${x + w - pillW / 2 - 10}" y="${y + 20.5}" font-family="${FONT}" font-size="10.5" font-weight="600" fill="${t.color}" text-anchor="middle">${t.text}</text>`,
  ]
  shown.forEach((row, i) => {
    const ry = y + HEADER + i * ROW
    const mid = ry + ROW / 2 + 4
    if (row.kind === 'note') {
      parts.push(`<text class="s" x="${x + 14}" y="${mid}" font-family="${FONT}" font-size="11" font-style="italic">${xml(row.name)}</text>`)
      return
    }
    const color = COLOR[row.kind]
    if (row.kind !== 'same') parts.push(`<rect x="${x + 6}" y="${ry + 2}" width="${w - 12}" height="${ROW - 4}" rx="5" fill="${color}" fill-opacity=".12"/>`)
    const typeText = row.ref ? `${row.type} → ${row.ref}`.trim() : row.type
    // The type takes what it needs, up to half; the name gets the rest.
    const typeW = Math.min(typeText.length * 6.7, (w - 40) * 0.5)
    const nameW = w - 44 - typeW
    parts.push(
      `<text x="${x + 12}" y="${mid}" font-family="${MONO}" font-size="12" font-weight="700" fill="${color}">${MARK[row.kind]}</text>`,
      `<text ${row.kind === 'same' ? 'class="t"' : `fill="${color}"`} x="${x + 26}" y="${mid}" font-family="${MONO}" font-size="12"${row.kind === 'dropped' ? ' text-decoration="line-through"' : ''}>${xml(fit(row.name, nameW, 12))}</text>`,
      `<text ${row.ref ? `fill="${VIOLET}"` : 'class="s"'} x="${x + w - 12}" y="${mid}" font-family="${MONO}" font-size="11" text-anchor="end">${xml(fit(typeText, typeW + 6, 11))}</text>`,
    )
  })
  if (more > 0) parts.push(`<text class="s" x="${x + 14}" y="${y + HEADER + shown.length * ROW + ROW / 2 + 4}" font-family="${FONT}" font-size="11">and ${more} more columns</text>`)
  return parts.join('')
}

/** Every changed table as a card, laid out in as many columns as fit. */
export function tablesSvg(W: number, tables: TableChange[]): { source: string; height: number } {
  const cols = Math.max(1, Math.floor((W + GAP) / (MIN_CARD + GAP)))
  const cardW = Math.min(MAX_CARD, Math.floor((W - GAP * (cols - 1)) / cols))
  const parts: string[] = []
  let y = 0
  for (let i = 0; i < tables.length; i += cols) {
    const row = tables.slice(i, i + cols)
    let tallest = 0
    for (const [j, table] of row.entries()) {
      const rows = tableRows(table)
      const h = HEADER + (Math.min(rows.length, MAX_ROWS) + (rows.length > MAX_ROWS ? 1 : 0)) * ROW + 8
      if (y + h + LEGEND > MAX_HEIGHT) break
      parts.push(card(j * (cardW + GAP), y, cardW, table, rows))
      tallest = Math.max(tallest, h)
    }
    if (tallest === 0) break
    y += tallest + GAP
  }
  let at = 4
  for (const [text, color] of [['added', COLOR.added], ['dropped', COLOR.dropped], ['changed', COLOR.changed], ['unchanged', COLOR.same], ['foreign key', VIOLET]] as const) {
    parts.push(`<circle cx="${at + 5}" cy="${y + 10}" r="5" fill="${color}"/><text class="s" x="${at + 14}" y="${y + 14}" font-family="${FONT}" font-size="11">${text}</text>`)
    at += 26 + text.length * 6.5
  }
  const H = y + LEGEND
  return { source: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${CSS}${parts.join('\n')}</svg>`, height: H }
}
