export type EdgeKind = 'db' | 'http' | 'lib'

export type Edge = {
  from: string
  to: string
  kind: EdgeKind
  via: string
  isExternal?: true
}

export type Graph = {
  repos: string[]
  edges: Edge[]
  scannedAt: number
}

export type Trigger = 'migration' | 'contract' | 'handler' | 'config'

export type Impact = {
  repo: string
  file: string
  trigger: Trigger
  edges: Edge[]
}

declare module 'claude-code' {
  interface PluginState {
    'service-impact': {
      graph: Shaped<Graph | null>
      alert: Impact | null
      seen: string[]
      paneRepo: string | null
      isScanning: boolean
    }
  }
}
