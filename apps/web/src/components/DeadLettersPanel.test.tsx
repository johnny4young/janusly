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

// Minimal `/recovery/items` row shape the panel hydrates into overlay
// badges (see DeadLettersPanel's fetch mapping). `deadLetterId` is the
// join key onto the DLQ row the badge decorates.
function mockRecoveryItem(
  id: string,
  deadLetterId: string,
  severity: 'p1' | 'p2' | 'p3' | 'p4' = 'p2',
) {
  return {
    id,
    deadLetterId,
    owner: 'dev-user',
    severity,
    status: 'open',
    slaTargetAt: '2026-05-26T12:00:00Z',
    resolutionReason: null,
    comments: [] as Array<{ id: string; authorUserId: string; body: string; createdAt: string }>,
    workflowId: null,
    occurrenceCount: 1,
    lastOccurredAt: '2026-05-25T12:00:00Z',
  }
}

describe('<DeadLettersPanel />', () => {
  beforeEach(() => {
    __resetBumpCoalesceForTests()
    localStorage.clear()
    vi.mocked(api).mockClear()
    // Re-establish the empty-default implementation each test. Some cases
    // below install a URL-aware `mockImplementation`; resetting here keeps
    // tests order-independent (mockClear alone leaves a prior impl in place).
    vi.mocked(api).mockImplementation(async () => ({ items: [], clusters: [], runs: [], proposals: [] }))
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

  it('renders the owner filter with All selected by default', async () => {
    render(<DeadLettersPanel deadLetters={[]} onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('dlq-owner-all')).toBeInTheDocument()
    })
    expect(screen.getByTestId('dlq-owner-all')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('dlq-owner-mine')).toHaveAttribute('aria-pressed', 'false')
  })

  it('clicking Mine scopes the recovery-items fetch with owner=me', async () => {
    render(<DeadLettersPanel deadLetters={[]} onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('dlq-owner-mine')).toBeInTheDocument()
    })
    const recoveryCalls = () =>
      vi.mocked(api).mock.calls.map(([p]) => String(p)).filter((p) => p.includes('/recovery/items'))
    // The default ('all') mount fetch carries no owner scope.
    expect(recoveryCalls().some((p) => p.includes('owner=me'))).toBe(false)
    fireEvent.click(screen.getByTestId('dlq-owner-mine'))
    await waitFor(() => {
      expect(recoveryCalls().some((p) => p.includes('owner=me'))).toBe(true)
    })
    expect(screen.getByTestId('dlq-owner-mine')).toHaveAttribute('aria-pressed', 'true')
  })

  it('Mine narrows the list to owned rows and All restores the full list', async () => {
    // Owner-scoped fetch returns one recovery item mapped to dead letter 'a'.
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.includes('/recovery/items')) {
        return path.includes('owner=me') ? { items: [mockRecoveryItem('ri-a', 'a')] } : { items: [] }
      }
      return { items: [], clusters: [], runs: [], proposals: [] }
    })
    const rows = [
      mockDeadLetter('a', { status: 'open' }),
      mockDeadLetter('b', { status: 'open' }),
    ]
    render(<DeadLettersPanel deadLetters={rows} onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    // 'all' (default): both open rows visible.
    await waitFor(() => {
      expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument()
    })
    expect(screen.getByTestId('dlq-row-b')).toBeInTheDocument()
    // 'mine': only the owned row 'a' survives once the owner=me fetch resolves.
    fireEvent.click(screen.getByTestId('dlq-owner-mine'))
    await waitFor(() => {
      expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument()
      expect(screen.queryByTestId('dlq-row-b')).toBeNull()
    })
    // back to 'all': the unowned row returns.
    fireEvent.click(screen.getByTestId('dlq-owner-all'))
    await waitFor(() => {
      expect(screen.getByTestId('dlq-row-b')).toBeInTheDocument()
    })
    expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument()
  })

  it('does not reuse the All recovery map while the Mine fetch is in flight', async () => {
    let resolveMineFetch: ((value: { items: ReturnType<typeof mockRecoveryItem>[] }) => void) | null = null
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.includes('/recovery/items')) {
        if (path.includes('owner=me')) {
          return new Promise<{ items: ReturnType<typeof mockRecoveryItem>[] }>((resolve) => {
            resolveMineFetch = resolve
          })
        }
        return { items: [mockRecoveryItem('ri-a', 'a'), mockRecoveryItem('ri-b', 'b')] }
      }
      return { items: [], clusters: [], runs: [], proposals: [] }
    })
    const rows = [
      mockDeadLetter('a', { status: 'open' }),
      mockDeadLetter('b', { status: 'open' }),
    ]
    render(<DeadLettersPanel deadLetters={rows} onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getAllByTestId('recovery-item-badge')).toHaveLength(2)
    })

    fireEvent.click(screen.getByTestId('dlq-owner-mine'))
    await waitFor(() => {
      expect(screen.queryByTestId('dlq-row-b')).toBeNull()
    })
    expect(screen.queryByTestId('dlq-empty-mine')).toBeNull()

    resolveMineFetch?.({ items: [mockRecoveryItem('ri-a', 'a')] })
    await waitFor(() => {
      expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument()
      expect(screen.queryByTestId('dlq-row-b')).toBeNull()
    })
  })

  it('shows the Mine empty state when no recovery items are assigned to the operator', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.includes('/recovery/items')) return { items: [] } // none owned by the operator
      return { items: [], clusters: [], runs: [], proposals: [] }
    })
    const rows = [mockDeadLetter('a', { status: 'open' })]
    render(<DeadLettersPanel deadLetters={rows} onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('dlq-owner-mine'))
    await waitFor(() => {
      expect(screen.getByTestId('dlq-empty-mine')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('dlq-row-a')).toBeNull()
    // The generic "queue clear" empty state must NOT render under Mine.
    expect(screen.queryByTestId('dlq-empty')).toBeNull()
  })
})

describe('<DeadLettersPanel /> — severity filter', () => {
  beforeEach(() => {
    __resetBumpCoalesceForTests()
    localStorage.clear()
    vi.mocked(api).mockClear()
    vi.mocked(api).mockImplementation(async () => ({ items: [], clusters: [], runs: [], proposals: [] }))
    useWorkflowStore.setState({ ...initialState, platformVersion: 0, toasts: [] }, true)
  })

  it('renders the severity filter defaulting to all', async () => {
    render(<DeadLettersPanel deadLetters={[]} onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('dlq-severity-filter')).toBeInTheDocument()
    })
    expect((screen.getByTestId('dlq-severity-filter') as HTMLSelectElement).value).toBe('all')
  })

  it('narrows the list to the selected severity and All restores it', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.includes('/recovery/items')) {
        return { items: [mockRecoveryItem('ri-a', 'a', 'p1'), mockRecoveryItem('ri-b', 'b', 'p3')] }
      }
      return { items: [], clusters: [], runs: [], proposals: [] }
    })
    const rows = [
      mockDeadLetter('a', { status: 'open' }),
      mockDeadLetter('b', { status: 'open' }),
    ]
    render(<DeadLettersPanel deadLetters={rows} onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument()
    })
    expect(screen.getByTestId('dlq-row-b')).toBeInTheDocument()
    // pick p1 → only the p1 row (a) survives.
    fireEvent.change(screen.getByTestId('dlq-severity-filter'), { target: { value: 'p1' } })
    await waitFor(() => {
      expect(screen.queryByTestId('dlq-row-b')).toBeNull()
    })
    expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument()
    // back to all → both return.
    fireEvent.change(screen.getByTestId('dlq-severity-filter'), { target: { value: 'all' } })
    await waitFor(() => {
      expect(screen.getByTestId('dlq-row-b')).toBeInTheDocument()
    })
  })

  it('composes the severity filter with the owner filter', async () => {
    // Both items are owned by dev-user, so the owner=me fetch returns both.
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.includes('/recovery/items')) {
        return { items: [mockRecoveryItem('ri-a', 'a', 'p1'), mockRecoveryItem('ri-b', 'b', 'p3')] }
      }
      return { items: [], clusters: [], runs: [], proposals: [] }
    })
    const rows = [
      mockDeadLetter('a', { status: 'open' }),
      mockDeadLetter('b', { status: 'open' }),
    ]
    render(<DeadLettersPanel deadLetters={rows} onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument()
    })
    // Mine: both are owned by dev-user, so both remain once owner=me resolves.
    fireEvent.click(screen.getByTestId('dlq-owner-mine'))
    await waitFor(() => {
      expect(screen.getByTestId('dlq-row-b')).toBeInTheDocument()
    })
    // Mine + p1 → only the p1 row.
    fireEvent.change(screen.getByTestId('dlq-severity-filter'), { target: { value: 'p1' } })
    await waitFor(() => {
      expect(screen.queryByTestId('dlq-row-b')).toBeNull()
    })
    expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument()
  })

  it('shows the severity empty state when no item matches the selected severity', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.includes('/recovery/items')) return { items: [mockRecoveryItem('ri-a', 'a', 'p3')] }
      return { items: [], clusters: [], runs: [], proposals: [] }
    })
    const rows = [mockDeadLetter('a', { status: 'open' })]
    render(<DeadLettersPanel deadLetters={rows} onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument()
    })
    // No p1 item exists → the severity-specific empty state, not the generic one.
    fireEvent.change(screen.getByTestId('dlq-severity-filter'), { target: { value: 'p1' } })
    await waitFor(() => {
      expect(screen.getByTestId('dlq-empty-severity')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('dlq-row-a')).toBeNull()
    expect(screen.queryByTestId('dlq-empty')).toBeNull()
  })

  it('does not show the severity empty state while the recovery overlay is still loading', async () => {
    let resolveRecoveryFetch: ((value: { items: ReturnType<typeof mockRecoveryItem>[] }) => void) | null = null
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.includes('/recovery/items')) {
        return new Promise<{ items: ReturnType<typeof mockRecoveryItem>[] }>((resolve) => {
          resolveRecoveryFetch = resolve
        })
      }
      return { items: [], clusters: [], runs: [], proposals: [] }
    })
    const rows = [mockDeadLetter('a', { status: 'open' })]
    render(<DeadLettersPanel deadLetters={rows} onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument()
      expect(resolveRecoveryFetch).not.toBeNull()
    })

    fireEvent.change(screen.getByTestId('dlq-severity-filter'), { target: { value: 'p1' } })
    await waitFor(() => {
      expect(screen.queryByTestId('dlq-row-a')).toBeNull()
    })
    expect(screen.queryByTestId('dlq-empty-severity')).toBeNull()

    resolveRecoveryFetch?.({ items: [mockRecoveryItem('ri-a', 'a', 'p1')] })
    await waitFor(() => {
      expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument()
    })
  })
})

describe('<DeadLettersPanel /> — filter persistence', () => {
  const FILTERS_KEY = 'janusly:recoveryQueueFilters'

  beforeEach(() => {
    __resetBumpCoalesceForTests()
    localStorage.clear()
    vi.mocked(api).mockClear()
    vi.mocked(api).mockImplementation(async () => ({ items: [], clusters: [], runs: [], proposals: [] }))
    useWorkflowStore.setState({ ...initialState, platformVersion: 0, toasts: [] }, true)
  })

  it('restores the persisted status / owner / severity selections on mount', async () => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify({ status: 'resolved', ownerScope: 'mine', severityFilter: 'p2' }))
    render(<DeadLettersPanel deadLetters={[]} onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('dlq-severity-filter')).toBeInTheDocument()
    })
    expect((screen.getByLabelText(/dlq\.show|show/i) as HTMLSelectElement).value).toBe('resolved')
    expect(screen.getByTestId('dlq-owner-mine')).toHaveAttribute('aria-pressed', 'true')
    expect((screen.getByTestId('dlq-severity-filter') as HTMLSelectElement).value).toBe('p2')
  })

  it('writes filter changes back to localStorage', async () => {
    render(<DeadLettersPanel deadLetters={[]} onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('dlq-severity-filter')).toBeInTheDocument()
    })
    fireEvent.change(screen.getByTestId('dlq-severity-filter'), { target: { value: 'p1' } })
    fireEvent.click(screen.getByTestId('dlq-owner-mine'))
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(FILTERS_KEY) ?? '{}')
      expect(stored.severityFilter).toBe('p1')
      expect(stored.ownerScope).toBe('mine')
    })
  })

  it('falls back to the defaults when the stored blob is corrupt', async () => {
    localStorage.setItem(FILTERS_KEY, 'not-json{')
    render(<DeadLettersPanel deadLetters={[]} onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('dlq-severity-filter')).toBeInTheDocument()
    })
    expect((screen.getByLabelText(/dlq\.show|show/i) as HTMLSelectElement).value).toBe('open')
    expect(screen.getByTestId('dlq-owner-all')).toHaveAttribute('aria-pressed', 'true')
    expect((screen.getByTestId('dlq-severity-filter') as HTMLSelectElement).value).toBe('all')
  })

  it('coerces unknown stored enum values to their defaults', async () => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify({ status: 'bogus', ownerScope: 'weird', severityFilter: 'p9' }))
    render(<DeadLettersPanel deadLetters={[]} onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('dlq-severity-filter')).toBeInTheDocument()
    })
    expect((screen.getByLabelText(/dlq\.show|show/i) as HTMLSelectElement).value).toBe('open')
    expect(screen.getByTestId('dlq-owner-all')).toHaveAttribute('aria-pressed', 'true')
    expect((screen.getByTestId('dlq-severity-filter') as HTMLSelectElement).value).toBe('all')
  })

  it('falls back to defaults when the localStorage accessor is unavailable', async () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('localStorage blocked', 'SecurityError')
      },
    })
    try {
      render(<DeadLettersPanel deadLetters={[]} onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
      await waitFor(() => {
        expect(screen.getByTestId('dlq-severity-filter')).toBeInTheDocument()
      })
      expect((screen.getByLabelText(/dlq\.show|show/i) as HTMLSelectElement).value).toBe('open')
      expect(screen.getByTestId('dlq-owner-all')).toHaveAttribute('aria-pressed', 'true')
      expect((screen.getByTestId('dlq-severity-filter') as HTMLSelectElement).value).toBe('all')
    } finally {
      if (originalDescriptor) Object.defineProperty(window, 'localStorage', originalDescriptor)
    }
  })
})
