import { beforeEach, describe, expect, it, vi } from 'vitest'
import { signResumeToken } from './secrets'

const {
  appendEventMock,
  dbRows,
  enqueueReadyNodesMock,
  markWaitingNodeSucceededMock,
  updateRunStatusFromNodesMock,
} = vi.hoisted(() => ({
  appendEventMock: vi.fn().mockResolvedValue(undefined),
  dbRows: [] as Array<{ orgId: string; inputJson: unknown }>,
  enqueueReadyNodesMock: vi.fn().mockResolvedValue(0),
  markWaitingNodeSucceededMock: vi.fn().mockResolvedValue(true),
  updateRunStatusFromNodesMock: vi.fn().mockResolvedValue('succeeded'),
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ kind: 'eq' })),
}))

vi.mock('@janusly/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(dbRows),
      }),
    }),
  },
  runs: { id: { name: 'id' } },
}))

vi.mock('./persistence', () => ({
  appendEvent: appendEventMock,
  markWaitingNodeSucceeded: markWaitingNodeSucceededMock,
  updateRunStatusFromNodes: updateRunStatusFromNodesMock,
}))

vi.mock('./adapters/bullmq-queue-adapter', () => ({
  BullMQQueueAdapter: class {},
}))

vi.mock('./adapters/postgres-execution-store', () => ({
  PostgresExecutionStore: class {},
}))

vi.mock('./core/runtime', () => ({
  WorkflowRuntime: class {
    enqueueReadyNodes = enqueueReadyNodesMock
  },
}))

import { ResumeRunConflictError, resumeRun } from './resume-run'

function workflow(node: { id: string; type: string; config: Record<string, unknown> }) {
  return {
    dslVersion: '1.0',
    nodes: [node],
    edges: [],
  }
}

describe('resumeRun', () => {
  beforeEach(() => {
    appendEventMock.mockClear()
    enqueueReadyNodesMock.mockClear()
    markWaitingNodeSucceededMock.mockClear().mockResolvedValue(true)
    updateRunStatusFromNodesMock.mockClear()
    dbRows.length = 0
  })

  it('validates and persists human_form input as node output', async () => {
    dbRows.push({
      orgId: 'org-1',
      inputJson: {
        workflow: workflow({
          id: 'collect',
          type: 'human_form',
          config: {
            schema: {
              type: 'object',
              properties: { requester: { type: 'string' }, days: { type: 'number' } },
              required: ['requester', 'days'],
            },
          },
        }),
      },
    })
    const token = signResumeToken({ orgId: 'org-1', runId: 'run-1', nodeId: 'collect', purpose: 'human_form' })

    await expect(resumeRun('run-1', 'collect', {
      resumeToken: token,
      input: { requester: 'Ada', days: 3 },
    })).resolves.toEqual({ resumed: true })

    expect(markWaitingNodeSucceededMock).toHaveBeenCalledWith('run-1', 'collect', { requester: 'Ada', days: 3 })
    expect(appendEventMock).toHaveBeenCalledWith('run-1', 'collect', 'node.resumed', { output: { requester: 'Ada', days: 3 } })
    expect(enqueueReadyNodesMock).toHaveBeenCalledWith({ runId: 'run-1', workflow: expect.objectContaining({ nodes: expect.any(Array) }) })
    expect(updateRunStatusFromNodesMock).toHaveBeenCalledWith('run-1')
  })

  it('rejects tampered human_form tokens before completing the node', async () => {
    dbRows.push({
      orgId: 'org-1',
      inputJson: {
        workflow: workflow({
          id: 'collect',
          type: 'human_form',
          config: { schema: { type: 'object', properties: { requester: { type: 'string' } } } },
        }),
      },
    })

    await expect(resumeRun('run-1', 'collect', {
      resumeToken: 'v1.bad.bad',
      input: { requester: 'Ada' },
    })).rejects.toThrow('Invalid resume token')

    expect(markWaitingNodeSucceededMock).not.toHaveBeenCalled()
  })

  it('returns a conflict when the waiting node was already completed', async () => {
    markWaitingNodeSucceededMock.mockResolvedValueOnce(false)
    dbRows.push({
      orgId: 'org-1',
      inputJson: {
        workflow: workflow({ id: 'gate', type: 'approval', config: {} }),
      },
    })

    await expect(resumeRun('run-1', 'gate')).rejects.toBeInstanceOf(ResumeRunConflictError)
    expect(enqueueReadyNodesMock).not.toHaveBeenCalled()
  })

  it('captures webhook resume input as the node output', async () => {
    dbRows.push({
      orgId: 'org-1',
      inputJson: {
        workflow: workflow({ id: 'trigger', type: 'webhook', config: {} }),
      },
    })

    await expect(resumeRun('run-1', 'trigger', {
      input: { customer: 'leah@example.com', amountUsd: 49 },
    })).resolves.toEqual({ resumed: true })

    expect(markWaitingNodeSucceededMock).toHaveBeenCalledWith('run-1', 'trigger', { customer: 'leah@example.com', amountUsd: 49 })
    expect(appendEventMock).toHaveBeenCalledWith('run-1', 'trigger', 'node.resumed', { output: { customer: 'leah@example.com', amountUsd: 49 } })
  })

  it('approval resume preserves empty output (decision lives in audit, not node state)', async () => {
    dbRows.push({
      orgId: 'org-1',
      inputJson: {
        workflow: workflow({ id: 'gate', type: 'approval', config: {} }),
      },
    })

    await expect(resumeRun('run-1', 'gate', { input: { reason: 'looks fine' } })).resolves.toEqual({ resumed: true })

    expect(markWaitingNodeSucceededMock).toHaveBeenCalledWith('run-1', 'gate', {})
    expect(appendEventMock).toHaveBeenCalledWith('run-1', 'gate', 'node.resumed', {})
  })
})
