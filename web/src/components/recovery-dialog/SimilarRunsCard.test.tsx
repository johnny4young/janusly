import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../api'
import { initI18n } from '../../i18n'
import { SimilarRunsCard } from './SimilarRunsCard'

vi.mock('../../api', () => ({ api: vi.fn() }))

describe('<SimilarRunsCard />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    initI18n('en')
  })

  it('renders nothing while memory is disabled or the search is empty', async () => {
    vi.mocked(api).mockResolvedValue({ enabled: false, entries: [] })
    const { container } = render(<SimilarRunsCard failureSignature="http_error timeout" />)
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalled())
    expect(container.querySelector('[data-testid="recovery-similar-runs"]')).toBeNull()
  })

  it('renders nothing when the search itself fails', async () => {
    vi.mocked(api).mockRejectedValue(new Error('offline'))
    const { container } = render(<SimilarRunsCard failureSignature="http_error timeout" />)
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalled())
    expect(container.querySelector('[data-testid="recovery-similar-runs"]')).toBeNull()
  })

  it('never queries with an empty signature', () => {
    render(<SimilarRunsCard failureSignature="   " />)
    expect(vi.mocked(api)).not.toHaveBeenCalled()
  })

  it('lists recalled failures with their similarity, capped at three', async () => {
    vi.mocked(api).mockResolvedValue({
      enabled: true,
      entries: [
        { id: 'm1', content: 'Workflow "Refunds" failed. Failed at node "fetch": http_error', similarity: 0.91, runId: 'run-1' },
        { id: 'm2', content: 'Workflow "Refunds" failed at fetch again', similarity: 0.84 },
        { id: 'm3', content: 'Workflow "Invoices" failed at post', similarity: 0.62 },
        { id: 'm4', content: 'must not render (over the cap)', similarity: 0.5 },
      ],
    })
    render(<SimilarRunsCard failureSignature="http_error fetch" />)
    await screen.findByTestId('recovery-similar-runs')
    expect(vi.mocked(api).mock.calls[0][0]).toBe('/runs/semantic-search?q=http_error%20fetch')
    expect(screen.getByText('91% match')).toBeInTheDocument()
    expect(screen.queryByText('must not render (over the cap)')).toBeNull()
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })
})
