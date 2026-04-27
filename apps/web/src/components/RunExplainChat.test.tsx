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
})
