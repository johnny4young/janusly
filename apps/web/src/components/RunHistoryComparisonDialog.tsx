/**
 * Historical run comparison dialog. Finds the strictly preceding successful
 * run for the selected workflow, then reuses the generic comparison endpoint
 * and renderer to answer “when did this last work and what changed?”.
 *
 * Used by:
 * - `RunHistoryList.tsx` for terminal non-success history rows.
 *
 * Invariants:
 * - The baseline query carries the selected run's `(createdAt,id)` cursor, so
 *   a newer success can never be presented as the prior green run.
 * - Both reads remain bounded (`limit=1` for baseline discovery) and are
 *   aborted when the dialog closes or retries.
 */

import { useEffect, useRef, useState } from 'react'
import { AlertCircle, GitCompareArrows, RefreshCcw, X } from 'lucide-react'
import { api } from '../api'
import { formatStatusLabel } from '../constants'
import { getResolvedLocale, useT } from '../i18n'
import type { RunSummary } from '../types'
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap'
import { RunComparisonView, type RunComparisonPayload } from './RunComparisonView'

type ComparableRun = RunSummary & {
  workflowId: string
  createdAt: string
}

type ComparisonState =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'error' }
  | { kind: 'done'; baseline: RunSummary; comparison: RunComparisonPayload }

/** Resolve and render the selected run against its last successful predecessor. */
export function RunHistoryComparisonDialog({
  selectedRun,
  workflowLabel,
  onClose,
}: {
  selectedRun: ComparableRun
  workflowLabel: string
  onClose: () => void
}) {
  const { t } = useT()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  const [state, setState] = useState<ComparisonState>({ kind: 'loading' })
  useDialogFocusTrap(dialogRef, { initialFocus: true })

  useEffect(() => {
    const controller = new AbortController()
    setState({ kind: 'loading' })

    const load = async () => {
      try {
        const before = `${selectedRun.createdAt}|${selectedRun.id}`
        const params = new URLSearchParams({
          workflowId: selectedRun.workflowId,
          status: 'succeeded',
          runKind: 'production',
          before,
          limit: '1',
        })
        const prior = await api(`/runs?${params.toString()}`, { signal: controller.signal })
        if (controller.signal.aborted) return
        const baseline = Array.isArray(prior) ? prior[0] as RunSummary | undefined : undefined
        if (!baseline) {
          setState({ kind: 'missing' })
          return
        }

        const comparison = await api(
          `/runs/compare?baseRunId=${encodeURIComponent(baseline.id)}&replayRunId=${encodeURIComponent(selectedRun.id)}`,
          { signal: controller.signal },
        ) as RunComparisonPayload
        if (!controller.signal.aborted) setState({ kind: 'done', baseline, comparison })
      } catch {
        if (!controller.signal.aborted) setState({ kind: 'error' })
      }
    }

    void load()
    return () => controller.abort()
  }, [selectedRun.createdAt, selectedRun.id, selectedRun.workflowId, retryNonce])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="run-input-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="run-input-dialog we-run-history-comparison-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-history-comparison-title"
        data-testid="run-history-comparison-dialog"
        onClick={event => event.stopPropagation()}
      >
        <header className="run-input-dialog__header">
          <span className="run-input-dialog__icon" aria-hidden="true">
            <GitCompareArrows size={18} />
          </span>
          <div className="run-input-dialog__heading">
            <div className="section-kicker">{t('runHistoryComparison.kicker')}</div>
            <h2 id="run-history-comparison-title">{t('runHistoryComparison.title')}</h2>
            <p className="helper-text">{t('runHistoryComparison.description', { workflow: workflowLabel })}</p>
          </div>
          <button
            type="button"
            className="run-input-dialog__close"
            onClick={onClose}
            aria-label={t('runHistoryComparison.close') as string}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="run-input-dialog__body" aria-live="polite">
          {state.kind === 'loading' && (
            <div className="we-run-history-comparison-state" role="status">
              <RefreshCcw size={16} aria-hidden="true" />
              <span>{t('runHistoryComparison.loading')}</span>
            </div>
          )}

          {state.kind === 'missing' && (
            <div className="we-run-history-comparison-state" role="status">
              <GitCompareArrows size={16} aria-hidden="true" />
              <div>
                <strong>{t('runHistoryComparison.missingTitle')}</strong>
                <p className="helper-text">{t('runHistoryComparison.missingBody', { workflow: workflowLabel })}</p>
              </div>
            </div>
          )}

          {state.kind === 'error' && (
            <div className="run-input-form-error" role="alert">
              <AlertCircle size={14} aria-hidden="true" />
              <div>
                <span>{t('runHistoryComparison.error')}</span>
                <button type="button" className="small-command" onClick={() => setRetryNonce(value => value + 1)}>
                  <RefreshCcw size={12} aria-hidden="true" /> {t('runHistoryComparison.retry')}
                </button>
              </div>
            </div>
          )}

          {state.kind === 'done' && (
            <>
              <dl className="we-run-history-comparison-facts">
                <div>
                  <dt>{t('runHistoryComparison.lastSuccessful')}</dt>
                  <dd>
                    <code title={state.baseline.id}>{state.baseline.id.slice(0, 12)}…</code>
                    <span>{state.baseline.createdAt ? new Date(state.baseline.createdAt).toLocaleString(getResolvedLocale()) : '—'}</span>
                  </dd>
                </div>
                <div>
                  <dt>{t('runHistoryComparison.selectedRun')}</dt>
                  <dd>
                    <code title={selectedRun.id}>{selectedRun.id.slice(0, 12)}…</code>
                    <span>{formatStatusLabel(selectedRun.status)}</span>
                  </dd>
                </div>
              </dl>
              <RunComparisonView payload={state.comparison} context="history" />
            </>
          )}
        </div>

        <footer className="run-input-dialog__footer">
          <button type="button" className="command-button" onClick={onClose}>
            {t('runHistoryComparison.close')}
          </button>
        </footer>
      </div>
    </div>
  )
}
