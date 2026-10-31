import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'flow-graph',
  component: 'Pane',
  requestId: 'flow-graph',
  props: {
    title: 'Flows',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const SCRIPT = "export const meta = { name: 'review-changes', description: 'do not show this' }\nawait agent('secret prompt')"

function standInEngine(on: On, now = 0): string[] {
  const opened: string[] = []
  mock.store(on, {})
  mock.clock(on, { now })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'flow' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id ?? '')
    return { value: { isPlaced: true } }
  })
  on('tool.call', () => ({ result: {} }))
  on('agent.spawn', (_, e) => ({ model: 'claude-sonnet-5-5', agentId: `agent-${e.workflow?.agentIndex ?? 0}` }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('skill.prompt', (_, e) => ({ text: e.text }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return opened
}

function spawn(index: number) {
  return {
    tool_use_id: 'toolu_wf',
    prompt: 'secret prompt',
    description: ['bugs', 'perf', 'security'][index - 1],
    subagentType: 'general-purpose',
    workflow: { runId: 'wf_1', agentIndex: index },
  } as never
}

function finish(agentId: string | undefined, reason: 'answer' | 'error') {
  return { reason, answer: 'secret answer', durationMs: 1, isAborted: false, turnId: 't', agentId } as never
}

test('should open the pane and draw one colored node per agent when a workflow runs', async ($, on) => {
  // Arrange
  const opened = standInEngine(on)
  await $.session.start({ cwd: 'C:/repo', surface: 'desktop', isInteractive: true })

  // Act
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'toolu_wf', script: SCRIPT } as never)
  for (const index of [1, 2, 3]) await $.agent.spawn(spawn(index))
  await $.tool.call({ tool: 'Skill', skill: 'code-review', agentId: 'agent-1' } as never)
  await $.tool.call({ tool: 'mcp__github__get_pr', agentId: 'agent-2' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'agent-2' } as never)
  await $.turn.complete(finish('agent-1', 'answer'))
  await $.turn.complete(finish('agent-3', 'error'))

  // Assert
  expect(opened).toEqual(['flow-graph'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svg = String((await ui.find({ type: 'Svg' }))?.props.source ?? '')
  expect(svg).toContain('review-changes')
  expect(svg).toContain('1. bugs')
  expect(svg).toContain('2. perf')
  expect(svg).toContain('3. security')
  expect(svg).toContain('skill · code-review')
  expect(svg).toContain('MCP · github')
  expect(svg).toContain('Bash ×1')
  expect(svg).toContain('2/3 agents · running')
  expect(svg).not.toContain('secret')
  expect(svg).not.toContain('do not show this')
  await ui.unmount()
})

test('should show the agents as text in the terminal', async ($, on) => {
  // Arrange
  standInEngine(on)
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'toolu_wf', script: SCRIPT } as never)
  await $.agent.spawn(spawn(1))

  // Act
  await $.turn.complete(finish('agent-1', 'error'))

  // Assert
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /1\. bugs/ }))?.props.color).toBe('error')
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  await ui.unmount()
})

test('should move the loop marker through its four stages and count rounds', async ($, on) => {
  // Arrange
  const opened = standInEngine(on)
  await $.session.start({ cwd: 'C:/repo', surface: 'desktop', isInteractive: true })
  const stageNow = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const svg = String((await ui.find({ type: 'Svg' }))?.props.source ?? '')
    await ui.unmount()
    return svg
  }

  // Act + Assert, one stage at a time
  await $.tool.call({ tool: 'ScheduleWakeup', delaySeconds: 60, prompt: 'check', reason: 'r' } as never)
  expect(opened).toEqual(['flow-graph'])
  expect(await stageNow()).toContain('current stage: schedule')

  await $.turn.complete(finish(undefined, 'answer'))
  expect(await stageNow()).toContain('current stage: wait')

  await $.prompt.submit({ text: 'check', origin: { kind: 'scheduled-trigger' } } as never)
  const woke = await stageNow()
  expect(woke).toContain('current stage: wake')
  expect(woke).toContain('round 2')

  await $.turn.start({ text: 'check', turnId: 't2' })
  expect(await stageNow()).toContain('current stage: work')

  await $.tool.call({ tool: 'ScheduleWakeup', stop: true } as never)
  const ended = await stageNow()
  expect(ended).not.toContain('current stage')
  expect(ended).toContain('after 2 rounds')
})

test('should open the pane on round 1 as soon as /loop starts', async ($, on) => {
  const opened = standInEngine(on)
  await $.session.start({ cwd: 'C:/repo', surface: 'desktop', isInteractive: true })

  await $.skill.prompt({ skill: 'loop', text: 'Run the loop.' })

  expect(opened).toEqual(['flow-graph'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svg = await ui.find({ type: 'Svg' })
  expect(svg?.props.isInteractive).toBe(true)
  expect(String(svg?.props.source)).toContain('round 1')
  expect(String(svg?.props.source)).toContain('current stage: work')
  await ui.unmount()
})

test('should open the pane on the first agent of a workflow it never saw launched', async ($, on) => {
  const opened = standInEngine(on)
  await $.session.start({ cwd: 'C:/repo', surface: 'desktop', isInteractive: true })

  for (const index of [1, 2]) await $.agent.spawn(spawn(index))

  expect(opened).toEqual(['flow-graph'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(String((await ui.find({ type: 'Svg' }))?.props.source)).toContain('2. perf')
  await ui.unmount()
})

test('should show the next time on every round of a fixed-interval loop', async ($, on) => {
  // Arrange
  const opened = standInEngine(on, new Date(2026, 9, 29, 14, 2).getTime())
  await $.session.start({ cwd: 'C:/repo', surface: 'desktop', isInteractive: true })
  const pane = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const svg = String((await ui.find({ type: 'Svg' }))?.props.source ?? '')
    await ui.unmount()
    return svg
  }

  // Act
  await $.tool.call({ tool: 'CronCreate', cron: '*/5 * * * *', prompt: 'check' } as never)
  const scheduled = await pane()
  await $.turn.complete(finish(undefined, 'answer'))
  const waiting = await pane()

  // Assert
  expect(opened).toEqual(['flow-graph'])
  expect(scheduled).toContain('current stage: schedule')
  expect(scheduled).toContain('next ~14:05')
  expect(waiting).toContain('current stage: wait')
  expect(waiting).toContain('next ~14:05')
})

test('should not draw a loop for a one-shot reminder or a scheduled prompt it never saw scheduled', async ($, on) => {
  // Arrange
  const opened = standInEngine(on)
  await $.session.start({ cwd: 'C:/repo', surface: 'desktop', isInteractive: true })

  // Act
  await $.tool.call({ tool: 'CronCreate', cron: '30 14 29 10 *', prompt: 'remind', recurring: false } as never)
  await $.prompt.submit({ text: 'routine', origin: { kind: 'scheduled-trigger' } } as never)

  // Assert
  expect(opened).toEqual([])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  await ui.unmount()
})

test('should ignore ordinary turns and tool calls outside a workflow', async ($, on) => {
  // Arrange
  standInEngine(on)
  await $.session.start({ cwd: 'C:/repo', surface: 'desktop', isInteractive: true })

  // Act
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'stray' } as never)
  await $.turn.complete(finish(undefined, 'answer'))

  // Assert
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /No workflow or/ }))?.text).toContain('has run in this session')
  await ui.unmount()
})
