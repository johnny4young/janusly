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
import { useT } from '../i18n'
import { t as runtimeT } from '../i18n/runtime'

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

const TAG_KEYS: Record<ChangeTag, string> = {
  secret_ref: 'diff.tag.secret_ref',
  retry: 'diff.tag.retry',
  timeout: 'diff.tag.timeout',
  approval: 'diff.tag.approval',
  bounds: 'diff.tag.bounds',
  rationale: 'diff.tag.rationale',
}

export function WorkflowDiffView({
  before,
  after,
  beforeLabel,
  afterLabel,
  aiPatchRationale,
}: WorkflowDiffViewProps) {
  const { t } = useT()
  const resolvedBeforeLabel = beforeLabel ?? (t('diff.beforeLabel') as string)
  const resolvedAfterLabel = afterLabel ?? (t('diff.afterLabel') as string)
  const diff = useMemo(() => computeWorkflowDiff(before, after), [before, after])

  if (diff.summary.totalChanges === 0) {
    return (
      <section className="we-diff-section">
        <div className="we-diff-summary">
          <GitBranch size={14} aria-hidden="true" />
          <span>
            <strong>{resolvedBeforeLabel}</strong> → <strong>{resolvedAfterLabel}</strong>
          </span>
          <span className="helper-text">{t('diff.noChanges')}</span>
        </div>
      </section>
    )
  }

  return (
    <section className="we-diff-section" aria-label={t('diff.aria')}>
      <div className="we-diff-summary">
        <GitBranch size={14} aria-hidden="true" />
        <span>
          <strong>{resolvedBeforeLabel}</strong> → <strong>{resolvedAfterLabel}</strong>
        </span>
        <span className="helper-text">{summarize(diff)}</span>
      </div>

      {diff.workflow.length > 0 && (
        <div className="we-diff-block">
          <div className="section-kicker">{t('diff.workflow')}</div>
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
          <div className="section-kicker">{t('diff.nodes')}</div>
          <ul className="we-diff-list">
            {diff.nodes.map((change) => (
              <li
                key={nodeChangeKey(change)}
                className={`we-diff-row we-diff-row--${nodeChangeKindClass(change.kind)}`}
              >
                {change.kind === 'added' && (
                  <NodeAddedOrRemovedRow icon={<Plus size={12} aria-hidden="true" />} verbKey="diff.verb.added" change={change} />
                )}
                {change.kind === 'removed' && (
                  <NodeAddedOrRemovedRow icon={<Minus size={12} aria-hidden="true" />} verbKey="diff.verb.removed" change={change} />
                )}
                {change.kind === 'changed' && <NodeChangedRow change={change} />}
              </li>
            ))}
          </ul>
        </div>
      )}

      {diff.edges.length > 0 && (
        <div className="we-diff-block">
          <div className="section-kicker">{t('diff.edges')}</div>
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
          <div className="section-kicker">{t('diff.aiPatchRationale')}</div>
          <p className="helper-text">{aiPatchRationale}</p>
        </div>
      )}
    </section>
  )
}

/* ----------------------------- Sub-components ---------------------------- */

function NodeAddedOrRemovedRow({
  icon,
  verbKey,
  change,
}: {
  icon: React.ReactNode
  verbKey: 'diff.verb.added' | 'diff.verb.removed'
  change: Extract<WorkflowDiff['nodes'][number], { kind: 'added' | 'removed' }>
}) {
  const { t } = useT()
  return (
    <div className="we-diff-row__head">
      <span className="we-diff-row__verb">
        {icon} {t(verbKey)}
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
  const { t } = useT()
  // Tags render once per field below — no head-level tag here, otherwise
  // a single retry change shows the "Retry" pill twice.
  return (
    <>
      <div className="we-diff-row__head">
        <span className="we-diff-row__verb">{t('diff.verb.changed')}</span>
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
  const { t } = useT()
  if (change.kind === 'added') {
    return (
      <div className="we-diff-row__head">
        <span className="we-diff-row__verb">
          <Plus size={12} aria-hidden="true" /> {t('diff.verb.added')}
        </span>
        <code className="we-diff-row__id">{change.edgeKey}</code>
        {change.edge.condition && (
          <span className="we-diff-condition" title={change.edge.condition}>
            {t('diff.condition.when', { condition: truncate(change.edge.condition, 60) })}
          </span>
        )}
      </div>
    )
  }
  if (change.kind === 'removed') {
    return (
      <div className="we-diff-row__head">
        <span className="we-diff-row__verb">
          <Minus size={12} aria-hidden="true" /> {t('diff.verb.removed')}
        </span>
        <code className="we-diff-row__id">{change.edgeKey}</code>
      </div>
    )
  }
  return (
    <>
      <div className="we-diff-row__head">
        <span className="we-diff-row__verb">{t('diff.verb.changed')}</span>
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
  const { t } = useT()
  // A `secret_ref`-tagged change either points at a sensitive key name
  // (`apiKey` / `Authorization` / …) or carries a `{{secret.X}}` /
  // supported `{{secret.X}}` / `{{env.X}}` template. In either case the raw
  // before/after values are unsafe to render in the DOM — a workflow
  // version that literally embedded a token before being templated
  // would leak it through the diff. Mask both sides with `[redacted]`
  // and rely on the path + tag pill to communicate the change.
  const isSecret = change.tag === 'secret_ref'
  const redacted = t('diff.redacted') as string
  const beforeDisplay = isSecret ? redacted : formatValue(change.before)
  const afterDisplay = isSecret ? redacted : formatValue(change.after)
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
  const { t } = useT()
  return (
    <span className={`we-diff-tag we-diff-tag--${tag}`}>
      {tag === 'secret_ref' && <ShieldAlert size={11} aria-hidden="true" />}
      {t(TAG_KEYS[tag] as never) as string}
    </span>
  )
}

/* ----------------------------- Utilities --------------------------------- */

function summarize(diff: WorkflowDiff): string {
  const parts: string[] = []
  const { summary } = diff
  if (summary.nodesAdded) parts.push(runtimeT('diff.summary.nodesAdded', { count: summary.nodesAdded }) as string)
  if (summary.nodesRemoved) parts.push(runtimeT('diff.summary.nodesRemoved', { count: summary.nodesRemoved }) as string)
  if (summary.nodesChanged) parts.push(runtimeT('diff.summary.nodesChanged', { count: summary.nodesChanged }) as string)
  if (summary.edgesAdded) parts.push(runtimeT('diff.summary.edgesAdded', { count: summary.edgesAdded }) as string)
  if (summary.edgesRemoved) parts.push(runtimeT('diff.summary.edgesRemoved', { count: summary.edgesRemoved }) as string)
  if (summary.edgesChanged) parts.push(runtimeT('diff.summary.edgesChanged', { count: summary.edgesChanged }) as string)
  if (diff.workflow.length > 0) parts.push(runtimeT('diff.summary.workflowFields', { count: diff.workflow.length }) as string)
  return parts.length === 0 ? (runtimeT('diff.summary.empty') as string) : parts.join(' · ')
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
