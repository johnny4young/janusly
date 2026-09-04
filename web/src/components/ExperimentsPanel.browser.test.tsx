import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { ExperimentsPanel } from './ExperimentsPanel'

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
