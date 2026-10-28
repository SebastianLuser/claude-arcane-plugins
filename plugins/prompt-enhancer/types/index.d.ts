export type Enhancer = { isHidden: boolean; status: 'ready' | 'working' | 'error'; note: string }

declare module 'claude-code' {
  interface PluginState {
    'prompt-enhancer': { enhancer: Shaped<Enhancer> }
  }
}
