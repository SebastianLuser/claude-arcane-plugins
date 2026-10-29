import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { classify, impact, locate, otherEnd } from './classify'
import type { Edge, EdgeKind, Graph, Trigger } from '../types'
import { scanAll } from './scan'
import type { Corrections } from './scan'

const PLUGIN = 'educabot-impacto'
const PANE = 'educabot-impacto'
const STORE_KEY = 'graph-1'
const VIOLET_TINT = '#B138C1'

const graphAtom = atom({ plugin: 'educabot-impacto', key: 'graph' } as const, null, { shape: 'graph-1' })
const alertAtom = atom({ plugin: 'educabot-impacto', key: 'alert' } as const, null)
const seenAtom = atom({ plugin: 'educabot-impacto', key: 'seen' } as const, [])
const paneRepoAtom = atom({ plugin: 'educabot-impacto', key: 'paneRepo' } as const, null)
const scanningAtom = atom({ plugin: 'educabot-impacto', key: 'isScanning' } as const, false)

const KIND_COLOR: Record<EdgeKind, string> = { db: 'error', http: 'warning', lib: 'subtle' }
const KIND_LABEL: Record<EdgeKind, string> = { db: 'DB', http: 'HTTP', lib: 'lib' }
const HEADLINE: Record<Trigger, { text: string; color: string }> = {
  migration: { text: 'Migración en una DB que usan otros servicios', color: 'error' },
  contract: { text: 'Cambio de contrato: lo consumen otros servicios', color: 'warning' },
  handler: { text: 'Cambio de API: la llaman otros servicios', color: 'warning' },
  config: { text: 'Cambio de config: este servicio se conecta con', color: 'warning' },
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut > 0 ? path.slice(0, cut) : path
}

function isGraph(value: unknown): value is Graph {
  const graph = value as Graph | null
  return !!graph && Array.isArray(graph.repos) && Array.isArray(graph.edges) && typeof graph.scannedAt === 'number'
}

function isCorrections(value: unknown): value is Corrections {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const { ignore, tokens, vars, external } = value as Record<string, unknown>
  const isMap = (map: unknown) => map === undefined || (typeof map === 'object' && map !== null && !Array.isArray(map))
  return (ignore === undefined || Array.isArray(ignore)) && isMap(tokens) && isMap(vars) && isMap(external)
}

async function resolveRoot($: EngineInterface, configured: string, cwd: string): Promise<string> {
  if (configured.trim()) return normalize(configured.trim())
  const start = normalize(cwd)
  if (await $.fs.exists(`${start}/.git`)) return parentOf(start)
  const children = await $.fs.list(start).catch(() => [])
  let repos = 0
  for (const child of children) {
    if (child.kind === 'dir' && (await $.fs.exists(`${start}/${child.name}/.git`))) repos += 1
    if (repos >= 2) return start
  }
  let dir = start
  for (let level = 0; level < 6; level++) {
    const up = parentOf(dir)
    if (up === dir) break
    if (await $.fs.exists(`${up}/.git`)) return parentOf(up)
    dir = up
  }
  return start
}

async function loadCorrections($: EngineInterface): Promise<Corrections> {
  const text = await $.fs.read(`${$.plugin.root}/correcciones.json`).catch(() => null)
  if (text === null) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (isCorrections(parsed)) return parsed
  } catch {}
  $.ui.toast(`${PLUGIN}: correcciones.json no es válido, escaneo sin correcciones`)
  return {}
}

let root = ''
let corrections: Corrections = {}
let inflight: Promise<void> | null = null

function rescan($: EngineInterface): Promise<void> {
  if (!root) return Promise.resolve()
  inflight ??= scanOnce($).finally(() => {
    inflight = null
  })
  return inflight
}

async function scanOnce($: EngineInterface): Promise<void> {
  await update($, scanningAtom, () => true)
  try {
    const fs = { list: (path: string) => $.fs.list(path), read: (path: string) => $.fs.read(path) }
    const graph = await scanAll(fs, root, corrections, await $.clock.now())
    await update($, graphAtom, () => graph)
    await $.store.set(STORE_KEY, graph)
  } finally {
    await update($, scanningAtom, () => false)
  }
}

async function noteEdit($: EngineInterface, file: string): Promise<void> {
  const graph = await read($, graphAtom)
  const where = graph ? locate(file, root, graph.repos) : null
  const trigger = where ? classify(where.rel) : null
  if (!graph || !where || !trigger) return
  const key = `${where.repo}/${where.rel}`
  if ((await read($, seenAtom)).includes(key)) return
  const found = impact(graph, where.repo, where.rel, trigger)
  if (!found) return
  await update($, seenAtom, list => [...list, key])
  await update($, alertAtom, () => found)
}

async function openPane($: EngineInterface, repo: string | null): Promise<void> {
  await update($, paneRepoAtom, () => repo)
  await $.ui.open({ id: PANE, title: repo ? `Impacto · ${repo}` : 'Impacto' })
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    root = await resolveRoot($, String(options.reposRoot ?? ''), e.cwd)
    corrections = await loadCorrections($)
    const cached = await $.store.get(STORE_KEY)
    if (isGraph(cached)) await update($, graphAtom, () => cached)
    await $.command.register({
      name: 'impacto',
      description: 'Mapa de impacto entre servicios de Educabot',
      argumentHint: '[repo]',
    })
    void rescan($).catch(() => $.ui.toast(`${PLUGIN}: no pude escanear ${root}`))

    return next(e)
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) await noteEdit($, e.file_path).catch(() => undefined)
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) await noteEdit($, e.file_path).catch(() => undefined)
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) await noteEdit($, e.notebook_path).catch(() => undefined)
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'impacto' }, async ($, e) => {
    const graph = await read($, graphAtom)
    const asked = e.args.trim()
    const cwdRepo = graph ? locate(`${await $.session.cwd()}/x`, root, graph.repos)?.repo ?? null : null
    const repo = asked ? (graph?.repos.find(name => name.toLowerCase() === asked.toLowerCase()) ?? null) : cwdRepo
    await openPane($, repo)
    if (!graph) return { text: 'Todavía estoy escaneando los repos. El mapa aparece en el panel cuando termine.' }
    if (asked && !repo) return { text: `No encontré "${asked}" entre los ${graph.repos.length} repos escaneados en ${root}.` }
    return { text: repo ? `Mapa de impacto de ${repo} abierto.` : 'Resumen de impacto abierto.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const alert = await read($, alertAtom)
    if (e.props.hasSurvey || !alert) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const room = Math.max(1, e.props.maxRows - 5)
    const shown = alert.edges.slice(0, room)
    const rest = alert.edges.length - shown.length

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={VIOLET_TINT} paddingX={1}>
        <Text bold>IMPACTO · {alert.repo}</Text>
        <Text color={HEADLINE[alert.trigger].color}>
          ▲ {HEADLINE[alert.trigger].text} · {alert.file}
        </Text>
        {shown.map(edge => (
          edgeRow(Text, edge, alert.repo)
        ))}
        {rest > 0 && <Text dimColor>y {rest} más</Text>}
        <Box gap={1}>
          <Button key="map" label="Ver mapa" onPress={() => openPane($, alert.repo)} />
          <Button key="hide" label="Ocultar" onPress={() => update($, alertAtom, () => null)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const graph = await read($, graphAtom)
    const repo = await read($, paneRepoAtom)
    const isScanning = await read($, scanningAtom)
    const rescanButton = (
      <Button key="rescan" label={isScanning ? 'Escaneando...' : 'Re-escanear'} onPress={() => rescan($)} />
    )

    if (!graph) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Escaneando los repos de {root || 'la carpeta'}...</Text>
          {rescanButton}
        </Box>
      )
    }

    if (!repo) {
      const ranked = graph.repos
        .map(name => ({ name, users: graph.edges.filter(edge => edge.to === name).length }))
        .filter(row => row.users > 0)
        .sort((a, b) => b.users - a.users || a.name.localeCompare(b.name))
      return (
        <Box flexDirection="column">
          <Text bold>Servicios más usados</Text>
          {ranked.map(row => (
            <Text>
              {row.name} <Text dimColor>· {row.users} dependen</Text>
            </Text>
          ))}
          <Text dimColor>Usá /impacto &lt;repo&gt; para ver uno.</Text>
          {rescanButton}
        </Box>
      )
    }

    const users = graph.edges.filter(edge => edge.to === repo)
    const uses = graph.edges.filter(edge => edge.from === repo)
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>Usan este servicio</Text>
          {users.length === 0 && <Text dimColor>Ningún repo escaneado.</Text>}
          {users.map(edge => (
            edgeRow(Text, edge, repo)
          ))}
        </Box>
        <Box flexDirection="column">
          <Text bold>Este servicio usa</Text>
          {uses.length === 0 && <Text dimColor>Nada que se haya detectado.</Text>}
          {uses.map(edge => (
            edgeRow(Text, edge, repo)
          ))}
        </Box>
        {rescanButton}
      </Box>
    )
  })
}

type TextElement = ReturnType<EngineInterface['ui']['resolve']>['Text']

function edgeRow(Text: TextElement, edge: Edge, repo: string) {
  const color = edge.isExternal ? 'subtle' : KIND_COLOR[edge.kind]
  return (
    <Text color={color}>
      {edge.isExternal ? '○' : '●'} {otherEnd(edge, repo)}{' '}
      <Text dimColor>
        {KIND_LABEL[edge.kind]} · {edge.via}
        {edge.isExternal ? ' · no clonado' : ''}
      </Text>
    </Text>
  )
}
