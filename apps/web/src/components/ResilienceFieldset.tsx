/**
 * Shared operational controls for node types that call an external system.
 *
 * Used by:
 * - `QuickConfigEditor.tsx` for http, tool, agent, and mcp_tool nodes.
 * - `WorkflowReadinessBadge.tsx` through the resilience-focus handoff.
 *
 * The controls only write config keys the engine already consumes: `retry`,
 * `timeoutMs`, and (for HTTP) request bounds and request metadata.
 */

import { useCallback, useEffect, useRef } from 'react'

import type { JsonObject } from '../types'
import { useT } from '../i18n'
import {
  fieldId,
  JsonConfigField,
  OptionalNumberConfigField,
} from './quick-config-fields'
import {
  consumeResilienceFocus,
  RESILIENCE_FOCUS_EVENT,
} from './resilience-focus-bus'

type ResilienceNodeType = 'http' | 'tool' | 'agent' | 'mcp_tool'

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const

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

  const focusFieldset = useCallback(() => {
    const fieldset = fieldsetRef.current
    if (!fieldset) return
    fieldset.scrollIntoView?.({ block: 'nearest' })
    fieldset.focus({ preventScroll: true })
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
  const retryAttempts = readNumber(retry.maxAttempts)
  const retryDelay = readNumber(retry.delayMs)
  const retryMaxDelay = readNumber(retry.maxDelayMs)
  const backoff = readBackoff(retry.backoff)
  const method = typeof config.method === 'string' && HTTP_METHODS.includes(config.method as typeof HTTP_METHODS[number])
    ? config.method
    : 'GET'

  return (
    <fieldset
      ref={fieldsetRef}
      className="we-resilience-fieldset"
      tabIndex={-1}
      data-testid="resilience-fieldset"
    >
      <legend>{t('rightPanel.resilience.legend')}</legend>
      <p className="helper-text">{t('rightPanel.resilience.helper')}</p>

      <div className="we-resilience-fieldset__grid">
        <OptionalNumberConfigField
          scope={nodeId}
          label={t('rightPanel.resilience.retryAttempts') as string}
          value={retryAttempts}
          min={2}
          placeholder="3"
          onChange={(value) => patchRetry({ maxAttempts: value })}
        />
        <OptionalNumberConfigField
          scope={nodeId}
          label={t('rightPanel.resilience.initialDelayMs') as string}
          value={retryDelay}
          min={1}
          placeholder="1000"
          onChange={(value) => patchRetry({ delayMs: value })}
        />
        <OptionalNumberConfigField
          scope={nodeId}
          label={t('rightPanel.resilience.maxDelayMs') as string}
          value={retryMaxDelay}
          min={1}
          placeholder="30000"
          onChange={(value) => patchRetry({ maxDelayMs: value })}
        />
        <div className="config-field-row">
          <label className="field-label" htmlFor={fieldId(nodeId, 'retry backoff')}>{t('rightPanel.resilience.backoff')}</label>
          <select
            id={fieldId(nodeId, 'retry backoff')}
            className="text-field"
            value={backoff}
            onChange={(event) => patchRetry({ backoff: event.target.value || undefined })}
          >
            <option value="">{t('rightPanel.resilience.backoffDefault')}</option>
            <option value="fixed">{t('rightPanel.resilience.backoffFixed')}</option>
            <option value="exponential">{t('rightPanel.resilience.backoffExponential')}</option>
          </select>
        </div>
      </div>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={retry.jitter === true}
          onChange={(event) => patchRetry({ jitter: event.target.checked })}
        />
        <span>{t('rightPanel.resilience.jitter')}</span>
      </label>
      <p className="helper-text">{t('rightPanel.resilience.retryHelper')}</p>

      {isHttp && (
        <div className="we-resilience-fieldset__http">
          <div className="config-field-row">
            <label className="field-label" htmlFor={fieldId(nodeId, 'http method')}>{t('rightPanel.resilience.httpMethod')}</label>
            <select
              id={fieldId(nodeId, 'http method')}
              className="text-field"
              value={method}
              onChange={(event) => onPatch({ method: event.target.value })}
            >
              {HTTP_METHODS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </div>
          <JsonConfigField
            scope={nodeId}
            label={t('rightPanel.resilience.headers') as string}
            value={asRecord(config.headers)}
            onChange={(headers) => onPatch({ headers })}
          />
          <div className="we-resilience-fieldset__grid">
            <OptionalNumberConfigField
              scope={nodeId}
              label={t('rightPanel.resilience.timeoutMs') as string}
              value={readNumber(config.timeoutMs)}
              min={1}
              placeholder="30000"
              onChange={(value) => onPatch({ timeoutMs: value })}
            />
            <OptionalNumberConfigField
              scope={nodeId}
              label={t('rightPanel.resilience.maxResponseBytes') as string}
              value={readNumber(config.maxResponseBytes)}
              min={1}
              placeholder="1000000"
              onChange={(value) => onPatch({ maxResponseBytes: value })}
            />
            <OptionalNumberConfigField
              scope={nodeId}
              label={t('rightPanel.resilience.maxRedirects') as string}
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
            label={t('rightPanel.resilience.timeoutMs') as string}
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
  )
}
