import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    // The synthetic "Ungrouped" bucket is not a real folder — no manage controls.
    expect(within(screen.getByTestId('workflows-folder-ungrouped')).queryByTitle(/^Rename/)).not.toBeInTheDocument()
    expect(within(screen.getByTestId('workflows-folder-ungrouped')).queryByTitle(/^Delete/)).not.toBeInTheDocument()
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
})
