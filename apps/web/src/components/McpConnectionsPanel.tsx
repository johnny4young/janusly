/**
 * MCP client connection admin panel — mounted inside `OperationsPage`.
 *
 * Admins register external MCP servers (alias + transport + connection
 * details + env-refs), then per-tool toggle which descriptors the
 * workflow's `mcp_tool` step can call. Three transports today: `stdio`
 * (local child process; subject to a server-controlled command
 * allowlist), `sse` (remote SSE stream), and `http` (remote Streamable
 * HTTP); URL transports are SSRF-guarded by the same outbound
 * target-policy validator used by the engine HTTP client.
 *
 * Discovery is one-shot on create + admin-triggered re-discovery. The
 * panel does NOT subscribe to a live discovery stream; status badges
 * reflect the cached `status` column.
 *
 * Admin-only. Calls `bumpPlatformVersion()` after each mutation so
 * other panels that depend on `mcp_tool` availability refetch.
 */

import React, { useEffect, useState } from 'react'
import { LoadingSkeleton } from './LoadingSkeleton'
import { AlertCircle, Plug, RefreshCw, Save, Trash2 } from 'lucide-react'

import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { McpConnection, McpConnectionStatus, McpToolDescriptor, McpTransport } from '../types'
import { tApiError, Trans, useT } from '../i18n'
import { useConfirm } from './ConfirmDialog'
import { isLikelyHttpUrl } from '../url'
import { t as runtimeT } from '../i18n/runtime'

type ConnectionListEntry = McpConnection & { toolCount?: number; enabledToolCount?: number }

type CreateForm = {
  alias: string
  transport: McpTransport
  command: string
  args: string
  url: string
  envRefsText: string
}

const EMPTY_FORM: CreateForm = {
  alias: '',
  transport: 'stdio',
  command: '',
  args: '',
  url: '',
  envRefsText: '',
}

function parseEnvRefs(text: string): { ok: true; envRefs: Record<string, { kind: 'env'; name: string }> } | { ok: false; error: string } {
  const out: Record<string, { kind: 'env'; name: string }> = {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  for (const line of lines) {
    const eq = line.indexOf('=')
    if (eq <= 0) return { ok: false, error: runtimeT('mcpConnections.errors.badEnvRefLine', { line }) as string }
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (!key || !value) return { ok: false, error: runtimeT('mcpConnections.errors.badEnvRefLine', { line }) as string }
    // Reject duplicate keys at parse time — a silent overwrite loses one
    // of the operator's intended refs (e.g. `KEY=A\nKEY=B` resolves to
    // just `B` with no warning). Surface it so the admin can fix it.
    if (key in out) return { ok: false, error: runtimeT('mcpConnections.errors.duplicateEnvRefKey', { key }) as string }
    out[key] = { kind: 'env', name: value }
  }
  return { ok: true, envRefs: out }
}

function formatEnvRefs(envRefs: Record<string, { kind: 'env'; name: string }>): string {
  return Object.entries(envRefs)
    .map(([key, ref]) => `${key}=${ref.name}`)
    .join('\n')
}

function statusBadgeClass(status: McpConnectionStatus): string {
  switch (status) {
    case 'active': return 'mode-pill mode-pill-success'
    case 'failed': return 'mode-pill mode-pill-danger'
    case 'disabled': return 'mode-pill mode-pill-neutral'
    case 'pending': return 'mode-pill mode-pill-warning'
  }
}

function statusLabel(status: McpConnectionStatus): string {
  switch (status) {
    case 'active': return runtimeT('mcpConnections.status.active') as string
    case 'failed': return runtimeT('mcpConnections.status.failed') as string
    case 'disabled': return runtimeT('mcpConnections.status.disabled') as string
    case 'pending': return runtimeT('mcpConnections.status.pending') as string
  }
}

export function McpConnectionsPanel() {
  const { t } = useT()
  const confirmDialog = useConfirm()
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion)
  const addToast = useWorkflowStore((state) => state.addToast)
  const platformVersion = useWorkflowStore((state) => state.platformVersion)

  const [connections, setConnections] = useState<ConnectionListEntry[]>([])
  const [toolsByConnection, setToolsByConnection] = useState<Record<string, McpToolDescriptor[]>>({})
  const [openConnectionId, setOpenConnectionId] = useState<string | null>(null)
  const [form, setForm] = useState<CreateForm>(EMPTY_FORM)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Patch the create form and clear any stale form-level error on edit, so a
  // validation message doesn't linger after the operator fixes the field.
  const patchForm = (patch: Partial<CreateForm>) => {
    setForm((prev) => ({ ...prev, ...patch }))
    if (error) setError(null)
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api('/mcp/connections')
      .then((data) => {
        if (cancelled) return
        const rows = (data as { connections?: ConnectionListEntry[] })?.connections
        setConnections(Array.isArray(rows) ? rows : [])
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : (t('mcpConnections.errors.loadFailed')))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [platformVersion, t])

  const loadToolsFor = async (connection: ConnectionListEntry) => {
    try {
      const data = await api(`/mcp/connections/${encodeURIComponent(connection.alias)}/tools`)
      const tools = (data as { tools?: McpToolDescriptor[] })?.tools ?? []
      setToolsByConnection((prev) => ({ ...prev, [connection.id]: tools }))
    } catch (err) {
      addToast(tApiError(err) || (t('mcpConnections.errors.loadToolsFailed')), 'error')
    }
  }

  const toggleAccordion = async (connection: ConnectionListEntry) => {
    if (openConnectionId === connection.id) {
      setOpenConnectionId(null)
      return
    }
    setOpenConnectionId(connection.id)
    if (!toolsByConnection[connection.id]) {
      await loadToolsFor(connection)
    }
  }

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    const alias = form.alias.trim().toLowerCase()
    if (!alias) {
      setError(t('mcpConnections.errors.aliasRequired'))
      return
    }
    const envRefsParsed = parseEnvRefs(form.envRefsText)
    if (!envRefsParsed.ok) {
      setError(envRefsParsed.error)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const body: Record<string, unknown> = {
        alias,
        transport: form.transport,
        envRefs: envRefsParsed.envRefs,
      }
      if (form.transport === 'stdio') {
        body.command = form.command.trim()
        const args = form.args.trim()
        body.args = args ? args.split(/\s+/) : []
      } else {
        body.url = form.url.trim()
      }
      const response = await api('/mcp/connections', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      const discovery = (response as { discovery?: { ok?: boolean; error?: string; tools?: number } })?.discovery
      if (discovery?.ok) {
        const count = discovery.tools ?? 0
        addToast(t('mcpConnections.toasts.connectedDiscovered', { count }), 'success')
      } else {
        const reason = discovery?.error ?? (t('mcpConnections.toasts.unknownReason'))
        addToast(t('mcpConnections.toasts.connectedNoDiscovery', { reason }), 'info')
      }
      setForm(EMPTY_FORM)
      bumpPlatformVersion()
    } catch (err) {
      setError(err instanceof Error ? err.message : (t('mcpConnections.errors.createFailed')))
    } finally {
      setSaving(false)
    }
  }

  const setEnabled = async (connection: ConnectionListEntry, nextEnabled: boolean) => {
    try {
      await api(`/mcp/connections/${encodeURIComponent(connection.alias)}`, {
        method: 'POST',
        body: JSON.stringify({ enabled: nextEnabled }),
      })
      addToast(
        nextEnabled
          ? (t('mcpConnections.toasts.connectionEnabled'))
          : (t('mcpConnections.toasts.connectionDisabled')),
        'success',
      )
      bumpPlatformVersion()
    } catch (err) {
      addToast(tApiError(err) || (t('mcpConnections.errors.updateFailed')), 'error')
    }
  }

  const rediscover = async (connection: ConnectionListEntry) => {
    try {
      const response = await api(`/mcp/connections/${encodeURIComponent(connection.alias)}/rediscover`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      const discovery = (response as { discovery?: { ok?: boolean; error?: string } })?.discovery
      if (discovery?.ok) {
        addToast(t('mcpConnections.toasts.rediscovered'), 'success')
      } else {
        const reason = discovery?.error ?? (t('mcpConnections.toasts.unknownReason'))
        addToast(t('mcpConnections.toasts.rediscoveryFailed', { reason }), 'error')
      }
      bumpPlatformVersion()
      await loadToolsFor(connection)
    } catch (err) {
      addToast(tApiError(err) || (t('mcpConnections.errors.rediscoverFailed')), 'error')
    }
  }

  const removeConnection = async (connection: ConnectionListEntry) => {
    if (!(await confirmDialog({ body: t('mcpConnections.actions.deleteConfirm', { alias: connection.alias }), tone: 'danger' }))) return
    try {
      await api(`/mcp/connections/${encodeURIComponent(connection.alias)}`, { method: 'DELETE' })
      addToast(t('mcpConnections.toasts.deleted'), 'success')
      bumpPlatformVersion()
    } catch (err) {
      addToast(tApiError(err) || (t('mcpConnections.errors.deleteFailed')), 'error')
    }
  }

  const setToolFlag = async (connection: ConnectionListEntry, tool: McpToolDescriptor, patch: { enabled?: boolean; writeSide?: boolean; exposeToAi?: boolean }) => {
    try {
      await api(`/mcp/connections/${encodeURIComponent(connection.alias)}/tools/${encodeURIComponent(tool.name)}`, {
        method: 'POST',
        body: JSON.stringify(patch),
      })
      // Refetch the descriptor list so the UI reflects the new flags.
      await loadToolsFor(connection)
      bumpPlatformVersion()
    } catch (err) {
      addToast(tApiError(err) || (t('mcpConnections.errors.updateToolFailed')), 'error')
    }
  }

  // Live form validation: gate submit on the required fields for the chosen
  // transport, and flag a malformed URL inline (http/https only) before submit.
  const trimmedAlias = form.alias.trim()
  const urlNeeded = form.transport !== 'stdio'
  const trimmedUrl = form.url.trim()
  const urlInvalid = urlNeeded && trimmedUrl.length > 0 && !isLikelyHttpUrl(trimmedUrl)
  const canSubmit =
    !saving &&
    trimmedAlias.length > 0 &&
    (urlNeeded ? trimmedUrl.length > 0 && !urlInvalid : form.command.trim().length > 0)

  return (
    <section className="we-card">
      <div className="split-row">
        <div>
          <div className="section-kicker">{t('mcpConnections.kicker')}</div>
          <strong>{t('mcpConnections.title')}</strong>
        </div>
        <span className="mode-pill mode-pill-neutral">{t('mcpConnections.connectedCount', { count: connections.length })}</span>
      </div>
      <p className="helper-text">
        <Trans
          i18nKey="mcpConnections.helper"
          components={{ code: <code /> }}
        />
      </p>

      {error && <div className="form-error">{error}</div>}

      <form onSubmit={create} className="form-stack">
        <div className="split-row">
          <div style={{ flex: 1 }}>
            <label className="field-label" htmlFor="mcp-alias">{t('mcpConnections.form.alias')}</label>
            <input
              id="mcp-alias"
              className="text-field"
              value={form.alias}
              onChange={(event) => patchForm({ alias: event.target.value })}
              placeholder={t('mcpConnections.form.aliasPlaceholder')}
              autoComplete="off"
            />
          </div>
          <div style={{ flex: 1 }}>
            <label className="field-label" htmlFor="mcp-transport">{t('mcpConnections.form.transport')}</label>
            <select
              id="mcp-transport"
              className="text-field"
              value={form.transport}
              onChange={(event) => patchForm({ transport: event.target.value as McpTransport })}
            >
              <option value="stdio">{t('mcpConnections.form.transportStdio')}</option>
              <option value="sse">{t('mcpConnections.form.transportSse')}</option>
              <option value="http">{t('mcpConnections.form.transportHttp')}</option>
            </select>
          </div>
        </div>
        {form.transport === 'stdio' ? (
          <>
            <label className="field-label" htmlFor="mcp-command">{t('mcpConnections.form.command')}</label>
            <input
              id="mcp-command"
              className="text-field"
              value={form.command}
              onChange={(event) => patchForm({ command: event.target.value })}
              placeholder={t('mcpConnections.form.commandPlaceholder')}
            />
            <label className="field-label" htmlFor="mcp-args">{t('mcpConnections.form.args')}</label>
            <input
              id="mcp-args"
              className="text-field"
              value={form.args}
              onChange={(event) => patchForm({ args: event.target.value })}
              placeholder={t('mcpConnections.form.argsPlaceholder')}
            />
          </>
        ) : (
          <>
            <label className="field-label" htmlFor="mcp-url">{t('mcpConnections.form.url')}</label>
            <input
              id="mcp-url"
              className={`text-field${urlInvalid ? ' text-field--error' : ''}`}
              value={form.url}
              onChange={(event) => patchForm({ url: event.target.value })}
              placeholder={t('mcpConnections.form.urlPlaceholder')}
              aria-invalid={urlInvalid}
              aria-describedby={urlInvalid ? 'mcp-url-error' : undefined}
            />
            {urlInvalid && (
              <span id="mcp-url-error" className="helper-text helper-text--error" role="alert">
                <AlertCircle size={13} aria-hidden="true" /> {t('mcpConnections.errors.urlInvalid')}
              </span>
            )}
          </>
        )}
        <label className="field-label" htmlFor="mcp-env-refs">{t('mcpConnections.form.envRefs')}</label>
        <textarea
          id="mcp-env-refs"
          className="text-field"
          rows={3}
          value={form.envRefsText}
          onChange={(event) => patchForm({ envRefsText: event.target.value })}
          placeholder={t('mcpConnections.form.envRefsPlaceholder')}
        />
        <button type="submit" className="command-button command-button-primary" disabled={!canSubmit}>
          <Plug size={15} aria-hidden="true" />
          <span>{saving ? t('mcpConnections.form.submitting') : t('mcpConnections.form.submit')}</span>
        </button>
      </form>

      {loading ? (
        <LoadingSkeleton rows={3} label={t('mcpConnections.list.loading')} />
      ) : connections.length === 0 ? (
        <p className="helper-text">{t('mcpConnections.list.empty')}</p>
      ) : (
        <div className="panel-list">
          {connections.map((connection) => (
            <article key={connection.id} className="list-card">
              <header className="split-row">
                <div>
                  <strong>{connection.alias}</strong>
                  <div className="helper-text">
                    {connection.transport === 'stdio'
                      ? `stdio · ${connection.command ?? ''} ${(connection.args ?? []).join(' ')}`.trim()
                      : `${connection.transport} · ${connection.url ?? ''}`}
                  </div>
                  {connection.statusReason && (
                    <div className="helper-text helper-text--error">
                      {connection.statusReason}
                    </div>
                  )}
                </div>
                <div className="split-row" style={{ gap: 8 }}>
                  <span className={statusBadgeClass(connection.status)}>{statusLabel(connection.status)}</span>
                  <span className="mode-pill mode-pill-neutral">
                    {t('mcpConnections.list.toolsCount', { total: connection.toolCount ?? 0, enabled: connection.enabledToolCount ?? 0 })}
                  </span>
                </div>
              </header>
              <div className="member-actions" style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="small-command"
                  onClick={() => toggleAccordion(connection)}
                  aria-expanded={openConnectionId === connection.id}
                  aria-controls={`mcp-tools-${connection.id}`}
                >
                  {openConnectionId === connection.id ? t('mcpConnections.list.hideTools') : t('mcpConnections.list.showTools')}
                </button>
                <button
                  type="button"
                  className="small-command"
                  onClick={() => setEnabled(connection, !connection.enabled)}
                  aria-label={
                    connection.enabled
                      ? (t('mcpConnections.actions.disableAria', { alias: connection.alias }))
                      : (t('mcpConnections.actions.enableAria', { alias: connection.alias }))
                  }
                  title={
                    connection.enabled
                      ? (t('mcpConnections.actions.disableTitle'))
                      : (t('mcpConnections.actions.enableTitle'))
                  }
                >
                  <Save size={14} aria-hidden="true" /> {connection.enabled ? t('mcpConnections.actions.disable') : t('mcpConnections.actions.enable')}
                </button>
                <button
                  type="button"
                  className="small-command"
                  onClick={() => rediscover(connection)}
                  aria-label={t('mcpConnections.actions.rediscoverAria', { alias: connection.alias })}
                  title={t('mcpConnections.actions.rediscoverTitle')}
                >
                  <RefreshCw size={14} aria-hidden="true" /> {t('mcpConnections.actions.rediscover')}
                </button>
                <button
                  type="button"
                  className="small-command danger"
                  onClick={() => removeConnection(connection)}
                  aria-label={t('mcpConnections.actions.deleteAria', { alias: connection.alias })}
                  title={t('mcpConnections.actions.deleteTitle')}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </div>
              {Object.keys(connection.envRefs ?? {}).length > 0 && (
                <div className="helper-text" style={{ marginTop: 8 }}>
                  {t('mcpConnections.list.envRefs')} <code>{formatEnvRefs(connection.envRefs).replace(/\n/g, ' · ')}</code>
                </div>
              )}
              {openConnectionId === connection.id && (
                <div id={`mcp-tools-${connection.id}`} className="panel-list" style={{ marginTop: 8 }}>
                  {(toolsByConnection[connection.id] ?? []).length === 0 ? (
                    <p className="helper-text">{t('mcpConnections.tools.empty')}</p>
                  ) : (
                    (toolsByConnection[connection.id] ?? []).map((tool) => (
                      <div key={tool.id} className="list-card">
                        <div className="split-row">
                          <div>
                            <strong>{tool.name}</strong>
                            {tool.description && <div className="helper-text">{tool.description}</div>}
                          </div>
                          <div className="member-actions">
                            <label className="small-command">
                              <input
                                type="checkbox"
                                checked={tool.enabled}
                                onChange={(event) => setToolFlag(connection, tool, { enabled: event.target.checked })}
                                aria-label={t('mcpConnections.tools.enabledAria', { name: tool.name })}
                              />
                              <span>{t('mcpConnections.tools.enabledLabel')}</span>
                            </label>
                            <label className="small-command">
                              <input
                                type="checkbox"
                                checked={tool.writeSide}
                                onChange={(event) => setToolFlag(connection, tool, { writeSide: event.target.checked })}
                                aria-label={t('mcpConnections.tools.writeSideAria', { name: tool.name })}
                              />
                              <span>{t('mcpConnections.tools.writeSideLabel')}</span>
                            </label>
                            <label className="small-command">
                              <input
                                type="checkbox"
                                checked={tool.exposeToAi}
                                onChange={(event) => setToolFlag(connection, tool, { exposeToAi: event.target.checked })}
                                aria-label={t('mcpConnections.tools.exposeToAiAria', { name: tool.name })}
                              />
                              <span>{t('mcpConnections.tools.exposeToAiLabel')}</span>
                            </label>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
