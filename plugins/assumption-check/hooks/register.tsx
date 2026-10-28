import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Assumption } from '../types'
import { addAssumption, correction, pending, setVerdict } from './review'

const TOOL = 'mcp__assumption-check__anotar_supuesto'
const review = atom(
  { plugin: 'assumption-check', key: 'review' } as const,
  { list: [], isOpen: false, editing: 0, draft: '' },
  { shape: 'review-1' },
)

const RULE =
  'Each time you make an assumption the person did not state (a default, a scope choice, a data shape, a design decision, a name), ' +
  'call the anotar_supuesto tool once with that assumption in one short Spanish sentence and a 1-3 word topic, then keep working. ' +
  'Do not ask about it and do not stop: the person reviews them later. Skip trivial choices.'

async function markWrong($: EngineInterface, a: Assumption, fix: string): Promise<void> {
  if (!fix.trim()) return
  await update($, review, r => ({ ...r, list: setVerdict(r.list, a.n, 'wrong', fix), editing: 0, draft: '' }))
  await $.prompt.submit({ text: correction({ ...a, fix }), asUser: true })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'anotar_supuesto',
      description: `Log an assumption you just made so the person can review it later. ${RULE}`,
      inputSchema: {
        type: 'object',
        properties: {
          supuesto: { type: 'string', description: 'The assumption, one short sentence in Spanish.' },
          tema: { type: 'string', description: 'What it is about, 1-3 words (e.g. "categorías", "estado inicial").' },
        },
        required: ['supuesto'],
      },
      isDeferred: false,
    })
    await $.command.register({ name: 'supuestos', description: 'Abre o cierra la revisión de supuestos' })
    return next(e)
  })

  // Also in the system prompt; the tool description carries the rule if this hook is skipped.
  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    return { sections: [...out.sections, { id: 'assumption-check:regla', text: RULE, scope: 'session' }] }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    if (e.agentId) return { result: 'ok' }
    const input = e as unknown as { supuesto?: string; tema?: string }
    await update($, review, r => ({ ...r, list: addAssumption(r.list, input.supuesto ?? '', input.tema ?? '') }))
    return { result: 'anotado' }
  })

  on('command.run', { command: 'supuestos' }, async $ => {
    const { isOpen } = await read($, review)
    await update($, review, r => ({ ...r, isOpen: !isOpen }))
    return { text: isOpen ? 'Revisión cerrada.' : 'Revisión abierta, arriba del cuadro de texto.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { list, isOpen, editing, draft } = await read($, review)
    if (list.length === 0) return next(e)
    const todo = pending(list)
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const toggle = () => void update($, review, r => ({ ...r, isOpen: !r.isOpen }))
    const header = (
      <Box flexDirection="row" flexWrap="wrap" gap={1} marginBottom={1}>
        <Text color={todo.length ? 'yellow' : 'green'}>{todo.length ? '◆' : '✓'}</Text>
        <Text>{todo.length ? `${todo.length} supuestos para revisar (${list.length} en total)` : `Todos revisados (${list.length})`}</Text>
        <Button key="abrir" plain dimColor label={isOpen ? '[-] cerrar' : 'abrir'} onPress={toggle} />
      </Box>
    )
    // Keep other mods' rows (like the idea shelf) drawn below ours.
    const below = await next(e)
    const a = todo[0]
    if (!isOpen || !a) {
      return (
        <Box flexDirection="column">
          {header}
          {below}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" borderStyle="round" paddingX={1} marginBottom={1}>
          <Text bold color="yellow">{`? #${a.n} ${a.text}`}</Text>
          {a.topic ? <Text dimColor>{a.topic}</Text> : null}
          <Box flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>
            <Button
              key={`bien-${a.n}`}
              label="✓ Bien"
              onPress={() => void update($, review, r => ({ ...r, list: setVerdict(r.list, a.n, 'right'), editing: 0, draft: '' }))}
            />
            <Button key={`mal-${a.n}`} label="✗ Mal" onPress={() => void update($, review, r => ({ ...r, editing: a.n, draft: '' }))} />
          </Box>
          {editing === a.n ? (
            <Box marginTop={1}>
              <Input
                key={`fix-${a.n}`}
                placeholder="¿Cómo debería ser?"
                submitLabel="enviar"
                value={draft}
                onInput={(v: string) => void update($, review, r => ({ ...r, draft: v }))}
                onSubmit={(v: string) => void markWrong($, a, v)}
              />
            </Box>
          ) : null}
        </Box>
        {header}
        {below}
      </Box>
    )
  })
}
