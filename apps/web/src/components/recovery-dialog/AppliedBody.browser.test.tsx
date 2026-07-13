/**
 * Real-Chromium render of the Applied-step ribbon and cluster celebration —
 * the browser-mode counterpart of the jsdom unit tests,
 * proving the line lays out and reads correctly in an actual renderer
 * (the live-smoke dialog state is transient; this pins the visual contract).
 */

import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { AppliedBody } from './AppliedBody'

describe('<AppliedBody /> cluster celebration (browser smoke)', () => {
  it('renders the summed-downtime line under the cluster ribbon in real Chromium', async () => {
    const { getByTestId } = render(
      <AppliedBody cluster={{ replayed: 2, failed: 0, errors: [], downtimeEndedMs: 4_560_000 }} />,
    )

    const line = getByTestId('cluster-recovered-line')
    expect(line.textContent).toBe('Recovered 2 cascading failures · 1h 16m of downtime ended')
    // Visible and laid out (a real box, not display:none) in the actual renderer.
    const rect = line.getBoundingClientRect()
    expect(rect.height).toBeGreaterThan(0)
    expect(getComputedStyle(line).display).not.toBe('none')
    const burst = getByTestId('celebration-burst')
    expect(burst.children).toHaveLength(10)
    expect(getComputedStyle(burst.firstElementChild as Element).animationName).toContain('we-celebration-burst')
  })
})
