import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'assumption-check',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
const TOOL = 'mcp__assumption-check__log_assumption'

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: a logged assumption is reviewed, and Wrong sends the correction`, async ($, on) => {
    on('ui.render', ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box />
    })
    const sent: string[] = []
    on('prompt.submit', (_, e) => {
      sent.push(e.text)
      return { text: e.text }
    })

    const logged = await $.tool.call({ tool: TOOL, assumption: 'Categories are fixed', topic: 'categories' } as never)
    expect(logged).toMatchObject({ result: 'logged' })
    await $.tool.call({ tool: TOOL, assumption: 'Start with sample data', topic: 'initial state' } as never)

    expect(await $.command.run({ command: 'assumptions', args: '' })).toMatchObject({ text: 'Review open, above the prompt box.' })
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: /2 assumptions to review/ })).toBeTruthy()
    expect(await ui.find({ text: /#1 Categories are fixed/ })).toBeTruthy()

    await ui.press({ key: 'wrong-1' })
    await ui.input({ key: 'fix-1', text: 'users can edit them' })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('you assumed "Categories are fixed"')
    expect(sent[0]).toContain('It should be: users can edit them.')

    // The next one comes up; Right closes it out.
    expect(await ui.find({ text: /#2 Start with sample data/ })).toBeTruthy()
    await ui.press({ key: 'right-2' })
    expect(await ui.find({ text: /All reviewed \(2\)/ })).toBeTruthy()
    expect(sent).toHaveLength(1)
    await ui.unmount()
  })
}

test('a subagent call is not logged', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await $.tool.call({ tool: TOOL, assumption: 'From a subagent', agentId: 'a1' } as never)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ text: /to review/ })).toBeFalsy()
  await ui.unmount()
})
