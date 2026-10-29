import { expect, mock, test } from 'claude-code/testing'

import { peerKey } from './peers'

const BAND = {
  plugin: 'shared-folder',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: another session in the folder shows up, and this one publishes itself`, async ($, on) => {
    // A second session already wrote its row to the shared store.
    const other = { id: 'other', prompt: 'fix the navbar', isWorking: true, doing: 'Editing navbar.tsx', at: 1000, ended: false }
    // The store by hand, so the test can read what this session wrote.
    const written = new Map<string, unknown>([[peerKey('/project', 'other'), other]])
    on('store.get', (_, e) => ({ value: written.get(e.key) }))
    on('store.keys', () => ({ value: [...written.keys()] }))
    on('store.set', (_, e) => {
      written.set(e.key, e.value)
      return { value: undefined }
    })
    mock.clock(on, { now: 2000 })
    on('ui.render', ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box />
    })
    on('command.register', () => ({ value: { command: 'shared' } }))
    on('session.cwd', () => ({ value: '/project' }))
    on('session.id', () => ({ value: 'me' }))
    on('ui.status', () => ({ value: undefined }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('prompt.submit', (_, e) => ({ text: e.text }))

    await $.session.start({ cwd: '/project', surface, isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: /Also working in this folder/ })).toBeTruthy()
    expect(await ui.find({ text: /fix the navbar/ })).toBeTruthy()
    expect(await ui.find({ text: /Editing navbar.tsx/ })).toBeTruthy()

    // What this session asks becomes visible to the other one.
    await $.prompt.submit({ text: 'add dark mode' })
    expect(written.get(peerKey('/project', 'me'))).toMatchObject({ prompt: 'add dark mode', isWorking: true })
    expect((await $.command.run({ command: 'shared', args: '' })).text).toContain('fix the navbar')

    await ui.press({ key: 'hide' })
    expect(await ui.find({ text: /Also working in this folder/ })).toBeFalsy()
    await ui.unmount()
  })
}

test('a session alone in its folder shows nothing', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 0 })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('command.register', () => ({ value: { command: 'shared' } }))
  on('session.cwd', () => ({ value: '/project' }))
  on('session.id', () => ({ value: 'me' }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true })
  expect((await $.command.run({ command: 'shared', args: '' })).text).toBe('No other sessions are working in this folder.')
})
