import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { WorkflowReadinessBadge } from './WorkflowReadinessBadge'

vi.mock('../api', () => ({
  api: vi.fn(),
}))

describe('<WorkflowReadinessBadge />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
  })

  it('shows an unavailable state when the readiness endpoint fails', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('service down'))

    render(<WorkflowReadinessBadge />)

    await waitFor(() => {
      expect(screen.getByText('Readiness unavailable')).toBeInTheDocument()
    })
  })

  it('shows the green ready state when the endpoint returns pass', async () => {
    vi.mocked(api).mockResolvedValueOnce({ status: 'pass', issues: [] })

    render(<WorkflowReadinessBadge />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Production readiness: Production Ready' })).toBeInTheDocument()
    })
  })
})
