import React, { useState } from 'react'
import { api } from '../api'

type Message = {
  role: 'user' | 'assistant'
  content: string
}

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
      })

      setMessages((current) => [
        ...current,
        { role: 'assistant', content: response.answer ?? 'No explanation available.' },
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
        <strong>AI Run Explainer</strong>
        <span className="section-kicker">Chat</span>
      </div>

      {!runId && <p className="empty-state">Open a run first to ask questions.</p>}

      <div className="panel-list">
        {messages.map((message, index) => (
          <div key={`${message.role}-${index}`} className="list-card">
            <span className="section-kicker">{message.role}</span>
            <div style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div>
          </div>
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
        {loading ? 'Explaining…' : 'Ask AI'}
      </button>
    </section>
  )
}
