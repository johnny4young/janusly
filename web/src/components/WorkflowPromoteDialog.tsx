import { useRef, type ReactNode } from 'react'
import { GitBranch, X } from 'lucide-react'

import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap'
import { useT } from '../i18n'
import type { WorkflowVersionRow } from '../lib/list-contract'
import { Button } from './ui/Button'
import { FormField } from './ui/Form'
import { WorkflowDiffView } from './WorkflowDiffView'
import './WorkflowPromoteDialog.css'

export type PromoteDraft = {
  baselineVersionId: string
  trafficPercent: number
  minimumSampleSize: number
  minimumSuccessRatePercent: number
}

// Form bounds for operator input mirror internal/engine/rollouts.go.
const FIELDS = [
  ['trafficPercent', 'traffic', 1, 50], // wire-policy: form bound.
  ['minimumSampleSize', 'sample', 5, 100], // wire-policy: form bound.
  ['minimumSuccessRatePercent', 'successRate', 1, 100], // wire-policy: form bound.
] as const

/** Starts the existing canary for the latest version; versions are newest first. */
export function WorkflowPromoteDialog({ versions, draft, onDraft, qualification, blocked, canStart, mutating, onStart, onClose }: {
  versions: WorkflowVersionRow[]
  draft: PromoteDraft
  onDraft: (draft: PromoteDraft) => void
  qualification: ReactNode
  blocked: boolean
  canStart: boolean
  mutating: boolean
  onStart: () => void
  onClose: () => void
}) {
  const { t } = useT()
  const dialogRef = useRef<HTMLFormElement | null>(null)
  const dismiss = mutating ? undefined : onClose
  useDialogFocusTrap(dialogRef, { onEscape: dismiss, initialFocus: true })
  const [latest] = versions
  const baseline = versions.find(version => version.id === draft.baselineVersionId)

  return (
    <div className="run-input-backdrop" onClick={dismiss}>
      <form
        ref={dialogRef}
        className="run-input-dialog we-promote-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflow-promote-title"
        data-testid="workflow-promote-dialog"
        onClick={event => event.stopPropagation()}
        onSubmit={event => { event.preventDefault(); onStart() }}
      >
        <header className="run-input-dialog__header">
          <span className="run-input-dialog__icon" aria-hidden="true"><GitBranch size={18} /></span>
          <div className="run-input-dialog__heading">
            <h2 id="workflow-promote-title">{t('workflowRollout.promoteDialogTitle', { version: latest.version })}</h2>
          </div>
          <Button size="icon" variant="ghost" onClick={onClose} disabled={mutating} aria-label={t('common.close')} data-testid="workflow-promote-close">
            <X size={16} aria-hidden="true" />
          </Button>
        </header>
        <div className="run-input-dialog__body">
          <FormField label={t('workflowRollout.baseline')}>
            {controlProps => (
              <select
                {...controlProps}
                value={draft.baselineVersionId}
                onChange={event => onDraft({ ...draft, baselineVersionId: event.target.value })}
                disabled={mutating}
                data-testid="workflow-promote-baseline"
              >
                {versions.slice(1).map(version => <option key={version.id} value={version.id}>v{version.version}</option>)}
              </select>
            )}
          </FormField>
          {baseline && (
            <WorkflowDiffView
              before={baseline.dagJson}
              after={latest.dagJson}
              beforeLabel={t('workflowRollout.baselineVersion', { version: baseline.version })}
              afterLabel={t('workflowRollout.canaryVersion', { version: latest.version })}
            />
          )}
          {qualification}
          <div className="we-rollout-panel__fields">
            {FIELDS.map(([field, label, min, max]) => (
              <FormField key={field} label={t(`workflowRollout.${label}`)}>
                {controlProps => (
                  <span className="we-rollout-panel__input-unit" data-unit={field !== 'minimumSampleSize'}>
                    <input
                      {...controlProps}
                      type="number"
                      min={min}
                      max={max}
                      value={draft[field]}
                      disabled={mutating}
                      data-testid={`workflow-promote-${field}`}
                      onChange={event => onDraft({ ...draft, [field]: Number(event.target.value) })}
                    />
                    {field !== 'minimumSampleSize' && <span aria-hidden="true">{t('workflowRollout.percentUnit')}</span>}
                  </span>
                )}
              </FormField>
            ))}
          </div>
          <p className="helper-text">{t('workflowRollout.guardrailHint')}</p>
          {blocked && <p className="we-rollout-panel__qualification-blocked">{t('workflowRollout.qualification.blockedHint')}</p>}
        </div>
        <footer className="run-input-dialog__footer">
          <Button onClick={onClose} disabled={mutating} data-testid="workflow-promote-cancel">{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" disabled={!canStart} data-testid="workflow-promote-start">
            {mutating ? t('workflowRollout.starting') : t('workflowRollout.start')}
          </Button>
        </footer>
      </form>
    </div>
  )
}
