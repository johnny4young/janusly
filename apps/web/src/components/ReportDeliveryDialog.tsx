/**
 * Report Delivery dialog — routes a server-rendered report through the
 * integration-tool chokepoint (`slack.post` / `github.create_issue` /
 * `webhook.send`) to land in the right team surface. Surface-agnostic: the
 * `endpoint` + `copyKeys` props point it at either `/reports/run-explain/deliver`
 * (default, run-explain report) or `/recovery/items/:id/evidence/deliver`
 * (recovery-incident evidence). No new vendor SDK, no new credential kind.
 *
 * State machine:
 *
 *   1. **Idle** — destination radio + credential-name field + per-kind
 *      args; submit CTA enabled when the form is valid.
 *   2. **Submitting** — `POST /reports/run-explain/deliver` in flight.
 *   3. **Succeeded** — success message + (when present) a link to the
 *      delivered surface (GitHub issue URL).
 *   4. **Failed** — error message, return to idle to retry.
 *
 * Backdrop / ESC / close-button are gated while submitting so the
 * operator can't accidentally double-fire the delivery.
 *
 * Used by `RightPanel.tsx` (Send-to button next to the run-history Export
 * button) and `RecoveryItemDrawer.tsx` (Deliver button in the evidence section).
 */

import { useEffect, useRef, useState } from 'react'
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap'
import { AlertCircle, CheckCircle2, ExternalLink, Send, X } from 'lucide-react'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { useT } from '../i18n'
import { isLikelyHttpUrl } from '../url'
import { formatStatusLabel } from '../constants'

type SourceRun = {
  id: string
  status: string
  workflowName?: string | null
}

type DestinationKind = 'slack' | 'github' | 'webhook'

type Step =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'succeeded'; deliveryId?: string; statusCode?: number }
  | { kind: 'failed'; message: string }

type DeliveryEnvelope = {
  ok?: boolean
  destination?: string
  statusCode?: number
  error?: string
  latencyMs?: number
  deliveryId?: string
}

/** The i18n keys whose copy varies per delivery surface (run-explain vs
 *  recovery-evidence). Everything else (field labels, destination helpers,
 *  buttons) is shared `reportDelivery.*` copy. */
type DeliveryCopyKeys = {
  kicker: string
  title: string
  description: string
  toastSent: string
  successMessage: string
}

const RUN_EXPLAIN_COPY: DeliveryCopyKeys = {
  kicker: 'reportDelivery.kicker',
  title: 'reportDelivery.title',
  description: 'reportDelivery.description',
  toastSent: 'reportDelivery.toastSent',
  successMessage: 'reportDelivery.successMessage',
}

export function ReportDeliveryDialog({
  sourceRun,
  endpoint = '/reports/run-explain/deliver',
  copyKeys = RUN_EXPLAIN_COPY,
  onClose,
}: {
  /** When present, the source-run summary section renders AND the request body
   *  carries `{ runId: sourceRun.id }`. Omitted for the evidence variant (the
   *  recovery item id is in the endpoint path; the drawer shows the context). */
  sourceRun?: SourceRun
  /** The deliver endpoint. Defaults to run-explain; the evidence caller passes
   *  `/recovery/items/:id/evidence/deliver`. */
  endpoint?: string
  /** Per-surface copy overrides (defaults to the run-explain keys). */
  copyKeys?: DeliveryCopyKeys
  onClose: () => void
}) {
  const { t } = useT()
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion)
  const addToast = useWorkflowStore((state) => state.addToast)
  const [step, setStep] = useState<Step>({ kind: 'idle' })
  const [destination, setDestination] = useState<DestinationKind>('slack')
  const [credentialName, setCredentialName] = useState('')
  const [owner, setOwner] = useState('')
  const [repo, setRepo] = useState('')
  const [labels, setLabels] = useState('')
  const [webhookUrl, setWebhookUrl] = useState('')
  const aliveRef = useRef(true)
  const primaryRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  useDialogFocusTrap(dialogRef)

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  useEffect(() => { primaryRef.current?.focus() }, [step.kind])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      if (step.kind === 'submitting') return
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [step.kind, onClose])

  const onBackdrop = () => {
    if (step.kind === 'submitting') return
    onClose()
  }

  // Flag a malformed webhook URL inline (must be an absolute http(s) URL) so the
  // operator sees the problem before the disabled submit leaves them guessing.
  const webhookTrimmed = webhookUrl.trim()
  const webhookInvalid = destination === 'webhook' && webhookTrimmed.length > 0 && !isLikelyHttpUrl(webhookTrimmed)

  // Per-kind valid form. The route's superRefine enforces the same set,
  // but the dialog disables submit so the operator gets the feedback
  // before a round-trip.
  const formValid = (() => {
    if (!credentialName.trim()) return false
    if (destination === 'github') return owner.trim().length > 0 && repo.trim().length > 0
    if (destination === 'webhook') return webhookTrimmed.length > 0 && isLikelyHttpUrl(webhookTrimmed)
    return true
  })()

  const submit = async () => {
    if (!formValid) return
    setStep({ kind: 'submitting' })
    try {
      const body: Record<string, unknown> = {
        ...(sourceRun ? { runId: sourceRun.id } : {}),
        destination: {
          kind: destination,
          credentialName: credentialName.trim(),
        },
      }
      if (destination === 'github') {
        ;(body.destination as Record<string, unknown>).owner = owner.trim()
        ;(body.destination as Record<string, unknown>).repo = repo.trim()
        const parsedLabels = labels
          .split(',')
          .map((label) => label.trim())
          .filter(Boolean)
        if (parsedLabels.length > 0) {
          ;(body.destination as Record<string, unknown>).labels = parsedLabels
        }
      }
      if (destination === 'webhook') {
        ;(body.destination as Record<string, unknown>).url = webhookUrl.trim()
      }

      const result = await api(endpoint, {
        method: 'POST',
        body: JSON.stringify(body),
      }) as DeliveryEnvelope

      if (!aliveRef.current) return

      if (result.ok) {
        setStep({ kind: 'succeeded', deliveryId: result.deliveryId, statusCode: result.statusCode })
        addToast(t(copyKeys.toastSent, { destination }), 'success')
        // The audit-log panel can refresh against the new
        // `report.run_explain.delivered` row.
        bumpPlatformVersion()
      } else {
        const message = result.error ?? (t('reportDelivery.errorDefault') as string)
        setStep({ kind: 'failed', message })
      }
    } catch (err) {
      if (!aliveRef.current) return
      setStep({
        kind: 'failed',
        message: err instanceof Error ? err.message : (t('reportDelivery.errorDefault') as string),
      })
    }
  }

  return (
    <div className="run-input-backdrop" onClick={onBackdrop}>
      <div
        ref={dialogRef}
        className="run-input-dialog we-report-delivery-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-delivery-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="run-input-dialog__header">
          <span className="run-input-dialog__icon" aria-hidden="true">
            <Send size={18} />
          </span>
          <div className="run-input-dialog__heading">
            <div className="section-kicker">{t(copyKeys.kicker)}</div>
            <h2 id="report-delivery-title">{t(copyKeys.title)}</h2>
            <p className="helper-text">{t(copyKeys.description)}</p>
          </div>
          <button
            type="button"
            className="run-input-dialog__close"
            onClick={onBackdrop}
            aria-label={t('reportDelivery.close') as string}
            disabled={step.kind === 'submitting'}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="run-input-dialog__body" aria-live="polite">
          {sourceRun && (
            <section className="we-replay-lab-source">
              <div className="section-kicker">{t('reportDelivery.sourceRun')}</div>
              <dl className="we-replay-lab-source-grid">
                <div>
                  <dt>{t('reportDelivery.runId')}</dt>
                  <dd className="we-replay-lab-id">{sourceRun.id}</dd>
                </div>
                <div>
                  <dt>{t('reportDelivery.status')}</dt>
                  <dd>{formatStatusLabel(sourceRun.status)}</dd>
                </div>
                {sourceRun.workflowName && (
                  <div>
                    <dt>{t('reportDelivery.workflow')}</dt>
                    <dd>{sourceRun.workflowName}</dd>
                  </div>
                )}
              </dl>
            </section>
          )}

          {step.kind !== 'succeeded' && (
            <section className="we-report-delivery-form">
              <div className="section-kicker">{t('reportDelivery.destination')}</div>
              <fieldset
                className="we-report-delivery-options"
                disabled={step.kind === 'submitting'}
              >
                <label className={`we-report-delivery-option ${destination === 'slack' ? 'is-active' : ''}`}>
                  <input
                    type="radio"
                    name="report-delivery-destination"
                    value="slack"
                    checked={destination === 'slack'}
                    onChange={() => setDestination('slack')}
                    data-testid="report-delivery-destination-slack"
                  />
                  <span>{t('reportDelivery.dest.slack')}</span>
                  <small>{t('reportDelivery.dest.slackHelper')}</small>
                </label>
                <label className={`we-report-delivery-option ${destination === 'github' ? 'is-active' : ''}`}>
                  <input
                    type="radio"
                    name="report-delivery-destination"
                    value="github"
                    checked={destination === 'github'}
                    onChange={() => setDestination('github')}
                    data-testid="report-delivery-destination-github"
                  />
                  <span>{t('reportDelivery.dest.github')}</span>
                  <small>{t('reportDelivery.dest.githubHelper')}</small>
                </label>
                <label className={`we-report-delivery-option ${destination === 'webhook' ? 'is-active' : ''}`}>
                  <input
                    type="radio"
                    name="report-delivery-destination"
                    value="webhook"
                    checked={destination === 'webhook'}
                    onChange={() => setDestination('webhook')}
                    data-testid="report-delivery-destination-webhook"
                  />
                  <span>{t('reportDelivery.dest.webhook')}</span>
                  <small>{t('reportDelivery.dest.webhookHelper')}</small>
                </label>
              </fieldset>

              <div className="we-report-delivery-fields">
                <label className="we-field">
                  <span>{t('reportDelivery.field.credential')}</span>
                  <input
                    type="text"
                    value={credentialName}
                    onChange={(event) => setCredentialName(event.target.value)}
                    placeholder={(destination === 'slack'
                      ? t('reportDelivery.placeholder.slack')
                      : destination === 'github'
                        ? t('reportDelivery.placeholder.github')
                        : t('reportDelivery.placeholder.webhook')) as string}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={step.kind === 'submitting'}
                    data-testid="report-delivery-credential"
                  />
                  <small>{t('reportDelivery.field.credentialHint')}</small>
                </label>

                {destination === 'github' && (
                  <>
                    <label className="we-field">
                      <span>{t('reportDelivery.field.owner')}</span>
                      <input
                        type="text"
                        value={owner}
                        onChange={(event) => setOwner(event.target.value)}
                        placeholder={t('reportDelivery.field.ownerPlaceholder') as string}
                        autoComplete="off"
                        disabled={step.kind === 'submitting'}
                        data-testid="report-delivery-owner"
                      />
                    </label>
                    <label className="we-field">
                      <span>{t('reportDelivery.field.repo')}</span>
                      <input
                        type="text"
                        value={repo}
                        onChange={(event) => setRepo(event.target.value)}
                        placeholder={t('reportDelivery.field.repoPlaceholder') as string}
                        autoComplete="off"
                        disabled={step.kind === 'submitting'}
                        data-testid="report-delivery-repo"
                      />
                    </label>
                    <label className="we-field">
                      <span>{t('reportDelivery.field.labels')}</span>
                      <input
                        type="text"
                        value={labels}
                        onChange={(event) => setLabels(event.target.value)}
                        placeholder={t('reportDelivery.field.labelsPlaceholder') as string}
                        autoComplete="off"
                        disabled={step.kind === 'submitting'}
                        data-testid="report-delivery-labels"
                      />
                    </label>
                  </>
                )}

                {destination === 'webhook' && (
                  <label className="we-field">
                    <span>{t('reportDelivery.field.url')}</span>
                    <input
                      type="url"
                      value={webhookUrl}
                      onChange={(event) => setWebhookUrl(event.target.value)}
                      placeholder={t('reportDelivery.field.urlPlaceholder') as string}
                      autoComplete="off"
                      disabled={step.kind === 'submitting'}
                      aria-invalid={webhookInvalid}
                      aria-describedby={webhookInvalid ? 'report-delivery-url-error' : undefined}
                      data-testid="report-delivery-url"
                    />
                    {webhookInvalid && (
                      <span id="report-delivery-url-error" className="helper-text helper-text--error" role="alert">
                        <AlertCircle size={13} aria-hidden="true" /> {t('reportDelivery.field.urlInvalid')}
                      </span>
                    )}
                  </label>
                )}
              </div>
            </section>
          )}

          {step.kind === 'failed' && (
            <div className="run-input-form-error" role="alert">
              <AlertCircle size={14} aria-hidden="true" />
              <div>{step.message}</div>
            </div>
          )}

          {step.kind === 'succeeded' && (
            <section className="we-report-delivery-result" aria-live="polite">
              <div className="run-input-form-success" role="status">
                <CheckCircle2 size={14} aria-hidden="true" />
                <div>{t(copyKeys.successMessage, { destination })}</div>
              </div>
              {step.deliveryId && /^https?:\/\//i.test(step.deliveryId) ? (
                <a
                  href={step.deliveryId}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="small-command"
                  data-testid="report-delivery-result-link"
                >
                  <ExternalLink size={12} aria-hidden="true" /> {t('reportDelivery.viewDestination')}
                </a>
              ) : null}
              {step.statusCode != null && (
                <p className="helper-text">{t('reportDelivery.upstreamStatus', { code: step.statusCode })}</p>
              )}
            </section>
          )}
        </div>

        <footer className="run-input-dialog__footer">
          {step.kind === 'idle' && (
            <>
              <button type="button" className="command-button" onClick={onClose}>
                {t('reportDelivery.cancel')}
              </button>
              <button
                ref={primaryRef}
                type="button"
                className="command-button command-button-primary"
                onClick={submit}
                disabled={!formValid}
                data-testid="report-delivery-submit"
              >
                <Send size={14} aria-hidden="true" />
                {t('reportDelivery.send')}
              </button>
            </>
          )}
          {step.kind === 'submitting' && (
            <button type="button" className="command-button command-button-primary" disabled>
              {t('reportDelivery.sending')}
            </button>
          )}
          {step.kind === 'succeeded' && (
            <button
              ref={primaryRef}
              type="button"
              className="command-button command-button-primary"
              onClick={onClose}
              data-testid="report-delivery-close-done"
            >
              {t('reportDelivery.closeButton')}
            </button>
          )}
          {step.kind === 'failed' && (
            <>
              <button type="button" className="command-button" onClick={onClose}>
                {t('reportDelivery.closeButton')}
              </button>
              <button
                ref={primaryRef}
                type="button"
                className="command-button command-button-primary"
                onClick={() => setStep({ kind: 'idle' })}
                data-testid="report-delivery-retry"
              >
                {t('reportDelivery.retry')}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  )
}
