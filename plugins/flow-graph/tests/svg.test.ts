import { describe, expect, test } from 'claude-code/testing'

import { EMPTY, addAgent, classifyTool, finishAgent, loopSchedule, loopWake, noteTool, startRun } from '../hooks/flow'
import { STATUS_COLOR, loopSvg, workflowSvg, xml } from '../hooks/svg'
import type { Run } from '../types'

function runWith(agents: number, childrenEach = 0): Run {
  let flow = startRun(EMPTY, 'toolu_wf', 'review-changes', 1)
  for (let i = 1; i <= agents; i++) {
    flow = addAgent(flow, { toolUseId: 'toolu_wf', runId: 'wf_1', index: i, agentId: `a${i}`, name: `agent ${i}`, at: 1 })
    for (let c = 0; c < childrenEach; c++) flow = noteTool(flow, `a${i}`, classifyTool('Skill', `skill-${c}`))
  }
  return flow.runs[0]!
}

describe('xml', () => {
  test('should escape markup in names', () => {
    expect(xml(`<b a="1">&'`)).toBe('&lt;b a=&quot;1&quot;&gt;&amp;&#39;')
  })
})

describe('workflowSvg', () => {
  test('should draw one node per agent with its status color and its children', () => {
    let flow = startRun(EMPTY, 'toolu_wf', 'review-changes', 1)
    flow = addAgent(flow, { toolUseId: 'toolu_wf', runId: 'wf_1', index: 1, agentId: 'a1', name: 'bugs', at: 1 })
    flow = addAgent(flow, { toolUseId: 'toolu_wf', runId: 'wf_1', index: 2, agentId: 'a2', name: 'perf', at: 1 })
    flow = noteTool(flow, 'a1', classifyTool('Skill', 'code-review'))
    flow = noteTool(flow, 'a1', classifyTool('mcp__github__get_pr', undefined))
    flow = noteTool(flow, 'a2', classifyTool('Bash', undefined))
    flow = finishAgent(flow, 'a2', 'error')
    const { source } = workflowSvg(600, flow.runs[0]!)

    expect(source).toContain('1. bugs')
    expect(source).toContain('2. perf')
    expect(source).toContain('skill · code-review')
    expect(source).toContain('MCP · github')
    expect(source).toContain('Bash ×1')
    expect(source).toContain(`stroke="${STATUS_COLOR.error}"`)
    expect(source).toContain(`stroke="${STATUS_COLOR.running}"`)
    expect(source).toContain('1/2 agents · running')
  })

  test('should escape a hostile agent name', () => {
    let flow = startRun(EMPTY, 'toolu_wf', 'w', 1)
    flow = addAgent(flow, { toolUseId: 'toolu_wf', runId: 'wf_1', index: 1, agentId: 'a1', name: '<script>x</script>', at: 1 })
    const { source } = workflowSvg(600, flow.runs[0]!)
    expect(source).not.toContain('<script>')
    expect(source).toContain('&lt;script&gt;')
  })

  test('should stay under 4096px and say how many agents it left out', () => {
    const { source, height } = workflowSvg(600, runWith(40, 3))
    expect(height).toBeLessThanOrEqual(4096)
    expect(source).toMatch(/and \d+ more agents/)
  })

  test('should say it is waiting when the run has no agents yet', () => {
    expect(workflowSvg(600, runWith(0)).source).toContain('waiting for agents')
  })
})

describe('loopSvg', () => {
  test('should mark the current stage and show the round and the next time', () => {
    const at = new Date(2026, 9, 29, 14, 30).getTime()
    const loop = loopWake(loopSchedule(EMPTY, at)).loop!
    const source = loopSvg(400, { ...loop, nextAt: at })
    expect(source).toContain('round 2')
    expect(source).toContain('next 14:30')
    expect(source).toContain('current stage: wake')
    for (const stage of ['wake', 'work', 'schedule', 'wait']) expect(source).toContain(`>${stage}<`)
  })

  test('should show a dash when the next round has no time', () => {
    expect(loopSvg(400, { stage: 'work', round: 1, nextAt: null, cron: null })).toContain('next: —')
  })

  test('should count down to the next round and say how long is left', () => {
    const source = loopSvg(400, { stage: 'wait', round: 3, nextAt: 300_000, cron: null }, 60_000)
    expect(source).toContain('dur="240s"')
    expect(source).toContain('in 4 min')
    expect(source.match(/<circle cx="[\d.]+" cy="306" r="4"/g)).toHaveLength(3)
  })

  test('should grey out a stopped loop and say how many rounds it ran', () => {
    const source = loopSvg(400, { stage: 'work', round: 4, nextAt: null, cron: null, isStopped: true }, 1)
    expect(source).toContain('loop ended')
    expect(source).toContain('after 4 rounds')
    expect(source).not.toContain('current stage')
    expect(source).not.toContain('class="orbit"')
  })

  test('should mark a cron time as approximate', () => {
    const at = new Date(2026, 9, 29, 14, 5).getTime()
    expect(loopSvg(400, { stage: 'wait', round: 1, nextAt: at, cron: '*/5 * * * *' })).toContain('next ~14:05')
  })
})
