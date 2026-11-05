import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'agents-panel'
const pane = { title: '', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: Details opens the task, its activity and its report`, async ($, on) => {
    mock.clock(on, { now: 0 })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('agent.spawn', (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: `agent-${e.tool_use_id}` }))
    on('tool.call', () => ({ result: {} }))
    on('turn.complete', () => ({ text: '' }))

    await $.agent.spawn({ tool_use_id: 'tu-1', prompt: 'Look for the flaky login test and say why it fails', description: 'Find the bug', subagentType: 'Explore' } as never)
    await $.tool.call({ tool: 'Grep', pattern: 'login', agentId: 'agent-tu-1' } as never)
    await $.turn.complete({ answer: 'The login test waits on a fixed timeout.', durationMs: 1, isAborted: false, turnId: 't', agentId: 'agent-tu-1', reason: 'answer' })

    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'savvy-agents', props: pane })
    const drawn = async () =>
      surface === 'desktop'
        ? (await ui.findAll({ type: 'Svg' })).map(el => String(el.props.source)).join('')
        : JSON.stringify(await ui.findAll({ type: 'Text' }), (k, v) => (k === 'parent' ? undefined : v))

    expect(await drawn()).not.toContain('fixed timeout')
    await ui.press({ key: 'x-agent-tu-1' })
    const open = await drawn()
    expect(open).toContain('flaky login test')
    expect(open).toContain('Grep · login')
    expect(open).toContain('fixed timeout')

    await ui.press({ key: 'x-agent-tu-1' })
    expect(await drawn()).not.toContain('fixed timeout')
  })
}
