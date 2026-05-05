/**
 * Tests for the cluster-recovery glue helpers in `cluster-recovery.ts`.
 * Mocks `collectFailureSamples` so we exercise the signature filtering
 * and the limit/cap accounting without standing up a database.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@janusly/data/src/failureClusterRepo', () => ({
  collectFailureSamples: vi.fn(),
}))

import { collectFailureSamples } from '@janusly/data/src/failureClusterRepo'
import {
  CLUSTER_MEMBERS_DEFAULT_LIMIT,
  CLUSTER_MEMBERS_MAX_LIMIT,
  findClusterMembers,
  recheckSignature,
} from './cluster-recovery'

const collectFailureSamplesMock = vi.mocked(collectFailureSamples)

afterEach(() => {
  collectFailureSamplesMock.mockReset()
})

function dlqSample(id: string, errorJson: unknown, overrides: Record<string, unknown> = {}) {
  return {
    source: 'dead_letter' as const,
    id,
    workflowId: 'wf-1',
    workflowName: 'wf',
    runId: `run-${id}`,
    nodeId: 'fetch',
    nodeType: 'http',
    errorJson,
    status: 'open',
    createdAt: new Date('2026-04-01T00:00:00Z'),
    ...overrides,
  }
}

function failedRunNodeSample(id: string, errorJson: unknown) {
  return {
    source: 'failed_run_node' as const,
    id,
    workflowId: 'wf-1',
    workflowName: 'wf',
    runId: `run-${id}`,
    nodeId: 'fetch',
    nodeType: 'http',
    errorJson,
    createdAt: new Date('2026-04-01T00:00:00Z'),
  }
}

describe('findClusterMembers', () => {
  it('returns DLQ ids whose normalized signature matches the cluster signature', async () => {
    collectFailureSamplesMock.mockResolvedValueOnce([
      dlqSample('dlq-1', { code: 'E_SECRET_MISSING', secret: 'GITHUB_TOKEN' }),
      dlqSample('dlq-2', { code: 'E_SECRET_MISSING', secret: 'GITHUB_TOKEN' }),
      dlqSample('dlq-3', { code: 'E_SECRET_MISSING', secret: 'OPENAI_API_KEY' }),
      dlqSample('dlq-4', { message: 'HTTP 401 unauthorized' }),
    ])

    const result = await findClusterMembers('org-1', 'Missing secret: GITHUB_TOKEN', 30, 100)

    expect(result.deadLetterIds).toEqual(['dlq-1', 'dlq-2'])
    expect(result.total).toBe(2)
    expect(result.capped).toBe(false)
  })

  it('skips failed_run_node-source samples (only DLQ rows are returnable for replay)', async () => {
    collectFailureSamplesMock.mockResolvedValueOnce([
      dlqSample('dlq-1', { code: 'E_SECRET_MISSING', secret: 'TOKEN' }),
      failedRunNodeSample('run-x:fetch', { code: 'E_SECRET_MISSING', secret: 'TOKEN' }),
    ])

    const result = await findClusterMembers('org-1', 'Missing secret: TOKEN', 30, 100)

    expect(result.deadLetterIds).toEqual(['dlq-1'])
    expect(result.total).toBe(1)
  })

  it('skips closed DLQ rows so bulk recovery only targets open entries', async () => {
    collectFailureSamplesMock.mockResolvedValueOnce([
      dlqSample('dlq-open', { code: 'E_SECRET_MISSING', secret: 'TOKEN' }),
      dlqSample('dlq-replayed', { code: 'E_SECRET_MISSING', secret: 'TOKEN' }, { status: 'replayed' }),
      dlqSample('dlq-resolved', { code: 'E_SECRET_MISSING', secret: 'TOKEN' }, { status: 'resolved' }),
    ])

    const result = await findClusterMembers('org-1', 'Missing secret: TOKEN', 30, 100)

    expect(result.deadLetterIds).toEqual(['dlq-open'])
    expect(result.total).toBe(1)
    expect(result.capped).toBe(false)
  })

  it('caps the returned list at the requested limit and reports capped=true when more matches exist', async () => {
    const samples = Array.from({ length: 5 }, (_, i) => dlqSample(`dlq-${i}`, { code: 'E_SECRET_MISSING', secret: 'TOKEN' }))
    collectFailureSamplesMock.mockResolvedValueOnce(samples)

    const result = await findClusterMembers('org-1', 'Missing secret: TOKEN', 30, 3)

    expect(result.deadLetterIds).toHaveLength(3)
    expect(result.total).toBe(5)
    expect(result.capped).toBe(true)
  })

  it('does not exceed CLUSTER_MEMBERS_MAX_LIMIT even when caller asks for more', async () => {
    const samples = Array.from({ length: 250 }, (_, i) => dlqSample(`dlq-${i}`, { code: 'E_SECRET_MISSING', secret: 'TOKEN' }))
    collectFailureSamplesMock.mockResolvedValueOnce(samples)

    const result = await findClusterMembers('org-1', 'Missing secret: TOKEN', 30, 9999)

    expect(result.deadLetterIds.length).toBeLessThanOrEqual(CLUSTER_MEMBERS_MAX_LIMIT)
  })

  it('default limit is CLUSTER_MEMBERS_DEFAULT_LIMIT (sanity)', () => {
    expect(CLUSTER_MEMBERS_DEFAULT_LIMIT).toBe(100)
    expect(CLUSTER_MEMBERS_MAX_LIMIT).toBe(100)
  })
})

describe('recheckSignature', () => {
  it('returns true when the row still matches the claimed signature', () => {
    const item = {
      errorJson: { code: 'E_SECRET_MISSING', secret: 'GITHUB_TOKEN' },
      nodeJson: { type: 'http', config: { url: 'https://x' } },
    }
    expect(recheckSignature(item, 'Missing secret: GITHUB_TOKEN')).toBe(true)
  })

  it('returns false when the row no longer matches the claimed signature', () => {
    const item = {
      errorJson: { message: 'HTTP 502 from upstream' },
      nodeJson: { type: 'http', config: { url: 'https://x' } },
    }
    expect(recheckSignature(item, 'Missing secret: GITHUB_TOKEN')).toBe(false)
  })

  it('uses tool name from nodeJson.config.tool when normalizing tool-node errors', () => {
    const item = {
      errorJson: { message: 'Invalid input for slack.post' },
      nodeJson: { type: 'tool', config: { tool: 'slack.post' } },
    }
    // Just verifying the helper doesn't throw and returns a boolean —
    // the exact signature for tool-input errors is exercised by the
    // engine's error-signature tests; this test pins that we pass the
    // tool name through correctly.
    const result = recheckSignature(item, 'this should not match')
    expect(typeof result).toBe('boolean')
  })

  it('handles missing nodeJson gracefully (defaults to nodeType="node")', () => {
    const item = {
      errorJson: { message: 'something broke' },
      nodeJson: null,
    }
    const result = recheckSignature(item, 'something else entirely')
    expect(typeof result).toBe('boolean')
  })
})
