export type Status = 'running' | 'ok' | 'error'

export type ChildKind = 'skill' | 'mcp'

export type Child = {
  kind: ChildKind
  name: string
  calls: number
}

export type AgentNode = {
  agentId: string | null
  index: number
  name: string
  status: Status
  children: Child[]
  counts: Record<string, number>
}

export type Run = {
  id: string
  runId: string | null
  name: string
  startedAt: number
  agents: AgentNode[]
}

export type LoopStage = 'wake' | 'work' | 'schedule' | 'wait'

export type Loop = {
  stage: LoopStage
  round: number
  nextAt: number | null
  cron: string | null
}

export type Flow = {
  runs: Run[]
  loop: Loop | null
}

declare module 'claude-code' {
  interface PluginState {
    'flow-graph': {
      flow: Flow
    }
  }
}
