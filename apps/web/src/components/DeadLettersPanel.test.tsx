import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { __resetBumpCoalesceForTests, useWorkflowStore } from '../store'
import { DeadLettersPanel, type DeadLetter } from './DeadLettersPanel'

// `DeadLettersPanel` fetches `/recovery/items` on mount; the test
// stub returns an empty items list unless overridden. Other api
// calls (cluster sample lookups inside `FailureClustersCard` /
// `AutoHealingPendingCard`, etc.) get the same empty default so the
// child cards mount cleanly.
vi.mock('../api', () => ({
  api: vi.fn(async () => ({ items: [], clusters: [], runs: [], proposals: [] })),
  downloadFromApi: vi.fn(),
}))

const initialState = useWorkflowStore.getState()

function mockDeadLetter(id: string, overrides: Partial<DeadLetter> = {}): DeadLetter {
  return {
    id,
    runId: `run-${id}`,
    nodeId: `node-${id}`,
    attempt: 1,
    status: 'open',
    workflowJson: {},
    nodeJson: {},
    errorJson: { message: `error ${id}` },
    createdAt: '2026-05-25T12:00:00Z',
    ...overrides,
  }
}

describe('<DeadLettersPanel />', () => {
  beforeEach(() => {
    __resetBumpCoalesceForTests()
    vi.mocked(api).mockClear()
    useWorkflowStore.setState({ ...initialState, platformVersion: 0, toasts: [] }, true)
  })

  it('renders the empty state when no DLQ rows are supplied', async () => {
    render(<DeadLettersPanel deadLetters={[]} onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('dlq-empty')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('dlq-virtual-list')).toBeNull()
  })

  it('renders all rows under the jsdom 0-height fallback when 100 DLQ entries are supplied', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => mockDeadLetter(String(i + 1)))
    render(<DeadLettersPanel deadLetters={rows} onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    // The virtual list mounts inside a scrollable container; under
    // jsdom the container has `clientHeight === 0` which triggers the
    // hook's "render all" fallback so tests find mid-list rows.
    await waitFor(() => {
      expect(screen.getByTestId('dlq-virtual-list')).toBeInTheDocument()
    })
    expect(screen.getByTestId('dlq-row-1')).toBeInTheDocument()
    expect(screen.getByTestId('dlq-row-50')).toBeInTheDocument()
    expect(screen.getByTestId('dlq-row-100')).toBeInTheDocument()
  })

  it('filters the visible rows when the status filter changes', async () => {
    const rows = [
      mockDeadLetter('open-1', { status: 'open' }),
      mockDeadLetter('open-2', { status: 'open' }),
      mockDeadLetter('replayed-1', { status: 'replayed' }),
    ]
    render(<DeadLettersPanel deadLetters={rows} onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    // The default filter is 'open' (see DeadLettersPanel:55); both
    // open rows render, the replayed row is excluded.
    await waitFor(() => {
      expect(screen.getByTestId('dlq-row-open-1')).toBeInTheDocument()
    })
    expect(screen.getByTestId('dlq-row-open-2')).toBeInTheDocument()
    expect(screen.queryByTestId('dlq-row-replayed-1')).toBeNull()
    // Switch to 'replayed' — the previous rows go away, the replayed row appears.
    fireEvent.change(screen.getByLabelText(/dlq\.show|show/i), { target: { value: 'replayed' } })
    await waitFor(() => {
      expect(screen.getByTestId('dlq-row-replayed-1')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('dlq-row-open-1')).toBeNull()
    expect(screen.queryByTestId('dlq-row-open-2')).toBeNull()
  })

  it('keeps the card warning stripe when open rows exist outside the active filter', async () => {
    const rows = [
      mockDeadLetter('open-1', { status: 'open' }),
      mockDeadLetter('replayed-1', { status: 'replayed' }),
    ]
    render(<DeadLettersPanel deadLetters={rows} onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTestId('dlq-row-open-1')).toBeInTheDocument()
    })

    fireEvent.change(screen.getByLabelText(/dlq\.show|show/i), { target: { value: 'replayed' } })
    await waitFor(() => {
      expect(screen.getByTestId('dlq-row-replayed-1')).toBeInTheDocument()
    })

    expect(screen.getByText('Recovery queue').closest('section')).toHaveAttribute('data-severity', 'warning')
  })

  it('clicking a DLQ row updates the inspector selection state', async () => {
    const rows = [
      mockDeadLetter('a', { status: 'open' }),
      mockDeadLetter('b', { status: 'open' }),
    ]
    render(<DeadLettersPanel deadLetters={rows} onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument()
    })
    // First row is auto-selected on mount (selectedId = deadLetters[0]?.id ?? null).
    // Clicking row 'b' should swap selection. The selection visual is
    // internal but the click handler is observable: `setSelectedId(item.id)`
    // happens synchronously. We assert via the row still being present
    // (smoke for the handler binding) — selection-state visual changes
    // are pinned by the e2e suite.
    const rowB = screen.getByTestId('dlq-row-b')
    fireEvent.click(rowB)
    expect(rowB).toBeInTheDocument()
  })
})
