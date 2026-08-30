/**
 * Shared operational controls for node types that call an external system.
 *
 * Used by:
 * - `QuickConfigEditor.tsx` for http, tool, agent, and mcp_tool nodes.
 * - `WorkflowReadinessBadge.tsx` through the resilience-focus handoff.
 *
 * The controls only write config keys the engine already consumes: `retry`,
 * `timeoutMs`, and HTTP response bounds.
 */

import { ChevronDown } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { JsonObject } from '../types'
import { useT } from '../i18n'
import {
  fieldId,
  OptionalNumberConfigField,
} from './quick-config-fields'
import {
  consumeResilienceFocus,
  RESILIENCE_FOCUS_EVENT,
} from './resilience-focus-bus'
import { readRetryOnClasses, RETRY_CLASSES, toggleRetryClass } from './resilience-retry-classes'
import { FormDisclosure, FormField } from './ui/Form'
import { SwitchField } from './ui/SwitchField'

type ResilienceNodeType = 'http' | 'tool' | 'agent' | 'mcp_tool'

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readBackoff(value: unknown): '' | 'fixed' | 'exponential' {
  return value === 'fixed' || value === 'exponential' ? value : ''
}

function configuredSettingCount(config: JsonObject, nodeType: ResilienceNodeType): number {
  const retry = asRecord(config.retry)
  return [
    Object.values(retry).some((value) => value !== undefined),
    typeof config.timeoutMs === 'number',
    nodeType === 'http' && typeof config.maxResponseBytes === 'number',
    nodeType === 'http' && typeof config.maxRedirects === 'number',
  ].filter(Boolean).length
}

export function ResilienceFieldset({
  nodeId,
  nodeType,
  config,
  onPatch,
}: {
  nodeId: string
  nodeType: ResilienceNodeType
  config: JsonObject
  onPatch: (next: Record<string, unknown>) => void
}) {
  const { t } = useT()
  const fieldsetRef = useRef<HTMLFieldSetElement | null>(null)
  const retry = asRecord(config.retry)
  const isHttp = nodeType === 'http'
  const timeoutMax = nodeType === 'mcp_tool' ? 120_000 : undefined
  const configuredCount = configuredSettingCount(config, nodeType)
  const [open, setOpen] = useState(false)

  const focusFieldset = useCallback(() => {
    setOpen(true)
    requestAnimationFrame(() => {
      const fieldset = fieldsetRef.current
      if (!fieldset) return
      fieldset.scrollIntoView?.({ block: 'nearest' })
      fieldset.focus({ preventScroll: true })
    })
  }, [])

  useEffect(() => {
    const onFocusRequest = (event: Event) => {
      const targetNodeId = event instanceof CustomEvent ? event.detail : null
      if (targetNodeId !== nodeId) return
      consumeResilienceFocus(nodeId)
      focusFieldset()
    }
    window.addEventListener(RESILIENCE_FOCUS_EVENT, onFocusRequest)
    if (consumeResilienceFocus(nodeId)) focusFieldset()
    return () => window.removeEventListener(RESILIENCE_FOCUS_EVENT, onFocusRequest)
  }, [focusFieldset, nodeId])

  const patchRetry = (next: Record<string, unknown>) => onPatch({ retry: { ...retry, ...next } })
  const selectedRetryClasses = readRetryOnClasses(retry.retryOn)
  const retryAttempts = readNumber(retry.maxAttempts)
  const retryDelay = readNumber(retry.delayMs)
  const retryMaxDelay = readNumber(retry.maxDelayMs)
  const backoff = readBackoff(retry.backoff)

  return (
    <FormDisclosure
      className="we-resilience-disclosure"
      data-testid="resilience-disclosure"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      summary={(
        <span className="ui-config-disclosure-summary">
          <span>
            <strong>{t('rightPanel.resilience.legend')}</strong>
            <small>{configuredCount > 0
              ? t('rightPanel.resilience.configuredSummary', { count: configuredCount })
              : t('rightPanel.resilience.defaultSummary')}</small>
          </span>
          <ChevronDown size={15} aria-hidden="true" />
        </span>
      )}
    >
      <fieldset
        ref={fieldsetRef}
        className="we-resilience-fieldset"
        tabIndex={-1}
        data-testid="resilience-fieldset"
      >
        <legend className="sr-only">{t('rightPanel.resilience.legend')}</legend>
        <p className="helper-text">{t('rightPanel.resilience.helper')}</p>

        <div className="we-resilience-fieldset__grid">
          <OptionalNumberConfigField
            scope={nodeId}
            label={t('rightPanel.resilience.retryAttempts')}
            value={retryAttempts}
            min={2}
            placeholder="3"
            onChange={(value) => patchRetry({ maxAttempts: value })}
          />
          <OptionalNumberConfigField
            scope={nodeId}
            label={t('rightPanel.resilience.initialDelayMs')}
            value={retryDelay}
            min={1}
            placeholder="1000"
            onChange={(value) => patchRetry({ delayMs: value })}
          />
          <OptionalNumberConfigField
            scope={nodeId}
            label={t('rightPanel.resilience.maxDelayMs')}
            value={retryMaxDelay}
            min={1}
            placeholder="30000"
            onChange={(value) => patchRetry({ maxDelayMs: value })}
          />
          <FormField id={fieldId(nodeId, 'retry backoff')} label={t('rightPanel.resilience.backoff')}>
            {controlProps => (
              <select
                {...controlProps}
                value={backoff}
                onChange={(event) => patchRetry({ backoff: event.target.value || undefined })}
              >
                <option value="">{t('rightPanel.resilience.backoffDefault')}</option>
                <option value="fixed">{t('rightPanel.resilience.backoffFixed')}</option>
                <option value="exponential">{t('rightPanel.resilience.backoffExponential')}</option>
              </select>
            )}
          </FormField>
        </div>
        <SwitchField
          checked={retry.jitter === true}
          label={t('rightPanel.resilience.jitter')}
          onChange={(event) => patchRetry({ jitter: event.target.checked })}
        />

        {/* With no classes selected the runtime retries every error. Choosing
            classes narrows retries to transient failures so client errors fail
            without consuming the full attempt budget. */}
        <div className="we-resilience-fieldset__retry-on" data-testid="resilience-retry-on">
          <strong className="ui-field__label">{t('rightPanel.resilience.retryOn.legend')}</strong>
          {RETRY_CLASSES.map((retryClass) => (
            <label key={retryClass.key} className="checkbox-row" title={t(retryClass.helperKey)}>
              <input
                type="checkbox"
                checked={selectedRetryClasses.has(retryClass.key)}
                data-testid={`resilience-retry-on-${retryClass.key}`}
                onChange={(event) => patchRetry({ retryOn: toggleRetryClass(retry.retryOn, retryClass.key, event.target.checked) })}
              />
              <span>{t(retryClass.labelKey)}</span>
            </label>
          ))}
          <p className="helper-text">
            {selectedRetryClasses.size === 0
              ? t('rightPanel.resilience.retryOn.allHelper')
              : t('rightPanel.resilience.retryOn.selectiveHelper')}
          </p>
        </div>

        <p className="helper-text">{t('rightPanel.resilience.retryHelper')}</p>

        {isHttp && (
          <div className="we-resilience-fieldset__http">
            <div className="we-resilience-fieldset__grid">
              <OptionalNumberConfigField
                scope={nodeId}
                label={t('rightPanel.resilience.timeoutMs')}
                value={readNumber(config.timeoutMs)}
                min={1}
                placeholder="30000"
                onChange={(value) => onPatch({ timeoutMs: value })}
              />
              <OptionalNumberConfigField
                scope={nodeId}
                label={t('rightPanel.resilience.maxResponseBytes')}
                value={readNumber(config.maxResponseBytes)}
                min={1}
                placeholder="1000000"
                onChange={(value) => onPatch({ maxResponseBytes: value })}
              />
              <OptionalNumberConfigField
                scope={nodeId}
                label={t('rightPanel.resilience.maxRedirects')}
                value={readNumber(config.maxRedirects)}
                min={0}
                placeholder="5"
                onChange={(value) => onPatch({ maxRedirects: value })}
              />
            </div>
            <p className="helper-text">{t('rightPanel.resilience.httpBoundsHelper')}</p>
          </div>
        )}

        {!isHttp && (
          <>
            <OptionalNumberConfigField
              scope={nodeId}
              label={t('rightPanel.resilience.timeoutMs')}
              value={readNumber(config.timeoutMs)}
              min={1}
              max={timeoutMax}
              placeholder="30000"
              onChange={(value) => onPatch({ timeoutMs: value })}
            />
            <p className="helper-text">
              {nodeType === 'mcp_tool'
                ? t('rightPanel.resilience.mcpTimeoutHelper')
                : t('rightPanel.resilience.timeoutHelper')}
            </p>
          </>
        )}
      </fieldset>
    </FormDisclosure>
  )
}
