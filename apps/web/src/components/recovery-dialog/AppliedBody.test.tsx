/**
 * Tests for the Applied-step success ribbon — focused on the Q-13
 * cluster-recovery celebration line: present with count + formatted summed
 * downtime on a hit, absent (never a NaN string) when `downtimeEndedMs` is
 * missing/0, and never rendered on the single-replay path.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AppliedBody } from './AppliedBody'
import type { ClusterApplyResult } from './types'

function renderCluster(cluster: ClusterApplyResult) {
  return render(<AppliedBody cluster={cluster} />)
}

describe('<AppliedBody /> cluster celebration (Q-13)', () => {
  it('renders count + summed downtime when the apply ended real downtime', () => {
    renderCluster({ replayed: 3, failed: 0, errors: [], downtimeEndedMs: 3_600_000 })

    const line = screen.getByTestId('cluster-recovered-line')
    // 3 replays, 1h of summed downtime — the plural `_other` copy.
    expect(line).toHaveTextContent('Recovered 3 cascading failures · 1h of downtime ended')
  })

  it('uses the singular copy for one replayed member', () => {
    renderCluster({ replayed: 1, failed: 0, errors: [], downtimeEndedMs: 90_000 })

    expect(screen.getByTestId('cluster-recovered-line')).toHaveTextContent(
      'Recovered 1 failure · 1m of downtime ended',
    )
  })

  it('renders NO line when downtimeEndedMs is absent (legacy server) or 0', () => {
    const { unmount } = renderCluster({ replayed: 2, failed: 0, errors: [] })
    expect(screen.queryByTestId('cluster-recovered-line')).toBeNull()
    unmount()

    renderCluster({ replayed: 2, failed: 0, errors: [], downtimeEndedMs: 0 })
    expect(screen.queryByTestId('cluster-recovered-line')).toBeNull()
  })

  it('renders NO line when nothing replayed, and never on the single-replay path', () => {
    const { unmount } = renderCluster({ replayed: 0, failed: 2, errors: [], downtimeEndedMs: 5_000 })
    expect(screen.queryByTestId('cluster-recovered-line')).toBeNull()
    unmount()

    render(<AppliedBody runId="run-12345678" />)
    expect(screen.queryByTestId('cluster-recovered-line')).toBeNull()
  })
})
