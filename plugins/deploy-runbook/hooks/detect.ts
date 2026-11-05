import type { BranchInfo, Consumer, MigrationInfo, MigrationMode, NewVar, Report, Risk, Step, TableChange } from '../types'
import { commandsFor, envsFor, environmentsOf, examplesOf, fallbackOf, usesOf } from './envs'
import { migrationRisks, schemaOf, tableChanges } from './sql'

export type Corrections = {
  migrations?: Record<string, string>
  targets?: Record<string, string>
}

export type RepoFile = { path: string; text: string }

export type ReportInput = {
  repo: string
  branch: string
  base: string
  nameStatus: string
  patches: RepoFile[]
  migrationTexts: RepoFile[]
  repoFiles: RepoFile[]
  corrections: Corrections
  /** Every tracked path, to find each migration's down file. */
  trackedPaths: string[]
  consumers: Consumer[]
  info: BranchInfo
  /** The repo's migrations from before this branch, to draw each table as it was. */
  earlierMigrations?: RepoFile[]
  /** Variables the branch stops reading that other code of the repo still reads. */
  stillUsed?: string[]
}

/** Earlier migrations in the order they ran: by file name, which is how the tools number them. */
export function inRunOrder(files: RepoFile[]): RepoFile[] {
  const name = (path: string) => path.split('/').pop()!
  return [...files].sort((a, b) => name(a.path).localeCompare(name(b.path)) || a.path.localeCompare(b.path))
}

const ENV_FILE = /(^|\/)\.env(\.[^/]+)?$/i
const ENV_EXAMPLE = /(^|\/)\.env(\.[\w-]+)*\.(example|sample|template)$/i
const CODE_FILE = /\.(go|ts|tsx|js|jsx|mjs|cjs)$/i
const TEST_FILE = /(_test\.go|\.(test|spec)\.[cm]?[jt]sx?)$/i
const DEPLOY_FILE =
  /(^|\/)([\w.-]*entrypoint[\w.-]*\.sh|Dockerfile[\w.-]*|railway\.(json|toml)|Procfile|nixpacks\.toml|vercel\.json|[Mm]akefile)$|^\.github\/workflows\/[^/]+\.ya?ml$|(^|\/)scripts\/[^/]*migrat[^/]*$|(^|\/)package\.json$/
const STARTUP_FILE = /(^|\/)([\w.-]*entrypoint[\w.-]*\.sh|Dockerfile[\w.-]*|railway\.(json|toml)|Procfile|nixpacks\.toml)$/
const MIGRATE_UP = /\bmigrate\b.*\bup\b/
const IN_CODE = /migrate\.New\w*\(|RunMigrations\(|goose\.Up\(/
const WORKFLOW_CALL = /uses:\s*\.\/\.github\/workflows\/([\w.-]*migrat[\w.-]*)/i
const BUILT_IN_VARS = new Set(['NODE_ENV', 'MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL'])
const CODE_VARS = [
  /os\.(?:Getenv|LookupEnv)\("([A-Z][A-Z0-9_]*)"/g,
  /getEnv\("([A-Z][A-Z0-9_]*)"/g,
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  /process\.env\[["']([A-Z][A-Z0-9_]*)["']\]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
]
const EXAMPLE_VAR = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/

export function isMigration(path: string): boolean {
  return /(^|\/)migrations\/[^/]+\.sql$/i.test(path) && !/\.down\.sql$/i.test(path)
}

/** Files whose diff is read for variable names: code and `.env.example`, never a real `.env`. */
export function isPatchable(path: string): boolean {
  if (ENV_EXAMPLE.test(path)) return true
  if (ENV_FILE.test(path)) return false
  return CODE_FILE.test(path) && !TEST_FILE.test(path)
}

/** Files read to see how the repo deploys: CI, startup files, scripts and the example env files, never a real `.env`. */
export function isDeployFile(path: string): boolean {
  if (path.startsWith('.claude/')) return false
  if (ENV_EXAMPLE.test(path)) return true
  return !ENV_FILE.test(path) && DEPLOY_FILE.test(path)
}

export function changedFiles(nameStatus: string): { status: string; path: string }[] {
  return nameStatus
    .split('\n')
    .map(line => line.trim().split('\t'))
    .filter(parts => parts.length >= 2 && !parts[0]!.startsWith('D'))
    .map(parts => ({ status: parts[0]!, path: parts[parts.length - 1]!.replace(/\\/g, '/') }))
}

export function splitPatch(diff: string): RepoFile[] {
  return diff
    .split(/^diff --git /m)
    .slice(1)
    .flatMap(chunk => {
      const path = /^a\/\S+ b\/(\S+)/.exec(chunk)?.[1]
      return path ? [{ path, text: chunk }] : []
    })
}

function namesIn(path: string, line: string): string[] {
  if (ENV_EXAMPLE.test(path)) {
    const match = EXAMPLE_VAR.exec(line)
    return match ? [match[1]!] : []
  }
  return CODE_VARS.flatMap(pattern => [...line.matchAll(pattern)].map(match => match[1]!))
}

/** Variables the branch starts reading, and those it stops reading (`removed`). */
export function newVars(patches: RepoFile[]): { name: string; file: string; status: 'new' | 'removed' }[] {
  const added = new Map<string, string>()
  const removed = new Map<string, string>()
  for (const { path, text } of patches) {
    if (!isPatchable(path)) continue
    for (const line of text.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue
      if (line.startsWith('+')) for (const name of namesIn(path, line.slice(1))) if (!added.has(name)) added.set(name, path)
      if (line.startsWith('-')) for (const name of namesIn(path, line.slice(1))) if (!removed.has(name)) removed.set(name, path)
    }
  }
  const keep = (name: string) => !BUILT_IN_VARS.has(name)
  return [
    ...[...added].filter(([name]) => !removed.has(name) && keep(name)).map(([name, file]) => ({ name, file, status: 'new' as const })),
    ...[...removed].filter(([name]) => !added.has(name) && keep(name)).map(([name, file]) => ({ name, file, status: 'removed' as const })),
  ]
}

function codeLines(text: string): string[] {
  return text.split('\n').filter(line => !/^\s*(#|\/\/)/.test(line))
}

function deployWorkflowMode(files: RepoFile[]): MigrationMode | null {
  const workflows = files
    .filter(file => file.path.startsWith('.github/workflows/') && WORKFLOW_CALL.test(file.text))
    .sort((a, b) => Number(b.path.includes('prod')) - Number(a.path.includes('prod')))
  const workflow = workflows[0]
  if (!workflow) return null
  const lines = workflow.text.split('\n')
  const at = lines.findIndex(line => WORKFLOW_CALL.test(line))
  const condition = lines.slice(Math.max(0, at - 3), at).join('\n').match(/inputs\.([\w-]+)/)
  const name = workflow.path.split('/').pop()!
  const isManual = /workflow_dispatch/.test(workflow.text)
  const text = condition
    ? `${isManual ? 'By hand: ' : ''}run the ${name} workflow with ${condition[1]} checked`
    : `They run in the ${name} workflow`
  const command = isManual ? `gh workflow run ${name}${condition ? ` -f ${condition[1]}=true` : ''}` : null
  return { kind: isManual ? 'manual' : 'auto', text, source: workflow.path, command }
}

export function migrationMode(repo: string, files: RepoFile[], corrections: Corrections): MigrationMode {
  const declared = corrections.migrations?.[repo]
  if (declared) return { kind: 'declared', text: declared, source: 'corrections.json' }

  const code = files.filter(file => file.path.endsWith('.go') && !TEST_FILE.test(file.path))
  const flag = code.find(file => codeLines(file.text).some(line => line.includes('RUN_MIGRATIONS')))
  if (flag) return { kind: 'flag', text: 'They run on startup; RUN_MIGRATIONS=false turns them off', source: flag.path }

  const workflow = deployWorkflowMode(files)
  if (workflow) return workflow

  const startup = files.find(file => STARTUP_FILE.test(file.path) && codeLines(file.text).some(line => MIGRATE_UP.test(line)))
  if (startup) {
    // A log line ("echo migrating ... up") names no command.
    const line = codeLines(startup.text).find(l => MIGRATE_UP.test(l) && !/^\s*(echo|printf)\b/.test(l))
    return { kind: 'auto', text: 'They run when the service starts', source: startup.path, command: (line && /\S*migrate\b.*?\bup\b/.exec(line)?.[0]) || null }
  }

  const inCode = code.find(file => codeLines(file.text).some(line => IN_CODE.test(line)))
  if (inCode) return { kind: 'auto', text: 'The app runs them from its code on startup', source: inCode.path }

  const script = files.find(file => /(^|\/)scripts\/[^/]*migrat[^/]*$/.test(file.path) && /\bmigrations\b/.test(file.text))
  if (script) {
    return { kind: 'unknown', text: `Unknown whether the deploy runs them: there is a script in ${script.path}`, source: script.path, command: script.path.endsWith('.sh') ? `sh ${script.path}` : script.path }
  }
  const named = namedCommand(files)
  if (named) return { kind: 'unknown', text: `Unknown whether the deploy runs them: ${named.source} has a migrate command`, source: named.source, command: named.command }
  return { kind: 'unknown', text: 'Not detected: add it in corrections.json', source: null }
}

/** A Makefile target or package.json script whose name says it migrates. */
function namedCommand(files: RepoFile[]): { command: string; source: string } | null {
  for (const file of files) {
    if (/(^|\/)[Mm]akefile$/.test(file.path)) {
      const target = /^([\w-]*migrat[\w-]*(?:-up)?)\s*:/m.exec(file.text)
      if (target) return { command: `make ${target[1]}`, source: file.path }
    }
    if (/(^|\/)package\.json$/.test(file.path)) {
      try {
        const scripts = (JSON.parse(file.text) as { scripts?: Record<string, unknown> }).scripts ?? {}
        const name = Object.keys(scripts).find(key => /migrat/i.test(key) && !/(down|rollback|create|new|make|gen)/i.test(key))
        if (name) return { command: `npm run ${name}`, source: file.path }
      } catch {}
    }
  }
  return null
}

// TODO(@SebastianLuser, 2026-10-28): a monorepo with Railway and Vercel apps gets Railway for every variable; match the file's app folder.
export function loadTarget(name: string, repo: string, files: RepoFile[], corrections: Corrections): string | null {
  const declared = corrections.targets?.[repo]
  if (declared) return declared
  const inWorkflow = files.some(
    file => file.path.startsWith('.github/workflows/') && new RegExp(`\\b(secrets|vars)\\.${name}\\b`).test(file.text),
  )
  if (inWorkflow) return 'GitHub (secrets)'
  if (files.some(file => /(^|\/)railway\.(json|toml)$/.test(file.path))) return 'Railway'
  if (files.some(file => /(^|\/)vercel\.json$/.test(file.path))) return 'Vercel'
  return null
}

export function buildReport(input: ReportInput): Report {
  const migrations = changedFiles(input.nameStatus)
    .map(file => file.path)
    .filter(isMigration)
  const tables = new Map<string, TableChange>()
  let skipped = 0
  for (const { path, text } of input.migrationTexts) {
    if (!isMigration(path)) continue
    const changes = tableChanges(text)
    skipped += changes.skipped
    for (const change of changes.tables) {
      const known = tables.get(change.table)
      tables.set(
        change.table,
        known
          ? {
              ...known,
              isNew: known.isNew || change.isNew,
              isDropped: change.isDropped,
              added: [...known.added, ...change.added],
              dropped: [...known.dropped, ...change.dropped],
              renamed: [...known.renamed, ...change.renamed],
              foreignKeys: [...known.foreignKeys, ...change.foreignKeys],
              ...(known.retyped || change.retyped ? { retyped: [...(known.retyped ?? []), ...(change.retyped ?? [])] } : {}),
            }
          : change,
      )
    }
  }
  if (input.earlierMigrations) {
    const before = schemaOf(inRunOrder(input.earlierMigrations).map(file => file.text))
    for (const table of tables.values()) table.before = table.isNew ? null : (before.get(table.table) ?? null)
  }
  const envs = environmentsOf(input.repoFiles, input.trackedPaths)
  const stillUsed = new Set(input.stillUsed ?? [])
  const vars: NewVar[] = newVars(input.patches)
    .filter(found => found.status === 'new' || !stillUsed.has(found.name))
    .map(found => {
      const uses = found.status === 'new' ? usesOf(found.name, input.patches) : []
      const v = {
        ...found,
        target: loadTarget(found.name, input.repo, input.repoFiles, input.corrections),
        uses,
        fallback: fallbackOf(found.name, uses),
        examples: examplesOf(uses),
        envs: envsFor(found.name, input.repoFiles, input.trackedPaths, envs),
      }
      return { ...v, command: commandsFor(v, v.envs) }
    })
  const tracked = new Set(input.trackedPaths)
  const risks: Risk[] = input.migrationTexts
    .filter(({ path }) => isMigration(path))
    .flatMap(({ path, text }) => {
      const file = path.split('/').pop()!
      const found: Risk[] = migrationRisks(text).map(risk => ({ ...risk, file }))
      if (!tracked.has(downPath(path)) && !IN_FILE_DOWN.test(text)) {
        found.push({ file, level: 'medium', text: 'No down migration: rolling back needs a fix by hand' })
      }
      return found
    })
    .sort((a, b) => Number(b.level === 'high') - Number(a.level === 'high'))
  const details: MigrationInfo[] = input.migrationTexts
    .filter(({ path }) => isMigration(path))
    .map(({ path, text }) => ({ path, summary: summaryOf(text), hasDown: tracked.has(downPath(path)) || IN_FILE_DOWN.test(text), sql: text.slice(0, 6000) }))
  return {
    repo: input.repo,
    branch: input.branch,
    base: input.base,
    migrations,
    mode: migrations.length > 0 ? migrationMode(input.repo, input.repoFiles, input.corrections) : null,
    vars,
    tables: [...tables.values()],
    skipped,
    risks,
    consumers: migrations.length > 0 ? input.consumers : input.consumers.filter(c => c.kind === 'http'),
    info: input.info,
    envs,
    details,
  }
}

/** What a migration does, one plain sentence per change. */
export function summaryOf(sql: string): string[] {
  const { tables, skipped } = tableChanges(sql)
  const lines: string[] = []
  for (const t of tables) {
    if (t.isDropped) {
      lines.push(`Drops table ${t.table}`)
      continue
    }
    if (t.isNew) lines.push(`Creates table ${t.table} with ${plural(t.added.length, 'column')}`)
    else for (const c of t.added) lines.push(`Adds ${c.name}${c.type ? ` (${c.type})` : ''} to ${t.table}`)
    for (const c of t.dropped) lines.push(`Drops ${c} from ${t.table}`)
    for (const r of t.renamed) lines.push(`Renames ${t.table}.${r.from} to ${r.to}`)
    for (const c of t.retyped ?? []) lines.push(`Changes ${t.table}.${c.name} to ${c.type}`)
    for (const fk of t.foreignKeys) lines.push(`Links ${t.table}.${fk.column} to ${fk.table}`)
  }
  if (skipped > 0) lines.push(`${plural(skipped, 'other statement')} (indexes, data, functions)`)
  return lines
}

// goose and dbmate keep the down part inside the same file.
const IN_FILE_DOWN = /\+goose\s+Down|migrate:down/i

function downPath(path: string): string {
  return /\.up\.sql$/i.test(path) ? path.replace(/\.up\.sql$/i, '.down.sql') : path.replace(/\.sql$/i, '.down.sql')
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** The runbook in the order it is done: push, back up, variables, migrations, deploy, then checks. */
export function deploySteps(report: Report): Step[] {
  const steps: Step[] = []
  const { unpushed } = report.info
  if (unpushed !== 0) {
    steps.push({
      id: 'push',
      text: `Push ${report.branch}`,
      detail: unpushed === null ? 'it has no upstream yet' : `${plural(unpushed, 'commit')} not pushed`,
      command: unpushed === null ? `git push -u origin ${report.branch}` : 'git push',
    })
  }
  if (report.risks.some(risk => risk.level === 'high')) {
    const touched = report.tables.filter(t => !t.isNew).map(t => t.table)
    steps.push({
      id: 'backup',
      text: 'Back up the tables the migrations touch',
      detail: 'a migration drops or rewrites data',
      command: touched.length > 0 ? `pg_dump "$DATABASE_URL" ${touched.map(t => `-t ${t}`).join(' ')} -f backup-${report.branch.replace(/[^\w-]+/g, '-')}.sql` : null,
    })
  }
  const where = (v: NewVar) => `${v.target ? ` in ${v.target}` : ''}${v.envs?.length ? ` (${v.envs.join(', ')})` : ''}`
  for (const found of report.vars.filter(v => v.status !== 'removed')) {
    const need = found.fallback != null ? `optional: falls back to "${found.fallback}"` : 'required: the code has no fallback'
    const detail = found.target ? need : `${need} · where to load it is not detected`
    steps.push({ id: `var:${found.name}`, text: `Load ${found.name}${where(found)}`, detail, command: found.command ?? null })
  }
  const mode = report.mode
  const isByHand = mode?.kind === 'manual' || mode?.kind === 'unknown'
  const count = plural(report.migrations.length, 'migration')
  if (mode && isByHand) steps.push({ id: 'migrate', text: `Apply ${count} before deploying`, detail: mode.text, command: mode.command ?? null })
  steps.push({ id: 'deploy', text: `Deploy ${report.branch}`, detail: null })
  if (mode && !isByHand) steps.push({ id: 'migrate', text: `Check the ${count} ran`, detail: mode.text })
  for (const gone of report.vars.filter(v => v.status === 'removed')) {
    steps.push({ id: `rm:${gone.name}`, text: `Delete ${gone.name}${where(gone)}`, detail: 'nothing reads it after this deploy', command: gone.command ?? null })
  }
  for (const consumer of report.consumers) {
    steps.push({
      id: `check:${consumer.repo}`,
      text: `Check ${consumer.repo} still works`,
      detail: consumer.kind === 'db' ? `it reads this database (${consumer.file})` : `it calls this service (${consumer.file})`,
    })
  }
  return steps
}
