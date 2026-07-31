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

function parseRgb(value: string): [number, number, number] {
  const channels = value.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number)
  if (!channels || channels.length !== 3) throw new Error(`Expected an RGB color, received ${value}`)
  return channels as [number, number, number]
}

function relativeLuminance(color: string): number {
  const [red, green, blue] = parseRgb(color)
  const convert = (channel: number) => {
    const normalized = channel / 255
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  }
  return (0.2126 * convert(red))
    + (0.7152 * convert(green))
    + (0.0722 * convert(blue))
}

function contrastRatio(foreground: string, background: string): number {
  const values = [relativeLuminance(foreground), relativeLuminance(background)]
    .sort((left, right) => right - left)
  return (values[0]! + 0.05) / (values[1]! + 0.05)
}

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
      actionRequest={null}
      onSuggestWorkflowImprovement={vi.fn(async () => ({ mode: 'fallback' as const, suggestions: [] }))}
      onApplyWorkflowImprovement={vi.fn(async () => true)}
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

    const detail = await screen.findByText(/Configure ANTHROPIC_API_KEY for the API and worker/i)
    expect(detail.getBoundingClientRect().height).toBeGreaterThan(0)
    expect(getComputedStyle(detail).display).not.toBe('none')
    expect(screen.getByText('Root .env has ANTHROPIC_API_KEY')).toBeInTheDocument()
    expect(screen.queryByText(/OPENAI_API_KEY/i)).not.toBeInTheDocument()
  })

  it('renders visible Anthropic guidance in Spanish local mode', async () => {
    initI18n('es')
    renderLocalModePanel()

    const detail = await screen.findByText(/Configura ANTHROPIC_API_KEY para la API y el worker/i)
    expect(detail.getBoundingClientRect().height).toBeGreaterThan(0)
    expect(getComputedStyle(detail).display).not.toBe('none')
    expect(screen.getByText('El archivo .env de la raíz contiene ANTHROPIC_API_KEY')).toBeInTheDocument()
    expect(screen.queryByText(/OPENAI_API_KEY/i)).not.toBeInTheDocument()
  })

  it('renders a visible budget backoff result with accessible AI status contrast in Chromium', async () => {
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
        actionRequest={null}
        onSuggestWorkflowImprovement={vi.fn(async () => ({ mode: 'fallback' as const, suggestions: [] }))}
        onApplyWorkflowImprovement={vi.fn(async () => true)}
        onOpenRuns={vi.fn()}
        onOpenTemplates={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Draft flow/i }))

    const notice = await screen.findByTestId('ai-candidate-backoff')
    expect(notice.getBoundingClientRect().height).toBeGreaterThan(0)
    expect(getComputedStyle(notice).display).not.toBe('none')
    expect(notice).toHaveTextContent('evaluated 1 of 4 candidates')

    const pill = document.querySelector<HTMLElement>('.result-panel .mode-pill-ai')
    expect(pill).not.toBeNull()
    const styles = getComputedStyle(pill!)
    expect(contrastRatio(styles.color, styles.backgroundColor)).toBeGreaterThanOrEqual(4.5)
  })
})
