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

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Download, MessageCircle, Send, X } from 'lucide-react'
import {
  RECOVERY_ITEM_RESOLUTION_REASONS,
  RECOVERY_ITEM_SEVERITIES,
  type RecoveryItemResolutionReason,
  type RecoveryItemSeverity,
  type RecoveryItemStatus,
  isSeverityEscalation,
} from '@/lib/recovery-item'
import { api, downloadFromApi } from '../api'
import { useWorkflowStore } from '../store'
import { getResolvedLocale, tApiError, useT } from '../i18n'
import { WorkflowAboutCard } from './WorkflowAboutCard'
import { RecoveryHandoffSection } from './recovery-item/RecoveryHandoffSection'
import { RecoveryOccurrences } from './recovery-item/RecoveryOccurrences'
import { ReportDeliveryDialog } from './ReportDeliveryDialog'
import { Button } from '@/components/ui/Button'

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
type Props = {
  item: RecoveryItemDrawerData
  onClose: () => void
}

export function RecoveryItemDrawer({ item, onClose }: Props): React.ReactElement {
  const { t } = useT()
  const bumpPlatformVersion = useWorkflowStore((s) => s.bumpPlatformVersion)
  const addToast = useWorkflowStore((s) => s.addToast)
  const userId = useWorkflowStore((s) => s.userId)

  // Non-modal drawer focus management. The drawer mounts at the END of the DOM
  // (below the whole DLQ list), so a keyboard / screen-reader operator who
  // clicked a row badge would otherwise be stranded far from the panel they
  // just opened. On open, move focus into the drawer (its aria-label is then
  // announced); Escape closes it; on close, focus returns to the badge that
  // opened it. Deliberately NOT a focus trap — the drawer is inline, not a modal
  // overlay, so Tab must still reach the rest of the page (a hard Tab-trap on
  // non-modal content is itself an accessibility failure).
  const drawerRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const trigger =
      typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null
    drawerRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Don't steal Escape from a nested modal layered on top (e.g. the evidence
      // ReportDeliveryDialog — let it close first), and ignore Escape fired from
      // background content the user has tabbed to. Only close when focus is
      // within the drawer and no modal is open.
      const node = drawerRef.current
      if (!node || !node.contains(document.activeElement)) return
      if (document.querySelector('[aria-modal="true"]')) return
      onCloseRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      // Restore focus to the trigger (the badge) on close, if it still exists.
      // Synchronous (NOT requestAnimationFrame) so it is StrictMode-safe: dev
      // double-invokes the effect as mount → cleanup → mount, and a deferred
      // restore would land AFTER the second mount's focus-in and steal focus
      // back to the trigger. A synchronous restore self-corrects — the re-mount's
      // focus-in runs after it, leaving focus on the drawer as intended. Skip the
      // restore when a modal is layered on top so we don't yank focus out of it.
      if (trigger && document.contains(trigger) && !document.querySelector('[aria-modal="true"]')) {
        trigger.focus()
      }
    }
    // Mount-once: the drawer remounts per open (parent gates on the selected id),
    // so focus-in / restore fire exactly once. onClose is read via a ref so this
    // effect never re-runs (and never steals focus) on a parent re-render.
  }, [])

  const [busyTransition, setBusyTransition] = useState<string | null>(null)
  const [commentDraft, setCommentDraft] = useState('')
  const [resolveOpen, setResolveOpen] = useState(false)
  const [resolveReason, setResolveReason] = useState<RecoveryItemResolutionReason>('fixed_by_patch')


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
      addToast(t('recoveryItems.toast.transitionOk'), 'success')
      bumpPlatformVersion()
      onClose()
    } catch (err) {
      addToast(tApiError(err) || (t('recoveryItems.toast.transitionFailed')), 'error')
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
      addToast(t('recoveryItems.evidence.toastOk'), 'success')
    } catch (err) {
      addToast(tApiError(err) || (t('recoveryItems.evidence.toastFailed')), 'error')
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
      addToast(t('recoveryItems.toast.commentAdded'), 'success')
      setCommentDraft('')
      bumpPlatformVersion()
    } catch (err) {
      addToast(tApiError(err) || (t('recoveryItems.toast.commentFailed')), 'error')
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

  return (
    <aside
      ref={drawerRef}
      tabIndex={-1}
      className="we-recovery-item-drawer"
      role="dialog"
      aria-modal={false}
      aria-label={t('recoveryItems.drawer.title')}
      data-testid="recovery-item-drawer"
    >
      <div className="we-recovery-item-drawer__header">
        <h3>
          {t('recoveryItems.drawer.title')} ·{' '}
          <span className="we-pill" data-tone={item.status === 'resolved' ? 'success' : 'primary'}>
            {t(`recoveryItems.status.${item.status}`)}
          </span>
        </h3>
        <Button variant="ghost" size="sm"
          type="button"

          onClick={onClose}
          aria-label={t('common.close')}
        >
          <X size={14} aria-hidden />
        </Button>
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
          <Button variant="ghost" size="sm"
            type="button"

            onClick={() => exportEvidence('json')}
            disabled={evidenceBusy !== null}
            data-testid="ri-evidence-json"
          >
            <Download size={14} aria-hidden /> {t('recoveryItems.evidence.json')}
          </Button>
          <Button variant="ghost" size="sm"
            type="button"

            onClick={() => exportEvidence('markdown')}
            disabled={evidenceBusy !== null}
            data-testid="ri-evidence-markdown"
          >
            <Download size={14} aria-hidden /> {t('recoveryItems.evidence.markdown')}
          </Button>
          <Button variant="ghost" size="sm"
            type="button"

            onClick={() => setDeliverOpen(true)}
            disabled={evidenceBusy !== null}
            data-testid="ri-evidence-deliver"
          >
            <Send size={14} aria-hidden /> {t('recoveryEvidence.deliver.action')}
          </Button>
        </div>
      </div>

      {deliverOpen && (
        <ReportDeliveryDialog
          endpoint={`/recovery/items/${item.id}/evidence/deliver`}
          copyKeys={EVIDENCE_DELIVER_COPY}
          onClose={() => setDeliverOpen(false)}
        />
      )}

      <RecoveryOccurrences item={item} />

      {/* Lifecycle legend so the transition buttons below read in context —
          which states follow which is otherwise opaque to a new operator. */}
      <p className="we-recovery-item-drawer__legend helper-text">{t('recoveryItems.legend')}</p>
      <div className="we-recovery-item-drawer__actions" data-testid="recovery-item-drawer-actions">
        {canAcknowledge && (
          <Button variant="primary" size="sm"
            type="button"

            onClick={() => callTransition('acknowledge', {})}
            disabled={busyTransition !== null}
            data-testid="ri-action-acknowledge"
          >
            {t('recoveryItems.action.acknowledge')}
          </Button>
        )}
        <Button variant="ghost" size="sm"
          type="button"

          onClick={takeOwnership}
          disabled={busyTransition !== null || item.status === 'resolved'}
          data-testid="ri-action-take-ownership"
        >
          {t('recoveryItems.action.takeOwnership')}
        </Button>
        {canInProgress && (
          <Button variant="ghost" size="sm"
            type="button"

            onClick={() => callTransition('in-progress', {})}
            disabled={busyTransition !== null}
            data-testid="ri-action-in-progress"
          >
            {t('recoveryItems.action.inProgress')}
          </Button>
        )}
        {canWaitingExternal && (
          <Button variant="ghost" size="sm"
            type="button"

            onClick={() => callTransition('waiting-external', {})}
            disabled={busyTransition !== null}
            data-testid="ri-action-waiting-external"
          >
            {t('recoveryItems.action.waitingExternal')}
          </Button>
        )}
        {canResolve && (
          <Button variant="ghost" size="sm"
            type="button"

            onClick={() => setResolveOpen((v) => !v)}
            disabled={busyTransition !== null}
            data-testid="ri-action-resolve"
          >
            {t('recoveryItems.action.resolve')}
          </Button>
        )}
        {canReopen && (
          <Button variant="ghost" size="sm"
            type="button"

            onClick={() => callTransition('reopen', {})}
            disabled={busyTransition !== null}
            data-testid="ri-action-reopen"
          >
            {t('recoveryItems.action.reopen')}
          </Button>
        )}
        {item.status !== 'resolved' && escalationTargets.length > 0 && (
          <div className="we-recovery-item-drawer__escalate" data-testid="ri-escalate-controls">
            <span>{t('recoveryItems.action.escalateTo')}</span>
            {escalationTargets.map((s) => (
              <Button variant="ghost" size="sm"
                key={s}
                type="button"

                onClick={() => submitEscalate(s)}
                disabled={busyTransition !== null}
                data-testid={`ri-action-escalate-${s}`}
              >
                {t(`recoveryItems.severity.${s}`)}
              </Button>
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
          <Button variant="primary" size="sm"
            type="button"

            onClick={submitResolve}
            disabled={busyTransition !== null}
            data-testid="ri-resolve-submit"
          >
            <Check size={14} aria-hidden /> {t('recoveryItems.resolve.submit')}
          </Button>
        </div>
      )}

      {item.metadataWorkflowId && <WorkflowAboutCard workflowId={item.metadataWorkflowId} />}

      <RecoveryHandoffSection
        itemId={item.id}
        disabled={busyTransition !== null}
        onBusyChange={setBusyTransition}
      />

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
            placeholder={t('recoveryItems.drawer.commentPlaceholder')}
            maxLength={4_000}
            rows={2}
          />
          <Button variant="ghost" size="sm"
            type="button"

            onClick={submitComment}
            disabled={busyTransition !== null || commentDraft.trim().length === 0}
            data-testid="ri-comment-submit"
          >
            {t('recoveryItems.action.addComment')}
          </Button>
        </div>
      </div>
    </aside>
  )
}
