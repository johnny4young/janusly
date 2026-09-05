import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Send } from 'lucide-react'
import { RECOVERY_HANDOFF_DESTINATIONS, type RecoveryHandoffDestination } from '@/lib/recovery-handoff'
import { api } from '../../api'
import { useWorkflowStore } from '../../store'
import { getResolvedLocale, tApiError, useT } from '../../i18n'
import { Button } from '../ui/Button'

type Props = {
  itemId: string
  /** The drawer disables every action while any transition is in flight. */
  disabled: boolean
  onBusyChange: (busy: 'handoff' | null) => void
}

// Hand the incident to Slack, GitHub, a webhook or Linear, and show the
// deliveries already made.
export function RecoveryHandoffSection({ itemId, disabled, onBusyChange }: Props) {
  const { t } = useT()
  const bumpPlatformVersion = useWorkflowStore((s) => s.bumpPlatformVersion)
  const addToast = useWorkflowStore((s) => s.addToast)
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
      api(`/recovery/items/${itemId}`).catch(() => ({ item: null, handoffs: [] })),
    ]).then(([credResp, itemResp]: [unknown, unknown]) => {
      if (cancelled) return
      setCredentials((credResp as Array<{ id: string; name: string; kind: string }>) ?? [])
      const detail = itemResp as { handoffs?: typeof existingHandoffs }
      setExistingHandoffs(detail?.handoffs ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [itemId])

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
    onBusyChange('handoff')
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
      const resp = (await api(`/recovery/items/${itemId}/handoff`, {
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
        addToast(t('recoveryHandoff.toast.skipped'), 'info')
      } else if (resp.alreadyDispatched) {
        addToast(t('recoveryHandoff.toast.alreadyDispatched'), 'info')
      } else if (resp.ok) {
        addToast(t('recoveryHandoff.toast.delivered'), 'success')
      } else {
        addToast(t('recoveryHandoff.toast.failed'), 'error')
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
      addToast(tApiError(err) || (t('recoveryHandoff.toast.failed')), 'error')
    } finally {
      onBusyChange(null)
    }
  }

  return (
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
          <Button variant="ghost" size="sm"
            type="button"

            onClick={() => setHandoffOpen(true)}
            data-testid="ri-handoff-open"
          >
            <Send size={14} aria-hidden /> {t('recoveryHandoff.action.open')}
          </Button>
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
                  placeholder={t('recoveryHandoff.form.urlPlaceholder')}
                  maxLength={2048}
                />
              </label>
            )}
            <div className="we-recovery-item-drawer__handoff-actions">
              <Button variant="primary" size="sm"
                type="button"

                onClick={submitHandoff}
                disabled={disabled || !canSubmitHandoff}
                data-testid="ri-handoff-submit"
              >
                {t('recoveryHandoff.action.submit')}
              </Button>
              <Button variant="ghost" size="sm"
                type="button"

                onClick={() => setHandoffOpen(false)}
              >
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        )}
      </div>
  )
}
