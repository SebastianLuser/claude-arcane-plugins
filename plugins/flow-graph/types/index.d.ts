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
  /** Optional: agents stored before these fields existed lack them. */
  model?: string | null
  /** The Agent tool's short description, when it says more than the name. */
  task?: string | null
  startedAt?: number
  endedAt?: number | null
  /** The start of the agent's final answer. */
  result?: string | null
  /** Why it ended, when not with an answer: aborted, refusal or error. */
  failure?: string | null
}

export type Run = {
  id: string
  runId: string | null
  name: string
  startedAt: number
  agents: AgentNode[]
}

export type LoopStage = 'wake' | 'work' | 'schedule' | 'wait'

export type Round = {
  round: number
  at: number
  /** How long the round's turn took; null while it works. */
  ms: number | null
}

export type Loop = {
  stage: LoopStage
  round: number
  nextAt: number | null
  cron: string | null
  isStopped?: true
  /** What each round runs: the cron job's or the wakeup's prompt. */
  prompt?: string | null
  /** The latest rounds, oldest first. */
  rounds?: Round[]
}

export type Flow = {
  runs: Run[]
  loop: Loop | null
}

declare module 'claude-code' {
  interface PluginState {
    'flow-graph': {
      flow: Flow
      /** Agents whose whole result is shown, as `<run id>|<agent index>`. */
      expanded: string[]
    }
  }
}
