import type { Column, RiskLevel, SqlChanges, TableChange } from '../types'

const NAME = String.raw`[\w."]+`
const CREATE_TABLE = new RegExp(
  String.raw`^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${NAME})\s*\(([\s\S]*)\)$`,
  'i',
)
const ALTER_TABLE = new RegExp(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${NAME})\s+([\s\S]+)$`, 'i')
const DROP_TABLE = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\s\S]+?)(?:\s+(?:CASCADE|RESTRICT))?$/i
const IGNORED = /^(BEGIN|COMMIT|END|START\s+TRANSACTION|SET)\b/i
const TABLE_CONSTRAINT = /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|EXCLUDE|FOREIGN|LIKE)\b/i
const COLUMN_END = /\s(NOT|NULL|DEFAULT|REFERENCES|PRIMARY|UNIQUE|CHECK|CONSTRAINT|GENERATED|COLLATE)\b/i
const INLINE_FK = new RegExp(String.raw`\bREFERENCES\s+(${NAME})`, 'i')
const TABLE_FK = new RegExp(String.raw`FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+(${NAME})`, 'i')
const DOLLAR_TAG = /^\$[A-Za-z_]*\$/

function unquote(name: string): string {
  return name.replace(/"/g, '')
}

function quoteEnd(sql: string, start: number): number {
  let i = start + 1
  while (i < sql.length) {
    if (sql[i] === "'" && sql[i + 1] === "'") i += 2
    else if (sql[i] === "'") return i + 1
    else i += 1
  }
  return sql.length
}

/** Splits on top-level `;`, dropping comments and keeping quoted text and `$$` bodies whole. */
export function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let i = 0
  const push = () => {
    const text = current.replace(/\s+/g, ' ').trim()
    if (text) statements.push(text)
    current = ''
  }
  while (i < sql.length) {
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? sql.length : end
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 2
    } else if (sql[i] === "'") {
      const end = quoteEnd(sql, i)
      current += sql.slice(i, end)
      i = end
    } else if (sql[i] === '$' && DOLLAR_TAG.test(sql.slice(i, i + 64))) {
      const tag = DOLLAR_TAG.exec(sql.slice(i, i + 64))![0]
      const close = sql.indexOf(tag, i + tag.length)
      const end = close === -1 ? sql.length : close + tag.length
      current += sql.slice(i, end)
      i = end
    } else if (sql[i] === ';') {
      push()
      i += 1
    } else {
      current += sql[i]
      i += 1
    }
  }
  push()
  return statements
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'") {
      i = quoteEnd(text, i)
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim())
      start = i + 1
    }
    i += 1
  }
  parts.push(text.slice(start).trim())
  return parts.filter(Boolean)
}

function parseColumn(definition: string): { column: Column; references: string | null } | null {
  const match = /^("[^"]+"|[\w]+)\s+([\s\S]+)$/.exec(definition)
  if (!match) return null
  const rest = ` ${match[2]!}`
  const cut = COLUMN_END.exec(rest)
  const type = (cut ? rest.slice(0, cut.index) : rest).trim()
  const fk = INLINE_FK.exec(rest)
  return { column: { name: unquote(match[1]!), type }, references: fk ? unquote(fk[1]!) : null }
}

function tableFks(constraint: string): { column: string; table: string }[] {
  const fk = TABLE_FK.exec(constraint)
  if (!fk) return []
  return fk[1]!.split(',').map(column => ({ column: unquote(column.trim()), table: unquote(fk[2]!) }))
}

export function tableChanges(sql: string): SqlChanges {
  const tables = new Map<string, TableChange>()
  let skipped = 0
  const tableOf = (raw: string): TableChange => {
    const name = unquote(raw)
    const known = tables.get(name)
    if (known) return known
    const created: TableChange = { table: name, isNew: false, isDropped: false, added: [], dropped: [], renamed: [], foreignKeys: [] }
    tables.set(name, created)
    return created
  }

  for (const statement of splitStatements(sql)) {
    if (IGNORED.test(statement)) continue

    const create = CREATE_TABLE.exec(statement)
    if (create) {
      const table = tableOf(create[1]!)
      table.isNew = true
      for (const item of splitTopLevel(create[2]!)) {
        if (TABLE_CONSTRAINT.test(item)) {
          table.foreignKeys.push(...tableFks(item))
          continue
        }
        const parsed = parseColumn(item)
        if (!parsed) continue
        table.added.push(parsed.column)
        if (parsed.references) table.foreignKeys.push({ column: parsed.column.name, table: parsed.references })
      }
      continue
    }

    const alter = ALTER_TABLE.exec(statement)
    if (alter) {
      const table = tableOf(alter[1]!)
      for (const action of splitTopLevel(alter[2]!)) {
        const fks = /^ADD\s+(CONSTRAINT\s+\S+\s+)?FOREIGN\s+KEY/i.test(action) ? tableFks(action) : []
        const addColumn = /^ADD\s+(?!CONSTRAINT\b|PRIMARY\b|UNIQUE\b|CHECK\b|EXCLUDE\b|FOREIGN\b)(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([\s\S]+)$/i.exec(action)
        const dropColumn = /^DROP\s+(?!CONSTRAINT\b)(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?("[^"]+"|\w+)/i.exec(action)
        const rename = /^RENAME\s+(?:COLUMN\s+)?("[^"]+"|\w+)\s+TO\s+("[^"]+"|\w+)$/i.exec(action)
        const retype = /^ALTER\s+(?:COLUMN\s+)?("[^"]+"|\w+)\s+(?:SET\s+DATA\s+)?TYPE\s+(.+?)(?:\s+USING\b[\s\S]*)?$/i.exec(action)
        if (retype) {
          table.retyped = [...(table.retyped ?? []), { name: unquote(retype[1]!), type: retype[2]!.trim() }]
        } else if (fks.length > 0) {
          table.foreignKeys.push(...fks)
        } else if (addColumn && parseColumn(addColumn[1]!)) {
          const parsed = parseColumn(addColumn[1]!)!
          table.added.push(parsed.column)
          if (parsed.references) table.foreignKeys.push({ column: parsed.column.name, table: parsed.references })
        } else if (dropColumn) {
          table.dropped.push(unquote(dropColumn[1]!))
        } else if (rename) {
          table.renamed.push({ from: unquote(rename[1]!), to: unquote(rename[2]!) })
        } else {
          skipped += 1
        }
      }
      continue
    }

    const drop = DROP_TABLE.exec(statement)
    if (drop) {
      for (const name of drop[1]!.split(',')) tableOf(name.trim()).isDropped = true
      continue
    }

    skipped += 1
  }

  const changed = [...tables.values()].filter(
    table => table.isNew || table.isDropped || table.added.length + table.dropped.length + table.renamed.length + table.foreignKeys.length + (table.retyped?.length ?? 0) > 0,
  )
  return { tables: changed, skipped }
}

const RISKS: { pattern: RegExp; level: RiskLevel; text: (m: RegExpExecArray) => string }[] = [
  { pattern: /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w."]+)/i, level: 'high', text: m => `Drops table ${unquote(m[1]!)}: its data is lost` },
  { pattern: /^TRUNCATE\s+(?:TABLE\s+)?([\w."]+)/i, level: 'high', text: m => `Empties table ${unquote(m[1]!)}` },
  { pattern: /^(DELETE\s+FROM|UPDATE)\s+([\w."]+)(?![\s\S]*\bWHERE\b)/i, level: 'high', text: m => `${m[1]!.split(/\s/)[0]!.toUpperCase()} on every row of ${unquote(m[2]!)} (no WHERE)` },
  { pattern: /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY\b)(?:IF\s+NOT\s+EXISTS\s+)?(?:[\w."]+\s+)?ON\s+(?:ONLY\s+)?([\w."]+)/i, level: 'medium', text: m => `Index on ${unquote(m[1]!)} without CONCURRENTLY: blocks writes while it builds` },
  { pattern: /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([\w."]+)\s+RENAME\s+TO\s+([\w."]+)/i, level: 'medium', text: m => `Renames table ${unquote(m[1]!)} to ${unquote(m[2]!)}: code using the old name breaks` },
]

const ALTER_RISKS: { pattern: RegExp; level: RiskLevel; text: (table: string, m: RegExpExecArray) => string }[] = [
  { pattern: /^DROP\s+(?!CONSTRAINT\b)(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?("[^"]+"|\w+)/i, level: 'high', text: (t, m) => `Drops column ${t}.${unquote(m[1]!)}: its data is lost` },
  { pattern: /^ALTER\s+(?:COLUMN\s+)?("[^"]+"|\w+)\s+(?:SET\s+DATA\s+)?TYPE\b/i, level: 'high', text: (t, m) => `Changes the type of ${t}.${unquote(m[1]!)}: rewrites and locks the table` },
  { pattern: /^ALTER\s+(?:COLUMN\s+)?("[^"]+"|\w+)\s+SET\s+NOT\s+NULL/i, level: 'medium', text: (t, m) => `Sets ${t}.${unquote(m[1]!)} NOT NULL: fails if a row has it empty` },
  { pattern: /^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|\w+)\s(?=[\s\S]*\bNOT\s+NULL\b)(?![\s\S]*\bDEFAULT\b)/i, level: 'high', text: (t, m) => `Adds ${t}.${unquote(m[1]!)} NOT NULL without a default: fails if ${t} has rows` },
  { pattern: /^RENAME\s+(?:COLUMN\s+)?("[^"]+"|\w+)\s+TO\s+("[^"]+"|\w+)$/i, level: 'medium', text: (t, m) => `Renames ${t}.${unquote(m[1]!)} to ${unquote(m[2]!)}: code using the old name breaks` },
]

/** What in a migration can lose data or lock a table, most severe first. */
export function migrationRisks(sql: string): { level: RiskLevel; text: string }[] {
  const risks: { level: RiskLevel; text: string }[] = []
  for (const statement of splitStatements(sql)) {
    for (const risk of RISKS) {
      const m = risk.pattern.exec(statement)
      if (m) risks.push({ level: risk.level, text: risk.text(m) })
    }
    const alter = ALTER_TABLE.exec(statement)
    if (!alter) continue
    const table = unquote(alter[1]!)
    for (const action of splitTopLevel(alter[2]!)) {
      for (const risk of ALTER_RISKS) {
        const m = risk.pattern.exec(action)
        if (m) risks.push({ level: risk.level, text: risk.text(table, m) })
      }
    }
  }
  return risks.sort((a, b) => Number(b.level === 'high') - Number(a.level === 'high'))
}

/**
 * Replays migrations in order and returns each table's columns at the end.
 * shortcut: reads CREATE/ALTER/DROP TABLE only; a table built by a function or a DO block is missed.
 */
export function schemaOf(sqls: string[]): Map<string, Column[]> {
  const schema = new Map<string, Column[]>()
  for (const sql of sqls) {
    for (const change of tableChanges(sql).tables) {
      if (change.isDropped) {
        schema.delete(change.table)
        continue
      }
      let columns = change.isNew ? [] : (schema.get(change.table) ?? [])
      columns = columns.filter(c => !change.dropped.includes(c.name))
      for (const r of change.renamed) columns = columns.map(c => (c.name === r.from ? { ...c, name: r.to } : c))
      for (const t of change.retyped ?? []) columns = columns.map(c => (c.name === t.name ? { ...c, type: t.type } : c))
      columns = [...columns.filter(c => !change.added.some(a => a.name === c.name)), ...change.added]
      if (change.isNew || schema.has(change.table)) schema.set(change.table, columns)
    }
  }
  return schema
}
