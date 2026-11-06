import { render, screen, waitFor } from '@testing-library/react'
import { page } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { initI18n } from '../i18n'
import type { Credential } from '../types'
import { ConnectionsPanel } from './ConnectionsPanel'
import '../styles/foundations.css'

vi.mock('../api', () => ({ api: vi.fn() }))

const credentials = Array.from({ length: 60 }, (_, index): Credential => ({
  id: `cred-${index}`,
  name: `connection-${index}`,
  kind: 'postgres',
  storage: 'managed',
}))

beforeEach(() => {
  initI18n('en')
  vi.mocked(api).mockResolvedValue({ managedStorageAvailable: true, credentials: [] })
})

describe('Connections table in Chromium', () => {
  it('scrolls by itself on both axes with the row height the window math assumes', async () => {
    await page.viewport(1280, 720)
    render(
      <div style={{ width: 700 }}>
        <ConnectionsPanel
          credentials={credentials}
          workflows={[]}
          onCreateCredential={vi.fn(async () => true)}
          onRevokeCredential={vi.fn(async () => true)}
          canWrite
        />
      </div>,
    )

    const list = screen.getByTestId('connections-virtual-list')
    await waitFor(() => expect(list.querySelectorAll('tbody th').length).toBeLessThan(60))
    expect(list.querySelector('tbody tr:not([aria-hidden])')!.getBoundingClientRect().height).toBe(48)
    expect(list.scrollHeight).toBe(34 + 60 * 48)
    expect(list.scrollWidth).toBeGreaterThan(list.clientWidth)

    list.scrollTop = 1200
    await screen.findByRole('rowheader', { name: 'connection-25' })
    expect(list.scrollTop).toBe(1200)
    expect(screen.queryByRole('rowheader', { name: 'connection-0' })).toBeNull()

    const actions = screen.getAllByTestId('connections-rotate')[0]!.closest('td')!
    expect(actions.getBoundingClientRect().right).toBeLessThanOrEqual(list.getBoundingClientRect().right)
  })
})
