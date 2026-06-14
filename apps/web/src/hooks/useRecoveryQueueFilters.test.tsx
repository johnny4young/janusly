import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { useRecoveryQueueFilters } from './useRecoveryQueueFilters'
import type { DeadLetter } from '../components/DeadLettersPanel'

// The hook fetches `/recovery/items` on mount; the stub returns an empty
// list unless a case overrides it.
vi.mock('../api', () => ({
  api: vi.fn(async () => ({ items: [], clusters: [], runs: [], proposals: [] })),
  downloadFromApi: vi.fn(),
}))

const FILTERS_KEY = 'janusly:recoveryQueueFilters'
const initialState = useWorkflowStore.getState()

function dl(id: string, status = 'open'): DeadLetter {
  return {
    id,
    runId: `run-${id}`,
    nodeId: `node-${id}`,
    attempt: 1,
    status,
    workflowJson: {},
    nodeJson: {},
    errorJson: { message: `error ${id}` },
  }
}

function recoveryItem(id: string, deadLetterId: string, severity: 'p1' | 'p2' | 'p3' | 'p4' = 'p2') {
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

// Minimal harness: render the hook's observable outputs + setter triggers as
// DOM so the case asserts against the contract without `renderHook`.
function Harness({ deadLetters }: { deadLetters: DeadLetter[] }) {
  const f = useRecoveryQueueFilters(deadLetters)
  return (
    <div>
      <span data-testid="status">{f.status}</span>
      <span data-testid="owner">{f.ownerScope}</span>
      <span data-testid="severity">{f.severityFilter}</span>
      <span data-testid="filtered">{f.filtered.map((r) => r.id).join(',')}</span>
      <span data-testid="loading">{String(f.recoveryFilterLoading)}</span>
      <button data-testid="set-status-resolved" onClick={() => f.setStatus('resolved')} />
      <button data-testid="set-owner-mine" onClick={() => f.setOwnerScope('mine')} />
      <button data-testid="set-sev-p1" onClick={() => f.setSeverityFilter('p1')} />
    </div>
  )
}

describe('useRecoveryQueueFilters', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(api).mockClear()
    vi.mocked(api).mockImplementation(async () => ({ items: [], clusters: [], runs: [], proposals: [] }))
    useWorkflowStore.setState({ ...initialState, platformVersion: 0 }, true)
  })

  it('defaults to open / all / all and filters by the default status', async () => {
    render(<Harness deadLetters={[dl('a', 'open'), dl('b', 'resolved')]} />)
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('open'))
    expect(screen.getByTestId('owner')).toHaveTextContent('all')
    expect(screen.getByTestId('severity')).toHaveTextContent('all')
    // Default status 'open' → only the open dead letter is visible.
    expect(screen.getByTestId('filtered')).toHaveTextContent('a')
    expect(screen.getByTestId('filtered')).not.toHaveTextContent('b')
  })

  it('restores persisted selections on mount', async () => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify({ status: 'resolved', ownerScope: 'all', severityFilter: 'all' }))
    render(<Harness deadLetters={[dl('a', 'open'), dl('b', 'resolved')]} />)
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('resolved'))
    // Persisted status 'resolved' → only the resolved dead letter.
    expect(screen.getByTestId('filtered')).toHaveTextContent('b')
    expect(screen.getByTestId('filtered')).not.toHaveTextContent('a')
  })

  it('writes filter changes back to localStorage', async () => {
    render(<Harness deadLetters={[dl('a')]} />)
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
    render(<Harness deadLetters={[dl('a')]} />)
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('open'))
    expect(screen.getByTestId('owner')).toHaveTextContent('all')
    expect(screen.getByTestId('severity')).toHaveTextContent('all')
  })

  it('narrows filtered by severity once the overlay has loaded', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.includes('/recovery/items')) {
        return { items: [recoveryItem('ri-a', 'a', 'p1'), recoveryItem('ri-b', 'b', 'p3')] }
      }
      return { items: [], clusters: [], runs: [], proposals: [] }
    })
    render(<Harness deadLetters={[dl('a'), dl('b')]} />)
    await waitFor(() => expect(screen.getByTestId('filtered')).toHaveTextContent('a,b'))
    fireEvent.click(screen.getByTestId('set-sev-p1'))
    await waitFor(() => {
      expect(screen.getByTestId('filtered')).toHaveTextContent('a')
      expect(screen.getByTestId('filtered')).not.toHaveTextContent('b')
    })
  })

  it('flags recoveryFilterLoading while the owner=me overlay fetch is in flight', async () => {
    let resolveMine: ((value: { items: ReturnType<typeof recoveryItem>[] }) => void) | null = null
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.includes('/recovery/items')) {
        if (path.includes('owner=me')) {
          return new Promise<{ items: ReturnType<typeof recoveryItem>[] }>((resolve) => {
            resolveMine = resolve
          })
        }
        return { items: [] }
      }
      return { items: [], clusters: [], runs: [], proposals: [] }
    })
    render(<Harness deadLetters={[dl('a')]} />)
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'))
    fireEvent.click(screen.getByTestId('set-owner-mine'))
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('true'))
    resolveMine?.({ items: [] })
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'))
  })
})
