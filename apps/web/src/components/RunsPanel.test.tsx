/**
 * Regression tests for the RunsPanel "Needs attention" card: a failed node
 * must surface WHY it failed — the
 * error message plus attempt count + duration read off the run_nodes row —
 * instead of just a bare "Retry <id>" button.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RunsPanel } from './RunsPanel'
import type { RunNode } from '../types'

function renderPanel(runNodes: RunNode[]) {
  const props: Parameters<typeof RunsPanel>[0] = {
    runs: [],
    usage: {},
    runNodes,
    activeRunId: 'run-1',
    onOpenRun: vi.fn(),
    onRefreshPlatform: vi.fn(),
    onApproveNode: vi.fn(),
    onSubmitHumanForm: vi.fn(),
    onReplayNode: vi.fn(),
    onCancelActiveRun: vi.fn(),
    onReplayDeadLetter: vi.fn(),
    onResolveDeadLetter: vi.fn(),
  }
  return { ...render(<RunsPanel {...props} />), props }
}

const failedNode: RunNode = {
  nodeId: 'http_call',
  status: 'failed',
  errorJson: { message: 'HTTP 500 from https://api.example.com/orders' },
  attempts: 3,
  startedAt: '2026-07-09T10:00:00.000Z',
  finishedAt: '2026-07-09T10:00:42.000Z',
}

describe('<RunsPanel /> failed-node card', () => {
  it('renders the error message and attempt · duration meta for a failed node', () => {
    renderPanel([failedNode])

    const card = screen.getByTestId('failed-node-http_call')
    expect(card).toBeInTheDocument()
    expect(card).toHaveTextContent('HTTP 500 from https://api.example.com/orders')
    // Meta line: "attempt 3 · 42s".
    expect(card).toHaveTextContent('attempt 3')
    expect(card).toHaveTextContent('42s')
  })

  it('still renders the retry action and wires it to onReplayNode', () => {
    const { props } = renderPanel([failedNode])

    fireEvent.click(screen.getByText('Retry http_call'))
    expect(props.onReplayNode).toHaveBeenCalledWith('http_call')
  })

  it('omits the meta line when the row carries no attempts or timestamps', () => {
    renderPanel([{ nodeId: 'bare', status: 'failed', errorJson: { message: 'boom' } }])

    const card = screen.getByTestId('failed-node-bare')
    expect(card).toHaveTextContent('boom')
    expect(card).not.toHaveTextContent('attempt')
  })

  it('formats a multi-minute duration as `Nm Ns`', () => {
    renderPanel([{
      ...failedNode,
      nodeId: 'slow',
      startedAt: '2026-07-09T10:00:00.000Z',
      finishedAt: '2026-07-09T10:01:20.000Z',
    }])

    expect(screen.getByTestId('failed-node-slow')).toHaveTextContent('1m 20s')
  })
})
