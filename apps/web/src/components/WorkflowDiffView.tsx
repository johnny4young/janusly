/**
 * Visual structural diff between two workflow snapshots. Computes the
 * diff via `computeWorkflowDiff` (pure shared helper) and renders four
 * sections: header summary, workflow-level field changes, node changes,
 * edge changes. AC-required signals (retry / timeout / secret_ref /
 * approval / bounds) get severity-tinted pills so the operator spots
 * meaningful changes at a glance.
 *
 * Used by `VersionHistoryPanel.tsx` (Compare-mode picker) and slated for
 * reuse by the Recovery MVP when an AI patch lands — pass the saved
 * workflow as `before`, the proposed patch as `after`, and the LLM's
 * rationale as `aiPatchRationale`.
 *
 * Visual posture mirrors the existing readiness/health badge surfaces —
 * inline panel sections, `section-kicker` headings, severity pills via
 * `--we-*` aliases (no inline hex). No animation / focus trap because
 * this is an inline panel, not a modal.
 */

import React, { useMemo } from 'react'
import { GitBranch, Minus, Plus, ShieldAlert } from 'lucide-react'
import {
  computeWorkflowDiff,
  type ChangeTag,
  type FieldChange,
  type WorkflowDiff,
} from '@janusly/shared/src/workflow-diff'
import type { WorkflowDefinition } from '../types'

type WorkflowDiffViewProps = {
  before: WorkflowDefinition
  after: WorkflowDefinition
  /** Display label for the `before` side (e.g. `"v3 — saved 2h ago"`). */
  beforeLabel?: string
  /** Display label for the `after` side. */
  afterLabel?: string
  /** Optional rationale text rendered below the diff (Recovery MVP hookup). */
  aiPatchRationale?: string
}

const TAG_LABELS: Record<ChangeTag, string> = {
  secret_ref: 'Secret-ref',
  retry: 'Retry',
  timeout: 'Timeout',
  approval: 'Approval',
  bounds: 'Bounds',
  rationale: 'Metadata',
}

export function WorkflowDiffView({
  before,
  after,
  beforeLabel = 'Before',
  afterLabel = 'After',
  aiPatchRationale,
}: WorkflowDiffViewProps) {
  const diff = useMemo(() => computeWorkflowDiff(before, after), [before, after])

  if (diff.summary.totalChanges === 0) {
    return (
      <section className="we-diff-section">
        <div className="we-diff-summary">
          <GitBranch size={14} aria-hidden="true" />
          <span>
            <strong>{beforeLabel}</strong> → <strong>{afterLabel}</strong>
          </span>
          <span className="helper-text">No structural changes between these versions.</span>
        </div>
      </section>
    )
  }

  return (
    <section className="we-diff-section" aria-label="Structural workflow diff">
      <div className="we-diff-summary">
        <GitBranch size={14} aria-hidden="true" />
        <span>
          <strong>{beforeLabel}</strong> → <strong>{afterLabel}</strong>
        </span>
        <span className="helper-text">{summarize(diff)}</span>
      </div>

      {diff.workflow.length > 0 && (
        <div className="we-diff-block">
          <div className="section-kicker">Workflow</div>
          <ul className="we-diff-list">
            {diff.workflow.map((change) => (
              <li key={change.path} className="we-diff-row we-diff-row--changed">
                <FieldChangeRow change={change} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {diff.nodes.length > 0 && (
        <div className="we-diff-block">
          <div className="section-kicker">Nodes</div>
          <ul className="we-diff-list">
            {diff.nodes.map((change) => (
              <li
                key={nodeChangeKey(change)}
                className={`we-diff-row we-diff-row--${nodeChangeKindClass(change.kind)}`}
              >
                {change.kind === 'added' && (
                  <NodeAddedOrRemovedRow icon={<Plus size={12} aria-hidden="true" />} verb="Added" change={change} />
                )}
                {change.kind === 'removed' && (
                  <NodeAddedOrRemovedRow icon={<Minus size={12} aria-hidden="true" />} verb="Removed" change={change} />
                )}
                {change.kind === 'changed' && <NodeChangedRow change={change} />}
              </li>
            ))}
          </ul>
        </div>
      )}

      {diff.edges.length > 0 && (
        <div className="we-diff-block">
          <div className="section-kicker">Edges</div>
          <ul className="we-diff-list">
            {diff.edges.map((change) => (
              <li
                key={`${change.kind}:${change.edgeKey}`}
                className={`we-diff-row we-diff-row--${kindClass(change.kind)}`}
              >
                <EdgeChangeRow change={change} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {aiPatchRationale && aiPatchRationale.trim().length > 0 && (
        <div className="we-diff-block we-diff-rationale">
          <div className="section-kicker">AI patch rationale</div>
          <p className="helper-text">{aiPatchRationale}</p>
        </div>
      )}
    </section>
  )
}

/* ----------------------------- Sub-components ---------------------------- */

function NodeAddedOrRemovedRow({
  icon,
  verb,
  change,
}: {
  icon: React.ReactNode
  verb: 'Added' | 'Removed'
  change: Extract<WorkflowDiff['nodes'][number], { kind: 'added' | 'removed' }>
}) {
  return (
    <div className="we-diff-row__head">
      <span className="we-diff-row__verb">
        {icon} {verb}
      </span>
      <code className="we-diff-row__id">{change.node.id}</code>
      <span className="mode-pill mode-pill-neutral">{change.node.type}</span>
      {change.tag && <TagPill tag={change.tag} />}
    </div>
  )
}

function NodeChangedRow({
  change,
}: {
  change: Extract<WorkflowDiff['nodes'][number], { kind: 'changed' }>
}) {
  // Tags render once per field below — no head-level tag here, otherwise
  // a single retry change shows the "Retry" pill twice.
  return (
    <>
      <div className="we-diff-row__head">
        <span className="we-diff-row__verb">Changed</span>
        <code className="we-diff-row__id">{change.nodeId}</code>
        <span className="mode-pill mode-pill-neutral">{change.nodeType}</span>
      </div>
      <ul className="we-diff-fields">
        {change.fields.map((field) => (
          <li key={field.path}>
            <FieldChangeRow change={field} />
          </li>
        ))}
      </ul>
    </>
  )
}

function EdgeChangeRow({ change }: { change: WorkflowDiff['edges'][number] }) {
  if (change.kind === 'added') {
    return (
      <div className="we-diff-row__head">
        <span className="we-diff-row__verb">
          <Plus size={12} aria-hidden="true" /> Added
        </span>
        <code className="we-diff-row__id">{change.edgeKey}</code>
        {change.edge.condition && (
          <span className="we-diff-condition" title={change.edge.condition}>
            when {truncate(change.edge.condition, 60)}
          </span>
        )}
      </div>
    )
  }
  if (change.kind === 'removed') {
    return (
      <div className="we-diff-row__head">
        <span className="we-diff-row__verb">
          <Minus size={12} aria-hidden="true" /> Removed
        </span>
        <code className="we-diff-row__id">{change.edgeKey}</code>
      </div>
    )
  }
  return (
    <>
      <div className="we-diff-row__head">
        <span className="we-diff-row__verb">Changed</span>
        <code className="we-diff-row__id">{change.edgeKey}</code>
      </div>
      <ul className="we-diff-fields">
        {change.fields.map((field) => (
          <li key={field.path}>
            <FieldChangeRow change={field} />
          </li>
        ))}
      </ul>
    </>
  )
}

function FieldChangeRow({ change }: { change: FieldChange }) {
  // A `secret_ref`-tagged change either points at a sensitive key name
  // (`apiKey` / `Authorization` / …) or carries a `{{secret.X}}` /
  // `{{credential.X}}` / `{{env.X}}` template. In either case the raw
  // before/after values are unsafe to render in the DOM — a workflow
  // version that literally embedded a token before being templated
  // would leak it through the diff. Mask both sides with `[redacted]`
  // and rely on the path + tag pill to communicate the change.
  const isSecret = change.tag === 'secret_ref'
  const beforeDisplay = isSecret ? '[redacted]' : formatValue(change.before)
  const afterDisplay = isSecret ? '[redacted]' : formatValue(change.after)
  return (
    <div className="we-diff-field">
      <code className="we-diff-field__path">{change.path}</code>
      <span className="we-diff-field__values">
        <code className="we-diff-field__before">{beforeDisplay}</code>
        <span aria-hidden="true">→</span>
        <code className="we-diff-field__after">{afterDisplay}</code>
      </span>
      {change.tag && <TagPill tag={change.tag} />}
    </div>
  )
}

function TagPill({ tag }: { tag: ChangeTag }) {
  return (
    <span className={`we-diff-tag we-diff-tag--${tag}`}>
      {tag === 'secret_ref' && <ShieldAlert size={11} aria-hidden="true" />}
      {TAG_LABELS[tag]}
    </span>
  )
}

/* ----------------------------- Utilities --------------------------------- */

function summarize(diff: WorkflowDiff): string {
  const parts: string[] = []
  const { summary } = diff
  if (summary.nodesAdded) parts.push(`+${summary.nodesAdded} node${summary.nodesAdded === 1 ? '' : 's'}`)
  if (summary.nodesRemoved) parts.push(`−${summary.nodesRemoved} node${summary.nodesRemoved === 1 ? '' : 's'}`)
  if (summary.nodesChanged) parts.push(`${summary.nodesChanged} node${summary.nodesChanged === 1 ? '' : 's'} changed`)
  if (summary.edgesAdded) parts.push(`+${summary.edgesAdded} edge${summary.edgesAdded === 1 ? '' : 's'}`)
  if (summary.edgesRemoved) parts.push(`−${summary.edgesRemoved} edge${summary.edgesRemoved === 1 ? '' : 's'}`)
  if (summary.edgesChanged) parts.push(`${summary.edgesChanged} edge${summary.edgesChanged === 1 ? '' : 's'} changed`)
  if (diff.workflow.length > 0) parts.push(`${diff.workflow.length} workflow field${diff.workflow.length === 1 ? '' : 's'}`)
  return parts.length === 0 ? 'No changes' : parts.join(' · ')
}

function nodeChangeKey(change: WorkflowDiff['nodes'][number]): string {
  if (change.kind === 'changed') return `changed:${change.nodeId}`
  return `${change.kind}:${change.node.id}`
}

function nodeChangeKindClass(kind: 'added' | 'removed' | 'changed'): string {
  return kind
}

function kindClass(kind: 'added' | 'removed' | 'changed'): string {
  return kind
}

function formatValue(value: unknown): string {
  if (value === undefined) return '∅'
  if (value === null) return 'null'
  if (typeof value === 'string') return truncate(JSON.stringify(value), 80)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return truncate(JSON.stringify(value), 80)
  } catch {
    return String(value)
  }
}

function truncate(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input
  return `${input.slice(0, maxLength - 1)}…`
}
