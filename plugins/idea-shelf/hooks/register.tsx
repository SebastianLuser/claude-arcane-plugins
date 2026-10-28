import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Idea } from '../types'
import { addIdea, asIdeas, removeIdea, shelfKey } from './shelf'

const shelf = atom(
  { plugin: 'idea-shelf', key: 'shelf' } as const,
  { project: '', ideas: [], draft: '', isOpen: false },
  { shape: 'shelf-2' },
)

const showCount = ($: EngineInterface, n: number) => $.ui.status(n ? `💡 ${n} ${n === 1 ? 'guardada' : 'guardadas'}` : undefined)

// The store keeps ideas between sessions; the atom is what the band draws.
async function save($: EngineInterface, ideas: Idea[]): Promise<void> {
  const { project } = await read($, shelf)
  await $.store.set(shelfKey(project), ideas)
  await update($, shelf, s => ({ ...s, ideas }))
  showCount($, ideas.length)
}

async function add($: EngineInterface, text: string): Promise<number> {
  const { ideas } = await read($, shelf)
  const next = addIdea(ideas, text, await $.clock.now())
  await save($, next)
  return next.length
}

async function send($: EngineInterface, idea: Idea): Promise<void> {
  const { ideas } = await read($, shelf)
  await save($, removeIdea(ideas, idea.id))
  await $.prompt.submit({ text: idea.text, asUser: true })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'idea', description: 'Abre o cierra el estante de ideas; /idea <texto> guarda una idea al toque' })
    const project = await $.session.cwd()
    const ideas = asIdeas(await $.store.get(shelfKey(project)))
    await update($, shelf, s => ({ ...s, project, ideas }))
    showCount($, ideas.length)
    return next(e)
  })

  on('command.run', { command: 'idea' }, async ($, e) => {
    const text = (e.args ?? '').trim()
    if (!text) {
      const { isOpen } = await read($, shelf)
      await update($, shelf, s => ({ ...s, isOpen: !isOpen }))
      return { text: isOpen ? 'Estante cerrado.' : 'Estante abierto, arriba del cuadro de texto.' }
    }
    const count = await add($, text)
    return { text: `💡 Guardada. Hay ${count} en el estante.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { ideas, draft, isOpen } = await read($, shelf)
    if (!isOpen) return next(e)
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    // Keep other mods' rows (like the assumption check) drawn below ours.
    const below = await next(e)

    return (
      <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Box flexDirection="row">
          <Text bold>{'+ : '}</Text>
          <Box flexGrow={1}>
            <Input
              key="nueva"
              placeholder="Nueva idea…"
              submitLabel="guardar"
              value={draft}
              onInput={(v: string) => void update($, shelf, s => ({ ...s, draft: v }))}
              onSubmit={(v: string) => void add($, v).then(() => update($, shelf, s => ({ ...s, draft: '' })))}
            />
          </Box>
        </Box>
        {ideas.length === 0 ? <Text dimColor>Estante vacío. Agregá con /idea texto.</Text> : null}
        {ideas.map(idea => (
          <Box key={idea.id} flexDirection="row" gap={1}>
            <Button key={`enviar-${idea.id}`} label="Enviar" onPress={() => void send($, idea)} />
            <Button key={`borrar-${idea.id}`} label="×" onPress={() => void save($, removeIdea(ideas, idea.id))} />
            <Text>{idea.text}</Text>
          </Box>
        ))}
      </Box>
      {below}
      </Box>
    )
  })
}
