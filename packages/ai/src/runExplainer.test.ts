import { describe, expect, it, vi } from 'vitest'
import { buildRunExplanationPrompt, explainRun, fallbackExplainRun } from './runExplainer'

describe('buildRunExplanationPrompt', () => {
  it('embeds the run and events as JSON', () => {
    const prompt = buildRunExplanationPrompt({
      run: { id: 'run_1', status: 'failed' },
      events: [{ type: 'node.failed', payload: { error: 'boom' } }],
      question: 'why did this fail?',
    })

    expect(prompt).toContain('why did this fail?')
    expect(prompt).toContain('"id": "run_1"')
    expect(prompt).toContain('node.failed')
  })

  it('uses a default question when none provided', () => {
    const prompt = buildRunExplanationPrompt({ run: {}, events: [] })
    expect(prompt).toContain('Explain this run')
  })
})

describe('fallbackExplainRun', () => {
  it('summarizes failures, retries, decisions, rollbacks, and skipped', () => {
    const summary = fallbackExplainRun({
      run: {},
      events: [
        { type: 'node.queued' },
        { type: 'decision.made' },
        { type: 'node.retry' },
        { type: 'node.failed' },
        { type: 'node.skipped' },
        { type: 'rollback.triggered' },
      ],
    })

    expect(summary).toContain('6 events observed')
    expect(summary).toContain('Decisions made: 1')
    expect(summary).toContain('Retries scheduled/executed: 1')
    expect(summary).toContain('Failures detected: 1')
    expect(summary).toContain('Nodes skipped by edge conditions: 1')
    expect(summary).toContain('Rollback activity detected: 1')
  })

  it('falls back to "no" lines when nothing happened', () => {
    const summary = fallbackExplainRun({ run: {}, events: [{ type: 'node.queued' }, { type: 'node.succeeded' }] })
    expect(summary).toContain('No routing decisions')
    expect(summary).toContain('No retries')
    expect(summary).toContain('No failures')
  })
})

describe('explainRun', () => {
  it('returns fallback mode when no openai client is provided', async () => {
    const result = await explainRun({ run: {}, events: [{ type: 'node.succeeded' }] })
    expect(result.mode).toBe('fallback')
    expect(result.answer).toContain('events observed')
  })

  it('uses the openai client and returns ai mode + model', async () => {
    const create = vi.fn().mockResolvedValue({ output_text: 'AI response here' })
    const result = await explainRun({
      run: { id: 'run_1' },
      events: [],
      question: 'what next?',
      openai: { responses: { create } },
      model: 'gpt-4o-mini',
    })

    expect(result.mode).toBe('ai')
    expect(result.answer).toBe('AI response here')
    expect(result.model).toBe('gpt-4o-mini')
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'gpt-4o-mini' })
  })

  it('falls back to deterministic answer when openai throws, attaching aiError', async () => {
    const create = vi.fn().mockRejectedValue(Object.assign(new Error('quota exceeded'), { status: 429 }))
    const result = await explainRun({
      run: {},
      events: [{ type: 'node.failed' }],
      openai: { responses: { create } },
    })

    expect(result.mode).toBe('fallback')
    expect(result.aiError).toBe('quota exceeded')
    expect(result.answer).toContain('events observed')
  })
})
