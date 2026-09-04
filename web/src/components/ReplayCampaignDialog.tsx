/**
 * Preview-and-create dialog for paced recovery campaigns.
 *
 * Used by `DeadLettersPanel.tsx` after an operator selects multiple recovery
 * queue rows. The server remains authoritative for cohort membership and
 * derives the failure signature; this dialog only explains that preview and
 * collects a bounded name and pace.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Gauge, TimerReset, X } from 'lucide-react'

import { api } from '../api'
import { getResolvedLocale, tApiError, useT } from '../i18n'
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap'
import { Button } from '@/components/ui/Button'
import { FieldLabel, SelectControl, TextInput } from '@/components/ui/Form'

type CampaignPreview = {
  canCreate: boolean
  clusterSignature: string | null
  eligible: Array<{ deadLetterId: string; runId: string; nodeId: string }>
  rejected: Array<{ deadLetterId: string; reason: string }>
}

type CampaignCreateResult = {
  campaign: { id: string; name: string; totalCount: number; pacingMs: number }
  publicationDeferred?: boolean
}

function isCampaignPreview(value: unknown): value is CampaignPreview {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<CampaignPreview>
  return typeof candidate.canCreate === 'boolean'
    && (typeof candidate.clusterSignature === 'string' || candidate.clusterSignature === null)
    && Array.isArray(candidate.eligible)
    && Array.isArray(candidate.rejected)
}

function isCampaignCreateResult(value: unknown): value is CampaignCreateResult {
  if (!value || typeof value !== 'object') return false
  const campaign = (value as Partial<CampaignCreateResult>).campaign
  const publicationDeferred = (value as Partial<CampaignCreateResult>).publicationDeferred
  return Boolean(campaign
    && typeof campaign.id === 'string'
    && typeof campaign.name === 'string'
    && Number.isInteger(campaign.totalCount)
    && campaign.totalCount >= 2
    && Number.isInteger(campaign.pacingMs)
    && campaign.pacingMs >= 1_000
    && campaign.pacingMs <= 60_000
    && (publicationDeferred === undefined || typeof publicationDeferred === 'boolean'))
}

const PACING_OPTIONS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000] as const

export function ReplayCampaignDialog({
  deadLetterIds,
  onClose,
  onCreated,
}: {
  deadLetterIds: string[]
  onClose: () => void
  onCreated: (result: CampaignCreateResult) => void
}) {
  const { t } = useT()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const nameRef = useRef<HTMLInputElement | null>(null)
  const stableIds = useMemo(() => [...new Set(deadLetterIds)], [deadLetterIds])
  const [name, setName] = useState(() => t('replayCampaign.dialog.defaultName', {
    date: new Intl.DateTimeFormat(getResolvedLocale(), {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date()),
  }))
  const [pacingMs, setPacingMs] = useState<number>(5_000)
  const [preview, setPreview] = useState<CampaignPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  useDialogFocusTrap(dialogRef, { onEscape: submitting ? undefined : onClose })

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setPreviewError(null)
    api('/recovery/campaigns/preview', {
      method: 'POST',
      body: JSON.stringify({ deadLetterIds: stableIds }),
    }).then((value) => {
      if (cancelled) return
      if (!isCampaignPreview(value)) throw new Error(t('replayCampaign.dialog.previewFailed'))
      setPreview(value)
    }).catch((error) => {
      if (!cancelled) setPreviewError(tApiError(error) || t('replayCampaign.dialog.previewFailed'))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [stableIds, t])

  useEffect(() => {
    if (!loading) nameRef.current?.focus()
  }, [loading])

  const submit = async () => {
    const trimmedName = name.trim()
    if (!preview?.canCreate || !trimmedName || submitting) return
    setSubmitting(true)
    setPreviewError(null)
    try {
      const result = await api('/recovery/campaigns', {
        method: 'POST',
        body: JSON.stringify({ deadLetterIds: stableIds, name: trimmedName, pacingMs }),
      })
      if (!isCampaignCreateResult(result)) throw new Error(t('replayCampaign.dialog.createFailed'))
      onCreated(result)
    } catch (error) {
      setPreviewError(tApiError(error) || t('replayCampaign.dialog.createFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  const close = () => {
    if (!submitting) onClose()
  }

  return (
    <div className="run-input-backdrop" onClick={close}>
      <div
        ref={dialogRef}
        className="run-input-dialog we-replay-campaign-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="replay-campaign-title"
        onClick={(event) => event.stopPropagation()}
        data-testid="replay-campaign-dialog"
      >
        <header className="run-input-dialog__header">
          <span className="run-input-dialog__icon" aria-hidden="true"><TimerReset size={18} /></span>
          <div className="run-input-dialog__heading">
            <div className="section-kicker">{t('replayCampaign.dialog.kicker')}</div>
            <h2 id="replay-campaign-title">{t('replayCampaign.dialog.title')}</h2>
            <p className="helper-text">{t('replayCampaign.dialog.description')}</p>
          </div>
          <button
            type="button"
            className="run-input-dialog__close"
            onClick={close}
            disabled={submitting}
            aria-label={t('replayCampaign.dialog.close')}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="run-input-dialog__body">
          {previewError && (
            <div className="run-input-form-error" role="alert">
              <AlertCircle size={14} aria-hidden="true" />
              <span>{previewError}</span>
            </div>
          )}

          <section className="we-campaign-preview" aria-busy={loading}>
            <div className="split-row">
              <div>
                <div className="section-kicker">{t('replayCampaign.dialog.preview')}</div>
                <strong>{loading
                  ? t('common.loading')
                  : t('replayCampaign.dialog.previewCount', {
                      eligible: preview?.eligible.length ?? 0,
                      selected: stableIds.length,
                    })}</strong>
              </div>
              {!loading && (
                <span className="we-pill" data-tone={preview?.canCreate ? 'success' : 'warning'}>
                  {preview?.canCreate
                    ? t('replayCampaign.dialog.cohortReady')
                    : t('replayCampaign.dialog.cohortBlocked')}
                </span>
              )}
            </div>
            {preview && preview.rejected.length > 0 && (
              <ul className="we-campaign-preview__rejections" data-testid="replay-campaign-rejections">
                {preview.rejected.map((item) => (
                  <li key={item.deadLetterId}>
                    <code>{item.deadLetterId.slice(0, 8)}</code>
                    <span>{t(`replayCampaign.reason.${item.reason}`, { defaultValue: item.reason })}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <FieldLabel  htmlFor="replay-campaign-name">{t('replayCampaign.dialog.name')}</FieldLabel>
          <TextInput
            ref={nameRef}
            id="replay-campaign-name"

            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            disabled={submitting}
            data-testid="replay-campaign-name"
          />

          <FieldLabel  htmlFor="replay-campaign-pace">{t('replayCampaign.dialog.pace')}</FieldLabel>
          <SelectControl
            id="replay-campaign-pace"

            value={pacingMs}
            onChange={(event) => setPacingMs(Number(event.target.value))}
            disabled={submitting}
            data-testid="replay-campaign-pace"
          >
            {PACING_OPTIONS_MS.map((value) => (
              <option key={value} value={value}>
                {t('replayCampaign.dialog.paceOption', { seconds: value / 1_000 })}
              </option>
            ))}
          </SelectControl>
          <p className="helper-text we-campaign-pace-helper">
            <Gauge size={13} aria-hidden="true" /> {t('replayCampaign.dialog.paceHelper')}
          </p>

          <footer className="run-input-dialog__footer">
            <Button variant="secondary" type="button"  onClick={close} disabled={submitting}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary"
              type="button"

              disabled={!preview?.canCreate || !name.trim() || submitting}
              onClick={() => { void submit() }}
              data-testid="replay-campaign-create"
            >
              <TimerReset size={14} aria-hidden="true" />
              <span>{submitting ? t('replayCampaign.dialog.creating') : t('replayCampaign.dialog.create')}</span>
            </Button>
          </footer>
        </div>
      </div>
    </div>
  )
}
