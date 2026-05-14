/**
 * MCP client connection admin panel — mounted inside `OperationsPanel`.
 *
 * Admins register external MCP servers (alias + transport + connection
 * details + env-refs), then per-tool toggle which descriptors the
 * workflow's `mcp_tool` step can call. Two transports today: `stdio`
 * (local child process; subject to a server-controlled command
 * allowlist) and `sse` (remote SSE stream; SSRF-guarded by the same
 * outbound target-policy validator used by the engine HTTP client).
 *
 * Discovery is one-shot on create + admin-triggered re-discovery. The
 * panel does NOT subscribe to a live discovery stream; status badges
 * reflect the cached `status` column.
 *
 * Admin-only. Calls `bumpPlatformVersion()` after each mutation so
 * other panels that depend on `mcp_tool` availability refetch.
 */

import React, { useEffect, useState } from 'react'
import { Plug, RefreshCw, Save, Trash2 } from 'lucide-react'

import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { McpConnection, McpConnectionStatus, McpToolDescriptor, McpTransport } from '../types'

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
    if (eq <= 0) return { ok: false, error: `bad env-ref line: ${line}` }
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (!key || !value) return { ok: false, error: `bad env-ref line: ${line}` }
    // Reject duplicate keys at parse time — a silent overwrite loses one
    // of the operator's intended refs (e.g. `KEY=A\nKEY=B` resolves to
    // just `B` with no warning). Surface it so the admin can fix it.
    if (key in out) return { ok: false, error: `duplicate env-ref key: ${key}` }
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

export function McpConnectionsPanel() {
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
        if (!cancelled) setError(err instanceof Error ? err.message : 'failed to load MCP connections')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [platformVersion])

  const loadToolsFor = async (connection: ConnectionListEntry) => {
    try {
      const data = await api(`/mcp/connections/${encodeURIComponent(connection.alias)}/tools`)
      const tools = (data as { tools?: McpToolDescriptor[] })?.tools ?? []
      setToolsByConnection((prev) => ({ ...prev, [connection.id]: tools }))
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'failed to load tools', 'error')
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
      setError('alias is required')
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
        addToast(`Connected — discovered ${discovery.tools ?? 0} tool${discovery.tools === 1 ? '' : 's'}`, 'success')
      } else {
        addToast(`Connection created but discovery failed: ${discovery?.error ?? 'unknown'}`, 'warning')
      }
      setForm(EMPTY_FORM)
      bumpPlatformVersion()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to create connection')
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
      addToast(nextEnabled ? 'Connection enabled' : 'Connection disabled', 'success')
      bumpPlatformVersion()
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'failed to update connection', 'error')
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
        addToast('Re-discovered tools', 'success')
      } else {
        addToast(`Re-discovery failed: ${discovery?.error ?? 'unknown'}`, 'error')
      }
      bumpPlatformVersion()
      await loadToolsFor(connection)
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'failed to re-discover', 'error')
    }
  }

  const removeConnection = async (connection: ConnectionListEntry) => {
    if (!confirm(`Delete the "${connection.alias}" MCP connection and its tools?`)) return
    try {
      await api(`/mcp/connections/${encodeURIComponent(connection.alias)}`, { method: 'DELETE' })
      addToast('Connection deleted', 'success')
      bumpPlatformVersion()
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'failed to delete connection', 'error')
    }
  }

  const setToolFlag = async (connection: ConnectionListEntry, tool: McpToolDescriptor, patch: { enabled?: boolean; writeSide?: boolean }) => {
    try {
      await api(`/mcp/connections/${encodeURIComponent(connection.alias)}/tools/${encodeURIComponent(tool.name)}`, {
        method: 'POST',
        body: JSON.stringify(patch),
      })
      // Refetch the descriptor list so the UI reflects the new flags.
      await loadToolsFor(connection)
      bumpPlatformVersion()
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'failed to update tool', 'error')
    }
  }

  return (
    <section className="panel-card">
      <div className="split-row">
        <div>
          <div className="section-kicker">MCP Connections</div>
          <strong>External MCP servers</strong>
        </div>
        <span className="mode-pill mode-pill-neutral">{connections.length} connected</span>
      </div>
      <p className="helper-text">
        Register external MCP servers and pick which of their tools your workflows can call via the <code>mcp_tool</code> step.
        Tools start disabled — opt in per tool. Writes also need <code>JANUSLY_MCP_CLIENT_WRITES_ENABLED</code> + <code>mcp.clientWriteConsent</code> both true.
      </p>

      {error && <div className="form-error">{error}</div>}

      <form onSubmit={create} className="form-stack">
        <div className="split-row">
          <div style={{ flex: 1 }}>
            <label className="field-label" htmlFor="mcp-alias">Alias</label>
            <input
              id="mcp-alias"
              className="text-field"
              value={form.alias}
              onChange={(event) => setForm((prev) => ({ ...prev, alias: event.target.value }))}
              placeholder="stripe-prod"
              autoComplete="off"
            />
          </div>
          <div style={{ flex: 1 }}>
            <label className="field-label" htmlFor="mcp-transport">Transport</label>
            <select
              id="mcp-transport"
              className="text-field"
              value={form.transport}
              onChange={(event) => setForm((prev) => ({ ...prev, transport: event.target.value as McpTransport }))}
            >
              <option value="stdio">stdio (local child process)</option>
              <option value="sse">sse (remote stream)</option>
            </select>
          </div>
        </div>
        {form.transport === 'stdio' ? (
          <>
            <label className="field-label" htmlFor="mcp-command">Command</label>
            <input
              id="mcp-command"
              className="text-field"
              value={form.command}
              onChange={(event) => setForm((prev) => ({ ...prev, command: event.target.value }))}
              placeholder="node"
            />
            <label className="field-label" htmlFor="mcp-args">Args (space-separated)</label>
            <input
              id="mcp-args"
              className="text-field"
              value={form.args}
              onChange={(event) => setForm((prev) => ({ ...prev, args: event.target.value }))}
              placeholder="./server.js --port 0"
            />
          </>
        ) : (
          <>
            <label className="field-label" htmlFor="mcp-url">URL</label>
            <input
              id="mcp-url"
              className="text-field"
              value={form.url}
              onChange={(event) => setForm((prev) => ({ ...prev, url: event.target.value }))}
              placeholder="https://mcp.example.com/sse"
            />
          </>
        )}
        <label className="field-label" htmlFor="mcp-env-refs">Env refs (one per line, `KEY=PROCESS_ENV_NAME`)</label>
        <textarea
          id="mcp-env-refs"
          className="text-field"
          rows={3}
          value={form.envRefsText}
          onChange={(event) => setForm((prev) => ({ ...prev, envRefsText: event.target.value }))}
          placeholder={'STRIPE_API_KEY=STRIPE_LIVE_KEY\nGITHUB_TOKEN=GH_BOT_TOKEN'}
        />
        <button type="submit" className="command-button command-button-primary" disabled={saving}>
          <Plug size={15} aria-hidden="true" />
          <span>{saving ? 'Connecting…' : 'Register + discover'}</span>
        </button>
      </form>

      {loading ? (
        <p className="helper-text">Loading…</p>
      ) : connections.length === 0 ? (
        <p className="helper-text">No MCP connections yet. Register one above to make external tools available as workflow steps.</p>
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
                      : `sse · ${connection.url ?? ''}`}
                  </div>
                  {connection.statusReason && (
                    <div className="helper-text" style={{ color: 'var(--we-danger-500)' }}>
                      {connection.statusReason}
                    </div>
                  )}
                </div>
                <div className="split-row" style={{ gap: 8 }}>
                  <span className={statusBadgeClass(connection.status)}>{connection.status}</span>
                  <span className="mode-pill mode-pill-neutral">
                    {connection.toolCount ?? 0} tools / {connection.enabledToolCount ?? 0} enabled
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
                  {openConnectionId === connection.id ? 'Hide tools' : 'Show tools'}
                </button>
                <button
                  type="button"
                  className="small-command"
                  onClick={() => setEnabled(connection, !connection.enabled)}
                  aria-label={connection.enabled ? `Disable ${connection.alias}` : `Enable ${connection.alias}`}
                  title={connection.enabled ? 'Disable connection' : 'Enable connection'}
                >
                  <Save size={14} aria-hidden="true" /> {connection.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  type="button"
                  className="small-command"
                  onClick={() => rediscover(connection)}
                  aria-label={`Re-discover ${connection.alias}`}
                  title="Re-discover tools"
                >
                  <RefreshCw size={14} aria-hidden="true" /> Re-discover
                </button>
                <button
                  type="button"
                  className="small-command danger"
                  onClick={() => removeConnection(connection)}
                  aria-label={`Delete ${connection.alias}`}
                  title="Delete connection"
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </div>
              {Object.keys(connection.envRefs ?? {}).length > 0 && (
                <div className="helper-text" style={{ marginTop: 8 }}>
                  Env refs: <code>{formatEnvRefs(connection.envRefs).replace(/\n/g, ' · ')}</code>
                </div>
              )}
              {openConnectionId === connection.id && (
                <div id={`mcp-tools-${connection.id}`} className="panel-list" style={{ marginTop: 8 }}>
                  {(toolsByConnection[connection.id] ?? []).length === 0 ? (
                    <p className="helper-text">No tools cached. Try Re-discover.</p>
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
                                aria-label={`Enable ${tool.name}`}
                              />
                              <span>Enabled</span>
                            </label>
                            <label className="small-command">
                              <input
                                type="checkbox"
                                checked={tool.writeSide}
                                onChange={(event) => setToolFlag(connection, tool, { writeSide: event.target.checked })}
                                aria-label={`Mark ${tool.name} write-side`}
                              />
                              <span>Write-side</span>
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
