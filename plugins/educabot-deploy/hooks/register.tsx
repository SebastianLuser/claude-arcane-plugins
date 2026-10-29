import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { buildReport, changedFiles, isDeployFile, isMigration, isPatchable, splitPatch } from './detect'
import type { Corrections, RepoFile } from './detect'
import type { ModeKind, Report, TableChange } from '../types'

const PLUGIN = 'educabot-deploy'
const PANE = 'educabot-deploy'
const VIOLET_TINT = '#B138C1'
const IN_CODE_PATTERN = 'RUN_MIGRATIONS|migrate[.]New|RunMigrations[(]|goose[.]Up[(]'
const GIT_TIMEOUT_MS = 15_000

const reportAtom = atom({ plugin: 'educabot-deploy', key: 'report' } as const, null)
const errorAtom = atom({ plugin: 'educabot-deploy', key: 'error' } as const, null)
const loadingAtom = atom({ plugin: 'educabot-deploy', key: 'isLoading' } as const, false)

const MODE_COLOR: Record<ModeKind, string | undefined> = {
  auto: undefined,
  flag: undefined,
  declared: undefined,
  manual: 'warning',
  unknown: 'warning',
}

function isCorrections(value: unknown): value is Corrections {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const { migrations, targets } = value as Record<string, unknown>
  const isTextMap = (map: unknown) =>
    map === undefined ||
    (typeof map === 'object' && map !== null && !Array.isArray(map) && Object.values(map).every(text => typeof text === 'string'))
  return isTextMap(migrations) && isTextMap(targets)
}

async function loadCorrections($: EngineInterface): Promise<Corrections> {
  const text = await $.fs.read(`${$.plugin.root}/correcciones.json`).catch(() => null)
  if (text === null) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (isCorrections(parsed)) return parsed
  } catch {}
  $.ui.toast(`${PLUGIN}: correcciones.json no es válido, sigo sin correcciones`)
  return {}
}

async function git($: EngineInterface, cwd: string, args: string[]): Promise<string | null> {
  const run = await $.process.run(['git', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS }).catch(() => null)
  return run && run.exitCode === 0 ? run.stdout.trim() : null
}

async function baseRef($: EngineInterface, top: string): Promise<string | null> {
  const head = await git($, top, ['rev-parse', '--abbrev-ref', 'origin/HEAD'])
  if (head && head !== 'origin/HEAD') return head
  for (const ref of ['origin/main', 'origin/master']) {
    if ((await git($, top, ['rev-parse', '--verify', '--quiet', ref])) !== null) return ref
  }
  return null
}

async function readAll($: EngineInterface, top: string, paths: string[]): Promise<RepoFile[]> {
  const files = await Promise.all(
    paths.map(path =>
      $.fs
        .read(`${top}/${path}`)
        .then(text => ({ path, text }))
        .catch(() => null),
    ),
  )
  return files.filter(file => file !== null)
}

let corrections: Corrections = {}
let inflight: Promise<Report | null> | null = null

async function analyze($: EngineInterface): Promise<Report> {
  const cwd = (await $.session.cwd()).replace(/\\/g, '/')
  const top = (await git($, cwd, ['rev-parse', '--show-toplevel']))?.replace(/\\/g, '/')
  if (!top) throw new Error(`${cwd} no es un repo git`)
  const branch = (await git($, top, ['rev-parse', '--abbrev-ref', 'HEAD'])) ?? 'HEAD'
  const base = await baseRef($, top)
  if (!base) throw new Error('No encontré la rama principal (origin/HEAD, origin/main ni origin/master)')
  const mergeBase = await git($, top, ['merge-base', 'HEAD', base])
  if (!mergeBase) throw new Error(`No pude comparar ${branch} con ${base}`)

  const nameStatus = (await git($, top, ['diff', '--name-status', '--no-renames', mergeBase])) ?? ''
  const changed = changedFiles(nameStatus).map(file => file.path)
  const patchable = changed.filter(isPatchable)
  const migrations = changed.filter(isMigration)
  // TODO(@SebastianLuser, 2026-10-28): one diff call with every path; a PR with thousands of files can exceed the command-line limit.
  const diff = patchable.length > 0 ? await git($, top, ['diff', '-U0', '--no-renames', mergeBase, '--', ...patchable]) : null
  const patches = splitPatch(diff ?? '')

  let repoFiles: RepoFile[] = []
  if (migrations.length > 0 || patches.length > 0) {
    const deployPaths = ((await git($, top, ['ls-files'])) ?? '').split('\n').filter(isDeployFile)
    const codePaths = ((await git($, top, ['grep', '-l', '-E', IN_CODE_PATTERN, '--', '*.go'])) ?? '').split('\n').filter(Boolean)
    repoFiles = await readAll($, top, [...new Set([...deployPaths, ...codePaths])])
  }

  return buildReport({
    repo: top.split('/').pop() ?? top,
    branch,
    base,
    nameStatus,
    patches,
    migrationTexts: await readAll($, top, migrations),
    repoFiles,
    corrections,
  })
}

function refresh($: EngineInterface): Promise<Report | null> {
  inflight ??= (async () => {
    await update($, loadingAtom, () => true)
    try {
      const report = await analyze($)
      await update($, reportAtom, () => report)
      await update($, errorAtom, () => null)
      return report
    } catch (error) {
      await update($, errorAtom, () => (error instanceof Error ? error.message : String(error)))
      return null
    } finally {
      await update($, loadingAtom, () => false)
    }
  })().finally(() => {
    inflight = null
  })
  return inflight
}

function hasWork(report: Report): boolean {
  return report.migrations.length > 0 || report.vars.length > 0
}

async function openPane($: EngineInterface, report: Report | null): Promise<void> {
  await $.ui.open({ id: PANE, title: report ? `Deploy · ${report.repo}` : 'Deploy' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    corrections = await loadCorrections($)
    await $.command.register({ name: 'deploy-info', description: 'Runbook de deploy de la rama actual' })
    return next(e)
  })

  on('skill.prompt', { skill: ['create-pr', 'code-review'] }, async ($, e, next) => {
    const prompt = await next(e)
    const report = await refresh($)
    if (report && hasWork(report)) await openPane($, report).catch(() => undefined)
    return prompt
  })

  on('command.run', { command: 'deploy-info' }, async $ => {
    const report = await refresh($)
    await openPane($, report)
    if (!report) return { text: `No pude armar el runbook: ${await read($, errorAtom)}` }
    if (!hasWork(report)) return { text: `Nada para deployar en ${report.branch}: no hay migraciones ni variables nuevas.` }
    return { text: `Runbook de deploy de ${report.repo} abierto.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const report = await read($, reportAtom)
    const error = await read($, errorAtom)
    const isLoading = await read($, loadingAtom)
    const refreshButton = <Button key="refresh" label={isLoading ? 'Analizando...' : 'Actualizar'} onPress={() => refresh($)} />

    if (!report) {
      return (
        <Box flexDirection="column">
          {error ? <Text color="error">{error}</Text> : <Text dimColor>Analizando la rama...</Text>}
          {refreshButton}
        </Box>
      )
    }

    const mode = report.mode
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={VIOLET_TINT} paddingX={1} gap={1}>
        <Box flexDirection="column">
          <Text bold>DEPLOY · {report.repo}</Text>
          <Text dimColor>
            {report.branch} contra {report.base}
          </Text>
          {error && <Text color="error">{error}</Text>}
        </Box>
        <Box flexDirection="column">
          <Text bold>Migraciones</Text>
          {!mode && <Text dimColor>No hay migraciones nuevas.</Text>}
          {mode && (
            <Text color={MODE_COLOR[mode.kind]}>
              {mode.kind === 'manual' || mode.kind === 'unknown' ? '▲' : '●'} {mode.text}
            </Text>
          )}
          {mode?.source && <Text dimColor>según {mode.source}</Text>}
          {report.migrations.map(path => (
            <Text dimColor>· {path.split('/').pop()}</Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text bold>Variables nuevas</Text>
          {report.vars.length === 0 && <Text dimColor>No hay variables nuevas.</Text>}
          {report.vars.map(found => (
            <Text color={found.target ? undefined : 'warning'}>
              ● {found.name}{' '}
              <Text dimColor>
                · {found.target ? `cargala en ${found.target}` : 'no sé dónde se carga'} · {found.file}
              </Text>
            </Text>
          ))}
        </Box>
        {report.tables.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Cambios en tablas</Text>
            {report.tables.map(table => tableRows(Box, Text, table))}
            {report.skipped > 0 && <Text dimColor>{report.skipped} sentencias sin interpretar (índices, datos, funciones)</Text>}
          </Box>
        )}
        {refreshButton}
      </Box>
    )
  })
}

type Elements = ReturnType<EngineInterface['ui']['resolve']>

function tableRows(Box: Elements['Box'], Text: Elements['Text'], table: TableChange) {
  const tag = table.isDropped ? ' (se borra)' : table.isNew ? ' (nueva)' : ''
  return (
    <Box flexDirection="column">
      <Text bold color={table.isDropped ? 'error' : undefined}>
        {table.table}
        {tag}
      </Text>
      {table.added.map(column => (
        <Text color="success">
          + {column.name} <Text dimColor>{column.type}</Text>
        </Text>
      ))}
      {table.dropped.map(name => (
        <Text color="error">- {name}</Text>
      ))}
      {table.renamed.map(rename => (
        <Text color="warning">
          ~ {rename.from} → {rename.to}
        </Text>
      ))}
      {table.foreignKeys.map(fk => (
        <Text color="subtle">
          → {fk.column} referencia a {fk.table}
        </Text>
      ))}
    </Box>
  )
}
