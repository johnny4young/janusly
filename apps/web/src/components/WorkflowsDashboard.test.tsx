import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { WorkflowsDashboard } from './WorkflowsDashboard'

vi.mock('../api', () => ({ api: vi.fn() }))
// The per-row health badge fetches on its own; stub it so these tests stay
// focused on Flows-list filtering, grouping, and folder-management behavior.
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
  createdAt?: string
  deletedAt?: string | null
}

// A descending-createdAt page of `count` rows starting at index `startIdx` — the
// server returns rows in createdAt-DESC order, so the LAST element is the oldest
// (the "Load more" cursor). Distinct createdAt per row keeps the keyset stable.
const pageOfFlows = (count: number, startIdx = 0): Flow[] =>
  Array.from({ length: count }, (_, k) => {
    const i = startIdx + k
    return { id: `wf${i}`, orgId: 'o', name: `Flow ${i}`, runCount: 0, createdAt: new Date(Date.UTC(2026, 0, 1) - i * 1000).toISOString() }
  })

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

// jsdom's DataTransfer is inert, so hand a minimal stand-in to the fired drag
// events: dragStart's handler calls setData; drop reads it back via getData.
function makeDataTransfer() {
  const store: Record<string, string> = {}
  return {
    effectAllowed: '',
    dropEffect: '',
    setData(type: string, value: string) {
      store[type] = value
    },
    getData(type: string) {
      return store[type] ?? ''
    },
  }
}

// A list mock that also records folder-management POSTs. `postResult` lets a case
// force the POST to reject (rollback path).
function mockListWithFolderPost(
  rows: Flow[],
  calls: Array<{ url: string; body: unknown }>,
  postResult: 'ok' | 'reject' = 'ok',
) {
  vi.mocked(api).mockImplementation(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      calls.push({ url, body: JSON.parse(String(options.body)) })
      if (postResult === 'reject') throw new Error('move failed')
      return { workflowId: url, metadata: null }
    }
    if (url === '/workflows/folders') return { folders: ['Billing', 'Onboarding'] }
    if (url === '/workflows/tags') return { tags: [] }
    return rows
  })
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

  it('populates the add-tag picker from GET /workflows/tags (placeholder + one option per org tag)', async () => {
    mockApi((url) => {
      if (url === '/workflows/tags') return { tags: ['billing', 'onboarding'] }
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    const select = (await screen.findByTestId('workflows-tag-filter-add')) as HTMLSelectElement
    const values = Array.from(select.options).map((o) => o.value)
    expect(values).toEqual(['', 'billing', 'onboarding'])
  })

  it('threads ?tag= into the list fetch when a tag is added to the filter', async () => {
    const calls: string[] = []
    mockApi((url) => {
      calls.push(url)
      if (url === '/workflows/tags') return { tags: ['billing'] }
      if (url.startsWith('/workflows?tag=billing')) return [FLOWS[0]]
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')
    fireEvent.change(screen.getByTestId('workflows-tag-filter-add'), { target: { value: 'billing' } })
    await waitFor(() => expect(calls).toContain('/workflows?tag=billing'))
  })

  it('ANDs several tags into the list fetch as repeated ?tag= params', async () => {
    const calls: string[] = []
    mockApi((url) => {
      calls.push(url)
      if (url === '/workflows/tags') return { tags: ['billing', 'urgent'] }
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')
    fireEvent.change(screen.getByTestId('workflows-tag-filter-add'), { target: { value: 'billing' } })
    await waitFor(() => expect(calls.some((u) => u.startsWith('/workflows?tag=billing'))).toBe(true))
    // The picker now only offers the still-unselected 'urgent'.
    fireEvent.change(screen.getByTestId('workflows-tag-filter-add'), { target: { value: 'urgent' } })
    await waitFor(() =>
      expect(calls.some((u) => u.includes('tag=billing') && u.includes('tag=urgent'))).toBe(true),
    )
    // Both selected tags render as removable chips.
    expect(screen.getByTestId('workflows-tag-filter-remove-billing')).toBeInTheDocument()
    expect(screen.getByTestId('workflows-tag-filter-remove-urgent')).toBeInTheDocument()
  })

  it('removing a chip widens the filter (drops that tag param)', async () => {
    const calls: string[] = []
    mockApi((url) => {
      calls.push(url)
      if (url === '/workflows/tags') return { tags: ['billing', 'urgent'] }
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')
    fireEvent.change(screen.getByTestId('workflows-tag-filter-add'), { target: { value: 'billing' } })
    fireEvent.change(screen.getByTestId('workflows-tag-filter-add'), { target: { value: 'urgent' } })
    await screen.findByTestId('workflows-tag-filter-remove-urgent')
    fireEvent.click(screen.getByTestId('workflows-tag-filter-remove-urgent'))
    await waitFor(() =>
      expect(screen.queryByTestId('workflows-tag-filter-remove-urgent')).not.toBeInTheDocument(),
    )
    // 'billing' remains filtered; the single-tag-only ?tag=billing fetch is re-issued.
    expect(screen.getByTestId('workflows-tag-filter-remove-billing')).toBeInTheDocument()
    await waitFor(() => expect(calls.some((u) => u.startsWith('/workflows?tag=billing'))).toBe(true))
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

  it('sends a debounced ?q= name search to the list fetch', async () => {
    const calls: string[] = []
    mockApi((url) => {
      calls.push(url)
      if (url === '/workflows/tags') return { tags: [] }
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')
    fireEvent.change(screen.getByTestId('workflows-search'), { target: { value: 'billing' } })
    await waitFor(() => expect(calls.some((u) => u.includes('q=billing'))).toBe(true), { timeout: 2000 })
  })

  it('back-fills a beyond-cap match returned only by the ?q= fetch', async () => {
    // The initial unfiltered load returns only wf1; the ?q=onboarding fetch
    // returns wf2 — a row absent from the first page (a beyond-cap match the
    // client-only filter could never surface). The org tag keeps the toolbar
    // (and its search box) visible even with a single loaded row.
    mockApi((url) => {
      if (url === '/workflows/tags') return { tags: ['onboarding'] }
      if (url.includes('q=onboarding')) return [FLOWS[1]]
      return [FLOWS[0]]
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByText('Billing sync')
    expect(screen.queryByText('Onboarding email')).not.toBeInTheDocument()
    fireEvent.change(screen.getByTestId('workflows-search'), { target: { value: 'onboarding' } })
    await waitFor(() => expect(screen.getByText('Onboarding email')).toBeInTheDocument(), { timeout: 2000 })
  })

  it('shows the search empty-state (not the all-clear) when the ?q= fetch returns nothing', async () => {
    const calls: string[] = []
    mockApi((url) => {
      calls.push(url)
      if (url === '/workflows/tags') return { tags: [] }
      if (url.includes('q=')) return [] // the server finds no match for the term
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')
    fireEvent.change(screen.getByTestId('workflows-search'), { target: { value: 'zzz-nothing' } })
    // The debounced server fetch fires and returns [] …
    await waitFor(() => expect(calls.some((u) => u.includes('q=zzz-nothing'))).toBe(true), { timeout: 2000 })
    // … and an empty result under an active search shows the search no-match
    // state, never the all-clear "no flows at all" panel.
    await waitFor(() => expect(screen.getByTestId('workflows-no-matches')).toBeInTheDocument())
    expect(screen.queryByTestId('workflows-empty')).not.toBeInTheDocument()
  })

  it('clears all active filters (search + tag) in one click and refetches unfiltered', async () => {
    const calls: string[] = []
    mockApi((url) => {
      calls.push(url)
      if (url === '/workflows/tags') return { tags: ['billing'] }
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')
    // Stack two filters: a tag chip + a search term.
    fireEvent.change(screen.getByTestId('workflows-tag-filter-add'), { target: { value: 'billing' } })
    await screen.findByTestId('workflows-tag-filter-remove-billing')
    fireEvent.change(screen.getByTestId('workflows-search'), { target: { value: 'onboard' } })
    const clearBtn = await screen.findByTestId('workflows-clear-filters')
    calls.length = 0
    fireEvent.click(clearBtn)
    // The chip + search box reset…
    await waitFor(() => expect(screen.queryByTestId('workflows-tag-filter-remove-billing')).not.toBeInTheDocument())
    expect((screen.getByTestId('workflows-search') as HTMLInputElement).value).toBe('')
    // …and the post-clear list fetch carries no filter params (unfiltered).
    await waitFor(() => expect(calls.some((u) => u === '/workflows')).toBe(true))
    expect(calls.every((u) => !u.includes('tag=') && !u.includes('q=') && !u.includes('folder='))).toBe(true)
    // The button disappears once nothing is filtered.
    await waitFor(() => expect(screen.queryByTestId('workflows-clear-filters')).not.toBeInTheDocument())
  })

  it('does not show the clear-filters button when no filter is active', async () => {
    mockApi((url) => {
      if (url === '/workflows/tags') return { tags: ['billing'] }
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')
    expect(screen.queryByTestId('workflows-clear-filters')).not.toBeInTheDocument()
  })

  it('shows "Load more" after a full page and appends the next keyset page on click', async () => {
    const calls: string[] = []
    mockApi((url) => {
      calls.push(url)
      if (url === '/workflows/tags') return { tags: [] }
      // The ?before= page is short (30 rows) → pagination ends after it.
      if (url.includes('before=')) return pageOfFlows(30, 100)
      // Page 1 is exactly full (PAGE_SIZE = 100) → "Load more" appears.
      return pageOfFlows(100, 0)
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    const btn = await screen.findByTestId('workflows-load-more')
    expect(screen.getAllByTestId(/^workflows-row-wf\d+$/).length).toBe(100)
    fireEvent.click(btn)
    // The next page is requested with a ?before= cursor built from the OLDEST
    // loaded row (wf99 — the last element of the createdAt-DESC page).
    await waitFor(() => expect(calls.some((u) => u.includes('before='))).toBe(true))
    const beforeCall = calls.find((u) => u.includes('before='))!
    expect(new URL(beforeCall, 'http://x').searchParams.get('before')?.endsWith('|wf99')).toBe(true)
    // …and the page is APPENDED (not replaced): 100 + 30 = 130 rows.
    await waitFor(() => expect(screen.getAllByTestId(/^workflows-row-wf\d+$/).length).toBe(130))
    // A short page ends pagination → the button disappears.
    await waitFor(() => expect(screen.queryByTestId('workflows-load-more')).not.toBeInTheDocument())
  })

  it('does not show "Load more" when the first page is short', async () => {
    mockApi((url) => {
      if (url === '/workflows/tags') return { tags: [] }
      return pageOfFlows(3, 0)
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf0')
    expect(screen.queryByTestId('workflows-load-more')).not.toBeInTheDocument()
  })

  it('migrates a persisted legacy scalar tag into a filter chip on mount', async () => {
    window.localStorage.setItem(FILTERS_KEY, JSON.stringify({ tag: 'billing', query: 'bill', sort: 'name' }))
    mockApi((url) => {
      if (url === '/workflows/tags') return { tags: ['billing'] }
      if (url.startsWith('/workflows?tag=billing')) return [FLOWS[0]]
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    // Legacy `{ tag: 'billing' }` (written before multi-tag) restores as one chip.
    expect(await screen.findByTestId('workflows-tag-filter-remove-billing')).toBeInTheDocument()
    expect((screen.getByTestId('workflows-search') as HTMLInputElement).value).toBe('bill')
  })

  it('restores a persisted multi-tag array as chips on mount', async () => {
    window.localStorage.setItem(FILTERS_KEY, JSON.stringify({ tags: ['billing', 'urgent'], query: '', sort: 'recent' }))
    mockApi((url) => {
      if (url === '/workflows/tags') return { tags: ['billing', 'urgent'] }
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    expect(await screen.findByTestId('workflows-tag-filter-remove-billing')).toBeInTheDocument()
    expect(screen.getByTestId('workflows-tag-filter-remove-urgent')).toBeInTheDocument()
  })

  it('reconciles a persisted tag the org no longer offers (drops the chip + refetches unfiltered)', async () => {
    window.localStorage.setItem(FILTERS_KEY, JSON.stringify({ tags: ['ghost'], query: '', sort: 'recent' }))
    const calls: string[] = []
    mockApi((url) => {
      calls.push(url)
      if (url === '/workflows/tags') return { tags: ['billing'] }
      if (url.startsWith('/workflows?tag=ghost')) return [] // the stale tag matches nothing
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    // The stale tag is dropped once the (ghost-less) options load → chip disappears…
    await waitFor(() =>
      expect(screen.queryByTestId('workflows-tag-filter-remove-ghost')).not.toBeInTheDocument(),
    )
    // …and the list refetches unfiltered.
    await waitFor(() => expect(screen.getByTestId('workflows-row-wf1')).toBeInTheDocument())
    expect(calls).toContain('/workflows')
  })

  it('persists the selected tags to localStorage', async () => {
    mockApi((url) => {
      if (url === '/workflows/tags') return { tags: ['billing'] }
      if (url.startsWith('/workflows?tag=billing')) return [FLOWS[0]]
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-tag-filter-add')
    fireEvent.change(screen.getByTestId('workflows-tag-filter-add'), { target: { value: 'billing' } })
    await waitFor(() => {
      const raw = window.localStorage.getItem(FILTERS_KEY)
      expect(raw && JSON.parse(raw).tags).toEqual(['billing'])
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
    fireEvent.click(billing.querySelector('summary')!)
    // The native details element changes before React commits, so persistence
    // must already be complete when the toggle handler returns. This protects
    // an immediate browser reload without relying on a deferred effect.
    const raw = window.localStorage.getItem(FILTERS_KEY)
    expect(raw && JSON.parse(raw).collapsedFolders).toContain('Billing')

    // A second click may arrive before the browser's asynchronous toggle event;
    // its intent still wins and clears the persisted collapse.
    fireEvent.click(billing.querySelector('summary')!)
    const expandedRaw = window.localStorage.getItem(FILTERS_KEY)
    expect(expandedRaw && JSON.parse(expandedRaw).collapsedFolders).not.toContain('Billing')
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

  it('populates the folder dropdown from GET /workflows/folders ("All folders" + one per org folder)', async () => {
    mockApi((url) => {
      if (url === '/workflows/folders') return { folders: ['Billing', 'Onboarding'] }
      if (url === '/workflows/tags') return { tags: [] }
      return FOLDERED
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    const select = (await screen.findByTestId('workflows-folder-filter')) as HTMLSelectElement
    const values = Array.from(select.options).map((o) => o.value)
    expect(values).toEqual(['', 'Billing', 'Onboarding'])
  })

  it('threads ?folder= into the list fetch when a folder is selected', async () => {
    const calls: string[] = []
    mockApi((url) => {
      calls.push(url)
      if (url === '/workflows/folders') return { folders: ['Billing'] }
      if (url === '/workflows/tags') return { tags: [] }
      if (url.startsWith('/workflows?folder=Billing')) return [FOLDERED[0]]
      return FOLDERED
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-filter')
    fireEvent.change(screen.getByTestId('workflows-folder-filter'), { target: { value: 'Billing' } })
    await waitFor(() => expect(calls).toContain('/workflows?folder=Billing'))
  })

  it('reconciles a persisted folder the org no longer offers (clears it + refetches unfiltered)', async () => {
    window.localStorage.setItem(FILTERS_KEY, JSON.stringify({ tag: '', folder: 'ghost', query: '', sort: 'recent', collapsedFolders: [] }))
    const calls: string[] = []
    mockApi((url) => {
      calls.push(url)
      if (url === '/workflows/folders') return { folders: ['Billing'] }
      if (url === '/workflows/tags') return { tags: [] }
      if (url.startsWith('/workflows?folder=ghost')) return [] // the stale folder matches nothing
      return FOLDERED
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    // The stale folder is dropped once the (ghost-less) options load → select clears…
    await waitFor(() => expect((screen.getByTestId('workflows-folder-filter') as HTMLSelectElement).value).toBe(''))
    // …and the list refetches unfiltered.
    await waitFor(() => expect(calls).toContain('/workflows'))
  })

  it('shows the no-folder-matches state when a folder filter returns nothing', async () => {
    mockApi((url) => {
      if (url === '/workflows/folders') return { folders: ['Billing'] }
      if (url === '/workflows/tags') return { tags: [] }
      if (url.startsWith('/workflows?folder=Billing')) return [] // folder emptied since the dropdown loaded
      return FOLDERED
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-filter')
    fireEvent.change(screen.getByTestId('workflows-folder-filter'), { target: { value: 'Billing' } })
    await waitFor(() => expect(screen.getByTestId('workflows-no-folder-matches')).toBeInTheDocument())
  })

  it('forces a previously-collapsed folder open when it is filtered to', async () => {
    // Billing is restored as collapsed; filtering to it must override the
    // persisted collapse so the operator doesn't land on an empty-looking section.
    window.localStorage.setItem(FILTERS_KEY, JSON.stringify({ tag: '', folder: '', query: '', sort: 'recent', collapsedFolders: ['Billing'] }))
    mockApi((url) => {
      if (url === '/workflows/folders') return { folders: ['Billing', 'Onboarding'] }
      if (url === '/workflows/tags') return { tags: [] }
      if (url.startsWith('/workflows?folder=Billing')) return [FOLDERED[0], FOLDERED[1]]
      return FOLDERED
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    // Unfiltered grouped view: Billing starts collapsed (restored from storage).
    const billing = (await screen.findByTestId('workflows-folder-Billing')) as HTMLDetailsElement
    expect(billing.open).toBe(false)
    // Filter to Billing → its section is forced open despite the persisted collapse.
    fireEvent.change(screen.getByTestId('workflows-folder-filter'), { target: { value: 'Billing' } })
    await waitFor(() => expect((screen.getByTestId('workflows-folder-Billing') as HTMLDetailsElement).open).toBe(true))
    // Clearing the filter restores the original collapse preference; the force-open
    // path must not silently erase it.
    fireEvent.change(screen.getByTestId('workflows-folder-filter'), { target: { value: '' } })
    await waitFor(() => expect((screen.getByTestId('workflows-folder-Billing') as HTMLDetailsElement).open).toBe(false))
  })

  it('renders a drag handle on grouped rows', async () => {
    mockApi((url) => {
      if (url === '/workflows/tags') return { tags: [] }
      return FOLDERED
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-Billing')
    expect(screen.getByTestId('workflows-drag-wf1')).toBeInTheDocument()
  })

  it('omits the drag handle on the flat list when no workflow has a folder', async () => {
    mockApi((url) => {
      if (url === '/workflows/tags') return { tags: [] }
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')
    expect(screen.queryByTestId('workflows-drag-wf1')).not.toBeInTheDocument()
  })

  it('reassigns a workflow to the dropped folder (POST /workflows/:id/folder)', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    mockListWithFolderPost(FOLDERED, calls)
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-Billing')

    // Drag wf3 (in Onboarding) onto the Billing section.
    const dataTransfer = makeDataTransfer()
    fireEvent.dragStart(screen.getByTestId('workflows-drag-wf3'), { dataTransfer })
    fireEvent.drop(screen.getByTestId('workflows-folder-Billing'), { dataTransfer })

    await waitFor(() =>
      expect(calls).toContainEqual({ url: '/workflows/wf3/folder', body: { folder: 'Billing' } }),
    )
  })

  it('clears the folder when a row is dropped on the Ungrouped section (folder: null)', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    mockListWithFolderPost(FOLDERED, calls)
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-ungrouped')

    // Drag wf1 (in Billing) onto the Ungrouped section.
    const dataTransfer = makeDataTransfer()
    fireEvent.dragStart(screen.getByTestId('workflows-drag-wf1'), { dataTransfer })
    fireEvent.drop(screen.getByTestId('workflows-folder-ungrouped'), { dataTransfer })

    await waitFor(() =>
      expect(calls).toContainEqual({ url: '/workflows/wf1/folder', body: { folder: null } }),
    )
  })

  it('does not POST when a row is dropped on its own folder (no-op)', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    mockListWithFolderPost(FOLDERED, calls)
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-Billing')

    // Drag wf1 (already in Billing) onto the Billing section.
    const dataTransfer = makeDataTransfer()
    fireEvent.dragStart(screen.getByTestId('workflows-drag-wf1'), { dataTransfer })
    fireEvent.drop(screen.getByTestId('workflows-folder-Billing'), { dataTransfer })

    // Give any microtasks a tick, then assert no POST fired.
    await Promise.resolve()
    expect(calls).toHaveLength(0)
  })

  it('reveals the New folder drop zone only while dragging a row', async () => {
    mockApi((url) => {
      if (url === '/workflows/folders') return { folders: ['Billing', 'Onboarding'] }
      if (url === '/workflows/tags') return { tags: [] }
      return FOLDERED
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-Billing')
    expect(screen.queryByTestId('workflows-newfolder-dropzone')).not.toBeInTheDocument()
    const dataTransfer = makeDataTransfer()
    fireEvent.dragStart(screen.getByTestId('workflows-drag-wf1'), { dataTransfer })
    expect(screen.getByTestId('workflows-newfolder-dropzone')).toBeInTheDocument()
  })

  it('drops a row on New folder, names it, and creates the folder (POST {folder})', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    mockListWithFolderPost(FOLDERED, calls)
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-Billing')
    const dataTransfer = makeDataTransfer()
    fireEvent.dragStart(screen.getByTestId('workflows-drag-wf1'), { dataTransfer })
    fireEvent.drop(screen.getByTestId('workflows-newfolder-dropzone'), { dataTransfer })
    const input = screen.getByTestId('workflows-newfolder-input')
    fireEvent.change(input, { target: { value: 'Q3 Launch' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(calls).toContainEqual({ url: '/workflows/wf1/folder', body: { folder: 'Q3 Launch' } }),
    )
  })

  it('cancels the New folder input (Escape) without moving the row', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    mockListWithFolderPost(FOLDERED, calls)
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-Billing')
    const dataTransfer = makeDataTransfer()
    fireEvent.dragStart(screen.getByTestId('workflows-drag-wf1'), { dataTransfer })
    fireEvent.drop(screen.getByTestId('workflows-newfolder-dropzone'), { dataTransfer })
    const input = screen.getByTestId('workflows-newfolder-input')
    fireEvent.change(input, { target: { value: 'Throwaway' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    await Promise.resolve()
    expect(screen.queryByTestId('workflows-newfolder-input')).not.toBeInTheDocument()
    expect(calls).toHaveLength(0)
  })

  it('does not create a folder when the typed name is blank', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    mockListWithFolderPost(FOLDERED, calls)
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-Billing')
    const dataTransfer = makeDataTransfer()
    fireEvent.dragStart(screen.getByTestId('workflows-drag-wf1'), { dataTransfer })
    fireEvent.drop(screen.getByTestId('workflows-newfolder-dropzone'), { dataTransfer })
    const input = screen.getByTestId('workflows-newfolder-input')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(screen.getByTestId('workflows-newfolder-save'))
    await Promise.resolve()
    expect(screen.queryByTestId('workflows-newfolder-input')).not.toBeInTheDocument()
    expect(calls).toHaveLength(0)
  })

  it('rolls the row back to its original folder when the folder POST fails', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    mockListWithFolderPost(FOLDERED, calls, 'reject')
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-Onboarding')

    // Drag wf3 (Onboarding) onto Billing; the POST rejects, so wf3 must end back
    // under Onboarding — never stranded in Billing by the optimistic move.
    const dataTransfer = makeDataTransfer()
    fireEvent.dragStart(screen.getByTestId('workflows-drag-wf3'), { dataTransfer })
    fireEvent.drop(screen.getByTestId('workflows-folder-Billing'), { dataTransfer })

    await waitFor(() => expect(calls).toHaveLength(1)) // the POST was attempted
    await waitFor(() =>
      expect(
        within(screen.getByTestId('workflows-folder-Onboarding')).getByTestId('workflows-row-wf3'),
      ).toBeInTheDocument(),
    )
    expect(
      within(screen.getByTestId('workflows-folder-Billing')).queryByTestId('workflows-row-wf3'),
    ).not.toBeInTheDocument()
  })

  it('shows a folder pill on a foldered row and omits it when ungrouped', async () => {
    mockApi((url) => {
      if (url === '/workflows/folders') return { folders: ['Billing', 'Onboarding'] }
      if (url === '/workflows/tags') return { tags: [] }
      return FOLDERED
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-Billing')
    // wf1 is in "Billing" → pill carries the folder via its title.
    expect(within(screen.getByTestId('workflows-row-wf1')).getByTitle('Folder: Billing')).toBeInTheDocument()
    // wf4 is ungrouped → no folder pill.
    expect(within(screen.getByTestId('workflows-row-wf4')).queryByTitle(/^Folder:/)).not.toBeInTheDocument()
  })

  it('renders a keyboard-accessible per-row folder select with the org folders + Ungrouped', async () => {
    mockApi((url) => {
      if (url === '/workflows/folders') return { folders: ['Billing', 'Onboarding'] }
      if (url === '/workflows/tags') return { tags: [] }
      return FOLDERED
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-Billing')
    const select = screen.getByTestId('workflows-move-folder-wf1') as HTMLSelectElement
    // First option is Ungrouped ('') then each org folder; current value = wf1's folder.
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'Billing', 'Onboarding'])
    expect(select.value).toBe('Billing')
  })

  it('omits the per-row folder select on the flat list when no workflow has a folder', async () => {
    mockApi((url) => {
      if (url === '/workflows/tags') return { tags: [] }
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')
    expect(screen.queryByTestId('workflows-move-folder-wf1')).not.toBeInTheDocument()
  })

  it('reassigns a workflow via the per-row select (POST /workflows/:id/folder)', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    mockListWithFolderPost(FOLDERED, calls)
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-Onboarding')
    // Move wf3 (Onboarding) → Billing via the keyboard-operable select.
    fireEvent.change(screen.getByTestId('workflows-move-folder-wf3'), { target: { value: 'Billing' } })
    await waitFor(() =>
      expect(calls).toContainEqual({ url: '/workflows/wf3/folder', body: { folder: 'Billing' } }),
    )
  })

  it('clears the folder via the per-row select choosing Ungrouped (folder: null)', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    mockListWithFolderPost(FOLDERED, calls)
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-Billing')
    fireEvent.change(screen.getByTestId('workflows-move-folder-wf1'), { target: { value: '' } })
    await waitFor(() =>
      expect(calls).toContainEqual({ url: '/workflows/wf1/folder', body: { folder: null } }),
    )
  })

  it('rolls the row back when the per-row select reassignment POST fails', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    mockListWithFolderPost(FOLDERED, calls, 'reject')
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-Onboarding')
    fireEvent.change(screen.getByTestId('workflows-move-folder-wf3'), { target: { value: 'Billing' } })
    await waitFor(() => expect(calls).toHaveLength(1)) // POST attempted
    // The optimistic move is undone — wf3 ends back under Onboarding.
    await waitFor(() =>
      expect(
        within(screen.getByTestId('workflows-folder-Onboarding')).getByTestId('workflows-row-wf3'),
      ).toBeInTheDocument(),
    )
  })

  it('clicking the per-row folder select does not open the workflow (stopPropagation)', async () => {
    const onOpen = vi.fn()
    mockApi((url) => {
      if (url === '/workflows/folders') return { folders: ['Billing', 'Onboarding'] }
      if (url === '/workflows/tags') return { tags: [] }
      return FOLDERED
    })
    render(<WorkflowsDashboard onOpen={onOpen} />)
    await screen.findByTestId('workflows-folder-Billing')
    fireEvent.click(screen.getByTestId('workflows-move-folder-wf3'))
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('reveals bulk-select checkboxes only after the Select toggle is on', async () => {
    mockApi((url) => {
      if (url === '/workflows/folders') return { folders: [] }
      if (url === '/workflows/tags') return { tags: [] }
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')
    expect(screen.queryByTestId('workflows-select-row-wf1')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('workflows-select-toggle'))
    expect(screen.getByTestId('workflows-select-row-wf1')).toBeInTheDocument()
    expect(screen.getByTestId('workflows-select-row-wf2')).toBeInTheDocument()
  })

  it('bulk-assigns the selected flows to a NEW folder (POST /workflows/folders/assign)', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    mockListWithFolderPost(FLOWS, calls)
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')
    fireEvent.click(screen.getByTestId('workflows-select-toggle'))
    fireEvent.click(screen.getByTestId('workflows-select-row-wf1'))
    fireEvent.click(screen.getByTestId('workflows-select-row-wf2'))
    // A brand-new folder name (not in folderOptions) is accepted via the datalist input.
    fireEvent.change(screen.getByTestId('workflows-bulk-folder-input'), { target: { value: 'Q3 Launch' } })
    fireEvent.click(screen.getByTestId('workflows-bulk-move'))
    await waitFor(() => {
      const assign = calls.find((c) => c.url === '/workflows/folders/assign')
      expect(assign?.body).toEqual({ workflowIds: ['wf1', 'wf2'], folder: 'Q3 Launch' })
    })
  })

  it('bulk-ungroups the selected flows (folder: null)', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    mockListWithFolderPost(FOLDERED, calls)
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-Billing')
    fireEvent.click(screen.getByTestId('workflows-select-toggle'))
    fireEvent.click(screen.getByTestId('workflows-select-row-wf1'))
    fireEvent.click(screen.getByTestId('workflows-bulk-ungroup'))
    await waitFor(() =>
      expect(calls).toContainEqual({ url: '/workflows/folders/assign', body: { workflowIds: ['wf1'], folder: null } }),
    )
  })

  it('rolls a bulk assign back when the POST fails', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    mockListWithFolderPost(FOLDERED, calls, 'reject')
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-Onboarding')
    fireEvent.click(screen.getByTestId('workflows-select-toggle'))
    fireEvent.click(screen.getByTestId('workflows-select-row-wf3'))
    fireEvent.change(screen.getByTestId('workflows-bulk-folder-input'), { target: { value: 'Billing' } })
    fireEvent.click(screen.getByTestId('workflows-bulk-move'))
    await waitFor(() => expect(calls.some((c) => c.url === '/workflows/folders/assign')).toBe(true))
    // wf3 ends back under Onboarding — the optimistic move is undone.
    await waitFor(() =>
      expect(within(screen.getByTestId('workflows-folder-Onboarding')).getByTestId('workflows-row-wf3')).toBeInTheDocument(),
    )
  })

  it('bulk-adds a tag to the selected flows (POST op:add)', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    mockListWithFolderPost(FOLDERED, calls)
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-Billing')
    fireEvent.click(screen.getByTestId('workflows-select-toggle'))
    fireEvent.click(screen.getByTestId('workflows-select-row-wf1'))
    fireEvent.click(screen.getByTestId('workflows-select-row-wf2'))
    fireEvent.change(screen.getByTestId('workflows-bulk-tag-input'), { target: { value: 'urgent' } })
    fireEvent.click(screen.getByTestId('workflows-bulk-tag-add'))
    await waitFor(() => {
      const assign = calls.find((c) => c.url === '/workflows/tags/assign')
      expect(assign?.body).toEqual({ workflowIds: ['wf1', 'wf2'], tag: 'urgent', op: 'add' })
    })
  })

  it('bulk-removes a tag from the selected flows (POST op:remove)', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    mockListWithFolderPost(FOLDERED, calls)
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-Billing')
    fireEvent.click(screen.getByTestId('workflows-select-toggle'))
    fireEvent.click(screen.getByTestId('workflows-select-row-wf1'))
    fireEvent.change(screen.getByTestId('workflows-bulk-tag-input'), { target: { value: 'billing' } })
    fireEvent.click(screen.getByTestId('workflows-bulk-tag-remove'))
    await waitFor(() => {
      const assign = calls.find((c) => c.url === '/workflows/tags/assign')
      expect(assign?.body).toEqual({ workflowIds: ['wf1'], tag: 'billing', op: 'remove' })
    })
  })

  it('rolls the optimistic tag change back when the tag POST fails', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    mockListWithFolderPost(FOLDERED, calls, 'reject')
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-Onboarding')
    fireEvent.click(screen.getByTestId('workflows-select-toggle'))
    fireEvent.click(screen.getByTestId('workflows-select-row-wf3'))
    fireEvent.change(screen.getByTestId('workflows-bulk-tag-input'), { target: { value: 'rollme' } })
    fireEvent.click(screen.getByTestId('workflows-bulk-tag-add'))
    await waitFor(() => expect(calls.some((c) => c.url === '/workflows/tags/assign')).toBe(true))
    // The optimistic 'rollme' pill is removed once the failure rolls back.
    await waitFor(() => expect(screen.queryByText('rollme')).not.toBeInTheDocument())
  })

  it('renames the active-filter tag across the org (POST /workflows/tags/rename)', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    vi.mocked(api).mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method === 'POST') { calls.push({ url, body: JSON.parse(String(options.body)) }); return { workflowId: url } }
      if (url === '/workflows/tags') return { tags: ['billing', 'urgent'] }
      if (url === '/workflows/folders') return { folders: [] }
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    fireEvent.change(await screen.findByTestId('workflows-tag-filter-add'), { target: { value: 'billing' } })
    fireEvent.click(await screen.findByTestId('workflows-tag-rename'))
    fireEvent.change(screen.getByTestId('workflows-tag-rename-input'), { target: { value: 'finance' } })
    fireEvent.keyDown(screen.getByTestId('workflows-tag-rename-input'), { key: 'Enter' })
    await waitFor(() => {
      const rename = calls.find((c) => c.url === '/workflows/tags/rename')
      expect(rename?.body).toEqual({ from: 'billing', to: 'finance' })
    })
  })

  it('rolls back the active tag rename when the POST fails', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    vi.mocked(api).mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method === 'POST') { calls.push({ url, body: JSON.parse(String(options.body)) }); throw new Error('rename failed') }
      if (url === '/workflows/tags') return { tags: ['billing', 'urgent'] }
      if (url === '/workflows/folders') return { folders: [] }
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    fireEvent.change(await screen.findByTestId('workflows-tag-filter-add'), { target: { value: 'billing' } })
    fireEvent.click(await screen.findByTestId('workflows-tag-rename'))
    fireEvent.change(screen.getByTestId('workflows-tag-rename-input'), { target: { value: 'finance' } })
    fireEvent.keyDown(screen.getByTestId('workflows-tag-rename-input'), { key: 'Enter' })

    await waitFor(() => expect(calls.some((c) => c.url === '/workflows/tags/rename')).toBe(true))
    await waitFor(() => expect(screen.getByTestId('workflows-tag-filter-remove-billing')).toBeInTheDocument())
    expect(within(screen.getByTestId('workflows-row-wf1')).getByText('billing')).toBeInTheDocument()
    expect(within(screen.getByTestId('workflows-row-wf1')).queryByText('finance')).not.toBeInTheDocument()
  })

  it('does not POST a tag rename when the name is unchanged', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    vi.mocked(api).mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method === 'POST') { calls.push({ url, body: JSON.parse(String(options.body)) }); return { workflowId: url } }
      if (url === '/workflows/tags') return { tags: ['billing'] }
      if (url === '/workflows/folders') return { folders: [] }
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    fireEvent.change(await screen.findByTestId('workflows-tag-filter-add'), { target: { value: 'billing' } })
    fireEvent.click(await screen.findByTestId('workflows-tag-rename'))
    fireEvent.change(screen.getByTestId('workflows-tag-rename-input'), { target: { value: 'billing' } })
    fireEvent.keyDown(screen.getByTestId('workflows-tag-rename-input'), { key: 'Enter' })
    await Promise.resolve()
    expect(calls.some((c) => c.url === '/workflows/tags/rename')).toBe(false)
  })

  it('deletes the active-filter tag from all flows (POST /workflows/tags/delete)', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    vi.mocked(api).mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method === 'POST') { calls.push({ url, body: JSON.parse(String(options.body)) }); return { workflowId: url } }
      if (url === '/workflows/tags') return { tags: ['billing'] }
      if (url === '/workflows/folders') return { folders: [] }
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    fireEvent.change(await screen.findByTestId('workflows-tag-filter-add'), { target: { value: 'billing' } })
    fireEvent.click(await screen.findByTestId('workflows-tag-delete'))
    fireEvent.click(await screen.findByTestId('workflows-tag-delete-confirm'))
    await waitFor(() => {
      const del = calls.find((c) => c.url === '/workflows/tags/delete')
      expect(del?.body).toEqual({ tag: 'billing' })
    })
  })

  it('rolls back the active tag delete when the POST fails', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    vi.mocked(api).mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method === 'POST') { calls.push({ url, body: JSON.parse(String(options.body)) }); throw new Error('delete failed') }
      if (url === '/workflows/tags') return { tags: ['billing'] }
      if (url === '/workflows/folders') return { folders: [] }
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    fireEvent.change(await screen.findByTestId('workflows-tag-filter-add'), { target: { value: 'billing' } })
    fireEvent.click(await screen.findByTestId('workflows-tag-delete'))
    fireEvent.click(await screen.findByTestId('workflows-tag-delete-confirm'))

    await waitFor(() => expect(calls.some((c) => c.url === '/workflows/tags/delete')).toBe(true))
    await waitFor(() => expect(screen.getByTestId('workflows-tag-filter-remove-billing')).toBeInTheDocument())
    expect(within(screen.getByTestId('workflows-row-wf1')).getByText('billing')).toBeInTheDocument()
  })

  it('adds a tag to a single row via the per-row "+ tag" picker (POST /workflows/:id/tags op:add)', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    vi.mocked(api).mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method === 'POST') { calls.push({ url, body: JSON.parse(String(options.body)) }); return { workflowId: url } }
      if (url === '/workflows/tags') return { tags: ['billing', 'urgent', 'finance'] }
      if (url === '/workflows/folders') return { folders: [] }
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')
    // wf1 already has billing + urgent, so 'finance' is the addable option.
    fireEvent.change(screen.getByTestId('workflows-row-tag-add-wf1'), { target: { value: 'finance' } })
    await waitFor(() => {
      const post = calls.find((c) => c.url === '/workflows/wf1/tags')
      expect(post?.body).toEqual({ tag: 'finance', op: 'add' })
    })
  })

  it('removes a tag from a single row via the pill ✕ (POST /workflows/:id/tags op:remove)', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    vi.mocked(api).mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method === 'POST') { calls.push({ url, body: JSON.parse(String(options.body)) }); return { workflowId: url } }
      if (url === '/workflows/tags') return { tags: ['billing', 'urgent'] }
      if (url === '/workflows/folders') return { folders: [] }
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')
    fireEvent.click(screen.getByTestId('workflows-row-tag-remove-wf1-billing'))
    await waitFor(() => {
      const post = calls.find((c) => c.url === '/workflows/wf1/tags')
      expect(post?.body).toEqual({ tag: 'billing', op: 'remove' })
    })
  })

  it('rolls the per-row tag change back when the POST fails', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    vi.mocked(api).mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method === 'POST') { calls.push({ url, body: JSON.parse(String(options.body)) }); throw new Error('row tag failed') }
      if (url === '/workflows/tags') return { tags: ['billing', 'urgent'] }
      if (url === '/workflows/folders') return { folders: [] }
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')
    fireEvent.click(screen.getByTestId('workflows-row-tag-remove-wf1-billing'))
    await waitFor(() => expect(calls.some((c) => c.url === '/workflows/wf1/tags')).toBe(true))
    // The optimistic removal rolls back → the billing pill's ✕ button is back.
    await waitFor(() => expect(screen.getByTestId('workflows-row-tag-remove-wf1-billing')).toBeInTheDocument())
  })

  it('Clear empties the selection (bulk bar disappears)', async () => {
    mockApi((url) => {
      if (url === '/workflows/folders') return { folders: [] }
      if (url === '/workflows/tags') return { tags: [] }
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')
    fireEvent.click(screen.getByTestId('workflows-select-toggle'))
    fireEvent.click(screen.getByTestId('workflows-select-row-wf1'))
    expect(screen.getByTestId('workflows-bulk-bar')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Clear'))
    expect(screen.queryByTestId('workflows-bulk-bar')).not.toBeInTheDocument()
  })

  it('Select all ticks every visible row and reveals the bulk bar', async () => {
    mockApi((url) => {
      if (url === '/workflows/folders') return { folders: [] }
      if (url === '/workflows/tags') return { tags: [] }
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')
    fireEvent.click(screen.getByTestId('workflows-select-toggle'))
    fireEvent.click(screen.getByTestId('workflows-select-all'))
    expect((screen.getByTestId('workflows-select-row-wf1') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId('workflows-select-row-wf2') as HTMLInputElement).checked).toBe(true)
    expect(screen.getByTestId('workflows-bulk-bar')).toBeInTheDocument()
  })

  it('Select all toggles back to Deselect all and clears the selection', async () => {
    mockApi((url) => {
      if (url === '/workflows/folders') return { folders: [] }
      if (url === '/workflows/tags') return { tags: [] }
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')
    fireEvent.click(screen.getByTestId('workflows-select-toggle'))
    const selectAll = screen.getByTestId('workflows-select-all')
    fireEvent.click(selectAll)
    expect(selectAll.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(selectAll)
    expect(screen.queryByTestId('workflows-bulk-bar')).not.toBeInTheDocument()
    expect(screen.getByTestId('workflows-select-all').getAttribute('aria-pressed')).toBe('false')
  })

  it('per-folder Select all ticks only that folder and drives a scoped bulk move', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    mockListWithFolderPost(FOLDERED, calls)
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-Billing')
    fireEvent.click(screen.getByTestId('workflows-select-toggle'))
    fireEvent.click(screen.getByTestId('workflows-select-folder-Billing'))
    // Billing has wf1 + wf2; wf3 (Onboarding) and wf4 (Ungrouped) stay untouched.
    expect((screen.getByTestId('workflows-select-row-wf1') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId('workflows-select-row-wf2') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId('workflows-select-row-wf3') as HTMLInputElement).checked).toBe(false)
    expect(screen.getByTestId('workflows-select-folder-Billing').getAttribute('aria-pressed')).toBe('true')
    fireEvent.change(screen.getByTestId('workflows-bulk-folder-input'), { target: { value: 'Q3 Launch' } })
    fireEvent.click(screen.getByTestId('workflows-bulk-move'))
    await waitFor(() => {
      const assign = calls.find((c) => c.url === '/workflows/folders/assign')
      expect(assign?.body).toEqual({ workflowIds: ['wf1', 'wf2'], folder: 'Q3 Launch' })
    })
  })

  it('hides the select-all controls until selection mode is on', async () => {
    mockApi((url) => {
      if (url === '/workflows/folders') return { folders: ['Billing', 'Onboarding'] }
      if (url === '/workflows/tags') return { tags: [] }
      return FOLDERED
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-Billing')
    expect(screen.queryByTestId('workflows-select-all')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workflows-select-folder-Billing')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('workflows-select-toggle'))
    expect(screen.getByTestId('workflows-select-all')).toBeInTheDocument()
    expect(screen.getByTestId('workflows-select-folder-Billing')).toBeInTheDocument()
  })

  it('offers rename + delete on a named folder but not on Ungrouped', async () => {
    mockApi((url) => {
      if (url === '/workflows/folders') return { folders: ['Billing', 'Onboarding'] }
      if (url === '/workflows/tags') return { tags: [] }
      return FOLDERED
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-Billing')
    expect(screen.getByTestId('workflows-renamefolder-Billing')).toBeInTheDocument()
    expect(screen.getByTestId('workflows-deletefolder-Billing')).toBeInTheDocument()
    expect(screen.getByLabelText('Rename Billing folder')).toBeInTheDocument()
    expect(screen.getByLabelText('Delete Billing folder')).toBeInTheDocument()
    // The synthetic "Ungrouped" bucket is not a real folder — no FOLDER manage
    // controls (scoped to the folder-management testids so the per-row Delete
    // affordance inside the section doesn't false-match a broad title regex).
    expect(within(screen.getByTestId('workflows-folder-ungrouped')).queryByTestId(/^workflows-renamefolder-/)).not.toBeInTheDocument()
    expect(within(screen.getByTestId('workflows-folder-ungrouped')).queryByTestId(/^workflows-deletefolder-/)).not.toBeInTheDocument()
  })

  it('renames a folder via the inline input (POST /workflows/folders/rename)', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    mockListWithFolderPost(FOLDERED, calls)
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-Billing')
    fireEvent.click(screen.getByTestId('workflows-renamefolder-Billing'))
    const input = screen.getByTestId('workflows-renamefolder-input-Billing')
    fireEvent.change(input, { target: { value: 'Invoicing' } })
    fireEvent.click(screen.getByTestId('workflows-renamefolder-save-Billing'))
    await waitFor(() =>
      expect(calls).toContainEqual({ url: '/workflows/folders/rename', body: { from: 'Billing', to: 'Invoicing' } }),
    )
  })

  it('does not POST a rename when the name is unchanged (no-op)', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    mockListWithFolderPost(FOLDERED, calls)
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-Billing')
    fireEvent.click(screen.getByTestId('workflows-renamefolder-Billing'))
    // Draft starts as the current name; saving without editing is a no-op.
    fireEvent.click(screen.getByTestId('workflows-renamefolder-save-Billing'))
    await Promise.resolve()
    expect(calls.filter((c) => c.url === '/workflows/folders/rename')).toHaveLength(0)
  })

  it('rolls the rename back when the POST fails (section stays under the old name)', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    mockListWithFolderPost(FOLDERED, calls, 'reject')
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-Billing')
    fireEvent.click(screen.getByTestId('workflows-renamefolder-Billing'))
    fireEvent.change(screen.getByTestId('workflows-renamefolder-input-Billing'), { target: { value: 'Invoicing' } })
    fireEvent.click(screen.getByTestId('workflows-renamefolder-save-Billing'))
    await waitFor(() => expect(calls).toHaveLength(1)) // POST attempted
    // Optimistic re-key is reverted — Billing survives, Invoicing never sticks.
    await waitFor(() => expect(screen.getByTestId('workflows-folder-Billing')).toBeInTheDocument())
    expect(screen.queryByTestId('workflows-folder-Invoicing')).not.toBeInTheDocument()
  })

  it('deletes a folder after confirm (POST /workflows/folders/delete)', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    mockListWithFolderPost(FOLDERED, calls)
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-Onboarding')
    fireEvent.click(screen.getByTestId('workflows-deletefolder-Onboarding'))
    // The confirm row replaces the summary content until confirmed.
    fireEvent.click(screen.getByTestId('workflows-deletefolder-confirm-Onboarding'))
    await waitFor(() =>
      expect(calls).toContainEqual({ url: '/workflows/folders/delete', body: { folder: 'Onboarding' } }),
    )
  })

  it('rolls the delete back when the POST fails (members stay in the folder)', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    mockListWithFolderPost(FOLDERED, calls, 'reject')
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-folder-Onboarding')
    fireEvent.click(screen.getByTestId('workflows-deletefolder-Onboarding'))
    fireEvent.click(screen.getByTestId('workflows-deletefolder-confirm-Onboarding'))
    await waitFor(() => expect(calls).toHaveLength(1)) // POST attempted
    // Optimistic null-out is reverted — wf3 stays under Onboarding.
    await waitFor(() =>
      expect(within(screen.getByTestId('workflows-folder-Onboarding')).getByTestId('workflows-row-wf3')).toBeInTheDocument(),
    )
  })

  // --- Soft-delete loop: per-row delete (active) + Trash view + restore ---

  const TRASH: Flow[] = [
    { id: 'wfd', orgId: 'o', name: 'Deleted flow', runCount: 2, deletedAt: '2026-06-05T00:00:00.000Z' },
  ]

  // Method-aware mock for the delete/trash/restore loop: GET /workflows → active,
  // GET /workflows/trash → trash, any non-GET is recorded (and can be forced to
  // reject for the rollback paths). STATEFUL — a mutation moves the row between
  // the active + trash sets so the bumpPlatformVersion()-driven refetch is
  // consistent with the optimistic update (a static trash list would re-add a
  // just-restored row and race the assertions).
  function mockSoftDeleteLoop(opts: {
    active: Flow[]
    trash: Flow[]
    calls: Array<{ url: string; method: string }>
    fail?: boolean
  }) {
    let active = [...opts.active]
    let trash = [...opts.trash]
    vi.mocked(api).mockImplementation(async (url: string, options?: RequestInit) => {
      const method = options?.method ?? 'GET'
      if (method !== 'GET') {
        opts.calls.push({ url, method })
        if (opts.fail) throw new Error('mutation failed')
        const restore = url.match(/^\/workflows\/([^/]+)\/restore$/)
        const del = method === 'DELETE' ? url.match(/^\/workflows\/([^/]+)$/) : null
        if (restore) {
          const id = restore[1]
          const row = trash.find((w) => w.id === id)
          trash = trash.filter((w) => w.id !== id)
          if (row) active = [{ ...row, deletedAt: null }, ...active]
        } else if (del) {
          const id = del[1]
          const row = active.find((w) => w.id === id)
          active = active.filter((w) => w.id !== id)
          if (row) trash = [{ ...row, deletedAt: '2026-06-05T00:00:00.000Z' }, ...trash]
        }
        return { ok: true }
      }
      if (url === '/workflows/tags') return { tags: [] }
      if (url === '/workflows/folders') return { folders: [] }
      if (url === '/org/config') return { config: [] } // retention key unset → default window
      if (url.startsWith('/workflows/trash')) return trash
      return active
    })
  }

  it('soft-deletes a workflow via an inline confirm → DELETE + optimistic row removal', async () => {
    const calls: Array<{ url: string; method: string }> = []
    mockSoftDeleteLoop({ active: FLOWS, trash: [], calls })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')

    // First click reveals the inline confirm (no request yet).
    fireEvent.click(screen.getByTestId('workflows-delete-wf1'))
    expect(screen.getByTestId('workflows-delete-confirm-wf1')).toBeInTheDocument()
    expect(calls).toHaveLength(0)

    // Confirm fires the DELETE and the row disappears.
    fireEvent.click(screen.getByTestId('workflows-delete-confirm-wf1'))
    await waitFor(() => expect(calls).toEqual([{ url: '/workflows/wf1', method: 'DELETE' }]))
    await waitFor(() => expect(screen.queryByTestId('workflows-row-wf1')).not.toBeInTheDocument())
    // The untouched row stays.
    expect(screen.getByTestId('workflows-row-wf2')).toBeInTheDocument()
  })

  it('clears a deleted active row from the bulk selection', async () => {
    const calls: Array<{ url: string; method: string }> = []
    mockSoftDeleteLoop({ active: FLOWS, trash: [], calls })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')

    fireEvent.click(screen.getByTestId('workflows-select-toggle'))
    fireEvent.click(screen.getByTestId('workflows-select-row-wf1'))
    expect(screen.getByTestId('workflows-bulk-bar')).toHaveTextContent('1 selected')

    fireEvent.click(screen.getByTestId('workflows-delete-wf1'))
    fireEvent.click(screen.getByTestId('workflows-delete-confirm-wf1'))

    await waitFor(() => expect(calls).toEqual([{ url: '/workflows/wf1', method: 'DELETE' }]))
    await waitFor(() => expect(screen.queryByTestId('workflows-row-wf1')).not.toBeInTheDocument())
    expect(screen.queryByTestId('workflows-bulk-bar')).not.toBeInTheDocument()
  })

  it('cancelling the delete confirm makes no request and keeps the row', async () => {
    const calls: Array<{ url: string; method: string }> = []
    mockSoftDeleteLoop({ active: FLOWS, trash: [], calls })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')

    fireEvent.click(screen.getByTestId('workflows-delete-wf1'))
    const confirm = screen.getByTestId('workflows-delete-confirm-wf1')
    // The cancel button sits next to the confirm CTA in the same control group.
    fireEvent.click(within(confirm.parentElement as HTMLElement).getAllByRole('button').at(-1) as HTMLElement)

    await waitFor(() => expect(screen.queryByTestId('workflows-delete-confirm-wf1')).not.toBeInTheDocument())
    expect(calls).toHaveLength(0)
    expect(screen.getByTestId('workflows-row-wf1')).toBeInTheDocument()
  })

  it('rolls the row back when the DELETE fails', async () => {
    const calls: Array<{ url: string; method: string }> = []
    mockSoftDeleteLoop({ active: FLOWS, trash: [], calls, fail: true })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')

    fireEvent.click(screen.getByTestId('workflows-delete-wf1'))
    fireEvent.click(screen.getByTestId('workflows-delete-confirm-wf1'))

    await waitFor(() => expect(calls).toHaveLength(1))
    // Optimistic removal is reverted — the row returns.
    await waitFor(() => expect(screen.getByTestId('workflows-row-wf1')).toBeInTheDocument())
  })

  it('toggles to Trash, fetches GET /workflows/trash, and restores a row', async () => {
    const calls: Array<{ url: string; method: string }> = []
    mockSoftDeleteLoop({ active: FLOWS, trash: TRASH, calls })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')

    fireEvent.click(screen.getByTestId('workflows-trash-toggle'))
    // The trash list renders the soft-deleted row; active rows are gone.
    await screen.findByTestId('workflows-trash-list')
    expect(screen.getByTestId('workflows-trash-row-wfd')).toBeInTheDocument()
    expect(screen.queryByTestId('workflows-row-wf1')).not.toBeInTheDocument()

    // Restore POSTs to /restore and drops the row from the trash list.
    fireEvent.click(screen.getByTestId('workflows-restore-wfd'))
    await waitFor(() => expect(calls).toEqual([{ url: '/workflows/wfd/restore', method: 'POST' }]))
    await waitFor(() => expect(screen.queryByTestId('workflows-trash-row-wfd')).not.toBeInTheDocument())
  })

  it('ignores a stale active-list response after switching to Trash', async () => {
    let resolveActive: (value: Flow[]) => void = () => {}
    const activePromise = new Promise<Flow[]>((resolve) => { resolveActive = resolve })
    vi.mocked(api).mockImplementation(async (url: string) => {
      if (url === '/workflows/tags') return { tags: [] }
      if (url === '/workflows/folders') return { folders: [] }
      if (url.startsWith('/workflows/trash')) return TRASH
      return activePromise
    })

    render(<WorkflowsDashboard onOpen={() => {}} />)
    fireEvent.click(screen.getByTestId('workflows-trash-toggle'))
    await screen.findByTestId('workflows-trash-row-wfd')

    await act(async () => {
      resolveActive(FLOWS)
      await activePromise
    })

    expect(screen.getByTestId('workflows-trash-row-wfd')).toBeInTheDocument()
    expect(screen.queryByTestId('workflows-trash-row-wf1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workflows-row-wf1')).not.toBeInTheDocument()
  })

  it('clears the prior view rows on toggle so they never render through the wrong row template', async () => {
    // Trash fetch held pending so we can inspect the swap window.
    let resolveTrash: (value: Flow[]) => void = () => {}
    const trashPromise = new Promise<Flow[]>((resolve) => { resolveTrash = resolve })
    vi.mocked(api).mockImplementation(async (url: string) => {
      if (url === '/workflows/tags') return { tags: [] }
      if (url === '/workflows/folders') return { folders: [] }
      if (url.startsWith('/workflows/trash')) return trashPromise
      return FLOWS
    })

    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')

    fireEvent.click(screen.getByTestId('workflows-trash-toggle'))

    // While the trash fetch is pending, the prior active rows are cleared and
    // NONE of them paint as trash rows (the stale-view render the toggle guards).
    await waitFor(() => expect(screen.queryByTestId('workflows-row-wf1')).not.toBeInTheDocument())
    expect(screen.queryByTestId('workflows-trash-row-wf1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workflows-trash-list')).not.toBeInTheDocument()

    // Resolving paints the real trash rows.
    await act(async () => {
      resolveTrash(TRASH)
      await trashPromise
    })
    expect(screen.getByTestId('workflows-trash-row-wfd')).toBeInTheDocument()
  })

  it('shows the trash empty state when no workflows are soft-deleted', async () => {
    const calls: Array<{ url: string; method: string }> = []
    mockSoftDeleteLoop({ active: FLOWS, trash: [], calls })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')

    fireEvent.click(screen.getByTestId('workflows-trash-toggle'))
    await screen.findByTestId('workflows-trash-empty')
    expect(screen.queryByTestId('workflows-trash-list')).not.toBeInTheDocument()
  })

  const DAY_MS = 86_400_000

  // A trash list whose rows' deletedAt are offsets from "now", so the expiry
  // countdown is stable under daysUntilPurge's ceil regardless of test clock.
  function trashRowsRelativeToNow(): Flow[] {
    return [
      { id: 'wf-fresh', orgId: 'o', name: 'Recently deleted', runCount: 0, deletedAt: new Date(Date.now() - 5 * DAY_MS).toISOString() },
      { id: 'wf-stale', orgId: 'o', name: 'Long deleted', runCount: 0, deletedAt: new Date(Date.now() - 40 * DAY_MS).toISOString() },
    ]
  }

  it('renders the retention countdown per trash row using the org window from /org/config', async () => {
    vi.mocked(api).mockImplementation(async (url: string) => {
      if (url === '/workflows/tags') return { tags: [] }
      if (url === '/workflows/folders') return { folders: [] }
      if (url === '/org/config') return { config: [{ key: 'retention.deletedWorkflowsDays', value: 30 }] }
      if (url.startsWith('/workflows/trash')) return trashRowsRelativeToNow()
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')

    fireEvent.click(screen.getByTestId('workflows-trash-toggle'))
    // Window 30, deleted 5 days ago → 25 days left.
    const fresh = await screen.findByTestId('workflows-trash-expiry-wf-fresh')
    expect(fresh).toHaveTextContent('Expires in 25 days')
    // Window 30, deleted 40 days ago → past the window → "Expires soon".
    expect(screen.getByTestId('workflows-trash-expiry-wf-stale')).toHaveTextContent('Expires soon')
  })

  it('omits the expiry label when /org/config cannot be read (no guessed number)', async () => {
    vi.mocked(api).mockImplementation(async (url: string) => {
      if (url === '/workflows/tags') return { tags: [] }
      if (url === '/workflows/folders') return { folders: [] }
      if (url === '/org/config') throw new Error('config unavailable')
      if (url.startsWith('/workflows/trash')) return trashRowsRelativeToNow()
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')

    fireEvent.click(screen.getByTestId('workflows-trash-toggle'))
    await screen.findByTestId('workflows-trash-row-wf-fresh')
    expect(screen.queryByTestId('workflows-trash-expiry-wf-fresh')).not.toBeInTheDocument()
  })

  const TRASH3: Flow[] = [
    { id: 'wfa', orgId: 'o', name: 'Trash A', runCount: 0, deletedAt: '2026-06-05T00:00:00.000Z' },
    { id: 'wfb', orgId: 'o', name: 'Trash B', runCount: 0, deletedAt: '2026-06-05T00:00:00.000Z' },
    { id: 'wfc', orgId: 'o', name: 'Trash C', runCount: 0, deletedAt: '2026-06-05T00:00:00.000Z' },
  ]

  it('bulk-restores the checked trash rows via the per-id route', async () => {
    const calls: Array<{ url: string; method: string }> = []
    mockSoftDeleteLoop({ active: FLOWS, trash: TRASH3, calls })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')

    fireEvent.click(screen.getByTestId('workflows-trash-toggle'))
    await screen.findByTestId('workflows-trash-list')

    fireEvent.click(screen.getByTestId('workflows-trash-select-wfa'))
    fireEvent.click(screen.getByTestId('workflows-trash-select-wfb'))
    fireEvent.click(screen.getByTestId('workflows-trash-restore-selected'))

    // One POST /workflows/<id>/restore per checked row.
    await waitFor(() => {
      const restores = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/restore')).map((c) => c.url).sort()
      expect(restores).toEqual(['/workflows/wfa/restore', '/workflows/wfb/restore'])
    })
    // Restored rows leave trash; the unchecked one stays.
    await waitFor(() => expect(screen.queryByTestId('workflows-trash-row-wfa')).not.toBeInTheDocument())
    expect(screen.queryByTestId('workflows-trash-row-wfb')).not.toBeInTheDocument()
    expect(screen.getByTestId('workflows-trash-row-wfc')).toBeInTheDocument()
  })

  it('select-all ticks every trash row; the toggle then clears them', async () => {
    const calls: Array<{ url: string; method: string }> = []
    mockSoftDeleteLoop({ active: FLOWS, trash: TRASH3, calls })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')

    fireEvent.click(screen.getByTestId('workflows-trash-toggle'))
    await screen.findByTestId('workflows-trash-list')

    fireEvent.click(screen.getByTestId('workflows-trash-select-all'))
    expect((screen.getByTestId('workflows-trash-select-wfa') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId('workflows-trash-select-wfc') as HTMLInputElement).checked).toBe(true)

    fireEvent.click(screen.getByTestId('workflows-trash-select-all')) // now the clear toggle
    expect((screen.getByTestId('workflows-trash-select-wfa') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByTestId('workflows-trash-select-wfc') as HTMLInputElement).checked).toBe(false)
  })

  it('clears a row from the trash selection when it is restored individually', async () => {
    const calls: Array<{ url: string; method: string }> = []
    mockSoftDeleteLoop({ active: FLOWS, trash: TRASH3, calls })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')

    fireEvent.click(screen.getByTestId('workflows-trash-toggle'))
    await screen.findByTestId('workflows-trash-list')

    fireEvent.click(screen.getByTestId('workflows-trash-select-wfa'))
    expect(screen.getByTestId('workflows-trash-restore-selected')).toHaveTextContent('Restore selected (1)')

    fireEvent.click(screen.getByTestId('workflows-restore-wfa'))
    await waitFor(() => expect(screen.queryByTestId('workflows-trash-row-wfa')).not.toBeInTheDocument())

    const restoreSelected = screen.getByTestId('workflows-trash-restore-selected') as HTMLButtonElement
    expect(restoreSelected).toBeDisabled()
    expect(restoreSelected).toHaveTextContent('Restore selected (0)')
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument()
  })

  it('reconciles a partial bulk-restore failure — the failed row reappears', async () => {
    let trash: Flow[] = [...TRASH3]
    vi.mocked(api).mockImplementation(async (url: string, options?: RequestInit) => {
      const method = options?.method ?? 'GET'
      if (method === 'POST' && url.endsWith('/restore')) {
        const id = url.match(/\/workflows\/([^/]+)\/restore$/)![1]
        if (id === 'wfb') throw new Error('restore failed') // one of the two fails
        trash = trash.filter((w) => w.id !== id)
        return { ok: true }
      }
      if (url === '/workflows/tags') return { tags: [] }
      if (url === '/workflows/folders') return { folders: [] }
      if (url === '/org/config') return { config: [] }
      if (url.startsWith('/workflows/trash')) return trash
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')

    fireEvent.click(screen.getByTestId('workflows-trash-toggle'))
    await screen.findByTestId('workflows-trash-list')

    fireEvent.click(screen.getByTestId('workflows-trash-select-wfa'))
    fireEvent.click(screen.getByTestId('workflows-trash-select-wfb'))
    fireEvent.click(screen.getByTestId('workflows-trash-restore-selected'))

    // wfa restored (gone); wfb failed → the bump-driven refetch re-adds it.
    await waitFor(() => expect(screen.queryByTestId('workflows-trash-row-wfa')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByTestId('workflows-trash-row-wfb')).toBeInTheDocument())
  })

  it('paginates the Trash list with a deletedAt keyset cursor (not createdAt)', async () => {
    const PAGE = 100
    const calls: string[] = []
    // A full first page (length === PAGE_SIZE) so the "Load more" button shows.
    // Rows carry deletedAt only (no createdAt) — so if loadMore wrongly used
    // createdAt the cursor would be undefined and no second fetch would fire.
    const page1: Flow[] = Array.from({ length: PAGE }, (_, k) => ({
      id: `t${k}`, orgId: 'o', name: `Trash ${k}`, runCount: 0,
      deletedAt: new Date(Date.UTC(2026, 5, 1) - k * 1000).toISOString(),
    }))
    const page2: Flow[] = [{ id: 't100', orgId: 'o', name: 'Trash 100', runCount: 0, deletedAt: '2026-05-01T00:00:00.000Z' }]
    vi.mocked(api).mockImplementation(async (url: string) => {
      if (url === '/workflows/tags') return { tags: [] }
      if (url === '/workflows/folders') return { folders: [] }
      if (url === '/org/config') return { config: [] }
      if (url.startsWith('/workflows/trash')) {
        calls.push(url)
        return url.includes('before=') ? page2 : page1
      }
      return FLOWS
    })
    render(<WorkflowsDashboard onOpen={() => {}} />)
    await screen.findByTestId('workflows-row-wf1')

    fireEvent.click(screen.getByTestId('workflows-trash-toggle'))
    await screen.findByTestId('workflows-trash-list')

    // A full page → the existing keyset "Load more" button renders in Trash.
    fireEvent.click(await screen.findByTestId('workflows-load-more'))

    // The second fetch's cursor is the oldest row's deletedAt + id.
    const oldest = page1[page1.length - 1]!
    await waitFor(() => {
      const paged = calls.find((u) => u.includes('before='))
      expect(paged).toBeTruthy()
      expect(new URLSearchParams(paged!.split('?')[1]).get('before')).toBe(`${oldest.deletedAt}|${oldest.id}`)
    })
    // The next page appends.
    await screen.findByTestId('workflows-trash-row-t100')
  })
})
