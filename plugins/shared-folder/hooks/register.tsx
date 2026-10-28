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
  $.ui.status(others.length ? `👥 ${others.length} ${others.length === 1 ? 'otra sesión' : 'otras sesiones'} en esta carpeta` : undefined)
}

const details = (others: Peer[]): string =>
  others.length === 0
    ? 'No hay otras sesiones trabajando en esta carpeta.'
    : others
        .map(p => `${p.isWorking ? '● trabajando' : '○ esperando'} · ${clip(p.prompt, 200) || '(sin pedido todavía)'}${p.doing ? `\n   ◆ ${p.doing}` : ''}`)
        .join('\n')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'compartida', description: 'Muestra qué hacen las otras sesiones de esta carpeta; /compartida ocultar o mostrar' })
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

  on('command.run', { command: 'compartida' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    if (arg === 'ocultar' || arg === 'mostrar') {
      await update($, folder, f => ({ ...f, isHidden: arg === 'ocultar' }))
      return { text: arg === 'ocultar' ? 'Aviso oculto.' : 'Aviso visible.' }
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
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Box flexDirection="row" gap={1}>
            <Text bold>👥 También trabajando en esta carpeta</Text>
            <Text dimColor>· /compartida para el detalle</Text>
            <Box flexGrow={1} />
            <Button key="ocultar" plain dimColor label="ocultar" onPress={() => void update($, folder, f => ({ ...f, isHidden: true }))} />
          </Box>
          {others.map(p => (
            <Box key={p.id} flexDirection="column">
              <Text>
                <Text color={p.isWorking ? 'yellow' : 'gray'}>{p.isWorking ? '● ' : '○ '}</Text>
                <Text bold>{clip(p.prompt) || '(sin pedido todavía)'}</Text>
                <Text dimColor>{p.isWorking ? ' · trabajando' : ' · esperando'}</Text>
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
