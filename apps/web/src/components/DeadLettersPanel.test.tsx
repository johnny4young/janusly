import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { __resetBumpCoalesceForTests, useWorkflowStore } from '../store'
import { DeadLettersPanel, type DeadLetter, type DeadLetterRecovery } from './DeadLettersPanel'

// `DeadLettersPanel`'s hook fetches `/dlq/queue?…` itself now — the server
// filters + sorts before the page cap, folds the recovery overlay inline, and
// returns a { items, nextCursor, hasMore } keyset envelope. The default stub
// returns an empty page; `dlqMock` simulates the server for filter/sort cases.
// Child cards (FailureClustersCard / AutoHealingPendingCard) get empty defaults.
vi.mock('../api', () => ({
  api: vi.fn(async (path?: unknown) => {
    if (typeof path !== 'string') return { items: [], clusters: [], runs: [], proposals: [] }
    if (path.startsWith('/dlq/counts')) return { total: 0, open: 0, replayed: 0, resolved: 0 }
    if (path.startsWith('/dlq/queue')) return { items: [] as DeadLetter[], nextCursor: null, hasMore: false }
    return { items: [], clusters: [], runs: [], proposals: [] }
  }),
  downloadFromApi: vi.fn(),
}))

const initialState = useWorkflowStore.getState()

// The recovery queue makes TWO fetches: `/dlq/queue?…` (the filtered/paginated
// list) and `/dlq/counts` (the org-wide mini-grid summary). The sibling
// `/dlq/clusters` + `/auto-healing/*` cards expect object shapes. Default to an
// empty page / zero counts and card-safe objects for the rest.
const defaultApiMock = async (path: string): Promise<unknown> => {
  if (path.startsWith('/dlq/counts')) return { total: 0, open: 0, replayed: 0, resolved: 0 }
  if (path.startsWith('/dlq/queue')) return { items: [] as DeadLetter[], nextCursor: null, hasMore: false }
  return { items: [], clusters: [], runs: [], proposals: [] }
}

function overlay(id: string, severity: 'p1' | 'p2' | 'p3' | 'p4' = 'p2'): DeadLetterRecovery {
  return {
    id,
    owner: 'dev-user',
    severity,
    status: 'open',
    slaTargetAt: '2026-05-26T12:00:00Z',
    resolutionReason: null,
    comments: [],
    workflowId: null,
    occurrenceCount: 1,
    lastOccurredAt: '2026-05-25T12:00:00Z',
  }
}

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

const SEVERITY_RANK: Record<string, number> = { p1: 0, p2: 1, p3: 2, p4: 3 }

/** The org-wide status breakdown `/dlq/counts` returns — derived from the FULL
 *  row set, never the filtered page (that is the endpoint's whole point). */
function countsFromRows(rows: DeadLetter[]) {
  return {
    total: rows.length,
    open: rows.filter((r) => r.status === 'open').length,
    replayed: rows.filter((r) => r.status === 'replayed').length,
    resolved: rows.filter((r) => r.status === 'resolved').length,
  }
}

/** Simulate the server: `/dlq/counts` returns the org-wide breakdown of the FULL
 *  row set; `/dlq/queue` filters + sorts by the query params and returns one
 *  (no-more) keyset page — so a panel test exercises the real "server filters,
 *  panel renders" contract. Other calls (child cards) get empty defaults. */
function dlqMock(rows: DeadLetter[]) {
  return async (path: string, options?: RequestInit): Promise<unknown> => {
    if (path === '/dlq/bulk-resolve') {
      const ids = JSON.parse(String(options?.body ?? '{}')).deadLetterIds as string[] | undefined
      return { resolved: ids?.length ?? 0, failed: 0, errors: [] }
    }
    if (path === '/dlq/bulk-replay') {
      const ids = JSON.parse(String(options?.body ?? '{}')).deadLetterIds as string[] | undefined
      return { replayed: ids?.length ?? 0, failed: 0, errors: [] }
    }
    if (path.startsWith('/dlq/counts')) return countsFromRows(rows)
    if (!path.startsWith('/dlq/queue')) return { items: [], clusters: [], runs: [], proposals: [] }
    const params = new URL(path, 'http://x').searchParams
    let out = rows
    const status = params.get('status')
    if (status) out = out.filter((r) => r.status === status)
    if (params.get('owner') === 'me') out = out.filter((r) => r.recovery?.owner === 'dev-user')
    const severity = params.get('severity')
    if (severity) out = out.filter((r) => r.recovery?.severity === severity)
    const search = params.get('search')
    if (search) {
      const q = search.toLowerCase()
      out = out.filter(
        (r) =>
          r.nodeId.toLowerCase().includes(q) ||
          r.runId.toLowerCase().includes(q) ||
          String((r.errorJson as { message?: string })?.message ?? '').toLowerCase().includes(q),
      )
    }
    if (params.get('sort') === 'severity') {
      out = [...out].sort(
        (a, b) => (SEVERITY_RANK[a.recovery?.severity ?? ''] ?? 4) - (SEVERITY_RANK[b.recovery?.severity ?? ''] ?? 4),
      )
    }
    return { items: out, nextCursor: null, hasMore: false }
  }
}

/** The query params of the most recent `/dlq/queue` fetch the panel's hook issued. */
function lastDlqParams(): URLSearchParams | null {
  const calls = vi.mocked(api).mock.calls
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const path = String(calls[i][0])
    if (path.startsWith('/dlq/queue')) return new URL(path, 'http://x').searchParams
  }
  return null
}

describe('<DeadLettersPanel />', () => {
  beforeEach(() => {
    __resetBumpCoalesceForTests()
    localStorage.clear()
    vi.mocked(api).mockClear()
    vi.mocked(api).mockImplementation(defaultApiMock)
    useWorkflowStore.setState({ ...initialState, platformVersion: 0, toasts: [] }, true)
  })

  it('renders the empty state when the server returns no rows', async () => {
    vi.mocked(api).mockImplementation(dlqMock([]))
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('dlq-empty')).toBeInTheDocument()
    })
  })

  it('renders all rows under the jsdom 0-height fallback when the server returns 100', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => mockDeadLetter(String(i + 1)))
    vi.mocked(api).mockImplementation(dlqMock(rows))
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getAllByTestId(/^dlq-row-/).length).toBe(100)
    })
  })

  it('refetches /dlq with the chosen status when the status filter changes', async () => {
    const rows = [
      mockDeadLetter('open-1', { status: 'open' }),
      mockDeadLetter('replayed-1', { status: 'replayed' }),
    ]
    vi.mocked(api).mockImplementation(dlqMock(rows))
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    // Default status 'open' → server returns only the open row.
    await waitFor(() => expect(screen.getByTestId('dlq-row-open-1')).toBeInTheDocument())
    expect(screen.queryByTestId('dlq-row-replayed-1')).toBeNull()
    fireEvent.change(screen.getByLabelText(/dlq\.show|show/i), { target: { value: 'replayed' } })
    await waitFor(() => {
      expect(lastDlqParams()?.get('status')).toBe('replayed')
      expect(screen.getByTestId('dlq-row-replayed-1')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('dlq-row-open-1')).toBeNull()
  })

  it('refresh button refetches the server-driven recovery queue', async () => {
    const onRefresh = vi.fn()
    vi.mocked(api).mockImplementation(dlqMock([mockDeadLetter('a')]))
    render(<DeadLettersPanel onRefresh={onRefresh} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument())
    const initialDlqCalls = vi.mocked(api).mock.calls.filter(([path]) => String(path).startsWith('/dlq/queue')).length

    fireEvent.click(screen.getByRole('button', { name: /dlq\.refresh|refresh/i }))

    await waitFor(() => {
      const nextDlqCalls = vi.mocked(api).mock.calls.filter(([path]) => String(path).startsWith('/dlq/queue')).length
      expect(nextDlqCalls).toBeGreaterThan(initialDlqCalls)
    })
    expect(onRefresh).toHaveBeenCalled()
  })

  it('renders Load more when the server reports a next page and appends on click', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (!path.startsWith('/dlq/queue')) return { items: [], clusters: [], runs: [], proposals: [] }
      const params = new URL(path, 'http://x').searchParams
      if (params.get('cursor') === 'c1') return { items: [mockDeadLetter('b')], nextCursor: null, hasMore: false }
      return { items: [mockDeadLetter('a')], nextCursor: 'c1', hasMore: true }
    })
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument())
    const button = screen.getByTestId('dlq-load-more')
    expect(button).toBeInTheDocument()

    fireEvent.click(button)
    await waitFor(() => expect(screen.getByTestId('dlq-row-b')).toBeInTheDocument())
    // Page 1's row remains (append, not replace); the button hides at the end.
    expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument()
    expect(screen.queryByTestId('dlq-load-more')).toBeNull()
  })

  it('hides Load more when the server reports no next page', async () => {
    vi.mocked(api).mockImplementation(dlqMock([mockDeadLetter('a')])) // dlqMock → hasMore: false
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument())
    expect(screen.queryByTestId('dlq-load-more')).toBeNull()
  })

  it('disables Load more while the next page is in flight', async () => {
    let resolveNext: ((value: unknown) => void) | null = null
    vi.mocked(api).mockImplementation((path: string) => {
      if (!path.startsWith('/dlq/queue')) return Promise.resolve({ items: [], clusters: [], runs: [], proposals: [] })
      const params = new URL(path, 'http://x').searchParams
      if (params.get('cursor') === 'c1') {
        return new Promise((resolve) => {
          resolveNext = resolve
        }) as unknown as Promise<unknown>
      }
      return Promise.resolve({ items: [mockDeadLetter('a')], nextCursor: 'c1', hasMore: true })
    })
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('dlq-load-more')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('dlq-load-more'))
    await waitFor(() => expect(screen.getByTestId('dlq-load-more')).toBeDisabled())
    resolveNext?.({ items: [mockDeadLetter('b')], nextCursor: null, hasMore: false })
    await waitFor(() => expect(screen.getByTestId('dlq-row-b')).toBeInTheDocument())
  })

  it('shows the warning stripe from the org-wide open count, not the visible page', async () => {
    // Empty loaded page, but the org-wide counts report opens → stripe still on.
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.startsWith('/dlq/counts')) return { total: 5, open: 3, replayed: 1, resolved: 1 }
      if (path.startsWith('/dlq/queue')) return { items: [], nextCursor: null, hasMore: false }
      return { items: [], clusters: [], runs: [], proposals: [] }
    })
    const { container } = render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => expect(container.querySelector('[data-severity="warning"]')).not.toBeNull())
  })

  it('renders the mini-grid from org-wide /dlq/counts, not the loaded page', async () => {
    // The loaded page has 1 open row; the org-wide counts are 120/100/15/5.
    // The mini-grid must show the org-wide breakdown instead of the filtered
    // page, so paging or filters cannot make the queue-health summary drift.
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.startsWith('/dlq/counts')) return { total: 120, open: 100, replayed: 15, resolved: 5 }
      if (path.startsWith('/dlq/queue')) return { items: [mockDeadLetter('a', { status: 'open' })], nextCursor: null, hasMore: false }
      return { items: [], clusters: [], runs: [], proposals: [] }
    })
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument())
    const values = [...document.querySelectorAll('.mini-grid strong')].map((s) => s.textContent)
    expect(values).toEqual(['120', '100', '15', '5'])
  })

  it('clicking a DLQ row keeps the handler bound (selection smoke)', async () => {
    vi.mocked(api).mockImplementation(dlqMock([mockDeadLetter('a'), mockDeadLetter('b')]))
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument())
    const rowB = screen.getByTestId('dlq-row-b')
    fireEvent.click(rowB)
    expect(rowB).toBeInTheDocument()
  })

  it('renders the owner filter with All selected by default', async () => {
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('dlq-owner-all')).toBeInTheDocument())
    expect(screen.getByTestId('dlq-owner-all')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('dlq-owner-mine')).toHaveAttribute('aria-pressed', 'false')
  })

  it('clicking Mine scopes the /dlq fetch with owner=me', async () => {
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('dlq-owner-mine')).toBeInTheDocument())
    expect(lastDlqParams()?.get('owner')).toBeNull()
    fireEvent.click(screen.getByTestId('dlq-owner-mine'))
    await waitFor(() => expect(lastDlqParams()?.get('owner')).toBe('me'))
    expect(screen.getByTestId('dlq-owner-mine')).toHaveAttribute('aria-pressed', 'true')
  })

  it('Mine narrows the list to owned rows and All restores the full list', async () => {
    const rows = [
      mockDeadLetter('a', { recovery: overlay('ri-a') }), // owned (owner=dev-user)
      mockDeadLetter('b', { recovery: null }), // unowned
    ]
    vi.mocked(api).mockImplementation(dlqMock(rows))
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument())
    expect(screen.getByTestId('dlq-row-b')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('dlq-owner-mine'))
    await waitFor(() => {
      expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument()
      expect(screen.queryByTestId('dlq-row-b')).toBeNull()
    })
    fireEvent.click(screen.getByTestId('dlq-owner-all'))
    await waitFor(() => expect(screen.getByTestId('dlq-row-b')).toBeInTheDocument())
  })

  it('shows the Mine empty state when the operator owns nothing', async () => {
    vi.mocked(api).mockImplementation(dlqMock([mockDeadLetter('a', { recovery: null })]))
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('dlq-owner-mine'))
    await waitFor(() => expect(screen.getByTestId('dlq-empty-mine')).toBeInTheDocument())
    expect(screen.queryByTestId('dlq-row-a')).toBeNull()
    expect(screen.queryByTestId('dlq-empty')).toBeNull()
  })

  it('renders the recovery badge from each row inline overlay', async () => {
    vi.mocked(api).mockImplementation(dlqMock([mockDeadLetter('a', { recovery: overlay('ri-a', 'p1') })]))
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('recovery-item-badge')).toBeInTheDocument())
  })
})

describe('<DeadLettersPanel /> — severity filter', () => {
  beforeEach(() => {
    __resetBumpCoalesceForTests()
    localStorage.clear()
    vi.mocked(api).mockClear()
    vi.mocked(api).mockImplementation(defaultApiMock)
    useWorkflowStore.setState({ ...initialState, platformVersion: 0, toasts: [] }, true)
  })

  it('renders the severity filter defaulting to all', async () => {
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('dlq-severity-filter')).toBeInTheDocument())
    expect((screen.getByTestId('dlq-severity-filter') as HTMLSelectElement).value).toBe('all')
  })

  it('refetches with the severity and narrows the list, then All restores it', async () => {
    const rows = [
      mockDeadLetter('a', { recovery: overlay('ri-a', 'p1') }),
      mockDeadLetter('b', { recovery: overlay('ri-b', 'p3') }),
    ]
    vi.mocked(api).mockImplementation(dlqMock(rows))
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument())
    fireEvent.change(screen.getByTestId('dlq-severity-filter'), { target: { value: 'p1' } })
    await waitFor(() => {
      expect(lastDlqParams()?.get('severity')).toBe('p1')
      expect(screen.queryByTestId('dlq-row-b')).toBeNull()
    })
    expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('dlq-severity-filter'), { target: { value: 'all' } })
    await waitFor(() => expect(screen.getByTestId('dlq-row-b')).toBeInTheDocument())
  })

  it('composes the severity filter with the owner filter (both params sent)', async () => {
    const rows = [
      mockDeadLetter('a', { recovery: overlay('ri-a', 'p1') }),
      mockDeadLetter('b', { recovery: overlay('ri-b', 'p3') }),
    ]
    vi.mocked(api).mockImplementation(dlqMock(rows))
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('dlq-owner-mine'))
    fireEvent.change(screen.getByTestId('dlq-severity-filter'), { target: { value: 'p1' } })
    await waitFor(() => {
      const params = lastDlqParams()
      expect(params?.get('owner')).toBe('me')
      expect(params?.get('severity')).toBe('p1')
      expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument()
      expect(screen.queryByTestId('dlq-row-b')).toBeNull()
    })
  })

  it('shows the severity empty state when no row matches the selected severity', async () => {
    vi.mocked(api).mockImplementation(dlqMock([mockDeadLetter('a', { recovery: overlay('ri-a', 'p3') })]))
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument())
    fireEvent.change(screen.getByTestId('dlq-severity-filter'), { target: { value: 'p1' } })
    await waitFor(() => expect(screen.getByTestId('dlq-empty-severity')).toBeInTheDocument())
    expect(screen.queryByTestId('dlq-row-a')).toBeNull()
    expect(screen.queryByTestId('dlq-empty')).toBeNull()
  })

  it('does not flash the severity empty state while the /dlq/queue fetch is in flight', async () => {
    const rows = [mockDeadLetter('a', { recovery: overlay('ri-a', 'p3') })]
    let resolvePending: ((value: unknown) => void) | null = null
    vi.mocked(api).mockImplementation((path: string) => {
      if (!path.startsWith('/dlq/queue')) return Promise.resolve({ items: [], clusters: [], runs: [], proposals: [] })
      const params = new URL(path, 'http://x').searchParams
      if (params.get('severity') === 'p1') {
        return new Promise((resolve) => {
          resolvePending = resolve
        }) as unknown as Promise<unknown>
      }
      return Promise.resolve({ items: rows, nextCursor: null, hasMore: false })
    })
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument())
    fireEvent.change(screen.getByTestId('dlq-severity-filter'), { target: { value: 'p1' } })
    // While the p1 fetch is in flight the panel shows the previous page
    // (stale-while-loading) and must NOT flash the severity empty state.
    expect(screen.queryByTestId('dlq-empty-severity')).toBeNull()
    // Once the empty p1 page lands, the severity empty state renders.
    resolvePending?.({ items: [], nextCursor: null, hasMore: false })
    await waitFor(() => expect(screen.getByTestId('dlq-empty-severity')).toBeInTheDocument())
  })
})

describe('<DeadLettersPanel /> — filter persistence', () => {
  const FILTERS_KEY = 'janusly:recoveryQueueFilters'

  beforeEach(() => {
    __resetBumpCoalesceForTests()
    localStorage.clear()
    vi.mocked(api).mockClear()
    vi.mocked(api).mockImplementation(defaultApiMock)
    useWorkflowStore.setState({ ...initialState, platformVersion: 0, toasts: [] }, true)
  })

  it('restores the persisted status / owner / severity selections on mount', async () => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify({ status: 'resolved', ownerScope: 'mine', severityFilter: 'p2' }))
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('dlq-severity-filter')).toBeInTheDocument())
    expect((screen.getByLabelText(/dlq\.show|show/i) as HTMLSelectElement).value).toBe('resolved')
    expect(screen.getByTestId('dlq-owner-mine')).toHaveAttribute('aria-pressed', 'true')
    expect((screen.getByTestId('dlq-severity-filter') as HTMLSelectElement).value).toBe('p2')
  })

  it('writes filter changes back to localStorage', async () => {
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('dlq-severity-filter')).toBeInTheDocument())
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
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('dlq-severity-filter')).toBeInTheDocument())
    expect((screen.getByLabelText(/dlq\.show|show/i) as HTMLSelectElement).value).toBe('open')
    expect(screen.getByTestId('dlq-owner-all')).toHaveAttribute('aria-pressed', 'true')
    expect((screen.getByTestId('dlq-severity-filter') as HTMLSelectElement).value).toBe('all')
  })

  it('coerces unknown stored enum values to their defaults', async () => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify({ status: 'bogus', ownerScope: 'weird', severityFilter: 'p9' }))
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('dlq-severity-filter')).toBeInTheDocument())
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
      render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
      await waitFor(() => expect(screen.getByTestId('dlq-severity-filter')).toBeInTheDocument())
      expect((screen.getByLabelText(/dlq\.show|show/i) as HTMLSelectElement).value).toBe('open')
      expect(screen.getByTestId('dlq-owner-all')).toHaveAttribute('aria-pressed', 'true')
      expect((screen.getByTestId('dlq-severity-filter') as HTMLSelectElement).value).toBe('all')
    } finally {
      if (originalDescriptor) Object.defineProperty(window, 'localStorage', originalDescriptor)
    }
  })
})

describe('<DeadLettersPanel /> — sort', () => {
  beforeEach(() => {
    __resetBumpCoalesceForTests()
    localStorage.clear()
    vi.mocked(api).mockClear()
    vi.mocked(api).mockImplementation(defaultApiMock)
    useWorkflowStore.setState({ ...initialState, platformVersion: 0, toasts: [] }, true)
  })

  it('renders the sort control defaulting to newest', async () => {
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('dlq-sort')).toBeInTheDocument())
    expect((screen.getByTestId('dlq-sort') as HTMLSelectElement).value).toBe('newest')
  })

  it('reorders the rendered rows when sorting by severity (server-ordered)', async () => {
    const rows = [
      mockDeadLetter('a', { recovery: overlay('ri-a', 'p3') }),
      mockDeadLetter('b', { recovery: overlay('ri-b', 'p1') }),
    ]
    vi.mocked(api).mockImplementation(dlqMock(rows))
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    // Default (newest): the server returns input order a, b.
    await waitFor(() => {
      expect(screen.getAllByTestId(/^dlq-row-/).map((e) => e.getAttribute('data-testid'))).toEqual([
        'dlq-row-a',
        'dlq-row-b',
      ])
    })
    fireEvent.change(screen.getByTestId('dlq-sort'), { target: { value: 'severity' } })
    await waitFor(() => {
      expect(lastDlqParams()?.get('sort')).toBe('severity')
      expect(screen.getAllByTestId(/^dlq-row-/).map((e) => e.getAttribute('data-testid'))).toEqual([
        'dlq-row-b',
        'dlq-row-a',
      ])
    })
  })

  it('bulk-resolves the ticked rows in one /dlq/bulk-resolve request', async () => {
    const rows = [mockDeadLetter('a'), mockDeadLetter('b'), mockDeadLetter('c')]
    vi.mocked(api).mockImplementation(dlqMock(rows))
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await screen.findByTestId('dlq-row-a')

    // Enter selection mode → per-row checkboxes appear; tick two rows.
    fireEvent.click(screen.getByTestId('dlq-select-toggle'))
    fireEvent.click(await screen.findByTestId('dlq-select-row-a'))
    fireEvent.click(screen.getByTestId('dlq-select-row-b'))
    expect(screen.getByTestId('dlq-bulk-bar')).toHaveTextContent('2 selected')

    fireEvent.click(screen.getByTestId('dlq-bulk-resolve'))
    await waitFor(() => {
      const call = vi.mocked(api).mock.calls.find(([p]) => p === '/dlq/bulk-resolve')
      expect(call).toBeTruthy()
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ deadLetterIds: ['a', 'b'] })
    })
    // A successful bulk resolve exits selection mode → the bar disappears.
    await waitFor(() => expect(screen.queryByTestId('dlq-bulk-bar')).not.toBeInTheDocument())
  })

  it('keeps failed rows selected and warns on a partial-success bulk resolve', async () => {
    const rows = [mockDeadLetter('a'), mockDeadLetter('b')]
    vi.mocked(api).mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/dlq/bulk-resolve') {
        expect(JSON.parse(String(options?.body))).toEqual({ deadLetterIds: ['a', 'b'] })
        return { resolved: 1, failed: 1, errors: [{ deadLetterId: 'b', error: 'DLQ entry not found' }] }
      }
      return dlqMock(rows)(path, options)
    })
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await screen.findByTestId('dlq-row-a')

    fireEvent.click(screen.getByTestId('dlq-select-toggle'))
    fireEvent.click(await screen.findByTestId('dlq-select-row-a'))
    fireEvent.click(screen.getByTestId('dlq-select-row-b'))
    fireEvent.click(screen.getByTestId('dlq-bulk-resolve'))

    await waitFor(() => {
      expect(screen.getByTestId('dlq-bulk-bar')).toHaveTextContent('1 selected')
      expect(screen.getByTestId('dlq-select-row-a')).not.toBeChecked()
      expect(screen.getByTestId('dlq-select-row-b')).toBeChecked()
      expect(useWorkflowStore.getState().toasts.at(-1)?.message).toContain('1 resolved, 1 failed')
    })
    // The inline detail surfaces WHICH row failed and WHY, announced as an alert.
    const errors = screen.getByTestId('dlq-bulk-errors')
    expect(errors).toHaveAttribute('role', 'alert')
    expect(errors).toHaveTextContent('b')
    expect(errors).toHaveTextContent('DLQ entry not found')
  })

  it('hides the Resolve action until a row is ticked; select-all ticks every loaded row', async () => {
    const rows = [mockDeadLetter('a'), mockDeadLetter('b'), mockDeadLetter('c')]
    vi.mocked(api).mockImplementation(dlqMock(rows))
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await screen.findByTestId('dlq-row-a')

    fireEvent.click(screen.getByTestId('dlq-select-toggle'))
    // Selection mode on, nothing ticked → no Resolve button yet.
    expect(screen.queryByTestId('dlq-bulk-resolve')).not.toBeInTheDocument()
    // Select all → every loaded row ticked → the count reflects all three.
    fireEvent.click(screen.getByTestId('dlq-select-all'))
    expect(screen.getByTestId('dlq-bulk-bar')).toHaveTextContent('3 selected')
    expect(screen.getByTestId('dlq-bulk-resolve')).toBeInTheDocument()
  })
})

describe('<DeadLettersPanel /> — bulk replay', () => {
  beforeEach(() => {
    __resetBumpCoalesceForTests()
    localStorage.clear()
    vi.mocked(api).mockClear()
    vi.mocked(api).mockImplementation(defaultApiMock)
    useWorkflowStore.setState({ ...initialState, platformVersion: 0, toasts: [] }, true)
  })

  it('offers Replay selected alongside Resolve selected once a row is ticked', async () => {
    const rows = [mockDeadLetter('a'), mockDeadLetter('b')]
    vi.mocked(api).mockImplementation(dlqMock(rows))
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await screen.findByTestId('dlq-row-a')

    fireEvent.click(screen.getByTestId('dlq-select-toggle'))
    // Nothing ticked yet → neither bulk action is shown.
    expect(screen.queryByTestId('dlq-bulk-replay')).not.toBeInTheDocument()
    fireEvent.click(await screen.findByTestId('dlq-select-row-a'))
    expect(screen.getByTestId('dlq-bulk-replay')).toBeInTheDocument()
    expect(screen.getByTestId('dlq-bulk-resolve')).toBeInTheDocument()
  })

  it('bulk-replays the ticked rows in one /dlq/bulk-replay request', async () => {
    const rows = [mockDeadLetter('a'), mockDeadLetter('b'), mockDeadLetter('c')]
    vi.mocked(api).mockImplementation(dlqMock(rows))
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await screen.findByTestId('dlq-row-a')

    // Enter selection mode → per-row checkboxes appear; tick two rows.
    fireEvent.click(screen.getByTestId('dlq-select-toggle'))
    fireEvent.click(await screen.findByTestId('dlq-select-row-a'))
    fireEvent.click(screen.getByTestId('dlq-select-row-b'))
    expect(screen.getByTestId('dlq-bulk-bar')).toHaveTextContent('2 selected')

    // Arming the confirm must not fire the request on its own.
    fireEvent.click(screen.getByTestId('dlq-bulk-replay'))
    expect(vi.mocked(api).mock.calls.find(([p]) => p === '/dlq/bulk-replay')).toBeFalsy()
    fireEvent.click(screen.getByTestId('dlq-bulk-replay-confirm'))
    await waitFor(() => {
      const call = vi.mocked(api).mock.calls.find(([p]) => p === '/dlq/bulk-replay')
      expect(call).toBeTruthy()
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ deadLetterIds: ['a', 'b'] })
    })
    // A successful bulk replay exits selection mode → the bar disappears.
    await waitFor(() => expect(screen.queryByTestId('dlq-bulk-bar')).not.toBeInTheDocument())
  })

  it('keeps failed rows selected and warns on a partial-success bulk replay', async () => {
    const rows = [mockDeadLetter('a'), mockDeadLetter('b')]
    vi.mocked(api).mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/dlq/bulk-replay') {
        expect(JSON.parse(String(options?.body))).toEqual({ deadLetterIds: ['a', 'b'] })
        // dl-b was already replayed by another path → reported in the failed set.
        return { replayed: 1, failed: 1, errors: [{ deadLetterId: 'b', error: 'DLQ entry already replayed' }] }
      }
      return dlqMock(rows)(path, options)
    })
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await screen.findByTestId('dlq-row-a')

    fireEvent.click(screen.getByTestId('dlq-select-toggle'))
    fireEvent.click(await screen.findByTestId('dlq-select-row-a'))
    fireEvent.click(screen.getByTestId('dlq-select-row-b'))
    fireEvent.click(screen.getByTestId('dlq-bulk-replay'))
    fireEvent.click(screen.getByTestId('dlq-bulk-replay-confirm'))

    await waitFor(() => {
      expect(screen.getByTestId('dlq-bulk-bar')).toHaveTextContent('1 selected')
      expect(screen.getByTestId('dlq-select-row-a')).not.toBeChecked()
      expect(screen.getByTestId('dlq-select-row-b')).toBeChecked()
      expect(useWorkflowStore.getState().toasts.at(-1)?.message).toContain('1 replayed, 1 failed')
    })
  })
})

describe('<DeadLettersPanel /> — search', () => {
  beforeEach(() => {
    __resetBumpCoalesceForTests()
    localStorage.clear()
    vi.mocked(api).mockClear()
    vi.mocked(api).mockImplementation(defaultApiMock)
    useWorkflowStore.setState({ ...initialState, platformVersion: 0, toasts: [] }, true)
  })

  it('filters the queue by the search box (server honors ?search=)', async () => {
    const rows = [mockDeadLetter('alpha'), mockDeadLetter('beta')]
    vi.mocked(api).mockImplementation(dlqMock(rows))
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await screen.findByTestId('dlq-row-alpha')
    expect(screen.getByTestId('dlq-row-beta')).toBeInTheDocument()

    // Typing settles through the debounce, then the server filters by `search`.
    fireEvent.change(screen.getByTestId('dlq-search'), { target: { value: 'alpha' } })
    await waitFor(() => {
      expect(lastDlqParams()?.get('search')).toBe('alpha')
      expect(screen.queryByTestId('dlq-row-beta')).toBeNull()
    })
    expect(screen.getByTestId('dlq-row-alpha')).toBeInTheDocument()
  })

  it('shows the search empty state when no failure matches', async () => {
    vi.mocked(api).mockImplementation(dlqMock([mockDeadLetter('alpha')]))
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await screen.findByTestId('dlq-row-alpha')
    fireEvent.change(screen.getByTestId('dlq-search'), { target: { value: 'zzz-no-match' } })
    await waitFor(() => expect(screen.getByTestId('dlq-empty-search')).toBeInTheDocument())
    expect(screen.queryByTestId('dlq-row-alpha')).toBeNull()
    expect(screen.queryByTestId('dlq-empty')).toBeNull()
  })
})
