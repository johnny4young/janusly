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

import React, { useMemo, useState } from 'react'
import { Check, MessageCircle, X } from 'lucide-react'
import {
  RECOVERY_ITEM_RESOLUTION_REASONS,
  RECOVERY_ITEM_SEVERITIES,
  type RecoveryItemResolutionReason,
  type RecoveryItemSeverity,
  type RecoveryItemStatus,
  isSeverityEscalation,
} from '@janusly/shared/src/recovery-item'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { getResolvedLocale, tApiError, useT } from '../i18n'

export type RecoveryItemDrawerData = {
  id: string
  deadLetterId: string
  owner: string | null
  severity: RecoveryItemSeverity
  status: RecoveryItemStatus
  slaTargetAtIso: string
  resolutionReason: RecoveryItemResolutionReason | null
  comments: Array<{ id: string; authorUserId: string; body: string; createdAt: string }>
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
