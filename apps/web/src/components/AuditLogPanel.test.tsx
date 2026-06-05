import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { AuditLogPanel } from './AuditLogPanel'

vi.mock('../api', () => ({ api: vi.fn() }))

type Row = {
  id: string
  userId: string | null
  action: string
  targetType: string | null
  targetId: string | null
  metadata: unknown
  createdAt: string | null
}

function row(over: Partial<Row> & { id: string; action: string }): Row {
  return {
    userId: 'dev-user',
    targetType: null,
    targetId: null,
    metadata: {},
    createdAt: '2026-06-01T00:00:00.000Z',
    ...over,
  }
}

function mockApi(handler: (url: string) => unknown) {
  vi.mocked(api).mockImplementation(async (url: string) => handler(url))
}

describe('<AuditLogPanel />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
  })

  it('renders audit rows', async () => {
    mockApi(() => ({
      rows: [row({ id: 'a1', action: 'workflow.saved', targetType: 'workflow', targetId: 'wf1' })],
      nextCursor: null,
      hasMore: false,
    }))
    render(<AuditLogPanel />)
    expect(await screen.findByText('workflow.saved')).toBeInTheDocument()
    expect(screen.getByText('workflow:wf1')).toBeInTheDocument()
  })

  it('shows the empty state when no rows match', async () => {
    mockApi(() => ({ rows: [], nextCursor: null, hasMore: false }))
    render(<AuditLogPanel />)
    expect(await screen.findByText(/No audit rows match/i)).toBeInTheDocument()
  })

  it('refetches with ?action= when a filter is applied', async () => {
    const calls: string[] = []
    mockApi((url) => {
      calls.push(url)
      return { rows: [], nextCursor: null, hasMore: false }
    })
    render(<AuditLogPanel />)
    await screen.findByText(/No audit rows match/i)
    fireEvent.change(screen.getByLabelText('Filter by action'), { target: { value: 'org.scim' } })
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }))
    await waitFor(() => expect(calls).toContain('/audit?action=org.scim'))
  })

  it('appends the next page on Load more', async () => {
    mockApi((url) => {
      if (url === '/audit') {
        return { rows: [row({ id: 'a1', action: 'first.action' })], nextCursor: 'cur1', hasMore: true }
      }
      if (url === '/audit?cursor=cur1') {
        return { rows: [row({ id: 'a2', action: 'older.action' })], nextCursor: null, hasMore: false }
      }
      return { rows: [], nextCursor: null, hasMore: false }
    })
    render(<AuditLogPanel />)
    await screen.findByText('first.action')
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(screen.getByText('older.action')).toBeInTheDocument())
    // First page stays — the page appends, not replaces.
    expect(screen.getByText('first.action')).toBeInTheDocument()
  })
})
