import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { initI18n } from '../i18n'
import { useWorkflowStore } from '../store'
import { WorkflowStatusPageCard } from './WorkflowStatusPageCard'

vi.mock('../api', () => ({ api: vi.fn() }))

const TOKEN = 'a'.repeat(64)

describe('<WorkflowStatusPageCard />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    initI18n('en')
    useWorkflowStore.setState({ currentWorkflowId: 'wf-status', currentWorkflowSaved: true })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  it('renders nothing for non-admins (probe 403) and for unsaved drafts', async () => {
    vi.mocked(api).mockRejectedValue(Object.assign(new Error('forbidden'), { statusCode: 403 }))
    const { container, rerender } = render(<WorkflowStatusPageCard />)
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalled())
    expect(container.querySelector('[data-testid="workflow-status-page-card"]')).toBeNull()

    vi.mocked(api).mockClear()
    useWorkflowStore.setState({ currentWorkflowSaved: false })
    rerender(<WorkflowStatusPageCard />)
    expect(vi.mocked(api)).not.toHaveBeenCalled()
  })

  it('offers enable when disabled, then shows the minted public link', async () => {
    vi.mocked(api).mockResolvedValueOnce({ enabled: false })
    render(<WorkflowStatusPageCard />)
    const enable = await screen.findByRole('button', { name: /Enable status page/ })

    vi.mocked(api).mockResolvedValueOnce({ enabled: true, token: TOKEN, path: `/public/status/${TOKEN}` })
    fireEvent.click(enable)
    await screen.findByRole('button', { name: /Rotate link/ })
    expect(vi.mocked(api).mock.calls[1]).toEqual([
      '/workflows/wf-status/status-page', { method: 'POST' },
    ])
    expect(screen.getByText(new RegExp(TOKEN))).toBeInTheDocument()
  })

  it('disable revokes and returns to the enable affordance', async () => {
    vi.mocked(api).mockResolvedValueOnce({ enabled: true, token: TOKEN, path: `/public/status/${TOKEN}` })
    render(<WorkflowStatusPageCard />)
    const disable = await screen.findByRole('button', { name: /Disable/ })
    vi.mocked(api).mockResolvedValueOnce({ enabled: false })
    fireEvent.click(disable)
    await screen.findByRole('button', { name: /Enable status page/ })
  })

  it('keeps transient probe failures visible and retries', async () => {
    vi.mocked(api).mockRejectedValueOnce(Object.assign(new Error('unavailable'), { statusCode: 503 }))
    render(<WorkflowStatusPageCard />)
    const retry = await screen.findByRole('button', { name: /Retry status page check/ })
    vi.mocked(api).mockResolvedValueOnce({ enabled: false })
    fireEvent.click(retry)
    await screen.findByRole('button', { name: /Enable status page/ })
  })

  it('manages a persisted page without recovering its bearer link', async () => {
    vi.mocked(api).mockResolvedValueOnce({ enabled: true, createdAt: new Date().toISOString() })
    render(<WorkflowStatusPageCard />)
    expect(await screen.findByText(/cannot be shown again/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Copy link/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Rotate link/ })).toBeInTheDocument()
  })
})
