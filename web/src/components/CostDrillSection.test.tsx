import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { changeAppLanguage } from '../i18n'
import type { UsageCosts } from '../lib/api-types.generated'
import { CostDrillSection } from './CostDrillSection'

const tally = (overrides: Partial<UsageCosts['totals']> = {}): UsageCosts['totals'] => ({
  calls: 0, uncachedInputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0,
  costUsd: null, unknownCostCalls: 0, simulatedCalls: 0, ...overrides,
})
const step = (runId: string, overrides: Partial<UsageCosts['steps'][number]> = {}): UsageCosts['steps'][number] => ({
  ...tally({ calls: 1, uncachedInputTokens: 1800, cachedInputTokens: 29000, outputTokens: 920, costUsd: 0.0312 }),
  runId, runAvailable: true, workflowName: 'Incident triage', nodeId: 'summarize', provider: 'Anthropic', model: 'haiku', ...overrides,
})
const costs = (overrides: Partial<UsageCosts> = {}): UsageCosts => ({
  windowDays: 30, retentionDays: 90, aiConfigured: true, stepsTruncated: false, stepsCoveredSince: null, rowCap: 10000, stepsTotal: 1, modelsTotal: 1,
  totals: tally({ calls: 1, uncachedInputTokens: 1800, cachedInputTokens: 29000, cacheCreationInputTokens: 12, outputTokens: 920, costUsd: 0.0312 }),
  withoutRun: tally(),
  steps: [step('9a1e4b2c-long-run-id')],
  models: [{ ...tally({ calls: 1, costUsd: 0.0312 }), provider: 'Anthropic', model: 'haiku' }],
  ...overrides,
})
const renderSection = (value: UsageCosts | null | undefined, props: Partial<Parameters<typeof CostDrillSection>[0]> = {}) => {
  const onOpenRun = vi.fn()
  const onSelectModel = vi.fn()
  render(<CostDrillSection costs={value} stepsRead={value} selectedModel={null} onSelectModel={onSelectModel} onOpenRun={onOpenRun} {...props} />)
  return { onOpenRun, onSelectModel }
}

describe('CostDrillSection', () => {
  it('labels cost as estimated, shows uncached tokens and opens the run of a row', async () => {
    await changeAppLanguage('en')
    const { onOpenRun } = renderSection(costs())
    const summary = screen.getByTestId('cost-drill-summary')
    expect(summary).toHaveTextContent('Estimated cost≈ $0.0312')
    expect(summary).toHaveTextContent('Uncached input1,800')
    expect(summary).toHaveTextContent('Cached input29,000')
    expect(summary).toHaveTextContent('Cache writes12')
    const table = screen.getByTestId('cost-drill-steps')
    expect(within(table).getByRole('columnheader', { name: 'Estimated cost' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'Uncached input' })).toBeInTheDocument()
    const open = screen.getByTestId('cost-drill-open-run')
    expect(open).toHaveAccessibleName('Open run 9a1e4b2c')
    fireEvent.click(open)
    expect(onOpenRun).toHaveBeenCalledWith('9a1e4b2c-long-run-id')
  })

  it.each([
    [true, 'No AI calls were recorded in the last 7 days, so there is no cost to estimate. Only AI steps have a cost.'],
    [false, 'No AI provider is configured, and no AI calls were recorded in the last 7 days, so there is no cost to estimate.'],
  ])('says why there is no usage instead of a zero (configured: %s)', async (aiConfigured, reason) => {
    await changeAppLanguage('en')
    renderSection(costs({ aiConfigured, windowDays: 7, totals: tally(), steps: [], models: [], stepsTotal: 0 }))
    expect(screen.getByTestId('cost-drill-empty')).toHaveTextContent(reason)
    expect(screen.queryByTestId('cost-drill-summary')).toBeNull()
    expect(screen.getByTestId('cost-drill')).not.toHaveTextContent('$')
  })

  it('never shows an unpriced or simulated step as zero, nor a link to a purged run', async () => {
    await changeAppLanguage('en')
    renderSection(costs({
      stepsTotal: 3,
      steps: [
        step('failed-run', { costUsd: null, unknownCostCalls: 1 }),
        step('simul-run', { costUsd: null, simulatedCalls: 1, nodeId: null }),
        step('purged-run', { runAvailable: false, workflowName: '' }),
      ],
    }))
    const rows = within(screen.getByTestId('cost-drill-steps')).getAllByRole('row').slice(1)
    expect(rows[0]).toHaveTextContent('—')
    expect(rows[0]).not.toHaveTextContent('$')
    expect(rows[1]).toHaveTextContent('Simulated')
    expect(rows[1]).toHaveTextContent('Whole run')
    expect(rows[2]).not.toHaveTextContent('Open run')
    expect(within(rows[2]).queryByTestId('cost-drill-open-run')).toBeNull()
    expect(screen.getAllByTestId('cost-drill-open-run')).toHaveLength(2)
  })

  it('states every limit of the estimate', async () => {
    await changeAppLanguage('en')
    renderSection(costs({
      windowDays: 90, retentionDays: 30, stepsTotal: 40,
      totals: tally({ calls: 5, costUsd: 1, unknownCostCalls: 2, simulatedCalls: 1 }),
      withoutRun: tally({ calls: 1 }),
    }))
    const notes = screen.getByTestId('cost-drill-notes')
    expect(notes).toHaveTextContent('2 calls recorded no cost')
    expect(notes).toHaveTextContent('1 simulated call is left out of the cost and token figures.')
    expect(notes).toHaveTextContent('1 call belongs to no run')
    expect(notes).toHaveTextContent('Usage older than 30 days')
    expect(screen.queryByTestId('cost-drill-steps-coverage')).toBeNull()
    expect(screen.getByTestId('cost-drill-steps-top')).toHaveTextContent('Top 1 of 40 steps.')
    expect(screen.queryByTestId('cost-drill-models-top')).toBeNull()
  })

  it.each([
    ['en' as const, 'Last 90 days', '≈ $43.2', '61,234', 'Steps cover only the newest 10,000 calls of this window, back to Sep 2, 2026', 'The totals cover the whole window.'],
    ['es' as const, 'Últimos 90 días', '43,2', '61.234', 'Los pasos cubren solo las 10.000 llamadas más recientes de este periodo, hasta el 2 sept 2026', 'Los totales cubren todo el periodo.'],
  ])('keeps the window totals and says how far back truncated steps reach (%s)', async (lang, window, cost, calls, coverage, totals) => {
    await changeAppLanguage(lang)
    const since = new Date(2026, 8, 2, 14, 5).toISOString()
    const truncated = costs({
      windowDays: 90, stepsTruncated: true, stepsCoveredSince: since,
      totals: tally({ calls: 61_234, costUsd: 43.21 }),
    })
    renderSection(truncated)
    const section = screen.getByTestId('cost-drill')
    expect(section).toHaveTextContent(window)
    const summary = screen.getByTestId('cost-drill-summary')
    expect(summary).toHaveTextContent(cost)
    expect(summary).toHaveTextContent(calls)
    const note = screen.getByTestId('cost-drill-steps-coverage')
    expect(note).toHaveTextContent(coverage)
    expect(note).toHaveTextContent(totals)
    await changeAppLanguage('en')
  })

  it('takes the coverage of a selected model from its own read', async () => {
    await changeAppLanguage('en')
    renderSection(costs(), {
      selectedModel: 'haiku',
      stepsRead: costs({ stepsTruncated: true, stepsCoveredSince: new Date(2026, 9, 1, 9, 0).toISOString() }),
    })
    expect(screen.getByTestId('cost-drill-steps-coverage')).toHaveTextContent('back to Oct 1, 2026')
  })

  it('says when the model table is cut', async () => {
    await changeAppLanguage('en')
    renderSection(costs({ modelsTotal: 60 }))
    expect(screen.getByTestId('cost-drill-models-top')).toHaveTextContent('Top 1 of 60 models.')
  })

  it('does not keep loading when the steps of a model failed', async () => {
    await changeAppLanguage('en')
    renderSection(costs(), { selectedModel: 'haiku', stepsRead: null })
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.queryByTestId('cost-drill-steps')).toBeNull()
  })

  it('selects and clears a model through its row', async () => {
    await changeAppLanguage('en')
    const { onSelectModel } = renderSection(costs(), { selectedModel: 'haiku', stepsRead: undefined })
    expect(screen.getByText('Most expensive steps on haiku')).toBeInTheDocument()
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    const toggle = screen.getByTestId('cost-drill-model-steps')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(toggle)
    expect(onSelectModel).toHaveBeenLastCalledWith(null)
    fireEvent.click(screen.getByTestId('cost-drill-clear-model'))
    expect(onSelectModel).toHaveBeenLastCalledWith(null)
  })

  it('shows a model without steps and renders nothing for a failed read', async () => {
    await changeAppLanguage('en')
    renderSection(costs(), { selectedModel: 'haiku', stepsRead: costs({ steps: [], stepsTotal: 0 }) })
    expect(screen.getByTestId('cost-drill-no-steps')).toBeInTheDocument()
    const { container } = render(<CostDrillSection costs={null} stepsRead={null} selectedModel={null} onSelectModel={vi.fn()} onOpenRun={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('translates the labels', async () => {
    await changeAppLanguage('es')
    renderSection(costs())
    expect(screen.getByText('Costo estimado de IA')).toBeInTheDocument()
    expect(screen.getByTestId('cost-drill-open-run')).toHaveAccessibleName('Abrir ejecución 9a1e4b2c')
    await changeAppLanguage('en')
  })
})
