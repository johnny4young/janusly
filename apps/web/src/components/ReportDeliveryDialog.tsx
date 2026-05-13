/**
 * Report Delivery dialog — routes the existing run-explain report
 * through the integration-tool chokepoint (`slack.post` /
 * `github.create_issue` / `webhook.send`) to land in the right team
 * surface. Reuses the same Markdown / JSON the GET /reports/run-explain
 * route renders; no new vendor SDK, no new credential kind.
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
 * Used by `RightPanel.tsx` (Send-to button next to the run-history
 * Export button).
 */

import React, { useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, ExternalLink, Send, X } from 'lucide-react'
import { api } from '../api'
import { useWorkflowStore } from '../store'

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

export function ReportDeliveryDialog({
  sourceRun,
  onClose,
}: {
  sourceRun: SourceRun
  onClose: () => void
}) {
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

  // Per-kind valid form. The route's superRefine enforces the same set,
  // but the dialog disables submit so the operator gets the feedback
  // before a round-trip.
  const formValid = (() => {
    if (!credentialName.trim()) return false
    if (destination === 'github') return owner.trim().length > 0 && repo.trim().length > 0
    if (destination === 'webhook') return webhookUrl.trim().length > 0
    return true
  })()

  const submit = async () => {
    if (!formValid) return
    setStep({ kind: 'submitting' })
    try {
      const body: Record<string, unknown> = {
        runId: sourceRun.id,
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

      const result = await api('/reports/run-explain/deliver', {
        method: 'POST',
        body: JSON.stringify(body),
      }) as DeliveryEnvelope

      if (!aliveRef.current) return

      if (result.ok) {
        setStep({ kind: 'succeeded', deliveryId: result.deliveryId, statusCode: result.statusCode })
        addToast(`Run explain report sent to ${destination}`, 'success')
        // The audit-log panel can refresh against the new
        // `report.run_explain.delivered` row.
        bumpPlatformVersion()
      } else {
        const message = result.error ?? 'Delivery failed'
        setStep({ kind: 'failed', message })
      }
    } catch (err) {
      if (!aliveRef.current) return
      setStep({
        kind: 'failed',
        message: err instanceof Error ? err.message : 'Delivery failed',
      })
    }
  }

  return (
    <div className="run-input-backdrop" onClick={onBackdrop}>
      <div
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
            <div className="section-kicker">Send report</div>
            <h2 id="report-delivery-title">Send run report</h2>
            <p className="helper-text">
              Send the same run summary that Export creates to Slack, GitHub,
              or a signed webhook using a stored credential.
            </p>
          </div>
          <button
            type="button"
            className="run-input-dialog__close"
            onClick={onBackdrop}
            aria-label="Close report delivery"
            disabled={step.kind === 'submitting'}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="run-input-dialog__body">
          <section className="we-replay-lab-source">
            <div className="section-kicker">Source run</div>
            <dl className="we-replay-lab-source-grid">
              <div>
                <dt>Run id</dt>
                <dd className="we-replay-lab-id">{sourceRun.id}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{sourceRun.status}</dd>
              </div>
              {sourceRun.workflowName && (
                <div>
                  <dt>Workflow</dt>
                  <dd>{sourceRun.workflowName}</dd>
                </div>
              )}
            </dl>
          </section>

          {step.kind !== 'succeeded' && (
            <section className="we-report-delivery-form">
              <div className="section-kicker">Destination</div>
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
                  <span>Slack</span>
                  <small>Posts a header + summary to a stored Incoming Webhook URL.</small>
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
                  <span>GitHub issue</span>
                  <small>Creates a new issue with the full Markdown report as the body.</small>
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
                  <span>Signed webhook</span>
                  <small>POSTs the JSON envelope with an HMAC-SHA256 signature header.</small>
                </label>
              </fieldset>

              <div className="we-report-delivery-fields">
                <label className="we-field">
                  <span>Credential name</span>
                  <input
                    type="text"
                    value={credentialName}
                    onChange={(event) => setCredentialName(event.target.value)}
                    placeholder={destination === 'slack' ? 'ops-channel' : destination === 'github' ? 'bot-github' : 'partner-webhook'}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={step.kind === 'submitting'}
                    data-testid="report-delivery-credential"
                  />
                  <small>The stored credential name (not an env-var). Configure under Credentials.</small>
                </label>

                {destination === 'github' && (
                  <>
                    <label className="we-field">
                      <span>Owner</span>
                      <input
                        type="text"
                        value={owner}
                        onChange={(event) => setOwner(event.target.value)}
                        placeholder="janusly"
                        autoComplete="off"
                        disabled={step.kind === 'submitting'}
                        data-testid="report-delivery-owner"
                      />
                    </label>
                    <label className="we-field">
                      <span>Repo</span>
                      <input
                        type="text"
                        value={repo}
                        onChange={(event) => setRepo(event.target.value)}
                        placeholder="demo"
                        autoComplete="off"
                        disabled={step.kind === 'submitting'}
                        data-testid="report-delivery-repo"
                      />
                    </label>
                    <label className="we-field">
                      <span>Labels (comma-separated, optional)</span>
                      <input
                        type="text"
                        value={labels}
                        onChange={(event) => setLabels(event.target.value)}
                        placeholder="incident, run-explain"
                        autoComplete="off"
                        disabled={step.kind === 'submitting'}
                        data-testid="report-delivery-labels"
                      />
                    </label>
                  </>
                )}

                {destination === 'webhook' && (
                  <label className="we-field">
                    <span>URL</span>
                    <input
                      type="url"
                      value={webhookUrl}
                      onChange={(event) => setWebhookUrl(event.target.value)}
                      placeholder="https://partner.example.com/hooks/janusly"
                      autoComplete="off"
                      disabled={step.kind === 'submitting'}
                      data-testid="report-delivery-url"
                    />
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
                <div>Report delivered to {destination}.</div>
              </div>
              {step.deliveryId && /^https?:\/\//i.test(step.deliveryId) ? (
                <a
                  href={step.deliveryId}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="small-command"
                  data-testid="report-delivery-result-link"
                >
                  <ExternalLink size={12} aria-hidden="true" /> View destination
                </a>
              ) : null}
              {step.statusCode != null && (
                <p className="helper-text">Upstream responded {step.statusCode}.</p>
              )}
            </section>
          )}
        </div>

        <footer className="run-input-dialog__footer">
          {step.kind === 'idle' && (
            <>
              <button type="button" className="command-button" onClick={onClose}>
                Cancel
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
                Send report
              </button>
            </>
          )}
          {step.kind === 'submitting' && (
            <button type="button" className="command-button command-button-primary" disabled>
              Sending…
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
              Close
            </button>
          )}
          {step.kind === 'failed' && (
            <>
              <button type="button" className="command-button" onClick={onClose}>
                Close
              </button>
              <button
                ref={primaryRef}
                type="button"
                className="command-button command-button-primary"
                onClick={() => setStep({ kind: 'idle' })}
                data-testid="report-delivery-retry"
              >
                Retry
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  )
}
