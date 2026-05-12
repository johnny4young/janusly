import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  RunComparisonView,
  type RunComparisonNode,
  type RunComparisonPayload,
} from './RunComparisonView'

function side(overrides: Partial<RunComparisonNode['base']> = {}): RunComparisonNode['base'] {
  return {
    status: 'succeeded',
    latencyMs: 100,
    costUsd: 0.0001,
    tokens: 12,
    output: { ok: true },
    errorJson: null,
    ...overrides,
  }
}

function payload(perNode: RunComparisonNode[]): RunComparisonPayload {
  return {
    baseRun: { id: 'src-run', status: 'failed', replayMode: null, parentRunId: null, createdAt: null },
    replayRun: { id: 'replay-run', status: 'succeeded', replayMode: 'validation', parentRunId: 'src-run', createdAt: null },
    perNode,
  }
}

describe('<RunComparisonView />', () => {
  it('renders an empty-state message when no nodes ran in either run', () => {
    render(<RunComparisonView payload={payload([])} />)
    expect(screen.getByRole('status')).toHaveTextContent(/no nodes ran/i)
  })

  it('classifies an identical-output row as Equal', () => {
    const node: RunComparisonNode = {
      nodeId: 'fetch',
      base: side(),
      replay: side(),
    }
    render(<RunComparisonView payload={payload([node])} />)

    const row = screen.getByTestId('comparison-row-fetch')
    expect(row.className).toMatch(/equal/)
    expect(within(row).getByText('Equal')).toBeInTheDocument()
  })

  it('classifies a different-output row as Changed', () => {
    const node: RunComparisonNode = {
      nodeId: 'fetch',
      base: side({ output: { ok: true } }),
      replay: side({ output: { ok: false } }),
    }
    render(<RunComparisonView payload={payload([node])} />)

    const row = screen.getByTestId('comparison-row-fetch')
    expect(row.className).toMatch(/changed/)
    expect(within(row).getByText('Changed')).toBeInTheDocument()
  })

  it('handles a node present only in base as Only base', () => {
    const node: RunComparisonNode = {
      nodeId: 'only-here',
      base: side(),
      replay: { status: 'missing', latencyMs: null, costUsd: null, tokens: 0, output: null, errorJson: null },
    }
    render(<RunComparisonView payload={payload([node])} />)

    const row = screen.getByTestId('comparison-row-only-here')
    expect(within(row).getByText('Only base')).toBeInTheDocument()
    // The missing-status pill renders an em dash.
    expect(within(row).getByLabelText('missing')).toBeInTheDocument()
  })

  it('treats key-order-shuffled outputs as Equal (stable stringify)', () => {
    const node: RunComparisonNode = {
      nodeId: 'order',
      base: side({ output: { a: 1, b: 2 } }),
      replay: side({ output: { b: 2, a: 1 } }),
    }
    render(<RunComparisonView payload={payload([node])} />)
    expect(within(screen.getByTestId('comparison-row-order')).getByText('Equal')).toBeInTheDocument()
  })

  it('formats latency delta with sign + unit and a near-zero ≈ marker', () => {
    const nodes: RunComparisonNode[] = [
      { nodeId: 'a', base: side({ latencyMs: 100 }), replay: side({ latencyMs: 250 }) },
      { nodeId: 'b', base: side({ latencyMs: 1000 }), replay: side({ latencyMs: 1000 }) },
    ]
    render(<RunComparisonView payload={payload(nodes)} />)

    const aRow = screen.getByTestId('comparison-row-a')
    expect(aRow.textContent).toContain('+150ms')

    const bRow = screen.getByTestId('comparison-row-b')
    expect(bRow.textContent).toContain('≈')
  })

  it('renders cost delta `—` when both sides have null cost', () => {
    const node: RunComparisonNode = {
      nodeId: 'no-llm',
      base: side({ costUsd: null }),
      replay: side({ costUsd: null }),
    }
    render(<RunComparisonView payload={payload([node])} />)
    const row = screen.getByTestId('comparison-row-no-llm')
    // Last cell is the cost delta.
    const cells = row.querySelectorAll('td')
    expect(cells[cells.length - 1]).toHaveTextContent('—')
  })

  it('summarizes changed/total nodes and total cost/latency at the top', () => {
    const nodes: RunComparisonNode[] = [
      { nodeId: 'equal', base: side(), replay: side() },
      { nodeId: 'changed', base: side({ output: { v: 1 } }), replay: side({ output: { v: 2 } }) },
    ]
    render(<RunComparisonView payload={payload(nodes)} />)

    const summary = screen.getByLabelText('Replay comparison summary')
    expect(summary.textContent).toMatch(/1\s*of\s*2.*node/i)
    expect(summary).toHaveTextContent(/succeeded/)
  })
})
