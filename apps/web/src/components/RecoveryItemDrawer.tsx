/**
 * Recovery item drawer — operator's incident detail surface. Opens on
 * click of a `RecoveryItemBadge` inside DLQ rows. Shows owner / severity
 * / status / SLA timer + transition buttons enabled by the current
 * status + append-only comment thread + resolve sub-form with the
 * closed-enum reason select.
 *
 * The drawer does NOT poll — the parent (DeadLettersPanel) re-fetches on
 * `platformVersion` bump after every successful transition, which we
 * trigger via the store's `bumpPlatformVersion()`.
 */

import React, { useEffect, useMemo, useState } from 'react'
import { Check, Download, ExternalLink, MessageCircle, Send, X } from 'lucide-react'
import {
  RECOVERY_ITEM_RESOLUTION_REASONS,
  RECOVERY_ITEM_SEVERITIES,
  type RecoveryItemResolutionReason,
  type RecoveryItemSeverity,
  type RecoveryItemStatus,
  isSeverityEscalation,
} from '@janusly/shared/src/recovery-item'
import {
  RECOVERY_HANDOFF_DESTINATIONS,
  type RecoveryHandoffDestination,
} from '@janusly/shared/src/recovery-handoff'
import { api, downloadFromApi } from '../api'
import { useWorkflowStore } from '../store'
import { getResolvedLocale, tApiError, useT } from '../i18n'
import { WorkflowAboutCard } from './WorkflowAboutCard'
import { ReportDeliveryDialog } from './ReportDeliveryDialog'

/** Per-surface copy for the generalized delivery dialog (evidence variant). */
const EVIDENCE_DELIVER_COPY = {
  kicker: 'recoveryEvidence.deliver.kicker',
  title: 'recoveryEvidence.deliver.title',
  description: 'recoveryEvidence.deliver.description',
  toastSent: 'recoveryEvidence.deliver.toastSent',
  successMessage: 'recoveryEvidence.deliver.successMessage',
}

export type RecoveryItemDrawerData = {
  id: string
  deadLetterId: string
  owner: string | null
  severity: RecoveryItemSeverity
  status: RecoveryItemStatus
  slaTargetAtIso: string
  resolutionReason: RecoveryItemResolutionReason | null
  comments: Array<{ id: string; authorUserId: string; body: string; createdAt: string }>
  /** Source workflow id from the run payload; may be an unsaved demo/template id. */
  workflowId?: string | null
  /** Persisted workflow id eligible for metadata lookups; null for unsaved templates. */
  metadataWorkflowId?: string | null
  /** Number of DLQ failures collapsed into this incident by debounce. 1 means a single failure. */
  occurrenceCount: number
  /** ISO timestamp of the most recent occurrence — drives the "last seen" subtitle. */
  lastOccurredAtIso: string
}

/** A child DLQ occurrence attached to this incident during a failure storm. */
type OccurrenceChild = { id: string; deadLetterId: string; occurredAt: string }

/** Compact relative-time label (narrow, locale-aware) for occurrence timestamps. */
function formatRelativeTime(iso: string): string {
  const ts = new Date(iso).getTime()
  if (Number.isNaN(ts)) return ''
  const deltaMin = Math.round((ts - Date.now()) / 60_000)
  const abs = Math.abs(deltaMin)
  const rtf = new Intl.RelativeTimeFormat(getResolvedLocale(), { numeric: 'auto', style: 'narrow' })
  if (abs < 60) return rtf.format(deltaMin, 'minute')
  if (abs < 60 * 24) return rtf.format(Math.round(deltaMin / 60), 'hour')
  return rtf.format(Math.round(deltaMin / 60 / 24), 'day')
}

type Props = {
  item: RecoveryItemDrawerData
  onClose: () => void
}

export function RecoveryItemDrawer({ item, onClose }: Props): React.ReactElement {
  const { t } = useT()
  const bumpPlatformVersion = useWorkflowStore((s) => s.bumpPlatformVersion)
  const addToast = useWorkflowStore((s) => s.addToast)
  const userId = useWorkflowStore((s) => s.userId)

  const [busyTransition, setBusyTransition] = useState<string | null>(null)
  const [commentDraft, setCommentDraft] = useState('')
  const [resolveOpen, setResolveOpen] = useState(false)
  const [resolveReason, setResolveReason] = useState<RecoveryItemResolutionReason>('fixed_by_patch')

  // Child-occurrence drawer (debounce). Lazy-fetched on first expand so the
  // network round-trip only happens for storms the operator chooses to inspect.
  const [occurrencesOpen, setOccurrencesOpen] = useState(false)
  const [children, setChildren] = useState<OccurrenceChild[] | null>(null)
  const [childrenError, setChildrenError] = useState(false)

  useEffect(() => {
    if (!occurrencesOpen || children !== null) return
    let cancelled = false
    api(`/recovery/items/${item.id}/children`)
      .then((resp: { children?: OccurrenceChild[] }) => {
        if (!cancelled) setChildren(resp?.children ?? [])
      })
      .catch(() => {
        if (!cancelled) setChildrenError(true)
      })
    return () => {
      cancelled = true
    }
  }, [occurrencesOpen, children, item.id])

  const canAcknowledge = item.status === 'open' || item.status === 'reopened'
  const canInProgress = item.status === 'acknowledged' || item.status === 'waiting_external'
  const canWaitingExternal = item.status === 'acknowledged' || item.status === 'in_progress'
  const canResolve = item.status !== 'resolved'
  const canReopen = item.status === 'resolved'

  const visibleResolutionReasons = useMemo(
    () => RECOVERY_ITEM_RESOLUTION_REASONS.filter((r) => r !== 'sandbox_replay_succeeded'),
    [],
  )
  const escalationTargets = useMemo(
    () => RECOVERY_ITEM_SEVERITIES.filter((s) => isSeverityEscalation(item.severity, s)),
    [item.severity],
  )

  async function callTransition(
    verb: string,
    body: Record<string, unknown> = {},
  ): Promise<void> {
    setBusyTransition(verb)
    try {
      await api(`/recovery/items/${item.id}/${verb}`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      addToast(t('recoveryItems.toast.transitionOk') as string, 'success')
      bumpPlatformVersion()
      onClose()
    } catch (err) {
      addToast(tApiError(err) || (t('recoveryItems.toast.transitionFailed') as string), 'error')
    } finally {
      setBusyTransition(null)
    }
  }

  async function takeOwnership(): Promise<void> {
    await callTransition('assign', { owner: userId ?? 'dev-user' })
  }

  // Audit evidence export — downloads a single per-incident artefact
  // (run timeline, DLQ row, scrubbed signature, AI explanation, patch
  // diff, sandbox validation, approval trail, audit rows, rollback link)
  // as JSON or Markdown. Compliance buyers archive this per failure. Does
  // NOT bumpPlatformVersion — exporting is read-only from the operator's
  // POV (the server's audit row is a side effect, not panel state).
  const [evidenceBusy, setEvidenceBusy] = useState<'json' | 'markdown' | null>(null)
  // Deliver the evidence report to Slack / GitHub / webhook via the generalized
  // ReportDeliveryDialog pointed at the evidence endpoint (the dialog bumps
  // platformVersion on success so the audit-log panel refreshes).
  const [deliverOpen, setDeliverOpen] = useState(false)
  async function exportEvidence(format: 'json' | 'markdown'): Promise<void> {
    setEvidenceBusy(format)
    try {
      await downloadFromApi(`/recovery/items/${item.id}/evidence?format=${format}`, {
        method: 'POST',
      })
      addToast(t('recoveryItems.evidence.toastOk') as string, 'success')
    } catch (err) {
      addToast(tApiError(err) || (t('recoveryItems.evidence.toastFailed') as string), 'error')
    } finally {
      setEvidenceBusy(null)
    }
  }

  async function submitComment(): Promise<void> {
    const body = commentDraft.trim()
    if (!body) return
    setBusyTransition('comment')
    try {
      await api(`/recovery/items/${item.id}/comment`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      })
      addToast(t('recoveryItems.toast.commentAdded') as string, 'success')
      setCommentDraft('')
      bumpPlatformVersion()
    } catch (err) {
      addToast(tApiError(err) || (t('recoveryItems.toast.commentFailed') as string), 'error')
    } finally {
      setBusyTransition(null)
    }
  }

  async function submitResolve(): Promise<void> {
    await callTransition('resolve', { resolutionReason: resolveReason })
  }

  async function submitEscalate(severity: RecoveryItemSeverity): Promise<void> {
    await callTransition('escalate', { severity })
  }

  // ─── Handoff section ─────────────────────────────────────────────────────

  const [handoffOpen, setHandoffOpen] = useState(false)
  const [handoffDest, setHandoffDest] = useState<RecoveryHandoffDestination>('slack')
  const [handoffCredentialName, setHandoffCredentialName] = useState('')
  const [handoffOwner, setHandoffOwner] = useState('')
  const [handoffRepo, setHandoffRepo] = useState('')
  const [handoffUrl, setHandoffUrl] = useState('')
  const [credentials, setCredentials] = useState<Array<{ id: string; name: string; kind: string }>>([])
  const [existingHandoffs, setExistingHandoffs] = useState<
    Array<{
      id: string
      destination: RecoveryHandoffDestination
      dispatchCount: number
      externalUrl: string | null
      lastOutcome: 'delivered' | 'delivery_failed'
      lastDispatchedAt: string
    }>
  >([])

  const credentialKindForDestination: Record<RecoveryHandoffDestination, string> = {
    slack: 'slack_webhook',
    github: 'github_token',
    webhook: 'webhook_secret',
    // Linear shares the webhook_secret kind because the dispatcher uses
    // webhook.send for Linear (no Linear-native client in v1).
    linear: 'webhook_secret',
  }

  useEffect(() => {
    let cancelled = false
    Promise.all([
      api('/credentials').catch(() => []),
      api(`/recovery/items/${item.id}`).catch(() => ({ item: null, handoffs: [] })),
    ]).then(([credResp, itemResp]: [unknown, unknown]) => {
      if (cancelled) return
      setCredentials((credResp as Array<{ id: string; name: string; kind: string }>) ?? [])
      const detail = itemResp as { handoffs?: typeof existingHandoffs }
      setExistingHandoffs(detail?.handoffs ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [item.id])

  const credentialsForDest = useMemo(() => {
    const wanted = credentialKindForDestination[handoffDest]
    return credentials.filter((c) => !wanted || c.kind === wanted)
  }, [credentials, handoffDest])

  useEffect(() => {
    if (!handoffCredentialName) return
    const stillAvailable = credentialsForDest.some((c) => c.name === handoffCredentialName)
    if (!stillAvailable) setHandoffCredentialName('')
  }, [credentialsForDest, handoffCredentialName])

  const canSubmitHandoff =
    handoffCredentialName.trim().length > 0 &&
    (handoffDest !== 'github' || (handoffOwner.trim().length > 0 && handoffRepo.trim().length > 0)) &&
    ((handoffDest !== 'webhook' && handoffDest !== 'linear') || handoffUrl.trim().length > 0)

  async function submitHandoff(): Promise<void> {
    if (!canSubmitHandoff) return
    setBusyTransition('handoff')
    try {
      const body: Record<string, unknown> = {
        destination: handoffDest,
        credentialName: handoffCredentialName.trim(),
      }
      if (handoffDest === 'github') {
        body.owner = handoffOwner.trim()
        body.repo = handoffRepo.trim()
      }
      if (handoffDest === 'webhook' || handoffDest === 'linear') {
        body.url = handoffUrl.trim()
      }
      const resp = (await api(`/recovery/items/${item.id}/handoff`, {
        method: 'POST',
        body: JSON.stringify(body),
      })) as {
        ok: boolean
        alreadyDispatched?: boolean
        skipped?: boolean
        handoff?: {
          id: string
          destination: RecoveryHandoffDestination
          dispatchCount: number
          externalUrl: string | null
          lastOutcome: 'delivered' | 'delivery_failed'
          lastDispatchedAt: string
        }
      }
      if (resp.skipped) {
        addToast(t('recoveryHandoff.toast.skipped') as string, 'info')
      } else if (resp.alreadyDispatched) {
        addToast(t('recoveryHandoff.toast.alreadyDispatched') as string, 'info')
      } else if (resp.ok) {
        addToast(t('recoveryHandoff.toast.delivered') as string, 'success')
      } else {
        addToast(t('recoveryHandoff.toast.failed') as string, 'error')
      }
      if (resp.handoff) {
        setExistingHandoffs((prev) => {
          const without = prev.filter((h) => h.destination !== resp.handoff!.destination)
          return [...without, resp.handoff!]
        })
      }
      setHandoffCredentialName('')
      setHandoffOwner('')
      setHandoffRepo('')
      setHandoffUrl('')
      // Collapse the form on any non-error outcome (delivered / cooldown /
      // sandbox skip) so the operator can re-open it cleanly for a new
      // destination. Hard failures keep the form open so the operator can
      // retry without re-entering the same fields.
      if (resp.skipped || resp.alreadyDispatched || resp.ok) {
        setHandoffOpen(false)
      }
      bumpPlatformVersion()
    } catch (err) {
      addToast(tApiError(err) || (t('recoveryHandoff.toast.failed') as string), 'error')
    } finally {
      setBusyTransition(null)
    }
  }

  return (
    <aside
      className="we-recovery-item-drawer"
      role="dialog"
      aria-label={t('recoveryItems.drawer.title')}
      data-testid="recovery-item-drawer"
    >
      <div className="we-recovery-item-drawer__header">
        <h3>
          {t('recoveryItems.drawer.title')} ·{' '}
          <span className={`we-pill we-pill--${item.status === 'resolved' ? 'green' : 'cobalt'}`}>
            {t(`recoveryItems.status.${item.status}`)}
          </span>
        </h3>
        <button
          type="button"
          className="we-btn we-btn--ghost we-btn--sm"
          onClick={onClose}
          aria-label={t('common.close') as string}
        >
          <X size={14} aria-hidden />
        </button>
      </div>

      <dl className="we-recovery-item-drawer__meta">
        <div>
          <dt>{t('recoveryItems.drawer.owner')}</dt>
          <dd>{item.owner ?? t('recoveryItems.drawer.unassigned')}</dd>
        </div>
        <div>
          <dt>{t('recoveryItems.drawer.severity')}</dt>
          <dd>{t(`recoveryItems.severity.${item.severity}`)}</dd>
        </div>
        <div>
          <dt>{t('recoveryItems.drawer.sla')}</dt>
          <dd>{new Date(item.slaTargetAtIso).toLocaleString(getResolvedLocale())}</dd>
        </div>
      </dl>

      <div className="we-recovery-item-drawer__evidence" data-testid="recovery-item-evidence">
        <span className="we-recovery-item-drawer__evidence-label">
          {t('recoveryItems.evidence.label')}
        </span>
        <div className="we-recovery-item-drawer__evidence-actions">
          <button
            type="button"
            className="we-btn we-btn--ghost we-btn--sm"
            onClick={() => exportEvidence('json')}
            disabled={evidenceBusy !== null}
            data-testid="ri-evidence-json"
          >
            <Download size={14} aria-hidden /> {t('recoveryItems.evidence.json')}
          </button>
          <button
            type="button"
            className="we-btn we-btn--ghost we-btn--sm"
            onClick={() => exportEvidence('markdown')}
            disabled={evidenceBusy !== null}
            data-testid="ri-evidence-markdown"
          >
            <Download size={14} aria-hidden /> {t('recoveryItems.evidence.markdown')}
          </button>
          <button
            type="button"
            className="we-btn we-btn--ghost we-btn--sm"
            onClick={() => setDeliverOpen(true)}
            disabled={evidenceBusy !== null}
            data-testid="ri-evidence-deliver"
          >
            <Send size={14} aria-hidden /> {t('recoveryEvidence.deliver.action')}
          </button>
        </div>
      </div>

      {deliverOpen && (
        <ReportDeliveryDialog
          endpoint={`/recovery/items/${item.id}/evidence/deliver`}
          copyKeys={EVIDENCE_DELIVER_COPY}
          onClose={() => setDeliverOpen(false)}
        />
      )}

      {item.occurrenceCount > 1 && (
        <div className="we-recovery-occurrences" data-testid="recovery-item-occurrences-section">
          <div className="we-recovery-occurrences__summary">
            <span className="we-pill we-pill--amber" data-testid="recovery-item-occurrences-badge">
              {t('recoveryItems.occurrences.badge', { count: item.occurrenceCount })}
            </span>
            <span className="we-recovery-occurrences__lastseen">
              {t('recoveryItems.occurrences.lastSeen', { when: formatRelativeTime(item.lastOccurredAtIso) })}
            </span>
            <button
              type="button"
              className="we-btn we-btn--ghost we-btn--sm"
              onClick={() => setOccurrencesOpen((v) => !v)}
              aria-expanded={occurrencesOpen}
              data-testid="recovery-item-occurrences-toggle"
            >
              {t(occurrencesOpen ? 'recoveryItems.occurrences.hide' : 'recoveryItems.occurrences.show')}
            </button>
          </div>
          {occurrencesOpen && (
            <div className="we-recovery-occurrences__list" data-testid="recovery-item-occurrences-list">
              {childrenError ? (
                <p className="we-recovery-occurrences__empty">{t('recoveryItems.occurrences.loadError')}</p>
              ) : children === null ? (
                <p className="we-recovery-occurrences__empty">{t('common.loading')}</p>
              ) : children.length === 0 ? (
                <p className="we-recovery-occurrences__empty">{t('recoveryItems.occurrences.empty')}</p>
              ) : (
                <ul>
                  {children.map((c) => (
                    <li
                      key={c.id}
                      className="we-recovery-occurrences__entry"
                      aria-label={
                        t('recoveryItems.occurrences.entryAria', {
                          id: c.deadLetterId,
                          when: formatRelativeTime(c.occurredAt),
                        }) as string
                      }
                    >
                      <code>{c.deadLetterId}</code>
                      <span>{new Date(c.occurredAt).toLocaleString(getResolvedLocale())}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      <div className="we-recovery-item-drawer__actions" data-testid="recovery-item-drawer-actions">
        {canAcknowledge && (
          <button
            type="button"
            className="we-btn we-btn--primary we-btn--sm"
            onClick={() => callTransition('acknowledge', {})}
            disabled={busyTransition !== null}
            data-testid="ri-action-acknowledge"
          >
            {t('recoveryItems.action.acknowledge')}
          </button>
        )}
        <button
          type="button"
          className="we-btn we-btn--ghost we-btn--sm"
          onClick={takeOwnership}
          disabled={busyTransition !== null || item.status === 'resolved'}
          data-testid="ri-action-take-ownership"
        >
          {t('recoveryItems.action.takeOwnership')}
        </button>
        {canInProgress && (
          <button
            type="button"
            className="we-btn we-btn--ghost we-btn--sm"
            onClick={() => callTransition('in-progress', {})}
            disabled={busyTransition !== null}
            data-testid="ri-action-in-progress"
          >
            {t('recoveryItems.action.inProgress')}
          </button>
        )}
        {canWaitingExternal && (
          <button
            type="button"
            className="we-btn we-btn--ghost we-btn--sm"
            onClick={() => callTransition('waiting-external', {})}
            disabled={busyTransition !== null}
            data-testid="ri-action-waiting-external"
          >
            {t('recoveryItems.action.waitingExternal')}
          </button>
        )}
        {canResolve && (
          <button
            type="button"
            className="we-btn we-btn--ghost we-btn--sm"
            onClick={() => setResolveOpen((v) => !v)}
            disabled={busyTransition !== null}
            data-testid="ri-action-resolve"
          >
            {t('recoveryItems.action.resolve')}
          </button>
        )}
        {canReopen && (
          <button
            type="button"
            className="we-btn we-btn--ghost we-btn--sm"
            onClick={() => callTransition('reopen', {})}
            disabled={busyTransition !== null}
            data-testid="ri-action-reopen"
          >
            {t('recoveryItems.action.reopen')}
          </button>
        )}
        {item.status !== 'resolved' && escalationTargets.length > 0 && (
          <div className="we-recovery-item-drawer__escalate" data-testid="ri-escalate-controls">
            <span>{t('recoveryItems.action.escalateTo')}</span>
            {escalationTargets.map((s) => (
              <button
                key={s}
                type="button"
                className="we-btn we-btn--ghost we-btn--sm"
                onClick={() => submitEscalate(s)}
                disabled={busyTransition !== null}
                data-testid={`ri-action-escalate-${s}`}
              >
                {t(`recoveryItems.severity.${s}`)}
              </button>
            ))}
          </div>
        )}
      </div>

      {resolveOpen && canResolve && (
        <div className="we-recovery-item-drawer__resolve" data-testid="recovery-item-resolve-form">
          <label>
            {t('recoveryItems.resolve.reason')}
            <select
              value={resolveReason}
              onChange={(e) => setResolveReason(e.target.value as RecoveryItemResolutionReason)}
            >
              {visibleResolutionReasons.map((r) => (
                <option key={r} value={r}>
                  {t(`recoveryItems.resolutionReason.${r}`)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="we-btn we-btn--primary we-btn--sm"
            onClick={submitResolve}
            disabled={busyTransition !== null}
            data-testid="ri-resolve-submit"
          >
            <Check size={14} aria-hidden /> {t('recoveryItems.resolve.submit')}
          </button>
        </div>
      )}

      {item.metadataWorkflowId && <WorkflowAboutCard workflowId={item.metadataWorkflowId} />}

      <div className="we-recovery-item-drawer__handoff" data-testid="recovery-item-handoff">
        <h4>
          <Send size={14} aria-hidden /> {t('recoveryHandoff.heading')}
        </h4>
        {existingHandoffs.length > 0 && (
          <ul className="we-recovery-item-drawer__handoff-history" data-testid="recovery-item-handoff-history">
            {existingHandoffs.map((h) => (
              <li key={h.id} data-destination={h.destination} data-outcome={h.lastOutcome}>
                <strong>{t(`recoveryHandoff.destinations.${h.destination}`)}</strong>
                <span className="we-list-row__hint">
                  {t('recoveryHandoff.dispatchCount', { count: h.dispatchCount })} ·{' '}
                  {new Date(h.lastDispatchedAt).toLocaleString(getResolvedLocale())}
                </span>
                {h.externalUrl && /^https?:\/\//i.test(h.externalUrl) && (
                  <a href={h.externalUrl} target="_blank" rel="noreferrer noopener">
                    {t('recoveryHandoff.openExternal')} <ExternalLink size={12} aria-hidden />
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
        {!handoffOpen ? (
          <button
            type="button"
            className="we-btn we-btn--ghost we-btn--sm"
            onClick={() => setHandoffOpen(true)}
            data-testid="ri-handoff-open"
          >
            <Send size={14} aria-hidden /> {t('recoveryHandoff.action.open')}
          </button>
        ) : (
          <div className="we-recovery-item-drawer__handoff-form" data-testid="recovery-item-handoff-form">
            <label>
              {t('recoveryHandoff.form.destination')}
              <select
                value={handoffDest}
                onChange={(e) => setHandoffDest(e.target.value as RecoveryHandoffDestination)}
              >
                {RECOVERY_HANDOFF_DESTINATIONS.map((d) => (
                  <option key={d} value={d}>
                    {t(`recoveryHandoff.destinations.${d}`)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('recoveryHandoff.form.credential')}
              <select
                value={handoffCredentialName}
                onChange={(e) => setHandoffCredentialName(e.target.value)}
                data-testid="ri-handoff-credential"
              >
                <option value="">{t('recoveryHandoff.form.pickCredential')}</option>
                {credentialsForDest.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            {handoffDest === 'github' && (
              <>
                <label>
                  {t('recoveryHandoff.form.githubOwner')}
                  <input
                    type="text"
                    value={handoffOwner}
                    onChange={(e) => setHandoffOwner(e.target.value)}
                    maxLength={120}
                  />
                </label>
                <label>
                  {t('recoveryHandoff.form.githubRepo')}
                  <input
                    type="text"
                    value={handoffRepo}
                    onChange={(e) => setHandoffRepo(e.target.value)}
                    maxLength={120}
                  />
                </label>
              </>
            )}
            {(handoffDest === 'webhook' || handoffDest === 'linear') && (
              <label>
                {t('recoveryHandoff.form.url')}
                <input
                  type="url"
                  value={handoffUrl}
                  onChange={(e) => setHandoffUrl(e.target.value)}
                  placeholder={t('recoveryHandoff.form.urlPlaceholder') as string}
                  maxLength={2048}
                />
              </label>
            )}
            <div className="we-recovery-item-drawer__handoff-actions">
              <button
                type="button"
                className="we-btn we-btn--primary we-btn--sm"
                onClick={submitHandoff}
                disabled={busyTransition !== null || !canSubmitHandoff}
                data-testid="ri-handoff-submit"
              >
                {t('recoveryHandoff.action.submit')}
              </button>
              <button
                type="button"
                className="we-btn we-btn--ghost we-btn--sm"
                onClick={() => setHandoffOpen(false)}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="we-recovery-item-drawer__comments" data-testid="recovery-item-comments">
        <h4>
          <MessageCircle size={14} aria-hidden /> {t('recoveryItems.drawer.commentsHeading')}
        </h4>
        <ul>
          {[...item.comments].reverse().map((c) => (
            <li key={c.id}>
              <strong>{c.authorUserId}</strong>
              <span className="we-recovery-item-drawer__comments-time">
                {new Date(c.createdAt).toLocaleString(getResolvedLocale())}
              </span>
              <p>{c.body}</p>
            </li>
          ))}
          {item.comments.length === 0 && (
            <li className="we-list-row--empty">{t('recoveryItems.drawer.commentsEmpty')}</li>
          )}
        </ul>
        <div className="we-recovery-item-drawer__comments-input">
          <textarea
            value={commentDraft}
            onChange={(e) => setCommentDraft(e.target.value)}
            placeholder={t('recoveryItems.drawer.commentPlaceholder') as string}
            maxLength={4_000}
            rows={2}
          />
          <button
            type="button"
            className="we-btn we-btn--ghost we-btn--sm"
            onClick={submitComment}
            disabled={busyTransition !== null || commentDraft.trim().length === 0}
            data-testid="ri-comment-submit"
          >
            {t('recoveryItems.action.addComment')}
          </button>
        </div>
      </div>
    </aside>
  )
}
