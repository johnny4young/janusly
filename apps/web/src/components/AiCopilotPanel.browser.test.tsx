/**
 * Real-Chromium coverage for AI Studio's provider setup guidance.
 *
 * Used by the browser-mode lane to keep the rendered local-mode copy aligned
 * with Janusly's supported Anthropic provider in English and Spanish.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReviewFindings, WorkflowDefinition } from '../types'
import { initI18n } from '../i18n'
import { AiCopilotPanel } from './AiCopilotPanel'

function renderLocalModePanel() {
  return render(
    <AiCopilotPanel
      health={null}
      workflowName="Sample workflow"
      onGenerateWorkflow={vi.fn(async () => ({
        mode: 'fallback' as const,
        workflow: { id: 'sample', name: 'Sample workflow', nodes: [], edges: [] } as unknown as WorkflowDefinition,
      }))}
      onExplainWorkflow={vi.fn(async () => ({ mode: 'fallback' as const, explanation: '' }))}
      onReviewWorkflow={vi.fn(async () => ({
        mode: 'fallback' as const,
        review: { status: 'pass', issues: [] } as unknown as ReviewFindings,
      }))}
      onOpenRuns={vi.fn()}
      onOpenTemplates={vi.fn()}
    />,
  )
}

describe('<AiCopilotPanel /> provider guidance (browser)', () => {
  afterEach(() => {
    initI18n('en')
  })

  it('renders visible Anthropic guidance in English local mode', async () => {
    renderLocalModePanel()

    const detail = await screen.findByText(/Add ANTHROPIC_API_KEY to the root \.env/i)
    expect(detail.getBoundingClientRect().height).toBeGreaterThan(0)
    expect(getComputedStyle(detail).display).not.toBe('none')
    expect(screen.getByText('Root .env has ANTHROPIC_API_KEY')).toBeInTheDocument()
    expect(screen.queryByText(/OPENAI_API_KEY/i)).not.toBeInTheDocument()
  })

  it('renders visible Anthropic guidance in Spanish local mode', async () => {
    initI18n('es')
    renderLocalModePanel()

    const detail = await screen.findByText(/Agrega ANTHROPIC_API_KEY al archivo \.env de la raíz/i)
    expect(detail.getBoundingClientRect().height).toBeGreaterThan(0)
    expect(getComputedStyle(detail).display).not.toBe('none')
    expect(screen.getByText('El archivo .env de la raíz contiene ANTHROPIC_API_KEY')).toBeInTheDocument()
    expect(screen.queryByText(/OPENAI_API_KEY/i)).not.toBeInTheDocument()
  })

  it('renders a visible budget backoff result in Chromium', async () => {
    render(
      <AiCopilotPanel
        health={{
          enabled: true,
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
          timeoutMs: 30_000,
          maxRetries: 2,
        }}
        workflowName="Sample workflow"
        onGenerateWorkflow={vi.fn(async () => ({
          mode: 'ai' as const,
          workflow: { id: 'sample', name: 'Budget-aware workflow', nodes: [], edges: [] } as unknown as WorkflowDefinition,
          bonBackoff: { from: 4, to: 1 },
        }))}
        onExplainWorkflow={vi.fn(async () => ({ mode: 'ai' as const, explanation: '' }))}
        onReviewWorkflow={vi.fn(async () => ({
          mode: 'ai' as const,
          review: { status: 'pass', issues: [] } as unknown as ReviewFindings,
        }))}
        onOpenRuns={vi.fn()}
        onOpenTemplates={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Draft flow/i }))

    const notice = await screen.findByTestId('ai-candidate-backoff')
    expect(notice.getBoundingClientRect().height).toBeGreaterThan(0)
    expect(getComputedStyle(notice).display).not.toBe('none')
    expect(notice).toHaveTextContent('evaluated 1 of 4 candidates')
  })
})
