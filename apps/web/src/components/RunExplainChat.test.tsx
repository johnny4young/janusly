import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RunExplainChat } from './RunExplainChat'
import { api } from '../api'

vi.mock('../api', () => ({
  api: vi.fn(),
}))

describe('<RunExplainChat />', () => {
  it('shows fallback mode returned by explain-run', async () => {
    vi.mocked(api).mockResolvedValueOnce({
      mode: 'fallback',
      answer: 'Run summary: all steps finished.',
    })

    render(<RunExplainChat runId="run_1" />)

    fireEvent.change(screen.getByPlaceholderText(/Ask:/), {
      target: { value: 'What happened?' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Ask Janusly' }))

    await waitFor(() => {
      expect(screen.getByText('Run summary: all steps finished.')).toBeInTheDocument()
    })
    expect(screen.getByText('Local mode')).toBeInTheDocument()
  })

  it('lets users pick a plain-language starter question', () => {
    render(<RunExplainChat runId="run_1" />)

    fireEvent.click(screen.getByRole('button', { name: 'What should I check next?' }))

    expect(screen.getByPlaceholderText(/Ask:/)).toHaveValue('What should I check next?')
  })

  it('exposes the reply list as an aria-live region', () => {
    const { container } = render(<RunExplainChat runId="run_1" />)
    expect(container.querySelector('.panel-list')).toHaveAttribute('aria-live', 'polite')
  })

  it('surfaces a transport error as an assertive alert, not a normal answer', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('network down'))
    render(<RunExplainChat runId="run_1" />)

    fireEvent.change(screen.getByPlaceholderText(/Ask:/), { target: { value: 'What happened?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ask Janusly' }))

    await waitFor(() => {
      expect(screen.getByTestId('run-explain-error')).toHaveTextContent('network down')
    })
    expect(screen.getByTestId('run-explain-error')).toHaveAttribute('role', 'alert')
  })
})
