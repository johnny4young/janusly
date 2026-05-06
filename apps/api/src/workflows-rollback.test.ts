/**
 * Tests for `rollbackWorkflowToVersion`. Mocks `@janusly/db` so the
 * single-transaction read+insert can be exercised without standing up
 * Postgres. The mock records the values inserted so we can assert the
 * new version's `dagJson` matches the source's exactly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

let sourceRows: { id: string; orgId: string; workflowId: string; version: number; dagJson: unknown }[] = []
let existingVersions: { version: number }[] = []
const insertedRows: Record<string, unknown>[] = []

type SourceSelectChain = {
  from: () => SourceSelectChain
  where: () => Promise<typeof sourceRows>
}

type ExistingVersionsOrderChain = {
  orderBy: () => Promise<typeof existingVersions>
}

type ExistingVersionsSelectChain = {
  from: () => ExistingVersionsSelectChain
  where: () => ExistingVersionsOrderChain
}

function makeTx() {
  return {
    // The rollback helper issues two `select()` calls. We disambiguate by
    // call-count: first → source-version load (terminates after `where()`);
    // second → existing-versions list (terminates after `orderBy()`).
    select: (() => {
      let callCount = 0
      return () => {
        callCount += 1
        if (callCount === 1) {
          const chain: SourceSelectChain = {
            from: () => chain,
            where: () => Promise.resolve(sourceRows),
          }
          return chain
        }
        const chain: ExistingVersionsSelectChain = {
          from: () => chain,
          where: () => ({
            orderBy: () => Promise.resolve(existingVersions),
          }),
        }
        return chain
      }
    })(),
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
    transaction: async <T>(fn: (tx: ReturnType<typeof makeTx>) => Promise<T>) => fn(makeTx()),
  },
  workflowVersions: {
    id: 'workflow_versions.id',
    orgId: 'workflow_versions.org_id',
    workflowId: 'workflow_versions.workflow_id',
    version: 'workflow_versions.version',
  },
}))

import { rollbackAuditMetadata, rollbackWorkflowToVersion } from './workflows-rollback'

afterEach(() => {
  sourceRows = []
  existingVersions = []
  insertedRows.length = 0
})

describe('rollbackWorkflowToVersion', () => {
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
  })

  it('returns not_found when the source version does not exist (cross-tenant or wrong workflow)', async () => {
    sourceRows = []
    existingVersions = [{ version: 5 }]

    const result = await rollbackWorkflowToVersion({
      orgId: 'org-1',
      userId: 'user-a',
      workflowId: 'wf-1',
      sourceVersionId: 'ver-from-other-org',
    })

    expect(result).toEqual({ ok: false, code: 'not_found' })
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

  it('builds the workflow.rolled_back audit metadata shape from the rollback result', () => {
    expect(rollbackAuditMetadata({
      ok: true,
      versionId: 'ver-6',
      version: 6,
      sourceVersion: 3,
      sourceVersionId: 'ver-3',
    })).toEqual({
      sourceVersionId: 'ver-3',
      sourceVersion: 3,
      newVersion: 6,
    })
  })
})
