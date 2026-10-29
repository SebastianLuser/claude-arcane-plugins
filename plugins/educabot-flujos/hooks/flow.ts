import type { AgentNode, Child, ChildKind, Flow, Loop, Run, Status } from '../types'

const MAX_RUNS = 5
const MAX_NAME = 40

export const EMPTY: Flow = { runs: [], loop: null }

export type ToolKind = { kind: ChildKind; name: string } | { kind: 'count'; name: string }

export function classifyTool(tool: string, skill: unknown): ToolKind {
  if (tool === 'Skill' && typeof skill === 'string' && skill) return { kind: 'skill', name: skill }
  const mcp = /^mcp__(.+?)__/.exec(tool)
  if (mcp) return { kind: 'mcp', name: mcp[1]! }
  return { kind: 'count', name: tool }
}

// Only the name: `meta.name` of an inline script, or the saved workflow's name. Never the script body.
export function workflowName(input: { name?: unknown; script?: unknown; scriptPath?: unknown }): string {
  if (typeof input.name === 'string' && input.name) return clip(input.name)
  if (typeof input.script === 'string') {
    const meta = /export\s+const\s+meta\s*=\s*\{[\s\S]*?\bname\s*:\s*['"`]([^'"`]+)['"`]/.exec(input.script)
    if (meta) return clip(meta[1]!)
  }
  if (typeof input.scriptPath === 'string' && input.scriptPath) {
    const file = input.scriptPath.replace(/\\/g, '/').split('/').pop() ?? ''
    if (file) return clip(file.replace(/\.[^.]+$/, ''))
  }
  return 'workflow'
}

export function clip(text: string, max = MAX_NAME): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function startRun(flow: Flow, id: string, name: string, at: number): Flow {
  const run: Run = { id, runId: null, name, startedAt: at, agents: [] }
  return { ...flow, runs: [...flow.runs.filter(r => r.id !== id), run].slice(-MAX_RUNS) }
}

export type Spawn = { toolUseId: string; runId: string; index: number; agentId: string | null; name: string; at: number }

export function addAgent(flow: Flow, spawn: Spawn): Flow {
  const owner =
    flow.runs.find(r => spawn.toolUseId && r.id === spawn.toolUseId) ??
    flow.runs.find(r => spawn.runId && r.runId === spawn.runId)
  // A resumed or server-launched run has no Workflow call this session saw: it gets its own node.
  const base = owner ? flow : startRun(flow, spawn.toolUseId || spawn.runId, 'workflow', spawn.at)
  const runKey = owner?.id ?? (spawn.toolUseId || spawn.runId)
  const agent: AgentNode = {
    agentId: spawn.agentId,
    index: spawn.index,
    name: clip(spawn.name || `agente ${spawn.index}`),
    status: 'running',
    children: [],
    counts: {},
  }
  return mapRun(base, runKey, run => ({
    ...run,
    runId: run.runId ?? (spawn.runId || null),
    agents: [...run.agents.filter(a => !(a.agentId && a.agentId === spawn.agentId)), agent].sort((a, b) => a.index - b.index),
  }))
}

export function noteTool(flow: Flow, agentId: string, tool: ToolKind): Flow {
  return mapAgent(flow, agentId, agent => {
    if (tool.kind === 'count') return { ...agent, counts: { ...agent.counts, [tool.name]: (agent.counts[tool.name] ?? 0) + 1 } }
    const name = clip(tool.name)
    const found = agent.children.find(c => c.kind === tool.kind && c.name === name)
    const children: Child[] = found
      ? agent.children.map(c => (c === found ? { ...c, calls: c.calls + 1 } : c))
      : [...agent.children, { kind: tool.kind, name, calls: 1 }]
    return { ...agent, children }
  })
}

export function finishAgent(flow: Flow, agentId: string, reason: string): Flow {
  const status: Status = reason === 'answer' ? 'ok' : 'error'
  return mapAgent(flow, agentId, agent => ({ ...agent, status }))
}

export function hasAgent(flow: Flow, agentId: string): boolean {
  return flow.runs.some(run => run.agents.some(a => a.agentId === agentId))
}

export function runStatus(run: Run): Status {
  if (run.agents.length === 0 || run.agents.some(a => a.status === 'running')) return 'running'
  return run.agents.some(a => a.status === 'error') ? 'error' : 'ok'
}

// A routine or scheduled task also fires a scheduled prompt: only a loop this session saw scheduled wakes.
export function loopWake(flow: Flow): Flow {
  return flow.loop ? setLoop(flow, { stage: 'wake', round: flow.loop.round + 1, nextAt: null }) : flow
}

export function loopWork(flow: Flow): Flow {
  return flow.loop?.stage === 'wake' ? setLoop(flow, { stage: 'work' }) : flow
}

export function loopSchedule(flow: Flow, nextAt: number | null, cron: string | null = null): Flow {
  const loop: Loop = flow.loop ?? { stage: 'schedule', round: 1, nextAt, cron }
  return { ...flow, loop: { ...loop, stage: 'schedule', nextAt, cron: cron ?? loop.cron } }
}

// A cron job re-arms itself when the turn ends, so its next time is worked out again each round.
export function loopWait(flow: Flow, now: number): Flow {
  if (!flow.loop) return flow
  const nextAt = flow.loop.cron ? nextCron(flow.loop.cron, now) : flow.loop.nextAt
  return setLoop(flow, { stage: 'wait', nextAt })
}

const CRON_RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]]

function cronField(field: string, value: number, [low, high]: [number, number]): boolean {
  return field.split(',').some(part => {
    const [range, step] = part.split('/')
    const every = step === undefined ? 1 : Number(step)
    const [from, to] = range === '*' ? [low, high] : range!.includes('-') ? range!.split('-').map(Number) : [Number(range), step === undefined ? Number(range) : high]
    return Number.isInteger(every) && every > 0 && value >= from! && value <= to! && (value - from!) % every === 0
  })
}

// Local time, minute by minute up to 8 days ahead; null for an expression it cannot read.
// shortcut: day-of-month and day-of-week both restricted must both match (cron ORs them); upgrade if /loop ever emits that.
export function nextCron(cron: string, now: number): number | null {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const at = new Date(now)
  at.setSeconds(0, 0)
  for (let i = 0; i < 8 * 24 * 60; i++) {
    at.setMinutes(at.getMinutes() + 1)
    const values = [at.getMinutes(), at.getHours(), at.getDate(), at.getMonth() + 1, at.getDay()]
    if (values.every((value, f) => cronField(fields[f]!, value, CRON_RANGES[f]!))) return at.getTime()
  }
  return null
}

export function loopStop(flow: Flow): Flow {
  return { ...flow, loop: null }
}

function setLoop(flow: Flow, patch: Partial<Loop>): Flow {
  return flow.loop ? { ...flow, loop: { ...flow.loop, ...patch } } : flow
}

function mapRun(flow: Flow, id: string, change: (run: Run) => Run): Flow {
  return { ...flow, runs: flow.runs.map(run => (run.id === id ? change(run) : run)) }
}

function mapAgent(flow: Flow, agentId: string, change: (agent: AgentNode) => AgentNode): Flow {
  if (!hasAgent(flow, agentId)) return flow
  return {
    ...flow,
    runs: flow.runs.map(run => ({ ...run, agents: run.agents.map(a => (a.agentId === agentId ? change(a) : a)) })),
  }
}
