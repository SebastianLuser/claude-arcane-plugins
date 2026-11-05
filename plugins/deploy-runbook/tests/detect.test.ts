import { describe, expect, test } from 'claude-code/testing'

import { buildReport, changedFiles, deploySteps, isDeployFile, isPatchable, loadTarget, migrationMode, newVars, summaryOf } from '../hooks/detect'
import { commandsFor, environmentsOf } from '../hooks/envs'
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
      command: 'migrate -path db/migrations -database "$DATABASE_URL" up',
    })
    expect(migrationMode('store-security-be', SEGURIDAD, {})).toMatchObject({ source: 'deploy/railway-entrypoint.sh', command: '/app/migrate up' })
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
      command: 'gh workflow run deploy-prod.yml -f DB_MIGRATION-up=true',
    })
  })

  test('should point at the script without guessing when only a migrate script exists', () => {
    const files = [{ path: 'scripts/migrate.sh', text: 'migrate -path db/migrations -database "$DATABASE_URL" up' }]

    expect(migrationMode('store-be', files, {})).toEqual({
      kind: 'unknown',
      text: 'Unknown whether the deploy runs them: there is a script in scripts/migrate.sh',
      source: 'scripts/migrate.sh',
      command: 'sh scripts/migrate.sh',
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
      { name: 'FOO_URL', file: '.env.example', status: 'new' },
      { name: 'SMTP_HOST', file: 'config/config.go', status: 'new' },
      { name: 'SMTP_PORT', file: 'config/config.go', status: 'new' },
      { name: 'VITE_API_URL', file: 'src/env.ts', status: 'new' },
    ])
  })

  test('should never read a real .env nor keep any value when the diff adds one', () => {
    const patches: RepoFile[] = [
      { path: '.env', text: '+SECRET_TOKEN=abc123' },
      { path: 'apps/web/.env.local', text: '+API_KEY=sk-live-999' },
      { path: '.env.example', text: '+PUBLIC_URL=https://real-host.example' },
    ]

    const found = newVars(patches)

    expect(found).toEqual([{ name: 'PUBLIC_URL', file: '.env.example', status: 'new' }])
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
      trackedPaths: ['packages/dbconn/migrations/000030_add_slug.down.sql'],
      consumers: [{ repo: 'reports-web', kind: 'db', file: '.env.example' }],
      info: { commits: 2, files: 3, unpushed: 0 },
    })

    expect(report).toEqual({
      repo: 'billing-api',
      branch: 'feat/slug',
      base: 'origin/main',
      migrations: ['packages/dbconn/migrations/000030_add_slug.up.sql'],
      mode: { kind: 'flag', text: 'They run on startup; RUN_MIGRATIONS=false turns them off', source: 'config/config.go' },
      vars: [
        {
          name: 'SLUG_BASE_URL',
          file: '.env.example',
          status: 'new',
          target: 'Railway',
          uses: [{ file: '.env.example', line: null, code: 'SLUG_BASE_URL=…' }],
          fallback: null,
          examples: ['.env.example'],
          envs: [],
          command: 'railway variables --set "SLUG_BASE_URL=..."',
        },
      ],
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
      risks: [],
      consumers: [{ repo: 'reports-web', kind: 'db', file: '.env.example' }],
      info: { commits: 2, files: 3, unpushed: 0 },
      envs: [],
      details: [
        {
          path: 'packages/dbconn/migrations/000030_add_slug.up.sql',
          summary: ['Adds slug (TEXT) to courses'],
          hasDown: true,
          sql: 'ALTER TABLE courses ADD COLUMN slug TEXT;',
        },
      ],
    })
    expect(JSON.stringify(report)).not.toContain('example.com')
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
      trackedPaths: [],
      consumers: [
        { repo: 'reports-web', kind: 'db', file: '.env.example' },
        { repo: 'admin-web', kind: 'http', file: 'src/api.ts' },
      ],
      info: { commits: 1, files: 1, unpushed: 0 },
    })

    expect(report.consumers).toEqual([{ repo: 'admin-web', kind: 'http', file: 'src/api.ts' }])
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

describe('risks and steps', () => {
  const input = (sql: string, extra: Partial<Parameters<typeof buildReport>[0]> = {}) =>
    buildReport({
      repo: 'snake-game',
      branch: 'feat/scores',
      base: 'origin/main',
      nameStatus: 'A\tmigrations/001_scores.sql\nM\t.env.example',
      patches: [{ path: '.env.example', text: '+LEADERBOARD_API_URL=http://localhost' }],
      migrationTexts: [{ path: 'migrations/001_scores.sql', text: sql }],
      repoFiles: [],
      corrections: {},
      trackedPaths: [],
      consumers: [{ repo: 'snake-leaderboard', kind: 'db', file: '.env.example' }],
      info: { commits: 1, files: 2, unpushed: null },
      ...extra,
    })

  test('should flag a migration with no down file and no down part inside it', () => {
    expect(input('CREATE TABLE scores (id int);').risks).toEqual([
      { file: '001_scores.sql', level: 'medium', text: 'No down migration: rolling back needs a fix by hand' },
    ])
    expect(input('-- +goose Up\nCREATE TABLE scores (id int);\n-- +goose Down\nDROP TABLE scores;').risks.map(r => r.text)).toEqual([
      'Drops table scores: its data is lost',
    ])
    expect(input('CREATE TABLE scores (id int);', { trackedPaths: ['migrations/001_scores.down.sql'] }).risks).toEqual([])
  })

  test('should order the steps push, back up, variables, migrations by hand, deploy, checks', () => {
    const report = input('ALTER TABLE players DROP COLUMN nickname;')
    expect(deploySteps(report).map(step => step.id)).toEqual([
      'push',
      'backup',
      'var:LEADERBOARD_API_URL',
      'migrate',
      'deploy',
      'check:snake-leaderboard',
    ])
    expect(deploySteps(report)[0]).toEqual({ id: 'push', text: 'Push feat/scores', detail: 'it has no upstream yet', command: 'git push -u origin feat/scores' })
    expect(deploySteps(report)[1]!.command).toBe('pg_dump "$DATABASE_URL" -t players -f backup-feat-scores.sql')
    expect(deploySteps(report)[5]!.detail).toBe('it reads this database (.env.example)')
  })

  test('should check the migrations after the deploy when they run by themselves', () => {
    const report = input('CREATE TABLE scores (id int);', {
      corrections: { migrations: { 'snake-game': 'They run on startup' } },
      info: { commits: 1, files: 2, unpushed: 0 },
    })
    report.mode = { kind: 'auto', text: 'They run on startup', source: null }
    const ids = deploySteps(report).map(step => step.id)
    expect(ids.indexOf('deploy')).toBeLessThan(ids.indexOf('migrate'))
    expect(ids).not.toContain('push')
    expect(ids).not.toContain('backup')
  })
})

describe('environments and variables', () => {
  const WORKFLOWS: RepoFile[] = [
    { path: '.github/workflows/deploy.yml', text: 'jobs:\n  prod:\n    environment: production\n    steps:\n      - run: echo ${{ secrets.MAIL_KEY }}\n  stg:\n    environment:\n      name: stg\n' },
    { path: '.env.qa.example', text: 'MAIL_KEY=\nREPORTS_URL=' },
  ]

  test('should read the environments from the workflows, per-environment examples and railway.json', () => {
    const railway = [{ path: 'railway.json', text: '{ "environments": { "production": {}, "dev": {} } }' }]

    expect(environmentsOf(WORKFLOWS, ['.env.qa.example', '.env.local.example', '.env.example'])).toEqual(['qa', 'staging', 'production'])
    expect(environmentsOf(railway, [])).toEqual(['development', 'production'])
    expect(environmentsOf([], ['.env.example'])).toEqual([])
  })

  test('should explain each variable: where it is read, whether it has a fallback and how to load it', () => {
    const report = buildReport({
      repo: 'mailer',
      branch: 'feat/mail',
      base: 'origin/main',
      nameStatus: 'M\tsrc/config.ts\nM\tsrc/old.ts',
      patches: [
        { path: 'src/config.ts', text: '@@ -10,0 +11,2 @@\n+const key = process.env.MAIL_KEY\n+const port = process.env.MAIL_PORT ?? "587"' },
        { path: 'src/old.ts', text: '@@ -4 +3,0 @@\n-const legacy = process.env.LEGACY_SMTP\n-const shared = process.env.SHARED_URL' },
      ],
      migrationTexts: [],
      repoFiles: WORKFLOWS,
      corrections: {},
      trackedPaths: ['.env.qa.example'],
      consumers: [],
      info: { commits: 1, files: 2, unpushed: 0 },
      stillUsed: ['SHARED_URL'],
    })
    const byName = Object.fromEntries(report.vars.map(v => [v.name, v]))

    expect(Object.keys(byName)).toEqual(['MAIL_KEY', 'MAIL_PORT', 'LEGACY_SMTP'])
    expect(byName.MAIL_KEY).toMatchObject({
      target: 'GitHub (secrets)',
      uses: [{ file: 'src/config.ts', line: 11, code: 'const key = process.env.MAIL_KEY' }],
      fallback: null,
      envs: ['qa', 'staging', 'production'],
      command: 'gh secret set MAIL_KEY --env qa\ngh secret set MAIL_KEY --env staging\ngh secret set MAIL_KEY --env production',
    })
    expect(byName.MAIL_PORT).toMatchObject({ fallback: '587', uses: [{ line: 12 }] })
    expect(byName.LEGACY_SMTP).toMatchObject({ status: 'removed', uses: [] })

    const steps = deploySteps(report)
    expect(steps.map(s => s.id)).toEqual(['var:MAIL_KEY', 'var:MAIL_PORT', 'deploy', 'rm:LEGACY_SMTP'])
    expect(steps[0]!.detail).toBe('required: the code has no fallback')
    expect(steps[1]!.detail).toBe('optional: falls back to "587" · where to load it is not detected')
  })

  test('should write Railway and Vercel commands without a value', () => {
    expect(commandsFor({ name: 'API_URL', target: 'Railway', status: 'new' }, ['staging', 'production'])).toBe(
      'railway variables --set "API_URL=..." --environment staging\nrailway variables --set "API_URL=..." --environment production',
    )
    expect(commandsFor({ name: 'API_URL', target: 'Vercel', status: 'removed' }, [])).toBe('vercel env rm API_URL production --yes')
    expect(commandsFor({ name: 'API_URL', target: null, status: 'new' }, ['production'])).toBeNull()
  })

  test('should explain each migration in plain sentences', () => {
    expect(
      summaryOf('CREATE TABLE scores (id int, player_id int REFERENCES players(id)); ALTER TABLE players RENAME nick TO name; CREATE INDEX i ON scores(id);'),
    ).toEqual(['Creates table scores with 2 columns', 'Links scores.player_id to players', 'Renames players.nick to name', '1 other statement (indexes, data, functions)'])
  })
})
