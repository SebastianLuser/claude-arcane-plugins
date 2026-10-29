import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const REPO = 'C:/repos/billing-api'
const SURFACES = ['terminal', 'desktop'] as const
const IN_CODE_PATTERN = 'RUN_MIGRATIONS|migrate[.]New|RunMigrations[(]|goose[.]Up[(]'

const PANE = {
  plugin: 'deploy-runbook',
  component: 'Pane',
  requestId: 'deploy-runbook',
  props: {
    title: 'Deploy',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const SLUG_BRANCH: Record<string, string> = {
  'rev-parse --show-toplevel': REPO,
  'rev-parse --abbrev-ref HEAD': 'feat/slug',
  'rev-parse --abbrev-ref origin/HEAD': 'origin/main',
  'merge-base HEAD origin/main': 'abc123',
  'diff --name-status --no-renames abc123': [
    'A\tpackages/dbconn/migrations/000030_add_slug.up.sql',
    'M\t.env.example',
    'M\t.env',
  ].join('\n'),
  'diff -U0 --no-renames abc123 -- .env.example': [
    'diff --git a/.env.example b/.env.example',
    '--- a/.env.example',
    '+++ b/.env.example',
    '@@ -3,0 +4 @@',
    '+SLUG_BASE_URL=https://slug.example.com',
  ].join('\n'),
  'ls-files': 'config/config.go\nrailway.json\nsrc/app/app.go\n.env.example',
  [`grep -l -E ${IN_CODE_PATTERN} -- *.go`]: 'config/config.go',
}

const SLUG_FILES: Record<string, string> = {
  [`${REPO}/packages/dbconn/migrations/000030_add_slug.up.sql`]:
    'ALTER TABLE courses ADD COLUMN slug TEXT NOT NULL DEFAULT \'\', DROP COLUMN legacy_code;',
  [`${REPO}/config/config.go`]: 'runMigrations, err := strconv.ParseBool(getEnv("RUN_MIGRATIONS", "true"))',
  [`${REPO}/railway.json`]: '{}',
  [`${REPO}/.env`]: 'SLUG_BASE_URL=https://secret-host.internal',
}

const QUIET_BRANCH: Record<string, string> = {
  ...SLUG_BRANCH,
  'rev-parse --abbrev-ref HEAD': 'fix/typo',
  'diff --name-status --no-renames abc123': 'M\tsrc/app/app.go',
}

type Calls = { opened: string[]; git: string[]; reads: string[] }

function standInEngine(
  on: On,
  answers: Record<string, string>,
  files: Record<string, string> = SLUG_FILES,
  corrections = '{}',
): Calls {
  const calls: Calls = { opened: [], git: [], reads: [] }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'deploy-info' } }))
  on('ui.open', (_, e) => {
    calls.opened.push(e.title ?? '')
    return { value: { isPlaced: true } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: REPO }))
  on('fs.read', (_, e) => {
    // On Linux the engine reads a drive path as relative and prefixes the plugin folder: match from REPO on.
    const raw = e.path.replace(/\\/g, '/')
    const path = raw.includes(REPO) ? raw.slice(raw.indexOf(REPO)) : raw
    calls.reads.push(path)
    if (path.endsWith('corrections.json')) return { value: corrections }
    const text = files[path]
    if (text === undefined) throw new Error(`ENOENT ${path}`)
    return { value: text }
  })
  on('process.run', (_, e) => {
    const key = e.argv.slice(1).join(' ')
    calls.git.push(key)
    const stdout = answers[key]
    return { value: { exitCode: stdout === undefined ? 1 : 0, stdout: stdout ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('skill.prompt', (_, e) => ({ text: e.text }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return calls
}

function deployInfo() {
  return {
    command: 'deploy-info',
    args: '',
    origin: { kind: 'composer' as const },
    presentation: { isFullscreen: false, columns: 120 },
  }
}

test('should open the runbook with migrations, variables and table changes when /create-pr runs on a branch that has them', async ($, on) => {
  const calls = standInEngine(on, SLUG_BRANCH)
  await $.session.start({ cwd: REPO, surface: 'terminal', isInteractive: true })

  const prompt = await $.skill.prompt({ skill: 'create-pr', text: 'Create a pull request.' })

  expect(prompt.text).toBe('Create a pull request.')
  expect(calls.opened).toEqual(['Deploy · billing-api'])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^DEPLOY/ }))?.text).toBe('DEPLOY · billing-api')
    expect((await ui.find({ type: 'Text', text: /against/ }))?.text).toBe('feat/slug against origin/main')
    expect((await ui.find({ type: 'Text', text: /RUN_MIGRATIONS/ }))?.text).toBe('● They run on startup; RUN_MIGRATIONS=false turns them off')
    expect((await ui.find({ type: 'Text', text: /SLUG_BASE_URL/ }))?.text).toContain('load it in Railway')
    expect((await ui.find({ type: 'Text', text: /\+ slug/ }))?.props.color).toBe('success')
    expect((await ui.find({ type: 'Text', text: /- legacy_code/ }))?.props.color).toBe('error')
    await ui.unmount()
  }
})

test('should not open anything and keep the prompt when /code-review runs on a branch without migrations or variables', async ($, on) => {
  const calls = standInEngine(on, QUIET_BRANCH)
  await $.session.start({ cwd: REPO, surface: 'terminal', isInteractive: true })

  const prompt = await $.skill.prompt({ skill: 'code-review', text: 'Review the diff.' })

  expect(prompt.text).toBe('Review the diff.')
  expect(calls.opened).toEqual([])
})

test('should not run git when another skill expands its prompt', async ($, on) => {
  const calls = standInEngine(on, SLUG_BRANCH)
  await $.session.start({ cwd: REPO, surface: 'terminal', isInteractive: true })

  await $.skill.prompt({ skill: 'commit', text: 'Commit.' })

  expect(calls.git).toEqual([])
  expect(calls.opened).toEqual([])
})

test('should open the pane and say there is nothing to deploy when /deploy-info runs on a quiet branch', async ($, on) => {
  const calls = standInEngine(on, QUIET_BRANCH)
  await $.session.start({ cwd: REPO, surface: 'desktop', isInteractive: true })

  const result = await $.command.run(deployInfo())

  expect(result.text).toBe('Nothing to deploy on fix/typo: no new migrations or variables.')
  expect(calls.opened).toEqual(['Deploy · billing-api'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /new migrations/ }))?.text).toBe('No new migrations.')
  await ui.unmount()
})

test('should explain the failure in the pane when /deploy-info runs outside a git repo', async ($, on) => {
  standInEngine(on, {})
  await $.session.start({ cwd: REPO, surface: 'terminal', isInteractive: true })

  const result = await $.command.run(deployInfo())

  expect(result.text).toBe(`Could not build the runbook: ${REPO} is not a git repo`)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /is not a git repo/ }))?.props.color).toBe('error')
  await ui.unmount()
})

test('should use corrections.json from the plugin folder when the session starts with one', async ($, on) => {
  const corrections = JSON.stringify({
    migrations: { 'billing-api': 'The data team runs them' },
    targets: { 'billing-api': 'Railway (api-prod)' },
  })
  standInEngine(on, SLUG_BRANCH, SLUG_FILES, corrections)
  await $.session.start({ cwd: REPO, surface: 'terminal', isInteractive: true })

  await $.command.run(deployInfo())

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /data team/ }))?.text).toBe('● The data team runs them')
  expect((await ui.find({ type: 'Text', text: /SLUG_BASE_URL/ }))?.text).toContain('load it in Railway (api-prod)')
  await ui.unmount()
})

test('should never read nor diff a real .env when the branch changes one', async ($, on) => {
  const calls = standInEngine(on, SLUG_BRANCH)
  await $.session.start({ cwd: REPO, surface: 'terminal', isInteractive: true })

  await $.skill.prompt({ skill: 'create-pr', text: 'Create a pull request.' })

  expect(calls.git.filter(key => /(^| )\.env($| )/.test(key))).toEqual([])
  expect(calls.reads.filter(path => /\/\.env$/.test(path))).toEqual([])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /secret-host/ })).toBeUndefined()
  await ui.unmount()
})
