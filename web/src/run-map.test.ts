import { describe, expect, it } from 'vitest'

import { formatRunCost, laneStepLabel, liveElapsedMs, projectAgentLanes, projectRunMapOverlays, type RunMap, type RunMapSnapshot } from './run-map'
import type { RunNode } from './types'

type MapNode = RunMap['nodes'][number]

function mapNode(nodeId: string, overrides: Partial<MapNode> = {}): MapNode {
  return {
    nodeId, type: 'http', status: 'succeeded', attempts: 1,
    startedAt: '2026-11-07T10:00:00Z', finishedAt: '2026-11-07T10:00:05Z', elapsedMs: 5_000,
    costUsd: 0, tokens: 0, stuck: false, needsYou: false, waitingKind: null, childRunId: null,
    ...overrides,
  }
}

function snapshot(nodes: MapNode[], status: RunMap['run']['status'] = 'running', lanes: RunMap['lanes'] = []): RunMapSnapshot {
  return {
    runId: 'run-1',
    receivedAt: 1_000,
    map: {
      run: { id: 'run-1', status, workflowVersionId: 'v1', parentRunId: null },
      nodes, lanes, totals: { costUsd: 0, tokens: 0 },
    },
  }
}

const toolWaiting: RunNode = {
  nodeId: 'gate', status: 'waiting',
  stateJson: { waiting: { kind: 'tool_approval', approvalId: 'ta-1', tool: 'http.request', paramsDigest: 'd1', params: {} } },
}
const running = { status: 'running', replayMode: null }

describe('projectRunMapOverlays', () => {
  it('offers a tool approval only with its full binding while the live step still waits', () => {
    const map = snapshot([mapNode('gate', { status: 'waiting', needsYou: true, waitingKind: 'tool_approval', finishedAt: null })])
    expect(projectRunMapOverlays(map, [toolWaiting], running, true).get('gate')).toMatchObject({
      needsYou: true, decision: { kind: 'tool_approval', approvalId: 'ta-1', paramsDigest: 'd1' },
    })
    const unbound = { ...toolWaiting, stateJson: { waiting: { kind: 'tool_approval', approvalId: 'ta-1' } } }
    expect(projectRunMapOverlays(map, [unbound], running, true).get('gate')).toMatchObject({ needsYou: true, decision: null })
    const resumed = { ...toolWaiting, status: 'running' }
    expect(projectRunMapOverlays(map, [resumed], running, true).get('gate')).toMatchObject({ needsYou: false, decision: null })
  })

  it('never offers a decision the map did not grant the viewer', () => {
    const map = snapshot([mapNode('gate', { status: 'waiting', needsYou: false, finishedAt: null })])
    expect(projectRunMapOverlays(map, [toolWaiting], running, true).get('gate')).toMatchObject({ needsYou: false, decision: null })
  })

  it('classifies approval steps and human forms', () => {
    const map = snapshot([
      mapNode('sign', { status: 'waiting', needsYou: true, finishedAt: null }),
      mapNode('form', { status: 'waiting', needsYou: true, finishedAt: null }),
    ])
    const nodes: RunNode[] = [
      { nodeId: 'sign', status: 'waiting', stateJson: { waiting: { kind: 'approval' } } },
      { nodeId: 'form', status: 'waiting', stateJson: { waiting: { kind: 'human_form', resumeToken: 'tok', schema: { type: 'object' } } } },
    ]
    const overlays = projectRunMapOverlays(map, nodes, running, true)
    expect(overlays.get('sign')?.decision).toEqual({ kind: 'approval' })
    expect(overlays.get('form')?.decision).toEqual({ kind: 'human_form', resumeToken: 'tok' })
  })

  it('keeps counting elapsed time for an unfinished step until the run ends', () => {
    const map = snapshot([mapNode('slow', { status: 'running', finishedAt: null, elapsedMs: 40_000, stuck: true })])
    const live = projectRunMapOverlays(map, [{ nodeId: 'slow', status: 'running' }], running, true).get('slow')!
    expect(live).toMatchObject({ liveSince: 1_000, stuck: true })
    expect(liveElapsedMs(live, 6_000)).toBe(45_000)
    const ended = projectRunMapOverlays(snapshot(map.map.nodes, 'cancelled'), [{ nodeId: 'slow', status: 'cancelled' }], { status: 'cancelled' }, true).get('slow')!
    expect(ended).toMatchObject({ liveSince: null, stuck: false })
    expect(liveElapsedMs(ended, 60_000)).toBe(40_000)
  })

  it('offers rerun from finished steps of a finished, non-replay run to people who may start runs', () => {
    const map = snapshot([mapNode('done'), mapNode('skip', { status: 'skipped' })], 'succeeded')
    const nodes: RunNode[] = [{ nodeId: 'done', status: 'succeeded' }, { nodeId: 'skip', status: 'skipped' }]
    const finished = { status: 'succeeded', replayMode: null }
    expect(projectRunMapOverlays(map, nodes, finished, true).get('done')?.rerun).toBe(true)
    expect(projectRunMapOverlays(map, nodes, finished, true).get('skip')?.rerun).toBe(false)
    expect(projectRunMapOverlays(map, nodes, finished, false).get('done')?.rerun).toBe(false)
    expect(projectRunMapOverlays(map, nodes, { status: 'succeeded', replayMode: 'validation' }, true).get('done')?.rerun).toBe(false)
    expect(projectRunMapOverlays(map, nodes, running, true).get('done')?.rerun).toBe(false)
  })

  it('carries cost, attempts and the child run', () => {
    const map = snapshot([mapNode('child', { attempts: 3, costUsd: 0.0125, tokens: 1_200, childRunId: 'run-2' })])
    expect(projectRunMapOverlays(map, [], running, true).get('child')).toMatchObject({
      attempts: 3, costUsd: 0.0125, tokens: 1_200, childRunId: 'run-2',
    })
    expect(projectRunMapOverlays(null, [], running, true).size).toBe(0)
  })
})

describe('projectAgentLanes', () => {
  it('draws agent and crew lanes, one track per crew agent, without duplicate lifecycle rows', () => {
    const lanes = projectAgentLanes([
      { nodeId: 'think', kind: 'agent', steps: [
        { type: 'agent.step.started', at: '2026-11-07T10:00:00Z', agent: 'agent', iteration: 0 },
        { type: 'agent.tool.started', at: '2026-11-07T10:00:01Z', tool: 'http.request' },
        { type: 'agent.completed', at: '2026-11-07T10:00:02Z' },
      ], truncated: false },
      { nodeId: 'crew', kind: 'multi_agent', steps: [
        { type: 'multi_agent.started', at: null },
        { type: 'multi_agent.agent.started', at: null, name: 'researcher', index: 0 },
        { type: 'multi_agent.agent.0.started', at: null, agent: 'researcher' },
        { type: 'multi_agent.agent.0.tool.started', at: null, agent: 'researcher', tool: 'search' },
        { type: 'agent.reasoning', at: null, agent: 'researcher' },
        { type: 'multi_agent.agent.failed', at: null, name: 'writer', index: 1, status: 'failed' },
        { type: 'multi_agent.completed', at: null },
      ], truncated: true },
    ])
    expect(lanes[0]).toMatchObject({ nodeId: 'think', kind: 'agent', stepCount: 3, truncated: false })
    expect(lanes[1]).toMatchObject({ nodeId: 'crew', truncated: true })
    expect(lanes[0]!.tracks).toHaveLength(1)
    expect(lanes[0]!.tracks[0]!.steps.map(view => view.tone)).toEqual(['info', 'tool', 'success'])
    expect(lanes[1]!.stepCount).toBe(6)
    expect(lanes[1]!.tracks.map(track => track.agent)).toEqual([null, 'researcher', 'writer'])
    expect(lanes[1]!.tracks[1]!.steps.map(view => view.step.type)).toContain('agent.reasoning')
    expect(lanes[1]!.tracks[2]!.steps[0]!.tone).toBe('error')
  })

  it('labels steps through catalog keys', () => {
    expect(laneStepLabel({ type: 'agent.step.started', at: null, iteration: 1 })).toEqual({ key: 'multiAgent.stepStarted', params: { step: 2 } })
    expect(laneStepLabel({ type: 'agent.tool.started', at: null, tool: 'crm.lookup' })).toEqual({ key: 'multiAgent.toolStarted', params: { tool: 'crm.lookup' } })
    expect(laneStepLabel({ type: 'agent.tool.started', at: null }).key).toBe('multiAgent.legend.tool')
    expect(laneStepLabel({ type: 'multi_agent.agent.completed', at: null, name: 'writer' })).toEqual({ key: 'multiAgent.agentCompleted', params: { name: 'writer' } })
    expect(laneStepLabel({ type: 'agent.memory.recalled', at: null }).key).toBe('runWorkspace.lanes.step.memory')
    expect(laneStepLabel({ type: 'agent.custom', at: null })).toEqual({ key: 'runWorkspace.lanes.step.other', params: { type: 'agent.custom' } })
  })
})

describe('formatRunCost', () => {
  it('keeps two significant digits for small costs without rounding away dollars', () => {
    expect(formatRunCost(0.0125, 'en')).toBe('$0.013')
    expect(formatRunCost(1234.56, 'en')).toBe('$1,234.56')
  })
})
