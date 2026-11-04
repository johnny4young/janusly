import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api, downloadFromApi } from '../api'
import { ReportsPanel } from './ReportsPanel'

vi.mock('../api', async () => {
  const { contractApiOver } = await import('../test/contract-api-mock')
  const { recoveryHome, recoveryMetrics } = await import('../test/recovery-home-fixture')
  const api = vi.fn()
  return {
    api,
    downloadFromApi: vi.fn(async () => undefined),
    contractApi: contractApiOver(api, { 'GET /recovery/home': recoveryHome, 'GET /recovery/metrics': recoveryMetrics }),
  }
})

vi.mock('../store', () => ({
  useWorkflowStore: (selector: (state: { orgId: string }) => unknown) => selector({ orgId: 'default' }),
}))

const today = new Date().toISOString().slice(0, 10)
const validation = (windowDays: number) => ({
  generatedAt: '2026-07-21T12:00:00.000Z',
  windowDays,
  sampleLimit: 100,
  sampleCapped: false,
  totals: {
    drills: 0, completed: 0, recovered: 0, acceptedLoss: 0, awaitingAction: 0, replayInProgress: 0,
    measurementIncomplete: 0, missingEvidence: 0, completionRatePercent: null, recoveryRatePercent: null,
  },
  resolution: { operator: 0, automated: 0, unknown: 0, operatorInterventionRatePercent: null },
  timing: { medianElapsedMs: null, p90ElapsedMs: null, averageElapsedMs: null, p95ElapsedMs: null, sampleSize: 0 },
  byFailureMode: [],
  byRecoveryPath: [],
  samples: [],
})
const cluster = (signature: string, frequency: number) => ({
  signature, frequency, category: 'unknown', suggestedOwner: 'ops',
  firstSeen: '2026-07-27T12:00:00.000Z', lastSeen: '2026-07-27T12:00:00.000Z',
  recurredAfterRecovery: false, affectedWorkflows: [], samples: [],
})
const windowOf = (path: string) => Number(new URL(path, 'http://x').searchParams.get('windowDays'))
const readModelMetrics = {
  windowDays: 30,
  terminalRuns: 7,
  successRate: { value: 71.4, display: '71.4%', severity: 'warn' },
  slaAttainment: { value: 92, display: '92.0%', severity: 'healthy' },
  timeToFirstAction: { value: 120_000, display: '2m', severity: 'healthy' },
  recurrenceRate: { value: 50, display: '50.0%', severity: 'warn' },
  mttrTrend: [
    { day: '2026-07-01', seconds: 300 },
    { day: '2026-07-02', seconds: 240 },
    { day: '2026-07-03', seconds: 180 },
  ],
}
const home = {
  scope: 'full',
  generatedAt: '2026-07-28T00:00:00.000Z',
  sections: {
    heatmap: { status: 'ok', value: { days: [{ day: today, failures: 2, recovered: 1, mttrSeconds: 60 }] } },
    ledger: { status: 'unavailable' },
    wins: { status: 'unavailable' },
    queue: { status: 'unavailable' },
    metrics: { status: 'ok', value: readModelMetrics },
    clusters: {
      status: 'ok',
      value: { windowDays: 30, totalSamples: 2, clusters: [cluster('read-model-cluster', 2)] },
    },
    validation: {
      status: 'ok',
      value: {
        ...validation(30),
        totals: { ...validation(30).totals, drills: 1, completed: 1, recovered: 1, completionRatePercent: 100, recoveryRatePercent: 100 },
      },
    },
  },
}

function respond(path: string): unknown {
  if (path.startsWith('/recovery/metrics')) return { windowDays: windowOf(path), terminalRuns: 4 }
  if (path.startsWith('/dlq/clusters')) {
    return { windowDays: windowOf(path), totalSamples: 9, clusters: ['a', 'b', 'c', 'd'].map((name, i) => cluster(name, i + 1)) }
  }
  if (path.startsWith('/recovery/validation')) return validation(windowOf(path))
  if (path === '/recovery/home') return home
  if (path === '/billing/budget') return { monthlyUsdLimit: null, monthlyUsdSpent: 0 }
  if (path === '/recovery/calibration-status') return { enabled: false, calibrations: [] }
  throw new Error(`unexpected ${path}`)
}

const called = (prefix: string) => vi.mocked(api).mock.calls.map(([path]) => path).filter((path) => path.startsWith(prefix))
const renderPanel = (props: Partial<Parameters<typeof ReportsPanel>[0]> = {}) => {
  const onOpenTab = vi.fn()
  render(<ReportsPanel canReadDeadLetters canReadReports onOpenTab={onOpenTab} {...props} />)
  return onOpenTab
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  vi.mocked(api).mockReset()
  vi.mocked(downloadFromApi).mockClear()
  vi.mocked(api).mockImplementation(async (path) => respond(path))
})

describe('ReportsPanel', () => {
  it('reads each windowed report for the selected window and the history only once', async () => {
    renderPanel()
    expect(screen.getByTestId('reports-window-30')).toHaveAttribute('aria-pressed', 'true')
    await screen.findByTestId('recovery-center-tile-clusters')
    await screen.findByTestId('reports-metric-strip')
    expect(screen.getByTestId('recovery-center-metric-verified-recovery')).toBeInTheDocument()
    expect(called('/recovery/metrics')).toEqual(['/recovery/metrics?windowDays=30'])

    fireEvent.click(screen.getByTestId('reports-window-7'))

    expect(screen.getByTestId('reports-window-7')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('reports-window-30')).toHaveAttribute('aria-pressed', 'false')
    await waitFor(() => expect(called('/recovery/validation')).toContain('/recovery/validation?windowDays=7'))
    expect(called('/recovery/metrics')).toContain('/recovery/metrics?windowDays=7')
    expect(called('/dlq/clusters')).toContain('/dlq/clusters?windowDays=7')
    expect(called('/recovery/home')).toHaveLength(1)
  })

  it('narrows the heatmap to the window and opens Recover on the selected day', async () => {
    const onOpenTab = renderPanel()
    await screen.findByTestId(`recovery-heatmap-cell-${today}`)
    expect(screen.getAllByTestId(/^recovery-heatmap-cell-/)).toHaveLength(30)

    fireEvent.click(screen.getByTestId('reports-window-90'))
    expect(screen.getAllByTestId(/^recovery-heatmap-cell-/)).toHaveLength(90)
    fireEvent.click(screen.getByTestId('reports-window-7'))
    expect(screen.getAllByTestId(/^recovery-heatmap-cell-/)).toHaveLength(7)

    fireEvent.click(screen.getByTestId(`recovery-heatmap-cell-${today}`))
    expect(window.location.hash).toBe(`#/recover/day/${today}`)
    expect(onOpenTab).toHaveBeenCalledWith('recover')
  })

  it('lists every cluster by frequency instead of the Home top three', async () => {
    renderPanel()
    const tile = await screen.findByTestId('recovery-center-tile-clusters')
    const rows = within(tile).getAllByTestId(/^recovery-center-watch-row-/)
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual(
      ['d', 'c', 'b', 'a'].map((name) => `recovery-center-watch-row-${name}`),
    )
  })

  it('exports both evidence reports for the selected window', async () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('reports-window-90'))
    const value = (await screen.findByRole('heading', { name: 'Verified recovery & estimated savings' })).closest('section')!
    fireEvent.click(within(value).getByRole('button', { name: 'Markdown' }))
    await waitFor(() => expect(downloadFromApi).toHaveBeenCalledWith('/reports/value-dashboard?windowDays=90&format=markdown'))

    const evidence = screen.getByTestId('recovery-validation-section')
    await waitFor(() => expect(within(evidence).getByRole('button', { name: 'JSON' })).toBeEnabled())
    fireEvent.click(within(evidence).getByRole('button', { name: 'JSON' }))
    await waitFor(() => expect(downloadFromApi).toHaveBeenCalledWith('/reports/recovery-validation?windowDays=90&format=json'))
  })

  it('gives recovery.read alone the read model reports, on its fixed windows, with no exports', async () => {
    renderPanel({ canReadDeadLetters: false, canReadReports: false })

    const tile = await screen.findByTestId('recovery-center-tile-clusters')
    expect(within(tile).getByTestId('recovery-center-watch-row-read-model-cluster')).toBeInTheDocument()
    expect(screen.getByTestId('reports-metric-strip')).toBeInTheDocument()
    expect(screen.getByTestId('recovery-center-metric-sla')).toBeInTheDocument()
    expect(screen.getByTestId('reports-metric-runs')).toHaveTextContent('7 · 71.4%')
    expect(screen.getByTestId('recovery-validation-section')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Verified recovery & estimated savings' })).toBeInTheDocument()
    expect(screen.getByTestId('recovery-center-tile-budget')).toBeInTheDocument()
    expect(screen.getByTestId('recovery-center-tile-calibration')).toBeInTheDocument()
    expect(screen.getAllByTestId(/^recovery-heatmap-cell-/)).toHaveLength(90)

    expect(called('/recovery/metrics')).toEqual([])
    expect(called('/dlq/clusters')).toEqual([])
    expect(called('/recovery/validation')).toEqual([])
    expect(screen.queryByTestId('reports-window-30')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Markdown' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'JSON' })).toBeNull()
    expect(screen.queryByTestId('reports-unavailable')).toBeNull()
  })

  it('keeps validation readable without reports.read and offers no export', async () => {
    renderPanel({ canReadReports: false })
    const value = (await screen.findByRole('heading', { name: 'Verified recovery & estimated savings' })).closest('section')!
    expect(called('/recovery/validation')).toEqual([])
    expect(screen.getByTestId('recovery-validation-section')).toHaveTextContent('1/1')
    expect(within(value).queryByRole('button', { name: 'Markdown' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'JSON' })).toBeNull()
    expect(screen.queryByTestId('reports-unavailable')).toBeNull()
  })

  it('keeps the other read model reports when one section is unavailable', async () => {
    vi.mocked(api).mockImplementation(async (path) => path === '/recovery/home'
      ? { ...home, sections: { ...home.sections, metrics: { status: 'unavailable' } } }
      : respond(path))
    renderPanel({ canReadDeadLetters: false })
    await screen.findByTestId('reports-unavailable')
    expect(screen.getByTestId('recovery-center-tile-clusters')).toBeInTheDocument()
    expect(screen.getByTestId('recovery-validation-section')).toBeInTheDocument()
    expect(screen.queryByTestId('reports-metric-strip')).toBeNull()
  })

  it('shows each KPI with its label and the cluster breakdown', async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path.startsWith('/recovery/metrics')) return { ...readModelMetrics, windowDays: windowOf(path) }
      if (path.startsWith('/dlq/clusters')) {
        return {
          windowDays: 30,
          totalSamples: 3,
          clusters: [{ ...cluster('Missing secret: GITHUB_TOKEN', 3), recurredAfterRecovery: true }],
        }
      }
      return respond(path)
    })
    renderPanel()
    expect(await screen.findByText('Missing secret: GITHUB_TOKEN')).toBeInTheDocument()
    expect(screen.getByText('Re-failed after fix')).toBeInTheDocument()
    expect(screen.getByText('SLA attainment')).toBeInTheDocument()
    expect(screen.getByTestId('recovery-center-metric-sla')).toBeInTheDocument()
    expect(screen.getByText('Time to first action')).toBeInTheDocument()
    expect(screen.getByTestId('recovery-center-metric-first-action')).toBeInTheDocument()
    expect(screen.getByText('Fixes that held')).toBeInTheDocument()
    expect(screen.getByTestId('recovery-center-metric-durability')).toBeInTheDocument()
    expect(screen.getByTestId('reports-metric-runs')).toHaveTextContent('7 · 71.4%')
  })

  it('routes each KPI to its detail and a trend point to Recover on that day', async () => {
    vi.mocked(api).mockImplementation(async (path) => path.startsWith('/recovery/metrics')
      ? readModelMetrics
      : respond(path))
    const onOpenTab = renderPanel()

    fireEvent.click(await screen.findByTestId('recovery-center-metric-verified-recovery'))
    expect(onOpenTab).toHaveBeenLastCalledWith('operations')
    fireEvent.click(screen.getByTestId('recovery-center-metric-replay'))
    expect(onOpenTab).toHaveBeenLastCalledWith('operations')
    fireEvent.click(screen.getByTestId('reports-metric-runs'))
    expect(onOpenTab).toHaveBeenLastCalledWith('runs')

    fireEvent.click(screen.getByTestId('vitals-sparkline-point-1'))
    expect(window.location.hash).toBe('#/recover/day/2026-07-02')
    expect(onOpenTab).toHaveBeenLastCalledWith('recover')
  })

  it.each([
    ['the ledger fails', { wins: { status: 'ok', value: { recovered: 3, windowDays: 30 } } }, 'recovery-insights-personal-wins', 'recovery-lifetime-ledger'],
    ['personal wins fail', { ledger: { status: 'ok', value: { totalRecovered: 12, downtimeEndedMs: 11_700_000, sinceIso: null } } }, 'recovery-lifetime-ledger', 'recovery-insights-personal-wins'],
  ])('keeps the other lifetime figure when %s', async (_name, sections, shown, hidden) => {
    vi.mocked(api).mockImplementation(async (path) => path === '/recovery/home'
      ? { ...home, sections: { ...home.sections, ...sections } }
      : respond(path))
    renderPanel()
    expect(await screen.findByTestId(shown)).toBeInTheDocument()
    expect(screen.queryByTestId(hidden)).toBeNull()
  })

  it('renders lifetime value in full', async () => {
    vi.mocked(api).mockImplementation(async (path) => path === '/recovery/home'
      ? { ...home, sections: { ...home.sections, ledger: { status: 'ok', value: { totalRecovered: 12, downtimeEndedMs: 11_700_000, sinceIso: null } } } }
      : respond(path))
    renderPanel()
    expect(await screen.findByTestId('recovery-lifetime-ledger')).toHaveTextContent(
      'Since day one: 12 failures recovered · 3h 15m of downtime ended',
    )
  })

  it('says a failed read is unavailable, never all clear, and retries it', async () => {
    let healthy = false
    vi.mocked(api).mockImplementation(async (path) => {
      if (!healthy && path.startsWith('/dlq/clusters')) throw new Error('boom')
      return respond(path)
    })
    renderPanel()
    await screen.findByTestId('reports-unavailable')
    expect(screen.queryByTestId('recovery-center-tile-clusters')).toBeNull()

    healthy = true
    fireEvent.click(screen.getByTestId('reports-retry'))
    await screen.findByTestId('recovery-center-tile-clusters')
    expect(screen.queryByTestId('reports-unavailable')).toBeNull()
  })

  it('flags a heatmap the Home read model could not settle', async () => {
    vi.mocked(api).mockImplementation(async (path) => path === '/recovery/home'
      ? { ...home, sections: { ...home.sections, heatmap: { status: 'unavailable' } } }
      : respond(path))
    renderPanel()
    await screen.findByTestId('reports-unavailable')
    expect(screen.queryByTestId('recovery-heatmap')).toBeNull()
  })

  it('ignores a slow answer for the window the operator already left', async () => {
    let answerSlow: (value: unknown) => void = () => undefined
    vi.mocked(api).mockImplementation((path) => path === '/dlq/clusters?windowDays=30'
      ? new Promise((resolve) => { answerSlow = resolve })
      : Promise.resolve(respond(path)))
    renderPanel()
    fireEvent.click(screen.getByTestId('reports-window-7'))
    const tile = await screen.findByTestId('recovery-center-tile-clusters')

    await act(async () => {
      answerSlow({ windowDays: 30, totalSamples: 1, clusters: [cluster('stale', 1)] })
    })

    expect(screen.queryByTestId('recovery-center-watch-row-stale')).toBeNull()
    expect(within(tile).getByTestId('recovery-center-watch-row-d')).toBeInTheDocument()
  })

  it('hides the previous window until the new one answers', async () => {
    let answer: (value: unknown) => void = () => undefined
    vi.mocked(api).mockImplementation((path) => path === '/dlq/clusters?windowDays=7'
      ? new Promise((resolve) => { answer = resolve })
      : Promise.resolve(respond(path)))
    renderPanel()
    await screen.findByTestId('recovery-center-tile-clusters')

    fireEvent.click(screen.getByTestId('reports-window-7'))
    expect(screen.queryByTestId('recovery-center-tile-clusters')).toBeNull()

    await act(async () => {
      answer(respond('/dlq/clusters?windowDays=7'))
    })
    expect(screen.getByTestId('recovery-center-tile-clusters')).toBeInTheDocument()
  })
})
