export type Idea = { id: string; text: string; at: number }
export type Shelf = { project: string; ideas: Idea[]; draft: string; isOpen: boolean }

declare module 'claude-code' {
  interface PluginState {
    'idea-shelf': { shelf: Shaped<Shelf> }
  }
}
