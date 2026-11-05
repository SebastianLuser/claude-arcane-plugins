export type Column = {
  name: string
  type: string
}

export type ForeignKey = {
  column: string
  table: string
}

export type TableChange = {
  table: string
  isNew: boolean
  isDropped: boolean
  added: Column[]
  dropped: string[]
  renamed: { from: string; to: string }[]
  foreignKeys: ForeignKey[]
  /** Columns whose type changes, with the new type; left out when none does. */
  retyped?: Column[]
  /** The table's columns before this branch, read from the repo's earlier migrations; null when none created it. */
  before?: Column[] | null
}

export type SqlChanges = {
  tables: TableChange[]
  skipped: number
}

export type ModeKind = 'auto' | 'flag' | 'manual' | 'unknown' | 'declared'

export type MigrationMode = {
  kind: ModeKind
  text: string
  source: string | null
  /** The command that applies them, when the repo names one. */
  command?: string | null
}

/** A line of the branch that reads the variable. */
export type VarUse = {
  file: string
  line: number | null
  code: string
}

export type NewVar = {
  name: string
  file: string
  target: string | null
  /** New on the branch, or no longer read anywhere; absent means new. */
  status?: 'new' | 'removed'
  uses?: VarUse[]
  /** The value the code falls back to when it is unset; null when it has none. */
  fallback?: string | null
  /** Example env files that list it; their values are never read. */
  examples?: string[]
  /** The environments to load it in (or delete it from); empty when the repo names none. */
  envs?: string[]
  /** Shell commands that load or delete it, one per line. */
  command?: string | null
}

/** One migration file of the branch, explained. */
export type MigrationInfo = {
  path: string
  /** What it does, one plain sentence per change. */
  summary: string[]
  hasDown: boolean
  sql: string
}

export type RiskLevel = 'high' | 'medium'

export type Risk = {
  file: string
  level: RiskLevel
  text: string
}

/** Another repo next to this one that reads its database or calls it. */
export type Consumer = {
  repo: string
  kind: 'db' | 'http'
  file: string
}

export type BranchInfo = {
  commits: number
  files: number
  /** Commits not on the upstream yet; null when the branch has no upstream. */
  unpushed: number | null
}

export type Step = {
  id: string
  text: string
  detail: string | null
  /** What to run, one command per line. */
  command?: string | null
}

export type Report = {
  repo: string
  branch: string
  base: string
  migrations: string[]
  mode: MigrationMode | null
  vars: NewVar[]
  tables: TableChange[]
  skipped: number
  risks: Risk[]
  consumers: Consumer[]
  info: BranchInfo
  /** The environments the repo deploys to, as its config names them. */
  envs?: string[]
  details?: MigrationInfo[]
}

declare module 'claude-code' {
  interface PluginState {
    'deploy-runbook': {
      report: Report | null
      error: string | null
      isLoading: boolean
      /** Checked steps, as `<branch>|<step id>`. */
      done: string[]
      /** Open detail cards: `var:<name>`, `sql:<path>`. */
      open: string[]
    }
  }
}
