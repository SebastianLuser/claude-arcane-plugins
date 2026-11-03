import type { AgentNode, Child, ChildKind, Flow, Loop, Round, Run, Status } from '../types'

const MAX_RUNS = 5
const MAX_NAME = 40
const MAX_TASK = 120
const MAX_RESULT = 1200
const MAX_ROUNDS = 8

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

export type Spawn = {
  toolUseId: string
  runId: string
  index: number
  agentId: string | null
  name: string
  at: number
  model?: string | null
  task?: string | null
}

export function addAgent(flow: Flow, spawn: Spawn): Flow {
  const owner =
    flow.runs.find(r => spawn.toolUseId && r.id === spawn.toolUseId) ??
    flow.runs.find(r => spawn.runId && r.runId === spawn.runId)
  // A resumed or server-launched run has no Workflow call this session saw: it gets its own node.
  const base = owner ? flow : startRun(flow, spawn.toolUseId || spawn.runId, 'workflow', spawn.at)
  const runKey = owner?.id ?? (spawn.toolUseId || spawn.runId)
  const name = clip(spawn.name || `agent ${spawn.index}`)
  const task = spawn.task ? clip(spawn.task, MAX_TASK) : null
  const agent: AgentNode = {
    agentId: spawn.agentId,
    index: spawn.index,
    name,
    status: 'running',
    children: [],
    counts: {},
    model: spawn.model ?? null,
    task: task && task !== name ? task : null,
    startedAt: spawn.at,
    endedAt: null,
    result: null,
    failure: null,
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

export function finishAgent(flow: Flow, agentId: string, reason: string, answer = '', at: number | null = null): Flow {
  const status: Status = reason === 'answer' ? 'ok' : 'error'
  const result = answer.trim() ? clip(answer, MAX_RESULT) : null
  return mapAgent(flow, agentId, agent => ({ ...agent, status, endedAt: at, result, failure: status === 'error' ? reason : null }))
}

/** How long the run has taken: until its last agent ended, or until now while one works. */
export function runMs(run: Run, now: number): number {
  const isRunning = runStatus(run) === 'running'
  const end = isRunning ? now : Math.max(run.startedAt, ...run.agents.map(a => a.endedAt ?? 0))
  return Math.max(0, end - run.startedAt)
}

export function agentMs(agent: AgentNode, now: number): number | null {
  if (agent.startedAt === undefined) return null
  return Math.max(0, (agent.endedAt ?? now) - agent.startedAt)
}

export function durationText(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/** `claude-haiku-5-5` → `haiku 5.5`; an alias stays as it is. */
export function modelText(model: string): string {
  return model.replace(/^claude-/, '').replace(/-(\d+)-(\d+)(?:[-@].*)?$/, ' $1.$2')
}

/** The common cron shapes in words; anything else as the expression itself. */
export function cronText(cron: string): string {
  const f = cron.trim().split(/\s+/)
  if (f.length !== 5) return cron
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string]
  const rest = dom === '*' && mon === '*' && dow === '*'
  const step = (field: string) => /^\*\/(\d+)$/.exec(field)?.[1]
  if (rest && hour === '*' && min === '*') return 'every minute'
  if (rest && hour === '*' && step(min)) return `every ${step(min)} min`
  if (rest && hour === '*' && /^\d+$/.test(min)) return `every hour at :${min.padStart(2, '0')}`
  if (rest && step(hour) && /^\d+$/.test(min)) return `every ${step(hour)} h`
  if (rest && /^\d+$/.test(hour) && /^\d+$/.test(min)) return `every day at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
  return cron
}

export function hasAgent(flow: Flow, agentId: string): boolean {
  return flow.runs.some(run => run.agents.some(a => a.agentId === agentId))
}

export function runStatus(run: Run): Status {
  if (run.agents.length === 0 || run.agents.some(a => a.status === 'running')) return 'running'
  return run.agents.some(a => a.status === 'error') ? 'error' : 'ok'
}

// A routine or scheduled task also fires a scheduled prompt: only a loop this session saw scheduled wakes.
export function loopWake(flow: Flow, at: number | null = null): Flow {
  if (!isLive(flow.loop)) return flow
  const round = flow.loop.round + 1
  return setLoop(flow, { stage: 'wake', round, nextAt: null, ...(at === null ? {} : { rounds: addRound(flow.loop.rounds, { round, at, ms: null }) }) })
}

function addRound(rounds: Round[] | undefined, round: Round): Round[] {
  return [...(rounds ?? []).filter(r => r.round !== round.round), round].slice(-MAX_ROUNDS)
}

export function loopWork(flow: Flow): Flow {
  return isLive(flow.loop) && flow.loop.stage === 'wake' ? setLoop(flow, { stage: 'work' }) : flow
}

// `/loop` starts working before it schedules anything: the pane shows round 1 at once.
export function loopBegin(flow: Flow, at: number | null = null): Flow {
  if (isLive(flow.loop)) return flow
  const loop: Loop = { stage: 'work', round: 1, nextAt: null, cron: null }
  return { ...flow, loop: at === null ? loop : { ...loop, rounds: [{ round: 1, at, ms: null }] } }
}

export function loopSchedule(flow: Flow, nextAt: number | null, cron: string | null = null, prompt: string | null = null, at: number | null = null): Flow {
  const fresh: Loop = { stage: 'schedule', round: 1, nextAt, cron }
  const loop: Loop = isLive(flow.loop) ? flow.loop : at === null ? fresh : { ...fresh, rounds: [{ round: 1, at, ms: null }] }
  const text = prompt ? clip(prompt, MAX_TASK) : null
  return { ...flow, loop: { ...loop, stage: 'schedule', nextAt, cron: cron ?? loop.cron, ...(text ? { prompt: text } : {}) } }
}

// A cron job re-arms itself when the turn ends, so its next time is worked out again each round.
export function loopWait(flow: Flow, now: number, ms: number | null = null): Flow {
  if (!isLive(flow.loop)) return flow
  const nextAt = flow.loop.cron ? nextCron(flow.loop.cron, now) : flow.loop.nextAt
  const rounds = flow.loop.rounds?.map(r => (r.round === flow.loop!.round && r.ms === null && ms !== null ? { ...r, ms } : r))
  return setLoop(flow, { stage: 'wait', nextAt, ...(rounds ? { rounds } : {}) })
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

// A stopped loop stays drawn, greyed, with its last round, until another one starts.
export function loopStop(flow: Flow): Flow {
  return flow.loop ? { ...flow, loop: { ...flow.loop, nextAt: null, isStopped: true } } : flow
}

export function isLive(loop: Loop | null): loop is Loop {
  return !!loop && !loop.isStopped
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
