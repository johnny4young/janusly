/**
 * Admin panel for declaring a workflow's reliability SLO. Two bounded
 * numeric inputs (success-rate % + p95 duration ms) plus a windowDays
 * select. v1 evaluates only those two metrics against the existing
 * `HealthSignals`; the other three SLO fields persist for contract
 * compatibility but remain informational until matching signals exist.
 *
 * Multi-tenant: every fetch carries the org-id header (via `api()`).
 * Role gate: the server route declares `role: admin` — non-admins see
 * the 403 surfaced through the existing toast envelope, so we keep the
 * form mounted for every effective role and let the server reject.
 *
 * Bumps the platform-version tick on success so `WorkflowHealthBadge`
 * + every other dependent panel refetches without a page reload.
 */

import { useEffect, useState } from 'react'
import { api, contractApi } from '../api'
import { useWorkflowStore } from '../store'
import { tApiError, useT } from '../i18n'
import { Button } from '@/components/ui/Button'
import { FieldStack, FormField } from '@/components/ui/Form'

export type WorkflowSloPanelProps = {
  /** Optional explicit workflowId. When omitted, the panel pulls the current
   *  workflow id from the store — matches the VersionHistoryPanel pattern. */
  workflowId?: string | undefined
  readOnly?: boolean
}

type WindowDays = 7 | 14 | 30

type WorkflowSlo = {
  successRatePercent: number | null
  mttrSeconds: number | null
  p95DurationMs: number | null
  budgetBlocksPerWindow: number | null
  stuckWaitingNodesMax: number | null
  windowDays: WindowDays
}

const DEFAULT_SLO: WorkflowSlo = {
  successRatePercent: null,
  mttrSeconds: null,
  p95DurationMs: null,
  budgetBlocksPerWindow: null,
  stuckWaitingNodesMax: null,
  windowDays: 7,
}

function parseOptionalNumber(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

export function WorkflowSloPanel({ workflowId: explicit, readOnly = false }: WorkflowSloPanelProps = {}) {
  const { t } = useT()
  const addToast = useWorkflowStore((s) => s.addToast)
  const bumpPlatformVersion = useWorkflowStore((s) => s.bumpPlatformVersion)
  const platformVersion = useWorkflowStore((s) => s.platformVersion)
  const storeWorkflowId = useWorkflowStore((s) => s.currentWorkflowId)
  const storeWorkflowSaved = useWorkflowStore((s) => s.currentWorkflowSaved)
  // With no explicit id this panel targets the current draft — but only once
  // it has been saved. An unsaved draft has no server row, so the health/SLO
  // lookup would 404; an explicit id always resolves.
  const workflowId = explicit ?? (storeWorkflowSaved ? storeWorkflowId : undefined)
  const [slo, setSlo] = useState<WorkflowSlo>(DEFAULT_SLO)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!workflowId) return
    let cancelled = false
    setLoading(true)
    contractApi('GET /workflows/health', `/workflows/health?workflowId=${encodeURIComponent(workflowId)}`, undefined)
      .then((payload) => {
        if (cancelled) return
        const incoming = (payload as { slo?: { slo: WorkflowSlo } | null } | null)?.slo?.slo
        // Validate the windowDays enum at read time — defense-in-depth against
        // an older code path or future schema drift writing a stale shape.
        if (incoming && ([7, 14, 30] as const).includes(incoming.windowDays)) {
          setSlo(incoming)
        } else {
          setSlo(DEFAULT_SLO)
        }
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [workflowId, platformVersion])

  if (!workflowId) return null

  const onSave = async (next: WorkflowSlo | null) => {
    if (!workflowId) return
    setSaving(true)
    try {
      await api(`/workflows/${encodeURIComponent(workflowId)}/slo`, {
        method: 'POST',
        body: JSON.stringify({ slo: next }),
      })
      addToast(t('workflowSlo.saved'), 'success')
      setSlo(next ?? DEFAULT_SLO)
      bumpPlatformVersion()
    } catch (err) {
      addToast(
        tApiError(err) || (t('workflowSlo.error', { message: err instanceof Error ? err.message : 'unknown' })),
        'error',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="we-card we-slo-panel" aria-labelledby="we-slo-panel-title">
      <h3 id="we-slo-panel-title" className="section-title">{t('workflowSlo.title')}</h3>
      <p className="helper-text">{t('workflowSlo.description')}</p>
      <form
        className="we-slo-panel__form"
        onSubmit={(e) => {
          e.preventDefault()
          void onSave(slo)
        }}
      >
        <FieldStack labelledBy="we-slo-panel-title" disabled={readOnly}>
        <FormField label={t('workflowSlo.field.successRatePercent')}>
          {(controlProps) => (
            <input
              {...controlProps}
              type="number"
              min={0}
              max={100}
              step={0.1}
              value={slo.successRatePercent ?? ''}
              placeholder={t('workflowSlo.field.placeholder')}
              onChange={(e) => setSlo({ ...slo, successRatePercent: parseOptionalNumber(e.target.value) })}
              disabled={loading || saving}
            />
          )}
        </FormField>
        <FormField label={t('workflowSlo.field.p95DurationMs')}>
          {(controlProps) => (
            <input
              {...controlProps}
              type="number"
              min={0}
              step={1}
              value={slo.p95DurationMs ?? ''}
              placeholder={t('workflowSlo.field.placeholder')}
              onChange={(e) => setSlo({ ...slo, p95DurationMs: parseOptionalNumber(e.target.value) })}
              disabled={loading || saving}
            />
          )}
        </FormField>
        <FormField label={t('workflowSlo.field.windowDays')}>
          {(controlProps) => (
            <select
              {...controlProps}
              value={slo.windowDays}
              onChange={(e) => setSlo({ ...slo, windowDays: Number(e.target.value) as WindowDays })}
              disabled={loading || saving}
            >
              {[7, 14, 30].map((days) => (
                <option key={days} value={days}>
                  {t('workflowSlo.windowOption', { days })}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <p className="helper-text">{t('workflowSlo.field.unsupportedV1')}</p>
        <div className="we-slo-panel__actions">
          <Button variant="primary" type="submit"  disabled={loading || saving}>
            {saving ? (t('workflowSlo.saving')) : (t('workflowSlo.save'))}
          </Button>
          <Button variant="secondary"
            type="button"

            onClick={() => void onSave(null)}
            disabled={loading || saving}
          >
            {t('workflowSlo.clear')}
          </Button>
        </div>
        </FieldStack>
      </form>
    </section>
  )
}
