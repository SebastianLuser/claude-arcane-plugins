import type { Edge, EdgeKind, Graph, Impact, Trigger } from '../types'

const KIND_ORDER: EdgeKind[] = ['db', 'http', 'lib']

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

export function classify(relPath: string): Trigger | null {
  const path = normalize(relPath)
  const name = path.split('/').pop() ?? ''
  if (/(^|\/)migrations\//.test(path)) return 'migration'
  if (/^CONTRATO.*\.md$/i.test(name) || /^(openapi|swagger).*\.ya?ml$/i.test(name)) return 'contract'
  if (/(^|\/)src\/entrypoints\/rest\//.test(path) || /(^|\/)routes?\//.test(path)) return 'handler'
  if (/(^|\/)config\/config\.go$/.test(path) || /^\.env\.example$/.test(name) || /^railway\.(json|toml)$/.test(name) || /\.tf$/.test(name)) {
    return 'config'
  }
  return null
}

/** Matches case-insensitively, as Windows paths do, and returns the repo as the scan spelled it. */
export function locate(file: string, root: string, repos: string[]): { repo: string; rel: string } | null {
  const path = normalize(file)
  const base = normalize(root)
  if (!path.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return null
  const [first, ...rest] = path.slice(base.length + 1).split('/')
  const repo = repos.find(name => name.toLowerCase() === first?.toLowerCase())
  return repo && rest.length > 0 ? { repo, rel: rest.join('/') } : null
}

export function impact(graph: Graph, repo: string, file: string, trigger: Trigger): Impact | null {
  const edges = graph.edges.filter(edge => {
    if (trigger === 'migration') return edge.to === repo && edge.kind === 'db'
    if (trigger === 'config') return edge.from === repo && edge.kind !== 'lib'
    return edge.to === repo && edge.kind === 'http'
  })
  if (edges.length === 0) return null
  const sorted = [...edges].sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || otherEnd(a, repo).localeCompare(otherEnd(b, repo)),
  )
  return { repo, file, trigger, edges: sorted }
}

export function otherEnd(edge: Edge, repo: string): string {
  return edge.from === repo ? edge.to : edge.from
}
