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
}

export type NewVar = {
  name: string
  file: string
  target: string | null
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
}

declare module 'claude-code' {
  interface PluginState {
    'deploy-runbook': {
      report: Report | null
      error: string | null
      isLoading: boolean
      /** Checked steps, as `<branch>|<step id>`. */
      done: string[]
    }
  }
}
