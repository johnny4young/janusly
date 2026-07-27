import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { RunSummary } from '../types'
import { RunHistoryList } from './RunHistoryList'

vi.mock('../api', () => ({
  api: vi.fn(),
  downloadFromApi: vi.fn(),
}))

vi.mock('../hooks/useVirtualList', () => ({
  useVirtualList: ({ items }: { items: unknown[] }) => ({
    containerRef: { current: null },
    visibleItems: items.map((item, index) => ({ item, index })),
    totalHeight: items.length * 156,
    startOffset: 0,
  }),
}))

vi.mock('./RunHistoryComparisonDialog', () => ({
  RunHistoryComparisonDialog: ({ selectedRun }: { selectedRun: RunSummary }) => (
    <div data-testid="comparison-dialog-stub">{selectedRun.id}</div>
  ),
}))

const runs: RunSummary[] = [
  {
    id: 'failed-run',
    workflowId: 'wf-billing',
    workflowName: 'Billing recovery',
    workflowVersionId: 'version-2',
    status: 'failed',
    createdAt: '2026-07-12T12:00:00.000Z',
  },
  {
    id: 'successful-run',
    workflowId: 'wf-billing',
    workflowName: 'Billing recovery',
    workflowVersionId: 'version-1',
    status: 'succeeded',
    createdAt: '2026-07-11T12:00:00.000Z',
  },
]

const props = {
  runs,
  workflows: [{ id: 'wf-billing', orgId: 'org-1', name: 'Billing recovery' }],
  onOpenRun: vi.fn(),
  onOpenLab: vi.fn(),
  onSend: vi.fn(),
}

beforeEach(() => {
  vi.mocked(api).mockReset()
  useWorkflowStore.setState({ platformVersion: 0, toasts: [] })
  props.onOpenRun.mockClear()
  props.onOpenLab.mockClear()
  props.onSend.mockClear()
})

describe('<RunHistoryList />', () => {
  it('renders workflow identity and does not refetch the unfiltered bootstrap page', () => {
    render(<RunHistoryList {...props} />)

    const rows = screen.getAllByRole('article')
    expect(rows).toHaveLength(2)
    expect(rows.every(row => within(row).getByText('Billing recovery'))).toBe(true)
    expect(screen.getByText('2 runs')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Created' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Timed out' })).toBeInTheDocument()
    expect(api).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open timeline for run failed-run' }))
    expect(props.onOpenRun).toHaveBeenCalledWith('failed-run')
  })

  it('surfaces the durable evidence level on validation history rows', () => {
    render(<RunHistoryList
      {...props}
      runs={[{
        ...runs[1]!,
        id: 'validation-run',
        replayMode: 'validation',
        validationEvidenceLevel: 'provider_simulated',
      }]}
    />)

    expect(screen.getByTestId('run-validation-evidence-validation-run'))
      .toHaveTextContent('Provider simulated')
    expect(screen.queryByTestId('history-replay-in-lab-validation-run')).not.toBeInTheDocument()
  })

  it('composes workflow and status as server-side filters', async () => {
    vi.mocked(api).mockResolvedValue([runs[0]])
    render(<RunHistoryList {...props} />)

    fireEvent.change(screen.getByTestId('run-history-workflow-filter'), { target: { value: 'wf-billing' } })
    fireEvent.change(screen.getByTestId('run-history-status-filter'), { target: { value: 'failed' } })

    await waitFor(() => {
      const path = String(vi.mocked(api).mock.calls.at(-1)?.[0])
      expect(path).toContain('workflowId=wf-billing')
      expect(path).toContain('status=failed')
    })
    expect(await screen.findByText('1 run')).toBeInTheDocument()
  })

  it('keeps the virtual scroll container mounted through a filtered loading transition', async () => {
    let resolveRequest!: (value: RunSummary[]) => void
    vi.mocked(api).mockImplementationOnce(() => new Promise(resolve => {
      resolveRequest = resolve as (value: RunSummary[]) => void
    }))
    render(<RunHistoryList {...props} />)

    const list = screen.getByTestId('runs-history-virtual-list')
    fireEvent.change(screen.getByTestId('run-history-status-filter'), { target: { value: 'failed' } })
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('runs-history-virtual-list')).toBe(list)
    expect(list).toHaveAttribute('hidden')
    expect(screen.getByTestId('run-history-count')).toBeEmptyDOMElement()

    await act(async () => resolveRequest([runs[0]!]))
    await waitFor(() => expect(list).not.toHaveAttribute('hidden'))
    expect(screen.getByTestId('runs-history-virtual-list')).toBe(list)
    expect(screen.getByTestId('run-history-count')).toHaveTextContent('1 run')
  })

  it('ignores a stale filtered response after the filter changes', async () => {
    let resolveFailed!: (value: RunSummary[]) => void
    let resolveSucceeded!: (value: RunSummary[]) => void
    vi.mocked(api)
      .mockImplementationOnce(() => new Promise(resolve => { resolveFailed = resolve as (value: RunSummary[]) => void }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSucceeded = resolve as (value: RunSummary[]) => void }))

    render(<RunHistoryList {...props} />)
    const statusFilter = screen.getByTestId('run-history-status-filter')
    fireEvent.change(statusFilter, { target: { value: 'failed' } })
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1))
    fireEvent.change(statusFilter, { target: { value: 'succeeded' } })
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2))

    resolveSucceeded([runs[1]!])
    expect(await screen.findByText('successf…')).toBeInTheDocument()
    resolveFailed([runs[0]!])
    await waitFor(() => expect(screen.queryByText('failed-r…')).not.toBeInTheDocument())
  })

  it('offers a clearable localized no-match state', async () => {
    vi.mocked(api).mockResolvedValue([])
    render(<RunHistoryList {...props} />)

    fireEvent.change(screen.getByTestId('run-history-status-filter'), { target: { value: 'cancelled' } })
    expect(await screen.findByText('No matching runs')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' }).at(-1)!)
    expect(screen.getByText('2 runs')).toBeInTheDocument()
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('opens historical comparison only from a terminal non-success row', () => {
    render(<RunHistoryList {...props} />)

    const failedRow = screen.getByRole('article', { name: 'Run failed-run' })
    fireEvent.click(within(failedRow).getByRole('button', { name: /Compare run failed-run/i }))
    expect(screen.getByTestId('comparison-dialog-stub')).toHaveTextContent('failed-run')
    expect(screen.queryByRole('button', { name: /Compare run successful-run/i })).not.toBeInTheDocument()
  })
})
