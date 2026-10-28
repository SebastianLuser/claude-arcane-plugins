import { expect, test } from 'claude-code/testing'

import type { Peer } from '../types'
import { clip, describeCall, othersOf, peerKey, prefixOf, STALE_MS } from './peers'

const peer = (id: string, isWorking: boolean, at: number, ended = false): Peer => ({ id, prompt: id, isWorking, doing: '', at, ended })

test('filtra y ordena las otras sesiones de la carpeta', async () => {
  const now = 10 * STALE_MS
  const all = [peer('yo', true, now), peer('quieta', false, now - 1000), peer('activa', true, now - 2000), peer('vieja', true, now - STALE_MS - 1), peer('cerrada', true, now, true)]
  expect(othersOf(all, 'yo', now).map(p => p.id)).toEqual(['activa', 'quieta'])
  expect(peerKey('C:\\Users\\sebas\\Desktop\\Web\\', 'x').startsWith(prefixOf('c:/users/sebas/desktop/web'))).toBe(true)
  expect(describeCall('Edit', { file_path: 'C:\\src\\Navbar.tsx' })).toBe('Edit · Navbar.tsx')
  expect(describeCall('Bash', { command: 'npm test' })).toBe('Bash · npm test')
  expect(clip('  hola\n  mundo  ')).toBe('hola mundo')
})
