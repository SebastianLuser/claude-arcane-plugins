import { describe, expect, test } from 'claude-code/testing'

import { classify, impact, locate } from '../hooks/classify'
import { libEdges, scanAll, shouldReadFile } from '../hooks/scan'
import type { Corrections, Fs, FsEntry } from '../hooks/scan'
import type { Edge, Graph } from '../types'

const ROOT = '/r'

const TREE: Record<string, string> = {
  'shop-orders/.git/HEAD': '',
  'shop-orders/config/config.go': 'os.Getenv("REPORT_GENERATOR_URL")',
  'shop-orders/.env': 'ORDERS_DATABASE_URL=postgres://user:secret@host/db',
  'shop-orders/.env.local': 'HIRING_API_URL=https://secret',
  'shop-orders/.env.example': 'DB_URL=',
  'shop-orders/node_modules/pkg/index.js': 'HIRING_API_URL',
  'shop-orders/.claude/worktrees/x/config.go': 'BILLING_BASE_URL',
  'shop-orders/src/config_test.go': 'HIRING_API_URL',
  'ai-report-generator/.git/HEAD': '',
  'ai-report-generator/config/config.go': 'os.Getenv("ORDERS_DATABASE_URL") os.Getenv("LLM_OPENAI_URL")',
  'billing-api/.git/HEAD': '',
  'billing-api/config/config.go': 'ORDERS_BASE_URL BILLING_BASE_URL',
  'hiring-hub/.git/HEAD': '',
  'hiring-hub/api/config.go': 'ORDERS_BASE_URL KAPSO_BASE_URL KIOSK_URL',
  'kiosk-ai-webapp/.git/HEAD': '',
  'kiosk-ai-webapp/apps/kiosk/src/env.ts':
    'import.meta.env.VITE_ORDERS_API_URL; import.meta.env.VITE_BILLING_API_URL; import.meta.env.VITE_MAILER_API_URL',
  'kiosk-widget/.git/HEAD': '',
  'kiosk-widget/src/env.ts': 'import.meta.env.VITE_CHAT_API_URL',
  'store-fe/.git/HEAD': '',
  'store-fe/src/config.ts': 'import.meta.env.VITE_AUTH_SERVICE_URL; import.meta.env.VITE_API_BASE_URL',
  'store-be/.git/HEAD': '',
  'store-be/go.mod': 'module github.com/acme/store-be\nrequire github.com/acme/shared-ai-toolkit v1.8.0',
  'store-catalog-be/.git/HEAD': '',
  'store-catalog-be/go.mod': 'require github.com/acme/shared-ai-toolkit v1.8.0',
  'store-security-be/.git/HEAD': '',
  'store-security-be/go.mod': 'require github.com/acme/shared-ai-toolkit v1.8.0',
  'store-security-be/config/config.go': 'KAPSO_BASE_URL PASSWORD_RESET_BASE_URL',
  'auth-service/.git/HEAD': '',
  'auth-service/go.mod': 'require github.com/acme/shared-ai-toolkit v1.8.0',
  'auth-service/src/errors.go': 'INET_E_INVALID_URL PASSWORD_RESET_URL',
  'shared-ai-toolkit/.git/HEAD': '',
  'shared-ai-toolkit/go.mod': 'module github.com/acme/shared-ai-toolkit',
  '_auth_wt/.git/HEAD': '',
  '_auth_wt/go.mod': 'require github.com/acme/shared-ai-toolkit v1.8.0',
}

const CORRECTIONS: Corrections = {
  ignore: [],
  tokens: { KIOSK: 'kiosk-ai-webapp' },
  vars: { 'store-fe': { API_BASE_URL: 'store-be' } },
  external: { MAILER: 'mailer', LEDGER: 'ledger' },
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

    expect(has(graph, 'ai-report-generator', 'shop-orders', 'db')).toBe(true)
    expect(has(graph, 'billing-api', 'shop-orders', 'http')).toBe(true)
    expect(has(graph, 'hiring-hub', 'shop-orders', 'http')).toBe(true)
    expect(has(graph, 'kiosk-ai-webapp', 'shop-orders', 'http')).toBe(true)
    expect(has(graph, 'kiosk-ai-webapp', 'billing-api', 'http')).toBe(true)
    expect(has(graph, 'store-fe', 'auth-service', 'http')).toBe(true)
    expect(has(graph, 'shop-orders', 'ai-report-generator', 'http')).toBe(true)
    for (const repo of ['store-be', 'store-catalog-be', 'store-security-be', 'auth-service']) {
      expect(has(graph, repo, 'shared-ai-toolkit', 'lib')).toBe(true)
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
    expect(has(graph, 'shop-orders', 'hiring-hub', 'http')).toBe(false)
    expect(has(graph, 'shop-orders', 'billing-api', 'http')).toBe(false)
  })

  test('should apply aliases and show not-cloned services only when corrections list them', async () => {
    const { fs } = fakeFs(TREE)

    const corrected = await scanAll(fs, ROOT, CORRECTIONS, 1)
    const raw = await scanAll(fs, ROOT, {}, 1)

    expect(has(corrected, 'store-fe', 'store-be', 'http')).toBe(true)
    expect(has(corrected, 'hiring-hub', 'kiosk-ai-webapp', 'http')).toBe(true)
    expect(corrected.edges.some(edge => edge.to === 'mailer' && edge.isExternal === true)).toBe(true)
    expect(has(raw, 'store-fe', 'store-be', 'http')).toBe(false)
    expect(raw.edges.some(edge => edge.to.startsWith('kiosk'))).toBe(false)
    expect(raw.edges.some(edge => edge.to === 'mailer')).toBe(false)
  })

  test('should drop a link that would otherwise exist when its var is ignored', async () => {
    const { fs } = fakeFs(TREE)

    const kept = await scanAll(fs, ROOT, {}, 1)
    const ignored = await scanAll(fs, ROOT, { ignore: ['ORDERS_BASE_URL'] }, 1)

    expect(has(kept, 'billing-api', 'shop-orders', 'http')).toBe(true)
    expect(has(ignored, 'billing-api', 'shop-orders', 'http')).toBe(false)
    expect(has(ignored, 'kiosk-ai-webapp', 'shop-orders', 'http')).toBe(true)
  })

  test('should never read a real .env file when scanning', async () => {
    const { fs, reads } = fakeFs(TREE)

    const graph = await scanAll(fs, ROOT, CORRECTIONS, 1)

    expect(reads.some(path => /\/\.env$/.test(path))).toBe(false)
    expect(reads.some(path => path.endsWith('.env.local'))).toBe(false)
    expect(reads.includes('/r/shop-orders/.env.example')).toBe(true)
    expect(JSON.stringify(graph).includes('secret')).toBe(false)
  })
})

describe('libEdges', () => {
  test('should link a scanned repo required from any Go host, with or without a major version suffix', () => {
    const goMod = 'module example.com/me/api\n\nrequire (\n\tgitlab.com/team/shared-kit/v2 v2.1.0\n\tgithub.com/other/not-scanned v1.0.0\n)\n'
    expect(libEdges('api', 'go.mod', goMod, ['api', 'shared-kit']).map(edge => edge.to)).toEqual(['shared-kit'])
  })

  test('should link a scanned repo used as an npm dependency, scoped or not', () => {
    const pkg = '{ "name": "web", "dependencies": { "@team/ui-kit": "^1.0.0", "date-utils": "2.0.0", "react": "18.3.1" } }'
    expect(libEdges('web', 'package.json', pkg, ['web', 'ui-kit', 'date-utils']).map(edge => edge.to)).toEqual(['ui-kit', 'date-utils'])
  })

  test('should not link a repo to itself through its own module line', () => {
    expect(libEdges('api', 'go.mod', 'module github.com/me/api\n', ['api'])).toEqual([])
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
    const found = locate('C:\\Users\\E\\repos\\Shop-Orders\\db\\migrations\\x.sql', 'C:/Users/E/repos', ['shop-orders'])

    expect(found).toEqual({ repo: 'shop-orders', rel: 'db/migrations/x.sql' })
  })

  test('should return null when the file is outside the repos root', () => {
    expect(locate('C:/other/shop-orders/a.go', 'C:/Users/E/repos', ['shop-orders'])).toBe(null)
  })
})

describe('impact', () => {
  const GRAPH: Graph = {
    repos: ['ai-report-generator', 'billing-api', 'shop-orders', 'kiosk-ai-webapp'],
    edges: [
      { from: 'kiosk-ai-webapp', to: 'shop-orders', kind: 'http', via: 'VITE_ORDERS_API_URL' },
      { from: 'ai-report-generator', to: 'shop-orders', kind: 'db', via: 'ORDERS_DATABASE_URL' },
      { from: 'billing-api', to: 'shop-orders', kind: 'http', via: 'ORDERS_BASE_URL' },
      { from: 'kiosk-ai-webapp', to: 'billing-api', kind: 'http', via: 'VITE_BILLING_API_URL' },
    ],
    scannedAt: 1,
  }

  test('should list the DB users when a migration is edited', () => {
    const found = impact(GRAPH, 'shop-orders', 'db/migrations/1.sql', 'migration')

    expect(found?.edges.map(edge => edge.from)).toEqual(['ai-report-generator'])
  })

  test('should list the API consumers sorted when a handler is edited', () => {
    const found = impact(GRAPH, 'shop-orders', 'src/entrypoints/rest/a.go', 'handler')

    expect(found?.edges.map(edge => edge.from)).toEqual(['billing-api', 'kiosk-ai-webapp'])
  })

  test('should list what the repo uses when its config is edited', () => {
    const found = impact(GRAPH, 'kiosk-ai-webapp', 'apps/kiosk/.env.example', 'config')

    expect(found?.edges.map(edge => edge.to)).toEqual(['billing-api', 'shop-orders'])
  })

  test('should return null when nobody depends on the repo', () => {
    expect(impact(GRAPH, 'ai-report-generator', 'db/migrations/1.sql', 'migration')).toBe(null)
  })
})
