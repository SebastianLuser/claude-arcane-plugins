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

test('desktop: each new subagent wears the next costume in turn', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: `agent-${e.tool_use_id}` }))

  for (let i = 1; i <= 40; i++) await $.agent.spawn(spawn(String(i), `Task ${i}`))

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: 'savvy-agents', props: pane })
  const drawn = (await ui.findAll({ type: 'Svg' })).map(el => String(el.props.source)).join('')
  // 40 subagents, 40 different looks, none of them the bare crab.
  expect(new Set(drawn.match(/class="c-[a-z]+/g)).size).toBe(40)
  expect(drawn).not.toContain('c-other')
})
