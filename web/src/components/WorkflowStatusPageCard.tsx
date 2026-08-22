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

type StatusPageState =
  | { phase: 'hidden' }
  | { phase: 'disabled' }
  | { phase: 'enabled'; path: string }

function parseStatusPage(payload: unknown): StatusPageState {
  if (!payload || typeof payload !== 'object') return { phase: 'hidden' }
  const body = payload as { enabled?: unknown; path?: unknown }
  if (body.enabled === true && typeof body.path === 'string') {
    return { phase: 'enabled', path: body.path }
  }
  if (body.enabled === false) return { phase: 'disabled' }
  return { phase: 'hidden' }
}

export function WorkflowStatusPageCard() {
  const { t } = useT()
  const addToast = useWorkflowStore((s) => s.addToast)
  const workflowId = useWorkflowStore((s) => s.currentWorkflowId)
  const workflowSaved = useWorkflowStore((s) => s.currentWorkflowSaved)
  const [state, setState] = useState<StatusPageState>({ phase: 'hidden' })
  const [busy, setBusy] = useState(false)
  const targetId = workflowSaved ? workflowId : null

  useEffect(() => {
    if (!targetId) {
      setState({ phase: 'hidden' })
      return
    }
    let cancelled = false
    api(`/workflows/${encodeURIComponent(targetId)}/status-page`)
      .then((payload) => {
        if (!cancelled) setState(parseStatusPage(payload))
      })
      .catch(() => {
        // 403 (not an admin) or transient failure: no surface at all.
        if (!cancelled) setState({ phase: 'hidden' })
      })
    return () => {
      cancelled = true
    }
  }, [targetId])

  if (!targetId || state.phase === 'hidden') return null

  const mutate = async (method: 'POST' | 'DELETE') => {
    if (busy) return
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

  const publicUrl = state.phase === 'enabled' ? new URL(state.path, window.location.origin).toString() : ''

  return (
    <section className="we-card we-status-page-card" data-testid="workflow-status-page-card">
      <header className="we-status-page-card__header">
        <Globe size={14} aria-hidden="true" />
        <strong>{t('workflowStatusPage.title')}</strong>
      </header>
      <p className="we-status-page-card__hint">{t('workflowStatusPage.hint')}</p>
      {state.phase === 'enabled' ? (
        <>
          <div className="we-status-page-card__url">
            <code>{publicUrl}</code>
            <button
              type="button"
              className="small-command"
              disabled={busy}
              onClick={() => {
                void navigator.clipboard?.writeText(publicUrl)
                addToast(t('workflowStatusPage.toast.copied'), 'success')
              }}
            >
              <Copy size={13} />
              <span>{t('workflowStatusPage.copy')}</span>
            </button>
          </div>
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
      ) : (
        <button type="button" className="small-command" disabled={busy} onClick={() => void mutate('POST')}>
          <Globe size={13} />
          <span>{t('workflowStatusPage.enable')}</span>
        </button>
      )}
    </section>
  )
}
