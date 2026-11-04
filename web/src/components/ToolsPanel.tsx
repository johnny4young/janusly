import { Check, ChevronDown, Eye, Pencil, Plug } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { tToolDescription, useT } from '../i18n'
import { PLATFORM_TAG, useInvalidationNonce } from '../lib/query-cache'
import { useWorkflowStore } from '../store'
import type { ToolSchema } from '../types'
import { EmptyView, PanelChrome } from './panel-primitives'
import { Button } from './ui/Button'
import './ToolsPanel.css'

type ToolFilter = 'all' | 'read' | 'write' | 'installed'
type ToolsPanelProps = {
  tools: ToolSchema[]
  onInstallPlugin: (pluginId: string) => Promise<boolean>
  canInstall: boolean
}

const TOOL_TAGS = [PLATFORM_TAG] as const

const namespaceOf = (name: string) => name.split('.', 1)[0]

// Largest namespaces first so a row of cards has similar heights.
function groupByNamespace(tools: ToolSchema[]) {
  const groups = new Map<string, ToolSchema[]>()
  for (const tool of tools) {
    const namespace = namespaceOf(tool.name)
    groups.set(namespace, [...(groups.get(namespace) ?? []), tool])
  }
  return [...groups].sort(([a, aTools], [b, bTools]) => bTools.length - aTools.length || a.localeCompare(b))
}

function CapabilityIcon({ writeSide }: { writeSide: boolean }) {
  const Icon = writeSide ? Pencil : Eye
  return <Icon size={13} className="we-tools__capability" data-write={writeSide} aria-hidden="true" />
}

export function ToolsPanel(props: ToolsPanelProps) {
  const organizationId = useWorkflowStore(state => state.identityContext?.currentOrganizationId ?? '')
  return <ToolsCatalog key={organizationId} {...props} />
}

function ToolsCatalog({ tools, onInstallPlugin, canInstall }: ToolsPanelProps) {
  const { t } = useT()
  const refreshNonce = useInvalidationNonce(TOOL_TAGS)
  const [filter, setFilter] = useState<ToolFilter>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)
  const [installedIds, setInstalledIds] = useState<ReadonlySet<string> | null>(null)
  const [installedFailed, setInstalledFailed] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    api('/plugins/installed', { signal: controller.signal }).then(
      (data) => {
        const { pluginIds } = data as { pluginIds?: unknown }
        if (!Array.isArray(pluginIds)) throw new TypeError('Malformed installed plugins response')
        setInstalledIds(new Set<string>(pluginIds))
        setInstalledFailed(false)
      },
    ).catch(() => {
      if (!controller.signal.aborted) setInstalledFailed(true)
    })
    return () => controller.abort()
  }, [refreshNonce])

  const writeCount = tools.filter(tool => tool.writeSide).length
  const installedCount = tools.filter(tool => installedIds?.has(tool.name)).length
  const groups = groupByNamespace(tools.filter(tool => {
    if (filter === 'read') return !tool.writeSide
    if (filter === 'write') return tool.writeSide
    if (filter === 'installed') return installedIds?.has(tool.name)
    return true
  }))

  const install = async (name: string) => {
    setInstalling(name)
    const ok = await onInstallPlugin(name)
    setInstalling(null)
    if (ok) setInstalledIds(current => new Set(current).add(name))
  }

  const filters: { id: ToolFilter; label: string; count: number }[] = [
    { id: 'all', label: t('rightPanel.tools.filter.all'), count: tools.length },
    { id: 'read', label: t('rightPanel.quickConfig.toolReadOnly'), count: tools.length - writeCount },
    { id: 'write', label: t('rightPanel.quickConfig.toolWriteCapable'), count: writeCount },
    { id: 'installed', label: t('rightPanel.tools.filter.installed'), count: installedCount },
  ]

  return (
    <PanelChrome title={t('rightPanel.tools.title')} description={t('rightPanel.tools.description')}>
      <div className="panel-list">
        {tools.length === 0 ? (
          <EmptyView icon={<Plug size={22} />} title={t('rightPanel.tools.empty.title')} body={t('rightPanel.tools.empty.body')} />
        ) : (
          <div className="we-tools">
            <div className="we-seg we-tools__filter" role="group" aria-label={t('rightPanel.tools.filter.aria')}>
              {filters.map(({ id, label, count }) => (id !== 'installed' || installedIds) && (
                <button
                  key={id}
                  type="button"
                  aria-pressed={filter === id}
                  onClick={() => setFilter(id)}
                  data-testid={`tools-filter-${id}`}
                >
                  {(id === 'read' || id === 'write') && <CapabilityIcon writeSide={id === 'write'} />}
                  {label} <span className="we-tools__count">{count}</span>
                </button>
              ))}
            </div>
            {installedFailed && (
              <p className="helper-text helper-text--error" role="alert" data-testid="tools-installed-error">
                {t('rightPanel.tools.installedUnavailable')}
              </p>
            )}
            {groups.length === 0 && <p className="helper-text" data-testid="tools-no-matches">{t('rightPanel.tools.noMatches')}</p>}
            <div className="we-tools__grid">
              {groups.map(([namespace, groupTools]) => {
                const writes = groupTools.filter(tool => tool.writeSide).length
                return (
                  <section key={namespace} className="we-tools__group" aria-label={namespace} data-testid={`tools-group-${namespace}`}>
                    <header className="we-tools__group-head">
                      <strong>{namespace}</strong>
                      <span>
                        {t('rightPanel.tools.groupCount', { count: groupTools.length })}
                        {writes > 0 && ` · ${t('rightPanel.tools.groupWrites', { count: writes })}`}
                      </span>
                    </header>
                    {groupTools.map(tool => {
                      const isOpen = expanded === tool.name
                      const isInstalled = installedIds?.has(tool.name) ?? false
                      const capability = t(tool.writeSide ? 'rightPanel.quickConfig.toolWriteCapable' : 'rightPanel.quickConfig.toolReadOnly')
                      return (
                        <div key={tool.name}>
                          <button
                            type="button"
                            className="we-tools__row"
                            aria-expanded={isOpen}
                            title={capability}
                            onClick={() => setExpanded(isOpen ? null : tool.name)}
                            data-testid={`tools-row-${tool.name}`}
                          >
                            <span className="we-tools__name">{tool.name.slice(namespace.length + 1) || tool.name}</span>
                            {isInstalled && (
                              <span className="we-pill" data-tone="success" data-testid={`tools-installed-${tool.name}`}>
                                <Check size={11} aria-hidden="true" />
                                {t('rightPanel.tools.installed')}
                              </span>
                            )}
                            <span className="we-sr-only">{capability}</span>
                            <CapabilityIcon writeSide={tool.writeSide} />
                            <ChevronDown size={13} className="we-tools__chevron" aria-hidden="true" />
                          </button>
                          {isOpen && (
                            <div className="we-tools__details" data-testid={`tools-details-${tool.name}`}>
                              <code>{tool.name}</code>
                              <span>{tToolDescription(tool)}</span>
                              <span className="we-pill" data-tone={tool.writeSide ? 'warning' : 'success'}>{capability}</span>
                              {!isInstalled && (
                                <Button
                                  size="sm"
                                  disabled={!canInstall}
                                  loading={installing === tool.name}
                                  onClick={() => void install(tool.name)}
                                  data-testid={`tools-install-${tool.name}`}
                                >
                                  {t('rightPanel.tools.installTool')}
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </section>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </PanelChrome>
  )
}
