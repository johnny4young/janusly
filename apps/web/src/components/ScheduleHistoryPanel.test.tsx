import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

vi.mock('../api', () => ({
  api: vi.fn(),
}))

// Store mock: the panel reads currentWorkflowId / currentWorkflowSaved /
// platformVersion. A saved workflow with id `wf-1` is the default.
const storeState = {
  currentWorkflowId: 'wf-1',
  currentWorkflowSaved: true,
  platformVersion: 1,
}

vi.mock('../store', () => ({
  useWorkflowStore: vi.fn((selector?: (s: typeof storeState) => unknown) => {
    if (typeof selector === 'function') return selector(storeState)
    return storeState
  }),
}))

import { api } from '../api'
import { changeAppLanguage } from '../i18n'
import { ScheduleHistoryPanel } from './ScheduleHistoryPanel'

const apiMock = vi.mocked(api)

const EMPTY_RESPONSE = {
  workflowId: 'wf-1',
  windowDays: 90,
  rowCap: 1000,
  capped: false,
  heatmap: { cells: [], totalFires: 0, totalSuccess: 0, totalFail: 0, timezone: 'UTC' },
  schedules: [],
}

const POPULATED_RESPONSE = {
  workflowId: 'wf-1',
  windowDays: 90,
  rowCap: 1000,
  capped: false,
  heatmap: {
    // 2024-01-01 Monday 09:00 — UTC dayOfWeek 1.
    cells: [
      // All-success high-volume cell → success-3 ramp.
      { dayOfWeek: 1, hour: 9, total: 4, success: 4, fail: 0, anomaly: false },
      // Mixed cell: mostly success but one failure → mixed ramp.
      { dayOfWeek: 2, hour: 8, total: 3, success: 2, fail: 1, anomaly: false },
      // All-fail cell → fail ramp.
      { dayOfWeek: 3, hour: 14, total: 2, success: 0, fail: 2, anomaly: false },
    ],
    totalFires: 9,
    totalSuccess: 6,
    totalFail: 3,
    timezone: 'UTC',
  },
  schedules: [
    {
      nodeId: 'cron-daily',
      cronExpression: '0 9 * * *',
      enabled: true,
      lastRunAt: '2024-01-01T09:00:00.000Z',
      lastRunId: 'run-1',
      nextFires: ['2026-06-01T09:00:00.000Z', '2026-06-02T09:00:00.000Z'],
    },
    {
      nodeId: 'cron-paused',
      cronExpression: '0 12 * * 1',
      enabled: false,
      lastRunAt: null,
      lastRunId: null,
      nextFires: [],
    },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  storeState.currentWorkflowId = 'wf-1'
  storeState.currentWorkflowSaved = true
  changeAppLanguage('en')
})

afterEach(() => {
  cleanup()
  changeAppLanguage('en')
})

describe('ScheduleHistoryPanel', () => {
  it('renders null when there is no saved workflow', () => {
    storeState.currentWorkflowSaved = false
    const { container } = render(<ScheduleHistoryPanel />)
    expect(container.firstChild).toBeNull()
    expect(apiMock).not.toHaveBeenCalled()
  })

  it('renders the empty-history state when no fires are recorded', async () => {
    apiMock.mockResolvedValueOnce(EMPTY_RESPONSE)
    const { container } = render(<ScheduleHistoryPanel />)
    await waitFor(() => {
      expect(container.querySelector('.we-schedule-panel')).not.toBeNull()
    })
    expect(container.textContent).toContain('No scheduled fires recorded yet')
    // The SVG grid still renders (7 days × 24 hours = 168 cell rects).
    const gridCells = container.querySelectorAll('.we-schedule-heatmap rect.we-schedule-heatmap__cell')
    expect(gridCells.length).toBe(168)
    // Every grid cell is empty in the no-fire state.
    const filled = container.querySelectorAll(
      '.we-schedule-heatmap rect.we-schedule-heatmap__cell:not(.we-schedule-heatmap__cell--empty)',
    )
    expect(filled.length).toBe(0)
  })

  it('renders the heatmap, success/fail rollups, and next-fire previews when populated', async () => {
    apiMock.mockResolvedValueOnce(POPULATED_RESPONSE)
    const { container } = render(<ScheduleHistoryPanel />)
    await waitFor(() => {
      expect(container.querySelector('.we-schedule-heatmap')).not.toBeNull()
    })
    // Rollups.
    expect(container.textContent).toContain('6 succeeded')
    expect(container.textContent).toContain('3 failed')
    expect(container.textContent).toContain('Times in UTC')
    // Three populated cells. maxTotal is 4: the all-success cell (total 4 →
    // ratio 1.0 → intensity 3) lands on success-3; the mixed cell on the
    // mixed ramp; the all-fail cell (total 2 → ratio 0.5 → intensity 2)
    // lands on fail-2.
    const successCell = container.querySelector('.we-schedule-heatmap rect.we-schedule-heatmap__cell--success-3')
    const mixedCell = container.querySelector('.we-schedule-heatmap rect[class*="we-schedule-heatmap__cell--mixed-"]')
    const failCell = container.querySelector('.we-schedule-heatmap rect.we-schedule-heatmap__cell--fail-2')
    expect(successCell).not.toBeNull()
    expect(mixedCell).not.toBeNull()
    expect(failCell).not.toBeNull()
    // Per-cell tooltip carries the success/fail split.
    expect(successCell?.querySelector('title')?.textContent).toContain('(4 ok, 0 failed)')
    // Next-fires preview: enabled entry lists 2 fires, paused entry shows paused copy.
    expect(container.textContent).toContain('0 9 * * *')
    expect(container.textContent).toContain('Active')
    expect(container.textContent).toContain('Paused')
    const fireItems = container.querySelectorAll('.we-schedule-entry__fires li')
    expect(fireItems.length).toBe(2)
  })

  it('renders the error state when the fetch rejects', async () => {
    apiMock.mockRejectedValueOnce(new Error('boom'))
    const { container } = render(<ScheduleHistoryPanel />)
    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')).not.toBeNull()
    })
    expect(container.textContent).toContain('Could not load schedule history')
  })

  it('renders Spanish copy when the locale is es', async () => {
    changeAppLanguage('es')
    apiMock.mockResolvedValueOnce(EMPTY_RESPONSE)
    const { container } = render(<ScheduleHistoryPanel />)
    await waitFor(() => {
      expect(container.querySelector('.we-schedule-panel')).not.toBeNull()
    })
    // ES title kicker + empty-state copy. "Schedule" stays English (accepted
    // technical noun), but the kicker + body are translated.
    expect(container.textContent).toContain('Observabilidad de cron')
    expect(container.textContent).toContain('Aún no hay disparos programados registrados')
  })
})
