import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'file-tree',
  component: 'Pane',
  requestId: 'file-tree',
  props: { title: 'Files', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('close and shrink only in the terminal', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('env.get', () => ({ value: undefined }))
  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await terminal.find({ key: 'button-close' })).toBeTruthy()
  expect(await terminal.find({ key: 'button-mini' })).toBeTruthy()
  await terminal.unmount()

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desktop.find({ key: 'button-close' })).toBeFalsy()
  expect(await desktop.find({ key: 'button-mini' })).toBeFalsy()
  await desktop.unmount()
})
