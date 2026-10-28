export type Peer = { id: string; prompt: string; isWorking: boolean; doing: string; at: number; ended: boolean }
export type Folder = { others: Peer[]; isHidden: boolean }

declare module 'claude-code' {
  interface PluginState {
    'shared-folder': { folder: Shaped<Folder> }
  }
}
