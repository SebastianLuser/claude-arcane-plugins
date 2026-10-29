import { describe, expect, test } from 'claude-code/testing'

import {
  EMPTY,
  addAgent,
  classifyTool,
  finishAgent,
  loopSchedule,
  loopStop,
  loopWait,
  loopWake,
  loopWork,
  nextCron,
  noteTool,
  runStatus,
  startRun,
  workflowName,
} from '../hooks/flow'

function spawn(index: number, agentId: string, toolUseId = 'toolu_wf') {
  return { toolUseId, runId: 'wf_1', index, agentId, name: `review ${index}`, at: 2 }
}

describe('classifyTool', () => {
  test('should make a skill node when the Skill tool names a skill', () => {
    expect(classifyTool('Skill', 'code-review')).toEqual({ kind: 'skill', name: 'code-review' })
  })

  test('should make an MCP node named after the server', () => {
    expect(classifyTool('mcp__github__create_issue', undefined)).toEqual({ kind: 'mcp', name: 'github' })
  })

  test('should count every other tool', () => {
    expect(classifyTool('Bash', undefined)).toEqual({ kind: 'count', name: 'Bash' })
    expect(classifyTool('Skill', '')).toEqual({ kind: 'count', name: 'Skill' })
  })
})

describe('workflowName', () => {
  test('should read meta.name from an inline script and nothing else', () => {
    const script = "export const meta = {\n  name: 'review-changes',\n  description: 'secret plan',\n}\nawait agent('x')"
    expect(workflowName({ script })).toBe('review-changes')
  })

  test('should prefer a saved workflow name, then the script file name', () => {
    expect(workflowName({ name: 'nightly', script: "export const meta = { name: 'other' }" })).toBe('nightly')
    expect(workflowName({ scriptPath: 'C:\\x\\wf\\triage.js' })).toBe('triage')
    expect(workflowName({})).toBe('workflow')
  })
})

describe('workflow runs', () => {
  test('should hang three agents under the run in their order', () => {
    let flow = startRun(EMPTY, 'toolu_wf', 'review-changes', 1)
    flow = addAgent(flow, spawn(3, 'a3'))
    flow = addAgent(flow, spawn(1, 'a1'))
    flow = addAgent(flow, spawn(2, 'a2'))
    expect(flow.runs).toHaveLength(1)
    expect(flow.runs[0]!.runId).toBe('wf_1')
    expect(flow.runs[0]!.agents.map(a => a.agentId)).toEqual(['a1', 'a2', 'a3'])
    expect(runStatus(flow.runs[0]!)).toBe('running')
  })

  test('should find the run by runId when the spawn carries no tool call id', () => {
    let flow = addAgent(startRun(EMPTY, 'toolu_wf', 'w', 1), spawn(1, 'a1'))
    flow = addAgent(flow, spawn(2, 'a2', ''))
    expect(flow.runs).toHaveLength(1)
    expect(flow.runs[0]!.agents).toHaveLength(2)
  })

  test('should open its own run for an agent of a run it never saw start', () => {
    const flow = addAgent(EMPTY, spawn(1, 'a1', ''))
    expect(flow.runs[0]!.name).toBe('workflow')
    expect(flow.runs[0]!.agents[0]!.agentId).toBe('a1')
  })

  test('should add skills and MCP as children and count the rest', () => {
    let flow = addAgent(startRun(EMPTY, 'toolu_wf', 'w', 1), spawn(1, 'a1'))
    flow = noteTool(flow, 'a1', classifyTool('Skill', 'simplify'))
    flow = noteTool(flow, 'a1', classifyTool('mcp__jira__search', undefined))
    flow = noteTool(flow, 'a1', classifyTool('mcp__jira__get', undefined))
    flow = noteTool(flow, 'a1', classifyTool('Bash', undefined))
    flow = noteTool(flow, 'a1', classifyTool('Bash', undefined))
    const agent = flow.runs[0]!.agents[0]!
    expect(agent.children).toEqual([
      { kind: 'skill', name: 'simplify', calls: 1 },
      { kind: 'mcp', name: 'jira', calls: 2 },
    ])
    expect(agent.counts).toEqual({ Bash: 2 })
  })

  test('should count repeat calls of a long-named MCP server on one node', () => {
    const server = `mcp__${'x'.repeat(60)}__search`
    let flow = addAgent(startRun(EMPTY, 'toolu_wf', 'w', 1), spawn(1, 'a1'))
    flow = noteTool(flow, 'a1', classifyTool(server, undefined))
    flow = noteTool(flow, 'a1', classifyTool(server, undefined))
    expect(flow.runs[0]!.agents[0]!.children).toHaveLength(1)
    expect(flow.runs[0]!.agents[0]!.children[0]!.calls).toBe(2)
  })

  test('should leave the flow alone for a tool call of an agent outside any run', () => {
    const flow = addAgent(startRun(EMPTY, 'toolu_wf', 'w', 1), spawn(1, 'a1'))
    expect(noteTool(flow, 'stray', classifyTool('Bash', undefined))).toBe(flow)
  })

  test('should mark agents ok or error and the run after its agents', () => {
    let flow = startRun(EMPTY, 'toolu_wf', 'w', 1)
    flow = addAgent(addAgent(flow, spawn(1, 'a1')), spawn(2, 'a2'))
    flow = finishAgent(flow, 'a1', 'answer')
    expect(runStatus(flow.runs[0]!)).toBe('running')
    flow = finishAgent(flow, 'a2', 'error')
    expect(flow.runs[0]!.agents.map(a => a.status)).toEqual(['ok', 'error'])
    expect(runStatus(flow.runs[0]!)).toBe('error')
  })

  test('should keep the last five runs', () => {
    let flow = EMPTY
    for (let i = 0; i < 7; i++) flow = startRun(flow, `t${i}`, `w${i}`, i)
    expect(flow.runs.map(r => r.id)).toEqual(['t2', 't3', 't4', 't5', 't6'])
  })
})

describe('nextCron', () => {
  test('should find the next match for the expressions /loop and reminders use', () => {
    const at = new Date(2026, 9, 29, 14, 2, 30).getTime()
    expect(nextCron('*/5 * * * *', at)).toBe(new Date(2026, 9, 29, 14, 5).getTime())
    expect(nextCron('7 * * * *', at)).toBe(new Date(2026, 9, 29, 14, 7).getTime())
    expect(nextCron('3 9 * * *', at)).toBe(new Date(2026, 9, 30, 9, 3).getTime())
    expect(nextCron('0 9 * * 1-5', at)).toBe(new Date(2026, 9, 30, 9, 0).getTime())
  })

  test('should give null for an expression it cannot read', () => {
    expect(nextCron('every 5 minutes', 0)).toBeNull()
    expect(nextCron('*/0 * * * *', 0)).toBeNull()
  })
})

describe('loop stages', () => {
  test('should go wake, work, schedule, wait and count rounds', () => {
    let flow = loopSchedule(EMPTY, 60_000)
    expect(flow.loop).toEqual({ stage: 'schedule', round: 1, nextAt: 60_000, cron: null })
    flow = loopWait(flow, 1)
    expect(flow.loop).toEqual({ stage: 'wait', round: 1, nextAt: 60_000, cron: null })
    flow = loopWake(flow)
    expect(flow.loop).toEqual({ stage: 'wake', round: 2, nextAt: null, cron: null })
    flow = loopWork(flow)
    expect(flow.loop?.stage).toBe('work')
    flow = loopSchedule(flow, 120_000)
    expect(flow.loop).toEqual({ stage: 'schedule', round: 2, nextAt: 120_000, cron: null })
    expect(loopWait(flow, 1).loop?.stage).toBe('wait')
  })

  test('should work out the next cron time again each round when the loop is a cron job', () => {
    const start = new Date(2026, 9, 29, 14, 2).getTime()
    let flow = loopSchedule(EMPTY, nextCron('*/5 * * * *', start), '*/5 * * * *')
    expect(flow.loop?.nextAt).toBe(new Date(2026, 9, 29, 14, 5).getTime())

    flow = loopWork(loopWake(loopWait(flow, start)))
    flow = loopWait(flow, new Date(2026, 9, 29, 14, 6).getTime())

    expect(flow.loop).toEqual({ stage: 'wait', round: 2, nextAt: new Date(2026, 9, 29, 14, 10).getTime(), cron: '*/5 * * * *' })
  })

  test('should not start a loop from an ordinary turn or a scheduled prompt it never saw scheduled', () => {
    expect(loopWork(EMPTY)).toBe(EMPTY)
    expect(loopWait(EMPTY, 1)).toBe(EMPTY)
    expect(loopWake(EMPTY)).toBe(EMPTY)
  })

  test('should clear the loop when it stops', () => {
    expect(loopStop(loopSchedule(EMPTY, 1)).loop).toBeNull()
  })
})
