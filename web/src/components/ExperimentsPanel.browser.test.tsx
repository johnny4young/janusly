import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'

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

    await screen.findByRole('option', { name: 'Accepted recoveries · 4 examples' })
    const button = screen.getByRole('button', { name: 'Run comparison' })
    const rect = button.getBoundingClientRect()
    expect(rect.height).toBeGreaterThan(0)
    expect(getComputedStyle(button).display).not.toBe('none')

    const tiles = ['dataset', 'arms', 'run'].map((id) => screen.getByTestId(`experiment-step-${id}`))
    const tops = tiles.map((tile) => tile.getBoundingClientRect().top)
    expect(new Set(tops).size).toBe(1)
    for (const tile of tiles) {
      const style = getComputedStyle(tile)
      expect(style.borderLeftWidth).toBe(style.borderRightWidth)
    }
    expect(getComputedStyle(tiles[0]!).backgroundColor).not.toBe(getComputedStyle(tiles[1]!).backgroundColor)
    expect(screen.getByTestId('experiment-run-blocker')).toHaveTextContent('Step 2')

    await page.viewport(375, 812)
    const inputs = ['experiment-dataset-name', 'experiment-dataset-description'].map((id) => document.getElementById(id)!.getBoundingClientRect())
    expect(inputs[1]!.top).toBeGreaterThan(inputs[0]!.bottom)
  })
})
