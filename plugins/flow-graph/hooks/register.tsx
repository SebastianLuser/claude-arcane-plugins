import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  EMPTY,
  addAgent,
  classifyTool,
  cronText,
  durationText,
  finishAgent,
  hasAgent,
  isLive,
  loopBegin,
  loopSchedule,
  loopStop,
  loopWait,
  loopWake,
  loopWork,
  nextCron,
  noteTool,
  runMs,
  runStatus,
  startRun,
  workflowName,
} from './flow'
import { LOOP_HEIGHT, STAGE_LABEL, STATUS_LABEL, VIOLET, clockText, countsLine, loopSvg, nextText, workflowSvg } from './svg'
import type { AgentNode, Flow, Loop, Run } from '../types'

const PANE = 'flow-graph'
const SHORT_RESULT = 220
const SHOWN_ROUNDS = 5

const flowAtom = atom({ plugin: 'flow-graph', key: 'flow' } as const, EMPTY)
const expandedAtom = atom({ plugin: 'flow-graph', key: 'expanded' } as const, [])

async function change($: EngineInterface, fn: (flow: Flow) => Flow): Promise<void> {
  await update($, flowAtom, fn)
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Flows' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'flow', description: 'Live graph of workflows and loops' })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const args = e as unknown as Record<string, unknown>
    if (e.tool === 'Workflow' && !e.agentId) {
      const at = await $.clock.now()
      await change($, flow => startRun(flow, e.tool_use_id || `wf-${at}`, workflowName(args), at))
      await openPane($)
      return next(e)
    }

    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    if (e.agentId) {
      const agentId = e.agentId
      await change($, flow => (hasAgent(flow, agentId) ? noteTool(flow, agentId, classifyTool(e.tool, args.skill)) : flow))
    } else if (e.tool === 'ScheduleWakeup' && args.stop === true) {
      await change($, loopStop)
    } else if (e.tool === 'CronDelete') {
      await change($, loopStop)
    } else if (e.tool === 'ScheduleWakeup' || (e.tool === 'CronCreate' && args.recurring !== false)) {
      const now = await $.clock.now()
      const cron = typeof args.cron === 'string' ? args.cron : null
      const delay = typeof args.delaySeconds === 'number' ? args.delaySeconds : null
      const nextAt = cron ? nextCron(cron, now) : delay === null ? null : now + delay * 1000
      const prompt = typeof args.prompt === 'string' ? args.prompt : null
      const isNew = !isLive((await read($, flowAtom)).loop)
      await change($, flow => loopSchedule(flow, nextAt, cron, prompt, now))
      if (isNew) await openPane($)
    }
    return ran
  }).catch(($, e, next) => next(e))

  // `/loop` shows its first round as soon as it starts, before it schedules the next one.
  on('skill.prompt', { skill: 'loop' }, async ($, e, next) => {
    const prompt = await next(e)
    const isNew = !isLive((await read($, flowAtom)).loop)
    const now = await $.clock.now()
    await change($, flow => loopBegin(flow, now))
    if (isNew) await openPane($)
    return prompt
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined || !e.workflow) return started
    const runId = e.workflow.runId
    // A run launched without a Workflow call this session saw brings the pane up with its first agent.
    const isFirst = !(await read($, flowAtom)).runs.some(r => (e.tool_use_id && r.id === e.tool_use_id) || (runId && r.runId === runId))
    const spawn = {
      toolUseId: e.tool_use_id,
      runId: e.workflow.runId,
      index: e.workflow.agentIndex,
      agentId: started.agentId ?? null,
      name: e.name || e.description,
      at: await $.clock.now(),
      model: started.model || null,
      // The description only: a workflow agent's prompt can carry the whole script.
      task: e.description,
    }
    await change($, flow => addAgent(flow, spawn))
    if (isFirst) await openPane($)
    return started
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) await change($, loopWork)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    const now = await $.clock.now()
    await change($, flow => (agentId ? finishAgent(flow, agentId, e.reason, e.answer, now) : loopWait(flow, now, e.durationMs)))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'scheduled-trigger') {
      const now = await $.clock.now()
      await change($, flow => loopWake(flow, now))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'flow' }, async $ => {
    await openPane($)
    const flow = await read($, flowAtom)
    if (flow.runs.length === 0 && !flow.loop) return { text: 'Flows pane open. It fills in when a workflow or a /loop starts.' }
    return { text: 'Flows pane open.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const flow = await read($, flowAtom)
    const run = flow.runs.at(-1) ?? null
    const older = flow.runs.length - 1

    if (!run && !flow.loop) {
      return (
        <Box flexDirection="column">
          <Text bold color={VIOLET}>FLOWS</Text>
          <Text dimColor>No workflow or /loop has run in this session yet.</Text>
          <Text dimColor>This pane opens by itself when a /loop starts or a workflow launches its first agent.</Text>
        </Box>
      )
    }

    const expanded = new Set(await read($, expandedAtom))
    const toggle = (key: string) => () =>
      void update($, expandedAtom, list => (list.includes(key) ? list.filter(k => k !== key) : [...list, key]))
    const loopInfo = flow.loop ? loopDetails(ui, flow.loop) : null
    const runInfo = run ? runDetails(ui, run, expanded, toggle) : null

    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(320, Math.min(900, (e.props.bodyColumns || 60) * 8 - 8))
      const graph = run ? workflowSvg(W, run) : null
      const now = await $.clock.now()
      return (
        <Box flexDirection="column" gap={1}>
          {flow.loop && (
            <Svg
              key="loop"
              source={loopSvg(W, flow.loop, now)}
              alt={flow.loop.isStopped ? `Loop ended after ${flow.loop.round} rounds` : `Loop, round ${flow.loop.round}, stage ${STAGE_LABEL[flow.loop.stage]}, ${nextText(flow.loop)}`}
              width={W}
              height={LOOP_HEIGHT}
              isInteractive
            />
          )}
          {loopInfo}
          {run && graph && (
            <Svg
              key={`run-${run.id}`}
              source={graph.source}
              alt={`Workflow ${run.name}: ${run.agents.length} agents, ${STATUS_LABEL[runStatus(run)]}`}
              width={W}
              height={graph.height}
              isInteractive
            />
          )}
          {runInfo}
          {older > 0 && <Text dimColor>{older} earlier workflows in this session</Text>}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {flow.loop && (
          <Box flexDirection="column">
            <Text bold color={VIOLET}>LOOP · round {flow.loop.round}</Text>
            {flow.loop.isStopped ? (
              <Text dimColor>■ ended</Text>
            ) : (
              <Text>● {STAGE_LABEL[flow.loop.stage]} <Text dimColor>· {nextText(flow.loop)}</Text></Text>
            )}
          </Box>
        )}
        {loopInfo}
        {run && <Text bold color={VIOLET}>WORKFLOW · {run.name} <Text dimColor>· {STATUS_LABEL[runStatus(run)]}</Text></Text>}
        {runInfo}
        <Text dimColor>The graph is drawn in the desktop app.</Text>
      </Box>
    )
  })
}

type Elements = ReturnType<EngineInterface['ui']['resolve']>

/** What the loop runs, how often, and its latest rounds. */
function loopDetails({ Box, Text }: Elements, loop: Loop) {
  const rounds = (loop.rounds ?? []).slice(-SHOWN_ROUNDS).reverse()
  const cadence = loop.cron ? `${cronText(loop.cron)} (${loop.cron})` : loop.nextAt !== null ? 'Claude picks the next time each round' : null
  return (
    <Box key="loop-info" flexDirection="column">
      {loop.prompt && (
        <Text>
          Runs <Text dimColor>· {loop.prompt}</Text>
        </Text>
      )}
      {cadence && (
        <Text>
          Every <Text dimColor>· {cadence}</Text>
        </Text>
      )}
      {rounds.map(round => (
        <Text key={`round-${round.round}`} dimColor>
          round {round.round} · {clockText(round.at)} · {round.ms === null ? (loop.isStopped ? '—' : 'working…') : durationText(round.ms)}
        </Text>
      ))}
    </Box>
  )
}

/** One block per agent: model, time, tools, its task and the start of its answer. */
function runDetails({ Box, Text, Button }: Elements, run: Run, expanded: Set<string>, toggle: (key: string) => () => void) {
  const status = runStatus(run)
  return (
    <Box key={`run-info-${run.id}`} flexDirection="column" gap={1}>
      <Text dimColor>
        started {clockText(run.startedAt)}
        {status === 'running' ? ' · running' : ` · took ${durationText(runMs(run, 0))}`}
      </Text>
      {run.agents.map(agent => agentBlock({ Box, Text, Button } as Elements, run, agent, expanded, toggle))}
    </Box>
  )
}

function agentBlock({ Box, Text, Button }: Elements, run: Run, agent: AgentNode, expanded: Set<string>, toggle: (key: string) => () => void) {
  const key = `${run.id}|${agent.index}`
  const isOpen = expanded.has(key)
  const result = agent.result ?? null
  const isLong = !!result && result.length > SHORT_RESULT
  const line = countsLine(agent)
  const color = agent.status === 'error' ? 'error' : agent.status === 'ok' ? 'success' : undefined
  return (
    <Box key={key} flexDirection="column">
      <Text color={color}>
        {agent.index}. {agent.name}
        {line && <Text dimColor> · {line}</Text>}
      </Text>
      {agent.task && <Text dimColor>task: {agent.task}</Text>}
      {agent.failure && <Text color="error">ended: {agent.failure}</Text>}
      {agent.status === 'running' && <Text dimColor>working…</Text>}
      {result && <Text>{isOpen || !isLong ? result : `${result.slice(0, SHORT_RESULT - 1)}…`}</Text>}
      {isLong && <Button key={`more-${key}`} label={isOpen ? 'Show less' : 'Show all'} onPress={toggle(key)} />}
    </Box>
  )
}
