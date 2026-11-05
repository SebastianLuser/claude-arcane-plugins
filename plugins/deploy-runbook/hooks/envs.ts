import type { NewVar, VarUse } from '../types'
import type { RepoFile } from './detect'

// Names that are not a deploy environment, as in `.env.local` or `.env.test.example`.
const NOT_ENVS = new Set(['example', 'sample', 'template', 'local', 'test', 'tests', 'ci', 'defaults', 'default', 'dist'])
const ALIASES: Record<string, string> = { prod: 'production', prd: 'production', stg: 'staging', stage: 'staging', dev: 'development', develop: 'development' }
const ORDER = ['development', 'qa', 'staging', 'preview', 'production']

const envName = (raw: string): string | null => {
  const name = raw.trim().toLowerCase().replace(/^['"]|['"]$/g, '')
  if (!/^[a-z][\w-]*$/.test(name) || NOT_ENVS.has(name)) return null
  return ALIASES[name] ?? name
}

const byOrder = (a: string, b: string) => {
  const at = (n: string) => (ORDER.includes(n) ? ORDER.indexOf(n) : ORDER.length)
  return at(a) - at(b) || a.localeCompare(b)
}

/** Environment names a workflow's jobs deploy to: `environment: x` or `environment:\n  name: x`. */
function workflowEnvs(text: string): string[] {
  const found: string[] = []
  for (const m of text.matchAll(/^\s*environment:\s*([^\s#{][^\s#]*)\s*$/gm)) found.push(m[1]!)
  for (const m of text.matchAll(/^\s*environment:\s*\n\s+name:\s*([^\s#{][^\s#]*)/gm)) found.push(m[1]!)
  return found.map(envName).filter((n): n is string => n !== null)
}

/** `.env.staging.example` → staging. */
const exampleEnv = (path: string): string | null => {
  const m = /(?:^|\/)\.env\.([\w-]+)\.(?:example|sample|template)$/i.exec(path)
  return m ? envName(m[1]!) : null
}

const railwayEnvs = (text: string): string[] => {
  try {
    const parsed = JSON.parse(text) as { environments?: Record<string, unknown> }
    return Object.keys(parsed.environments ?? {}).map(envName).filter((n): n is string => n !== null)
  } catch {
    return []
  }
}

/** The environments the repo deploys to, read from its workflows, its per-environment examples and railway.json. */
export function environmentsOf(files: RepoFile[], trackedPaths: string[]): string[] {
  const found = new Set<string>()
  for (const file of files) {
    if (file.path.startsWith('.github/workflows/')) workflowEnvs(file.text).forEach(n => found.add(n))
    if (/(^|\/)railway\.json$/.test(file.path)) railwayEnvs(file.text).forEach(n => found.add(n))
  }
  for (const path of trackedPaths) {
    const name = exampleEnv(path)
    if (name) found.add(name)
  }
  return [...found].sort(byOrder)
}

const EXAMPLE_FILE = /\.env(\.[\w-]+)*\.(example|sample|template)$/i
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** Each line the patch adds that names `name`, with its line number in the new file. */
export function usesOf(name: string, patches: RepoFile[]): VarUse[] {
  const word = new RegExp(`\\b${name}\\b`)
  const uses: VarUse[] = []
  for (const { path, text } of patches) {
    let line: number | null = null
    for (const row of text.split('\n')) {
      const hunk = HUNK.exec(row)
      if (hunk) {
        line = Number(hunk[1])
        continue
      }
      if (row.startsWith('+++') || row.startsWith('---')) continue
      if (row.startsWith('+')) {
        // An example env file's value is never kept: only that it lists the name.
        if (word.test(row)) uses.push({ file: path, line, code: EXAMPLE_FILE.test(path) ? `${name}=…` : row.slice(1).trim().slice(0, 160) })
        if (line !== null) line += 1
      }
    }
  }
  return uses
}

const FALLBACKS = (name: string): RegExp[] => [
  new RegExp(`getEnv\\(\\s*"${name}"\\s*,\\s*"([^"]*)"`),
  new RegExp(`\\b${name}\\b['"\\]]*\\s*(?:\\?\\?|\\|\\|)\\s*(['"\`])(.*?)\\1`),
  new RegExp(`\\b${name}\\b['"\\]]*\\s*(?:\\?\\?|\\|\\|)\\s*(-?\\d+(?:\\.\\d+)?|true|false)\\b`),
]

/** The value the code falls back to when the variable is unset, read from the lines that use it. */
export function fallbackOf(name: string, uses: VarUse[]): string | null {
  for (const use of uses) {
    if (EXAMPLE_FILE.test(use.file)) continue
    for (const pattern of FALLBACKS(name)) {
      const m = pattern.exec(use.code)
      if (m) return m[2] ?? m[1] ?? null
    }
  }
  return null
}

/** The example env files that list it. */
export const examplesOf = (uses: VarUse[]): string[] => [...new Set(uses.filter(u => EXAMPLE_FILE.test(u.file)).map(u => u.file))]

/** The environments to load it in: those whose workflow or example file names it, else all. */
export function envsFor(name: string, files: RepoFile[], trackedPaths: string[], envs: string[]): string[] {
  const word = new RegExp(`\\b${name}\\b`)
  const found = new Set<string>()
  for (const file of files) {
    if (file.path.startsWith('.github/workflows/') && word.test(file.text)) workflowEnvs(file.text).forEach(n => found.add(n))
    const example = exampleEnv(file.path)
    if (example && word.test(file.text)) found.add(example)
  }
  return found.size > 0 ? [...found].sort(byOrder) : envs
}

const VERCEL_ENV: Record<string, string> = { staging: 'preview', qa: 'preview', preview: 'preview', development: 'development', production: 'production' }
/** Shell commands that load (or delete) the variable where it lives, one per environment; the value is left for the person. */
export function commandsFor(v: Pick<NewVar, 'name' | 'target' | 'status'>, envs: string[]): string | null {
  const target = v.target?.toLowerCase() ?? ''
  const isRemoved = v.status === 'removed'
  const value = `"${v.name}=..."`
  const each = (make: (env: string | null) => string | null) => {
    const lines = (envs.length > 0 ? envs : [null]).map(make).filter((l): l is string => l !== null)
    return lines.length > 0 ? [...new Set(lines)].join('\n') : null
  }
  if (target.startsWith('railway')) {
    // shortcut: the Railway CLI has no delete flag we can rely on; a removed variable gets no command.
    if (isRemoved) return null
    return each(env => `railway variables --set ${value}${env ? ` --environment ${env}` : ''}`)
  }
  if (target.startsWith('vercel')) {
    return each(env => {
      const scope = env ? (VERCEL_ENV[env] ?? null) : 'production'
      if (!scope) return null
      return isRemoved ? `vercel env rm ${v.name} ${scope} --yes` : `vercel env add ${v.name} ${scope}`
    })
  }
  if (target.startsWith('github')) {
    return each(env => (isRemoved ? `gh secret delete ${v.name}${env ? ` --env ${env}` : ''}` : `gh secret set ${v.name}${env ? ` --env ${env}` : ''}`))
  }
  return null
}
