import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { useRecoveryQueueFilters } from './useRecoveryQueueFilters'
import type { DeadLetter, DeadLetterRecovery } from '../components/DeadLettersPanel'

// The hook fetches `/dlq/queue?…` itself (server filters + sorts before the page
// cap and returns a { items, nextCursor, hasMore } keyset envelope). The stub
// returns an empty single page unless a case overrides it.
vi.mock('../api', () => ({
  api: vi.fn(async () => emptyPage()),
  downloadFromApi: vi.fn(),
}))

const FILTERS_KEY = 'janusly:recoveryQueueFilters'
const initialState = useWorkflowStore.getState()

/** Build the keyset page envelope the server returns from `/dlq/queue`. */
function page(items: DeadLetter[], hasMore = false, nextCursor: string | null = null) {
  return { items, hasMore, nextCursor }
}
function emptyPage() {
  return page([])
}

/** Build a server recovery-queue row (a dead letter + optional inline overlay). */
function dlqRow(id: string, opts: { status?: string; recovery?: DeadLetterRecovery | null } = {}): DeadLetter {
  return {
    id,
    runId: `run-${id}`,
    nodeId: `node-${id}`,
    attempt: 1,
    status: opts.status ?? 'open',
    workflowJson: {},
    nodeJson: {},
    errorJson: { message: `error ${id}` },
    ...(opts.recovery !== undefined ? { recovery: opts.recovery } : {}),
  }
}

function overlay(
  id: string,
  severity: 'p1' | 'p2' | 'p3' | 'p4' = 'p2',
  overrides: Partial<DeadLetterRecovery> = {},
): DeadLetterRecovery {
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
    ...overrides,
  }
}

/** The query params of the most recent `/dlq/queue` fetch the hook issued. */
function lastQueueParams(): URLSearchParams | null {
  const calls = vi.mocked(api).mock.calls
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const path = String(calls[i][0])
    if (path.startsWith('/dlq/queue')) return new URL(path, 'http://x').searchParams
  }
  return null
}

/** Count the `/dlq/queue` fetches issued so far. */
function queueFetchCount(): number {
  return vi.mocked(api).mock.calls.filter(([p]) => String(p).startsWith('/dlq/queue')).length
}

/** Count the `/dlq/counts` (org-wide mini-grid) fetches issued so far. */
function countsFetchCount(): number {
  return vi.mocked(api).mock.calls.filter(([p]) => String(p).startsWith('/dlq/counts')).length
}

// Minimal harness: render the hook's observable outputs + setter triggers as
// DOM so the case asserts against the contract without `renderHook`.
function Harness() {
  const f = useRecoveryQueueFilters()
  return (
    <div>
      <span data-testid="status">{f.status}</span>
      <span data-testid="owner">{f.ownerScope}</span>
      <span data-testid="severity">{f.severityFilter}</span>
      <span data-testid="sort">{f.sortKey}</span>
      <span data-testid="filtered">{f.filtered.map((r) => r.id).join(',')}</span>
      <span data-testid="overlay-keys">{[...f.recoveryByDeadLetterId.keys()].join(',')}</span>
      <span data-testid="overlay-a-sev">{f.recoveryByDeadLetterId.get('a')?.severity ?? ''}</span>
      <span data-testid="overlay-a-workflow">{f.recoveryByDeadLetterId.get('a')?.workflowId ?? ''}</span>
      <span data-testid="overlay-a-metadata-workflow">{f.recoveryByDeadLetterId.get('a')?.metadataWorkflowId ?? ''}</span>
      <span data-testid="loading">{String(f.recoveryFilterLoading)}</span>
      <span data-testid="has-more">{String(f.hasMore)}</span>
      <span data-testid="loading-more">{String(f.loadingMore)}</span>
      <span data-testid="counts">{`${f.counts.total}/${f.counts.open}/${f.counts.replayed}/${f.counts.resolved}`}</span>
      <button data-testid="load-more" onClick={() => f.loadMore()} />
      <button data-testid="set-status-all" onClick={() => f.setStatus('all')} />
      <button data-testid="set-status-resolved" onClick={() => f.setStatus('resolved')} />
      <button data-testid="set-owner-mine" onClick={() => f.setOwnerScope('mine')} />
      <button data-testid="set-sev-p1" onClick={() => f.setSeverityFilter('p1')} />
      <button data-testid="set-sort-severity" onClick={() => f.setSortKey('severity')} />
      <button data-testid="set-sort-oldest" onClick={() => f.setSortKey('oldest')} />
      <span data-testid="search">{f.searchInput}</span>
      <button data-testid="set-search" onClick={() => f.setSearchInput('run-7')} />
      <button data-testid="clear-search" onClick={() => f.setSearchInput('')} />
    </div>
  )
}

describe('useRecoveryQueueFilters', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(api).mockClear()
    vi.mocked(api).mockImplementation(async () => emptyPage())
    useWorkflowStore.setState({ ...initialState, platformVersion: 0 }, true)
  })

  it('defaults to open / all / all / newest and fetches /dlq/queue with those params', async () => {
    render(<Harness />)
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('open'))
    expect(screen.getByTestId('owner')).toHaveTextContent('all')
    expect(screen.getByTestId('severity')).toHaveTextContent('all')
    expect(screen.getByTestId('sort')).toHaveTextContent('newest')
    const params = lastQueueParams()
    expect(params?.get('status')).toBe('open')
    expect(params?.get('sort')).toBe('newest')
    expect(params?.get('limit')).toBe('50')
    // First page never sends a cursor.
    expect(params?.get('cursor')).toBeNull()
    // No owner/severity narrowing by default.
    expect(params?.get('owner')).toBeNull()
    expect(params?.get('severity')).toBeNull()
  })

  it('renders the server page verbatim (the server already filtered + ordered)', async () => {
    vi.mocked(api).mockImplementation(async () => page([dlqRow('a'), dlqRow('b')]))
    render(<Harness />)
    // Order is the server's — the hook does NOT re-sort.
    await waitFor(() => expect(screen.getByTestId('filtered')).toHaveTextContent('a,b'))
  })

  it('omits the status param and sends owner=me when scoped to mine', async () => {
    render(<Harness />)
    await waitFor(() => expect(lastQueueParams()).not.toBeNull())
    fireEvent.click(screen.getByTestId('set-status-all'))
    fireEvent.click(screen.getByTestId('set-owner-mine'))
    await waitFor(() => {
      const params = lastQueueParams()
      expect(params?.get('status')).toBeNull() // 'all' → omitted
      expect(params?.get('owner')).toBe('me')
    })
  })

  it('sends the severity + sort params when the operator narrows', async () => {
    render(<Harness />)
    await waitFor(() => expect(lastQueueParams()).not.toBeNull())
    fireEvent.click(screen.getByTestId('set-sev-p1'))
    fireEvent.click(screen.getByTestId('set-sort-severity'))
    await waitFor(() => {
      const params = lastQueueParams()
      expect(params?.get('severity')).toBe('p1')
      expect(params?.get('sort')).toBe('severity')
    })
  })

  it('builds the recovery overlay map from each row inline recovery field', async () => {
    vi.mocked(api).mockImplementation(async () =>
      page([dlqRow('a', { recovery: overlay('ri-a', 'p1') }), dlqRow('b', { recovery: null })]),
    )
    render(<Harness />)
    await waitFor(() => expect(screen.getByTestId('filtered')).toHaveTextContent('a,b'))
    // Only the row carrying an inline recovery contributes an overlay entry.
    expect(screen.getByTestId('overlay-keys')).toHaveTextContent('a')
    expect(screen.getByTestId('overlay-a-sev')).toHaveTextContent('p1')
  })

  it('keeps unsaved template workflow ids out of metadata lookups', async () => {
    vi.mocked(api).mockImplementation(async () =>
      page([
        dlqRow('a', {
          recovery: overlay('ri-a', 'p2', {
            workflowId: 'failed-workflow-recovery',
            metadataWorkflowId: null,
          }),
        }),
      ]),
    )
    render(<Harness />)
    await waitFor(() => expect(screen.getByTestId('overlay-keys')).toHaveTextContent('a'))
    expect(screen.getByTestId('overlay-a-workflow')).toHaveTextContent('failed-workflow-recovery')
    expect(screen.getByTestId('overlay-a-metadata-workflow')).toHaveTextContent('')
  })

  it('threads persisted workflow ids separately for the recovery metadata card', async () => {
    vi.mocked(api).mockImplementation(async () =>
      page([
        dlqRow('a', {
          recovery: overlay('ri-a', 'p2', {
            workflowId: 'template-source-id',
            metadataWorkflowId: 'wf_saved_1',
          }),
        }),
      ]),
    )
    render(<Harness />)
    await waitFor(() => expect(screen.getByTestId('overlay-keys')).toHaveTextContent('a'))
    expect(screen.getByTestId('overlay-a-workflow')).toHaveTextContent('template-source-id')
    expect(screen.getByTestId('overlay-a-metadata-workflow')).toHaveTextContent('wf_saved_1')
  })

  it('appends the next page and threads the cursor on loadMore', async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      const params = new URL(String(path), 'http://x').searchParams
      if (params.get('cursor') === 'c1') return page([dlqRow('b')], false, null)
      return page([dlqRow('a')], true, 'c1')
    })
    render(<Harness />)
    await waitFor(() => expect(screen.getByTestId('filtered')).toHaveTextContent('a'))
    expect(screen.getByTestId('has-more')).toHaveTextContent('true')

    fireEvent.click(screen.getByTestId('load-more'))
    await waitFor(() => expect(screen.getByTestId('filtered')).toHaveTextContent('a,b'))
    // The append fetch carried the cursor; the queue exhausted (hasMore=false).
    expect(lastQueueParams()?.get('cursor')).toBe('c1')
    expect(screen.getByTestId('has-more')).toHaveTextContent('false')
  })

  it('loadMore is a no-op when there is no next page', async () => {
    vi.mocked(api).mockImplementation(async () => page([dlqRow('a')], false, null))
    render(<Harness />)
    await waitFor(() => expect(screen.getByTestId('filtered')).toHaveTextContent('a'))
    expect(queueFetchCount()).toBe(1)
    fireEvent.click(screen.getByTestId('load-more'))
    // No cursor → guard short-circuits; no second fetch.
    await waitFor(() => expect(screen.getByTestId('has-more')).toHaveTextContent('false'))
    expect(queueFetchCount()).toBe(1)
  })

  it('resets pagination to page 1 (no cursor) when the sort changes', async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      const params = new URL(String(path), 'http://x').searchParams
      if (params.get('sort') === 'oldest') return page([dlqRow('x')], false, null)
      if (params.get('cursor') === 'c1') return page([dlqRow('b')], false, null)
      return page([dlqRow('a')], true, 'c1')
    })
    render(<Harness />)
    await waitFor(() => expect(screen.getByTestId('filtered')).toHaveTextContent('a'))
    fireEvent.click(screen.getByTestId('load-more'))
    await waitFor(() => expect(screen.getByTestId('filtered')).toHaveTextContent('a,b'))

    fireEvent.click(screen.getByTestId('set-sort-oldest'))
    // Sort change refetches page 1 (no cursor) and REPLACES rows, not appends.
    await waitFor(() => expect(screen.getByTestId('filtered')).toHaveTextContent('x'))
    expect(lastQueueParams()?.get('sort')).toBe('oldest')
    expect(lastQueueParams()?.get('cursor')).toBeNull()
  })

  it('drops a stale loadMore append when a filter change reset the queue mid-fetch', async () => {
    let resolveLoadMore: (() => void) | null = null
    vi.mocked(api).mockImplementation(async (path) => {
      const params = new URL(String(path), 'http://x').searchParams
      if (params.get('cursor') === 'c1') {
        return new Promise((resolve) => {
          resolveLoadMore = () => resolve(page([dlqRow('stale')], false, null))
        }) as unknown as Promise<unknown>
      }
      if (params.get('sort') === 'oldest') return page([dlqRow('x')], false, null)
      return page([dlqRow('a')], true, 'c1')
    })
    render(<Harness />)
    await waitFor(() => expect(screen.getByTestId('filtered')).toHaveTextContent('a'))

    // Start a load-more whose fetch hangs, then change the sort (epoch bumps,
    // page-1 'oldest' resolves) BEFORE the hung append resolves.
    fireEvent.click(screen.getByTestId('load-more'))
    await waitFor(() => expect(resolveLoadMore).not.toBeNull())
    fireEvent.click(screen.getByTestId('set-sort-oldest'))
    await waitFor(() => expect(screen.getByTestId('filtered')).toHaveTextContent('x'))

    resolveLoadMore?.()
    // The stale append must NOT graft onto the new page-1 set.
    await waitFor(() => expect(screen.getByTestId('loading-more')).toHaveTextContent('false'))
    expect(screen.getByTestId('filtered')).toHaveTextContent('x')
    expect(screen.getByTestId('filtered')).not.toHaveTextContent('stale')
  })

  it('restores persisted selections on mount and defaults a missing sort key', async () => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify({ status: 'resolved', ownerScope: 'all', severityFilter: 'all' }))
    render(<Harness />)
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('resolved'))
    expect(screen.getByTestId('sort')).toHaveTextContent('newest')
    // The restored status drives the fetch.
    expect(lastQueueParams()?.get('status')).toBe('resolved')
  })

  it('writes filter changes back to localStorage', async () => {
    render(<Harness />)
    await waitFor(() => expect(screen.getByTestId('owner')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('set-owner-mine'))
    fireEvent.click(screen.getByTestId('set-status-resolved'))
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(FILTERS_KEY) ?? '{}')
      expect(stored.ownerScope).toBe('mine')
      expect(stored.status).toBe('resolved')
    })
  })

  it('falls back to defaults when the stored blob is corrupt', async () => {
    localStorage.setItem(FILTERS_KEY, 'not-json{')
    render(<Harness />)
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('open'))
    expect(screen.getByTestId('owner')).toHaveTextContent('all')
    expect(screen.getByTestId('severity')).toHaveTextContent('all')
    expect(screen.getByTestId('sort')).toHaveTextContent('newest')
  })

  it('flags recoveryFilterLoading while the first-page fetch is in flight', async () => {
    // Hang only the queue fetch (which drives `recoveryFilterLoading`); the
    // sibling /dlq/counts fetch resolves immediately so it doesn't interfere.
    let resolveQueue: ((value: ReturnType<typeof emptyPage>) => void) | null = null
    vi.mocked(api).mockImplementation((path) => {
      if (String(path).startsWith('/dlq/counts')) return Promise.resolve({ total: 0, open: 0, replayed: 0, resolved: 0 }) as unknown as Promise<unknown>
      return new Promise((resolve) => {
        resolveQueue = resolve
      }) as unknown as Promise<unknown>
    })
    render(<Harness />)
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('true'))
    resolveQueue?.(emptyPage())
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'))
  })

  it('persists the sort key', async () => {
    render(<Harness />)
    await waitFor(() => expect(screen.getByTestId('sort')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('set-sort-oldest'))
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(FILTERS_KEY) ?? '{}')
      expect(stored.sortKey).toBe('oldest')
    })
  })

  it('fetches org-wide counts from /dlq/counts and exposes the parsed breakdown', async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (String(path).startsWith('/dlq/counts')) return { total: 42, open: 30, replayed: 8, resolved: 4 }
      return page([])
    })
    render(<Harness />)
    await waitFor(() => expect(screen.getByTestId('counts')).toHaveTextContent('42/30/8/4'))
  })

  it('does NOT refetch counts on a filter/sort change (org-wide, not view-scoped)', async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (String(path).startsWith('/dlq/counts')) return { total: 5, open: 5, replayed: 0, resolved: 0 }
      return page([])
    })
    render(<Harness />)
    await waitFor(() => expect(screen.getByTestId('counts')).toHaveTextContent('5/5/0/0'))
    const countsBefore = countsFetchCount()
    const queueBefore = queueFetchCount()

    fireEvent.click(screen.getByTestId('set-status-resolved'))
    fireEvent.click(screen.getByTestId('set-sort-severity'))
    // The queue refetches on filter/sort; the counts must NOT.
    await waitFor(() => expect(lastQueueParams()?.get('status')).toBe('resolved'))
    expect(queueFetchCount()).toBeGreaterThan(queueBefore)
    expect(countsFetchCount()).toBe(countsBefore)
  })

  it('defaults counts to zero when the /dlq/counts fetch fails', async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (String(path).startsWith('/dlq/counts')) throw new Error('boom')
      return page([])
    })
    render(<Harness />)
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('open'))
    expect(screen.getByTestId('counts')).toHaveTextContent('0/0/0/0')
  })

  it('debounces the search box and sends the search= param, resetting to page 1', async () => {
    render(<Harness />)
    await waitFor(() => expect(lastQueueParams()).not.toBeNull())
    fireEvent.click(screen.getByTestId('set-search'))
    // The raw input updates immediately; the server param follows after debounce.
    expect(screen.getByTestId('search')).toHaveTextContent('run-7')
    await waitFor(() => expect(lastQueueParams()?.get('search')).toBe('run-7'))
    // A search change resets pagination to page 1 (no cursor on the refetch).
    expect(lastQueueParams()?.get('cursor')).toBeNull()
  })

  it('refetches without search= when the search box is cleared', async () => {
    render(<Harness />)
    await waitFor(() => expect(lastQueueParams()).not.toBeNull())
    fireEvent.click(screen.getByTestId('set-search'))
    await waitFor(() => expect(lastQueueParams()?.get('search')).toBe('run-7'))
    fireEvent.click(screen.getByTestId('clear-search'))
    await waitFor(() => expect(lastQueueParams()?.get('search')).toBeNull())
  })

  it('persists the debounced search term', async () => {
    render(<Harness />)
    await waitFor(() => expect(lastQueueParams()).not.toBeNull())
    fireEvent.click(screen.getByTestId('set-search'))
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(FILTERS_KEY) ?? '{}')
      expect(stored.search).toBe('run-7')
    })
  })

  it('restores a persisted search term on mount and sends it on the first fetch', async () => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify({ search: 'persisted-term' }))
    render(<Harness />)
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('persisted-term'))
    expect(lastQueueParams()?.get('search')).toBe('persisted-term')
  })
})
