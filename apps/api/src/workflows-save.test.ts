/**
 * Tests for `saveWorkflowVersion`. Mocks `@janusly/db` so the
 * single-transaction read+insert pipeline (plus the unique-constraint
 * retry loop) can be exercised without standing up Postgres. The
 * mock counts insert attempts so a test can throw a synthetic 23505
 * on the first N attempts and let the (N+1)th succeed, exercising the
 * retry branch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Workflow } from '@janusly/shared'

type ExistingVersionRow = {
  version: number
  sloJson?: unknown
  upstreamHealthSources?: string[] | null
}

let existingVersionsByAttempt: ExistingVersionRow[][] = []
let existingWorkflowRows: { id: string; name: string }[] = []
let existingWorkflowRowsByAttempt: { id: string; name: string }[][] | null = null
const insertedWorkflowsRows: Record<string, unknown>[] = []
const insertedVersionRows: Record<string, unknown>[] = []
const updatedWorkflowsRows: Record<string, unknown>[] = []

let workflowInsertBehaviour: Array<'ok' | { throwError: unknown }> = []
let versionInsertBehaviour: Array<'ok' | { throwError: unknown }> = []
let attemptCount = 0
// Drives the top-level soft-delete pre-check (`db.select … limit(1)` before the
// save tx). `null` = no matching workflow row → not soft-deleted (the default,
// so existing tests are unaffected).
let softDeleteGateRow: { deletedAt: Date | null } | null = null

class SyntheticPgError extends Error {
  code: string
  constraint?: string
  constructor(code: string, constraint?: string) {
    super(`synthetic-${code}`)
    this.code = code
    if (constraint) this.constraint = constraint
  }
}

type SelectChain = {
  from: () => SelectChain
  where: (...args: unknown[]) => Promise<unknown> | {
    orderBy: () => { limit: () => Promise<unknown> }
  }
}

function makeTx(currentAttempt: number) {
  return {
    // The save helper issues two `select()` calls per attempt:
    //   1. latest workflow_version (terminates with .orderBy().limit(1))
    //   2. workflows lookup (terminates with .where())
    select: (() => {
      let callCount = 0
      return () => {
        callCount += 1
        if (callCount === 1) {
          // workflow_versions select. Returns the slice for this
          // attempt — earlier attempts may have seen 0 rows; later
          // attempts (after a winner committed) see one more row.
          const chain: SelectChain = {
            from: () => chain,
            where: () => ({
              orderBy: () => ({
                limit: () => Promise.resolve(existingVersionsByAttempt[currentAttempt - 1]?.slice(0, 1) ?? []),
              }),
            }),
          }
          return chain
        }
        // workflows select.
        const workflowRows = existingWorkflowRowsByAttempt?.[currentAttempt - 1] ?? existingWorkflowRows
        const chain: SelectChain = {
          from: () => chain,
          where: () => Promise.resolve(workflowRows),
        }
        return chain
      }
    })(),
    update: () => ({
      set: (row: Record<string, unknown>) => ({
        where: () => {
          updatedWorkflowsRows.push(row)
          return Promise.resolve()
        },
      }),
    }),
    insert: (() => {
      return (table: unknown) => ({
        values: (row: Record<string, unknown>) => {
          const isWorkflowsTable = (table as { __tableName?: string })?.__tableName === 'workflows'
          if (isWorkflowsTable) {
            const behaviour = workflowInsertBehaviour[currentAttempt - 1] ?? 'ok'
            if (behaviour !== 'ok') {
              return Promise.reject(behaviour.throwError)
            }
            insertedWorkflowsRows.push(row)
            return Promise.resolve()
          }
          // workflow_versions insert — may throw based on per-attempt
          // behaviour configured by the test.
          const behaviour = versionInsertBehaviour[currentAttempt - 1] ?? 'ok'
          if (behaviour !== 'ok') {
            return Promise.reject(behaviour.throwError)
          }
          insertedVersionRows.push(row)
          return Promise.resolve()
        },
      })
    })(),
  }
}

// `saveWorkflowVersion` now calls `syncWorkflowSchedules` from the
// engine's schedule-scheduler module on a successful save. Mocking that
// here keeps these unit tests from pulling in BullMQ + ioredis (which
// would error on missing REDIS_URL in the test runner).
vi.mock('@janusly/engine/src/schedule-scheduler', () => ({
  syncWorkflowSchedules: vi.fn(async () => undefined),
}))

vi.mock('@janusly/db', () => ({
  db: {
    // Top-level soft-delete pre-check: select({deletedAt}).from(workflows)
    //   .where(...).limit(1) → [] (not soft-deleted) unless a test sets the row.
    select: () => {
      const chain = {
        from: () => chain,
        where: () => ({ limit: () => Promise.resolve(softDeleteGateRow ? [softDeleteGateRow] : []) }),
      }
      return chain
    },
    transaction: async <T>(fn: (tx: ReturnType<typeof makeTx>) => Promise<T>) => {
      attemptCount += 1
      return fn(makeTx(attemptCount))
    },
  },
  workflowVersions: {
    id: 'workflow_versions.id',
    orgId: 'workflow_versions.org_id',
    workflowId: 'workflow_versions.workflow_id',
    version: 'workflow_versions.version',
    __tableName: 'workflow_versions',
  },
  workflows: {
    id: 'workflows.id',
    orgId: 'workflows.org_id',
    name: 'workflows.name',
    __tableName: 'workflows',
  },
}))

import {
  isRetryableSaveViolation,
  MAX_SAVE_ATTEMPTS,
  saveWorkflowVersion,
} from './workflows-save'

const baseWorkflow: Workflow = {
  dslVersion: '1.0',
  id: 'wf-test',
  name: 'Test workflow',
  nodes: [{ id: 'a', type: 'noop', config: {} }],
  edges: [],
}

afterEach(() => {
  existingVersionsByAttempt = []
  existingWorkflowRows = []
  existingWorkflowRowsByAttempt = null
  insertedWorkflowsRows.length = 0
  insertedVersionRows.length = 0
  updatedWorkflowsRows.length = 0
  workflowInsertBehaviour = []
  versionInsertBehaviour = []
  attemptCount = 0
  softDeleteGateRow = null
})

describe('saveWorkflowVersion — happy path', () => {
  it('inserts a new workflow row and v1 on first save', async () => {
    existingVersionsByAttempt = [[]]
    existingWorkflowRows = []
    versionInsertBehaviour = ['ok']

    const result = await saveWorkflowVersion({
      orgId: 'org-1',
      userId: 'user-a',
      parsedWorkflow: baseWorkflow,
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.version).toBe(1)
    expect(result.attempts).toBe(1)
    expect(result.workflowId).toBe('wf-test')
    expect(result.workflowName).toBe('Test workflow')
    expect(insertedWorkflowsRows).toHaveLength(1)
    expect(insertedVersionRows).toHaveLength(1)
    expect((insertedVersionRows[0]!.dagJson as { id: string }).id).toBe('wf-test')
  })

  it('inserts the next version (max+1) when prior versions exist', async () => {
    existingVersionsByAttempt = [[{ version: 7 }, { version: 6 }, { version: 5 }]]
    existingWorkflowRows = [{ id: 'wf-test', name: 'Test workflow' }]
    versionInsertBehaviour = ['ok']

    const result = await saveWorkflowVersion({
      orgId: 'org-1',
      userId: 'user-a',
      parsedWorkflow: baseWorkflow,
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.version).toBe(8)
    expect(result.attempts).toBe(1)
    expect(insertedWorkflowsRows).toHaveLength(0)
    expect(insertedVersionRows[0]!.version).toBe(8)
  })

  it('updates the workflow name when it differs from the stored row', async () => {
    existingVersionsByAttempt = [[{ version: 1 }]]
    existingWorkflowRows = [{ id: 'wf-test', name: 'Old name' }]
    versionInsertBehaviour = ['ok']

    await saveWorkflowVersion({
      orgId: 'org-1',
      userId: 'user-a',
      parsedWorkflow: { ...baseWorkflow, name: 'New name' },
    })

    expect(updatedWorkflowsRows).toHaveLength(1)
    expect(updatedWorkflowsRows[0]!.name).toBe('New name')
  })

  it('carries reliability declarations from the single latest version', async () => {
    const sloJson = { targetSuccessRate: 0.99 }
    existingVersionsByAttempt = [[{
      version: 7,
      sloJson,
      upstreamHealthSources: ['github'],
    }]]
    existingWorkflowRows = [{ id: 'wf-test', name: 'Test workflow' }]

    const result = await saveWorkflowVersion({
      orgId: 'org-1',
      userId: 'user-a',
      parsedWorkflow: baseWorkflow,
    })

    expect(result).toMatchObject({ kind: 'ok', version: 8 })
    expect(insertedVersionRows[0]).toMatchObject({
      sloJson,
      upstreamHealthSources: ['github'],
    })
  })

  it('generates a workflow id when the parsed workflow has none', async () => {
    existingVersionsByAttempt = [[]]
    existingWorkflowRows = []
    versionInsertBehaviour = ['ok']

    const result = await saveWorkflowVersion({
      orgId: 'org-1',
      userId: 'user-a',
      parsedWorkflow: { ...baseWorkflow, id: undefined },
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.workflowId.length).toBeGreaterThan(0)
    expect(result.workflowId).not.toBe('wf-test')
  })
})

describe('saveWorkflowVersion — retry on version unique-constraint violations', () => {
  it('retries once when the first insert throws 23505 on the version index', async () => {
    // Attempt 1 sees 1 prior version, computes nextVersion=2, INSERT
    // throws 23505 (the concurrent saver got there first).
    // Attempt 2 re-reads, sees the just-committed v2 → computes 3, succeeds.
    existingVersionsByAttempt = [
      [{ version: 1 }],
      [{ version: 2 }, { version: 1 }],
    ]
    existingWorkflowRows = [{ id: 'wf-test', name: 'Test workflow' }]
    versionInsertBehaviour = [
      { throwError: new SyntheticPgError('23505', 'workflow_versions_org_workflow_version_idx') },
      'ok',
    ]

    const result = await saveWorkflowVersion({
      orgId: 'org-1',
      userId: 'user-a',
      parsedWorkflow: baseWorkflow,
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.version).toBe(3)
    expect(result.attempts).toBe(2)
  })

  it('retries twice under rapid contention', async () => {
    existingVersionsByAttempt = [
      [{ version: 1 }],
      [{ version: 2 }, { version: 1 }],
      [{ version: 3 }, { version: 2 }, { version: 1 }],
    ]
    existingWorkflowRows = [{ id: 'wf-test', name: 'Test workflow' }]
    versionInsertBehaviour = [
      { throwError: new SyntheticPgError('23505', 'workflow_versions_org_workflow_version_idx') },
      { throwError: new SyntheticPgError('23505', 'workflow_versions_org_workflow_version_idx') },
      'ok',
    ]

    const result = await saveWorkflowVersion({
      orgId: 'org-1',
      userId: 'user-a',
      parsedWorkflow: baseWorkflow,
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.version).toBe(4)
    expect(result.attempts).toBe(3)
    expect(MAX_SAVE_ATTEMPTS).toBe(3)
  })

  it('returns kind: conflict when retries are exhausted', async () => {
    existingVersionsByAttempt = [
      [{ version: 1 }],
      [{ version: 2 }, { version: 1 }],
      [{ version: 3 }, { version: 2 }, { version: 1 }],
    ]
    existingWorkflowRows = [{ id: 'wf-test', name: 'Test workflow' }]
    versionInsertBehaviour = [
      { throwError: new SyntheticPgError('23505', 'workflow_versions_org_workflow_version_idx') },
      { throwError: new SyntheticPgError('23505', 'workflow_versions_org_workflow_version_idx') },
      { throwError: new SyntheticPgError('23505', 'workflow_versions_org_workflow_version_idx') },
    ]

    const result = await saveWorkflowVersion({
      orgId: 'org-1',
      userId: 'user-a',
      parsedWorkflow: baseWorkflow,
    })

    expect(result.kind).toBe('conflict')
    if (result.kind !== 'conflict') return
    expect(result.attempts).toBe(MAX_SAVE_ATTEMPTS)
  })

  it('rethrows non-23505 Postgres errors without retrying', async () => {
    existingVersionsByAttempt = [[]]
    existingWorkflowRows = []
    // 23502 = NOT NULL violation. Genuine schema bug — must not retry.
    versionInsertBehaviour = [{ throwError: new SyntheticPgError('23502') }]

    await expect(saveWorkflowVersion({
      orgId: 'org-1',
      userId: 'user-a',
      parsedWorkflow: baseWorkflow,
    })).rejects.toThrow(/synthetic-23502/)

    // Only one attempt fired — no retry on non-23505.
    expect(attemptCount).toBe(1)
  })

  it('rethrows 23505 on a different unique index (not the version one)', async () => {
    existingVersionsByAttempt = [[]]
    existingWorkflowRows = []
    versionInsertBehaviour = [{
      throwError: new SyntheticPgError('23505', 'some_other_unique_idx'),
    }]

    await expect(saveWorkflowVersion({
      orgId: 'org-1',
      userId: 'user-a',
      parsedWorkflow: baseWorkflow,
    })).rejects.toThrow(/synthetic-23505/)

    // The route's retry only covers the workflow-save race constraints;
    // other 23505s indicate genuine bugs and rethrow on first attempt.
    expect(attemptCount).toBe(1)
  })

  it('regenerates versionId per attempt so logs disambiguate the rolled-back attempts', async () => {
    existingVersionsByAttempt = [
      [{ version: 1 }],
      [{ version: 2 }, { version: 1 }],
    ]
    existingWorkflowRows = [{ id: 'wf-test', name: 'Test workflow' }]
    versionInsertBehaviour = [
      { throwError: new SyntheticPgError('23505', 'workflow_versions_org_workflow_version_idx') },
      'ok',
    ]

    const result = await saveWorkflowVersion({
      orgId: 'org-1',
      userId: 'user-a',
      parsedWorkflow: baseWorkflow,
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    // Only the successful attempt's versionId is committed (the rolled-
    // back attempt's insert never persisted), but the result mirrors
    // it. Confirm it's a valid UUID-shaped id.
    expect(typeof result.versionId).toBe('string')
    expect(result.versionId.length).toBeGreaterThan(8)
  })
})

describe('isRetryableSaveViolation', () => {
  it('matches a 23505 error with the version-index constraint name', () => {
    const err = new SyntheticPgError('23505', 'workflow_versions_org_workflow_version_idx')
    expect(isRetryableSaveViolation(err)).toBe(true)
  })

  it('matches a 23505 error with the workflows-pkey constraint name (first-save race)', () => {
    // Concurrent first-saves with the same caller-provided workflowId
    // race on `workflows.id` PK. The retry covers this so the loser
    // re-runs the transaction, sees the just-committed row on the
    // second `existingWorkflow` read, and skips the workflows-INSERT
    // branch entirely.
    const err = new SyntheticPgError('23505', 'workflows_pkey')
    expect(isRetryableSaveViolation(err)).toBe(true)
  })

  it('matches a 23505 error with no constraint name (defensive default)', () => {
    const err = new SyntheticPgError('23505')
    expect(isRetryableSaveViolation(err)).toBe(true)
  })

  it('matches a 23505 wrapped in `cause` (Drizzle/pg error chain)', () => {
    const inner = new SyntheticPgError('23505', 'workflow_versions_org_workflow_version_idx')
    const wrapper = Object.assign(new Error('drizzle wrap'), { cause: inner })
    expect(isRetryableSaveViolation(wrapper)).toBe(true)
  })

  it('does not match 23505 on a different constraint name', () => {
    const err = new SyntheticPgError('23505', 'some_other_unique_idx')
    expect(isRetryableSaveViolation(err)).toBe(false)
  })

  it('does not match a non-23505 error', () => {
    const err = new SyntheticPgError('23502')
    expect(isRetryableSaveViolation(err)).toBe(false)
  })

  it('does not match non-Error inputs (null, undefined, plain strings)', () => {
    expect(isRetryableSaveViolation(null)).toBe(false)
    expect(isRetryableSaveViolation(undefined)).toBe(false)
    expect(isRetryableSaveViolation('boom')).toBe(false)
    expect(isRetryableSaveViolation(42)).toBe(false)
  })
})

describe('saveWorkflowVersion — retry on workflows-pkey violations (first-save race)', () => {
  it('retries when the INSERT throws workflows_pkey 23505 on the first attempt', async () => {
    // Concurrent first-saves race on `workflows.id` PK because the
    // caller-provided `workflowId` is the same for every concurrent
    // saver. First saver wins the workflows-INSERT; losers throw
    // workflows_pkey 23505 inside their transaction. The probe
    // accepts both `workflows_pkey` AND
    // `workflow_versions_org_workflow_version_idx`, so the retry
    // loop kicks in. On attempt 2, the helper's `existingWorkflow`
    // re-read sees the just-committed row and skips the workflows-
    // INSERT branch — the version insert proceeds against v2.
    existingVersionsByAttempt = [
      [],
      [{ version: 1 }],
    ]
    existingWorkflowRowsByAttempt = [
      [],
      [{ id: 'wf-test', name: 'Test workflow' }],
    ]
    workflowInsertBehaviour = [
      { throwError: new SyntheticPgError('23505', 'workflows_pkey') },
      'ok',
    ]
    versionInsertBehaviour = ['ok', 'ok']

    const result = await saveWorkflowVersion({
      orgId: 'org-1',
      userId: 'user-a',
      parsedWorkflow: baseWorkflow,
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.attempts).toBe(2)
    expect(result.version).toBe(2)
    expect(insertedWorkflowsRows).toHaveLength(0)
    expect(insertedVersionRows).toHaveLength(1)
  })
})

describe('saveWorkflowVersion — soft-deleted workflow', () => {
  it('rejects with kind:"deleted" and writes nothing', async () => {
    softDeleteGateRow = { deletedAt: new Date('2026-01-01T00:00:00Z') }
    const result = await saveWorkflowVersion({ orgId: 'org-1', userId: 'u1', parsedWorkflow: baseWorkflow })
    expect(result).toEqual({ kind: 'deleted' })
    expect(insertedVersionRows).toHaveLength(0)
    expect(insertedWorkflowsRows).toHaveLength(0)
  })

  it('still saves when the gate row is active (deletedAt null)', async () => {
    softDeleteGateRow = { deletedAt: null }
    existingVersionsByAttempt = [[{ version: 4 }]]
    existingWorkflowRows = [{ id: 'wf-test', name: 'Test workflow' }]
    const result = await saveWorkflowVersion({ orgId: 'org-1', userId: 'u1', parsedWorkflow: baseWorkflow })
    expect(result.kind).toBe('ok')
    expect(insertedVersionRows).toHaveLength(1)
  })
})
