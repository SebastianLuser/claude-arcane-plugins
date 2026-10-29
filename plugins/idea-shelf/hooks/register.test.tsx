import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'idea-shelf',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: /idea saves an idea, the band shows it and Send submits it`, async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 1000 })
    on('command.register', () => ({ value: { command: 'idea' } }))
    on('session.cwd', () => ({ value: '/project' }))
    on('ui.status', () => ({ value: undefined }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    // Stands for the engine's own rows under the band.
    on('ui.render', ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box />
    })
    const sent: string[] = []
    on('prompt.submit', (_, e) => {
      sent.push(e.text)
      return { text: e.text }
    })

    await $.session.start({ cwd: '/project', surface, isInteractive: true })
    expect(await $.command.run({ command: 'idea', args: 'dark mode' })).toMatchObject({ text: '💡 Saved. 1 on the shelf.' })

    // Closed by default: nothing drawn until /idea opens it.
    const closed = await $.ui.mount({ ...BAND, surface })
    expect(await closed.find({ text: /dark mode/ })).toBeFalsy()
    await closed.unmount()

    expect(await $.command.run({ command: 'idea', args: '' })).toMatchObject({ text: 'Shelf open, above the prompt box.' })
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'dark mode' })).toBeTruthy()

    // The input saves a second one.
    await ui.input({ key: 'new', text: 'navbar tests' })
    expect(await ui.find({ type: 'Text', text: 'navbar tests' })).toBeTruthy()

    const send = (await ui.findAll({ type: 'Button', text: 'Send' }))[0]
    await ui.press({ key: String(send?.key) })
    expect(sent).toEqual(['dark mode'])
    expect(await ui.find({ type: 'Text', text: 'dark mode' })).toBeFalsy()
    await ui.unmount()
  })
}
