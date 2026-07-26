/**
 * Tests for `rollbackWorkflowToVersion`. Mocks `@janusly/db` so the
 * single-transaction read+insert can be exercised without standing up
 * Postgres. The mock records the values inserted so we can assert the
 * new version's `dagJson` matches the source's exactly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const { syncWorkflowSchedulesMock } = vi.hoisted(() => ({
  syncWorkflowSchedulesMock: vi.fn(async () => undefined),
}))

let sourceRows: { id: string; orgId: string; workflowId: string; version: number; dagJson: unknown }[] = []
let existingVersions: {
  version: number
  sloJson?: unknown
  upstreamHealthSources?: string[] | null
}[] = []
// Parent-workflow pre-check rows. The default is one active workflow; `[]`
// represents a missing parent and a dated row represents a tombstone.
let gateWorkflowRows: { deletedAt: Date | null }[] = [{ deletedAt: null }]
let activeRolloutRows: { id: string }[] = []
const insertedRows: Record<string, unknown>[] = []
let transactionFailures: unknown[] = []

function makeTx() {
  return {
    select: (selection?: unknown) => {
      let tableName = ''
      const chain = {
        from: (table: unknown) => {
          tableName = (table as { __tableName?: string })?.__tableName ?? ''
          return chain
        },
        where: () => {
          if (tableName === 'workflows') {
            return { limit: () => ({ for: () => Promise.resolve(gateWorkflowRows) }) }
          }
          if (tableName === 'workflow_rollouts') {
            return { limit: () => Promise.resolve(activeRolloutRows) }
          }
          if (selection === undefined) return Promise.resolve(sourceRows)
          return {
            orderBy: () => ({ limit: () => Promise.resolve(existingVersions.slice(0, 1)) }),
          }
        },
      }
      return chain
    },
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        insertedRows.push(row)
        return Promise.resolve()
      },
    }),
  }
}

vi.mock('@janusly/db', () => ({
  db: {
    transaction: async <T>(fn: (tx: ReturnType<typeof makeTx>) => Promise<T>) => {
      const failure = transactionFailures.shift()
      if (failure) throw failure
      return fn(makeTx())
    },
  },
  workflowVersions: {
    id: 'workflow_versions.id',
    orgId: 'workflow_versions.org_id',
    workflowId: 'workflow_versions.workflow_id',
    version: 'workflow_versions.version',
    __tableName: 'workflow_versions',
  },
  workflowRollouts: {
    id: 'workflow_rollouts.id',
    orgId: 'workflow_rollouts.org_id',
    workflowId: 'workflow_rollouts.workflow_id',
    status: 'workflow_rollouts.status',
    __tableName: 'workflow_rollouts',
  },
  workflows: {
    id: 'workflows.id',
    orgId: 'workflows.org_id',
    deletedAt: 'workflows.deleted_at',
    __tableName: 'workflows',
  },
}))

vi.mock('@janusly/engine/src/schedule-scheduler', () => ({
  syncWorkflowSchedules: syncWorkflowSchedulesMock,
}))

import { rollbackAuditMetadata, rollbackWorkflowToVersion } from './workflows-rollback'

afterEach(() => {
  sourceRows = []
  existingVersions = []
  gateWorkflowRows = [{ deletedAt: null }]
  activeRolloutRows = []
  transactionFailures = []
  insertedRows.length = 0
  syncWorkflowSchedulesMock.mockReset()
  syncWorkflowSchedulesMock.mockResolvedValue(undefined)
})

describe('rollbackWorkflowToVersion', () => {
  it('does not mint a rollback version while a deployment is active', async () => {
    activeRolloutRows = [{ id: 'rollout-1' }]

    const result = await rollbackWorkflowToVersion({
      orgId: 'org-1',
      userId: 'user-1',
      workflowId: 'wf-1',
      sourceVersionId: 'ver-1',
    })

    expect(result).toEqual({ ok: false, code: 'rollout_active' })
    expect(insertedRows).toHaveLength(0)
  })

  it('inserts a new version whose dagJson matches the source exactly', async () => {
    const dag = { dslVersion: '1.0', id: 'wf-1', name: 'My Flow', nodes: [{ id: 'n1', type: 'noop', config: {} }], edges: [] }
    sourceRows = [{ id: 'ver-3', orgId: 'org-1', workflowId: 'wf-1', version: 3, dagJson: dag }]
    existingVersions = [{ version: 5 }, { version: 4 }, { version: 3 }, { version: 2 }, { version: 1 }]

    const result = await rollbackWorkflowToVersion({
      orgId: 'org-1',
      userId: 'user-a',
      workflowId: 'wf-1',
      sourceVersionId: 'ver-3',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.version).toBe(6)
    expect(result.sourceVersion).toBe(3)
    expect(result.sourceVersionId).toBe('ver-3')
    expect(result.attempts).toBe(1)
    expect(typeof result.versionId).toBe('string')
    expect(result.versionId.length).toBeGreaterThan(0)

    expect(insertedRows).toHaveLength(1)
    const inserted = insertedRows[0]!
    expect(inserted.orgId).toBe('org-1')
    expect(inserted.workflowId).toBe('wf-1')
    expect(inserted.version).toBe(6)
    expect(inserted.createdBy).toBe('user-a')
    expect(inserted.dagJson).toEqual(dag)
    expect(inserted.dagJson).toBe(dag)
    expect(syncWorkflowSchedulesMock).toHaveBeenCalledWith({
      orgId: 'org-1',
      workflowId: 'wf-1',
      workflowVersionId: result.versionId,
      nodes: dag.nodes,
      createdBy: 'user-a',
    })
  })

  it('returns source_not_found when the source version does not exist (cross-tenant or wrong workflow)', async () => {
    sourceRows = []
    existingVersions = [{ version: 5 }]

    const result = await rollbackWorkflowToVersion({
      orgId: 'org-1',
      userId: 'user-a',
      workflowId: 'wf-1',
      sourceVersionId: 'ver-from-other-org',
    })

    expect(result).toEqual({ ok: false, code: 'source_not_found' })
    expect(insertedRows).toHaveLength(0)
  })

  it('treats no existing versions as nextVersion = 1', async () => {
    const dag = { dslVersion: '1.0', id: 'wf-2', name: 'X', nodes: [{ id: 'a', type: 'noop', config: {} }], edges: [] }
    sourceRows = [{ id: 'ver-x', orgId: 'org-1', workflowId: 'wf-2', version: 1, dagJson: dag }]
    existingVersions = []

    const result = await rollbackWorkflowToVersion({
      orgId: 'org-1',
      userId: 'user-a',
      workflowId: 'wf-2',
      sourceVersionId: 'ver-x',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.version).toBe(1)
    expect(insertedRows[0]!.version).toBe(1)
  })

  it('attributes the new version to the operator who triggered the rollback', async () => {
    const dag = { dslVersion: '1.0', id: 'wf-1', name: 'Y', nodes: [{ id: 'n1', type: 'noop', config: {} }], edges: [] }
    sourceRows = [{ id: 'ver-3', orgId: 'org-1', workflowId: 'wf-1', version: 3, dagJson: dag }]
    existingVersions = [{ version: 5 }]

    await rollbackWorkflowToVersion({
      orgId: 'org-1',
      userId: 'reviewer-bob',
      workflowId: 'wf-1',
      sourceVersionId: 'ver-3',
    })

    expect(insertedRows[0]!.createdBy).toBe('reviewer-bob')
  })

  it('carries reliability declarations from the single latest version', async () => {
    const dag = { dslVersion: '1.0', id: 'wf-1', nodes: [{ id: 'n1', type: 'noop', config: {} }], edges: [] }
    const sloJson = { targetSuccessRate: 0.995 }
    sourceRows = [{ id: 'ver-3', orgId: 'org-1', workflowId: 'wf-1', version: 3, dagJson: dag }]
    existingVersions = [{ version: 5, sloJson, upstreamHealthSources: ['salesforce'] }]

    const result = await rollbackWorkflowToVersion({
      orgId: 'org-1',
      userId: 'user-a',
      workflowId: 'wf-1',
      sourceVersionId: 'ver-3',
    })

    expect(result).toMatchObject({ ok: true, version: 6 })
    expect(insertedRows[0]).toMatchObject({
      sloJson,
      upstreamHealthSources: ['salesforce'],
    })
  })

  it('builds the workflow.rolled_back audit metadata shape from the rollback result', () => {
    expect(rollbackAuditMetadata({
      ok: true,
      versionId: 'ver-6',
      version: 6,
      sourceVersion: 3,
      sourceVersionId: 'ver-3',
      attempts: 1,
    })).toEqual({
      sourceVersionId: 'ver-3',
      sourceVersion: 3,
      newVersion: 6,
      attempts: 1,
    })
  })

  it('rejects a rollback against a soft-deleted workflow (no version written)', async () => {
    gateWorkflowRows = [{ deletedAt: new Date('2026-01-01T00:00:00Z') }]
    // Even with a valid source version present, the soft-delete gate short-circuits.
    sourceRows = [{ id: 'ver-3', orgId: 'org-1', workflowId: 'wf-1', version: 3, dagJson: {} }]
    existingVersions = [{ version: 3 }]

    const result = await rollbackWorkflowToVersion({
      orgId: 'org-1',
      userId: 'user-a',
      workflowId: 'wf-1',
      sourceVersionId: 'ver-3',
    })

    expect(result).toEqual({ ok: false, code: 'deleted' })
    expect(insertedRows).toHaveLength(0)
  })

  it('rejects rollback when the active parent workflow does not exist', async () => {
    gateWorkflowRows = []
    sourceRows = [{ id: 'ver-3', orgId: 'org-1', workflowId: 'wf-1', version: 3, dagJson: {} }]

    const result = await rollbackWorkflowToVersion({
      orgId: 'org-1',
      userId: 'user-a',
      workflowId: 'wf-1',
      sourceVersionId: 'ver-3',
    })

    expect(result).toEqual({ ok: false, code: 'parent_not_found' })
    expect(insertedRows).toHaveLength(0)
  })

  it('rejects a malformed historical source before writing a new version', async () => {
    sourceRows = [{ id: 'ver-bad', orgId: 'org-1', workflowId: 'wf-1', version: 3, dagJson: { nodes: 'bad' } }]

    const result = await rollbackWorkflowToVersion({
      orgId: 'org-1',
      userId: 'user-a',
      workflowId: 'wf-1',
      sourceVersionId: 'ver-bad',
    })

    expect(result).toEqual({ ok: false, code: 'malformed' })
    expect(insertedRows).toHaveLength(0)
  })

  it('retries a version-allocation race and reports the winning attempt', async () => {
    const dag = { dslVersion: '1.0', id: 'wf-1', nodes: [{ id: 'n1', type: 'noop', config: {} }], edges: [] }
    sourceRows = [{ id: 'ver-3', orgId: 'org-1', workflowId: 'wf-1', version: 3, dagJson: dag }]
    existingVersions = [{ version: 5 }]
    transactionFailures = [{ code: '23505', constraint: 'workflow_versions_org_workflow_version_idx' }]

    const result = await rollbackWorkflowToVersion({
      orgId: 'org-1',
      userId: 'user-a',
      workflowId: 'wf-1',
      sourceVersionId: 'ver-3',
    })

    expect(result).toMatchObject({ ok: true, version: 6, attempts: 2 })
    expect(insertedRows).toHaveLength(1)
  })

  it('returns a bounded conflict after repeated version-allocation losses', async () => {
    transactionFailures = Array.from({ length: 3 }, () => ({
      code: '23505',
      constraint: 'workflow_versions_org_workflow_version_idx',
    }))

    const result = await rollbackWorkflowToVersion({
      orgId: 'org-1',
      userId: 'user-a',
      workflowId: 'wf-1',
      sourceVersionId: 'ver-3',
    })

    expect(result).toEqual({ ok: false, code: 'conflict', attempts: 3 })
    expect(insertedRows).toHaveLength(0)
  })

  it('keeps a committed rollback successful when schedule reconciliation fails', async () => {
    const dag = { dslVersion: '1.0', id: 'wf-1', nodes: [{ id: 'n1', type: 'noop', config: {} }], edges: [] }
    sourceRows = [{ id: 'ver-3', orgId: 'org-1', workflowId: 'wf-1', version: 3, dagJson: dag }]
    existingVersions = [{ version: 5 }]
    syncWorkflowSchedulesMock.mockRejectedValueOnce(new Error('redis unavailable'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const result = await rollbackWorkflowToVersion({
      orgId: 'org-1',
      userId: 'user-a',
      workflowId: 'wf-1',
      sourceVersionId: 'ver-3',
    })

    expect(result).toMatchObject({ ok: true, version: 6 })
    expect(errorSpy).toHaveBeenCalledWith('[workflows-rollback] schedule sync failed', expect.objectContaining({ workflowId: 'wf-1' }))
    errorSpy.mockRestore()
  })
})
