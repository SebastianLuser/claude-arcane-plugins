import { describe, expect, test } from 'claude-code/testing'

import { classify, impact, locate } from '../hooks/classify'
import { scanAll, shouldReadFile } from '../hooks/scan'
import type { Corrections, Fs, FsEntry } from '../hooks/scan'
import type { Edge, Graph } from '../types'

const ROOT = '/r'

const TREE: Record<string, string> = {
  'tich-cronos/.git/HEAD': '',
  'tich-cronos/config/config.go': 'os.Getenv("CONTENT_GENERATOR_URL")',
  'tich-cronos/.env': 'CRONOS_DATABASE_URL=postgres://user:secret@host/db',
  'tich-cronos/.env.local': 'TALENTO_API_URL=https://secret',
  'tich-cronos/.env.example': 'DB_URL=',
  'tich-cronos/node_modules/pkg/index.js': 'TALENTO_API_URL',
  'tich-cronos/.claude/worktrees/x/config.go': 'CAMPUS_BASE_URL',
  'tich-cronos/src/config_test.go': 'TALENTO_API_URL',
  'ai-content-generator/.git/HEAD': '',
  'ai-content-generator/config/config.go': 'os.Getenv("CRONOS_DATABASE_URL") os.Getenv("LLM_OPENAI_URL")',
  'campus-api/.git/HEAD': '',
  'campus-api/config/config.go': 'CRONOS_BASE_URL CAMPUS_BASE_URL',
  'talento-ia/.git/HEAD': '',
  'talento-ia/api/config.go': 'CRONOS_BASE_URL KAPSO_BASE_URL TUNI_URL',
  'tuni-ai-webapp/.git/HEAD': '',
  'tuni-ai-webapp/apps/tuni/src/env.ts':
    'import.meta.env.VITE_CRONOS_API_URL; import.meta.env.VITE_CAMPUS_API_URL; import.meta.env.VITE_HERMES_API_URL',
  'tuni-widget/.git/HEAD': '',
  'tuni-widget/src/env.ts': 'import.meta.env.VITE_CHAT_API_URL',
  'alizia-fe/.git/HEAD': '',
  'alizia-fe/src/config.ts': 'import.meta.env.VITE_AUTH_SERVICE_URL; import.meta.env.VITE_API_BASE_URL',
  'alizia-be/.git/HEAD': '',
  'alizia-be/go.mod': 'module github.com/educabot/alizia-be\nrequire github.com/educabot/team-ai-toolkit v1.8.0',
  'alizia-inclusion-be/.git/HEAD': '',
  'alizia-inclusion-be/go.mod': 'require github.com/educabot/team-ai-toolkit v1.8.0',
  'alizia-seguridad-be/.git/HEAD': '',
  'alizia-seguridad-be/go.mod': 'require github.com/educabot/team-ai-toolkit v1.8.0',
  'alizia-seguridad-be/config/config.go': 'KAPSO_BASE_URL PASSWORD_RESET_BASE_URL',
  'auth-service/.git/HEAD': '',
  'auth-service/go.mod': 'require github.com/educabot/team-ai-toolkit v1.8.0',
  'auth-service/src/errors.go': 'INET_E_INVALID_URL PASSWORD_RESET_URL',
  'team-ai-toolkit/.git/HEAD': '',
  'team-ai-toolkit/go.mod': 'module github.com/educabot/team-ai-toolkit',
  '_auth_wt/.git/HEAD': '',
  '_auth_wt/go.mod': 'require github.com/educabot/team-ai-toolkit v1.8.0',
}

const CORRECTIONS: Corrections = {
  ignore: [],
  tokens: { TUNI: 'tuni-ai-webapp' },
  vars: { 'alizia-fe': { API_BASE_URL: 'alizia-be' } },
  external: { HERMES: 'hermes', ODIN: 'odin' },
}

function fakeFs(tree: Record<string, string>): { fs: Fs; reads: string[] } {
  const reads: string[] = []
  const relOf = (path: string) => (path === ROOT ? '' : `${path.slice(ROOT.length + 1)}/`)
  const fs: Fs = {
    list: async path => {
      const prefix = relOf(path)
      const entries = new Map<string, FsEntry>()
      for (const [key, text] of Object.entries(tree)) {
        if (!key.startsWith(prefix)) continue
        const [name, ...rest] = key.slice(prefix.length).split('/')
        entries.set(name!, { name: name!, kind: rest.length > 0 ? 'dir' : 'file', size: text.length })
      }
      if (entries.size === 0) throw new Error(`ENOENT ${path}`)
      return [...entries.values()]
    },
    read: async path => {
      reads.push(path)
      const text = tree[path.slice(ROOT.length + 1)]
      if (text === undefined) throw new Error(`ENOENT ${path}`)
      return text
    },
  }
  return { fs, reads }
}

function has(graph: Graph, from: string, to: string, kind: Edge['kind']): boolean {
  return graph.edges.some(edge => edge.from === from && edge.to === to && edge.kind === kind)
}

describe('scanAll', () => {
  test('should find the real service links when scanning the repos', async () => {
    const { fs } = fakeFs(TREE)

    const graph = await scanAll(fs, ROOT, CORRECTIONS, 1)

    expect(has(graph, 'ai-content-generator', 'tich-cronos', 'db')).toBe(true)
    expect(has(graph, 'campus-api', 'tich-cronos', 'http')).toBe(true)
    expect(has(graph, 'talento-ia', 'tich-cronos', 'http')).toBe(true)
    expect(has(graph, 'tuni-ai-webapp', 'tich-cronos', 'http')).toBe(true)
    expect(has(graph, 'tuni-ai-webapp', 'campus-api', 'http')).toBe(true)
    expect(has(graph, 'alizia-fe', 'auth-service', 'http')).toBe(true)
    expect(has(graph, 'tich-cronos', 'ai-content-generator', 'http')).toBe(true)
    for (const repo of ['alizia-be', 'alizia-inclusion-be', 'alizia-seguridad-be', 'auth-service']) {
      expect(has(graph, repo, 'team-ai-toolkit', 'lib')).toBe(true)
    }
  })

  test('should not link anything when a var is external, generic or a Windows constant', async () => {
    const { fs } = fakeFs(TREE)

    const graph = await scanAll(fs, ROOT, CORRECTIONS, 1)

    const vias = graph.edges.flatMap(edge => edge.via.split(', '))
    for (const noise of ['PASSWORD_RESET_URL', 'KAPSO_BASE_URL', 'INET_E_INVALID_URL', 'LLM_OPENAI_URL', 'PASSWORD_RESET_BASE_URL', 'VITE_CHAT_API_URL']) {
      expect(vias.includes(noise)).toBe(false)
    }
    expect(graph.edges.some(edge => edge.from === edge.to)).toBe(false)
  })

  test('should skip pruned folders, test files and underscore folders when walking', async () => {
    const { fs } = fakeFs(TREE)

    const graph = await scanAll(fs, ROOT, CORRECTIONS, 1)

    expect(graph.repos.includes('_auth_wt')).toBe(false)
    expect(has(graph, 'tich-cronos', 'talento-ia', 'http')).toBe(false)
    expect(has(graph, 'tich-cronos', 'campus-api', 'http')).toBe(false)
  })

  test('should apply aliases and show not-cloned services only when corrections list them', async () => {
    const { fs } = fakeFs(TREE)

    const corrected = await scanAll(fs, ROOT, CORRECTIONS, 1)
    const raw = await scanAll(fs, ROOT, {}, 1)

    expect(has(corrected, 'alizia-fe', 'alizia-be', 'http')).toBe(true)
    expect(has(corrected, 'talento-ia', 'tuni-ai-webapp', 'http')).toBe(true)
    expect(corrected.edges.some(edge => edge.to === 'hermes' && edge.isExternal === true)).toBe(true)
    expect(has(raw, 'alizia-fe', 'alizia-be', 'http')).toBe(false)
    expect(raw.edges.some(edge => edge.to.startsWith('tuni'))).toBe(false)
    expect(raw.edges.some(edge => edge.to === 'hermes')).toBe(false)
  })

  test('should drop a link that would otherwise exist when its var is ignored', async () => {
    const { fs } = fakeFs(TREE)

    const kept = await scanAll(fs, ROOT, {}, 1)
    const ignored = await scanAll(fs, ROOT, { ignore: ['CRONOS_BASE_URL'] }, 1)

    expect(has(kept, 'campus-api', 'tich-cronos', 'http')).toBe(true)
    expect(has(ignored, 'campus-api', 'tich-cronos', 'http')).toBe(false)
    expect(has(ignored, 'tuni-ai-webapp', 'tich-cronos', 'http')).toBe(true)
  })

  test('should never read a real .env file when scanning', async () => {
    const { fs, reads } = fakeFs(TREE)

    const graph = await scanAll(fs, ROOT, CORRECTIONS, 1)

    expect(reads.some(path => /\/\.env$/.test(path))).toBe(false)
    expect(reads.some(path => path.endsWith('.env.local'))).toBe(false)
    expect(reads.includes('/r/tich-cronos/.env.example')).toBe(true)
    expect(JSON.stringify(graph).includes('secret')).toBe(false)
  })
})

describe('shouldReadFile', () => {
  test('should read only .env.example when the file is an env file', () => {
    expect(shouldReadFile('.env', 10)).toBe(false)
    expect(shouldReadFile('.env.production', 10)).toBe(false)
    expect(shouldReadFile('.env.template', 10)).toBe(false)
    expect(shouldReadFile('.env.sample', 10)).toBe(false)
    expect(shouldReadFile('.env.example', 10)).toBe(true)
    expect(shouldReadFile('config.go', 10)).toBe(true)
    expect(shouldReadFile('config.go', 300_000)).toBe(false)
    expect(shouldReadFile('package-lock.json', 10)).toBe(false)
  })
})

describe('classify', () => {
  test('should name the trigger when the path is a migration, contract, handler or config', () => {
    expect(classify('db/migrations/000042_add_col.up.sql')).toBe('migration')
    expect(classify('academic/packages/dbconn/migrations/0001.sql')).toBe('migration')
    expect(classify('CONTRATO-BACKEND.md')).toBe('contract')
    expect(classify('api/openapi.yaml')).toBe('contract')
    expect(classify('src/entrypoints/rest/teaching/handler.go')).toBe('handler')
    expect(classify('config/config.go')).toBe('config')
    expect(classify('.env.example')).toBe('config')
    expect(classify('modules/db/main.tf')).toBe('config')
  })

  test('should return null when the path is plain code or a real env file', () => {
    expect(classify('src/core/usecases/teaching/prompts.go')).toBe(null)
    expect(classify('.env')).toBe(null)
  })
})

describe('locate', () => {
  test('should find the repo and relative path when given a Windows path', () => {
    const found = locate('C:\\Users\\E\\repos\\Tich-Cronos\\db\\migrations\\x.sql', 'C:/Users/E/repos', ['tich-cronos'])

    expect(found).toEqual({ repo: 'tich-cronos', rel: 'db/migrations/x.sql' })
  })

  test('should return null when the file is outside the repos root', () => {
    expect(locate('C:/other/tich-cronos/a.go', 'C:/Users/E/repos', ['tich-cronos'])).toBe(null)
  })
})

describe('impact', () => {
  const GRAPH: Graph = {
    repos: ['ai-content-generator', 'campus-api', 'tich-cronos', 'tuni-ai-webapp'],
    edges: [
      { from: 'tuni-ai-webapp', to: 'tich-cronos', kind: 'http', via: 'VITE_CRONOS_API_URL' },
      { from: 'ai-content-generator', to: 'tich-cronos', kind: 'db', via: 'CRONOS_DATABASE_URL' },
      { from: 'campus-api', to: 'tich-cronos', kind: 'http', via: 'CRONOS_BASE_URL' },
      { from: 'tuni-ai-webapp', to: 'campus-api', kind: 'http', via: 'VITE_CAMPUS_API_URL' },
    ],
    scannedAt: 1,
  }

  test('should list the DB users when a migration is edited', () => {
    const found = impact(GRAPH, 'tich-cronos', 'db/migrations/1.sql', 'migration')

    expect(found?.edges.map(edge => edge.from)).toEqual(['ai-content-generator'])
  })

  test('should list the API consumers sorted when a handler is edited', () => {
    const found = impact(GRAPH, 'tich-cronos', 'src/entrypoints/rest/a.go', 'handler')

    expect(found?.edges.map(edge => edge.from)).toEqual(['campus-api', 'tuni-ai-webapp'])
  })

  test('should list what the repo uses when its config is edited', () => {
    const found = impact(GRAPH, 'tuni-ai-webapp', 'apps/tuni/.env.example', 'config')

    expect(found?.edges.map(edge => edge.to)).toEqual(['campus-api', 'tich-cronos'])
  })

  test('should return null when nobody depends on the repo', () => {
    expect(impact(GRAPH, 'ai-content-generator', 'db/migrations/1.sql', 'migration')).toBe(null)
  })
})
