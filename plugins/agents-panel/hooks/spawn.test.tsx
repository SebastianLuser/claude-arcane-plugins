import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'agents-panel'
const pane = { title: '', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const

const spawn = (id: string, description: string) =>
  ({ tool_use_id: `tu-${id}`, prompt: 'p', description, subagentType: 'general-purpose' }) as never

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: every subagent opens the panel and shows its latest tool call`, async ($, on) => {
    const opened: string[] = []
    mock.clock(on, { now: 0 })
    on('ui.open', (_$, e) => {
      opened.push(e.id ?? '')
      return { value: { isPlaced: true } }
    })
    on('agent.spawn', (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: `agent-${e.tool_use_id}` }))
    on('tool.call', () => ({ result: {} }))

    await $.agent.spawn(spawn('1', 'Find the bug'))
    await $.tool.call({ tool: 'Read', file_path: 'C:/repo/src/register.tsx', agentId: 'agent-tu-1' } as never)
    // A second subagent opens it again, as if the person had closed it in between.
    await $.agent.spawn(spawn('2', 'Write the test'))
    expect(opened).toEqual(['savvy-agents', 'savvy-agents'])

    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'savvy-agents', props: pane })
    const drawn =
      surface === 'desktop'
        ? (await ui.findAll({ type: 'Svg' })).map(el => String(el.props.source)).join('')
        : JSON.stringify(await ui.findAll({ type: 'Text' }), (k, v) => (k === 'parent' ? undefined : v))
    expect(drawn).toContain('Read · register.tsx')
  })
}
