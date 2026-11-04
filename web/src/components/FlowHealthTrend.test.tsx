import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { contractApi } from '../api'
import { healthDelta } from '../test/health-delta-fixture'
import { FlowHealthTrend } from './FlowHealthTrend'

vi.mock('../api', () => ({ contractApi: vi.fn() }))
vi.mock('../i18n', () => ({
  useT: () => ({ t: (key: string, values: Record<string, unknown>) => `${key}:${values.points}:${values.version}` }),
}))

const contract = vi.mocked(contractApi)
const delta = (score: number | null, afterVersion = 3) => healthDelta({
  workflowId: 'wf', afterVersion, windowDays: 30, minRunsForDelta: 5, hasEnoughData: score !== null,
  before: { score: 80, status: 'healthy', signals: {} },
  after: { score: 80 + (score ?? 0), status: 'healthy', signals: {} },
  delta: score === null ? null : { score, p95LatencyMs: null, costPerRunUsd: null },
  recentRunsAgainstAfter: { totalRuns: 5, succeeded: 5, failed: 0, running: 0 },
  sameFailureSinceApply: null,
  priorVersion: null,
})

beforeEach(() => { contract.mockReset() })

describe('<FlowHealthTrend />', () => {
  it('asks nothing for a flow with a single version', () => {
    const { container } = render(<FlowHealthTrend workflowId="wf" currentVersion={1} />)
    expect(contract).not.toHaveBeenCalled()
    expect(container).toBeEmptyDOMElement()
  })

  it('names a drop since the current version', async () => {
    contract.mockResolvedValue(delta(-9))
    render(<FlowHealthTrend workflowId="wf" currentVersion={3} />)
    const trend = await screen.findByTestId('workflows-health-trend-wf')
    expect(trend).toHaveTextContent('↓ 9')
    expect(trend).toHaveAccessibleName('workflowsDashboard.healthTrendDown:9:3')
    expect(contract.mock.calls[0][1]).toBe('/workflows/health/delta?workflowId=wf&afterVersion=3')
  })

  it('names a rise', async () => {
    contract.mockResolvedValue(delta(2))
    render(<FlowHealthTrend workflowId="wf" currentVersion={3} />)
    expect(await screen.findByRole('img')).toHaveAccessibleName('workflowsDashboard.healthTrendUp:2:3')
  })

  it.each([
    ['the sample is too small', delta(null)],
    ['the score did not move', delta(0)],
    ['the response is about another version', delta(4, 2)],
    ['the read fails', null],
  ])('renders nothing when %s', async (_name, response) => {
    if (response) contract.mockResolvedValue(response)
    else contract.mockRejectedValue(new Error('unavailable'))
    const { container } = render(<FlowHealthTrend workflowId="wf" currentVersion={3} />)
    await waitFor(() => expect(contract).toHaveBeenCalled())
    await act(() => Promise.resolve())
    expect(container).toBeEmptyDOMElement()
  })
})
