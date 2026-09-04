import { ChevronDown } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { api } from '../api'
import { Trans, useT } from '../i18n'
import type { JsonObject } from '../types'
import {
  fieldId,
  OptionalJsonConfigField,
  OptionalNumberConfigField,
  readConfigString,
  TextareaConfigField,
} from './quick-config-fields'
import { FormDisclosure, FormField } from './ui/Form'
import { asRecordOrEmpty as asRecord } from '../lib/guards'

type AiResponseMode = 'text' | 'json' | 'structured'
type PromptSource = 'inline' | 'saved'

type PromptSummary = {
  name: string
  description: string | null
}

const DEFAULT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    result: { type: 'string' },
  },
  required: ['result'],
}

function readPromptRef(config: JsonObject): { name: string; version?: number } | null {
  const ref = asRecord(config.promptRef)
  if (typeof ref.name !== 'string' || !ref.name.trim()) return null
  return {
    name: ref.name,
    ...(typeof ref.version === 'number' && Number.isInteger(ref.version) && ref.version > 0
      ? { version: ref.version }
      : {}),
  }
}

function readResponseMode(config: JsonObject): AiResponseMode {
  if (config.outputSchema !== undefined) return 'structured'
  return config.responseFormat === 'json' ? 'json' : 'text'
}

function parsePromptList(value: unknown): PromptSummary[] {
  const rows = asRecord(value).prompts
  if (!Array.isArray(rows)) return []
  const names = new Set<string>()
  return rows.flatMap((row) => {
    const record = asRecord(row)
    if (typeof record.name !== 'string') return []
    const name = record.name.trim()
    if (!name || names.has(name) || names.size >= 200) return []
    names.add(name)
    return [{
      name,
      description: typeof record.description === 'string' ? record.description : null,
    }]
  })
}

export function AiConfigEditor({
  nodeId,
  config,
  onUpdate,
}: {
  nodeId: string
  config: JsonObject
  onUpdate: (config: Record<string, unknown>) => void
}) {
  const { t } = useT()
  const promptRef = readPromptRef(config)
  const responseMode = readResponseMode(config)
  const [promptSource, setPromptSource] = useState<PromptSource>(promptRef ? 'saved' : 'inline')
  const [prompts, setPrompts] = useState<PromptSummary[]>([])
  const [promptsLoading, setPromptsLoading] = useState(false)
  const [promptsUnavailable, setPromptsUnavailable] = useState(false)
  const configuredAdvancedCount = [
    typeof config.model === 'string' && config.model.length > 0,
    promptSource === 'saved' && promptRef?.version !== undefined,
    promptSource === 'saved' && config.variables !== undefined,
  ].filter(Boolean).length
  const [advancedOpen, setAdvancedOpen] = useState(configuredAdvancedCount > 0)
  const patch = (next: Record<string, unknown>) => onUpdate({ ...config, ...next })
  const replaceKeys = (keys: string[], next: Record<string, unknown>) => {
    const updated: Record<string, unknown> = { ...config }
    for (const key of keys) delete updated[key]
    onUpdate({ ...updated, ...next })
  }
  const promptSourceId = fieldId(nodeId, 'prompt source')
  const promptNameId = fieldId(nodeId, 'saved prompt')
  const responseModeId = fieldId(nodeId, 'ai response mode')
  const modelId = fieldId(nodeId, 'model override')
  const outputHelperId = `${responseModeId}-helper`

  useEffect(() => {
    setPromptSource(promptRef ? 'saved' : 'inline')
  }, [nodeId, promptRef?.name])

  useEffect(() => {
    setAdvancedOpen(configuredAdvancedCount > 0)
  }, [nodeId])

  useEffect(() => {
    if (promptSource !== 'saved') return
    const controller = new AbortController()
    setPromptsLoading(true)
    setPromptsUnavailable(false)
    void api('/prompts', { signal: controller.signal })
      .then((payload) => {
        setPrompts(parsePromptList(payload))
        setPromptsLoading(false)
      })
      .catch((error) => {
        if ((error as { name?: string }).name === 'AbortError') return
        setPrompts([])
        setPromptsLoading(false)
        setPromptsUnavailable(true)
      })
    return () => controller.abort()
  }, [nodeId, promptSource])

  const promptOptions = useMemo(() => {
    if (!promptRef || prompts.some((prompt) => prompt.name === promptRef.name)) return prompts
    return [{ name: promptRef.name, description: null }, ...prompts]
  }, [promptRef, prompts])

  const selectedPrompt = promptOptions.find((prompt) => prompt.name === promptRef?.name) ?? null

  const changeResponseMode = (nextMode: AiResponseMode) => {
    if (nextMode === 'text') {
      replaceKeys(['responseFormat', 'outputSchema'], {})
      return
    }
    if (nextMode === 'json') {
      replaceKeys(['outputSchema'], { responseFormat: 'json' })
      return
    }
    replaceKeys(['responseFormat'], {
      outputSchema: config.outputSchema ?? DEFAULT_OUTPUT_SCHEMA,
    })
  }

  return (
    <section className="quick-config" data-testid="ai-config">
      <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>

      <FormField id={promptSourceId} label={t('rightPanel.quickConfig.ai.promptSource')}>
        {controlProps => (
          <select
            {...controlProps}
            value={promptSource}
            onChange={(event) => {
              const source = event.target.value as PromptSource
              setPromptSource(source)
              if (source === 'inline') {
                replaceKeys(['promptRef', 'variables'], { prompt: readConfigString(config, 'prompt') })
              } else {
                replaceKeys(['prompt'], {})
              }
            }}
          >
            <option value="inline">{t('rightPanel.quickConfig.ai.promptInline')}</option>
            <option value="saved">{t('rightPanel.quickConfig.ai.promptSaved')}</option>
          </select>
        )}
      </FormField>

      {promptSource === 'inline' ? (
        <TextareaConfigField
          scope={nodeId}
          label={t('rightPanel.quickConfig.prompt')}
          value={readConfigString(config, 'prompt')}
          onChange={(prompt) => patch({ prompt })}
        />
      ) : (
        <>
          <FormField id={promptNameId} label={t('rightPanel.quickConfig.ai.savedPrompt')}>
            {controlProps => (
              <select
                {...controlProps}
                value={promptRef?.name ?? ''}
                disabled={promptsLoading && promptOptions.length === 0}
                onChange={(event) => {
                  const name = event.target.value
                  if (!name) replaceKeys(['prompt', 'promptRef', 'variables'], {})
                  else replaceKeys(['prompt', 'promptRef', 'variables'], { promptRef: { name } })
                }}
              >
                <option value="">{t(promptsLoading
                  ? 'rightPanel.quickConfig.ai.promptsLoading'
                  : 'rightPanel.quickConfig.ai.pickPrompt')}</option>
                {promptOptions.map((prompt) => (
                  <option key={prompt.name} value={prompt.name}>{prompt.name}</option>
                ))}
              </select>
            )}
          </FormField>
          {selectedPrompt?.description && <p className="helper-text">{selectedPrompt.description}</p>}
          {!promptsLoading && promptsUnavailable && (
            <p className="helper-text" data-testid="ai-prompts-empty">
              {t('rightPanel.quickConfig.ai.promptsUnavailable')}
            </p>
          )}
          {!promptsLoading && !promptsUnavailable && promptOptions.length === 0 && (
            <p className="helper-text" data-testid="ai-prompts-empty">
              {t('rightPanel.quickConfig.ai.promptsEmpty')}
            </p>
          )}
        </>
      )}

      <FormField id={responseModeId} label={t('rightPanel.quickConfig.ai.responseMode')}>
        {controlProps => (
          <select
            {...controlProps}
            value={responseMode}
            aria-describedby={outputHelperId}
            onChange={(event) => changeResponseMode(event.target.value as AiResponseMode)}
          >
            <option value="text">{t('rightPanel.quickConfig.ai.responseText')}</option>
            <option value="json">{t('rightPanel.quickConfig.ai.responseJson')}</option>
            <option value="structured">{t('rightPanel.quickConfig.ai.responseStructured')}</option>
          </select>
        )}
      </FormField>

      {responseMode === 'structured' && (
        <OptionalJsonConfigField
          scope={nodeId}
          label={t('rightPanel.quickConfig.ai.outputSchema')}
          value={config.outputSchema}
          describedBy={outputHelperId}
          onChange={(outputSchema) => {
            if (outputSchema === undefined) replaceKeys(['outputSchema'], {})
            else patch({ outputSchema })
          }}
        />
      )}

      <p id={outputHelperId} className="helper-text" data-testid="ai-output-helper">
        <Trans
          i18nKey={`rightPanel.quickConfig.ai.response.${responseMode}.helper`}
          components={{ code: <code /> }}
        />
      </p>

      <FormDisclosure
        data-testid="ai-options"
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
        summary={(
          <span className="ui-config-disclosure-summary">
            <span>
              <strong>{t('rightPanel.quickConfig.ai.advanced')}</strong>
              <small>{configuredAdvancedCount > 0
                ? t('rightPanel.quickConfig.configuredOptions', { count: configuredAdvancedCount })
                : t('rightPanel.quickConfig.defaultOptions')}</small>
            </span>
            <ChevronDown size={15} aria-hidden="true" />
          </span>
        )}
      >
          {promptSource === 'saved' && promptRef && (
            <>
              <OptionalNumberConfigField
                scope={nodeId}
                label={t('rightPanel.quickConfig.ai.promptVersion')}
                value={promptRef.version ?? null}
                min={1}
                placeholder={t('rightPanel.quickConfig.ai.promptVersionPlaceholder')}
                onChange={(version) => patch({
                  promptRef: {
                    name: promptRef.name,
                    ...(version === undefined ? {} : { version }),
                  },
                })}
              />
              <OptionalJsonConfigField
                scope={nodeId}
                label={t('rightPanel.quickConfig.ai.promptVariables')}
                value={config.variables}
                placeholder={'{\n  "customer": "{{context.input.customer}}"\n}'}
                onChange={(variables) => {
                  if (variables === undefined) replaceKeys(['variables'], {})
                  else patch({ variables })
                }}
              />
            </>
          )}
          <FormField
            id={modelId}
            label={t('rightPanel.quickConfig.ai.model')}
            hint={t('rightPanel.quickConfig.ai.modelHelper')}
          >
            {controlProps => (
              <input
                {...controlProps}
                value={readConfigString(config, 'model')}
                placeholder={t('rightPanel.quickConfig.ai.modelPlaceholder')}
                onChange={(event) => {
                  const model = event.target.value
                  if (!model) replaceKeys(['model'], {})
                  else patch({ model })
                }}
              />
            )}
          </FormField>
      </FormDisclosure>

      <p className="helper-text" data-testid="ai-fallback-helper">
        {t('rightPanel.quickConfig.ai.fallbackHelper')}
      </p>
    </section>
  )
}
