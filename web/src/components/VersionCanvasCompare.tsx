import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import { createPortal } from 'react-dom'
import { Background, BackgroundVariant, Controls, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react'
import type { AriaLabelConfig, EdgeProps, NodeProps } from '@xyflow/react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
// Reach the canvas entry statically so React Flow and the step renderers stay in its chunk.
import './CanvasWorkspace'
import { getNodeLabel } from '../constants'
import { useT } from '../i18n'
import { useWorkflowStore } from '../store'
import type { WorkflowDefinition } from '../types'
import { Button } from './ui/Button'
import { buildVersionCompare, type CompareChange, type CompareGraphEdge, type CompareGraphNode, type CompareMark } from './version-compare-model'
import { WorkflowEdge } from './WorkflowEdge'
import { WorkflowStepNode } from './WorkflowStepNode'
import './VersionCanvasCompare.css'

const MARKS: readonly CompareMark[] = ['added', 'changed', 'removed']
const PILL_TONE: Record<CompareMark, string> = { added: 'success', changed: 'warning', removed: 'danger' }
// A new object per render would overwrite the options of a queued fitView call.
const INITIAL_FIT = { padding: 0.15 }

function CompareStepNode(props: NodeProps<CompareGraphNode>) {
  const { t } = useT()
  const mark = props.data.compareMark
  return (
    <div className="version-compare-node" data-mark={mark}>
      <WorkflowStepNode {...(props as ComponentProps<typeof WorkflowStepNode>)} />
      {mark && (
        <span className="version-compare-node__mark" data-testid="version-compare-mark" title={t(`versionCompare.mark.${mark}`)}>
          {t(`versionCompare.short.${mark}`)}
        </span>
      )}
    </div>
  )
}

function CompareEdge(props: EdgeProps<CompareGraphEdge>) {
  return (
    <g className="version-compare-edge" data-mark={props.data?.compareMark}>
      <WorkflowEdge {...(props as ComponentProps<typeof WorkflowEdge>)} />
    </g>
  )
}

const compareNodeTypes = { versionCompareStep: CompareStepNode }
const compareEdgeTypes = { versionCompareEdge: CompareEdge }

function JsonBlock({ side, label, json, other }: { side: 'before' | 'after'; label: string; json: string; other?: string }) {
  const comparable = (line: string) => line.replace(/,$/, '')
  const otherLines = other === undefined ? null : new Set(other.split('\n').map(comparable))
  return (
    <div className="version-compare__side">
      <span className="section-kicker">{label}</span>
      <pre className="version-compare__json" data-side={side} data-testid={`version-compare-json-${side}`}>
        {json.split('\n').map((line, index) => (
          <span key={index} data-changed={otherLines && !otherLines.has(comparable(line)) ? 'true' : undefined}>{line}{'\n'}</span>
        ))}
      </pre>
    </div>
  )
}

type SavedVersion = { id: string; version: number; dagJson: WorkflowDefinition }

function CompareBody({ before, after, beforeLabel, afterLabel, onClose }: {
  before: WorkflowDefinition
  after: WorkflowDefinition
  beforeLabel: string
  afterLabel: string
  onClose: () => void
}) {
  const { t } = useT()
  const { fitView } = useReactFlow()
  const graph = useMemo(() => buildVersionCompare(before, after), [before, after])
  const [selected, setSelected] = useState(0)
  const active: CompareChange | undefined = graph.changes[selected]

  const nodeTitles = useMemo(() => new Map(graph.nodes.map(node => [
    node.id, node.data.label?.trim() || getNodeLabel(node.data.type),
  ])), [graph.nodes])
  const titleOf = (change: CompareChange) => change.target === 'node'
    ? nodeTitles.get(change.canvasId) ?? change.canvasId
    : t('canvas.edgeAria', { source: nodeTitles.get(change.nodeIds[0]) ?? '', target: nodeTitles.get(change.nodeIds[1]) ?? '' })

  const nodes = useMemo(() => graph.nodes.map((node) => {
    const mark = node.data.compareMark
    return {
      ...node,
      selected: active?.target === 'node' && active.canvasId === node.id,
      ariaLabel: `${t('canvas.nodeAria', { label: nodeTitles.get(node.id) ?? node.id })}${mark ? `. ${t(`versionCompare.mark.${mark}`)}` : ''}`,
    }
  }), [active, graph.nodes, nodeTitles, t])
  const edges = useMemo(() => graph.edges.map(edge => ({
    ...edge,
    selected: active?.target === 'edge' && active.canvasId === edge.id,
    ariaLabel: t('canvas.edgeAria', { source: nodeTitles.get(edge.source) ?? edge.source, target: nodeTitles.get(edge.target) ?? edge.target }),
  })), [active, graph.edges, nodeTitles, t])
  const ariaLabelConfig = useMemo<Partial<AriaLabelConfig>>(() => ({
    'controls.ariaLabel': t('canvas.flowMap'),
    'controls.zoomIn.ariaLabel': t('canvas.a11y.zoomIn'),
    'controls.zoomOut.ariaLabel': t('canvas.a11y.zoomOut'),
    'controls.fitView.ariaLabel': t('canvas.a11y.fitView'),
  }), [t])

  const select = (target: CompareChange['target'], canvasId: string) => {
    const index = graph.changes.findIndex(change => change.target === target && change.canvasId === canvasId)
    if (index >= 0) setSelected(index)
  }
  const step = (delta: number) => {
    const next = (selected + delta + graph.changes.length) % graph.changes.length
    setSelected(next)
    void fitView({ nodes: graph.changes[next].nodeIds.map(id => ({ id })), padding: 0.5, maxZoom: 1 })
  }

  return (
    <>
      <div className="version-compare__flow">
        <div className="version-compare__summary">
          <strong data-testid="version-compare-title">{t('versionCompare.title', { before: beforeLabel, after: afterLabel })}</strong>
          <div className="version-compare__counts">
            {graph.changes.length === 0
              ? <span data-testid="version-compare-empty">{t('versionCompare.noCanvasChanges')}</span>
              : (
                <>
                  <span data-testid="version-compare-count">{t('versionCompare.changes', { count: graph.changes.length })}</span>
                  <Button size="icon" variant="ghost" data-testid="version-compare-prev" aria-label={t('versionCompare.previous')} title={t('versionCompare.previous')} onClick={() => step(-1)}>
                    <ChevronLeft size={14} aria-hidden="true" />
                  </Button>
                  <Button size="icon" variant="ghost" data-testid="version-compare-next" aria-label={t('versionCompare.next')} title={t('versionCompare.next')} onClick={() => step(1)}>
                    <ChevronRight size={14} aria-hidden="true" />
                  </Button>
                  {MARKS.map(mark => (
                    <span key={mark} className="we-pill" data-tone={PILL_TONE[mark]} data-testid={`version-compare-count-${mark}`} title={t(`versionCompare.mark.${mark}`)}>
                      {t(`versionCompare.short.${mark}`)} {graph.counts[mark]}
                    </span>
                  ))}
                </>
              )}
          </div>
          <Button size="icon" variant="ghost" data-testid="version-compare-close" aria-label={t('versionCompare.close')} title={t('versionCompare.close')} onClick={onClose}>
            <X size={14} aria-hidden="true" />
          </Button>
        </div>
        <div className="canvas-flow-surface">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={compareNodeTypes}
            edgeTypes={compareEdgeTypes}
            onNodeClick={(_, node) => select('node', node.id)}
            onEdgeClick={(_, edge) => select('edge', edge.id)}
            fitView
            fitViewOptions={INITIAL_FIT}
            minZoom={0.45}
            maxZoom={1.35}
            nodesDraggable={false}
            nodesConnectable={false}
            edgesReconnectable={false}
            deleteKeyCode={null}
            disableKeyboardA11y
            ariaLabelConfig={ariaLabelConfig}
          >
            <Background color="var(--we-grid-strong)" gap={24} size={1.2} variant={BackgroundVariant.Dots} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </div>
      {active && (
        <aside className="version-compare__detail" data-testid="version-compare-detail" aria-label={titleOf(active)} tabIndex={0}>
          <strong>{titleOf(active)} · {t(`versionCompare.mark.${active.mark}`)}</strong>
          {active.beforeJson !== undefined && <JsonBlock side="before" label={beforeLabel} json={active.beforeJson} other={active.afterJson} />}
          {active.afterJson !== undefined && <JsonBlock side="after" label={afterLabel} json={active.afterJson} other={active.beforeJson} />}
        </aside>
      )}
    </>
  )
}

/**
 * Covers the author canvas with a read-only merged graph of two versions. It
 * stays owned by the history panel, so leaving the workflow or tab closes it.
 */
export default function VersionCanvasCompare({ pair, history, onClose }: {
  /** Oldest first. Without a pair the current draft is compared against `history`. */
  pair: readonly [SavedVersion, SavedVersion] | null
  history: readonly SavedVersion[]
  onClose: () => void
}) {
  const { t } = useT()
  const [draft] = useState(() => {
    const { currentWorkflowVersion, getWorkflowJson } = useWorkflowStore.getState()
    return { base: history.find(version => version.id === currentWorkflowVersion?.id) ?? history[0], workflow: getWorkflowJson() }
  })
  const older = pair ? pair[0] : draft.base
  const newer = pair?.[1]
  const beforeLabel = `v${older.version}`
  const afterLabel = newer ? `v${newer.version}` : t('versionCompare.draft')
  const root = useRef<HTMLElement | null>(null)
  const setCanvasCovered = useWorkflowStore(state => state.setCanvasCovered)
  const workflowDirty = useWorkflowStore(state => state.workflowDirty)
  const host = document.querySelector<HTMLElement>('.canvas-frame[data-mode="author"]')
  // A saved draft has nothing left to compare, and must not reopen on the next edit.
  useEffect(() => {
    if (!pair && !workflowDirty) onClose()
  }, [onClose, pair, workflowDirty])
  useEffect(() => {
    if (!host) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setCanvasCovered(true)
    root.current?.focus()
    return () => {
      setCanvasCovered(false)
      if (opener?.isConnected) opener.focus()
    }
  }, [host, setCanvasCovered])
  if (!host) return null
  return createPortal(
    <section
      ref={root}
      className="version-compare"
      data-testid="version-compare"
      tabIndex={-1}
      aria-label={t('versionCompare.title', { before: beforeLabel, after: afterLabel })}
    >
      <ReactFlowProvider>
        <CompareBody
          key={`${beforeLabel}:${afterLabel}`}
          before={older.dagJson}
          after={newer ? newer.dagJson : draft.workflow}
          beforeLabel={beforeLabel}
          afterLabel={afterLabel}
          onClose={onClose}
        />
      </ReactFlowProvider>
    </section>,
    host,
  )
}
