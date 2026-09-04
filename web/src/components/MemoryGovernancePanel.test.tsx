import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { MemoryGovernancePanel } from './MemoryGovernancePanel'

vi.mock('../api', () => {
  const module = ({ api: vi.fn() })
  return {
    ...module,
    // Typed reads route through contractApi; delegate to the same mock so the
    // path-keyed expectations below keep working.
    contractApi: (_operation: string, path: string, _request: unknown, options?: RequestInit) =>
      options === undefined ? module.api(path) : module.api(path, options),
  }
})

describe('<MemoryGovernancePanel />', () => {
  beforeEach(() => vi.mocked(api).mockReset())

  it('shows both consent gates when memory is effective', async () => {
    vi.mocked(api).mockResolvedValue({
      enabled: true,
      processEnabled: true,
      tenantEnabled: true,
      purge: { status: 'none', scheduledFor: null },
    })
    render(<MemoryGovernancePanel />)

    expect(await screen.findByText('Persistent memory is active')).toBeInTheDocument()
    expect(screen.getByText('No memory deletion is scheduled.')).toBeInTheDocument()
    expect(screen.getAllByText('On')).toHaveLength(2)
  })

  it('surfaces a scheduled purge after tenant consent is revoked', async () => {
    vi.mocked(api).mockResolvedValue({
      enabled: false,
      processEnabled: true,
      tenantEnabled: false,
      purge: { status: 'scheduled', scheduledFor: '2026-07-21T12:00:00.000Z' },
    })
    render(<MemoryGovernancePanel />)

    expect(await screen.findByText('Persistent memory is off')).toBeInTheDocument()
    expect(screen.getByText(/Memory deletion is scheduled for/)).toBeInTheDocument()
  })

  it('does not render a stale state for malformed responses', async () => {
    vi.mocked(api).mockResolvedValue({ enabled: true, purge: { status: 'none' } })
    render(<MemoryGovernancePanel />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Memory governance status is unavailable')
  })
})
