export type Verdict = 'pending' | 'right' | 'wrong'
export type Assumption = { n: number; text: string; topic: string; verdict: Verdict; fix: string }
export type Review = { list: Assumption[]; isOpen: boolean; editing: number; draft: string }

declare module 'claude-code' {
  interface PluginState {
    'assumption-check': { review: Shaped<Review> }
  }
}
