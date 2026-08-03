/** Organization-wide janusly.md guidance editor for AI authoring/recovery. */

import { useEffect, useRef, useState } from 'react'
import {
  AI_OPERATOR_GUIDANCE_SCOPE_MAX_BYTES,
  containsOperatorGuidanceSecret,
} from '@/lib/operator-guidance'

import { api } from '../api'
import { getResolvedLocale, tApiError, useT } from '../i18n'
import { useWorkflowStore } from '../store'

type OrgConfigEntry = { key: string; value: string | number | boolean }
type GuidanceLoadState = 'loading' | 'ready' | 'error'

function readGuidance(payload: unknown): string | null {
  const envelope = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as { config?: unknown }
    : null
  const entries = Array.isArray(payload) ? payload : Array.isArray(envelope?.config) ? envelope.config : null
  if (!entries) return null
  const entry = entries.find((candidate): candidate is OrgConfigEntry => (
    candidate !== null
    && typeof candidate === 'object'
    && !Array.isArray(candidate)
    && (candidate as { key?: unknown }).key === 'ai.operatorGuidance'
  ))
  return typeof entry?.value === 'string' ? entry.value : null
}

export function AiGuidanceSettingsPanel() {
  const { t } = useT()
  const addToast = useWorkflowStore(state => state.addToast)
  const bumpPlatformVersion = useWorkflowStore(state => state.bumpPlatformVersion)
  const platformVersion = useWorkflowStore(state => state.platformVersion)
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
      <label className="we-field">
        <span>
          {t('aiGuidance.field.label')}{' '}
          <span className="helper-text">
            ({byteLength.toLocaleString(getResolvedLocale())}/{AI_OPERATOR_GUIDANCE_SCOPE_MAX_BYTES.toLocaleString(getResolvedLocale())} {t('workflowMetadata.field.runbookUnit')})
          </span>
        </span>
        <textarea
          rows={8}
          value={guidance}
          onChange={event => {
            dirtyRef.current = true
            setGuidance(event.target.value)
          }}
          placeholder={t('aiGuidance.field.placeholder')}
          disabled={loadState !== 'ready' || saving}
          aria-invalid={overCap || hasSecret}
          data-testid="ai-guidance-org-input"
        />
        <span className="helper-text">{t('aiGuidance.field.help')}</span>
        {overCap && <span className="helper-text we-helper-text--error">{t('aiGuidance.field.overCap')}</span>}
        {hasSecret && <span className="helper-text we-helper-text--error">{t('aiGuidance.field.secret')}</span>}
      </label>
      {error && <p className="helper-text we-helper-text--error" role="alert">{error}</p>}
      <div className="we-ai-guidance-settings__actions">
        {error && (
          <button
            type="button"
            className="command-button"
            onClick={() => setReloadNonce(value => value + 1)}
            disabled={saving || loadState === 'loading'}
            data-testid="ai-guidance-org-retry"
          >
            {t('aiGuidance.action.retry')}
          </button>
        )}
        <button
          type="button"
          className="command-button command-button-primary"
          onClick={() => void save()}
          disabled={loadState !== 'ready' || saving || overCap || hasSecret}
          data-testid="ai-guidance-org-save"
        >
          {saving ? t('aiGuidance.action.saving') : t('aiGuidance.action.save')}
        </button>
      </div>
    </section>
  )
}
