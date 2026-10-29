import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'prompt-enhancer',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: Enhance rewrites the prompt box and Send submits it`, async ($, on) => {
    on('ui.render', ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box />
    })
    let box = 'add a login'
    const asks: string[] = []
    const sent: string[] = []
    on('prompt.read', () => ({ value: { text: box } }))
    on('prompt.fill', (_, e) => {
      box = e.text
      return { isFilled: true }
    })
    on('prompt.submit', (_, e) => {
      sent.push(e.text)
      return { text: e.text }
    })
    // No conversation to fork yet: the mod falls back to a plain model call.
    on('model.fork', () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }))
    on('session.cwd', () => ({ value: '/project' }))
    on('fs.read', () => {
      throw new Error('no CLAUDE.md')
    })
    on('model.complete', (_, e) => {
      asks.push(String(e.prompt))
      return { value: { isAnswered: true, text: 'Build a login page with email and password.' } }
    })

    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'enhance' })
    expect(asks[0]).toContain('add a login')
    expect(box).toBe('Build a login page with email and password.')
    expect(await ui.find({ text: /Enhanced: review it/ })).toBeTruthy()

    await ui.press({ key: 'send' })
    expect(sent).toEqual(['Build a login page with email and password.'])
    expect(box).toBe('')
    await ui.unmount()
  })
}

test('an empty prompt box asks for text first', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('prompt.read', () => ({ value: { text: '  ' } }))
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'enhance' })
  expect(await ui.find({ text: /Type something in the prompt box first/ })).toBeTruthy()
  await ui.unmount()
})
