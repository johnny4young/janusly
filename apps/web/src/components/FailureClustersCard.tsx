/**
 * Recovery Queue cluster card. Calls `GET /dlq/clusters` and renders the
 * grouped failure rollup so an operator opening the Runs tab sees "12
 * `Missing secret: GITHUB_TOKEN`" instead of 12 individual DLQ rows.
 *
 * Each row shows the cluster signature, category pill, suggested owner,
 * frequency, affected-workflow count, and last-seen timestamp. Clicking
 * a row expands to show the workflow breakdown + sample run ids the
 * operator can drill into via the existing per-row DLQ list below.
 *
 * Refetches on the platform-version tick — same cross-panel reactivity
 * hook the readiness/health badges use, so a DLQ replay or a fresh
 * failure flips this surface without a manual refresh. A refresh preserves
 * the last successful card and any nested recovery dialog while its next
 * payload is in flight; applying a fix must not discard its success state.
 *
 * Used in `DeadLettersPanel.tsx` (Runs tab → Operations card).
 */

import { lazy, Suspense, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, RefreshCw, Sparkles, Users } from 'lucide-react'
import { api } from '../api'
import { EmptyState } from './EmptyState'
import { useWorkflowStore } from '../store'
// Modal-only + heavy (~1.2k lines) — load on first open, not in the main chunk.
const RecoveryDialog = lazy(() => import('./RecoveryDialog').then((m) => ({ default: m.RecoveryDialog })))
import type { DeadLetter } from './DeadLettersPanel'
import { getResolvedLocale, useT } from '../i18n'
import { t as runtimeT } from '../i18n/runtime'

type ClusterCategory =
  | 'secret_missing'
  | 'http_error'
  | 'network_timeout'
  | 'ai_provider'
  | 'parse_error'
  | 'tool_input'
  | 'unknown'

type ClusterOwner = 'ops' | 'workflow_author' | 'platform'

type ClusterWorkflow = {
  workflowId: string
  workflowName: string
  count: number
}

type ClusterSampleRef = {
  source: 'dead_letter' | 'failed_run_node'
  id: string
  runId: string
}

type FailureCluster = {
  signature: string
  category: ClusterCategory
  frequency: number
  affectedWorkflows: ClusterWorkflow[]
  firstSeen: string
  lastSeen: string
  suggestedOwner: ClusterOwner
  samples: ClusterSampleRef[]
}

type ClustersResponse = {
  clusters: FailureCluster[]
  totalSamples: number
  windowDays: number
}

type ClusterData = ClustersResponse & {
  fetchedAtMs: number
}

/** State held while loading + driving the cluster-recovery dialog. */
type ClusterRecoveryState =
  | { kind: 'loading'; signature: string }
  | { kind: 'open'; signature: string; dlq: DeadLetter; members: string[]; capped: boolean; total: number }
  | { kind: 'error'; signature: string; message: string }

const MIN_FREQUENCY_FOR_BULK_RECOVER = 2

/** Initial sample count shown inside an expanded cluster — operators
 *  can opt-in to all via the show-more button. Capping the default
 *  avoids unbounded DOM growth on clusters with many recent samples. */
const SAMPLES_PREVIEW_LIMIT = 50

const CATEGORY_KEYS: Record<ClusterCategory, string> = {
  secret_missing: 'clusters.category.secret_missing',
  http_error: 'clusters.category.http_error',
  network_timeout: 'clusters.category.network_timeout',
  ai_provider: 'clusters.category.ai_provider',
  parse_error: 'clusters.category.parse_error',
  tool_input: 'clusters.category.tool_input',
  unknown: 'clusters.category.unknown',
}

const OWNER_KEYS: Record<ClusterOwner, string> = {
  ops: 'clusters.owner.ops',
  workflow_author: 'clusters.owner.workflow_author',
  platform: 'clusters.owner.platform',
}

/**
 * Severity tier used to colour the cluster row. `secret_missing` is the
 * most actionable (a single env-var change resolves the whole cluster);
 * `ai_provider` is degraded-platform territory; everything else is
 * workflow-author scope and rendered with the warn token.
 */
function severityForCategory(category: ClusterCategory): 'pass' | 'warn' | 'fail' {
  if (category === 'secret_missing') return 'fail'
  if (category === 'ai_provider') return 'fail'
  return 'warn'
}

export function FailureClustersCard() {
  const { t } = useT()
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  const [data, setData] = useState<ClusterData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  // Per-cluster opt-in for showing more than the first
  // SAMPLES_PREVIEW_LIMIT entries. Keyed by `cluster.signature` to
  // match the existing `expanded` dict shape.
  const [showAllSamples, setShowAllSamples] = useState<Record<string, boolean>>({})
  const [recovery, setRecovery] = useState<ClusterRecoveryState | null>(null)

  const openClusterRecovery = async (cluster: FailureCluster) => {
    // Pick a DLQ-source representative — only those carry a DLQ id we
    // can replay against. Falls back to the first sample if no DLQ
    // entry is present (the button is gated upstream so this branch is
    // defensive only).
    const representative = cluster.samples.find((s) => s.source === 'dead_letter')
    if (!representative) return
    setRecovery({ kind: 'loading', signature: cluster.signature })
    try {
      // Fetch the bounded member list and the representative DLQ row in
      // parallel. The members route enforces the same 100-row cap as
      // the apply route — the dialog renders "100 of 247" when the
      // window has more matching rows than fit in one batch.
      const [membersResp, dlqResp] = await Promise.all([
        api(`/dlq/cluster-members?signature=${encodeURIComponent(cluster.signature)}`) as Promise<{
          deadLetterIds: string[]
          total: number
          capped: boolean
        }>,
        api(`/dlq?id=${encodeURIComponent(representative.id)}`) as Promise<DeadLetter>,
      ])
      let selectedDlq = dlqResp
      if (!membersResp.deadLetterIds.includes(representative.id)) {
        // Defensive: representative should always be in the member list,
        // but if a race replayed/resolved it between cluster fetch and
        // now, fall back to the first still-open member and validate the
        // patch against that row instead.
        const fallback = membersResp.deadLetterIds[0]
        if (!fallback) {
          setRecovery({ kind: 'error', signature: cluster.signature, message: t('clusters.noOpenMembers') })
          return
        }
        selectedDlq = await api(`/dlq?id=${encodeURIComponent(fallback)}`) as DeadLetter
      }
      setRecovery({
        kind: 'open',
        signature: cluster.signature,
        dlq: selectedDlq,
        members: membersResp.deadLetterIds,
        capped: membersResp.capped,
        total: membersResp.total,
      })
    } catch (err) {
      setRecovery({
        kind: 'error',
        signature: cluster.signature,
        message: err instanceof Error ? err.message : (t('clusters.errorMembers')),
      })
    }
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api('/dlq/clusters')
      .then((payload) => {
        if (cancelled) return
        setData({ ...(payload as ClustersResponse), fetchedAtMs: Date.now() })
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : (t('clusters.unavailable', { detail: '' })))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [platformVersion, t])

  const recoveryDialog = recovery?.kind === 'open' ? (
    <Suspense fallback={null}>
      <RecoveryDialog
        dlq={recovery.dlq}
        clusterMembers={recovery.members}
        clusterSignature={recovery.signature}
        clusterMembersCapped={recovery.capped}
        clusterMembersTotal={recovery.total}
        onClose={() => setRecovery(null)}
      />
    </Suspense>
  ) : null

  if (error && !data) {
    return (
      <>
        <section className="panel-card">
          <div className="section-kicker">{t('clusters.heading')}</div>
          <p className="helper-text">{t('clusters.unavailable', { detail: error })}</p>
        </section>
        {recoveryDialog}
      </>
    )
  }
  if (!data) {
    return (
      <>
        <section className="panel-card" aria-busy={loading || undefined}>
          <div className="section-kicker">{t('clusters.heading')}</div>
          <p className="helper-text" aria-live="polite">{t('clusters.scoring')}</p>
        </section>
        {recoveryDialog}
      </>
    )
  }

  const { clusters, totalSamples, windowDays, fetchedAtMs } = data

  if (clusters.length === 0) {
    return (
      <>
        <section className="panel-card" aria-busy={loading || undefined}>
          <div className="section-kicker">{t('clusters.heading')}</div>
          <EmptyState
            icon={<CheckCircle2 />}
            kicker={t('emptyState.clusters.kicker')}
            body={t('emptyState.clusters.body')}
            testId="clusters-empty"
          />
        </section>
        {recoveryDialog}
      </>
    )
  }

  const cardSeverity: 'danger' | 'warning' | undefined = clusters.some(
    (c) => severityForCategory(c.category) === 'fail',
  )
    ? 'danger'
    : clusters.some((c) => severityForCategory(c.category) === 'warn')
      ? 'warning'
      : undefined

  const clusterCard = (
    <section className="panel-card" data-severity={cardSeverity} aria-busy={loading || undefined}>
      <div className="split-row">
        <div>
          <div className="section-kicker">{t('clusters.heading')}</div>
          <strong>{t('clusters.patterns', { count: clusters.length })}</strong>
        </div>
        <span className="helper-text we-cluster-summary">
          <RefreshCw size={12} aria-hidden="true" />{' '}
          {t('clusters.windowSummary', { samples: t('clusters.samples', { count: totalSamples }), days: windowDays })}
        </span>
      </div>
      {Number.isFinite(fetchedAtMs) && (
        <p className="helper-text we-cluster-asof">
          {t('clusters.asOf', { time: new Date(fetchedAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}
        </p>
      )}
      {error && (
        <p className="helper-text we-recovery-warning" role="status">
          {t('clusters.unavailable', { detail: error })}
        </p>
      )}

      <ul className="we-cluster-list">
        {clusters.map((cluster) => {
          const severity = severityForCategory(cluster.category)
          const isOpen = expanded[cluster.signature] ?? false
          const lastSeenLabel = formatRelative(cluster.lastSeen, fetchedAtMs)

          return (
            <li key={cluster.signature} className={`we-cluster-row we-cluster-row--${severity}`}>
              <button
                type="button"
                className="we-cluster-row__summary"
                onClick={() => setExpanded((prev) => ({ ...prev, [cluster.signature]: !isOpen }))}
                aria-expanded={isOpen}
                aria-label={t('clusters.rowAria', {
                  category: t(CATEGORY_KEYS[cluster.category] as never),
                  signature: cluster.signature,
                  occurrences: t('clusters.occurrences', { count: cluster.frequency }),
                  workflows: t('clusters.workflows', { count: cluster.affectedWorkflows.length }),
                })}
              >
                <span className="we-cluster-row__icon" aria-hidden="true">
                  {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </span>
                <span className="we-cluster-row__body">
                  <span className="we-cluster-row__title">
                    <AlertTriangle size={12} aria-hidden="true" />
                    <strong>{cluster.signature}</strong>
                  </span>
                  <span className="we-cluster-row__meta">
                    <span className={`mode-pill we-cluster-pill--${cluster.category}`}>{t(CATEGORY_KEYS[cluster.category] as never)}</span>
                    <span className="we-cluster-meta-sep">{t('clusters.occurrences', { count: cluster.frequency })}</span>
                    <span className="we-cluster-meta-sep">{t('clusters.workflows', { count: cluster.affectedWorkflows.length })}</span>
                    <span className="we-cluster-meta-sep">{t('clusters.lastSeen', { rel: lastSeenLabel })}</span>
                  </span>
                </span>
                <span className="we-cluster-row__owner" title={t('clusters.suggestedOwner')}>
                  <Users size={12} aria-hidden="true" /> {t(OWNER_KEYS[cluster.suggestedOwner] as never)}
                </span>
              </button>

              {isOpen && (
                <div className="we-cluster-row__details">
                  <div className="we-cluster-row__section">
                    <div className="field-label">{t('clusters.affected')}</div>
                    <ul className="we-cluster-row__workflows">
                      {cluster.affectedWorkflows.map((wf) => (
                        <li key={wf.workflowId}>
                          <strong>{wf.workflowName}</strong>
                          <span className="helper-text">{t('clusters.occurrences', { count: wf.count })}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="we-cluster-row__section">
                    <div className="field-label">{t('clusters.recent')}</div>
                    <ul className="we-cluster-row__samples">
                      {(showAllSamples[cluster.signature] ? cluster.samples : cluster.samples.slice(0, SAMPLES_PREVIEW_LIMIT)).map((sample) => (
                        <li key={`${sample.source}:${sample.id}`}>
                          <code>{sample.runId.slice(0, 12)}…</code>
                          <span className="helper-text">{sample.source === 'dead_letter' ? t('clusters.dlq') : t('clusters.failedRun')}</span>
                        </li>
                      ))}
                    </ul>
                    {cluster.samples.length > SAMPLES_PREVIEW_LIMIT && (
                      <button
                        type="button"
                        className="link-button"
                        data-testid={`cluster-samples-toggle-${cluster.signature}`}
                        onClick={() => setShowAllSamples((prev) => ({ ...prev, [cluster.signature]: !prev[cluster.signature] }))}
                      >
                        {showAllSamples[cluster.signature]
                          ? t('clusters.showFewerSamples')
                          : t('clusters.showMoreSamples', { count: cluster.samples.length - SAMPLES_PREVIEW_LIMIT })}
                      </button>
                    )}
                  </div>
                  {cluster.frequency >= MIN_FREQUENCY_FOR_BULK_RECOVER
                    && cluster.samples.some((s) => s.source === 'dead_letter') ? (
                    <div className="we-cluster-row__section">
                      <button
                        type="button"
                        className="command-button command-button-primary"
                        onClick={() => openClusterRecovery(cluster)}
                        disabled={recovery?.kind === 'loading' && recovery.signature === cluster.signature}
                      >
                        <Sparkles size={14} aria-hidden="true" />
                        <span>
                          {recovery?.kind === 'loading' && recovery.signature === cluster.signature
                            ? t('clusters.loadingMembers')
                            : t('clusters.recover')}
                        </span>
                      </button>
                      {recovery?.kind === 'error' && recovery.signature === cluster.signature && (
                        <p className="helper-text we-recovery-warning" role="alert">
                          {t('clusters.recoveryError', { detail: recovery.message })}
                        </p>
                      )}
                    </div>
                  ) : (
                    // Explain why bulk recovery isn't offered for this cluster instead
                    // of rendering nothing — the gate needs repeat failures AND a
                    // replayable dead-letter sample.
                    <div className="we-cluster-row__section">
                      <p className="helper-text we-cluster-row__recover-gate">
                        {t('clusters.recoverUnavailable', { min: MIN_FREQUENCY_FOR_BULK_RECOVER })}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
  return (
    <>
      {clusterCard}
      {recoveryDialog}
    </>
  )
}

/** "2h ago" / "5d ago" / ISO date — tight format for the meta-line. */
function formatRelative(iso: string, nowMs: number): string {
  const time = new Date(iso).getTime()
  if (!Number.isFinite(time)) return iso
  const diffSec = Math.max(0, Math.floor((nowMs - time) / 1000))
  if (diffSec < 60) return runtimeT('clusters.relative.justNow') as string
  if (diffSec < 3600) return runtimeT('clusters.relative.minutes', { count: Math.floor(diffSec / 60) }) as string
  if (diffSec < 86400) return runtimeT('clusters.relative.hours', { count: Math.floor(diffSec / 3600) }) as string
  if (diffSec < 7 * 86400) return runtimeT('clusters.relative.days', { count: Math.floor(diffSec / 86400) }) as string
  return new Date(iso).toLocaleDateString(getResolvedLocale())
}
