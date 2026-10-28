import type { Peer } from '../types'

// A session that has not written for this long is treated as gone (closed without saying so).
export const STALE_MS = 30 * 60 * 1000

export const folderKey = (cwd: string): string => cwd.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
export const peerKey = (cwd: string, id: string): string => `ses|${folderKey(cwd)}|${id}`
export const prefixOf = (cwd: string): string => `ses|${folderKey(cwd)}|`

export const isPeer = (v: unknown): v is Peer =>
  !!v && typeof v === 'object' && typeof (v as Peer).id === 'string' && typeof (v as Peer).at === 'number'

// The other live sessions of this folder, the working ones first.
export const othersOf = (all: Peer[], selfId: string, now: number): Peer[] =>
  all
    .filter(p => p.id !== selfId && !p.ended && now - p.at < STALE_MS)
    .sort((a, b) => Number(b.isWorking) - Number(a.isWorking) || b.at - a.at)

// "Edit · Navbar.tsx" from a tool call's name and input.
export const describeCall = (tool: string, input: Record<string, unknown>): string => {
  const path = input.file_path ?? input.path ?? input.notebook_path
  if (typeof path === 'string') return `${tool} · ${path.replaceAll('\\', '/').split('/').pop()}`
  if (typeof input.command === 'string') return `${tool} · ${input.command.slice(0, 60)}`
  if (typeof input.description === 'string') return `${tool} · ${input.description.slice(0, 60)}`
  return tool
}

export const clip = (text: string, max = 80): string => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}
