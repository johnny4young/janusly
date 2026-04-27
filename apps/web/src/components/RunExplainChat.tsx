import React, { useState } from 'react'
import { api } from '../api'
import { formatAiModeLabel } from '../constants'
import type { AiMode } from '../types'

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
}

const starterQuestions = [
  'What happened in this run?',
  'What should I check next?',
  'Did anything need a retry or approval?',
]

export function RunExplainChat({ runId }: { runId?: string | null }) {
  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)

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

      setMessages((current) => [
        ...current,
        {
          role: 'assistant',
          content: response.answer ?? 'No explanation available.',
          mode: response.mode ?? 'fallback',
          model: response.model,
        },
      ])
    } catch (error) {
      setMessages((current) => [
        ...current,
        { role: 'assistant', content: error instanceof Error ? error.message : 'Failed to explain run.' },
      ])
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="panel-card">
      <div className="split-row">
        <div>
          <strong>Ask Janusly about this run</strong>
          <p className="helper-text">Use plain language. Janusly answers with AI when connected, otherwise from local run signals.</p>
        </div>
        <span className="section-kicker">Chat</span>
      </div>

      {!runId && <p className="empty-state">Run or open a workflow first to ask what happened.</p>}

      <div className="panel-list">
        {messages.map((message, index) => (
          <div key={`${message.role}-${index}`} className={`message-card message-card-${message.role}`}>
            <div className="split-row">
              <span className="section-kicker">{message.role === 'user' ? 'You' : 'Janusly'}</span>
              {message.mode && (
                <span className={`mode-pill mode-pill-${message.mode}`}>
                  {message.model ? `${formatAiModeLabel(message.mode)} · ${message.model}` : formatAiModeLabel(message.mode)}
                </span>
              )}
            </div>
            <div className="message-body">{message.content}</div>
          </div>
        ))}
      </div>

      <div className="chat-starters" aria-label="Run question examples">
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
        placeholder="Ask: why did this run fail? why was this route chosen? what should I do next?"
      />

      <button className="command-button command-button-primary" disabled={!runId || loading || !question.trim()} onClick={ask}>
        {loading ? 'Explaining…' : 'Ask Janusly'}
      </button>
    </section>
  )
}
