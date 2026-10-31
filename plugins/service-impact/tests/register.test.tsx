import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Graph } from '../types'

// The engine resolves paths for the host OS: a drive path on Windows, a POSIX one on the Linux CI runner.
const ROOT = 'C:/repos'
const SURFACES = ['terminal', 'desktop'] as const
const OPTIONS = { options: { reposRoot: ROOT } }

const GRAPH: Graph = {
  repos: ['ai-report-generator', 'auth-service', 'billing-api', 'shared-ai-toolkit', 'shop-orders'],
  edges: [
    { from: 'ai-report-generator', to: 'shop-orders', kind: 'db', via: 'ORDERS_DATABASE_URL' },
    { from: 'billing-api', to: 'shop-orders', kind: 'http', via: 'ORDERS_BASE_URL' },
    { from: 'shop-orders', to: 'ai-report-generator', kind: 'http', via: 'REPORT_GENERATOR_URL' },
    { from: 'shop-orders', to: 'mailer', kind: 'http', via: 'MAILER_API_URL', isExternal: true },
    { from: 'auth-service', to: 'shared-ai-toolkit', kind: 'lib', via: 'go.mod' },
  ],
  scannedAt: 1,
}

const BAND = {
  plugin: 'service-impact',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 11 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'service-impact',
  component: 'Pane',
  requestId: 'service-impact',
  props: {
    title: 'Impact',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const TREE: Record<string, string> = {
  'shop-orders/.git/HEAD': '',
  'shop-orders/db/migrations/0001_init.up.sql': 'create table courses ();',
  'ai-report-generator/.git/HEAD': '',
  'ai-report-generator/config/config.go': 'os.Getenv("ORDERS_DATABASE_URL")',
}

// On Linux the engine reads a drive path as relative and prefixes the plugin folder: match from ROOT on.
function fromRoot(raw: string): string {
  const path = raw.replace(/\\/g, '/')
  const at = path.indexOf(ROOT)
  return at < 0 ? path : path.slice(at)
}

function answerFs(on: On, tree: Record<string, string>) {
  const relOf = (raw: string) => {
    const path = fromRoot(raw)
    return path === ROOT ? '' : path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : null
  }
  on('fs.list', (_, e) => {
    const rel = relOf(e.path)
    const prefix = rel ? `${rel}/` : ''
    const entries = new Map<string, { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }>()
    for (const [key, text] of Object.entries(tree)) {
      if (rel === null || !key.startsWith(prefix)) continue
      const [name, ...rest] = key.slice(prefix.length).split('/')
      entries.set(name!, { name: name!, kind: rest.length > 0 ? 'dir' : 'file', size: text.length, mtimeMs: 0, isLink: false })
    }
    if (entries.size === 0) throw new Error(`ENOENT ${e.path}`)
    return { value: [...entries.values()] }
  })
  on('fs.exists', (_, e) => {
    const rel = relOf(e.path)
    return { value: rel !== null && rel !== '' && Object.keys(tree).some(key => key === rel || key.startsWith(`${rel}/`)) }
  })
  on('fs.read', (_, e) => {
    const rel = relOf(e.path)
    const text = rel === null ? '{}' : tree[rel]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
}

function standInEngine(on: On, store: Record<string, unknown> = { 'graph-1': GRAPH }, tree?: Record<string, string>): string[] {
  const opened: string[] = []
  mock.store(on, store)
  mock.clock(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'impact' } }))
  on('ui.open', (_, e) => {
    opened.push(e.title ?? '')
    return { value: { isPlaced: true } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: ROOT }))
  if (tree) {
    answerFs(on, tree)
  } else {
    on('fs.read', () => ({ value: '{}' }))
    on('fs.list', () => {
      throw new Error('ENOENT')
    })
  }
  on('tool.call', () => ({ result: {} }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return opened
}

function edit(file: string) {
  return { tool: 'Edit' as const, file_path: `${ROOT}/${file}`, old_string: 'a', new_string: 'b' }
}

function impact(args: string) {
  return {
    command: 'impact',
    args,
    origin: { kind: 'composer' as const },
    presentation: { isFullscreen: false, columns: 120 },
  }
}

test('should show a red band naming the DB users and open the map when a shared-DB migration is edited', OPTIONS, async ($, on) => {
  const opened = standInEngine(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  await $.tool.call(edit('shop-orders/db/migrations/0042_add_col.up.sql'))
  expect(opened).toEqual(['Impact · shop-orders'])

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /IMPACT · shop-orders/ }))?.text).toBe('IMPACT · shop-orders')
    expect((await ui.find({ type: 'Text', text: /ai-report-generator/ }))?.props.color).toBe('error')
    expect(await ui.find({ type: 'Text', text: /billing-api/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('should not show a band when the edited file is not a trigger', OPTIONS, async ($, on) => {
  standInEngine(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  await $.tool.call(edit('shop-orders/src/core/usecases/courses.go'))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /IMPACT/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('should not show a band when nobody depends on the edited repo', OPTIONS, async ($, on) => {
  standInEngine(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  await $.tool.call(edit('ai-report-generator/db/migrations/0003_prompts.up.sql'))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /IMPACT/ })).toBeUndefined()
  await ui.unmount()
})

test('should show the band once per file when the same file is edited again', OPTIONS, async ($, on) => {
  standInEngine(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call(edit('shop-orders/src/entrypoints/rest/courses.go'))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /billing-api/ }))?.props.color).toBe('warning')

  await ui.press({ key: 'hide' })
  await $.tool.call(edit('shop-orders/src/entrypoints/rest/courses.go'))
  expect(await ui.find({ type: 'Text', text: /IMPACT/ })).toBeUndefined()

  await $.tool.call(edit('shop-orders/src/entrypoints/rest/activities.go'))
  expect((await ui.find({ type: 'Text', text: /IMPACT · shop-orders/ }))?.text).toBe('IMPACT · shop-orders')
  await ui.unmount()
})

test('should open the map with both directions colored when /impact names a repo', OPTIONS, async ($, on) => {
  const opened = standInEngine(on)
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })

  const result = await $.command.run(impact('Shop-Orders'))

  expect(result.text).toBe('Impact map of shop-orders open.')
  expect(opened).toEqual(['Impact · shop-orders'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Used by/ }))?.text).toBe('Used by')
  expect((await ui.find({ type: 'Text', text: /This service uses/ }))?.text).toBe('This service uses')
  expect((await ui.find({ type: 'Text', text: /billing-api/ }))?.props.color).toBe('warning')
  expect((await ui.find({ type: 'Text', text: /mailer/ }))?.props.color).toBe('subtle')
  await ui.unmount()

  // The desktop draws it: users on the left, what it uses on the right, each edge in its kind's color.
  const drawn = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svg = await drawn.find({ type: 'Svg' })
  expect(svg?.props.isInteractive).toBe(true)
  const source = String(svg?.props.source)
  expect(source).toContain('USED BY · 2')
  expect(source).toContain('USES · 2')
  expect(source).toContain('billing-api')
  expect(source).toContain('stroke="#F5A524"')
  expect(source).toContain('stroke-dasharray="4 3"')
  await drawn.press({ key: 'all' })
  expect(opened).toEqual(['Impact · shop-orders', 'Impact'])
  await drawn.unmount()
})

test('should draw the edit as a red banner with glowing edges on the desktop map', OPTIONS, async ($, on) => {
  standInEngine(on)
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })

  await $.tool.call(edit('shop-orders/db/migrations/0042_add_col.up.sql'))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const source = String((await ui.find({ type: 'Svg' }))?.props.source)
  expect(source).toContain('Migration edited · 1 service affected')
  expect(source).toContain('class="hot"')
  expect(source).toContain('animateMotion')
  await ui.unmount()
})

test('should draw every connected repo on the overview map with a button to open each', OPTIONS, async ($, on) => {
  const opened = standInEngine(on)
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await $.command.run(impact(''))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const source = String((await ui.find({ type: 'Svg' }))?.props.source)
  expect(source).toContain('6 services · 5 connections')
  await ui.press({ key: 'repo-shop-orders' })
  expect(opened.at(-1)).toBe('Impact · shop-orders')
  await ui.unmount()
})

test('should say the repo is unknown when /impact names one that was not scanned', OPTIONS, async ($, on) => {
  standInEngine(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const result = await $.command.run(impact('ledger'))

  expect(result.text).toBe(`No repo named "ledger" among the 5 repos scanned in ${ROOT}.`)
})

test('should open the map from the band when Ver mapa is pressed', OPTIONS, async ($, on) => {
  const opened = standInEngine(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call(edit('shop-orders/db/migrations/0042_add_col.up.sql'))
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

  await band.press({ key: 'map' })

  // Once by itself on the edit, once from the button.
  expect(opened).toEqual(['Impact · shop-orders', 'Impact · shop-orders'])
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /ai-report-generator/ }))?.text).toContain('ai-report-generator')
  await pane.unmount()
  await band.unmount()
})

test('should say it is scanning when there is no graph yet', OPTIONS, async ($, on) => {
  standInEngine(on, {})
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const result = await $.command.run(impact(''))

  expect(result.text).toBe('Still scanning the repos. The map shows in the pane when it finishes.')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Scanning/ }))?.text).toBe(`Scanning the repos in ${ROOT}...`)
  await ui.unmount()
})

test('should show what the repo connects to when its config is edited', OPTIONS, async ($, on) => {
  standInEngine(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  await $.tool.call(edit('shop-orders/config/config.go'))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Config change/ }))?.props.color).toBe('warning')
  expect((await ui.find({ type: 'Text', text: /ai-report-generator/ }))?.props.color).toBe('warning')
  expect((await ui.find({ type: 'Text', text: /mailer/ }))?.props.color).toBe('subtle')
  await ui.unmount()
})

for (const [where, cwd] of [
  ['the repos folder', ROOT],
  ['a folder inside a repo', `${ROOT}/shop-orders/src`],
] as const) {
  test(`should find the repos root and scan it when the session starts in ${where}`, async ($, on) => {
    standInEngine(on, {}, TREE)
    await $.session.start({ cwd, surface: 'terminal', isInteractive: true })
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await pane.press({ key: 'rescan' })
    await pane.unmount()

    await $.tool.call(edit('shop-orders/db/migrations/0001_init.up.sql'))

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /IMPACT · shop-orders/ }))?.text).toBe('IMPACT · shop-orders')
    expect((await ui.find({ type: 'Text', text: /ai-report-generator/ }))?.props.color).toBe('error')
    await ui.unmount()
  })
}
