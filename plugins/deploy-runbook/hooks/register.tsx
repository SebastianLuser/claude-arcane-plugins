import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { buildReport, changedFiles, deploySteps, inRunOrder, isDeployFile, isMigration, isPatchable, splitPatch } from './detect'
import { tablesSvg } from './svg'
import type { Corrections, RepoFile } from './detect'
import type { Consumer, ModeKind, Report, TableChange } from '../types'

const PLUGIN = 'deploy-runbook'
const PANE = 'deploy-runbook'
const VIOLET_TINT = '#B138C1'
const IN_CODE_PATTERN = 'RUN_MIGRATIONS|migrate[.]New|RunMigrations[(]|goose[.]Up[(]'
const GIT_TIMEOUT_MS = 15_000
const MAX_SIBLINGS = 60
// shortcut: replays the latest 400 earlier migrations only; a repo with more misses the oldest tables.
const MAX_EARLIER = 400

const reportAtom = atom({ plugin: 'deploy-runbook', key: 'report' } as const, null)
const errorAtom = atom({ plugin: 'deploy-runbook', key: 'error' } as const, null)
const loadingAtom = atom({ plugin: 'deploy-runbook', key: 'isLoading' } as const, false)
const doneAtom = atom({ plugin: 'deploy-runbook', key: 'done' } as const, [])

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

// shortcut: matches the whole repo name as a variable prefix (snake-game → SNAKE_GAME_DATABASE_URL); service-impact's fuzzier matching would find more.
async function consumersOf($: EngineInterface, top: string, repo: string): Promise<Consumer[]> {
  const parent = top.slice(0, top.lastIndexOf('/'))
  const token = repo.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  const entries = (await $.fs.list(parent).catch(() => [])).filter(entry => entry.kind === 'dir' && entry.name !== repo)
  const found = await Promise.all(
    entries.slice(0, MAX_SIBLINGS).map(async (entry): Promise<Consumer | null> => {
      const dir = `${parent}/${entry.name}`
      if (!(await $.fs.exists(`${dir}/.git`).catch(() => false))) return null
      // -l lists file names only: a tracked .env never has its values read.
      const db = await git($, dir, ['grep', '-l', '-E', `${token}_(DATABASE|DB)_URL`])
      const http = db ? null : await git($, dir, ['grep', '-l', '-E', `${token}_(API_|BASE_)*URL`])
      const file = (db ?? http)?.split('\n')[0]
      return file ? { repo: entry.name, kind: db ? 'db' : 'http', file } : null
    }),
  )
  return found.filter(consumer => consumer !== null)
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

  const repo = top.split('/').pop() ?? top
  let repoFiles: RepoFile[] = []
  let trackedPaths: string[] = []
  let consumers: Consumer[] = []
  if (migrations.length > 0 || patches.length > 0) {
    trackedPaths = ((await git($, top, ['ls-files'])) ?? '').split('\n').filter(Boolean)
    const codePaths = ((await git($, top, ['grep', '-l', '-E', IN_CODE_PATTERN, '--', '*.go'])) ?? '').split('\n').filter(Boolean)
    repoFiles = await readAll($, top, [...new Set([...trackedPaths.filter(isDeployFile), ...codePaths])])
    consumers = await consumersOf($, top, repo)
  }
  const branchMigrations = new Set(migrations)
  const earlierPaths = inRunOrder(trackedPaths.filter(path => isMigration(path) && !branchMigrations.has(path)).map(path => ({ path, text: '' })))
    .map(file => file.path)
    .slice(-MAX_EARLIER)
  const earlierMigrations = migrations.length > 0 ? await readAll($, top, earlierPaths) : []
  const commits = Number((await git($, top, ['rev-list', '--count', `${mergeBase}..HEAD`])) ?? 0)
  const unpushed = await git($, top, ['rev-list', '--count', '@{u}..HEAD'])

  return buildReport({
    repo,
    branch,
    base,
    nameStatus,
    patches,
    migrationTexts: await readAll($, top, migrations),
    repoFiles,
    corrections,
    trackedPaths,
    consumers,
    earlierMigrations,
    info: { commits, files: changed.length, unpushed: unpushed === null ? null : Number(unpushed) },
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

const REVIEW_SKILLS = new Set(['create-pr', 'code-review'])

async function showRunbook($: EngineInterface): Promise<void> {
  const report = await refresh($)
  if (report && hasWork(report)) await openPane($, report).catch(() => undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    corrections = await loadCorrections($)
    await $.command.register({ name: 'deploy-info', description: 'Deploy runbook for the current branch' })
    return next(e)
  })

  // Seen at the slash line and the Skill tool, not at skill.prompt: on Team and Enterprise plans the
  // built-in guard (cc-plugin-sec-default) skips skill.prompt hooks of user-installed mods.
  on('prompt.submit', async ($, e, next) => {
    const sent = await next(e)
    if (e.command && REVIEW_SKILLS.has(e.command.name)) await showRunbook($)
    return sent
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const ran = await next(e)
    const skill = (e as unknown as { skill?: unknown }).skill
    if (ran.deny === undefined && !e.agentId && typeof skill === 'string' && REVIEW_SKILLS.has(skill.split(':').pop() ?? '')) {
      await showRunbook($)
    }
    return ran
  }).catch(($, e, next) => next(e))

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
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
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
    const { info } = report
    const done = new Set(await read($, doneAtom))
    const steps = hasWork(report) ? deploySteps(report) : []
    const doneCount = steps.filter(step => done.has(`${report.branch}|${step.id}`)).length
    const gaps = gapsPrompt(report)
    const toggle = (key: string) => () =>
      void update($, doneAtom, list => (list.includes(key) ? list.filter(k => k !== key) : [...list.filter(k => k.startsWith(`${report.branch}|`)), key]))
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={VIOLET_TINT} paddingX={1} gap={1}>
        <Box flexDirection="column">
          <Text bold>DEPLOY · {report.repo}</Text>
          <Text dimColor>
            {report.branch} against {report.base}
          </Text>
          <Text dimColor>
            {plural(info.commits, 'commit')} · {plural(info.files, 'file')} changed ·{' '}
            {info.unpushed === null ? 'not pushed yet' : info.unpushed === 0 ? 'pushed' : `${info.unpushed} not pushed`}
          </Text>
          {error && <Text color="error">{error}</Text>}
        </Box>
        {steps.length > 0 && (
          <Box flexDirection="column">
            <Text bold>
              Steps <Text dimColor>{doneCount}/{steps.length}</Text>
            </Text>
            {steps.map((step, i) => {
              const key = `${report.branch}|${step.id}`
              const isDone = done.has(key)
              return (
                <Box key={key} flexDirection="row" gap={1}>
                  <Button label={isDone ? '☑' : '☐'} onPress={toggle(key)} />
                  <Box flexDirection="column">
                    <Text dimColor={isDone}>
                      {i + 1}. {step.text}
                    </Text>
                    {step.detail && <Text dimColor>{step.detail}</Text>}
                  </Box>
                </Box>
              )
            })}
          </Box>
        )}
        {report.risks.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Risks</Text>
            {report.risks.map(risk => (
              <Text color={risk.level === 'high' ? 'error' : 'warning'}>
                ▲ {risk.text} <Text dimColor>· {risk.file}</Text>
              </Text>
            ))}
          </Box>
        )}
        {report.consumers.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Also affected</Text>
            {report.consumers.map(consumer => (
              <Text>
                ● {consumer.repo}{' '}
                <Text dimColor>
                  · {consumer.kind === 'db' ? 'reads this database' : 'calls this service'} · {consumer.file}
                </Text>
              </Text>
            ))}
          </Box>
        )}
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
            {e.surface === 'desktop' && 'Svg' in ui
              ? (() => {
                  const W = Math.max(280, Math.min(900, (e.props.bodyColumns || 60) * 8 - 24))
                  const drawn = tablesSvg(W, report.tables)
                  const { Svg } = ui
                  return <Svg key="tables" source={drawn.source} alt={`Changed tables: ${report.tables.map(t => t.table).join(', ')}`} width={W} height={drawn.height} />
                })()
              : report.tables.map(table => tableRows(Box, Text, table))}
            {report.skipped > 0 && <Text dimColor>{report.skipped} statements not read (indexes, data, functions)</Text>}
          </Box>
        )}
        <Box flexDirection="row" gap={1}>
          {refreshButton}
          {gaps && <Button key="ask" label="Ask Claude to fill the gaps" onPress={() => void $.prompt.submit({ text: gaps, asUser: true })} />}
        </Box>
      </Box>
    )
  })
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** What the runbook could not detect, asked of Claude; null when nothing is missing. */
function gapsPrompt(report: Report): string | null {
  const asks: string[] = []
  if (report.mode?.kind === 'unknown') asks.push(`how ${report.repo} applies its database migrations on deploy (CI workflow, startup code, scripts or docs)`)
  const unplaced = report.vars.filter(found => !found.target).map(found => found.name)
  if (unplaced.length > 0) asks.push(`where ${report.repo} loads ${unplaced.join(', ')} in each environment`)
  if (asks.length === 0) return null
  return `Find out ${asks.join(', and ')}. Look in the repo first and ask me what you cannot find. Then tell me each one in one line.`
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
