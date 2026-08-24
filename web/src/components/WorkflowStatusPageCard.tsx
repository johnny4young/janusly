/**
 * Admin control for the per-workflow public status page.
 *
 * Rendered under the "About" section of the workflow tools. The initial
 * GET is the role probe: non-admins get a 403 and the card renders
 * nothing, so the surface only exists for operators who can act on it.
 * Enabling mints an unguessable 256-bit token; rotating replaces it
 * (old links die immediately); disabling revokes the page.
 */

import { useEffect, useState } from 'react'
import { Copy, Globe, RefreshCw, Trash2 } from 'lucide-react'
import { api } from '../api'
import { useT } from '../i18n'
import { useWorkflowStore } from '../store'
import { useConfirm } from './ConfirmDialog'

type StatusPageState =
  | { phase: 'hidden' }
  | { phase: 'disabled' }
  | { phase: 'enabled'; path?: string }
  | { phase: 'error' }

function parseStatusPage(payload: unknown): StatusPageState {
  if (!payload || typeof payload !== 'object') return { phase: 'hidden' }
  const body = payload as { enabled?: unknown; path?: unknown }
  if (body.enabled === true) {
    return typeof body.path === 'string'
      ? { phase: 'enabled', path: body.path }
      : { phase: 'enabled' }
  }
  if (body.enabled === false) return { phase: 'disabled' }
  return { phase: 'hidden' }
}

export function WorkflowStatusPageCard() {
  const { t } = useT()
  const addToast = useWorkflowStore((s) => s.addToast)
  const confirm = useConfirm()
  const workflowId = useWorkflowStore((s) => s.currentWorkflowId)
  const workflowSaved = useWorkflowStore((s) => s.currentWorkflowSaved)
  const [state, setState] = useState<StatusPageState>({ phase: 'hidden' })
  const [busy, setBusy] = useState(false)
  const targetId = workflowSaved ? workflowId : null

  const load = () => {
    if (!targetId) {
      setState({ phase: 'hidden' })
      return () => undefined
    }
    let cancelled = false
    api(`/workflows/${encodeURIComponent(targetId)}/status-page`)
      .then((payload) => {
        if (!cancelled) setState(parseStatusPage(payload))
      })
      .catch((error: unknown) => {
        if (cancelled) return
        // A 403 is the role probe. Operational failures remain visible so an
        // admin does not mistake an unavailable control for a missing feature.
        const statusCode = error && typeof error === 'object' && 'statusCode' in error
          ? (error as { statusCode?: unknown }).statusCode
          : undefined
        setState(statusCode === 403
          ? { phase: 'hidden' }
          : { phase: 'error' })
      })
    return () => {
      cancelled = true
    }
  }

  useEffect(() => {
    return load()
    // targetId is the complete ownership key; load is intentionally local so
    // retries can call it without expanding the effect dependency surface.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId])

  if (!targetId || state.phase === 'hidden') return null

  const mutate = async (method: 'POST' | 'DELETE') => {
    if (busy) return
    if (state.phase === 'enabled') {
      const accepted = await confirm({
        body: method === 'DELETE'
          ? t('workflowStatusPage.confirm.disable')
          : t('workflowStatusPage.confirm.rotate'),
        confirmLabel: method === 'DELETE'
          ? t('workflowStatusPage.disable')
          : t('workflowStatusPage.rotate'),
        tone: method === 'DELETE' ? 'danger' : 'default',
      })
      if (!accepted) return
    }
    setBusy(true)
    try {
      const payload = await api(`/workflows/${encodeURIComponent(targetId)}/status-page`, { method })
      setState(parseStatusPage(payload))
      addToast(
        method === 'DELETE'
          ? t('workflowStatusPage.toast.disabled')
          : t('workflowStatusPage.toast.enabled'),
        'success',
      )
    } catch {
      addToast(t('workflowStatusPage.toast.failed'), 'error')
    } finally {
      setBusy(false)
    }
  }

  const publicUrl = state.phase === 'enabled' && state.path
    ? new URL(state.path, window.location.origin).toString()
    : ''

  return (
    <section className="we-card we-status-page-card" data-testid="workflow-status-page-card">
      <header className="we-status-page-card__header">
        <Globe size={14} aria-hidden="true" />
        <strong>{t('workflowStatusPage.title')}</strong>
      </header>
      <p className="we-status-page-card__hint">{t('workflowStatusPage.hint')}</p>
      {state.phase === 'error' && (
        <button type="button" className="small-command" disabled={busy} onClick={() => { load() }}>
          <RefreshCw size={13} />
          <span>{t('workflowStatusPage.retry')}</span>
        </button>
      )}
      {state.phase === 'enabled' ? (
        <>
          {publicUrl ? (
            <div className="we-status-page-card__url">
              <code>{publicUrl}</code>
              <button
                type="button"
                className="small-command"
                disabled={busy}
                onClick={() => {
                  const copy = navigator.clipboard?.writeText(publicUrl)
                  if (!copy) {
                    addToast(t('workflowStatusPage.toast.copyFailed'), 'error')
                    return
                  }
                  void copy
                    .then(() => addToast(t('workflowStatusPage.toast.copied'), 'success'))
                    .catch(() => addToast(t('workflowStatusPage.toast.copyFailed'), 'error'))
                }}
              >
                <Copy size={13} />
                <span>{t('workflowStatusPage.copy')}</span>
              </button>
            </div>
          ) : (
            <p className="helper-text">{t('workflowStatusPage.linkProtected')}</p>
          )}
          <div className="we-status-page-card__actions">
            <button type="button" className="small-command" disabled={busy} onClick={() => void mutate('POST')}>
              <RefreshCw size={13} />
              <span>{t('workflowStatusPage.rotate')}</span>
            </button>
            <button type="button" className="small-command" disabled={busy} onClick={() => void mutate('DELETE')}>
              <Trash2 size={13} />
              <span>{t('workflowStatusPage.disable')}</span>
            </button>
          </div>
        </>
      ) : state.phase === 'disabled' ? (
        <button type="button" className="small-command" disabled={busy} onClick={() => void mutate('POST')}>
          <Globe size={13} />
          <span>{t('workflowStatusPage.enable')}</span>
        </button>
      ) : null}
    </section>
  )
}
