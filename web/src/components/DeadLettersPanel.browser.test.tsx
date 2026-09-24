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
    mountQueue()
    try {
      const row = await screen.findByTestId('dlq-row-invoice')
      expect(row.getBoundingClientRect().top).toBeLessThan(330)
      // 640 CSS pixels exercises reflow of a 1280px-wide window at 200% zoom,
      // not screen-reader or physical browser-zoom qualification.
      for (const width of [1280, 640, 390]) {
        await page.viewport(width, 800)
        const queue = screen.getByTestId('recovery-queue')
        expect(queue.scrollWidth).toBeLessThanOrEqual(queue.clientWidth + 1)
        for (const id of ['dlq-search', 'dlq-filter', 'dlq-severity-filter', 'dlq-sort']) {
          const input = document.getElementById(id)!
          expect(input.getBoundingClientRect().width).toBeGreaterThan(80)
          expect(input.getBoundingClientRect().right).toBeLessThanOrEqual(width)
          expect(input).toHaveAccessibleName()
        }
        expect(row.getBoundingClientRect().height).toBe(54)
        await page.getByTestId('recovery-queue').screenshot({ path: `../../test-results/queue-${locale}-${width}.png` })
      }
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
    expect(screen.getByLabelText('Failure status')).toHaveFocus()
    await userEvent.keyboard('{Tab}')
    expect(screen.getByTestId('dlq-owner-all')).toHaveFocus()
    await userEvent.keyboard('{Tab}')
    expect(screen.getByTestId('dlq-owner-mine')).toHaveFocus()
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
    await waitFor(() => expect(document.querySelector('section.detail-box > .split-row strong'))
      .toHaveTextContent(rows[1]!.nodeId))
    await waitFor(() => expect(document.querySelector('section.detail-box')).toHaveFocus())
    expect(screen.getByTestId('recovery-queue')).not.toHaveFocus()

    act(() => requestRecoveryQueueFocus('gone'))
    await waitFor(() => expect(screen.getByTestId('dlq-requested-not-found')).toHaveFocus())
    expect(document.querySelector('section.detail-box > .split-row strong')).toBeNull()
  })
})
