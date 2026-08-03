/**
 * RecoveryCenterComposer — chat-style operator input + quick chips that
 * route to existing tabs (Runs / Inspector / Operations / Copilot).
 *
 * Self-contained: owns its own `value` / `busy` / `answer` state and calls
 * `/ai/explain-workflow` (Suggest fix / What changed / Summarize / Spend)
 * and `/ai/explain-run` (Why fail) directly. The chips route into the
 * relevant surface in one click when there's no workflow / run to ask
 * about. Used by `../RecoveryCenterPanel.tsx`.
 */

import React, { useState } from 'react'
import {
  ArrowUp,
  BarChart3,
  DollarSign,
  FileDiff,
  ShieldAlert,
  Sparkles,
  Wand2,
} from 'lucide-react'
import type { ActiveTab } from '../../types'
import { api } from '../../api'
import { useWorkflowStore } from '../../store'
import { useT } from '../../i18n'
import { t as runtimeT } from '../../i18n/runtime'

export function RecoveryCenterComposer({
  onOpenTab,
  recentDlqRunId,
}: {
  onOpenTab: (tab: ActiveTab) => void
  recentDlqRunId?: string
}) {
  const { t } = useT()
  const addToast = useWorkflowStore((state) => state.addToast)
  const nodes = useWorkflowStore((state) => state.nodes)
  const edges = useWorkflowStore((state) => state.edges)
  const currentWorkflowName = useWorkflowStore((state) => state.currentWorkflowName)
  const currentWorkflowId = useWorkflowStore((state) => state.currentWorkflowId)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [answer, setAnswer] = useState<{ text: string; mode: 'ai' | 'fallback'; aiError?: string } | null>(null)

  const buildWorkflowPayload = () => {
    return {
      id: currentWorkflowId,
      name: currentWorkflowName,
      nodes: nodes.map((node) => ({ id: node.id, type: node.data.type, config: node.data.config ?? {}, position: node.position })),
      edges: edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, data: edge.data })),
    }
  }

  const askWorkflow = async (prompt: string) => {
    if (nodes.length === 0) {
      addToast(runtimeT('recoveryCenter.composer.needWorkflow'), 'info')
      onOpenTab('copilot')
      return
    }
    setBusy(true)
    setAnswer(null)
    try {
      const result = await api('/ai/explain-workflow', {
        method: 'POST',
        body: JSON.stringify({ workflow: buildWorkflowPayload(), prompt }),
      }) as { mode?: 'ai' | 'fallback' | 'error'; explanation?: string; aiError?: string; error?: string }
      if (result.error) {
        addToast(result.error, 'error')
        return
      }
      const mode: 'ai' | 'fallback' = result.mode === 'ai' ? 'ai' : 'fallback'
      setAnswer({
        text: result.explanation ?? runtimeT('recoveryCenter.composer.noAnswer'),
        mode,
        aiError: result.aiError,
      })
    } catch (error) {
      addToast(error instanceof Error ? error.message : runtimeT('recoveryCenter.composer.callFailed'), 'error')
    } finally {
      setBusy(false)
    }
  }

  const askRun = async (runId: string, question: string) => {
    setBusy(true)
    setAnswer(null)
    try {
      const result = await api('/ai/explain-run', {
        method: 'POST',
        body: JSON.stringify({ runId, question }),
      }) as { mode?: 'ai' | 'fallback' | 'error'; explanation?: string; aiError?: string; error?: string }
      if (result.error) {
        addToast(result.error, 'error')
        return
      }
      const mode: 'ai' | 'fallback' = result.mode === 'ai' ? 'ai' : 'fallback'
      setAnswer({
        text: result.explanation ?? runtimeT('recoveryCenter.composer.noAnswer'),
        mode,
        aiError: result.aiError,
      })
    } catch (error) {
      addToast(error instanceof Error ? error.message : runtimeT('recoveryCenter.composer.callFailed'), 'error')
    } finally {
      setBusy(false)
    }
  }

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault()
    const prompt = value.trim()
    if (!prompt) return
    await askWorkflow(prompt)
    setValue('')
  }

  const handleWhyFail = () => {
    if (recentDlqRunId) {
      void askRun(recentDlqRunId, runtimeT('recoveryCenter.composer.chip.whyFail'))
    } else {
      onOpenTab('runs')
    }
  }

  const handleWhatChanged = () => {
    if (nodes.length === 0) {
      onOpenTab('inspector')
      return
    }
    void askWorkflow(runtimeT('recoveryCenter.composer.intent.whatChangedPrompt'))
  }

  const handleSuggestFix = () => {
    if (nodes.length === 0) {
      onOpenTab('operations')
      return
    }
    void askWorkflow(runtimeT('recoveryCenter.composer.intent.suggestFixPrompt'))
  }

  const handleSummarize = () => {
    if (nodes.length === 0) {
      onOpenTab('operations')
      return
    }
    void askWorkflow(runtimeT('recoveryCenter.composer.intent.summarizePrompt'))
  }

  const handleSpend = () => {
    if (nodes.length === 0) {
      onOpenTab('operations')
      return
    }
    void askWorkflow(runtimeT('recoveryCenter.composer.intent.spendPrompt'))
  }

  return (
    <section className="recovery-center-composer" data-testid="recovery-center-composer">
      <header className="recovery-center-composer__head">
        <span className="recovery-center-composer__avatar" aria-hidden="true">
          <Sparkles size={14} />
        </span>
        <div>
          <div className="section-kicker">{t('recoveryCenter.composer.kicker')}</div>
        </div>
      </header>

      <form className="recovery-center-composer__input" onSubmit={submit}>
        <Sparkles size={16} aria-hidden="true" />
        <input
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={t('recoveryCenter.composer.placeholder')}
          aria-label={t('recoveryCenter.composer.placeholder')}
          disabled={busy}
        />
        <button type="submit" className="recovery-center-composer__send" disabled={busy || value.trim().length === 0}>
          <ArrowUp size={13} aria-hidden="true" />
          <span>{busy ? t('recoveryCenter.composer.thinking') : t('recoveryCenter.composer.send')}</span>
        </button>
      </form>
      {answer && (
        <div className={`recovery-center-composer__answer recovery-center-composer__answer--${answer.mode}`} data-testid="recovery-center-composer-answer">
          <span className={`recovery-center-composer__answer-pill recovery-center-composer__answer-pill--${answer.mode}`}>{answer.mode === 'ai' ? t('recoveryCenter.composer.modeAi') : t('recoveryCenter.composer.modeFallback')}</span>
          <p>{answer.text}</p>
          {answer.aiError && <small className="recovery-center-composer__answer-error">{answer.aiError}</small>}
          <div className="recovery-center-composer__answer-acts">
            <button type="button" className="command-button command-button-compact" onClick={() => setAnswer(null)}>
              {t('recoveryCenter.composer.dismiss')}
            </button>
            <button type="button" className="command-button command-button-compact" onClick={() => onOpenTab('copilot')}>
              {t('recoveryCenter.composer.openStudio')}
            </button>
          </div>
        </div>
      )}
      {/* Chips ordered recovery-first: Suggest fix and Why fail (the two
          chips that touch Janusly's differentiator) come before the
          diagnostic + diff + spend chips. */}
      <div className="recovery-center-composer__chips">
        <button type="button" className="recovery-center-composer__chip recovery-center-composer__chip--primary" onClick={handleSuggestFix} disabled={busy}>
          <Wand2 size={11} aria-hidden="true" />
          <span>{t('recoveryCenter.composer.chip.suggestFix')}</span>
        </button>
        <button type="button" className="recovery-center-composer__chip" onClick={handleWhyFail} disabled={busy}>
          <ShieldAlert size={11} aria-hidden="true" />
          <span>{t('recoveryCenter.composer.chip.whyFail')}</span>
        </button>
        <button type="button" className="recovery-center-composer__chip" onClick={handleWhatChanged} disabled={busy}>
          <FileDiff size={11} aria-hidden="true" />
          <span>{t('recoveryCenter.composer.chip.whatChanged')}</span>
        </button>
        <button type="button" className="recovery-center-composer__chip" onClick={handleSummarize} disabled={busy}>
          <BarChart3 size={11} aria-hidden="true" />
          <span>{t('recoveryCenter.composer.chip.summarize')}</span>
        </button>
        <button type="button" className="recovery-center-composer__chip" onClick={handleSpend} disabled={busy}>
          <DollarSign size={11} aria-hidden="true" />
          <span>{t('recoveryCenter.composer.chip.spend')}</span>
        </button>
      </div>
    </section>
  )
}
