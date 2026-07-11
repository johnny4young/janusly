/**
 * Failure-recovery dialog — Review step body.
 *
 * Used by: apps/web/src/components/RecoveryDialog.tsx. Owns the review-state
 * UI: the fallback / no-structural-patch warnings, the per-suggestion tab
 * strip (with keyboard navigation + calibrated-confidence labels), the
 * `WorkflowDiffView` of the selected suggestion against the failing
 * version, and the `EvidencePanel`. Receives everything via explicit props
 * — the parent keeps the `Step` state machine and the apply callbacks.
 */

import React from 'react'
import { AlertCircle } from 'lucide-react'
import { useT } from '../../i18n'
import type { WorkflowDefinition } from '../../types'
import { WorkflowDiffView } from '../WorkflowDiffView'
import type { DeadLetter } from '../DeadLettersPanel'
import { EvidencePanel } from './EvidencePanel'
import { LearningHealthBadge } from './LearningHealthBadge'
import { RecoveryPassportCard } from './RecoveryPassportCard'
import type { RecoverySandboxStatus } from './recovery-passport'
import { approachLabelDisplay, resolveConfidenceDisplay, suggestionTabKey } from './helpers'
import type { PatchSuggestion, SuggestionTab } from './types'

export function ReviewBody({
  suggestion,
  selected,
  selectedIndex,
  onSelectIndex,
  dlq,
  canApplyPatch,
  sandboxStatus = 'not_run',
  failureSignature,
  selectionLocked = false,
}: {
  suggestion: PatchSuggestion
  selected: SuggestionTab
  selectedIndex: number
  onSelectIndex: (index: number) => void
  dlq: DeadLetter
  canApplyPatch: boolean
  sandboxStatus?: RecoverySandboxStatus
  failureSignature: string
  selectionLocked?: boolean
}) {
  const { t } = useT()
  const tabs = suggestion.suggestions
  const showTabs = tabs.length > 1
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!showTabs) return
    const lastIndex = tabs.length - 1
    const nextIndexByKey: Record<string, number> = {
      ArrowRight: index === lastIndex ? 0 : index + 1,
      ArrowDown: index === lastIndex ? 0 : index + 1,
      ArrowLeft: index === 0 ? lastIndex : index - 1,
      ArrowUp: index === 0 ? lastIndex : index - 1,
      Home: 0,
      End: lastIndex,
    }
    const nextIndex = nextIndexByKey[event.key]
    if (nextIndex === undefined) return
    event.preventDefault()
    onSelectIndex(nextIndex)
    window.requestAnimationFrame(() => {
      document.getElementById(`we-recovery-tab-${nextIndex}`)?.focus()
    })
  }
  return (
    <>
      {suggestion.mode === 'fallback' && (
        <div className="we-recovery-warning" role="alert">
          <AlertCircle size={14} aria-hidden="true" />
          <div>
            <strong>{t('recoveryDialog.review.aiUnavailable')}</strong> {t('recoveryDialog.review.aiUnavailableBody')}
            {suggestion.aiError ? ` ${t('recoveryDialog.review.aiUnavailableReason', { reason: suggestion.aiError })}` : null}
          </div>
        </div>
      )}
      {suggestion.mode === 'ai' && !canApplyPatch && (
        <div className="we-recovery-warning" role="alert">
          <AlertCircle size={14} aria-hidden="true" />
          <div>
            <strong>{t('recoveryDialog.review.noStructuralPatch')}</strong> {t('recoveryDialog.review.noStructuralPatchBody')}
          </div>
        </div>
      )}
      <RecoveryPassportCard
        dlq={dlq}
        suggestion={suggestion}
        selected={selected}
        actionable={canApplyPatch}
        sandboxStatus={sandboxStatus}
        failureSignature={failureSignature}
      />
      {showTabs && (
        <div className="we-recovery-tabs" role="tablist" aria-label={t('recoveryDialog.review.tabsAriaLabel') as string}>
          {tabs.map((tab, index) => (
            <button
              key={suggestionTabKey(tab)}
              type="button"
              role="tab"
              id={`we-recovery-tab-${index}`}
              aria-controls="we-recovery-tabpanel"
              aria-selected={index === selectedIndex}
              tabIndex={index === selectedIndex ? 0 : -1}
              className={`we-recovery-tab${index === selectedIndex ? ' we-recovery-tab--active' : ''}`}
              disabled={selectionLocked}
              onClick={() => onSelectIndex(index)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
              title={(() => {
                const { primary, showSelfRated, selfRated } = resolveConfidenceDisplay(tab)
                return showSelfRated
                  ? t('recoveryDialog.review.tabCalibratedTitle', { confidence: primary, selfRated }) as string
                  : t('recoveryDialog.review.tabConfidenceTitle', { confidence: primary }) as string
              })()}
            >
              <span className="we-recovery-tab__label">{approachLabelDisplay(tab.approachLabel)}</span>
              {(() => {
                const { primary, showSelfRated, selfRated } = resolveConfidenceDisplay(tab)
                return (
                  <span className="we-recovery-tab__confidence">
                    <span className="we-recovery-tab__confidence-primary">{primary}%</span>
                    {showSelfRated && (
                      <span className="we-recovery-tab__confidence-self">
                        {t('recoveryDialog.review.selfRated', { confidence: selfRated })}
                      </span>
                    )}
                  </span>
                )
              })()}
            </button>
          ))}
        </div>
      )}
      <LearningHealthBadge
        feedbackHealth={suggestion.feedbackHealth}
        approachLabel={selected.approachLabel}
      />
      <div
        id="we-recovery-tabpanel"
        role={showTabs ? 'tabpanel' : undefined}
        aria-labelledby={showTabs ? `we-recovery-tab-${selectedIndex}` : undefined}
      >
        <WorkflowDiffView
          before={(dlq.workflowJson ?? {}) as WorkflowDefinition}
          after={selected.workflow}
          beforeLabel={t('recoveryDialog.review.beforeLabel') as string}
          afterLabel={showTabs
            ? (t('recoveryDialog.review.suggestedLabelWithApproach', { approach: approachLabelDisplay(selected.approachLabel) }) as string)
            : (t('recoveryDialog.review.suggestedLabel') as string)}
          aiPatchRationale={selected.rationale}
        />
        <EvidencePanel evidence={suggestion.evidence ?? []} />
      </div>
    </>
  )
}
