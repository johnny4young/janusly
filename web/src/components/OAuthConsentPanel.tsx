/**
 * Consent for an MCP client that asked to connect with OAuth. The client's
 * name is whatever it registered, so it is shown as unverified next to the
 * address the code goes to; only capabilities this person can grant are offered.
 */
import { useEffect, useState } from 'react'
import { useAliveRef } from '../hooks/useAliveRef'
import { useT } from '../i18n'
import { decideOAuthConsent, getOAuthConsentRequest, pendingOAuthRequestId, type OAuthConsentRequest } from '../lib/oauth-consent'
import { Button } from './ui/Button'
import './OAuthConsentPanel.css'

/** Reads the request id from the URL; renders nothing when it is not a well-formed one. */
export default function OAuthConsentPanel(props: { navigate?: (url: string) => void }) {
  const requestId = pendingOAuthRequestId()
  return requestId ? <Consent requestId={requestId} {...props} /> : null
}

function Consent({ requestId, navigate = url => window.location.assign(url) }: {
  requestId: string
  navigate?: (url: string) => void
}) {
  const { t } = useT()
  const alive = useAliveRef()
  const [request, setRequest] = useState<OAuthConsentRequest | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'gone' | 'failed'>('loading')
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set())
  const [days, setDays] = useState(30)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    getOAuthConsentRequest(requestId).then((loaded) => {
      if (!alive.current) return
      setRequest(loaded)
      // Only read starts ticked: everything else is a choice the person makes.
      setChosen(new Set(loaded.capabilities.filter(item => item.grantable && item.capability === 'read').map(item => item.capability)))
      setDays(loaded.defaultExpiresInDays)
      setState('ready')
    }, () => { if (alive.current) setState('gone') })
  }, [alive, requestId])

  const decide = async (approve: boolean) => {
    setBusy(true)
    try {
      navigate(await decideOAuthConsent(requestId, approve ? { approve, capabilities: [...chosen], expiresInDays: days } : { approve }))
    } catch {
      if (alive.current) { setState('failed'); setBusy(false) }
    }
  }

  if (state === 'loading') return <p className="helper-text">{t('common.loading')}</p>
  if (state === 'gone' || !request) {
    return <p className="we-card" role="alert" data-testid="oauth-consent-gone">{t('oauthConsent.gone')}</p>
  }
  return (
    <section className="we-card oauth-consent" aria-labelledby="oauth-consent-title" data-testid="oauth-consent">
      <h3 id="oauth-consent-title">
        {t('oauthConsent.title')}
      </h3>
      <dl>
        <dt>{t('oauthConsent.name')}</dt>
        <dd>{request.clientName} <span className="we-pill" data-tone="warning">{t('oauthConsent.unverified')}</span></dd>
        <dt>{t('oauthConsent.sendsTo')}</dt>
        <dd>
          <code>{request.redirectHost}</code>{' '}
          {request.redirectIsLocal
            ? t('oauthConsent.thisComputer')
            : <span className="we-pill" data-tone="warning">{t('oauthConsent.leavesComputer')}</span>}
        </dd>
        <dt>{t('oauthConsent.organization')}</dt>
        <dd><code>{request.organizationId}</code></dd>
      </dl>
      <fieldset disabled={busy}>
        <legend>{t('oauthConsent.capabilities')}</legend>
        {request.capabilities.map(item => (
          <label key={item.capability}>
            <input type="checkbox" checked={chosen.has(item.capability)}
              disabled={!item.grantable || item.capability === 'read'}
              onChange={(event) => setChosen((current) => {
                const next = new Set(current)
                if (event.target.checked) next.add(item.capability)
                else next.delete(item.capability)
                return next
              })} />
            <span>
              {t(`oauthConsent.capability.${item.capability}`)}
              {!item.grantable && <small> {t('oauthConsent.missing', { permissions: item.missingPermissions.join(', ') })}</small>}
            </span>
          </label>
        ))}
        <label className="oauth-consent__days">
          <span>{t('oauthConsent.expires')}</span>
          <input type="number" min={1} max={request.maxExpiresInDays} value={days}
            onChange={event => setDays(Math.min(request.maxExpiresInDays, Math.max(1, Number(event.target.value) || 1)))} />
        </label>
      </fieldset>
      {state === 'failed' && <p role="alert" className="helper-text">{t('oauthConsent.failed')}</p>}
      <div className="oauth-consent__actions">
        <Button variant="primary" loading={busy} onClick={() => void decide(true)}>{t('oauthConsent.connect')}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => void decide(false)}>{t('rightPanel.runs.toolApproval.deny')}</Button>
      </div>
    </section>
  )
}
