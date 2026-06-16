import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { __resetBumpCoalesceForTests, useWorkflowStore } from '../store'
import { DeadLettersPanel, type DeadLetter, type DeadLetterRecovery } from './DeadLettersPanel'

// `DeadLettersPanel`'s hook fetches `/dlq?…` itself now — the server filters +
// sorts before the cap and folds the recovery overlay inline. The default stub
// returns an empty page; `dlqMock` simulates the server for filter/sort cases.
// Child cards (FailureClustersCard / AutoHealingPendingCard) get empty defaults.
vi.mock('../api', () => ({
  api: vi.fn(async (path?: unknown) =>
    typeof path === 'string' && path.startsWith('/dlq?')
      ? ([] as DeadLetter[])
      : { items: [], clusters: [], runs: [], proposals: [] },
  ),
  downloadFromApi: vi.fn(),
}))

const initialState = useWorkflowStore.getState()

// The recovery-queue fetch is `/dlq?…` (always has a query string); the sibling
// `/dlq/clusters` + `/auto-healing/*` cards expect object shapes. Default to an
// empty recovery-queue page for `/dlq?…` and card-safe objects for the rest.
const defaultApiMock = async (path: string): Promise<unknown> =>
  path.startsWith('/dlq?') ? ([] as DeadLetter[]) : { items: [], clusters: [], runs: [], proposals: [] }

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

/** Simulate the server `/dlq` endpoint: filter + sort the full row set by the
 *  query params, so a panel test exercises the real "server filters, panel
 *  renders" contract. Non-`/dlq` calls (child cards) get empty defaults. */
function dlqMock(rows: DeadLetter[]) {
  return async (path: string): Promise<unknown> => {
    if (!path.startsWith('/dlq?')) return { items: [], clusters: [], runs: [], proposals: [] }
    const params = new URL(path, 'http://x').searchParams
    let out = rows
    const status = params.get('status')
    if (status) out = out.filter((r) => r.status === status)
    if (params.get('owner') === 'me') out = out.filter((r) => r.recovery?.owner === 'dev-user')
    const severity = params.get('severity')
    if (severity) out = out.filter((r) => r.recovery?.severity === severity)
    if (params.get('sort') === 'severity') {
      out = [...out].sort(
        (a, b) => (SEVERITY_RANK[a.recovery?.severity ?? ''] ?? 4) - (SEVERITY_RANK[b.recovery?.severity ?? ''] ?? 4),
      )
    }
    return out
  }
}

/** The query params of the most recent `/dlq` fetch the panel's hook issued. */
function lastDlqParams(): URLSearchParams | null {
  const calls = vi.mocked(api).mock.calls
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const path = String(calls[i][0])
    if (path.startsWith('/dlq?')) return new URL(path, 'http://x').searchParams
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
    const initialDlqCalls = vi.mocked(api).mock.calls.filter(([path]) => String(path).startsWith('/dlq?')).length

    fireEvent.click(screen.getByRole('button', { name: /dlq\.refresh|refresh/i }))

    await waitFor(() => {
      const nextDlqCalls = vi.mocked(api).mock.calls.filter(([path]) => String(path).startsWith('/dlq?')).length
      expect(nextDlqCalls).toBeGreaterThan(initialDlqCalls)
    })
    expect(onRefresh).toHaveBeenCalled()
  })

  it('shows the warning stripe when the visible page has open rows', async () => {
    vi.mocked(api).mockImplementation(dlqMock([mockDeadLetter('open-1', { status: 'open' })]))
    const { container } = render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('dlq-row-open-1')).toBeInTheDocument())
    expect(container.querySelector('[data-severity="warning"]')).not.toBeNull()
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

  it('does not flash the severity empty state while the /dlq fetch is in flight', async () => {
    const rows = [mockDeadLetter('a', { recovery: overlay('ri-a', 'p3') })]
    let resolvePending: ((value: DeadLetter[]) => void) | null = null
    vi.mocked(api).mockImplementation((path: string) => {
      if (!path.startsWith('/dlq?')) return Promise.resolve({ items: [], clusters: [], runs: [], proposals: [] })
      const params = new URL(path, 'http://x').searchParams
      if (params.get('severity') === 'p1') {
        return new Promise<DeadLetter[]>((resolve) => {
          resolvePending = resolve
        }) as unknown as Promise<unknown>
      }
      return Promise.resolve(rows)
    })
    render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('dlq-row-a')).toBeInTheDocument())
    fireEvent.change(screen.getByTestId('dlq-severity-filter'), { target: { value: 'p1' } })
    // While the p1 fetch is in flight the panel shows the previous page
    // (stale-while-loading) and must NOT flash the severity empty state.
    expect(screen.queryByTestId('dlq-empty-severity')).toBeNull()
    // Once the empty p1 page lands, the severity empty state renders.
    resolvePending?.([])
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
})
