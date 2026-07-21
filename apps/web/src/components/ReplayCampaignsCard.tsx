/**
 * Compact progress surface for recent paced recovery campaigns.
 *
 * Used by `DeadLettersPanel.tsx`. Running campaigns poll on a bounded cadence;
 * settled campaigns refresh only when the shared platform version changes.
 */

import { useCallback, useEffect, useState } from 'react'
import { CircleCheck, RefreshCw, TimerReset, XCircle } from 'lucide-react'

import { api } from '../api'
import { getResolvedLocale, tApiError, useT } from '../i18n'
import { useWorkflowStore } from '../store'

type ReplayCampaign = {
  id: string
  name: string
  pacingMs: number
  status: 'running' | 'completed' | 'cancelled'
  totalCount: number
  replayedCount: number
  failedCount: number
  cancelledCount: number
  createdAt: string
  nextDispatchAt: string
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isCampaignPacingMs(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 1_000
    && value <= 60_000
}

function campaignList(value: unknown): ReplayCampaign[] {
  if (!value || typeof value !== 'object') return []
  const campaigns = (value as { campaigns?: unknown }).campaigns
  if (!Array.isArray(campaigns)) return []
  return campaigns.filter((item): item is ReplayCampaign => {
    if (!item || typeof item !== 'object') return false
    const candidate = item as Partial<ReplayCampaign>
    return typeof candidate.id === 'string'
      && typeof candidate.name === 'string'
      && isCampaignPacingMs(candidate.pacingMs)
      && isNonNegativeInteger(candidate.totalCount)
      && candidate.totalCount >= 2
      && isNonNegativeInteger(candidate.replayedCount)
      && isNonNegativeInteger(candidate.failedCount)
      && isNonNegativeInteger(candidate.cancelledCount)
      && candidate.replayedCount + candidate.failedCount + candidate.cancelledCount <= candidate.totalCount
      && typeof candidate.createdAt === 'string'
      && Number.isFinite(Date.parse(candidate.createdAt))
      && typeof candidate.nextDispatchAt === 'string'
      && Number.isFinite(Date.parse(candidate.nextDispatchAt))
      && (candidate.status === 'running' || candidate.status === 'completed' || candidate.status === 'cancelled')
  })
}

export function ReplayCampaignsCard() {
  const { t } = useT()
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion)
  const addToast = useWorkflowStore((state) => state.addToast)
  const [campaigns, setCampaigns] = useState<ReplayCampaign[]>([])
  const [loaded, setLoaded] = useState(false)
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null)
  const [cancellingId, setCancellingId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setCampaigns(campaignList(await api('/recovery/campaigns?limit=8')))
    } catch {
      // Campaign progress is supplementary; the recovery queue remains usable.
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => { void refresh() }, [platformVersion, refresh])

  const hasRunning = campaigns.some((campaign) => campaign.status === 'running')
  useEffect(() => {
    if (!hasRunning) return
    const timer = window.setInterval(() => { void refresh() }, 3_000)
    return () => window.clearInterval(timer)
  }, [hasRunning, refresh])

  const cancel = async (campaign: ReplayCampaign) => {
    setCancellingId(campaign.id)
    try {
      await api(`/recovery/campaigns/${encodeURIComponent(campaign.id)}/cancel`, { method: 'POST' })
      addToast(t('replayCampaign.cancelled', { name: campaign.name }), 'success')
      setConfirmCancelId(null)
      bumpPlatformVersion()
      await refresh()
    } catch (error) {
      addToast(tApiError(error) || t('replayCampaign.cancelFailed'), 'error')
    } finally {
      setCancellingId(null)
    }
  }

  if (loaded && campaigns.length === 0) return null

  return (
    <section className="we-card we-replay-campaigns" aria-labelledby="replay-campaigns-heading" data-testid="replay-campaigns-card">
      <div className="split-row">
        <div>
          <div className="section-kicker">{t('replayCampaign.kicker')}</div>
          <strong id="replay-campaigns-heading">{t('replayCampaign.title')}</strong>
        </div>
        <button type="button" className="small-command" onClick={() => { void refresh() }} aria-label={t('replayCampaign.refresh')}>
          <RefreshCw size={12} aria-hidden="true" />
        </button>
      </div>
      {!loaded && <p className="helper-text">{t('common.loading')}</p>}
      <div className="we-replay-campaigns__list">
        {campaigns.map((campaign) => {
          const settled = campaign.replayedCount + campaign.failedCount + campaign.cancelledCount
          const percentage = campaign.totalCount > 0 ? Math.min(100, Math.round((settled / campaign.totalCount) * 100)) : 0
          const tone = campaign.status === 'completed' ? 'success' : campaign.status === 'cancelled' ? 'neutral' : 'info'
          return (
            <article key={campaign.id} className="we-replay-campaign" data-testid={`replay-campaign-${campaign.id}`}>
              <div className="split-row">
                <div className="we-replay-campaign__identity">
                  <span className="we-replay-campaign__icon" data-status={campaign.status} aria-hidden="true">
                    {campaign.status === 'completed'
                      ? <CircleCheck size={15} />
                      : campaign.status === 'cancelled'
                        ? <XCircle size={15} />
                        : <TimerReset size={15} />}
                  </span>
                  <div>
                    <strong>{campaign.name}</strong>
                    <small>{new Date(campaign.createdAt).toLocaleString(getResolvedLocale())}</small>
                  </div>
                </div>
                <span className="we-pill" data-tone={tone}>{t(`replayCampaign.status.${campaign.status}` as never)}</span>
              </div>
              <div
                className="we-replay-campaign__progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={campaign.totalCount}
                aria-valuenow={settled}
                aria-label={t('replayCampaign.progressAria', { name: campaign.name })}
              >
                <span style={{ width: `${percentage}%` }} />
              </div>
              <div className="we-replay-campaign__meta">
                <span>{t('replayCampaign.progress', { settled, total: campaign.totalCount })}</span>
                <span>{t('replayCampaign.counts', { replayed: campaign.replayedCount, failed: campaign.failedCount })}</span>
                <span>{t('replayCampaign.pace', { seconds: campaign.pacingMs / 1_000 })}</span>
              </div>
              {campaign.status === 'running' && (
                <div className="we-replay-campaign__actions">
                  {confirmCancelId === campaign.id ? (
                    <>
                      <span className="helper-text">{t('replayCampaign.cancelConfirm')}</span>
                      <button
                        type="button"
                        className="small-command danger"
                        disabled={cancellingId === campaign.id}
                        onClick={() => { void cancel(campaign) }}
                        data-testid={`replay-campaign-cancel-confirm-${campaign.id}`}
                      >
                        {cancellingId === campaign.id ? t('replayCampaign.cancelling') : t('replayCampaign.cancelConfirmCta')}
                      </button>
                      <button type="button" className="small-command" onClick={() => setConfirmCancelId(null)}>
                        {t('common.cancel')}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="small-command"
                      onClick={() => setConfirmCancelId(campaign.id)}
                      data-testid={`replay-campaign-cancel-${campaign.id}`}
                    >
                      {t('replayCampaign.cancel')}
                    </button>
                  )}
                </div>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}
