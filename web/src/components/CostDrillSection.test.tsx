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
  windowDays: 30, retentionDays: 90, aiConfigured: true, truncated: false, rowCap: 10000, stepsTotal: 1, modelsTotal: 1,
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
    [true, 'No AI calls were recorded in the last 7 days, so there is no cost to estimate. Flows without an AI step record no usage.'],
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
      truncated: true, windowDays: 90, retentionDays: 30, stepsTotal: 40,
      totals: tally({ calls: 5, costUsd: 1, unknownCostCalls: 2, simulatedCalls: 1 }),
      withoutRun: tally({ calls: 1 }),
    }))
    const notes = screen.getByTestId('cost-drill-notes')
    expect(notes).toHaveTextContent('2 calls recorded no cost')
    expect(notes).toHaveTextContent('1 simulated call is left out')
    expect(notes).toHaveTextContent('1 call belongs to no run')
    expect(notes).toHaveTextContent('Based on the newest 10,000 calls')
    expect(notes).toHaveTextContent('Usage older than 30 days')
    expect(screen.getByTestId('cost-drill-steps-top')).toHaveTextContent('Top 1 of 40 steps.')
    expect(screen.queryByTestId('cost-drill-models-top')).toBeNull()
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
