import { ChevronDown } from 'lucide-react'
import { useState } from 'react'

import { Trans, useT } from '../i18n'
import type { JsonObject } from '../types'
import { ResilienceFieldset } from './ResilienceFieldset'
import {
  fieldId,
  OptionalJsonConfigField,
  OptionalNumberConfigField,
  readConfigNumber,
  readConfigString,
} from './quick-config-fields'

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
const METHODS_WITH_BODY = new Set<string>(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

function configuredOptionCount(config: JsonObject): number {
  return [
    config.headers !== undefined,
    config.bodyMode === 'stream',
    typeof config.streamPreviewBytes === 'number',
  ].filter(Boolean).length
}

export function HttpConfigEditor({
  nodeId,
  config,
  onUpdate,
}: {
  nodeId: string
  config: JsonObject
  onUpdate: (config: Record<string, unknown>) => void
}) {
  const { t } = useT()
  const method = HTTP_METHODS.includes(config.method as typeof HTTP_METHODS[number])
    ? config.method as typeof HTTP_METHODS[number]
    : 'GET'
  const responseMode = config.bodyMode === 'stream' ? 'stream' : 'buffer'
  const bodySupported = METHODS_WITH_BODY.has(method)
  const bodyConfigured = config.body !== undefined
  const optionCount = configuredOptionCount(config)
  const [optionsOpen, setOptionsOpen] = useState(optionCount > 0)
  const patch = (next: Record<string, unknown>) => onUpdate({ ...config, ...next })
  const replaceKeys = (keys: string[], next: Record<string, unknown>) => {
    const updated: Record<string, unknown> = { ...config }
    for (const key of keys) delete updated[key]
    onUpdate({ ...updated, ...next })
  }
  const methodId = fieldId(nodeId, 'http method')
  const urlId = fieldId(nodeId, 'request url')
  const bodyHelperId = `${fieldId(nodeId, 'request body')}-helper`

  return (
    <section className="quick-config" data-testid="http-config">
      <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
      <div className="we-http-request-row">
        <div className="config-field-row we-http-request-row__method">
          <label className="field-label" htmlFor={methodId}>{t('rightPanel.resilience.httpMethod')}</label>
          <select
            id={methodId}
            className="text-field"
            value={method}
            onChange={(event) => patch({ method: event.target.value })}
          >
            {HTTP_METHODS.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </div>
        <div className="config-field-row we-http-request-row__url">
          <label className="field-label" htmlFor={urlId}>{t('rightPanel.quickConfig.requestUrl')}</label>
          <input
            id={urlId}
            className="text-field"
            type="url"
            inputMode="url"
            value={readConfigString(config, 'url')}
            placeholder="https://api.example.com"
            onChange={(event) => patch({ url: event.target.value })}
          />
        </div>
      </div>

      {(bodySupported || bodyConfigured) && (
        <>
          <OptionalJsonConfigField
            scope={nodeId}
            label={t('rightPanel.quickConfig.requestBody')}
            value={config.body}
            describedBy={bodyHelperId}
            placeholder={t('rightPanel.quickConfig.requestBodyPlaceholder')}
            onChange={(body) => {
              if (body === undefined) replaceKeys(['body'], {})
              else patch({ body })
            }}
          />
          <p
            id={bodyHelperId}
            className={bodySupported ? 'helper-text' : 'helper-text helper-text--error'}
          >
            {t(bodySupported
              ? 'rightPanel.quickConfig.requestBodyHelper'
              : 'rightPanel.quickConfig.requestBodyUnsupported')}
          </p>
        </>
      )}

      <details
        className="we-config-disclosure"
        data-testid="http-options"
        open={optionsOpen}
        onToggle={(event) => setOptionsOpen(event.currentTarget.open)}
      >
        <summary>
          <span>
            <strong>{t('rightPanel.quickConfig.requestOptions')}</strong>
            <small>{optionCount > 0
              ? t('rightPanel.quickConfig.configuredOptions', { count: optionCount })
              : t('rightPanel.quickConfig.defaultOptions')}</small>
          </span>
          <ChevronDown size={15} aria-hidden="true" />
        </summary>
        <div className="we-config-disclosure__body">
          <OptionalJsonConfigField
            scope={nodeId}
            label={t('rightPanel.resilience.headers')}
            value={config.headers}
            placeholder={t('rightPanel.quickConfig.headersPlaceholder')}
            onChange={(headers) => {
              if (headers === undefined) replaceKeys(['headers'], {})
              else patch({ headers })
            }}
          />
          <div className="config-field-row">
            <label className="field-label" htmlFor={fieldId(nodeId, 'response mode')}>
              {t('rightPanel.quickConfig.responseMode')}
            </label>
            <select
              id={fieldId(nodeId, 'response mode')}
              className="text-field"
              value={responseMode}
              onChange={(event) => {
                if (event.target.value === 'stream') patch({ bodyMode: 'stream' })
                else replaceKeys(['bodyMode', 'streamPreviewBytes'], {})
              }}
            >
              <option value="buffer">{t('rightPanel.quickConfig.responseBuffered')}</option>
              <option value="stream">{t('rightPanel.quickConfig.responseStream')}</option>
            </select>
          </div>
          {responseMode === 'stream' && (
            <OptionalNumberConfigField
              scope={nodeId}
              label={t('rightPanel.quickConfig.streamPreviewBytes')}
              value={readConfigNumber(config, 'streamPreviewBytes')}
              min={1_024}
              max={1_048_576}
              placeholder="65536"
              onChange={(streamPreviewBytes) => {
                if (streamPreviewBytes === undefined) replaceKeys(['streamPreviewBytes'], {})
                else patch({ streamPreviewBytes })
              }}
            />
          )}
          <p className="helper-text">
            {t(responseMode === 'stream'
              ? 'rightPanel.quickConfig.responseStreamHelper'
              : 'rightPanel.quickConfig.responseBufferedHelper')}
          </p>
        </div>
      </details>

      <p className="helper-text" data-testid="http-json-contract-helper">
        <Trans i18nKey="rightPanel.quickConfig.httpJsonHelper" components={{ code: <code /> }} />
      </p>
      <ResilienceFieldset nodeId={nodeId} nodeType="http" config={config} onPatch={patch} />
    </section>
  )
}
