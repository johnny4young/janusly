import { act, render, screen, waitFor } from '@testing-library/react'
import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { initI18n } from '../i18n'
import { PLATFORM_TAG, invalidateTags } from '../lib/query-cache'
import { __resetBumpCoalesceForTests, useWorkflowStore } from '../store'
import { deadLetterWireDefaults } from '../test/dead-letter-fixture'
import { DeadLettersPanel, type DeadLetter } from './DeadLettersPanel'
import { requestRecoveryQueueFocus } from './recovery-queue-focus-bus'

vi.mock('../api', () => {
  const api = vi.fn()
  return { api, downloadFromApi: vi.fn(), contractApi: (_op: string, path: string, _body: unknown, options?: RequestInit) => api(path, options) }
})
const initialState = useWorkflowStore.getState()
const rows: DeadLetter[] = ['invoice', 'shipment'].map(id => ({
  ...deadLetterWireDefaults, id, runId: `run-${id}`, nodeId: `${id}-${'long-identifier-'.repeat(8)}`,
  status: 'open', attempt: 1, workflowJson: {}, nodeJson: {}, errorJson: { message: 'Service unavailable' },
  createdAt: '2026-09-01T12:00:00Z',
}))

let queueRows = rows

beforeEach(() => {
  queueRows = rows
  __resetBumpCoalesceForTests()
  localStorage.clear()
  sessionStorage.clear()
  useWorkflowStore.setState({ ...initialState, toasts: [] }, true)
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(async path => {
    if (path === '/dlq/counts') return { total: 12, open: 9, replayed: 2, resolved: 1 }
    if (path.startsWith('/dlq/queue')) return { items: queueRows, nextCursor: null, hasMore: false }
    if (path.startsWith('/dlq/entries/')) return rows.find(row => path.endsWith(row.id))
    throw new Error(`Unexpected read: ${path}`)
  })
})

function mountQueue() {
  return render(<DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} />)
}

describe('Recovery queue layout and focus in Chromium', () => {
  it.each(['en', 'es'] as const)('puts work before tall controls and retains all filters at narrow widths in %s', async locale => {
    initI18n(locale)
    await page.viewport(1280, 800)
    localStorage.setItem('janusly:recoveryQueueFilters', JSON.stringify({ view: 'list' }))
    mountQueue()
    try {
      const row = await screen.findByTestId('dlq-row-invoice')
      expect(row.getBoundingClientRect().top).toBeLessThan(180)
      // 640 CSS pixels exercises reflow of a 1280px-wide window at 200% zoom,
      // not screen-reader or physical browser-zoom qualification.
      for (const width of [1280, 640, 390]) {
        await page.viewport(width, 800)
        const queue = screen.getByTestId('recovery-queue')
        expect(queue.scrollWidth).toBeLessThanOrEqual(queue.clientWidth + 1)
        for (const id of ['dlq-search', 'dlq-filter', 'dlq-owner', 'dlq-severity-filter', 'dlq-sort']) {
          const input = document.getElementById(id)!
          expect(input.getBoundingClientRect().width).toBeGreaterThan(80)
          expect(input.getBoundingClientRect().right).toBeLessThanOrEqual(width)
          expect(input).toHaveAccessibleName()
        }
        expect(row.getBoundingClientRect().height).toBe(84)
        await page.getByTestId('recovery-queue').screenshot({ path: `../../test-results/queue-${locale}-${width}.png` })
      }
    } finally { await page.viewport(1024, 768) }
  })

  // Card widths beside the sidebar in 1280px (English) and 1440px (Spanish) windows.
  it.each([['en', 852], ['es', 1012]] as const)('keeps search, status chips and menus on one row in %s at a %ipx card', async (locale, width) => {
    initI18n(locale)
    render(<div style={{ width }}><DeadLettersPanel onRefresh={vi.fn()} onReplay={vi.fn()} onResolve={vi.fn()} /></div>)
    await screen.findByTestId('dlq-row-invoice')
    const centers = ['dlq-search', 'dlq-filter', 'dlq-owner', 'dlq-severity-filter', 'dlq-sort']
      .map(id => { const box = document.getElementById(id)!.getBoundingClientRect(); return box.top + box.height / 2 })
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1)
    expect(screen.getByTestId('dlq-toolbar').getBoundingClientRect().height).toBeLessThanOrEqual(40)
  })

  it.each(['en', 'es'] as const)('triages side by side in %s: J/K moves neither pane and the action bar stays in view', async locale => {
    initI18n(locale)
    await page.viewport(1280, 800)
    const tall = { message: 'Service unavailable', detail: 'x'.repeat(6_000) }
    queueRows = Array.from({ length: 12 }, (_, index) => ({ ...rows[0]!, id: `r${index}`, runId: `run-${index}`, errorJson: tall }))
    vi.mocked(api).mockImplementation(async path => {
      if (path === '/dlq/counts') return { total: 12, open: 12, replayed: 0, resolved: 0 }
      if (path.startsWith('/dlq/queue')) return { items: queueRows, nextCursor: null, hasMore: false }
      if (path.startsWith('/dlq/entries/')) return queueRows.find(row => path.endsWith(row.id))
      return { clusters: [], totalSamples: 0, windowDays: 30 }
    })
    mountQueue()
    try {
      const first = await screen.findByTestId('dlq-row-r0')
      const left = screen.getByTestId('dlq-queue-pane')
      const right = screen.getByTestId('dlq-detail-pane')
      const leftBox = left.getBoundingClientRect()
      const rightBox = right.getBoundingClientRect()
      expect(leftBox.right).toBeLessThanOrEqual(rightBox.left)
      expect(leftBox.top).toBe(rightBox.top)
      expect(leftBox.height).toBe(rightBox.height)
      expect(screen.getByRole('grid').querySelector('.we-dlq-cluster')!.getBoundingClientRect().height).toBe(84)
      expect(first.scrollWidth).toBeLessThanOrEqual(first.clientWidth)

      await userEvent.click(first)
      await userEvent.keyboard('jjjjjjjj')
      await waitFor(() => expect(screen.getByTestId('dlq-row-r8')).toHaveFocus())
      expect(left.getBoundingClientRect().top).toBe(leftBox.top)
      expect(right.getBoundingClientRect().top).toBe(rightBox.top)

      // The list scrolls inside its pane; the focused row is not left below it.
      const list = screen.getByTestId('dlq-virtual-list')
      expect(list.scrollTop).toBeGreaterThan(0)
      expect(screen.getByTestId('dlq-row-r8').getBoundingClientRect().bottom).toBeLessThanOrEqual(list.getBoundingClientRect().bottom + 1)

      right.scrollTop = right.scrollHeight
      await waitFor(() => expect(right.scrollTop).toBeGreaterThan(0))
      const bar = screen.getByTestId('dlq-action-bar').getBoundingClientRect()
      expect(bar.top).toBeGreaterThanOrEqual(rightBox.top)
      expect(bar.bottom).toBeLessThanOrEqual(rightBox.bottom)

      // Selecting another failure starts its detail from the top.
      await userEvent.keyboard('k')
      await waitFor(() => expect(screen.getByTestId('dlq-row-r7')).toHaveFocus())
      await waitFor(() => expect(right.scrollTop).toBe(0))

      await userEvent.click(screen.getByTestId('dlq-select-toggle'))
      await waitFor(() => expect(screen.queryByTestId('dlq-detail-pane')).toBeNull())
      expect(list.clientHeight).toBeLessThanOrEqual(window.innerHeight * 0.6 + 1)
      expect(list.scrollHeight).toBeGreaterThan(list.clientHeight)
      await userEvent.click(screen.getByTestId('dlq-select-toggle'))

      await page.viewport(640, 800)
      await waitFor(() => expect(left.getBoundingClientRect().bottom).toBeLessThanOrEqual(screen.getByTestId('dlq-detail-pane').getBoundingClientRect().top))
      const head = document.querySelector('.we-dlq-detail__head')!
      expect(getComputedStyle(head).position).toBe('static')
    } finally { await page.viewport(1024, 768) }
  })

  it('opens the recovery item drawer in the detail pane, leaving the queue and Load more usable', async () => {
    initI18n('en')
    await page.viewport(1280, 800)
    const recovery: DeadLetter['recovery'] = {
      id: 'item', owner: null, severity: 'p2', status: 'open', slaTargetAt: '2026-09-02T12:00:00Z', resolutionReason: null,
      comments: [], workflowId: null, occurrenceCount: 2, lastOccurredAt: '2026-09-01T12:00:00Z',
    }
    queueRows = Array.from({ length: 6 }, (_, index) => ({ ...rows[0]!, id: `r${index}`, runId: `run-${index}`, recovery }))
    vi.mocked(api).mockImplementation(async path => {
      if (path === '/dlq/counts') return { total: 6, open: 6, replayed: 0, resolved: 0 }
      if (path.startsWith('/dlq/queue')) return { items: queueRows, nextCursor: 'next', hasMore: true }
      if (path.startsWith('/dlq/entries/')) return { ...rows[0]!, id: path.split('/').at(-1)! }
      if (path === '/dlq/clusters') return { clusters: [], totalSamples: 0, windowDays: 30 }
      return []
    })
    mountQueue()
    try {
      const list = await screen.findByTestId('dlq-virtual-list')
      const left = screen.getByTestId('dlq-queue-pane')
      const leftBox = left.getBoundingClientRect()
      const listHeight = list.clientHeight
      expect(listHeight).toBeGreaterThan(200)
      expect(screen.getByTestId('dlq-load-more').getBoundingClientRect().bottom).toBeLessThanOrEqual(leftBox.bottom + 1)

      const right = screen.getByTestId('dlq-detail-pane')
      right.scrollTop = right.scrollHeight
      await userEvent.click(screen.getAllByTestId('recovery-item-badge')[1]!)
      const drawer = await waitFor(() => {
        const element = document.querySelector('.we-recovery-item-drawer')
        expect(element).not.toBeNull()
        return element!
      })
      expect(right).toContainElement(drawer as HTMLElement)
      expect(left.getBoundingClientRect().height).toBe(leftBox.height)
      expect(list.clientHeight).toBe(listHeight)
      await waitFor(() => expect(drawer.getBoundingClientRect().top).toBeGreaterThanOrEqual(right.getBoundingClientRect().top))
    } finally { await page.viewport(1024, 768) }
  })

  it('keeps keyboard focus, selected failure and bulk selection across background refresh', async () => {
    mountQueue()
    const row = await screen.findByTestId('dlq-row-shipment')
    await userEvent.click(screen.getByTestId('dlq-select-toggle'))
    const checkbox = screen.getByTestId('dlq-select-row-shipment')
    await userEvent.click(checkbox)
    expect(checkbox).toHaveFocus()
    const reads = () => vi.mocked(api).mock.calls.filter(([path]) => path.startsWith('/dlq/queue')).length
    const before = reads()
    queueRows = [...rows].reverse().map(row => ({ ...row }))
    act(() => invalidateTags([PLATFORM_TAG]))
    await waitFor(() => expect(reads()).toBeGreaterThan(before))
    expect(checkbox).toHaveFocus()
    expect(checkbox).toBeChecked()
    expect(row).toHaveAttribute('aria-selected', 'true')
    const search = screen.getByTestId('dlq-search')
    await userEvent.click(search)
    await userEvent.keyboard('{Tab}')
    expect(screen.getByRole('radio', { name: /^Open/ })).toHaveFocus()
    await userEvent.keyboard('j')
    expect(screen.getByRole('radio', { name: /^Open/ })).toHaveFocus()
    await userEvent.keyboard('{ArrowRight}')
    const retried = screen.getByRole('radio', { name: /^Retried/ })
    expect(retried).toHaveFocus()
    expect(retried).toBeChecked()
    await waitFor(() => expect(vi.mocked(api).mock.calls.at(-1)?.[0]).toContain('status=replayed'))
    await userEvent.keyboard('{Tab}')
    expect(screen.getByLabelText('Recovery owner')).toHaveFocus()
    await userEvent.keyboard('{Tab}')
    expect(screen.getByLabelText('Recovery severity')).toHaveFocus()
    await userEvent.keyboard('{Tab}')
    expect(screen.getByLabelText('Sort')).toHaveFocus()
    await userEvent.click(search)
    await userEvent.keyboard('j')
    expect(search).toHaveValue('j')
    expect(search).toHaveFocus()
  })

  it('focuses the exact off-page failure instead of the previously clicked row', async () => {
    initI18n('en')
    queueRows = [rows[0]!]
    mountQueue()
    await userEvent.click(await screen.findByTestId('dlq-row-invoice'))

    act(() => requestRecoveryQueueFocus('shipment'))
    await waitFor(() => expect(document.querySelector('section.detail-box .we-dlq-detail__head strong'))
      .toHaveTextContent(rows[1]!.nodeId))
    await waitFor(() => expect(document.querySelector('section.detail-box')).toHaveFocus())
    expect(screen.getByTestId('recovery-queue')).not.toHaveFocus()

    act(() => requestRecoveryQueueFocus('gone'))
    await waitFor(() => expect(screen.getByTestId('dlq-requested-not-found')).toHaveFocus())
    expect(document.querySelector('section.detail-box .we-dlq-detail__head strong')).toBeNull()
  })
})
