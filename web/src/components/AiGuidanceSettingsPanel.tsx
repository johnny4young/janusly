/** Organization-wide janusly.md guidance editor for AI authoring/recovery. */

import { useEffect, useRef, useState } from 'react'
import { RefreshCw, Save } from 'lucide-react'
import {
  AI_OPERATOR_GUIDANCE_SCOPE_MAX_BYTES,
  containsOperatorGuidanceSecret,
} from '@/lib/operator-guidance'

import { api } from '../api'
import { getResolvedLocale, tApiError, useT } from '../i18n'
import { useWorkflowStore } from '../store'
import { Button } from './ui/Button'
import { FormActions, FormField } from './ui/Form'
import { StatusSummary } from './ui/StatusSummary'
import { isRecord } from '../lib/guards'
import { orgConfigValue } from '../lib/org-config-model'
import { PLATFORM_TAG, useInvalidationNonce } from '@/lib/query-cache'

type GuidanceLoadState = 'loading' | 'ready' | 'error'

function readGuidance(payload: unknown): string | null {
  if (!Array.isArray(payload) && !(isRecord(payload) && Array.isArray(payload.config))) return null
  const value = orgConfigValue(payload, 'ai.operatorGuidance')
  return typeof value === 'string' ? value : null
}

const GUIDANCE_TAGS = [PLATFORM_TAG, 'org-config'] as const

export function AiGuidanceSettingsPanel() {
  const { t } = useT()
  const addToast = useWorkflowStore(state => state.addToast)
  const bumpPlatformVersion = useWorkflowStore(state => state.bumpPlatformVersion)
  const platformVersion = useInvalidationNonce(GUIDANCE_TAGS)
  const [guidance, setGuidance] = useState('')
  const [loadState, setLoadState] = useState<GuidanceLoadState>('loading')
  const [reloadNonce, setReloadNonce] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirtyRef = useRef(false)
  const readyRef = useRef(false)
  const requestEpochRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const epoch = requestEpochRef.current + 1
    requestEpochRef.current = epoch
    if (!readyRef.current) {
      setLoadState('loading')
      setError(null)
    }
    // A user-triggered retry must be a fresh request. Passing a signal opts
    // this read out of api()'s short in-flight dedup window, which otherwise
    // could replay the same rejected or malformed response for 500 ms.
    api('/org/config', { signal: controller.signal }).then(payload => {
      if (cancelled || requestEpochRef.current !== epoch) return
      const value = readGuidance(payload)
      if (value === null) {
        if (!readyRef.current) setLoadState('error')
        setError(t('aiGuidance.error.load'))
        return
      }
      if (!dirtyRef.current) {
        setGuidance(value)
      }
      setError(null)
      readyRef.current = true
      setLoadState('ready')
    }).catch(error => {
      if (cancelled || requestEpochRef.current !== epoch) return
      if (!readyRef.current) setLoadState('error')
      setError(tApiError(error) || t('aiGuidance.error.load'))
    })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [platformVersion, reloadNonce, t])

  const byteLength = new TextEncoder().encode(guidance).byteLength
  const overCap = byteLength > AI_OPERATOR_GUIDANCE_SCOPE_MAX_BYTES
  const hasSecret = containsOperatorGuidanceSecret(guidance)
  const validationError = overCap || hasSecret ? (
    <>
      {overCap ? t('aiGuidance.field.overCap') : null}
      {overCap && hasSecret ? ' · ' : null}
      {hasSecret ? t('aiGuidance.field.secret') : null}
    </>
  ) : undefined

  const save = async () => {
    if (saving || overCap || hasSecret || loadState !== 'ready') return
    setSaving(true)
    setError(null)
    try {
      await api('/org/config', {
        method: 'POST',
        body: JSON.stringify({ key: 'ai.operatorGuidance', value: guidance }),
      })
      requestEpochRef.current += 1
      dirtyRef.current = false
      addToast(t('aiGuidance.toast.saved'), 'success')
      bumpPlatformVersion()
    } catch (error) {
      setError(tApiError(error) || t('aiGuidance.error.save'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section
      className="we-card we-ai-guidance-settings"
      aria-labelledby="ai-guidance-settings-title"
      data-testid="ai-guidance-settings"
    >
      <div className="section-kicker">{t('aiGuidance.kicker')}</div>
      <h3 id="ai-guidance-settings-title">{t('aiGuidance.title')}</h3>
      <p className="helper-text">{t('aiGuidance.description')}</p>
      {error && (
        <StatusSummary
          role="alert"
          tone="danger"
          title={error}
          actions={(
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setReloadNonce(value => value + 1)}
              disabled={saving || loadState === 'loading'}
              leadingIcon={<RefreshCw size={14} />}
              data-testid="ai-guidance-org-retry"
            >
              {t('aiGuidance.action.retry')}
            </Button>
          )}
        />
      )}
      <FormField
        id="ai-guidance-org"
        label={t('aiGuidance.field.label')}
        hint={(
          <>
            {t('aiGuidance.field.help')} · {byteLength.toLocaleString(getResolvedLocale())}/{AI_OPERATOR_GUIDANCE_SCOPE_MAX_BYTES.toLocaleString(getResolvedLocale())} {t('workflowMetadata.field.runbookUnit')}
          </>
        )}
        error={validationError}
      >
        {(controlProps) => (
          <textarea
            {...controlProps}
            rows={8}
            value={guidance}
            onChange={event => {
              dirtyRef.current = true
              setGuidance(event.target.value)
            }}
            placeholder={t('aiGuidance.field.placeholder')}
            disabled={loadState !== 'ready' || saving}
            data-testid="ai-guidance-org-input"
          />
        )}
      </FormField>
      <FormActions>
        <Button
          variant="primary"
          onClick={() => void save()}
          disabled={loadState !== 'ready' || saving || overCap || hasSecret}
          loading={saving}
          loadingLabel={t('aiGuidance.action.saving')}
          leadingIcon={<Save size={15} />}
          data-testid="ai-guidance-org-save"
        >
          {t('aiGuidance.action.save')}
        </Button>
      </FormActions>
    </section>
  )
}
