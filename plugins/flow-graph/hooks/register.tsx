import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  EMPTY,
  addAgent,
  classifyTool,
  finishAgent,
  hasAgent,
  loopSchedule,
  loopStop,
  loopWait,
  loopWake,
  loopWork,
  nextCron,
  noteTool,
  runStatus,
  startRun,
  workflowName,
} from './flow'
import { LOOP_HEIGHT, STAGE_LABEL, STATUS_LABEL, VIOLET, loopSvg, nextText, workflowSvg } from './svg'
import type { Flow } from '../types'

const PANE = 'flow-graph'

const flowAtom = atom({ plugin: 'flow-graph', key: 'flow' } as const, EMPTY)

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
      const isNew = (await read($, flowAtom)).loop === null
      await change($, flow => loopSchedule(flow, nextAt, cron))
      if (isNew) await openPane($)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined || !e.workflow) return started
    const spawn = {
      toolUseId: e.tool_use_id,
      runId: e.workflow.runId,
      index: e.workflow.agentIndex,
      agentId: started.agentId ?? null,
      name: e.name || e.description,
      at: await $.clock.now(),
    }
    await change($, flow => addAgent(flow, spawn))
    return started
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) await change($, loopWork)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    const now = await $.clock.now()
    await change($, flow => (agentId ? finishAgent(flow, agentId, e.reason) : loopWait(flow, now)))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'scheduled-trigger') await change($, loopWake)
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
        </Box>
      )
    }

    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(320, Math.min(900, (e.props.bodyColumns || 60) * 8 - 8))
      const graph = run ? workflowSvg(W, run) : null
      return (
        <Box flexDirection="column" gap={1}>
          {flow.loop && (
            <Svg
              key="loop"
              source={loopSvg(W, flow.loop)}
              alt={`Loop, round ${flow.loop.round}, stage ${STAGE_LABEL[flow.loop.stage]}, ${nextText(flow.loop)}`}
              width={W}
              height={LOOP_HEIGHT}
            />
          )}
          {run && graph && (
            <Svg
              key={`run-${run.id}`}
              source={graph.source}
              alt={`Workflow ${run.name}: ${run.agents.length} agents, ${STATUS_LABEL[runStatus(run)]}`}
              width={W}
              height={graph.height}
            />
          )}
          {older > 0 && <Text dimColor>{older} earlier workflows in this session</Text>}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {flow.loop && (
          <Box flexDirection="column">
            <Text bold color={VIOLET}>LOOP · round {flow.loop.round}</Text>
            <Text>● {STAGE_LABEL[flow.loop.stage]} <Text dimColor>· {nextText(flow.loop)}</Text></Text>
          </Box>
        )}
        {run && (
          <Box flexDirection="column">
            <Text bold color={VIOLET}>WORKFLOW · {run.name} <Text dimColor>· {STATUS_LABEL[runStatus(run)]}</Text></Text>
            {run.agents.map(agent => (
              <Text key={agent.agentId ?? `i${agent.index}`} color={agent.status === 'error' ? 'error' : agent.status === 'ok' ? 'success' : undefined}>
                {agent.index}. {agent.name}{' '}
                <Text dimColor>
                  {[...agent.children.map(c => `${c.kind === 'skill' ? 'skill' : 'MCP'} ${c.name}`), ...Object.entries(agent.counts).map(([t, n]) => `${t} ×${n}`)].join(' · ')}
                </Text>
              </Text>
            ))}
          </Box>
        )}
        <Text dimColor>The graph is drawn in the desktop app.</Text>
      </Box>
    )
  })
}
