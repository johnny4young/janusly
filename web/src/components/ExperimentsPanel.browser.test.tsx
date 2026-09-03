import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { ExperimentsPanel } from './ExperimentsPanel'

vi.mock('../api', () => ({ api: vi.fn() }))

describe('<ExperimentsPanel /> (browser smoke)', () => {
  it('renders its responsive comparison controls in real Chromium', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/experiments') return { experiments: [] }
      if (path === '/eval/datasets') return { datasets: [{ id: 'dataset-1', name: 'Accepted recoveries', description: '', exampleCount: 4 }] }
      return {}
    })

    render(<ExperimentsPanel />)

    const button = await screen.findByRole('button', { name: 'Run comparison' })
    const rect = button.getBoundingClientRect()
    expect(rect.height).toBeGreaterThan(0)
    expect(getComputedStyle(button).display).not.toBe('none')
    expect(screen.getByLabelText('Evaluation dataset')).toBeInTheDocument()
  })
})
