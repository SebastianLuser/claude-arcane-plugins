import type { MigrationMode, NewVar, Report, TableChange } from '../types'
import { tableChanges } from './sql'

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
}

const ENV_FILE = /(^|\/)\.env(\.[^/]+)?$/i
const ENV_EXAMPLE = /(^|\/)\.env\.example$/i
const CODE_FILE = /\.(go|ts|tsx|js|jsx|mjs|cjs)$/i
const TEST_FILE = /(_test\.go|\.(test|spec)\.[cm]?[jt]sx?)$/i
const DEPLOY_FILE =
  /(^|\/)([\w.-]*entrypoint[\w.-]*\.sh|Dockerfile[\w.-]*|railway\.(json|toml)|Procfile|nixpacks\.toml|vercel\.json|[Mm]akefile)$|^\.github\/workflows\/[^/]+\.ya?ml$|(^|\/)scripts\/[^/]*migrat[^/]*$/
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

export function isDeployFile(path: string): boolean {
  return !path.startsWith('.claude/') && !ENV_FILE.test(path) && DEPLOY_FILE.test(path)
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

export function newVars(patches: RepoFile[]): { name: string; file: string }[] {
  const added = new Map<string, string>()
  const removed = new Set<string>()
  for (const { path, text } of patches) {
    if (!isPatchable(path)) continue
    for (const line of text.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue
      if (line.startsWith('+')) for (const name of namesIn(path, line.slice(1))) if (!added.has(name)) added.set(name, path)
      if (line.startsWith('-')) for (const name of namesIn(path, line.slice(1))) removed.add(name)
    }
  }
  return [...added]
    .filter(([name]) => !removed.has(name) && !BUILT_IN_VARS.has(name))
    .map(([name, file]) => ({ name, file }))
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
    ? `${isManual ? 'A mano: ' : ''}corré el workflow ${name} con ${condition[1]} marcado`
    : `Corren en el workflow ${name}`
  return { kind: isManual ? 'manual' : 'auto', text, source: workflow.path }
}

export function migrationMode(repo: string, files: RepoFile[], corrections: Corrections): MigrationMode {
  const declared = corrections.migrations?.[repo]
  if (declared) return { kind: 'declared', text: declared, source: 'correcciones.json' }

  const code = files.filter(file => file.path.endsWith('.go') && !TEST_FILE.test(file.path))
  const flag = code.find(file => codeLines(file.text).some(line => line.includes('RUN_MIGRATIONS')))
  if (flag) return { kind: 'flag', text: 'Corren solas al arrancar; se apagan con RUN_MIGRATIONS=false', source: flag.path }

  const workflow = deployWorkflowMode(files)
  if (workflow) return workflow

  const startup = files.find(file => STARTUP_FILE.test(file.path) && codeLines(file.text).some(line => MIGRATE_UP.test(line)))
  if (startup) return { kind: 'auto', text: 'Corren solas al arrancar el servicio', source: startup.path }

  const inCode = code.find(file => codeLines(file.text).some(line => IN_CODE.test(line)))
  if (inCode) return { kind: 'auto', text: 'Corren solas desde el código al arrancar la app', source: inCode.path }

  const script = files.find(file => /(^|\/)scripts\/[^/]*migrat[^/]*$/.test(file.path) && /\bmigrations\b/.test(file.text))
  if (script) {
    return { kind: 'unknown', text: `No sé si el deploy las corre: hay un script en ${script.path}`, source: script.path }
  }
  return { kind: 'unknown', text: 'No detectado: agregalo en correcciones.json', source: null }
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
            }
          : change,
      )
    }
  }
  const vars: NewVar[] = newVars(input.patches).map(found => ({
    ...found,
    target: loadTarget(found.name, input.repo, input.repoFiles, input.corrections),
  }))
  return {
    repo: input.repo,
    branch: input.branch,
    base: input.base,
    migrations,
    mode: migrations.length > 0 ? migrationMode(input.repo, input.repoFiles, input.corrections) : null,
    vars,
    tables: [...tables.values()],
    skipped,
  }
}
