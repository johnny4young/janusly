/**
 * Run-level Q&A chat — calls `/ai/explain-run` for the selected run id.
 * Surfaces the `mode` ("ai" / "fallback") + `aiError` chip per AGENTS.md
 * fallback contract; also shows the resolved `model` when AI mode succeeds.
 *
 * Used by `RightPanel.tsx` (Runs tab → AI Run Explainer card).
 */

import React, { useState } from 'react'
import { api } from '../api'
import { formatAiModeLabel } from '../constants'
import type { AiMode } from '../types'
import { useT } from '../i18n'

type Message = {
  role: 'user' | 'assistant'
  content: string
  mode?: AiMode
  model?: string
}

type ExplainRunResponse = {
  answer?: string
  mode?: AiMode
  model?: string
  error?: string
  aiError?: string
}

/** Conversational explainer for the active run. Shows mode chip + aiError when present. */
export function RunExplainChat({ runId }: { runId?: string | null }) {
  const { t } = useT()
  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)

  function describeAiError(message: string): string {
    if (/quota|billing|insufficient_quota/i.test(message)) return t('runExplain.errorQuota')
    if (/rate limit/i.test(message)) return t('runExplain.errorRate')
    if (/invalid api key|incorrect api key|unauthorized/i.test(message)) return t('runExplain.errorAuth')
    return message
  }

  const starterQuestions: string[] = [
    t('runExplain.starter1') as string,
    t('runExplain.starter2') as string,
    t('runExplain.starter3') as string,
  ]

  const ask = async () => {
    if (!runId || !question.trim()) return

    const userMessage: Message = { role: 'user', content: question.trim() }
    setMessages((current) => [...current, userMessage])
    setQuestion('')
    setLoading(true)

    try {
      const response = await api('/ai/explain-run', {
        method: 'POST',
        body: JSON.stringify({ runId, question: userMessage.content }),
      }) as ExplainRunResponse

      if (response.error) throw new Error(response.error)

      const baseAnswer = response.answer ?? (t('runExplain.noAnswer') as string)
      const body = response.aiError
        ? `${baseAnswer}\n\n${t('runExplain.noteFailed', { detail: describeAiError(response.aiError) })}`
        : baseAnswer

      setMessages((current) => [
        ...current,
        {
          role: 'assistant',
          content: body,
          mode: response.mode ?? 'fallback',
          model: response.model,
        },
      ])
    } catch (error) {
      setMessages((current) => [
        ...current,
        { role: 'assistant', content: error instanceof Error ? error.message : (t('runExplain.failed') as string) },
      ])
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="panel-card">
      <div className="split-row">
        <div>
          <strong>{t('runExplain.title')}</strong>
          <p className="helper-text">{t('runExplain.helper')}</p>
        </div>
        <span className="section-kicker">{t('runExplain.kicker')}</span>
      </div>

      {!runId && <p className="empty-state">{t('runExplain.empty')}</p>}

      <div className="panel-list">
        {messages.map((message, index) => (
          <div key={`${message.role}-${index}`} className={`message-card message-card-${message.role}`}>
            <div className="split-row">
              <span className="section-kicker">{message.role === 'user' ? t('runExplain.you') : t('runExplain.assistant')}</span>
              {message.mode && (
                <span className={`mode-pill mode-pill-${message.mode}`}>
                  {message.model ? `${formatAiModeLabel(message.mode)} · ${message.model}` : formatAiModeLabel(message.mode)}
                </span>
              )}
            </div>
            {message.role === 'assistant' && message.mode === 'fallback' && (
              // Make degraded answers obvious at the top of the bubble — not
              // just an inline pill — so heuristics aren't read as AI output.
              <div className="issue issue-warn" role="alert">
                <strong>{t('runExplain.fallbackBannerTitle')}</strong>{' '}
                <span>{t('runExplain.fallbackBannerBody')}</span>
              </div>
            )}
            <div className="message-body">{message.content}</div>
          </div>
        ))}
      </div>

      <div className="chat-starters" aria-label={t('runExplain.starterAria')}>
        {starterQuestions.map((starter) => (
          <button
            key={starter}
            className="small-command"
            disabled={!runId || loading}
            onClick={() => setQuestion(starter)}
            type="button"
          >
            {starter}
          </button>
        ))}
      </div>

      <textarea
        className="code-field code-field-short"
        value={question}
        disabled={!runId || loading}
        onChange={(event) => setQuestion(event.target.value)}
        placeholder={t('runExplain.placeholder')}
      />

      <button className="command-button command-button-primary" disabled={!runId || loading || !question.trim()} onClick={ask}>
        {loading ? t('runExplain.explaining') : t('runExplain.ask')}
      </button>
    </section>
  )
}
