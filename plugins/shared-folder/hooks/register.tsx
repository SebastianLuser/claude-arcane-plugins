import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Peer } from '../types'
import { clip, describeCall, isPeer, othersOf, peerKey, prefixOf } from './peers'

const folder = atom({ plugin: 'shared-folder', key: 'folder' } as const, { others: [], isHidden: false }, { shape: 'folder-1' })
const EVERY_MS = 5_000

// Each session writes only its own key, so sessions never overwrite each other.
// shortcut: assumes $.store reads its file fresh on every get; if sessions don't see each other, move to files under ~/.claude.
let me: { cwd: string; id: string; prompt: string; isWorking: boolean; doing: string } | null = null

async function publish($: EngineInterface, ended = false): Promise<void> {
  if (!me) return
  const row: Peer = { id: me.id, prompt: me.prompt, isWorking: me.isWorking, doing: me.doing, at: await $.clock.now(), ended }
  await $.store.set(peerKey(me.cwd, me.id), row)
}

async function refresh($: EngineInterface): Promise<void> {
  if (!me) return
  const prefix = prefixOf(me.cwd)
  const keys = (await $.store.keys()).filter(k => k.startsWith(prefix))
  const rows = (await Promise.all(keys.map(k => $.store.get(k)))).filter(isPeer)
  const others = othersOf(rows, me.id, await $.clock.now())
  await update($, folder, f => ({ ...f, others }))
  $.ui.status(others.length ? `👥 ${others.length} other ${others.length === 1 ? 'session' : 'sessions'} in this folder` : undefined)
}

const details = (others: Peer[]): string =>
  others.length === 0
    ? 'No other sessions are working in this folder.'
    : others
        .map(p => `${p.isWorking ? '● working' : '○ waiting'} · ${clip(p.prompt, 200) || '(no prompt yet)'}${p.doing ? `\n   ◆ ${p.doing}` : ''}`)
        .join('\n')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'shared', description: 'Show what the other sessions in this folder are doing; /shared hide or show' })
    me = { cwd: await $.session.cwd(), id: await $.session.id(), prompt: '', isWorking: false, doing: '' }
    await publish($)
    await refresh($)
    $.clock.every(EVERY_MS, () => void publish($).then(() => refresh($)))
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (me && e.text.trim() && !e.text.trim().startsWith('/')) {
      me.prompt = clip(e.text, 200)
      me.isWorking = true
      me.doing = ''
      await publish($)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (me && !e.agentId) {
      me.doing = describeCall(e.tool, e as unknown as Record<string, unknown>)
      void publish($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (me) {
      me.isWorking = false
      me.doing = ''
      await publish($)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await publish($, true)
    return next(e)
  })

  on('command.run', { command: 'shared' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    if (arg === 'hide' || arg === 'show') {
      await update($, folder, f => ({ ...f, isHidden: arg === 'hide' }))
      return { text: arg === 'hide' ? 'Notice hidden.' : 'Notice shown.' }
    }
    await refresh($)
    return { text: details((await read($, folder)).others) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { others, isHidden } = await read($, folder)
    const below = await next(e)
    if (isHidden || others.length === 0) return below
    const { Box, Text, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" borderStyle="round" paddingX={1} marginBottom={1}>
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            <Text bold>👥 Also working in this folder</Text>
            <Text dimColor>· /shared for details</Text>
            <Box flexGrow={1} />
            <Button key="hide" plain dimColor label="hide" onPress={() => void update($, folder, f => ({ ...f, isHidden: true }))} />
          </Box>
          {others.map(p => (
            <Box key={p.id} flexDirection="column">
              <Text>
                <Text color={p.isWorking ? 'yellow' : 'gray'}>{p.isWorking ? '● ' : '○ '}</Text>
                <Text bold>{clip(p.prompt) || '(no prompt yet)'}</Text>
                <Text dimColor>{p.isWorking ? ' · working' : ' · waiting'}</Text>
              </Text>
              {p.doing ? <Text color="yellow">{`   ◆ ${p.doing}`}</Text> : null}
            </Box>
          ))}
        </Box>
        {below}
      </Box>
    )
  })
}
