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
 * failure flips this surface without a manual refresh.
 *
 * Used in `DeadLettersPanel.tsx` (Runs tab → Operations card).
 */

import React, { useEffect, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, RefreshCw, Sparkles, Users } from 'lucide-react'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { RecoveryDialog } from './RecoveryDialog'
import type { DeadLetter } from './DeadLettersPanel'

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

const CATEGORY_LABELS: Record<ClusterCategory, string> = {
  secret_missing: 'Secret',
  http_error: 'HTTP',
  network_timeout: 'Network',
  ai_provider: 'AI provider',
  parse_error: 'Parse',
  tool_input: 'Tool',
  unknown: 'Other',
}

const OWNER_LABELS: Record<ClusterOwner, string> = {
  ops: 'Ops',
  workflow_author: 'Workflow author',
  platform: 'Platform',
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
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  const [data, setData] = useState<ClusterData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
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
          setRecovery({ kind: 'error', signature: cluster.signature, message: 'No open DLQ entries match this pattern any more.' })
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
        message: err instanceof Error ? err.message : 'Failed to load cluster members',
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
        setError(err instanceof Error ? err.message : 'Cluster rollup unavailable')
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [platformVersion])

  if (error) {
    return (
      <section className="panel-card">
        <div className="section-kicker">Failure clusters</div>
        <p className="helper-text">Cluster rollup unavailable — {error}</p>
      </section>
    )
  }
  if (loading || !data) {
    return (
      <section className="panel-card">
        <div className="section-kicker">Failure clusters</div>
        <p className="helper-text" aria-live="polite">Scoring recent failures…</p>
      </section>
    )
  }

  const { clusters, totalSamples, windowDays, fetchedAtMs } = data

  if (clusters.length === 0) {
    return (
      <section className="panel-card">
        <div className="section-kicker">Failure clusters</div>
        <p className="helper-text">No recurring failures in the last {windowDays} days.</p>
      </section>
    )
  }

  return (
    <section className="panel-card">
      <div className="split-row">
        <div>
          <div className="section-kicker">Failure clusters</div>
          <strong>{clusters.length} pattern{clusters.length === 1 ? '' : 's'}</strong>
        </div>
        <span className="helper-text we-cluster-summary">
          <RefreshCw size={12} aria-hidden="true" /> {totalSamples} sample{totalSamples === 1 ? '' : 's'} · last {windowDays} days
        </span>
      </div>

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
                aria-label={`${cluster.signature} — ${cluster.frequency} occurrences across ${cluster.affectedWorkflows.length} workflow${cluster.affectedWorkflows.length === 1 ? '' : 's'}`}
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
                    <span className={`mode-pill we-cluster-pill--${cluster.category}`}>{CATEGORY_LABELS[cluster.category]}</span>
                    <span className="we-cluster-meta-sep">{cluster.frequency} occurrence{cluster.frequency === 1 ? '' : 's'}</span>
                    <span className="we-cluster-meta-sep">{cluster.affectedWorkflows.length} workflow{cluster.affectedWorkflows.length === 1 ? '' : 's'}</span>
                    <span className="we-cluster-meta-sep">last seen {lastSeenLabel}</span>
                  </span>
                </span>
                <span className="we-cluster-row__owner" title="Suggested owner">
                  <Users size={12} aria-hidden="true" /> {OWNER_LABELS[cluster.suggestedOwner]}
                </span>
              </button>

              {isOpen && (
                <div className="we-cluster-row__details">
                  <div className="we-cluster-row__section">
                    <div className="field-label">Affected workflows</div>
                    <ul className="we-cluster-row__workflows">
                      {cluster.affectedWorkflows.map((wf) => (
                        <li key={wf.workflowId}>
                          <strong>{wf.workflowName}</strong>
                          <span className="helper-text">{wf.count} occurrence{wf.count === 1 ? '' : 's'}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="we-cluster-row__section">
                    <div className="field-label">Recent runs</div>
                    <ul className="we-cluster-row__samples">
                      {cluster.samples.map((sample) => (
                        <li key={`${sample.source}:${sample.id}`}>
                          <code>{sample.runId.slice(0, 12)}…</code>
                          <span className="helper-text">{sample.source === 'dead_letter' ? 'DLQ' : 'failed run'}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  {cluster.frequency >= MIN_FREQUENCY_FOR_BULK_RECOVER
                    && cluster.samples.some((s) => s.source === 'dead_letter') && (
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
                            ? 'Loading members…'
                            : 'Recover this pattern'}
                        </span>
                      </button>
                      {recovery?.kind === 'error' && recovery.signature === cluster.signature && (
                        <p className="helper-text we-recovery-warning" role="alert">
                          Could not start cluster recovery — {recovery.message}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {recovery?.kind === 'open' && (
        <RecoveryDialog
          dlq={recovery.dlq}
          clusterMembers={recovery.members}
          clusterSignature={recovery.signature}
          clusterMembersCapped={recovery.capped}
          clusterMembersTotal={recovery.total}
          onClose={() => setRecovery(null)}
        />
      )}
    </section>
  )
}

/** "2h ago" / "5d ago" / ISO date — tight format for the meta-line. */
function formatRelative(iso: string, nowMs: number): string {
  const time = new Date(iso).getTime()
  if (!Number.isFinite(time)) return iso
  const diffSec = Math.max(0, Math.floor((nowMs - time) / 1000))
  if (diffSec < 60) return 'just now'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  if (diffSec < 7 * 86400) return `${Math.floor(diffSec / 86400)}d ago`
  return new Date(iso).toLocaleDateString()
}
