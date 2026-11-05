/** Draft-only test data for one step: the data it can read, pins, mocks and test runs. */

import { useRef, useState } from 'react'
import { Pin, Play } from 'lucide-react'
import { api } from '../api'
import { getNodeLabel } from '../constants'
import { useT } from '../i18n'
import { tApiError } from '../i18n/server-events'
import { testDataFor, useTestData, type TestDatum } from '../lib/test-data'
import { useWorkflowStore } from '../store'
import type { JsonObject, WorkflowGraphEdge, WorkflowGraphNode } from '../types'
import { Button } from './ui/Button'
import { FormActions } from './ui/Form'
import './NodeTestData.css'

// The server refuses stand-ins where a person decides or a router picks a branch.
const NO_STAND_IN = new Set(['approval', 'human_form', 'router', 'router_llm'])

function ancestorsOf(nodeId: string, edges: WorkflowGraphEdge[]): Set<string> {
  const seen = new Set<string>()
  const queue = [nodeId]
  while (queue.length) {
    const current = queue.pop()
    for (const edge of edges) {
      if (edge.target === current && !seen.has(edge.source)) {
        seen.add(edge.source)
        queue.push(edge.source)
      }
    }
  }
  return seen
}

const asObject = (value: unknown): JsonObject | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined

export function NodeTestData({ node, nodes, edges, readOnly }: {
  node: WorkflowGraphNode
  nodes: WorkflowGraphNode[]
  edges: WorkflowGraphEdge[]
  readOnly: boolean
}) {
  const { t } = useT()
  const workflowId = useWorkflowStore(state => state.currentWorkflowId)
  const runId = useWorkflowStore(state => state.runId)
  const runDetail = useWorkflowStore(state => state.runDetail)
  const runNodes = useWorkflowStore(state => state.runNodes)
  const addToast = useWorkflowStore(state => state.addToast)
  const setRunId = useWorkflowStore(state => state.setRunId)
  const setRunDetail = useWorkflowStore(state => state.setRunDetail)
  const bumpPlatformVersion = useWorkflowStore(state => state.bumpPlatformVersion)
  const pins = useTestData(state => state.workflowId === workflowId ? state.pins : undefined) ?? {}
  const setDatum = useTestData(state => state.setDatum)
  const [mockDraft, setMockDraft] = useState<string | null>(null)
  const [mockError, setMockError] = useState(false)
  const [busy, setBusy] = useState(false)
  const mockRef = useRef<HTMLTextAreaElement>(null)

  const runInput = asObject(runDetail?.inputJson)
  const runWorkflowId = asObject(runInput?.workflow)?.id ?? runDetail?.workflowId
  const sameWorkflowRun = Boolean(runId && runDetail?.id === runId && runWorkflowId === workflowId)
  const runStandIns = asObject(asObject(runInput?.draftTest)?.pins) ?? {}
  const lastOutput = (id: string): { found: boolean; value?: unknown } => {
    const row = sameWorkflowRun && !runStandIns[id] ? runNodes.find(item => item.nodeId === id) : undefined
    const state = asObject(row?.stateJson)
    return row?.status === 'succeeded' && state && 'output' in state ? { found: true, value: state.output } : { found: false }
  }

  const ancestors = ancestorsOf(node.id, edges)
  const rows = nodes.filter(item => ancestors.has(item.id) || item.id === node.id).flatMap(item => {
    const datum = pins[item.id]
    const last = lastOutput(item.id)
    if (datum) {
      const source = datum.kind === 'pinned'
        ? t('testData.pinnedFrom', { run: datum.sourceRunId.slice(0, 8) })
        : t('testData.mocked')
      return [{ item, source, kind: datum.kind as string, value: datum.output }]
    }
    return last.found ? [{ item, source: t('testData.lastRun', { run: runId?.slice(0, 8) }), kind: 'last', value: last.value }] : []
  })

  const own = pins[node.id]
  const ownLast = lastOutput(node.id)
  const canStandIn = !readOnly && !NO_STAND_IN.has(node.data.type)
  const save = (datum: TestDatum | null) => setDatum(workflowId, node.id, datum)

  const saveMock = () => {
    try {
      save({ kind: 'mocked', output: JSON.parse(mockRef.current?.value ?? '') })
      setMockDraft(null)
      setMockError(false)
    } catch {
      setMockError(true)
    }
  }

  const start = async (stepNodeId?: string) => {
    const workflow = useWorkflowStore.getState().getWorkflowJson()
    const present = new Set(workflow.nodes.map(item => item.id))
    const standIns = Object.fromEntries(Object.entries(testDataFor(workflowId))
      .filter(([id]) => present.has(id))
      .map(([id, datum]) => [id, datum.kind === 'pinned' ? { sourceRunId: datum.sourceRunId } : { mock: datum.output }]))
    const input = sameWorkflowRun ? runInput?.input : undefined
    setBusy(true)
    try {
      const { runId: nextRunId } = await api('/runs/draft-test', {
        method: 'POST',
        body: JSON.stringify({ workflow, pins: standIns, ...(stepNodeId ? { stepNodeId } : {}), ...(input !== undefined ? { input } : {}) }),
      }) as { runId: string }
      setRunId(nextRunId)
      setRunDetail({ id: nextRunId, workflowId, status: 'running', replayMode: 'validation', inputJson: { workflow, draftTest: { pins: standIns } } })
      bumpPlatformVersion()
      addToast(t('testData.started', { run: nextRunId.slice(0, 8) }), 'success')
    } catch (error) {
      addToast(tApiError(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="node-test-data" data-testid="node-test-data" aria-labelledby="node-test-data-title">
      <div className="split-row">
        <h4 id="node-test-data-title">{t('testData.title')}</h4>
        <span className="we-pill" data-tone="info">{t('testData.draftOnly')}</span>
      </div>
      {rows.length === 0 && <p className="helper-text">{t('testData.empty')}</p>}
      {rows.map(row => (
        <details key={row.item.id} className="node-test-data__row" open={row.item.id === node.id} data-testid={`test-data-row-${row.item.id}`}>
          <summary>
            <span>{row.item.data.label?.trim() || getNodeLabel(row.item.data.type)}</span>
            <span className="we-pill" data-tone={row.kind === 'last' ? 'neutral' : 'primary'} data-testid={`test-data-source-${row.item.id}`}>{row.source}</span>
          </summary>
          <pre className="node-test-data__value">{JSON.stringify(row.value, null, 2) ?? 'null'}</pre>
        </details>
      ))}
      {mockDraft !== null && (
        <>
          <textarea
            ref={mockRef}
            className="ui-config-code"
            data-ui-control
            defaultValue={mockDraft}
            aria-label={t('testData.mockLabel')}
            aria-invalid={mockError || undefined}
            data-testid="test-data-mock-input"
          />
          {mockError && <p className="ui-field__error" role="alert">{t('rightPanel.inspector.invalidJsonObject')}</p>}
        </>
      )}
      <FormActions className="node-test-data__actions">
        {canStandIn && mockDraft !== null && (
          <>
            <Button size="sm" variant="primary" data-testid="test-data-mock-save" onClick={saveMock}>{t('testData.saveMock')}</Button>
            <Button size="sm" variant="ghost" data-testid="test-data-mock-cancel" onClick={() => setMockDraft(null)}>{t('common.cancel')}</Button>
          </>
        )}
        {canStandIn && mockDraft === null && (
          <>
            {!own && ownLast.found && runId && (
              <Button size="sm" leadingIcon={<Pin size={14} />} data-testid="test-data-pin"
                onClick={() => save({ kind: 'pinned', sourceRunId: runId, output: ownLast.value })}>
                {t('testData.pin')}
              </Button>
            )}
            <Button size="sm" data-testid="test-data-mock"
              onClick={() => setMockDraft(JSON.stringify(own?.output ?? ownLast.value ?? {}, null, 2))}>
              {t('testData.mock')}
            </Button>
            {own && <Button size="sm" variant="ghost" data-testid="test-data-clear" onClick={() => save(null)}>{t('testData.clear')}</Button>}
          </>
        )}
        {!readOnly && mockDraft === null && (
          <>
            <Button size="sm" variant="primary" leadingIcon={<Play size={14} />} disabled={busy} data-testid="test-data-run-step" onClick={() => { void start(node.id) }}>
              {t('testData.runStep')}
            </Button>
            <Button size="sm" disabled={busy} data-testid="test-data-run-draft" onClick={() => { void start() }}>
              {t('testData.runDraft')}
            </Button>
          </>
        )}
      </FormActions>
    </section>
  )
}
