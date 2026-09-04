/**
 * Debounced next-fire preview for an unsaved schedule config. Parsing stays
 * server-side so authoring and runtime share cron-parser's exact grammar.
 */

import { useEffect, useState } from 'react'
import { contractApi } from '../api'
import { getResolvedLocale, useT } from '../i18n'

export type ScheduleCronPreviewKind = 'idle' | 'loading' | 'invalid' | 'error' | 'ready'

export type ScheduleCronPreviewSnapshot = {
  expression: string
  kind: ScheduleCronPreviewKind
}

type PreviewState = ScheduleCronPreviewSnapshot & {
  nextFires?: string[]
}

const PREVIEW_DEBOUNCE_MS = 250

export function ScheduleCronPreview({ expression, enabled, id, onStateChange }: {
  expression: string
  enabled: boolean
  id: string
  onStateChange?: (snapshot: ScheduleCronPreviewSnapshot) => void
}) {
  const { t } = useT()
  const [state, setState] = useState<PreviewState>({ expression: '', kind: 'idle' })
  const cron = expression.trim()
  const effectiveState: PreviewState = !enabled || cron.length === 0
    ? { expression: cron, kind: 'idle' }
    : state.expression === cron
      ? state
      : { expression: cron, kind: 'loading' }

  useEffect(() => {
    if (!enabled || cron.length === 0) {
      setState({ expression: '', kind: 'idle' })
      return
    }

    const controller = new AbortController()
    let active = true
    setState({ expression: cron, kind: 'loading' })
    const timeout = window.setTimeout(() => {
      contractApi('GET /workflows/schedule-preview', `/workflows/schedule-preview?cron=${encodeURIComponent(cron)}`, undefined, { signal: controller.signal })
        .then((payload) => {
          if (!active) return
          const preview = payload as { valid?: unknown; nextFires?: unknown }
          const nextFires = Array.isArray(preview.nextFires)
            ? preview.nextFires.filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)))
            : []
          setState(preview.valid === true && nextFires.length === 3
            ? { expression: cron, kind: 'ready', nextFires }
            : { expression: cron, kind: 'invalid' })
        })
        .catch((error: unknown) => {
          if (!active || (error instanceof Error && error.name === 'AbortError')) return
          setState({ expression: cron, kind: 'error' })
        })
    }, PREVIEW_DEBOUNCE_MS)

    return () => {
      active = false
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [cron, enabled])

  useEffect(() => {
    onStateChange?.({ expression: cron, kind: effectiveState.kind })
  }, [cron, effectiveState.kind, onStateChange])

  let content
  if (!enabled) content = <span className="helper-text">{t('rightPanel.quickConfig.cronPreviewPaused')}</span>
  else if (cron.length === 0) content = <span className="helper-text">{t('rightPanel.quickConfig.cronPreviewEmpty')}</span>
  else if (effectiveState.kind === 'loading') content = <span className="helper-text">{t('rightPanel.quickConfig.cronPreviewLoading')}</span>
  else if (effectiveState.kind === 'invalid') content = <span className="helper-text helper-text--error">{t('rightPanel.quickConfig.cronPreviewInvalid')}</span>
  else if (effectiveState.kind === 'error') content = <span className="helper-text helper-text--error">{t('rightPanel.quickConfig.cronPreviewError')}</span>
  else if (effectiveState.kind === 'ready') {
    const formatter = new Intl.DateTimeFormat(getResolvedLocale(), { dateStyle: 'medium', timeStyle: 'short' })
    content = (
      <>
        <strong>{t('rightPanel.quickConfig.cronPreviewTitle')}</strong>
        <ol>
          {(effectiveState.nextFires ?? []).map((value) => <li key={value}>{formatter.format(new Date(value))}</li>)}
        </ol>
      </>
    )
  } else content = null

  return <div id={id} className="we-cron-preview" aria-live="polite" data-state={effectiveState.kind}>{content}</div>
}
