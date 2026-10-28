import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { cleanReply, enhanceAsk } from './ask'

const enhancer = atom(
  { plugin: 'prompt-enhancer', key: 'enhancer' } as const,
  { isHidden: false, status: 'ready', note: '' },
  { shape: 'enhancer-1' },
)

async function projectNotes($: EngineInterface): Promise<string> {
  try {
    return String(await $.fs.read(`${await $.session.cwd()}/CLAUDE.md`)).slice(0, 8000)
  } catch {
    return ''
  }
}

async function enhance($: EngineInterface): Promise<void> {
  const { text } = await $.prompt.read()
  if (!text.trim()) {
    await update($, enhancer, s => ({ ...s, status: 'error', note: 'Escribí algo en el cuadro primero' }))
    return
  }
  await update($, enhancer, s => ({ ...s, status: 'working', note: '' }))
  const ask = enhanceAsk(text)
  // The fork sees this session's system prompt, so it knows the project's skills and CLAUDE.md.
  let reply = await $.model.fork({ prompt: ask })
  if (!reply.isAnswered && reply.reason === 'nothing-to-fork') {
    const notes = await projectNotes($)
    reply = await $.model.complete({
      model: 'sonnet',
      system: notes ? `Project instructions (CLAUDE.md):\n${notes}` : undefined,
      prompt: ask,
      maxTokens: 2000,
    })
  }
  if (!reply.isAnswered) {
    await update($, enhancer, s => ({ ...s, status: 'error', note: `No pude mejorarlo (${reply.reason})` }))
    return
  }
  await $.prompt.fill({ text: cleanReply(reply.text), mode: 'replace' })
  await update($, enhancer, s => ({ ...s, status: 'ready', note: 'Mejorado: revisalo y tocá Enviar' }))
}

async function send($: EngineInterface): Promise<void> {
  const { text } = await $.prompt.read()
  if (!text.trim()) return
  await $.prompt.fill({ text: '', mode: 'replace' })
  await update($, enhancer, s => ({ ...s, status: 'ready', note: '' }))
  await $.prompt.submit({ text, asUser: true })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'mejorar', description: 'Muestra u oculta la barra para mejorar el prompt antes de enviarlo' })
    return next(e)
  })

  on('command.run', { command: 'mejorar' }, async $ => {
    const { isHidden } = await read($, enhancer)
    await update($, enhancer, s => ({ ...s, isHidden: !isHidden }))
    return { text: isHidden ? 'Barra para mejorar prompts visible.' : 'Barra para mejorar prompts oculta.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { isHidden, status, note } = await read($, enhancer)
    const below = await next(e)
    if (isHidden) return below
    const { Box, Text, Button } = $.ui.resolve(e)
    const isWorking = status === 'working'

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" gap={1} marginBottom={1}>
          <Text bold>Mejorar prompt</Text>
          <Button key="mejorar" label={isWorking ? 'Mejorando…' : 'Mejorar'} onPress={() => void (isWorking ? undefined : enhance($))} />
          <Button key="enviar" label="Enviar" onPress={() => void send($)} />
          {note ? <Text dimColor={status !== 'error'} color={status === 'error' ? 'red' : undefined}>{note}</Text> : null}
        </Box>
        {below}
      </Box>
    )
  })
}
