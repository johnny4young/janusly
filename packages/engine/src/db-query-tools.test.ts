import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@janusly/data', () => ({
  getCredentialByName: vi.fn(),
  resolveCredentialSecretRef: vi.fn(async (_orgId: string, secretRef: string) => process.env[secretRef] ?? null),
}))

import { getCredentialByName } from '@janusly/data'
import {
  _resetExternalDbClientsForTests,
  _setExternalDbClientFactoryForTests,
  dbQueryReadTool,
  dbQueryTransactionTool,
  dbQueryWriteTool,
  dbSchemaDescribeTool,
} from './db-query-tools'
import {
  _resetIntegrationUsageRecorderForTests,
  setIntegrationUsageRecorder,
  type IntegrationUsageRecord,
} from './integration-usage'
import {
  _resetEngineRateLimiterForTests,
  setEngineRateLimiter,
} from './rate-limit'

type Rows = Array<Record<string, unknown>> & { count?: number }

function rows(values: Array<Record<string, unknown>>, count = values.length): Rows {
  return Object.assign(values, { count })
}

function createClient(resolver: (sql: string, params?: unknown[]) => Rows | Error) {
  const unsafe = vi.fn(async (sql: string, params?: unknown[]) => {
    const result = resolver(sql, params)
    if (result instanceof Error) throw result
    return result
  })
  const client = {
    unsafe,
    begin: vi.fn(),
    end: vi.fn(async () => undefined),
  }
  client.begin.mockImplementation(async (handler: (tx: { unsafe: typeof unsafe }) => Promise<unknown>) => handler(client))
  return client
}

describe('db query tools', () => {
  const captured: IntegrationUsageRecord[] = []
  let client: ReturnType<typeof createClient>

  beforeEach(async () => {
    captured.length = 0
    vi.mocked(getCredentialByName).mockReset()
    vi.mocked(getCredentialByName).mockResolvedValue({ secretRef: 'CUSTOMER_DATABASE_URL' } as never)
    process.env.CUSTOMER_DATABASE_URL = 'postgres://user:secret@example.com/customer'
    _resetIntegrationUsageRecorderForTests()
    setIntegrationUsageRecorder((record) => { captured.push(record) })
    await _resetExternalDbClientsForTests()
    client = createClient((sql) => {
      if (sql.startsWith('set local statement_timeout')) return rows([])
      if (sql.includes('information_schema.columns')) return rows([
        { table_schema: 'public', table_name: 'customers', column_name: 'id', data_type: 'text', is_nullable: 'NO', ordinal_position: 1 },
        { table_schema: 'public', table_name: 'customers', column_name: 'email', data_type: 'text', is_nullable: 'YES', ordinal_position: 2 },
      ])
      return rows([{ id: 'cus_1', active: true }], 1)
    })
    _setExternalDbClientFactoryForTests(() => client as never)
    _resetEngineRateLimiterForTests()
  })

  afterEach(() => {
    _resetEngineRateLimiterForTests()
  })

  it('describes table columns through an org-scoped postgres credential', async () => {
    const result = await dbSchemaDescribeTool.execute(
      { credential: 'customer-db', schema: 'public', tables: ['customers'] },
      {},
      { orgId: 'org-1', runId: 'run-1', nodeId: 'describe' },
    )

    expect(result.ok).toBe(true)
    expect(result.tables).toEqual([
      expect.objectContaining({
        schema: 'public',
        name: 'customers',
        columns: expect.arrayContaining([expect.objectContaining({ name: 'id', nullable: false })]),
      }),
    ])
    expect(getCredentialByName).toHaveBeenCalledWith('org-1', 'postgres', 'customer-db')
    expect(client.unsafe).toHaveBeenCalledWith(expect.stringContaining('information_schema.columns'), ['public', ['customers']])
    expect(captured.at(-1)).toMatchObject({ orgId: 'org-1', tool: 'db.schema.describe', credentialName: 'customer-db', ok: true })
  })

  it('runs a bounded parameterized SELECT and records usage', async () => {
    const result = await dbQueryReadTool.execute(
      { credential: 'customer-db', sql: 'select id, active from customers where status = $1', params: ['active'], maxRows: 10 },
      {},
      { orgId: 'org-1', runId: 'run-1', nodeId: 'read' },
    )

    expect(result).toMatchObject({ ok: true, rowCount: 1, rows: [{ id: 'cus_1', active: true }], truncated: false })
    expect(client.begin).toHaveBeenCalledTimes(1)
    expect(client.unsafe).toHaveBeenCalledWith(
      'select * from (select id, active from customers where status = $1) as janusly_db_query limit 11',
      ['active'],
    )
    expect(captured.at(-1)).toMatchObject({ orgId: 'org-1', tool: 'db.query.read', credentialName: 'customer-db', ok: true })
  })

  it('rate-limits each org credential bucket without exposing the credential name', async () => {
    const limiter = vi.fn(async (_bucket: string, _orgId: string, _options: { windowMs: number; max: number }) => undefined)
    setEngineRateLimiter(limiter)

    await dbQueryReadTool.execute(
      { credential: 'customer-db', sql: 'select id from customers', params: [] },
      {},
      { orgId: 'org-1', integrations: { db: { rateLimitPerMin: 12 } } },
    )
    await dbQueryReadTool.execute(
      { credential: 'reporting-db', sql: 'select id from customers', params: [] },
      {},
      { orgId: 'org-1', integrations: { db: { rateLimitPerMin: 12 } } },
    )

    expect(limiter).toHaveBeenCalledTimes(2)
    expect(limiter).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^tool\.db\.query\.read\.[a-f0-9]{16}$/),
      'org-1',
      { windowMs: 60_000, max: 12 },
    )
    const [firstBucket] = limiter.mock.calls[0]!
    const [secondBucket] = limiter.mock.calls[1]!
    expect(firstBucket).not.toContain('customer-db')
    expect(secondBucket).not.toContain('reporting-db')
    expect(secondBucket).not.toBe(firstBucket)
  })

  it('rejects semicolon injection before connecting', async () => {
    const result = await dbQueryReadTool.execute(
      { credential: 'customer-db', sql: 'select * from customers; drop table customers', params: [] },
      {},
      { orgId: 'org-1', nodeId: 'read' },
    )

    expect(result.ok).toBe(false)
    expect(result.error).toContain('no semicolon')
    expect(client.unsafe).not.toHaveBeenCalled()
    expect(captured.at(-1)).toMatchObject({ tool: 'db.query.read', ok: false })
  })

  it('rejects placeholder gaps and write/read verb mismatches', async () => {
    await expect(dbQueryReadTool.execute(
      { credential: 'customer-db', sql: 'select * from customers where id = $2', params: ['unused', 'cus_1'] },
      {},
      { orgId: 'org-1' },
    )).resolves.toMatchObject({ ok: false, error: expect.stringContaining('contiguous') })

    await expect(dbQueryWriteTool.execute(
      { credential: 'customer-db', sql: 'select * from customers', params: [] },
      {},
      { orgId: 'org-1' },
    )).resolves.toMatchObject({ ok: false, error: expect.stringContaining('INSERT, UPDATE, or DELETE') })
  })

  it('runs transaction statements inside one transaction', async () => {
    const result = await dbQueryTransactionTool.execute(
      {
        credential: 'customer-db',
        statements: [
          { sql: 'update customers set active = $1 where id = $2', params: [true, 'cus_1'] },
          { sql: 'select id, active from customers where id = $1', params: ['cus_1'] },
        ],
      },
      {},
      { orgId: 'org-1', runId: 'run-1', nodeId: 'tx' },
    )

    expect(result).toMatchObject({ ok: true, results: [{ rowCount: 1 }, { rows: [{ id: 'cus_1', active: true }] }] })
    expect(client.begin).toHaveBeenCalledTimes(1)
    expect(client.unsafe).toHaveBeenCalledWith('update customers set active = $1 where id = $2', [true, 'cus_1'])
    expect(client.unsafe).toHaveBeenCalledWith('select * from (select id, active from customers where id = $1) as janusly_db_query limit 101', ['cus_1'])
  })

  it('never echoes postgres URLs from runtime failures', async () => {
    client = createClient(() => new Error(`could not connect to ${process.env.CUSTOMER_DATABASE_URL}`))
    _setExternalDbClientFactoryForTests(() => client as never)

    const result = await dbQueryReadTool.execute(
      { credential: 'customer-db', sql: 'select id from customers', params: [] },
      {},
      { orgId: 'org-1' },
    )

    expect(result.ok).toBe(false)
    expect(result.error).not.toContain('postgres://')
    expect(result.error).not.toContain('secret')
    expect(result.error).toContain('[REDACTED_POSTGRES_URL]')
  })

  it('returns an envelope when credential resolution throws', async () => {
    vi.mocked(getCredentialByName).mockRejectedValueOnce(
      new Error(`lookup failed for ${process.env.CUSTOMER_DATABASE_URL}`),
    )

    const result = await dbQueryReadTool.execute(
      { credential: 'customer-db', sql: 'select id from customers', params: [] },
      {},
      { orgId: 'org-1' },
    )

    expect(result.ok).toBe(false)
    expect(result.error).not.toContain('postgres://')
    expect(client.unsafe).not.toHaveBeenCalled()
    expect(captured.at(-1)).toMatchObject({ tool: 'db.query.read', ok: false })
  })
})
