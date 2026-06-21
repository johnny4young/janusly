import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { WorkflowsDashboard } from './WorkflowsDashboard'

vi.mock('../api', () => ({ api: vi.fn() }))
// The per-row health badge fetches on its own; stub it so this test stays
// focused on the list's tag filter + pills.
vi.mock('./WorkflowHealthBadge', () => ({ WorkflowHealthBadge: () => null }))

type Flow = {
  id: string
  orgId: string
  name: string
  tags?: string[]
  folder?: string | null
  lastRunStatus?: string | null
  runCount?: number
  updatedAt?: string
}

const FLOWS: Flow[] = [
  { id: 'wf1', orgId: 'o', name: 'Billing sync', tags: ['billing', 'urgent'], lastRunStatus: 'succeeded', runCount: 3, updatedAt: '2026-06-02T00:00:00.000Z' },
  { id: 'wf2', orgId: 'o', name: 'Onboarding email', tags: ['onboarding'], runCount: 0, updatedAt: '2026-06-01T00:00:00.000Z' },
]

// Two flows in "Billing", one in "Onboarding", one ungrouped — drives the
// folder-grouping cases.
const FOLDERED: Flow[] = [
  { id: 'wf1', orgId: 'o', name: 'Billing sync', folder: 'Billing', runCount: 0, updatedAt: '2026-06-04T00:00:00.000Z' },
  { id: 'wf2', orgId: 'o', name: 'Billing retry', folder: 'Billing', runCount: 0, updatedAt: '2026-06-03T00:00:00.000Z' },
  { id: 'wf3', orgId: 'o', name: 'Welcome email', folder: 'Onboarding', runCount: 0, updatedAt: '2026-06-02T00:00:00.000Z' },
  { id: 'wf4', orgId: 'o', name: 'Ad hoc cleanup', runCount: 0, updatedAt: '2026-06-01T00:00:00.000Z' },
]

function mockApi(handler: (url: string) => unknown) {
  vi.mocked(api).mockImplementation(async (url: string) => handler(url))
}

const FILTERS_KEY = 'janusly:flowsFilters'

describe('<WorkflowsDashboard />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    window.localStorage.clear()
  })

  it('renders each workflow with its tag pills', async () => {
    mockApi((url) => {
      if (url === '/workflows/tags') return { tags: ['billing', 'onboarding', 'urgent'] }
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    const row1 = await screen.findByTestId('workflows-row-wf1')
    expect(within(row1).getByText('billing')).toBeInTheDocument()
    expect(within(row1).getByText('urgent')).toBeInTheDocument()
    const row2 = screen.getByTestId('workflows-row-wf2')
    expect(within(row2).getByText('onboarding')).toBeInTheDocument()
  })

  it('populates the tag dropdown from GET /workflows/tags ("All tags" + one option per org tag)', async () => {
    mockApi((url) => {
      if (url === '/workflows/tags') return { tags: ['billing', 'onboarding'] }
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    const select = (await screen.findByTestId('workflows-tag-filter')) as HTMLSelectElement
    const values = Array.from(select.options).map((o) => o.value)
    expect(values).toEqual(['', 'billing', 'onboarding'])
  })

  it('threads ?tag= into the list fetch when a tag is selected', async () => {
    const calls: string[] = []
    mockApi((url) => {
      calls.push(url)
      if (url === '/workflows/tags') return { tags: ['billing'] }
      if (url.startsWith('/workflows?tag=billing')) return [FLOWS[0]]
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')
    fireEvent.change(screen.getByTestId('workflows-tag-filter'), { target: { value: 'billing' } })
    await waitFor(() => expect(calls).toContain('/workflows?tag=billing'))
  })

  it('keeps the client-side name search narrowing the fetched list', async () => {
    mockApi((url) => {
      if (url === '/workflows/tags') return { tags: ['billing', 'onboarding'] }
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByText('Billing sync')
    expect(screen.getByText('Onboarding email')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('workflows-search'), { target: { value: 'billing' } })
    await waitFor(() => expect(screen.queryByText('Onboarding email')).not.toBeInTheDocument())
    expect(screen.getByText('Billing sync')).toBeInTheDocument()
  })

  it('restores persisted tag + search from localStorage on mount', async () => {
    window.localStorage.setItem(FILTERS_KEY, JSON.stringify({ tag: 'billing', query: 'bill', sort: 'name' }))
    mockApi((url) => {
      if (url === '/workflows/tags') return { tags: ['billing'] }
      if (url.startsWith('/workflows?tag=billing')) return [FLOWS[0]]
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    const select = (await screen.findByTestId('workflows-tag-filter')) as HTMLSelectElement
    expect(select.value).toBe('billing')
    expect((screen.getByTestId('workflows-search') as HTMLInputElement).value).toBe('bill')
  })

  it('reconciles a persisted tag the org no longer offers (clears it + refetches unfiltered)', async () => {
    window.localStorage.setItem(FILTERS_KEY, JSON.stringify({ tag: 'ghost', query: '', sort: 'recent' }))
    const calls: string[] = []
    mockApi((url) => {
      calls.push(url)
      if (url === '/workflows/tags') return { tags: ['billing'] }
      if (url.startsWith('/workflows?tag=ghost')) return [] // the stale tag matches nothing
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    // The stale tag is dropped once the (ghost-less) options load → select clears…
    await waitFor(() => expect((screen.getByTestId('workflows-tag-filter') as HTMLSelectElement).value).toBe(''))
    // …and the list refetches unfiltered.
    await waitFor(() => expect(screen.getByTestId('workflows-row-wf1')).toBeInTheDocument())
    expect(calls).toContain('/workflows')
  })

  it('persists the selected tag to localStorage', async () => {
    mockApi((url) => {
      if (url === '/workflows/tags') return { tags: ['billing'] }
      if (url.startsWith('/workflows?tag=billing')) return [FLOWS[0]]
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-tag-filter')
    fireEvent.change(screen.getByTestId('workflows-tag-filter'), { target: { value: 'billing' } })
    await waitFor(() => {
      const raw = window.localStorage.getItem(FILTERS_KEY)
      expect(raw && JSON.parse(raw).tag).toBe('billing')
    })
  })

  it('renders a flat list (no folder sections) when no workflow has a folder', async () => {
    mockApi((url) => {
      if (url === '/workflows/tags') return { tags: [] }
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')
    expect(screen.queryByTestId('workflows-folder-groups')).not.toBeInTheDocument()
  })

  it('groups rows into folder sections with the Ungrouped section last', async () => {
    mockApi((url) => {
      if (url === '/workflows/tags') return { tags: [] }
      return FOLDERED
    })
    const { container } = render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-groups')

    // One <details> per named folder + the ungrouped bucket.
    const billing = screen.getByTestId('workflows-folder-Billing')
    expect(within(billing).getByTestId('workflows-row-wf1')).toBeInTheDocument()
    expect(within(billing).getByTestId('workflows-row-wf2')).toBeInTheDocument()
    expect(within(billing).getByText('2 flows')).toBeInTheDocument() // count pill
    expect(screen.getByTestId('workflows-folder-Onboarding')).toBeInTheDocument()

    // Ungrouped renders last (named folders alphabetical, then ungrouped).
    const sections = Array.from(container.querySelectorAll('[data-testid^="workflows-folder-"]'))
      .map((el) => el.getAttribute('data-testid'))
      .filter((id) => id !== 'workflows-folder-groups')
    expect(sections).toEqual(['workflows-folder-Billing', 'workflows-folder-Onboarding', 'workflows-folder-ungrouped'])
  })

  it('restores a persisted collapsed folder (section starts closed)', async () => {
    window.localStorage.setItem(
      FILTERS_KEY,
      JSON.stringify({ tag: '', query: '', sort: 'recent', collapsedFolders: ['Billing'] }),
    )
    mockApi((url) => {
      if (url === '/workflows/tags') return { tags: [] }
      return FOLDERED
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    const billing = (await screen.findByTestId('workflows-folder-Billing')) as HTMLDetailsElement
    expect(billing.open).toBe(false) // restored as collapsed
    expect((screen.getByTestId('workflows-folder-Onboarding') as HTMLDetailsElement).open).toBe(true)
  })

  it('persists a folder collapse to localStorage', async () => {
    mockApi((url) => {
      if (url === '/workflows/tags') return { tags: [] }
      return FOLDERED
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    const billing = (await screen.findByTestId('workflows-folder-Billing')) as HTMLDetailsElement
    // Simulate the operator collapsing the section (jsdom doesn't auto-toggle on
    // summary click, so drive the native open state + toggle event directly).
    billing.open = false
    fireEvent(billing, new Event('toggle'))
    await waitFor(() => {
      const raw = window.localStorage.getItem(FILTERS_KEY)
      expect(raw && JSON.parse(raw).collapsedFolders).toContain('Billing')
    })
  })

  it('keeps the name search narrowing within folder sections', async () => {
    mockApi((url) => {
      if (url === '/workflows/tags') return { tags: [] }
      return FOLDERED
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-Billing')
    fireEvent.change(screen.getByTestId('workflows-search'), { target: { value: 'billing' } })
    // Only the two Billing-folder rows survive; the Onboarding section disappears.
    await waitFor(() => expect(screen.queryByTestId('workflows-folder-Onboarding')).not.toBeInTheDocument())
    expect(screen.getByTestId('workflows-row-wf1')).toBeInTheDocument()
    expect(screen.queryByTestId('workflows-row-wf3')).not.toBeInTheDocument()
  })
})
