import { useEffect, useId, useRef, useState } from 'react'
import { Bot, Check, CheckCircle2, CircleX, Copy, KeyRound, X } from 'lucide-react'

import { contractApi, publicApiUrl } from '../api'
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap'
import { tApiError, useT } from '../i18n'
import type { ApiResponse } from '../lib/api-types.generated'
import { isGetAgentClientsIdResponse } from '../lib/api-guards/operations/GetAgentClientsId'
import { isPostAgentClientsResponse } from '../lib/api-guards/operations/PostAgentClients'
import { readSavedWorkflowPage } from '../lib/list-contract'
import type { SavedWorkflow } from '../types'
import { formatWhen } from './agent-actors'
import { LoadingSkeleton } from './LoadingSkeleton'
import { Button } from './ui/Button'
import { FormField, TextInput } from './ui/Form'

type AgentClientList = ApiResponse<'GET /agent-clients'>
type AgentCapability = AgentClientList['clients'][number]['capabilities'][number]
type IssuedAgentClient = ApiResponse<'POST /agent-clients'>
type Detail = ApiResponse<'GET /agent-clients/{id}'>

function parseTags(value: string): string[] {
  return [...new Set(value.split(',').map((tag) => tag.trim()).filter(Boolean))]
}

export function CreateAgentClientDialog({
  catalog,
  onClose,
  onCreated,
}: {
  catalog: Pick<AgentClientList, 'capabilities' | 'limits'>
  onClose: () => void
  onCreated: (issued: IssuedAgentClient) => void
}) {
  const { t } = useT()
  const formId = useId()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const nameRef = useRef<HTMLInputElement | null>(null)
  const [name, setName] = useState('')
  const [capabilities, setCapabilities] = useState<ReadonlySet<AgentCapability>>(() => new Set(['read']))
  const [workflowIds, setWorkflowIds] = useState<ReadonlySet<string>>(() => new Set())
  const [tags, setTags] = useState('')
  const [expiresInDays, setExpiresInDays] = useState(String(catalog.limits.defaultExpiryDays))
  const [rateLimit, setRateLimit] = useState(String(catalog.limits.defaultRateLimitPerMinute))
  const [gateTools, setGateTools] = useState('')
  const [captureContent, setCaptureContent] = useState(false)
  const [workflows, setWorkflows] = useState<SavedWorkflow[] | null | 'failed'>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useDialogFocusTrap(dialogRef, { initialFocus: nameRef, onEscape: submitting ? undefined : onClose })

  useEffect(() => {
    let cancelled = false
    readSavedWorkflowPage()
      .then((rows) => { if (!cancelled) setWorkflows(rows) })
      .catch(() => { if (!cancelled) setWorkflows('failed') })
    return () => { cancelled = true }
  }, [])

  const expiry = Number(expiresInDays)
  const rate = Number(rateLimit)
  const expiryValid = Number.isInteger(expiry) && expiry >= 1 && expiry <= catalog.limits.maxExpiryDays
  const rateValid = Number.isInteger(rate) && rate >= 1 && rate <= catalog.limits.maxRateLimitPerMinute
  // The server always adds read, so a person who cannot grant it cannot create.
  const readGrantable = catalog.capabilities.find((capability) => capability.name === 'read')?.grantable ?? false
  const canSubmit = name.trim().length > 0 && expiryValid && rateValid && readGrantable && !submitting
  const scopeTags = parseTags(tags)
  // Gates and their content only apply to a client that reports its sessions.
  const reports = capabilities.has('report')
  const gates = reports ? parseTags(gateTools) : []

  const toggle = <Value,>(set: ReadonlySet<Value>, value: Value, on: boolean): ReadonlySet<Value> => {
    const next = new Set(set)
    if (on) next.add(value)
    else next.delete(value)
    return next
  }

  const submit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const issued = await contractApi('POST /agent-clients', '/v1/agent-clients', {
        name: name.trim(),
        capabilities: [...capabilities],
        scope: { workflowIds: [...workflowIds], tags: scopeTags },
        expiresInDays: expiry,
        rateLimitPerMinute: rate,
        gateTools: gates,
        captureContent: gates.length > 0 && captureContent,
      }, { guard: isPostAgentClientsResponse, signal: new AbortController().signal })
      onCreated(issued)
    } catch (createError) {
      setError(tApiError(createError) || t('agentClients.error.create'))
      setSubmitting(false)
    }
  }

  return (
    <div className="run-input-backdrop" onClick={() => { if (!submitting) onClose() }}>
      <div
        ref={dialogRef}
        className="run-input-dialog we-agent-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${formId}-title`}
        onClick={(event) => event.stopPropagation()}
        data-testid="agent-client-create-dialog"
      >
        <header className="run-input-dialog__header">
          <span className="run-input-dialog__icon" aria-hidden="true"><Bot size={18} /></span>
          <div className="run-input-dialog__heading">
            <h2 id={`${formId}-title`}>{t('agentClients.action.new')}</h2>
          </div>
          <Button size="icon" variant="ghost" onClick={onClose} disabled={submitting} aria-label={t('common.close')}>
            <X size={16} aria-hidden="true" />
          </Button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="run-input-dialog__body we-agent-dialog__body">
            {error && <p className="we-agent-dialog__error" role="alert">{error}</p>}
            <FormField id={`${formId}-name`} label={t('workflowsDashboard.columnName')} required>
              {(controlProps) => (
                <input
                  {...controlProps}
                  ref={nameRef}
                  value={name}
                  maxLength={120}
                  autoComplete="off"
                  onChange={(event) => setName(event.target.value)}
                  disabled={submitting}
                />
              )}
            </FormField>

            <fieldset className="we-agent-dialog__group" disabled={submitting}>
              <legend>{t('agentClients.column.capabilities')}</legend>
              {catalog.capabilities.map(({ name: capability, grantable, missingPermissions }) => {
                const id = `${formId}-cap-${capability}`
                const implied = capability === 'read'
                return (
                  <div className="we-agent-dialog__option" key={capability}>
                    <input
                      id={id}
                      type="checkbox"
                      checked={implied || capabilities.has(capability)}
                      disabled={implied || !grantable}
                      aria-describedby={`${id}-hint`}
                      onChange={(event) => setCapabilities((current) => toggle(current, capability, event.target.checked))}
                    />
                    <label htmlFor={id}>
                      <span className="we-agent-dialog__option-name">{t(`agentClients.capability.${capability}.label`)}</span>
                      {!grantable && (
                        <span className="we-pill" data-tone="neutral" data-testid={`agent-client-missing-${capability}`}>
                          {t('agentClients.capability.needs', { permissions: missingPermissions.join(', ') })}
                        </span>
                      )}
                      <span id={`${id}-hint`} className="we-agent-dialog__option-hint">
                        {t(`agentClients.capability.${capability}.hint`)}
                      </span>
                    </label>
                  </div>
                )
              })}
            </fieldset>

            <fieldset className="we-agent-dialog__group" disabled={submitting}>
              <legend>{t('alerts.form.scope')}</legend>
              {workflowIds.size === 0 && scopeTags.length === 0 && (
                <p className="we-agent-dialog__scope-state">{t('agentClients.scope.organization')}</p>
              )}
              <div className="we-agent-dialog__workflows" role="group" aria-label={t('workspace.destination.workflows.label')}>
                <span className="we-agent-dialog__subhead" aria-hidden="true">{t('workspace.destination.workflows.label')}</span>
                {workflows === null && <p className="helper-text" role="status">{t('common.loading')}</p>}
                {workflows === 'failed' && <p className="helper-text" role="status">{t('agentClients.scope.workflowsUnavailable')}</p>}
                {Array.isArray(workflows) && workflows.length === 0 && (
                  <p className="helper-text">{t('agentClients.scope.noWorkflows')}</p>
                )}
                {Array.isArray(workflows) && workflows.length > 0 && (
                  <ul className="we-agent-dialog__workflow-list">
                    {workflows.map((workflow) => {
                      const id = `${formId}-wf-${workflow.id}`
                      return (
                        <li key={workflow.id}>
                          <input
                            id={id}
                            type="checkbox"
                            checked={workflowIds.has(workflow.id)}
                            onChange={(event) => setWorkflowIds((current) => toggle(current, workflow.id, event.target.checked))}
                          />
                          <label htmlFor={id}>{workflow.name || workflow.id}</label>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
              <FormField id={`${formId}-tags`} label={t('workflowMetadata.field.tags')}>
                {(controlProps) => (
                  <input
                    {...controlProps}
                    value={tags}
                    autoComplete="off"
                    placeholder={t('agentClients.field.tagsPlaceholder')}
                    onChange={(event) => setTags(event.target.value)}
                  />
                )}
              </FormField>
            </fieldset>

            {reports && (
              <fieldset className="we-agent-dialog__group" disabled={submitting} data-testid="agent-client-report-options">
                <legend>{t('agentClients.capability.report.label')}</legend>
                <FormField id={`${formId}-gates`} label={t('agentClients.field.gateTools')}>
                  {(controlProps) => (
                    <input
                      {...controlProps}
                      value={gateTools}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={t('agentClients.field.gateToolsPlaceholder')}
                      onChange={(event) => setGateTools(event.target.value)}
                    />
                  )}
                </FormField>
                <div className="we-agent-dialog__option">
                  <input
                    id={`${formId}-capture`}
                    type="checkbox"
                    checked={gates.length > 0 && captureContent}
                    disabled={gates.length === 0}
                    onChange={(event) => setCaptureContent(event.target.checked)}
                  />
                  <label htmlFor={`${formId}-capture`}>
                    <span className="we-agent-dialog__option-name">{t('agentClients.field.captureContent')}</span>
                  </label>
                </div>
              </fieldset>
            )}

            <div className="we-agent-dialog__limits">
              <FormField
                id={`${formId}-expiry`}
                label={t('agentClients.field.expiry')}
                error={expiryValid ? undefined : t('agentClients.field.range', { max: catalog.limits.maxExpiryDays })}
              >
                {(controlProps) => (
                  <input
                    {...controlProps}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={catalog.limits.maxExpiryDays}
                    value={expiresInDays}
                    onChange={(event) => setExpiresInDays(event.target.value)}
                    disabled={submitting}
                  />
                )}
              </FormField>
              <FormField
                id={`${formId}-rate`}
                label={t('agentClients.field.rateLimit')}
                error={rateValid ? undefined : t('agentClients.field.range', { max: catalog.limits.maxRateLimitPerMinute })}
              >
                {(controlProps) => (
                  <input
                    {...controlProps}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={catalog.limits.maxRateLimitPerMinute}
                    value={rateLimit}
                    onChange={(event) => setRateLimit(event.target.value)}
                    disabled={submitting}
                  />
                )}
              </FormField>
            </div>
          </div>
          <footer className="run-input-dialog__footer">
            <Button variant="secondary" onClick={onClose} disabled={submitting}>{t('common.cancel')}</Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!canSubmit}
              loading={submitting}
              loadingLabel={t('common.working')}
              data-testid="agent-client-create-submit"
            >
              {t('agentClients.action.create')}
            </Button>
          </footer>
        </form>
      </div>
    </div>
  )
}

/** Ready-to-paste remote MCP setup for the two supported coding agents. */
export function mcpSnippets(token: string, url = publicApiUrl('/mcp')) {
  return {
    url,
    claudeCode: `claude mcp add --transport http janusly ${url} --header "Authorization: Bearer ${token}"`,
    codex: `[mcp_servers.janusly]\nurl = "${url}"\nhttp_headers = { "Authorization" = "Bearer ${token}" }`,
  }
}

function CopyBlock({ id, label, value, multiline = false }: { id: string; label: string; value: string; multiline?: boolean }) {
  const { t } = useT()
  const [copied, setCopied] = useState<boolean | null>(null)
  // Clipboard API only: a textarea fallback would put the token in the DOM.
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div className="we-agent-token__block">
      <div className="we-agent-token__block-head">
        <span id={`${id}-label`} className="we-agent-token__label">{label}</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void copy()}
          aria-label={t('agentClients.token.copyNamed', { name: label })}
          data-testid={`${id}-copy`}
        >
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          {copied ? t('agentClients.token.copied') : t('workflowMetadata.action.copy')}
        </Button>
      </div>
      {multiline
        ? <pre className="we-agent-token__code" aria-labelledby={`${id}-label`} tabIndex={0}><code>{value}</code></pre>
        : (
          <TextInput
            readOnly
            value={value}
            aria-labelledby={`${id}-label`}
            className="we-agent-token__value"
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
            data-testid={`${id}-value`}
          />
        )}
      {copied === false && <p className="we-agent-dialog__error" role="alert">{t('agentClients.token.copyFailed')}</p>}
    </div>
  )
}

/** Shows a freshly issued token once. Closing asks first, then drops the only copy the page held. */
export function AgentTokenDialog({
  clientName,
  token,
  rotated,
  onClose,
}: {
  clientName: string
  token: string
  rotated: boolean
  onClose: () => void
}) {
  const { t } = useT()
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const doneRef = useRef<HTMLButtonElement | null>(null)
  const keepRef = useRef<HTMLButtonElement | null>(null)
  const [closing, setClosing] = useState(false)
  const askToClose = () => setClosing(true)
  useDialogFocusTrap(dialogRef, { initialFocus: doneRef, onEscape: closing ? () => setClosing(false) : askToClose })
  const asked = useRef(false)
  useEffect(() => {
    if (closing) keepRef.current?.focus()
    else if (asked.current) doneRef.current?.focus()
    asked.current = closing
  }, [closing])
  const snippets = mcpSnippets(token)
  return (
    <div className="run-input-backdrop">
      <div
        ref={dialogRef}
        className="run-input-dialog we-agent-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${titleId}-once`}
        data-testid="agent-token-dialog"
      >
        <header className="run-input-dialog__header">
          <span className="run-input-dialog__icon" aria-hidden="true"><KeyRound size={18} /></span>
          <div className="run-input-dialog__heading">
            <h2 id={titleId}>{t(rotated ? 'agentClients.token.rotatedTitle' : 'agentClients.token.title', { name: clientName })}</h2>
            <p id={`${titleId}-once`} className="helper-text">{t('agentClients.token.once')}</p>
          </div>
        </header>
        <div className="run-input-dialog__body we-agent-dialog__body">
          <CopyBlock id="agent-token" label={t('agentClients.token.token')} value={token} />
          <CopyBlock id="agent-token-claude" label={t('agentClients.token.claudeCode')} value={snippets.claudeCode} multiline />
          <CopyBlock id="agent-token-codex" label={t('agentClients.token.codex')} value={snippets.codex} multiline />
        </div>
        <footer className="run-input-dialog__footer">
          {closing
            ? (
              <div className="we-agent-token__confirm" role="alert" data-testid="agent-token-confirm">
                <span>{t('agentClients.token.closeConfirm')}</span>
                <Button ref={keepRef} variant="secondary" onClick={() => setClosing(false)} data-testid="agent-token-keep">
                  {t('agentClients.token.keep')}
                </Button>
                <Button variant="danger" onClick={onClose} data-testid="agent-token-close">
                  {t('common.close')}
                </Button>
              </div>
            )
            : (
              <Button ref={doneRef} variant="primary" onClick={askToClose} data-testid="agent-token-done">
                {t('agentClients.token.done')}
              </Button>
            )}
        </footer>
      </div>
    </div>
  )
}

/** Tools per capability, what the creator no longer holds, latest calls and open publications. */
export function AgentClientDetail({ clientId }: { clientId: string }) {
  const { t } = useT()
  const [load, setLoad] = useState<{ kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; detail: Detail }>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    contractApi('GET /agent-clients/{id}', `/v1/agent-clients/${encodeURIComponent(clientId)}`, undefined, { guard: isGetAgentClientsIdResponse })
      .then((detail) => { if (!cancelled) setLoad({ kind: 'ready', detail }) })
      .catch((error: unknown) => { if (!cancelled) setLoad({ kind: 'error', message: tApiError(error) || t('agentClients.error.detail') }) })
    return () => { cancelled = true }
  }, [clientId, t])

  if (load.kind === 'loading') return <LoadingSkeleton rows={2} label={t('common.loading')} />
  if (load.kind === 'error') return <p className="we-agent-dialog__error" role="alert">{load.message}</p>
  const { client, capabilities, recentCalls, openRequests } = load.detail
  return (
    <div className="we-agent-detail" data-testid={`agent-client-detail-${client.id}`}>
      {client.creatorAccess.state === 'removed' && (
        <p className="we-agent-detail__notice" role="status">{t('agentClients.detail.removed')}</p>
      )}
      {client.gateTools.length > 0 && (
        <p className="we-agent-detail__notice" data-testid={`agent-client-gates-${client.id}`}>
          {t('agentClients.detail.gates', { tools: client.gateTools.join(', ') })}
          {client.captureContent && ` · ${t('agentClients.detail.gatesContent')}`}
        </p>
      )}
      <section aria-labelledby={`${client.id}-tools`}>
        <h4 id={`${client.id}-tools`}>{t('agentClients.detail.tools')}</h4>
        <ul className="we-agent-detail__capabilities">
          {capabilities.map((capability) => (
            <li key={capability.name}>
              <strong>{t(`agentClients.capability.${capability.name}.label`)}</strong>
              {capability.missingPermissions.length > 0 && (
                <span className="we-pill" data-tone="warning" data-testid={`agent-client-lost-${capability.name}`}>
                  {t('agentClients.detail.lost', { permissions: capability.missingPermissions.join(', ') })}
                </span>
              )}
              <span className="we-agent-detail__tools">{capability.tools.join(' · ') || t('agentClients.detail.noTools')}</span>
            </li>
          ))}
        </ul>
      </section>
      {recentCalls !== null && (
        <section aria-labelledby={`${client.id}-calls`}>
          <h4 id={`${client.id}-calls`}>{t('agentClients.detail.calls')}</h4>
          {recentCalls.length === 0
            ? <p className="helper-text">{t('agentClients.detail.noCalls')}</p>
            : (
              <ul className="we-agent-detail__calls">
                {recentCalls.map((call, index) => (
                  <li key={`${call.at ?? ''}-${index}`}>
                    {call.allowed
                      ? <CheckCircle2 size={13} role="img" aria-label={t('agentClients.detail.allowed')} />
                      : <CircleX size={13} role="img" aria-label={t('agentClients.detail.denied')} />}
                    <code>{call.tool}</code>
                    <span className="we-agent-detail__muted">{formatWhen(call.at)}</span>
                  </li>
                ))}
              </ul>
            )}
        </section>
      )}
      {openRequests !== null && (
        <section aria-labelledby={`${client.id}-requests`}>
          <h4 id={`${client.id}-requests`}>{t('agentClients.detail.requests')}</h4>
          {openRequests.length === 0
            ? <p className="helper-text">{t('agentClients.detail.noRequests')}</p>
            : (
              <ul className="we-agent-detail__calls">
                {openRequests.map((request) => (
                  <li key={request.id}>
                    <code>{request.workflowId}</code>
                    <span className="we-agent-detail__muted">{t('agentClients.detail.expires', { when: formatWhen(request.expiresAt) })}</span>
                  </li>
                ))}
              </ul>
            )}
        </section>
      )}
    </div>
  )
}
