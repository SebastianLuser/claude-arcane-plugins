import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { buildReport, changedFiles, isDeployFile, isMigration, isPatchable, splitPatch } from './detect'
import type { Corrections, RepoFile } from './detect'
import type { ModeKind, Report, TableChange } from '../types'

const PLUGIN = 'deploy-runbook'
const PANE = 'deploy-runbook'
const VIOLET_TINT = '#B138C1'
const IN_CODE_PATTERN = 'RUN_MIGRATIONS|migrate[.]New|RunMigrations[(]|goose[.]Up[(]'
const GIT_TIMEOUT_MS = 15_000

const reportAtom = atom({ plugin: 'deploy-runbook', key: 'report' } as const, null)
const errorAtom = atom({ plugin: 'deploy-runbook', key: 'error' } as const, null)
const loadingAtom = atom({ plugin: 'deploy-runbook', key: 'isLoading' } as const, false)

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
  const text = await $.fs.read(`${$.plugin.root}/corrections.json`).catch(() => null)
  if (text === null) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (isCorrections(parsed)) return parsed
  } catch {}
  $.ui.toast(`${PLUGIN}: corrections.json is not valid, going on without corrections`)
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
  if (!top) throw new Error(`${cwd} is not a git repo`)
  const branch = (await git($, top, ['rev-parse', '--abbrev-ref', 'HEAD'])) ?? 'HEAD'
  const base = await baseRef($, top)
  if (!base) throw new Error('No main branch found (origin/HEAD, origin/main or origin/master)')
  const mergeBase = await git($, top, ['merge-base', 'HEAD', base])
  if (!mergeBase) throw new Error(`Could not compare ${branch} with ${base}`)

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

const SHIP_COMMAND = /\b(git\s+push|gh\s+pr\s+create)\b/
let shownKey = ''

// Opens the runbook by itself when the branch has something to deploy that was not shown yet.
async function autoOpen($: EngineInterface, isShipping: boolean): Promise<void> {
  const report = await refresh($)
  if (!report || !hasWork(report)) return
  const key = `${report.branch}|${report.migrations.length}|${report.vars.length}`
  if (key === shownKey && !isShipping) return
  shownKey = key
  await openPane($, report)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    corrections = await loadCorrections($)
    await $.command.register({ name: 'deploy-info', description: 'Deploy runbook for the current branch' })
    return next(e)
  })

  on('skill.prompt', { skill: ['create-pr', 'code-review'] }, async ($, e, next) => {
    const prompt = await next(e)
    const report = await refresh($)
    if (report && hasWork(report)) await openPane($, report).catch(() => undefined)
    return prompt
  })

  for (const tool of ['Edit', 'Write'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const ran = await next(e)
      const path = e.file_path.replace(/\\/g, '/')
      if (ran.deny === undefined && ran.isError !== true && (isMigration(path) || /(^|\/)\.env\.example$/i.test(path))) {
        await autoOpen($, false).catch(() => undefined)
      }
      return ran
    }).catch(($, e, next) => next(e))
  }

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && SHIP_COMMAND.test(e.command)) await autoOpen($, true).catch(() => undefined)
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'deploy-info' }, async $ => {
    const report = await refresh($)
    await openPane($, report)
    if (!report) return { text: `Could not build the runbook: ${await read($, errorAtom)}` }
    if (!hasWork(report)) return { text: `Nothing to deploy on ${report.branch}: no new migrations or variables.` }
    return { text: `Deploy runbook for ${report.repo} open.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const report = await read($, reportAtom)
    const error = await read($, errorAtom)
    const isLoading = await read($, loadingAtom)
    const refreshButton = <Button key="refresh" label={isLoading ? 'Analyzing...' : 'Refresh'} onPress={() => refresh($)} />

    if (!report) {
      return (
        <Box flexDirection="column">
          {error ? <Text color="error">{error}</Text> : <Text dimColor>Analyzing the branch...</Text>}
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
            {report.branch} against {report.base}
          </Text>
          {error && <Text color="error">{error}</Text>}
        </Box>
        <Box flexDirection="column">
          <Text bold>Migrations</Text>
          {!mode && <Text dimColor>No new migrations.</Text>}
          {mode && (
            <Text color={MODE_COLOR[mode.kind]}>
              {mode.kind === 'manual' || mode.kind === 'unknown' ? '▲' : '●'} {mode.text}
            </Text>
          )}
          {mode?.source && <Text dimColor>from {mode.source}</Text>}
          {report.migrations.map(path => (
            <Text dimColor>· {path.split('/').pop()}</Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text bold>New variables</Text>
          {report.vars.length === 0 && <Text dimColor>No new variables.</Text>}
          {report.vars.map(found => (
            <Text color={found.target ? undefined : 'warning'}>
              ● {found.name}{' '}
              <Text dimColor>
                · {found.target ? `load it in ${found.target}` : 'unknown where it is loaded'} · {found.file}
              </Text>
            </Text>
          ))}
        </Box>
        {report.tables.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Table changes</Text>
            {report.tables.map(table => tableRows(Box, Text, table))}
            {report.skipped > 0 && <Text dimColor>{report.skipped} statements not read (indexes, data, functions)</Text>}
          </Box>
        )}
        {refreshButton}
      </Box>
    )
  })
}

type Elements = ReturnType<EngineInterface['ui']['resolve']>

function tableRows(Box: Elements['Box'], Text: Elements['Text'], table: TableChange) {
  const tag = table.isDropped ? ' (dropped)' : table.isNew ? ' (new)' : ''
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
          → {fk.column} references {fk.table}
        </Text>
      ))}
    </Box>
  )
}
