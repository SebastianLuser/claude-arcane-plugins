import { describe, expect, test } from 'claude-code/testing'

import { buildReport, changedFiles, isDeployFile, isPatchable, loadTarget, migrationMode, newVars } from '../hooks/detect'
import type { RepoFile } from '../hooks/detect'

const INCLUSION: RepoFile[] = [
  {
    path: 'Dockerfile',
    text: [
      '# golang-migrate keeps the version tracking in schema_migrations',
      "RUN CGO_ENABLED=0 go install -tags 'postgres' github.com/golang-migrate/migrate/v4/cmd/migrate@v4.19.0",
      'ENTRYPOINT ["/app/entrypoint.sh"]',
    ].join('\n'),
  },
  {
    path: 'entrypoint.sh',
    text: [
      '# Migrations on container start, with golang-migrate.',
      'antes=$(migrate -path db/migrations -database "$DATABASE_URL" version 2>&1 || echo "no tracking")',
      'if migrate -path db/migrations -database "$DATABASE_URL" up; then',
    ].join('\n'),
  },
]

const SEGURIDAD: RepoFile[] = [
  { path: 'deploy/railway-entrypoint.sh', text: 'echo "[entrypoint] migrando DB (golang-migrate up)..."\n/app/migrate up\n' },
  { path: 'railway.json', text: '{ "deploy": { "startCommand": "/app/deploy/railway-entrypoint.sh" } }' },
]

const BILLING: RepoFile[] = [
  { path: 'config/config.go', text: 'runMigrations, err := strconv.ParseBool(getEnv("RUN_MIGRATIONS", "true"))' },
  { path: 'packages/dbconn/migrate.go', text: 'm, err := migrate.NewWithInstance("iofs", sourceDriver, "postgres", dbDriver)' },
  { path: 'railway.json', text: '{}' },
]

const AUTH: RepoFile[] = [
  { path: 'cmd/main.go', text: '\tif err := RunMigrations(db); err != nil {' },
  { path: 'Dockerfile', text: 'COPY --from=builder /app/db/migrations ./db/migrations\nCMD ["./auth-service"]' },
  { path: 'Makefile', text: 'migrate-up:\n\tmigrate -path db/migrations -database "$(DATABASE_URL)" up' },
]

const ORDERS: RepoFile[] = [
  {
    path: '.github/workflows/deploy-prod.yml',
    text: [
      'name: "Deploy prod"',
      'on:',
      '  workflow_dispatch:',
      'jobs:',
      '  create-env-file:',
      '    steps:',
      '      - run: echo "SMTP_HOST=${{ secrets.SMTP_HOST }}" >> .env',
      '  database-migration-up:',
      '    if: ${{ inputs.DB_MIGRATION-up == true }}',
      '    uses: ./.github/workflows/migrate-db-up.yml',
    ].join('\n'),
  },
  {
    path: '.github/workflows/deploy-staging.yml',
    text: 'on:\n  workflow_dispatch:\njobs:\n  database-migration-up:\n    if: ${{ inputs.DB_MIGRATION-up == true }}\n    uses: ./.github/workflows/migrate-db-up.yml',
  },
  {
    path: '.github/workflows/migrate-db-up.yml',
    text: 'on:\n  workflow_call:\njobs:\n  up:\n    steps:\n      - run: ./migrate -path db/migrations -database "$URL" up',
  },
]

describe('migrationMode', () => {
  test('should say migrations run on their own when the entrypoint runs migrate up', () => {
    expect(migrationMode('store-catalog-be', INCLUSION, {})).toEqual({
      kind: 'auto',
      text: 'They run when the service starts',
      source: 'entrypoint.sh',
    })
    expect(migrationMode('store-security-be', SEGURIDAD, {}).source).toBe('deploy/railway-entrypoint.sh')
  })

  test('should name the RUN_MIGRATIONS flag when the config reads it', () => {
    expect(migrationMode('billing-api', BILLING, {})).toEqual({
      kind: 'flag',
      text: 'They run on startup; RUN_MIGRATIONS=false turns them off',
      source: 'config/config.go',
    })
  })

  test('should say migrations run from the code when main calls RunMigrations', () => {
    expect(migrationMode('auth-service', AUTH, {})).toEqual({
      kind: 'auto',
      text: 'The app runs them from its code on startup',
      source: 'cmd/main.go',
    })
  })

  test('should name the prod workflow and its input when the deploy calls a migration workflow', () => {
    expect(migrationMode('shop-orders', ORDERS, {})).toEqual({
      kind: 'manual',
      text: 'By hand: run the deploy-prod.yml workflow with DB_MIGRATION-up checked',
      source: '.github/workflows/deploy-prod.yml',
    })
  })

  test('should point at the script without guessing when only a migrate script exists', () => {
    const files = [{ path: 'scripts/migrate.sh', text: 'migrate -path db/migrations -database "$DATABASE_URL" up' }]

    expect(migrationMode('store-be', files, {})).toEqual({
      kind: 'unknown',
      text: 'Unknown whether the deploy runs them: there is a script in scripts/migrate.sh',
      source: 'scripts/migrate.sh',
    })
  })

  test('should say it is not detected when nothing runs migrations', () => {
    const files = [
      { path: 'Dockerfile', text: 'CMD ["./server"]' },
      { path: 'radiant-ts/scripts/migrate-novedades-images.mjs', text: 'await uploadImages(bucket)' },
    ]

    expect(migrationMode('ai-report-generator', files, {})).toEqual({
      kind: 'unknown',
      text: 'Not detected: add it in corrections.json',
      source: null,
    })
  })

  test('should use the corrections entry instead of the detection when the repo has one', () => {
    const corrections = { migrations: { 'shop-orders': 'The data team runs them on Tuesdays' } }

    expect(migrationMode('shop-orders', ORDERS, corrections)).toEqual({
      kind: 'declared',
      text: 'The data team runs them on Tuesdays',
      source: 'corrections.json',
    })
  })
})

describe('newVars', () => {
  test('should list names added in .env.example and in code but not moved or built-in ones', () => {
    const patches: RepoFile[] = [
      { path: '.env.example', text: '--- a/.env.example\n+++ b/.env.example\n-DB_URL=postgres://x\n+FOO_URL=https://example.com\n+DB_URL=postgres://y' },
      { path: 'config/config.go', text: '+\tsmtp := os.Getenv("SMTP_HOST")\n+\tport := getEnv("SMTP_PORT", "25")' },
      { path: 'src/env.ts', text: '+const api = import.meta.env.VITE_API_URL\n+const env = process.env.NODE_ENV' },
      { path: 'config/config_test.go', text: '+\tos.Getenv("ONLY_IN_TEST")' },
    ]

    expect(newVars(patches)).toEqual([
      { name: 'FOO_URL', file: '.env.example' },
      { name: 'SMTP_HOST', file: 'config/config.go' },
      { name: 'SMTP_PORT', file: 'config/config.go' },
      { name: 'VITE_API_URL', file: 'src/env.ts' },
    ])
  })

  test('should never read a real .env nor keep any value when the diff adds one', () => {
    const patches: RepoFile[] = [
      { path: '.env', text: '+SECRET_TOKEN=abc123' },
      { path: 'apps/web/.env.local', text: '+API_KEY=sk-live-999' },
      { path: '.env.example', text: '+PUBLIC_URL=https://real-host.example' },
    ]

    const found = newVars(patches)

    expect(found).toEqual([{ name: 'PUBLIC_URL', file: '.env.example' }])
    expect(JSON.stringify(found)).not.toContain('real-host')
    expect(isPatchable('.env')).toBe(false)
    expect(isPatchable('apps/web/.env.production')).toBe(false)
    expect(isPatchable('apps/web/.env.example')).toBe(true)
  })

  test('should not treat an env file as a deploy file when it sits in a scripts folder named like a migration', () => {
    expect(isDeployFile('scripts/.env.migrate')).toBe(false)
    expect(isDeployFile('scripts/migrate.sh')).toBe(true)
  })
})

describe('loadTarget', () => {
  test('should prefer a workflow secret, then Railway, then Vercel when it places a variable', () => {
    const vercel = [{ path: 'vercel.json', text: '{}' }]

    expect(loadTarget('SMTP_HOST', 'shop-orders', ORDERS, {})).toBe('GitHub (secrets)')
    expect(loadTarget('FOO_URL', 'billing-api', BILLING, {})).toBe('Railway')
    expect(loadTarget('FOO_URL', 'repensandonos', vercel, {})).toBe('Vercel')
    expect(loadTarget('FOO_URL', 'ai-report-generator', [], {})).toBeNull()
    expect(loadTarget('FOO_URL', 'billing-api', BILLING, { targets: { 'billing-api': 'Railway (servicio api-prod)' } })).toBe(
      'Railway (servicio api-prod)',
    )
  })
})

describe('buildReport', () => {
  test('should put migrations, how they run, new variables and table changes together when a branch has them', () => {
    const nameStatus = [
      'A\tpackages/dbconn/migrations/000030_add_slug.up.sql',
      'A\tpackages/dbconn/migrations/000030_add_slug.down.sql',
      'M\t.env.example',
      'D\tpackages/old.go',
    ].join('\n')

    const report = buildReport({
      repo: 'billing-api',
      branch: 'feat/slug',
      base: 'origin/main',
      nameStatus,
      patches: [{ path: '.env.example', text: '+SLUG_BASE_URL=https://example.com' }],
      migrationTexts: [{ path: 'packages/dbconn/migrations/000030_add_slug.up.sql', text: 'ALTER TABLE courses ADD COLUMN slug TEXT;' }],
      repoFiles: BILLING,
      corrections: {},
    })

    expect(report).toEqual({
      repo: 'billing-api',
      branch: 'feat/slug',
      base: 'origin/main',
      migrations: ['packages/dbconn/migrations/000030_add_slug.up.sql'],
      mode: { kind: 'flag', text: 'They run on startup; RUN_MIGRATIONS=false turns them off', source: 'config/config.go' },
      vars: [{ name: 'SLUG_BASE_URL', file: '.env.example', target: 'Railway' }],
      tables: [
        {
          table: 'courses',
          isNew: false,
          isDropped: false,
          added: [{ name: 'slug', type: 'TEXT' }],
          dropped: [],
          renamed: [],
          foreignKeys: [],
        },
      ],
      skipped: 0,
    })
  })

  test('should leave the migration mode out when the branch has no migrations', () => {
    const report = buildReport({
      repo: 'billing-api',
      branch: 'fix/typo',
      base: 'origin/main',
      nameStatus: 'M\tsrc/app/app.go',
      patches: [],
      migrationTexts: [],
      repoFiles: BILLING,
      corrections: {},
    })

    expect(report.mode).toBeNull()
    expect(report.migrations).toEqual([])
  })
})

test('should skip deleted files and keep the new path when it reads git name-status', () => {
  expect(changedFiles('A\ta.sql\r\nD\tb.go\nM\tsrc\\c.ts\n')).toEqual([
    { status: 'A', path: 'a.sql' },
    { status: 'M', path: 'src/c.ts' },
  ])
})
