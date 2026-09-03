import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RecoveryItemDrawer, type RecoveryItemDrawerData } from './RecoveryItemDrawer'

// The drawer fetches `/credentials` + `/recovery/items/:id` on mount (handoff
// section). Stub both so the mount effect resolves without a real network call.
vi.mock('../api', () => ({
  api: vi.fn(async (path?: unknown) => {
    if (path === '/credentials') return []
    return { item: null, handoffs: [] }
  }),
  downloadFromApi: vi.fn(),
}))

function makeItem(overrides: Partial<RecoveryItemDrawerData> = {}): RecoveryItemDrawerData {
  return {
    id: 'ri_1',
    deadLetterId: 'dl_1',
    owner: 'alice',
    severity: 'p2',
    status: 'acknowledged',
    slaTargetAtIso: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    resolutionReason: null,
    comments: [],
    occurrenceCount: 1,
    lastOccurredAtIso: new Date().toISOString(),
    ...overrides,
  }
}

describe('<RecoveryItemDrawer /> focus management', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('moves focus into the drawer on open and closes on Escape', async () => {
    const onClose = vi.fn()
    render(<RecoveryItemDrawer item={makeItem()} onClose={onClose} />)

    const drawer = screen.getByTestId('recovery-item-drawer')
    await waitFor(() => expect(drawer).toHaveFocus())

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('lets a nested modal own Escape instead of closing the drawer', async () => {
    const onClose = vi.fn()
    render(<RecoveryItemDrawer item={makeItem()} onClose={onClose} />)
    await waitFor(() => expect(screen.getByTestId('recovery-item-drawer')).toHaveFocus())

    // A nested modal (e.g. the evidence ReportDeliveryDialog) is layered on top.
    const modal = document.createElement('div')
    modal.setAttribute('aria-modal', 'true')
    document.body.appendChild(modal)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled() // the modal closes; the drawer stays

    modal.remove()
  })

  it('restores focus to the trigger (the badge) when the drawer unmounts', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    expect(trigger).toHaveFocus()

    const { unmount } = render(<RecoveryItemDrawer item={makeItem()} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('recovery-item-drawer')).toHaveFocus())

    // Restore is synchronous (StrictMode-safe) — no requestAnimationFrame to flush.
    unmount()
    expect(trigger).toHaveFocus()
    trigger.remove()
  })
})
