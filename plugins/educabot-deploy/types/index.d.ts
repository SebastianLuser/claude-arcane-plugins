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

export type Report = {
  repo: string
  branch: string
  base: string
  migrations: string[]
  mode: MigrationMode | null
  vars: NewVar[]
  tables: TableChange[]
  skipped: number
}

declare module 'claude-code' {
  interface PluginState {
    'educabot-deploy': {
      report: Report | null
      error: string | null
      isLoading: boolean
    }
  }
}
