import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Graph } from '../types'

const ROOT = 'C:/repos'
const SURFACES = ['terminal', 'desktop'] as const
const OPTIONS = { options: { reposRoot: ROOT } }

const GRAPH: Graph = {
  repos: ['ai-content-generator', 'auth-service', 'campus-api', 'team-ai-toolkit', 'tich-cronos'],
  edges: [
    { from: 'ai-content-generator', to: 'tich-cronos', kind: 'db', via: 'CRONOS_DATABASE_URL' },
    { from: 'campus-api', to: 'tich-cronos', kind: 'http', via: 'CRONOS_BASE_URL' },
    { from: 'tich-cronos', to: 'ai-content-generator', kind: 'http', via: 'CONTENT_GENERATOR_URL' },
    { from: 'tich-cronos', to: 'hermes', kind: 'http', via: 'HERMES_API_URL', isExternal: true },
    { from: 'auth-service', to: 'team-ai-toolkit', kind: 'lib', via: 'go.mod' },
  ],
  scannedAt: 1,
}

const BAND = {
  plugin: 'educabot-impacto',
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
  plugin: 'educabot-impacto',
  component: 'Pane',
  requestId: 'educabot-impacto',
  props: {
    title: 'Impacto',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const TREE: Record<string, string> = {
  'tich-cronos/.git/HEAD': '',
  'tich-cronos/db/migrations/0001_init.up.sql': 'create table courses ();',
  'ai-content-generator/.git/HEAD': '',
  'ai-content-generator/config/config.go': 'os.Getenv("CRONOS_DATABASE_URL")',
}

function answerFs(on: On, tree: Record<string, string>) {
  const relOf = (raw: string) => {
    const path = raw.replace(/\\/g, '/')
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
  on('command.register', () => ({ value: { command: 'impacto' } }))
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

function impacto(args: string) {
  return {
    command: 'impacto',
    args,
    origin: { kind: 'composer' as const },
    presentation: { isFullscreen: false, columns: 120 },
  }
}

test('should show a red band naming the DB users when a shared-DB migration is edited', OPTIONS, async ($, on) => {
  standInEngine(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  await $.tool.call(edit('tich-cronos/db/migrations/0042_add_col.up.sql'))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /IMPACTO · tich-cronos/ }))?.text).toBe('IMPACTO · tich-cronos')
    expect((await ui.find({ type: 'Text', text: /ai-content-generator/ }))?.props.color).toBe('error')
    expect(await ui.find({ type: 'Text', text: /campus-api/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('should not show a band when the edited file is not a trigger', OPTIONS, async ($, on) => {
  standInEngine(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  await $.tool.call(edit('tich-cronos/src/core/usecases/courses.go'))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /IMPACTO/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('should not show a band when nobody depends on the edited repo', OPTIONS, async ($, on) => {
  standInEngine(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  await $.tool.call(edit('ai-content-generator/db/migrations/0003_prompts.up.sql'))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /IMPACTO/ })).toBeUndefined()
  await ui.unmount()
})

test('should show the band once per file when the same file is edited again', OPTIONS, async ($, on) => {
  standInEngine(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call(edit('tich-cronos/src/entrypoints/rest/courses.go'))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /campus-api/ }))?.props.color).toBe('warning')

  await ui.press({ key: 'hide' })
  await $.tool.call(edit('tich-cronos/src/entrypoints/rest/courses.go'))
  expect(await ui.find({ type: 'Text', text: /IMPACTO/ })).toBeUndefined()

  await $.tool.call(edit('tich-cronos/src/entrypoints/rest/activities.go'))
  expect((await ui.find({ type: 'Text', text: /IMPACTO · tich-cronos/ }))?.text).toBe('IMPACTO · tich-cronos')
  await ui.unmount()
})

test('should open the map with both directions colored when /impacto names a repo', OPTIONS, async ($, on) => {
  const opened = standInEngine(on)
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })

  const result = await $.command.run(impacto('Tich-Cronos'))

  expect(result.text).toBe('Mapa de impacto de tich-cronos abierto.')
  expect(opened).toEqual(['Impacto · tich-cronos'])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Usan este servicio/ }))?.text).toBe('Usan este servicio')
    expect((await ui.find({ type: 'Text', text: /Este servicio usa/ }))?.text).toBe('Este servicio usa')
    expect((await ui.find({ type: 'Text', text: /campus-api/ }))?.props.color).toBe('warning')
    expect((await ui.find({ type: 'Text', text: /hermes/ }))?.props.color).toBe('subtle')
    await ui.unmount()
  }
})

test('should say the repo is unknown when /impacto names one that was not scanned', OPTIONS, async ($, on) => {
  standInEngine(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const result = await $.command.run(impacto('odin'))

  expect(result.text).toBe(`No encontré "odin" entre los 5 repos escaneados en ${ROOT}.`)
})

test('should open the map from the band when Ver mapa is pressed', OPTIONS, async ($, on) => {
  const opened = standInEngine(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call(edit('tich-cronos/db/migrations/0042_add_col.up.sql'))
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

  await band.press({ key: 'map' })

  expect(opened).toEqual(['Impacto · tich-cronos'])
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /ai-content-generator/ }))?.text).toContain('ai-content-generator')
  await pane.unmount()
  await band.unmount()
})

test('should say it is scanning when there is no graph yet', OPTIONS, async ($, on) => {
  standInEngine(on, {})
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const result = await $.command.run(impacto(''))

  expect(result.text).toBe('Todavía estoy escaneando los repos. El mapa aparece en el panel cuando termine.')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Escaneando/ }))?.text).toBe(`Escaneando los repos de ${ROOT}...`)
  await ui.unmount()
})

test('should show what the repo connects to when its config is edited', OPTIONS, async ($, on) => {
  standInEngine(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  await $.tool.call(edit('tich-cronos/config/config.go'))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Cambio de config/ }))?.props.color).toBe('warning')
  expect((await ui.find({ type: 'Text', text: /ai-content-generator/ }))?.props.color).toBe('warning')
  expect((await ui.find({ type: 'Text', text: /hermes/ }))?.props.color).toBe('subtle')
  await ui.unmount()
})

for (const [where, cwd] of [
  ['the repos folder', ROOT],
  ['a folder inside a repo', `${ROOT}/tich-cronos/src`],
] as const) {
  test(`should find the repos root and scan it when the session starts in ${where}`, async ($, on) => {
    standInEngine(on, {}, TREE)
    await $.session.start({ cwd, surface: 'terminal', isInteractive: true })
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await pane.press({ key: 'rescan' })
    await pane.unmount()

    await $.tool.call(edit('tich-cronos/db/migrations/0001_init.up.sql'))

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /IMPACTO · tich-cronos/ }))?.text).toBe('IMPACTO · tich-cronos')
    expect((await ui.find({ type: 'Text', text: /ai-content-generator/ }))?.props.color).toBe('error')
    await ui.unmount()
  })
}
