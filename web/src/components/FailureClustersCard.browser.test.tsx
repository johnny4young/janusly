/**
 * Real-Chromium regression smoke for the recovery dialog lifecycle.
 * A successful cluster apply schedules a platform refresh; the refreshed
 * cluster payload can be empty because every member was just recovered.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { __resetBumpCoalesceForTests, useWorkflowStore } from '../store'
import { FailureClustersCard } from './FailureClustersCard'

vi.mock('../api', () => ({ api: vi.fn() }))

describe('<FailureClustersCard /> recovery lifecycle (browser smoke)', () => {
  beforeEach(() => {
    __resetBumpCoalesceForTests()
    useWorkflowStore.setState({ platformVersion: 0, toasts: [] })
    vi.mocked(api).mockReset()
  })

  afterEach(() => {
    __resetBumpCoalesceForTests()
  })

  it('keeps the applied dialog visible after its empty cluster refresh', async () => {
    const cluster = {
      signature: 'HTTP 502 on fetch',
      category: 'http_error',
      frequency: 2,
      affectedWorkflows: [{ workflowId: 'wf-recovery', workflowName: 'Recovery Flow', count: 2 }],
      firstSeen: '2026-07-01T10:00:00.000Z',
      lastSeen: '2026-07-01T11:00:00.000Z',
      suggestedOwner: 'workflow_author',
      samples: [{ source: 'dead_letter', id: 'dlq-recovery', runId: 'run-recovery-12345678' }],
    }
    const dlq = {
      id: 'dlq-recovery',
      runId: 'run-recovery-12345678',
      nodeId: 'fetch',
      attempt: 3,
      status: 'open',
      workflowJson: {
        dslVersion: '1.0',
        nodes: [{ id: 'fetch', type: 'http', config: { url: 'https://example.test' } }],
        edges: [],
      },
      nodeJson: { id: 'fetch', type: 'http', config: { url: 'https://example.test' } },
      errorJson: { message: 'upstream 502' },
    }
    const delta = {
      workflowId: 'wf-recovery',
      afterVersion: 2,
      windowDays: 1,
      hasEnoughData: false,
      before: { score: 80, status: 'healthy', signals: { p95LatencyMs: null, totalRuns: 0, totalCostUsd: 0 } },
      after: { score: 80, status: 'healthy', signals: { p95LatencyMs: null, totalRuns: 2, totalCostUsd: 0 } },
      delta: null,
      recentRunsAgainstAfter: { totalRuns: 2, succeeded: 2, failed: 0, running: 0 },
      sameFailureSinceApply: { count: 0, sampleDeadLetterIds: [], priorSignature: 'HTTP 502 on fetch' },
      priorVersion: null,
    }
    const initialClusters = { clusters: [cluster], totalSamples: 2, windowDays: 30 }
    const refreshedClusters = { clusters: [], totalSamples: 0, windowDays: 30 }
    let clusterRequestCount = 0
    let resolveClusterRefresh: ((payload: unknown) => void) | undefined

    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/dlq/clusters') {
        clusterRequestCount += 1
        if (clusterRequestCount === 1) return initialClusters
        return new Promise<unknown>((resolve) => {
          resolveClusterRefresh = resolve
        })
      }
      if (path.startsWith('/dlq/cluster-members?')) return { deadLetterIds: ['dlq-recovery', 'dlq-peer'], total: 2, capped: false }
      if (path === '/dlq?id=dlq-recovery') return dlq
      if (path === '/ai/patch-workflow') {
        return {
          mode: 'ai',
          suggestedWorkflow: {
            dslVersion: '1.0',
            nodes: [{ id: 'fetch', type: 'http', config: { url: 'https://example.test', retry: { maxAttempts: 3 } } }],
            edges: [],
          },
          rationale: 'Retry the transient response.',
        }
      }
      if (path === '/dlq/validate-fix') return { runId: 'validation-cluster' }
      if (path.startsWith('/run?runId=validation-cluster')) {
        return { run: { id: 'validation-cluster', status: 'succeeded' }, nodes: [{ nodeId: 'fetch', status: 'succeeded' }] }
      }
      if (path === '/workflows/save') return { workflowId: 'wf-recovery', versionId: 'v2', version: 2 }
      if (path === '/dlq/cluster-apply') return { replayed: 2, failed: 0, errors: [] }
      if (path.startsWith('/workflows/health/delta?')) return delta
      if (path === '/members') return []
      return { ok: true }
    })

    render(<FailureClustersCard />)

    fireEvent.click(await screen.findByRole('button', { name: /HTTP 502 on fetch/i }))
    fireEvent.click(screen.getByRole('button', { name: /Recover this pattern/i }))
    await screen.findByRole(
      'heading',
      { name: /Recover fetch on run run-reco/i },
      { timeout: 5_000 },
    )
    fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))
    fireEvent.click(await screen.findByRole('button', { name: /Validate 1 sample.*2 entries/i }))
    fireEvent.click(await screen.findByRole('button', { name: /Apply to 2 entries/i }))

    await waitFor(() => {
      expect(screen.getAllByText(/Patch applied/i).length).toBeGreaterThan(0)
      expect(clusterRequestCount).toBe(2)
      expect(resolveClusterRefresh).toBeDefined()
    })
    const resolveRefresh = resolveClusterRefresh
    if (!resolveRefresh) throw new Error('cluster refresh was not pending')
    await act(async () => {
      resolveRefresh(refreshedClusters)
    })

    const ribbon = await screen.findByRole('alert')
    expect(ribbon).toHaveTextContent('Patch applied')
    expect(ribbon.getBoundingClientRect().height).toBeGreaterThan(0)
    expect(getComputedStyle(ribbon).display).not.toBe('none')
    expect(screen.getByTestId('clusters-empty')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Generate suggestion/i })).toBeNull()
  })
})
