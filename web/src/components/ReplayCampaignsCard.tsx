/**
 * Recovery jobs view: progress, abort and touched runs for paced recovery
 * campaigns. Lazy-loaded by `DeadLettersPanel.tsx` when the view opens.
 */

import { Fragment, useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'

import { currentApiRequestLifecycle } from '../api-request-lifecycle'
import { api } from '../api'
import { getResolvedLocale, tApiError, useT } from '../i18n'
import { useWorkflowStore } from '../store'
import './ReplayCampaignsCard.css'
import { PLATFORM_TAG, useInvalidationNonce } from '../lib/query-cache'
import { Button } from './ui/Button'

const REPLAY_CAMPAIGN_TAGS = [PLATFORM_TAG, 'campaigns', 'recovery', 'dlq'] as const
const JOB_LIST_PATH = '/recovery/campaigns?limit=50'
const JOB_POLL_MS = 3_000
const JOB_COLUMNS = ['replayed', 'failed', 'cancelled', 'startedBy'] as const

type ReplayCampaign = {
  id: string
  name: string
  pacingMs: number
  status: 'running' | 'completed' | 'cancelled'
  totalCount: number
  replayedCount: number
  failedCount: number
  cancelledCount: number
  createdBy: string
  createdAt: string
}

type JobItem = {
  id: string
  deadLetterId: string
  runId: string | null
  nodeId: string | null
  status: string
  error: string | null
}

function isCount(value: unknown, min = 0, max = Infinity): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max
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
      && isCount(candidate.pacingMs, 1_000, 60_000)
      && isCount(candidate.totalCount, 2)
      && isCount(candidate.replayedCount)
      && isCount(candidate.failedCount)
      && isCount(candidate.cancelledCount)
      && candidate.replayedCount + candidate.failedCount + candidate.cancelledCount <= candidate.totalCount
      && typeof candidate.createdBy === 'string'
      && typeof candidate.createdAt === 'string'
      && Number.isFinite(Date.parse(candidate.createdAt))
      && (candidate.status === 'running' || candidate.status === 'completed' || candidate.status === 'cancelled')
  })
}

function jobItems(value: unknown): JobItem[] {
  const items = (value as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) return []
  return items.filter((item): item is JobItem => {
    const candidate = item as Partial<JobItem> | null
    return typeof candidate?.id === 'string'
      && typeof candidate.deadLetterId === 'string'
      && typeof candidate.status === 'string'
  })
}

// Module state outlives this lazy view, so a job still announces its end after
// the operator leaves Recover. One timer serves the view and the announcements.
const watchedJobs = new Set<string>()
let jobTimer: number | undefined
let showJobs: ((jobs: ReplayCampaign[]) => void) | undefined
let announceJob: ((job: ReplayCampaign) => void) | undefined

function stopJobTimer() {
  window.clearInterval(jobTimer)
  jobTimer = undefined
}

function trackJobs(jobs: ReplayCampaign[]) {
  const listed = new Set(jobs.map((job) => job.id))
  for (const id of watchedJobs) if (!listed.has(id)) watchedJobs.delete(id)
  for (const job of jobs) {
    if (job.status === 'running') watchedJobs.add(job.id)
    else if (watchedJobs.delete(job.id)) announceJob?.(job)
  }
  if (watchedJobs.size === 0) stopJobTimer()
  else if (jobTimer === undefined) {
    const { signal } = currentApiRequestLifecycle()
    jobTimer = window.setInterval(() => {
      if (signal.aborted) {
        watchedJobs.clear()
        stopJobTimer()
        if (!showJobs) return
      }
      // A failed poll keeps the watch; the next tick retries.
      void readJobs().catch(() => undefined)
    }, JOB_POLL_MS)
  }
}

async function readJobs() {
  const jobs = campaignList(await api(JOB_LIST_PATH))
  showJobs?.(jobs)
  trackJobs(jobs)
}

function JobRuns({ jobId, settled, onOpenRun }: {
  jobId: string
  settled: number
  onOpenRun?: (runId: string) => void | Promise<void>
}) {
  const { t } = useT()
  const [items, setItems] = useState<JobItem[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let stale = false
    api(`/recovery/campaigns/${encodeURIComponent(jobId)}`).then((value) => {
      if (stale) return
      setItems(jobItems(value))
      setFailed(false)
    }).catch(() => {
      if (!stale) setFailed(true)
    })
    return () => { stale = true }
  }, [jobId, settled])

  if (failed && !items) return <p className="helper-text" role="alert">{t('replayCampaign.runsFailed')}</p>
  if (!items) return <p className="helper-text">{t('common.loading')}</p>
  return (
    <ul className="we-recovery-jobs__runs" data-testid={`recovery-job-runs-${jobId}`}>
      {items.map((item) => (
        <li key={item.id}>
          {item.runId && onOpenRun ? (
            <Button
              size="sm"
              onClick={() => { void onOpenRun(item.runId as string) }}
              data-testid={`recovery-job-run-${item.id}`}
            >
              <code>{item.runId.slice(0, 8)}</code>
            </Button>
          ) : <code>{(item.runId ?? item.deadLetterId).slice(0, 8)}</code>}
          <span>{item.nodeId}</span>
          <span className="we-pill" data-tone={item.status === 'failed' ? 'danger' : item.status === 'replayed' ? 'success' : 'neutral'}>
            {t(`replayCampaign.item.${item.status}`, { defaultValue: item.status })}
          </span>
          {item.error && <small>{item.error}</small>}
        </li>
      ))}
    </ul>
  )
}

export function ReplayCampaignsCard({ canCancel = true, onNew, onOpenRun }: {
  canCancel?: boolean
  onNew?: () => void
  onOpenRun?: (runId: string) => void | Promise<void>
}) {
  const { t } = useT()
  const platformVersion = useInvalidationNonce(REPLAY_CAMPAIGN_TAGS)
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion)
  const addToast = useWorkflowStore((state) => state.addToast)
  const [campaigns, setCampaigns] = useState<ReplayCampaign[]>([])
  const [loaded, setLoaded] = useState(false)
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null)
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [openRunsId, setOpenRunsId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      await readJobs()
    } catch {
      // Job progress is supplementary; the recovery queue remains usable.
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    showJobs = setCampaigns
    announceJob = (job) => {
      addToast(
        job.status === 'cancelled'
          ? t('replayCampaign.cancelled', { name: job.name })
          : t('replayCampaign.finished', { name: job.name, replayed: job.replayedCount, failed: job.failedCount }),
        job.failedCount > 0 ? 'error' : 'success',
      )
      bumpPlatformVersion(['campaigns', 'recovery', 'dlq'])
    }
    return () => { showJobs = undefined }
  }, [addToast, bumpPlatformVersion, t])

  useEffect(() => { void refresh() }, [platformVersion, refresh])

  const cancel = async (campaign: ReplayCampaign) => {
    setCancellingId(campaign.id)
    try {
      await api(`/recovery/campaigns/${encodeURIComponent(campaign.id)}/cancel`, { method: 'POST' })
      watchedJobs.delete(campaign.id)
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

  return (
    <section className="we-card we-replay-campaigns" aria-labelledby="replay-campaigns-heading" data-testid="replay-campaigns-card">
      <div className="split-row">
        <strong id="replay-campaigns-heading">{t('replayCampaign.title')}</strong>
        <div className="we-replay-campaign__actions">
          {onNew && (
            <Button size="sm" variant="primary" onClick={onNew} data-testid="recovery-jobs-new">
              {t('replayCampaign.new')}
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => { void refresh() }}
            aria-label={t('replayCampaign.refresh')}
            data-testid="recovery-jobs-refresh"
          >
            <RefreshCw size={12} aria-hidden="true" />
          </Button>
        </div>
      </div>
      {!loaded && <p className="helper-text">{t('common.loading')}</p>}
      {loaded && campaigns.length === 0 && (
        <p className="helper-text" data-testid="recovery-jobs-empty">{t('replayCampaign.empty')}</p>
      )}
      {campaigns.length > 0 && (
        <table className="we-recovery-jobs">
          <thead>
            <tr>
              <th scope="col">{t('replayCampaign.col.job')}</th>
              <th scope="col">{t('replayCampaign.col.progress')}</th>
              {JOB_COLUMNS.map((column) => <th key={column} scope="col">{t(`replayCampaign.col.${column}`)}</th>)}
              <th scope="col" aria-label={t('replayCampaign.col.actions')} />
            </tr>
          </thead>
          <tbody>
            {campaigns.map((campaign) => {
              const settled = campaign.replayedCount + campaign.failedCount + campaign.cancelledCount
              const percentage = Math.min(100, Math.round((settled / campaign.totalCount) * 100))
              const tone = campaign.status === 'completed' ? 'success' : campaign.status === 'cancelled' ? 'neutral' : 'info'
              const confirming = canCancel && campaign.status === 'running' && confirmCancelId === campaign.id
              return (
                <Fragment key={campaign.id}>
                  <tr data-testid={`replay-campaign-${campaign.id}`}>
                    <td className="we-recovery-jobs__job">
                      <strong>{campaign.name}</strong>
                      <small>
                        {t('replayCampaign.scope', { count: campaign.totalCount })}
                        {' · '}{t('replayCampaign.pace', { seconds: campaign.pacingMs / 1_000 })}
                        {' · '}{new Date(campaign.createdAt).toLocaleString(getResolvedLocale())}
                      </small>
                    </td>
                    <td className="we-recovery-jobs__progress" data-label={t('replayCampaign.col.progress')}>
                      <span className="we-pill" data-tone={tone}>{t(`replayCampaign.status.${campaign.status}`)}</span>
                      <small>{t('replayCampaign.progress', { settled, total: campaign.totalCount })}</small>
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
                    </td>
                    {[campaign.replayedCount, campaign.failedCount, campaign.cancelledCount, campaign.createdBy].map((value, index) => (
                      <td key={JOB_COLUMNS[index]} data-label={t(`replayCampaign.col.${JOB_COLUMNS[index]}`)}>{value}</td>
                    ))}
                    <td>
                      <div className="we-replay-campaign__actions">
                        {canCancel && campaign.status === 'running' && !confirming && (
                          <Button
                            size="sm"
                            onClick={() => setConfirmCancelId(campaign.id)}
                            data-testid={`replay-campaign-cancel-${campaign.id}`}
                          >
                            {t('replayCampaign.cancel')}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          aria-expanded={openRunsId === campaign.id}
                          onClick={() => setOpenRunsId((current) => (current === campaign.id ? null : campaign.id))}
                          data-testid={`recovery-job-view-runs-${campaign.id}`}
                        >
                          {t('replayCampaign.viewRuns')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                  {(confirming || openRunsId === campaign.id) && (
                    <tr className="we-recovery-jobs__detail">
                      <td colSpan={7}>
                        {confirming && <div className="we-replay-campaign__actions">
                          <span className="helper-text">{t('replayCampaign.cancelConfirm')}</span>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={cancellingId === campaign.id}
                            onClick={() => { void cancel(campaign) }}
                            data-testid={`replay-campaign-cancel-confirm-${campaign.id}`}
                          >
                            {cancellingId === campaign.id ? t('replayCampaign.cancelling') : t('replayCampaign.cancelConfirmCta')}
                          </Button>
                          <Button size="sm" onClick={() => setConfirmCancelId(null)}>
                            {t('common.cancel')}
                          </Button>
                        </div>}
                        {openRunsId === campaign.id && <JobRuns jobId={campaign.id} settled={settled} onOpenRun={onOpenRun} />}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}
