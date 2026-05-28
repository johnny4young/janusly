/**
 * MCP connection + tool dropdown editor for `mcp_tool` nodes. Renders
 * inside `QuickConfigEditor`'s mcp_tool branch.
 *
 * Self-contained data fetcher: hits `/mcp/connections` for the list of
 * active connections, then `/mcp/connections/:alias/tools` whenever
 * the operator picks an alias. Both fetches re-run on `platformVersion`
 * bumps so an admin enabling / disabling / re-discovering a connection
 * in the Operations panel is reflected here without a page reload.
 *
 * Viewer-without-permission failures are silenced — the dropdown
 * degrades to "empty" rather than crashing the inspector.
 *
 * Used by:
 * - `QuickConfigEditor.tsx` (mcp_tool branch).
 */

import React, { useEffect, useState } from 'react'
import type { JsonObject, McpConnection, McpToolDescriptor } from '../types'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { useT } from '../i18n'
import {
  asJsonObject,
  fieldId,
  JsonConfigField,
  NumberConfigField,
  readConfigNumber,
  readConfigString,
} from './quick-config-fields'

export function McpToolConfigField({ scope, config, onPatch }: { scope: string; config: JsonObject; onPatch: (next: Record<string, unknown>) => void }) {
  const { t } = useT()
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  const [connections, setConnections] = useState<McpConnection[]>([])
  const [toolsByAlias, setToolsByAlias] = useState<Record<string, McpToolDescriptor[]>>({})
  const [loading, setLoading] = useState(true)
  const selectedAlias = readConfigString(config, 'connectionAlias')
  const selectedTool = readConfigString(config, 'toolName')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api('/mcp/connections')
      .then((data) => {
        if (cancelled) return
        const rows = (data as { connections?: McpConnection[] })?.connections ?? []
        setConnections(rows.filter((row) => row.status === 'active'))
      })
      .catch(() => {
        // Keep silent — viewer-without-permission shouldn't crash the inspector
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // Re-fetch when an admin enables / disables / re-discovers a connection in
    // the Operations panel (they bump platformVersion); otherwise the dropdown
    // shows stale options until the page reloads.
  }, [platformVersion])

  useEffect(() => {
    if (!selectedAlias) return
    let cancelled = false
    // Re-fetch the per-connection tool list whenever the alias changes OR
    // platformVersion bumps (admin re-discovered / disabled a tool). The
    // previous cache-only guard kept stale descriptors after a disable.
    api(`/mcp/connections/${encodeURIComponent(selectedAlias)}/tools`)
      .then((data) => {
        if (cancelled) return
        const tools = (data as { tools?: McpToolDescriptor[] })?.tools ?? []
        setToolsByAlias((prev) => ({ ...prev, [selectedAlias]: tools.filter((tool) => tool.enabled) }))
      })
      .catch(() => {
        // ignore
      })
    return () => {
      cancelled = true
    }
  }, [selectedAlias, platformVersion])

  const aliasFieldId = fieldId(scope, 'mcp connection')
  const toolFieldId = fieldId(scope, 'mcp tool')
  const tools = selectedAlias ? toolsByAlias[selectedAlias] ?? [] : []
  const knownAlias = connections.some((c) => c.alias === selectedAlias)
  const knownTool = tools.some((tool) => tool.name === selectedTool)

  return (
    <section className="quick-config">
      <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
      <div className="form-grid">
        <label className="field-label" htmlFor={aliasFieldId}>{t('rightPanel.mcpInspector.connection')}</label>
        <select
          id={aliasFieldId}
          className="text-field"
          value={selectedAlias}
          onChange={(event) => onPatch({ connectionAlias: event.target.value, toolName: '' })}
        >
          {!selectedAlias && <option value="">{t('rightPanel.mcpInspector.pickConnection')}</option>}
          {selectedAlias && !knownAlias && <option value={selectedAlias}>{t('rightPanel.mcpInspector.notActiveSuffix', { alias: selectedAlias })}</option>}
          {connections.map((connection) => (
            <option key={connection.id} value={connection.alias}>{t('rightPanel.mcpInspector.connectionOption', { alias: connection.alias, transport: connection.transport })}</option>
          ))}
        </select>
        {!loading && connections.length === 0 && (
          <p className="helper-text">{t('rightPanel.mcpInspector.noActiveConnections')}</p>
        )}
      </div>
      <div className="form-grid">
        <label className="field-label" htmlFor={toolFieldId}>{t('rightPanel.mcpInspector.tool')}</label>
        <select
          id={toolFieldId}
          className="text-field"
          value={selectedTool}
          onChange={(event) => onPatch({ toolName: event.target.value })}
          disabled={!selectedAlias}
        >
          {!selectedTool && <option value="">{t('rightPanel.mcpInspector.pickTool')}</option>}
          {selectedTool && !knownTool && <option value={selectedTool}>{t('rightPanel.mcpInspector.notEnabledSuffix', { name: selectedTool })}</option>}
          {tools.map((tool) => (
            <option key={tool.id} value={tool.name}>
              {tool.writeSide
                ? t('rightPanel.mcpInspector.toolWriteSideOption', { name: tool.name })
                : tool.name}
            </option>
          ))}
        </select>
        {selectedAlias && tools.length === 0 && !loading && (
          <p className="helper-text">{t('rightPanel.mcpInspector.noEnabledTools')}</p>
        )}
      </div>
      <JsonConfigField scope={scope} label={t('rightPanel.mcpInspector.toolInput') as string} value={asJsonObject(config.input)} onChange={(value) => onPatch({ input: value })} />
      <NumberConfigField
        scope={scope}
        label={t('rightPanel.mcpInspector.timeoutMs') as string}
        value={readConfigNumber(config, 'timeoutMs') ?? 30000}
        onChange={(value) => onPatch({ timeoutMs: value })}
      />
      <p className="helper-text">{t('rightPanel.mcpInspector.timeoutHelper')}</p>
    </section>
  )
}
