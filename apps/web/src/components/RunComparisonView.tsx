/**
 * Per-node comparison renderer for the Replay Lab. Reads the typed
 * payload `GET /runs/compare` returns and displays one row per node
 * with status pills, output equality, latency delta, and cost delta.
 *
 * Used by `ReplayLabDialog.tsx` after the lab run reaches terminal
 * status; the dialog fetches the comparison and hands the result to
 * this component for rendering.
 */

import React, { useMemo } from 'react'
import { ArrowRight, Minus, Check, AlertCircle, Beaker } from 'lucide-react'

export type RunComparisonNodeSide = {
  status: string
  latencyMs: number | null
  costUsd: number | null
  tokens: number
  output: unknown
  errorJson: unknown
}

export type RunComparisonNode = {
  nodeId: string
  base: RunComparisonNodeSide
  replay: RunComparisonNodeSide
}

export type RunComparisonRunSummary = {
  id: string
  status: string
  replayMode: string | null
  parentRunId: string | null
  createdAt: string | null
}

export type RunComparisonPayload = {
  baseRun: RunComparisonRunSummary
  replayRun: RunComparisonRunSummary
  perNode: RunComparisonNode[]
}

type Equality = 'equal' | 'changed' | 'only-base' | 'only-replay'

type SummaryStats = {
  changedNodes: number
  totalNodes: number
  baseTotalLatencyMs: number
  replayTotalLatencyMs: number
  baseTotalCostUsd: number | null
  replayTotalCostUsd: number | null
}

function classifyEquality(node: RunComparisonNode): Equality {
  if (node.base.status === 'missing') return 'only-replay'
  if (node.replay.status === 'missing') return 'only-base'
  const baseJson = stableStringify(node.base.output)
  const replayJson = stableStringify(node.replay.output)
  if (node.base.status === node.replay.status && baseJson === replayJson) return 'equal'
  return 'changed'
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value, replacer)
  } catch {
    return ''
  }
}

function replacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    const out: Record<string, unknown> = {}
    for (const k of keys) out[k] = (value as Record<string, unknown>)[k]
    return out
  }
  return value
}

function formatLatency(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function formatLatencyDelta(base: number | null, replay: number | null): string {
  if (base === null || replay === null) return '—'
  const delta = replay - base
  if (Math.abs(delta) < 1) return '≈'
  const sign = delta > 0 ? '+' : '-'
  return `${sign}${formatLatency(Math.abs(delta))}`
}

function formatCost(value: number | null): string {
  if (value === null) return '—'
  if (value === 0) return '$0'
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

function formatCostDelta(base: number | null, replay: number | null): string {
  if (base === null && replay === null) return '—'
  const safeBase = base ?? 0
  const safeReplay = replay ?? 0
  const delta = safeReplay - safeBase
  if (Math.abs(delta) < 0.00005) return '≈'
  const sign = delta > 0 ? '+' : '-'
  return `${sign}${formatCost(Math.abs(delta))}`
}

function statusToTone(status: string): 'success' | 'warn' | 'danger' | 'neutral' {
  if (status === 'succeeded') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'cancelled' || status === 'timed_out' || status === 'skipped') return 'warn'
  return 'neutral'
}

function computeSummary(perNode: RunComparisonNode[]): SummaryStats {
  let changed = 0
  let baseLatency = 0
  let replayLatency = 0
  let baseCost: number | null = null
  let replayCost: number | null = null

  for (const node of perNode) {
    const equality = classifyEquality(node)
    if (equality !== 'equal') changed += 1
    if (node.base.latencyMs !== null) baseLatency += node.base.latencyMs
    if (node.replay.latencyMs !== null) replayLatency += node.replay.latencyMs
    if (node.base.costUsd !== null) baseCost = (baseCost ?? 0) + node.base.costUsd
    if (node.replay.costUsd !== null) replayCost = (replayCost ?? 0) + node.replay.costUsd
  }

  return {
    changedNodes: changed,
    totalNodes: perNode.length,
    baseTotalLatencyMs: baseLatency,
    replayTotalLatencyMs: replayLatency,
    baseTotalCostUsd: baseCost,
    replayTotalCostUsd: replayCost,
  }
}

const EQUALITY_LABEL: Record<Equality, string> = {
  equal: 'Equal',
  changed: 'Changed',
  'only-base': 'Only base',
  'only-replay': 'Only replay',
}

export function RunComparisonView({ payload }: { payload: RunComparisonPayload }) {
  const summary = useMemo(() => computeSummary(payload.perNode), [payload.perNode])

  if (payload.perNode.length === 0) {
    return (
      <div className="we-comparison-empty" role="status">
        No nodes ran in either run. Nothing to compare.
      </div>
    )
  }

  return (
    <div className="we-comparison">
      <header className="we-comparison-summary" aria-label="Replay comparison summary">
        <div className="we-comparison-summary__line">
          <Beaker size={14} aria-hidden="true" />
          <span>
            <strong>{summary.changedNodes}</strong> of {summary.totalNodes} {summary.totalNodes === 1 ? 'node' : 'nodes'} changed
          </span>
          <span aria-hidden="true">·</span>
          <span>Replay <strong>{payload.replayRun.status}</strong></span>
          <span aria-hidden="true">·</span>
          <span>
            latency {formatLatency(summary.baseTotalLatencyMs)}
            <ArrowRight size={12} aria-hidden="true" style={{ verticalAlign: 'middle', margin: '0 4px' }} />
            {formatLatency(summary.replayTotalLatencyMs)}
            <span className="we-comparison-delta">
              ({formatLatencyDelta(summary.baseTotalLatencyMs, summary.replayTotalLatencyMs)})
            </span>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            cost {formatCost(summary.baseTotalCostUsd)}
            <ArrowRight size={12} aria-hidden="true" style={{ verticalAlign: 'middle', margin: '0 4px' }} />
            {formatCost(summary.replayTotalCostUsd)}
            <span className="we-comparison-delta">
              ({formatCostDelta(summary.baseTotalCostUsd, summary.replayTotalCostUsd)})
            </span>
          </span>
        </div>
      </header>

      <table className="we-comparison-table" role="table" aria-label="Per-node comparison">
        <thead>
          <tr>
            <th scope="col">Node</th>
            <th scope="col">Base</th>
            <th scope="col">Replay</th>
            <th scope="col">Output</th>
            <th scope="col">Latency Δ</th>
            <th scope="col">Cost Δ</th>
          </tr>
        </thead>
        <tbody>
          {payload.perNode.map((node) => {
            const equality = classifyEquality(node)
            return (
              <tr
                key={node.nodeId}
                className={`we-comparison-row we-comparison-row--${equality}`}
                data-testid={`comparison-row-${node.nodeId}`}
              >
                <td className="we-comparison-cell-node">{node.nodeId}</td>
                <td>
                  <StatusPill status={node.base.status} />
                </td>
                <td>
                  <StatusPill status={node.replay.status} />
                </td>
                <td>
                  <EqualityChip equality={equality} />
                </td>
                <td className="we-comparison-cell-num">
                  {formatLatencyDelta(node.base.latencyMs, node.replay.latencyMs)}
                </td>
                <td className="we-comparison-cell-num">
                  {formatCostDelta(node.base.costUsd, node.replay.costUsd)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function StatusPill({ status }: { status: string }) {
  if (status === 'missing') {
    return (
      <span className="we-comparison-pill we-comparison-pill--neutral" aria-label="missing">
        <Minus size={11} aria-hidden="true" /> —
      </span>
    )
  }
  const tone = statusToTone(status)
  return (
    <span className={`we-comparison-pill we-comparison-pill--${tone}`}>
      {tone === 'success' && <Check size={11} aria-hidden="true" />}
      {tone === 'danger' && <AlertCircle size={11} aria-hidden="true" />}
      {status}
    </span>
  )
}

function EqualityChip({ equality }: { equality: Equality }) {
  return (
    <span className={`we-comparison-chip we-comparison-chip--${equality}`}>
      {EQUALITY_LABEL[equality]}
    </span>
  )
}
