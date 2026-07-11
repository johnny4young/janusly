/**
 * Real-Chromium coverage for AI Studio's provider setup guidance.
 *
 * Used by the browser-mode lane to keep the rendered local-mode copy aligned
 * with Janusly's supported Anthropic provider in both shipped locales.
 */

import { render, screen } from '@testing-library/react'
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
})
