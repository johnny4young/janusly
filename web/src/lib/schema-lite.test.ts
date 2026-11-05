import { afterEach, describe, expect, it, vi } from 'vitest'
import * as zodMini from 'zod/mini'

import { WorkflowRecoverySchema } from './recovery-contract'
import * as lite from './schema-lite'
import {
  SetWorkflowFolderBodySchema,
  UpsertWorkflowMetadataBodySchema,
  WorkflowMetadataSchema,
} from './workflow-metadata'
import { WorkflowInputSchema } from './value-schema'

function createRandom(seed: number) {
  let state = seed
  return (limit: number) => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state % limit
  }
}

const JUNK = [
  undefined, null, 0, 1, -1, 1.5, 4, 5, 101, NaN, '', ' ', '  padded  ', 'x', true, false, [], {},
  ['retry'], ['retry', 'retry'], { extra: 1 }, 'required', 'autonomous_level_4', 'provider_simulated',
  'live_canary', '#ok-channel', 'acme/project', 'https://linear.app/acme', 'p1', 'y'.repeat(70000),
  JSON.parse('{"__proto__":{"x":1}}'), JSON.parse('{"constructor":1}'), new Date(0), Array(2), [undefined, 'x'],
]

function mutate(value: unknown, random: (limit: number) => number): unknown {
  if (random(5) === 0) return JUNK[random(JUNK.length)]
  if (Array.isArray(value)) {
    const copy = value.map((item) => (random(4) === 0 ? mutate(item, random) : item))
    if (random(6) === 0) copy.pop()
    if (random(6) === 0 && copy.length > 0) copy.push(copy[0])
    return copy
  }
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const roll = random(8)
      if (roll === 0) continue
      copy[key] = roll <= 2 ? mutate(item, random) : item
    }
    if (random(8) === 0) copy.unexpected = JUNK[random(JUNK.length)]
    if (random(10) === 0) {
      Object.defineProperty(copy, '__proto__', { value: { x: 1 }, enumerable: true, configurable: true })
    }
    return copy
  }
  return value
}

const commonContract = {
  evidence: {
    required: ['failure_snapshot', 'audit_trail', 'validation_receipt', 'effect_receipt', 'terminal_outcome'],
  },
  effects: [{ nodeId: ' charge ', kind: 'financial_mutation', idempotency: 'required', receipt: 'provider' }],
  repairs: { allowed: ['retry', 'config_patch', 'rollback'] },
  validation: { minimumEvidenceLevel: 'provider_simulated' },
  verification: { kind: 'generation_bound_terminal_success' },
  recurrence: { windowDays: 7 },
}
const RECOVERY_SEEDS = [
  {},
  { circuitBreaker: false },
  { circuitBreaker: 5 },
  { circuitBreaker: { consecutiveFailures: 3 } },
  {
    contract: {
      ...commonContract,
      version: '1',
      failure: {
        technical: { terminalNodeFailure: true, stalledNode: true, autonomy: { stalledNode: 1 } },
        semantic: { mode: 'disabled' },
      },
      approval: { productionMutation: 'required', permission: 'recovery.write' },
      autonomyLevel: 3,
    },
  },
  {
    circuitBreaker: 2,
    contract: {
      ...commonContract,
      version: '2',
      failure: {
        technical: { terminalNodeFailure: true, stalledNode: false },
        semantic: {
          mode: 'deterministic',
          detectors: [
            { id: 'a', sourceNodeId: 'n', kind: 'expression', passWhen: 'x', action: 'observe', message: 'm' },
            {
              id: 'b',
              sourceNodeId: 'n',
              kind: 'schema',
              action: 'quarantine',
              message: 'm',
              autonomyLevel: 2,
              schema: {
                type: 'object',
                required: ['a'],
                properties: { a: { type: 'array', items: { type: 'string', enum: ['x'] } } },
              },
            },
          ],
          evaluationFixtures: [
            { id: 'p', sourceNodeId: 'n', output: { ok: true }, context: { a: 1 }, expected: 'pass' },
            { id: 'v', sourceNodeId: 'n', output: null, expected: 'violation' },
          ],
        },
      },
      approval: { productionMutation: 'autonomous_level_4', permission: 'recovery.write' },
      autonomyLevel: 4,
      narrowAutonomy: {
        allowedRepairClasses: ['retry'],
        minimumPriorVerifiedRecoveries: 3,
        maxAffectedExecutions: 5,
        rollbackRequired: true,
      },
    },
  },
]
const METADATA_SEEDS = [
  {},
  {
    owners: ['alpha', 'beta'],
    runbookMarkdown: '# runbook',
    aiGuidanceMarkdown: 'Prefer retries',
    description: 'desc',
    tags: ['one'],
    folder: 'ops',
    slackChannel: '#ops',
    linearProject: 'acme/project',
    severityDefault: 'p2',
  },
  { runbookMarkdown: null, aiGuidanceMarkdown: 'api_key=sk-ant-0123456789abcdef', folder: null, tags: [] },
]

type Parser = { safeParse(input: unknown): { success: boolean; data?: unknown } }

function expectSameBehavior(lite: Parser, zod: Parser, seeds: unknown[], rounds: number) {
  const random = createRandom(20261104)
  let accepted = 0
  let rejected = 0
  for (const input of seeds.flatMap((seed) => [seed, ...Array.from({ length: rounds }, () => mutate(seed, random))])) {
    const liteResult = lite.safeParse(input)
    const zodResult = zod.safeParse(input)
    if (liteResult.success !== zodResult.success) {
      throw new Error(`zod ${zodResult.success ? 'accepted' : 'rejected'}: ${JSON.stringify(input)?.slice(0, 2000)}`)
    }
    if (zodResult.success) expect(liteResult.data).toStrictEqual(zodResult.data)
    if (zodResult.success) accepted += 1
    else rejected += 1
  }
  expect(accepted).toBeGreaterThan(seeds.length)
  expect(rejected).toBeGreaterThan(rounds)
}

describe('schema-lite parity with zod/mini', () => {
  afterEach(() => {
    vi.doUnmock('./schema-lite')
    vi.resetModules()
  })

  async function zodBuilt<T>(path: string): Promise<T> {
    vi.resetModules()
    vi.doMock('./schema-lite', () => import('zod/mini'))
    return await import(/* @vite-ignore */ path) as T
  }

  it('matches on mutated workflow recovery policies', async () => {
    const zodModule = await zodBuilt<{ WorkflowRecoverySchema: Parser }>('./recovery-contract')
    expect(zodModule.WorkflowRecoverySchema).toHaveProperty('_zod')
    expect(WorkflowRecoverySchema).not.toHaveProperty('_zod')
    expectSameBehavior(WorkflowRecoverySchema, zodModule.WorkflowRecoverySchema, RECOVERY_SEEDS, 1500)
  })

  it('matches on mutated workflow metadata', async () => {
    const zodModule = await zodBuilt<{ WorkflowMetadataSchema: Parser }>('./workflow-metadata-schema')
    expect(zodModule.WorkflowMetadataSchema).toHaveProperty('_zod')
    expectSameBehavior(WorkflowMetadataSchema, zodModule.WorkflowMetadataSchema, METADATA_SEEDS, 1500)
  })

  it('matches on mutated metadata write bodies', async () => {
    const zodModule = await zodBuilt<Record<string, Parser>>('./workflow-metadata')
    const upsert = zodModule.UpsertWorkflowMetadataBodySchema!
    expectSameBehavior(UpsertWorkflowMetadataBodySchema, upsert, METADATA_SEEDS.map((metadata) => ({ metadata })), 1500)
    const folder = zodModule.SetWorkflowFolderBodySchema!
    expectSameBehavior(SetWorkflowFolderBodySchema, folder, [{ folder: 'ops' }, { folder: null }], 1500)
  })

  it('matches on mutated workflow input schemas', async () => {
    const zodModule = await zodBuilt<{ WorkflowInputSchema: Parser }>('./value-schema')
    const seed = { type: 'object', required: ['a'], properties: { a: { type: 'array', items: { type: 'string', enum: ['x'] } } } }
    const seeds = [seed, { type: 'string', default: 'x' }, { type: 'number', description: 'n' }, { type: 'array', items: seed }]
    expectSameBehavior(WorkflowInputSchema, zodModule.WorkflowInputSchema, seeds, 1500)
  })

  type Builder = typeof lite
  const edgeCases: Array<[string, (z: Builder) => Parser, unknown]> = [
    ['strict object with an own __proto__ key', (z) => z.strictObject({ a: z.string() }), JSON.parse('{"a":"x","__proto__":{}}')],
    ['loose object with an own __proto__ key', (z) => z.object({ a: z.string() }), JSON.parse('{"a":"x","__proto__":{}}')],
    ['record with an own __proto__ key', (z) => z.record(z.string(), z.unknown()), JSON.parse('{"a":1,"__proto__":{}}')],
    ['array holes', (z) => z.array(z.string()), Array(2)],
    ['record from a Date', (z) => z.record(z.string(), z.unknown()), new Date(0)],
    ['record from a class instance', (z) => z.record(z.string(), z.unknown()), new (class { a = 1 })()],
    ['record without a prototype', (z) => z.record(z.string(), z.unknown()), Object.assign(Object.create(null), { a: 1 })],
    ['record key failing its check', (z) => z.record(z.string().check(z.minLength(3)), z.unknown()), { a: 1 }],
    ['record key outside an enum', (z) => z.record(z.enum(['a']), z.unknown()), { b: 1 }],
    ['optional default', (z) => z.optional(z._default(z.string(), 'd')), undefined],
    ['optional nullable default', (z) => z.optional(z.nullable(z._default(z.string(), 'd'))), undefined],
    ['optional default in an object', (z) => z.object({ a: z.optional(z._default(z.string(), 'd')) }), {}],
    ['checked optional default', (z) => z.optional(z._default(z.string(), 'd').check(z.minLength(1))), undefined],
  ]
  it.each(edgeCases)('matches on %s', (_name, build, input) => {
    const liteResult = build(lite).safeParse(input)
    const zodResult = build(zodMini as unknown as Builder).safeParse(input)
    expect(liteResult.success).toBe(zodResult.success)
    if (zodResult.success) expect(liteResult.data).toStrictEqual(zodResult.data)
  })

  it('matches on a global regex parsed twice', () => {
    for (const z of [lite, zodMini as unknown as Builder]) {
      const pattern = z.string().check(z.regex(/a/g))
      expect(pattern.safeParse('a').success).toBe(true)
      expect(pattern.safeParse('a').success).toBe(true)
    }
  })

  it('copies object defaults between parses', () => {
    for (const z of [lite, zodMini as unknown as Builder]) {
      const withDefault = z._default(z.unknown(), { a: 1 })
      expect(withDefault.safeParse(undefined).data).not.toBe(withDefault.safeParse(undefined).data)
    }
  })
})
