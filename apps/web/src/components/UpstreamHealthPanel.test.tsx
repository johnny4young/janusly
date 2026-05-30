import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { useWorkflowStore } from '../store'
import { UpstreamHealthPanel } from './UpstreamHealthPanel'

vi.mock('../api', () => ({
  api: vi.fn(),
}))

beforeEach(() => {
  vi.mocked(api).mockReset()
  useWorkflowStore.setState({ orgId: 'default', platformVersion: 0 })
})

describe('<UpstreamHealthPanel />', () => {
  it('renders the empty state when no sources exist', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/upstream/sources') return { sources: [] }
      return null
    })

    render(<UpstreamHealthPanel />)

    await waitFor(() => {
      expect(screen.getByTestId('upstream-health-empty')).toBeInTheDocument()
    })
  })

  it('renders a degraded source with its status chip + provider', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/upstream/sources') {
        return {
          sources: [
            {
              id: 's1',
              name: 'stripe-prod',
              kind: 'statuspage_io',
              url: 'https://status.stripe.com/api/v2/status.json',
              expectedComponents: ['API'],
              checkIntervalSeconds: 60,
              enabled: true,
              lastStatus: 'major_outage',
              lastDegraded: true,
              lastCheckedAt: new Date().toISOString(),
              lastErrorReason: null,
            },
          ],
        }
      }
      return null
    })

    render(<UpstreamHealthPanel />)

    await waitFor(() => {
      expect(screen.getByText('stripe-prod')).toBeInTheDocument()
    })
    expect(screen.getByText('Statuspage.io')).toBeInTheDocument()
    expect(screen.getByText('Major outage')).toBeInTheDocument()
  })

  it('surfaces the fail-open error reason chip when the last poll could not reach the feed', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/upstream/sources') {
        return {
          sources: [
            {
              id: 's2',
              name: 'github',
              kind: 'http_probe',
              url: 'https://www.githubstatus.com',
              expectedComponents: [],
              checkIntervalSeconds: 120,
              enabled: true,
              lastStatus: null,
              lastDegraded: false,
              lastCheckedAt: new Date().toISOString(),
              lastErrorReason: 'unreachable',
            },
          ],
        }
      }
      return null
    })

    render(<UpstreamHealthPanel />)

    await waitFor(() => {
      expect(screen.getByText('github')).toBeInTheDocument()
    })
    expect(screen.getByText('Feed unreachable')).toBeInTheDocument()
  })

  it('shows the create form and only shows the components field for statuspage kinds', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/upstream/sources') return { sources: [] }
      return null
    })

    render(<UpstreamHealthPanel />)

    fireEvent.click(await screen.findByRole('button', { name: /Add source/i }))
    expect(screen.getByTestId('upstream-source-form')).toBeInTheDocument()
    // statuspage_io is the default kind → the components field is shown.
    expect(screen.getByText('Watched components')).toBeInTheDocument()

    // Switch to http_probe → the components field disappears.
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'http_probe' } })
    expect(screen.queryByText('Watched components')).not.toBeInTheDocument()
  })

  it('POSTs the new source on save', async () => {
    const apiMock = vi.mocked(api)
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/upstream/sources') return { sources: [] }
      return null
    })

    render(<UpstreamHealthPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /Add source/i }))

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'stripe-prod' } })
    fireEvent.change(screen.getByLabelText('Status feed URL'), {
      target: { value: 'https://status.stripe.com/api/v2/status.json' },
    })

    apiMock.mockClear()
    apiMock.mockResolvedValue({ source: { id: 's1' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }))

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        '/upstream/sources',
        expect.objectContaining({ method: 'POST' }),
      )
    })
  })
})
