import { expect, test } from 'claude-code/testing'

import type { Peer } from '../types'
import { clip, describeCall, othersOf, peerKey, prefixOf, STALE_MS } from './peers'

const peer = (id: string, isWorking: boolean, at: number, ended = false): Peer => ({ id, prompt: id, isWorking, doing: '', at, ended })

test('filters and sorts the other sessions of the folder', async () => {
  const now = 10 * STALE_MS
  const all = [peer('me', true, now), peer('idle', false, now - 1000), peer('busy', true, now - 2000), peer('stale', true, now - STALE_MS - 1), peer('closed', true, now, true)]
  expect(othersOf(all, 'me', now).map(p => p.id)).toEqual(['busy', 'idle'])
  expect(peerKey('C:\\Users\\sebas\\Desktop\\Web\\', 'x').startsWith(prefixOf('c:/users/sebas/desktop/web'))).toBe(true)
  expect(describeCall('Edit', { file_path: 'C:\\src\\Navbar.tsx' })).toBe('Edit · Navbar.tsx')
  expect(describeCall('Bash', { command: 'npm test' })).toBe('Bash · npm test')
  expect(clip('  hello\n  world  ')).toBe('hello world')
})
