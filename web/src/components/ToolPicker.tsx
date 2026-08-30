import { useEffect, useMemo, useState } from 'react'

import { tToolDescription, useT } from '../i18n'
import type { ToolSchema } from '../types'
import { fieldId } from './quick-config-fields'
import { FormField } from './ui/Form'

function exampleFor(tool: ToolSchema | undefined): Record<string, unknown> {
  return tool?.inputExample ?? {}
}

export function ToolPicker({
  nodeId,
  selectedTool,
  tools,
  onChange,
}: {
  nodeId: string
  selectedTool: string
  tools: ToolSchema[]
  onChange: (tool: string, input: Record<string, unknown>) => void
}) {
  const { t, i18n } = useT()
  const [query, setQuery] = useState('')
  const matchedTool = tools.find(tool => tool.name === selectedTool) ?? null
  const showCurrentToolOption = Boolean(selectedTool) && !matchedTool
  const isUnknown = showCurrentToolOption && tools.length > 0
  const toolNameId = fieldId(nodeId, 'tool name')
  const searchId = fieldId(nodeId, 'tool search')

  useEffect(() => setQuery(''), [nodeId])

  const filteredTools = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    const matching = normalized
      ? tools.filter(tool => (
          tool.name.toLocaleLowerCase().includes(normalized)
          || tToolDescription(tool).toLocaleLowerCase().includes(normalized)
        ))
      : tools
    return [...matching].sort((left, right) => left.name.localeCompare(right.name))
  }, [i18n.resolvedLanguage, query, tools])

  const visibleTools = matchedTool && !filteredTools.some(tool => tool.name === matchedTool.name)
    ? [matchedTool, ...filteredTools]
    : filteredTools

  return (
    <div className="ui-config-stack" data-testid="tool-picker">
      <FormField id={searchId} label={t('rightPanel.quickConfig.toolSearch')}>
        {controlProps => (
          <input
            {...controlProps}
            type="search"
            value={query}
            placeholder={t('rightPanel.quickConfig.toolSearchPlaceholder')}
            onChange={event => setQuery(event.target.value)}
          />
        )}
      </FormField>
      <FormField id={toolNameId} label={t('rightPanel.quickConfig.tool')}>
        {controlProps => (
          <select
            {...controlProps}
            value={selectedTool}
            onChange={(event) => {
              const next = event.target.value
              onChange(next, exampleFor(tools.find(tool => tool.name === next)))
            }}
          >
            {!selectedTool && <option value="">{t('rightPanel.quickConfig.pickTool')}</option>}
            {showCurrentToolOption && (
              <option value={selectedTool}>
                {tools.length > 0
                  ? t('rightPanel.quickConfig.toolNotRegistered', { name: selectedTool })
                  : t('rightPanel.quickConfig.toolLoading', { name: selectedTool })}
              </option>
            )}
            {visibleTools.map(tool => (
              <option key={tool.name} value={tool.name}>{tool.name}</option>
            ))}
          </select>
        )}
      </FormField>

      {query.trim() && filteredTools.length === 0 && (
        <p className="helper-text" data-testid="tool-search-empty">
          {t('rightPanel.quickConfig.toolSearchEmpty')}
        </p>
      )}
      {matchedTool && (
        <>
          <div className="we-tool-params" data-testid="tool-capability">
            <span className="we-pill" data-tone={matchedTool.writeSide ? 'warning' : 'success'}>
              {t(matchedTool.writeSide
                ? 'rightPanel.quickConfig.toolWriteCapable'
                : 'rightPanel.quickConfig.toolReadOnly')}
            </span>
          </div>
          {matchedTool.description && <p className="helper-text">{tToolDescription(matchedTool)}</p>}
          <p className="helper-text">
            {t(matchedTool.writeSide
              ? 'rightPanel.quickConfig.toolWriteCapableHelper'
              : 'rightPanel.quickConfig.toolReadOnlyHelper')}
          </p>
        </>
      )}
      {isUnknown && (
        <p className="helper-text helper-text--error" data-testid="unknown-tool-warning">
          {t('rightPanel.quickConfig.unknownToolWarning')}
        </p>
      )}
    </div>
  )
}
