import type { Edge, EdgeKind, Graph } from '../types'

export type Corrections = {
  ignore?: string[]
  tokens?: Record<string, string>
  vars?: Record<string, Record<string, string>>
  external?: Record<string, string>
}

export type FsEntry = { name: string; kind: 'file' | 'dir' | 'other'; size: number }

export type Fs = {
  list: (path: string) => Promise<FsEntry[]>
  read: (path: string) => Promise<string>
}

const URL_VAR = /\b[A-Z][A-Z0-9_]*_URL\b/g
const GO_MOD_LIB = /github\.com\/educabot\/([A-Za-z0-9._-]+)/g
const NPM_LIB = /"@educabot\/([a-z0-9._-]+)"\s*:/g
const PREFIXES = ['VITE_', 'NEXT_PUBLIC_', 'REACT_APP_']
const SUFFIXES: [string, EdgeKind][] = [
  ['_DATABASE_URL', 'db'],
  ['_DB_URL', 'db'],
  ['_API_BASE_URL', 'http'],
  ['_API_URL', 'http'],
  ['_BASE_URL', 'http'],
  ['_URL', 'http'],
]
const GENERIC_WORDS = new Set([
  'ai', 'api', 'app', 'b2b', 'be', 'cms', 'core', 'demos', 'fe', 'infra', 'service', 'web', 'webapp', 'widget',
])
const PRUNED_DIRS = new Set([
  '__mocks__', '__tests__', 'build', 'coverage', 'dist', 'docs', 'e2e', 'fixtures', 'mocks',
  'node_modules', 'out', 'storybook-static', 'test', 'testdata', 'tests', 'tmp', 'vendor', 'worktrees',
])
const ALWAYS_READ = new Set(['go.mod', 'package.json', 'railway.json', 'railway.toml'])
const CODE_FILE = /\.(go|ts|tsx|js|jsx|mjs|cjs|ya?ml|toml|tf)$/i
const SKIPPED_FILE = /(_test\.go|\.(test|spec)\.[cm]?[jt]sx?|\.min\.js|-lock\.ya?ml|\.lock)$/i
const ENV_FILE = /^\.env(\..+)?$/i
const ENV_TEMPLATE = /^\.env\.example$/i
const MAX_FILE_BYTES = 200_000
const MAX_DEPTH = 5
const READ_BATCH = 16

export function shouldEnterDir(name: string): boolean {
  return !name.startsWith('.') && !PRUNED_DIRS.has(name.toLowerCase())
}

/** Reads `.env.example` only, never real .env files: they hold secrets. */
export function shouldReadFile(name: string, size: number): boolean {
  if (size > MAX_FILE_BYTES) return false
  if (ENV_FILE.test(name)) return ENV_TEMPLATE.test(name)
  if (ALWAYS_READ.has(name)) return true
  return CODE_FILE.test(name) && !SKIPPED_FILE.test(name)
}

function stripPrefix(name: string): string {
  const prefix = PREFIXES.find(p => name.startsWith(p))
  return prefix ? name.slice(prefix.length) : name
}

function splitVar(name: string): { token: string; kind: EdgeKind } | null {
  for (const [suffix, kind] of SUFFIXES) {
    if (name.endsWith(suffix)) {
      const token = name.slice(0, -suffix.length)
      return token ? { token, kind } : null
    }
  }
  return null
}

function kindOf(name: string): EdgeKind {
  return SUFFIXES.find(([suffix]) => name.endsWith(suffix))?.[1] ?? 'http'
}

export function buildKeyIndex(repos: string[]): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const repo of repos) {
    const words = repo.toLowerCase().split('-')
    for (let start = 0; start < words.length; start++) {
      for (let end = start + 1; end <= words.length; end++) {
        const part = words.slice(start, end)
        if (part.every(word => GENERIC_WORDS.has(word))) continue
        const key = part.join('_')
        const owners = index.get(key) ?? []
        if (!owners.includes(repo)) index.set(key, [...owners, repo])
      }
    }
  }
  return index
}

/** Drops trailing words until a key matches, so TICH_CRONOS_TRACES finds tich-cronos. */
export function matchToken(token: string, index: Map<string, string[]>): string | null {
  const words = token.toLowerCase().split('_')
  for (let end = words.length; end > 0; end--) {
    const owners = index.get(words.slice(0, end).join('_'))
    if (owners) return owners.length === 1 ? owners[0]! : null
  }
  return null
}

export function edgesFromText(
  repo: string,
  text: string,
  index: Map<string, string[]>,
  corrections: Corrections,
): Edge[] {
  const ignored = new Set(corrections.ignore ?? [])
  const edges: Edge[] = []
  for (const raw of new Set(text.match(URL_VAR) ?? [])) {
    const name = stripPrefix(raw)
    if (ignored.has(raw) || ignored.has(name)) continue
    const alias = corrections.vars?.[repo]?.[name]
    if (alias) {
      edges.push({ from: repo, to: alias, kind: kindOf(name), via: raw })
      continue
    }
    const parts = splitVar(name)
    if (!parts) continue
    const target = corrections.tokens?.[parts.token] ?? matchToken(parts.token, index)
    if (target) {
      edges.push({ from: repo, to: target, kind: parts.kind, via: raw })
      continue
    }
    const external = corrections.external?.[parts.token]
    if (external) edges.push({ from: repo, to: external, kind: parts.kind, via: raw, isExternal: true })
  }
  return edges.filter(edge => edge.to !== repo)
}

export function libEdges(repo: string, fileName: string, text: string, repos: string[]): Edge[] {
  const pattern = fileName === 'go.mod' ? GO_MOD_LIB : fileName === 'package.json' ? NPM_LIB : null
  if (!pattern) return []
  const names = new Set([...text.matchAll(pattern)].map(match => match[1]!))
  return [...names]
    .filter(name => name !== repo && repos.includes(name))
    .map(name => ({ from: repo, to: name, kind: 'lib' as const, via: fileName }))
}

export function dedupe(edges: Edge[]): Edge[] {
  const byKey = new Map<string, Edge>()
  for (const edge of edges) {
    const key = `${edge.from}|${edge.to}|${edge.kind}`
    const known = byKey.get(key)
    if (!known) byKey.set(key, edge)
    else if (!known.via.split(', ').includes(edge.via) && known.via.split(', ').length < 2) {
      byKey.set(key, { ...known, via: `${known.via}, ${edge.via}` })
    }
  }
  return [...byKey.values()]
}

async function listRepos(fs: Fs, root: string): Promise<string[]> {
  const repos: string[] = []
  for (const entry of await fs.list(root)) {
    if (entry.kind !== 'dir' || entry.name.startsWith('_') || entry.name.startsWith('.')) continue
    const children = await fs.list(`${root}/${entry.name}`).catch(() => [])
    if (children.some(child => child.name === '.git')) repos.push(entry.name)
  }
  return repos.sort()
}

async function filesOf(fs: Fs, dir: string): Promise<{ path: string; name: string }[]> {
  const files: { path: string; name: string }[] = []
  let level = [dir]
  for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth++) {
    const next: string[] = []
    for (const current of level) {
      for (const entry of await fs.list(current).catch(() => [])) {
        const path = `${current}/${entry.name}`
        if (entry.kind === 'dir' && shouldEnterDir(entry.name)) next.push(path)
        else if (entry.kind === 'file' && shouldReadFile(entry.name, entry.size)) files.push({ path, name: entry.name })
      }
    }
    level = next
  }
  return files
}

export async function scanAll(fs: Fs, root: string, corrections: Corrections, now: number): Promise<Graph> {
  const repos = await listRepos(fs, root)
  const index = buildKeyIndex(repos)
  const edges: Edge[] = []
  for (const repo of repos) {
    const files = await filesOf(fs, `${root}/${repo}`)
    for (let i = 0; i < files.length; i += READ_BATCH) {
      const batch = files.slice(i, i + READ_BATCH)
      const texts = await Promise.all(batch.map(file => fs.read(file.path).catch(() => '')))
      batch.forEach((file, j) => {
        const text = texts[j] ?? ''
        edges.push(...libEdges(repo, file.name, text, repos), ...edgesFromText(repo, text, index, corrections))
      })
    }
  }
  return { repos, edges: dedupe(edges), scannedAt: now }
}
