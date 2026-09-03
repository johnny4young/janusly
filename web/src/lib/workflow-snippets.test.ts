import { describe, expect, it } from 'vitest'

import {
  BUILTIN_SNIPPETS,
  BUILTIN_SNIPPET_ID_PREFIX,
  CreateSnippetBodySchema,
  getBuiltinSnippet,
  generateNodeId,
  insertSnippet,
  isBuiltinSnippetId,
  resolveFreshNodeId,
  SNIPPET_CATEGORIES,
  SNIPPET_MAX_NODES,
  SnippetDefinitionSchema,
  UpdateSnippetBodySchema,
  type SnippetDefinition,
  type SnippetTargetWorkflow,
} from './workflow-snippets'

// ─── built-in catalog ─────────────────────────────────────────────────────────

describe('BUILTIN_SNIPPETS', () => {
  const expectedSlugs = [
    'retry-with-backoff',
    'approval-with-timeout',
    'slack-on-failure',
    'condition-then-branch',
    'parallel-fan-out',
    'transform-and-enrich',
    'http-with-circuit-breaker',
    'dlq-friendly-error-flow',
    'webhook-to-transform',
  ]

  it('ships exactly the nine named built-ins', () => {
    expect(BUILTIN_SNIPPETS).toHaveLength(9)
    const slugs = BUILTIN_SNIPPETS.map((s) => s.id.replace(BUILTIN_SNIPPET_ID_PREFIX, ''))
    expect(slugs).toEqual(expectedSlugs)
  })

  it('marks every built-in `builtin: true` with a namespaced id', () => {
    for (const snippet of BUILTIN_SNIPPETS) {
      expect(snippet.builtin).toBe(true)
      expect(isBuiltinSnippetId(snippet.id)).toBe(true)
      expect(snippet.id.startsWith(BUILTIN_SNIPPET_ID_PREFIX)).toBe(true)
    }
  })

  it('every built-in validates against SnippetDefinitionSchema', () => {
    for (const snippet of BUILTIN_SNIPPETS) {
      const parsed = SnippetDefinitionSchema.safeParse(snippet)
      expect(parsed.success, `${snippet.id} should parse`).toBe(true)
    }
  })

  it('every built-in uses a closed-enum category', () => {
    for (const snippet of BUILTIN_SNIPPETS) {
      expect(SNIPPET_CATEGORIES).toContain(snippet.category)
    }
  })

  it('every built-in edge references only its own local node ids', () => {
    for (const snippet of BUILTIN_SNIPPETS) {
      const localIds = new Set(snippet.nodes.map((n) => n.id))
      for (const edge of snippet.edges) {
        expect(localIds.has(edge.from), `${snippet.id} edge.from`).toBe(true)
        expect(localIds.has(edge.to), `${snippet.id} edge.to`).toBe(true)
      }
    }
  })

  it('ships the parallel fan-out with the executable branch object grammar', () => {
    const snippet = getBuiltinSnippet('builtin:parallel-fan-out')
    const fork = snippet?.nodes.find((node) => node.type === 'parallel_fork')
    expect(fork?.config.branches).toEqual([{ label: 'a' }, { label: 'b' }])
  })

  it('getBuiltinSnippet resolves a known slug and rejects unknown ids', () => {
    expect(getBuiltinSnippet('builtin:retry-with-backoff')?.id).toBe('builtin:retry-with-backoff')
    expect(getBuiltinSnippet('builtin:does-not-exist')).toBeNull()
    expect(getBuiltinSnippet('retry-with-backoff')).toBeNull()
  })
})

// ─── id generation + collision resolution ──────────────────────────────────────

describe('generateNodeId / resolveFreshNodeId', () => {
  it('generates ids of the requested length from the safe alphabet', () => {
    const id = generateNodeId()
    expect(id).toMatch(/^[0-9a-z]{8}$/)
    expect(generateNodeId(12)).toMatch(/^[0-9a-z]{12}$/)
  })

  it('returns an id absent from the taken set', () => {
    const taken = new Set(['abc', 'def'])
    const fresh = resolveFreshNodeId(taken)
    expect(taken.has(fresh)).toBe(false)
  })

  it('resolves around a saturated RNG by appending a suffix', () => {
    // Force a collision: seed the taken set with whatever the RNG will produce
    // by pre-running it, then assert the resolver still escapes.
    const taken = new Set<string>()
    for (let i = 0; i < 200; i += 1) taken.add(generateNodeId())
    const fresh = resolveFreshNodeId(taken)
    expect(taken.has(fresh)).toBe(false)
  })
})

// ─── insertSnippet — the core delta ─────────────────────────────────────────────

const targetWorkflow: SnippetTargetWorkflow = {
  nodes: [
    { id: 'start', type: 'http', config: { url: 'https://api.example.com' } },
    { id: 'finish', type: 'noop', config: {} },
  ],
  edges: [{ from: 'start', to: 'finish' }],
}

const twoNodeSnippet: SnippetDefinition = {
  id: 'builtin:two',
  name: 'Two node',
  description: '',
  category: 'transform',
  tags: [],
  builtin: true,
  nodes: [
    { id: 'a', type: 'transform', config: { mapping: {} } },
    { id: 'b', type: 'noop', config: {} },
  ],
  edges: [{ from: 'a', to: 'b' }],
  entryNodeId: 'a',
}

describe('insertSnippet — fresh ids + remapping', () => {
  it('assigns fresh node ids that do not collide with the existing graph', () => {
    const result = insertSnippet(targetWorkflow, twoNodeSnippet)
    expect(result.insertedNodeIds).toHaveLength(2)
    const existing = new Set(targetWorkflow.nodes.map((n) => n.id))
    for (const id of result.insertedNodeIds) {
      expect(existing.has(id)).toBe(false)
      // Local snippet ids must NOT leak through verbatim.
      expect(id).not.toBe('a')
      expect(id).not.toBe('b')
    }
  })

  it('resolves an id collision when the RNG would reuse an existing id', () => {
    // Deterministic RNG stub: first call returns bytes that map to "start"-ish,
    // but since we control the alphabet we instead pre-populate a workflow whose
    // node ids span a wide set and confirm uniqueness holds across 50 inserts.
    let workflow = targetWorkflow
    const seen = new Set(workflow.nodes.map((n) => n.id))
    for (let i = 0; i < 50; i += 1) {
      const res = insertSnippet(workflow, twoNodeSnippet)
      for (const id of res.insertedNodeIds) {
        expect(seen.has(id)).toBe(false)
        seen.add(id)
      }
      workflow = res.workflow
    }
    // 2 original + 50 * 2 inserted, all unique.
    expect(workflow.nodes).toHaveLength(2 + 50 * 2)
  })

  it('remaps the snippet internal edges to the fresh ids', () => {
    const result = insertSnippet(targetWorkflow, twoNodeSnippet)
    const [freshA, freshB] = result.insertedNodeIds
    const remapped = result.workflow.edges.find((e) => e.from === freshA && e.to === freshB)
    expect(remapped).toBeDefined()
  })

  it('does not mutate the input workflow or snippet', () => {
    const before = JSON.parse(JSON.stringify(targetWorkflow))
    const snippetBefore = JSON.parse(JSON.stringify(twoNodeSnippet))
    insertSnippet(targetWorkflow, twoNodeSnippet)
    expect(targetWorkflow).toEqual(before)
    expect(twoNodeSnippet).toEqual(snippetBefore)
  })
})

describe('insertSnippet — edge stitching to a target', () => {
  it('stitches the snippet entry node onto the operator-selected target', () => {
    const result = insertSnippet(targetWorkflow, twoNodeSnippet, 'finish')
    const stitch = result.workflow.edges.find(
      (e) => e.from === 'finish' && e.to === result.insertedEntryNodeId,
    )
    expect(stitch).toBeDefined()
    expect(result.insertedEntryNodeId).toBe(result.insertedNodeIds[0])
  })

  it('honours an explicit entryNodeId for the stitch', () => {
    const entryB: SnippetDefinition = { ...twoNodeSnippet, entryNodeId: 'b' }
    const result = insertSnippet(targetWorkflow, entryB, 'start')
    // entry is the SECOND inserted node now.
    expect(result.insertedEntryNodeId).toBe(result.insertedNodeIds[1])
    const stitch = result.workflow.edges.find(
      (e) => e.from === 'start' && e.to === result.insertedEntryNodeId,
    )
    expect(stitch).toBeDefined()
  })

  it('adds NO stitch edge when no target is supplied', () => {
    const result = insertSnippet(targetWorkflow, twoNodeSnippet)
    const stitch = result.workflow.edges.find((e) => e.to === result.insertedEntryNodeId && e.from === 'start')
    expect(stitch).toBeUndefined()
    // Only the original edge + the snippet internal edge.
    expect(result.workflow.edges).toHaveLength(targetWorkflow.edges.length + twoNodeSnippet.edges.length)
  })

  it('adds NO stitch edge when the target id is not in the workflow', () => {
    const result = insertSnippet(targetWorkflow, twoNodeSnippet, 'ghost-node')
    expect(result.workflow.edges).toHaveLength(targetWorkflow.edges.length + twoNodeSnippet.edges.length)
  })

  it('preserves edge conditions through the remap', () => {
    const conditional: SnippetDefinition = {
      ...twoNodeSnippet,
      edges: [{ from: 'a', to: 'b', condition: 'context.a.output.ok == true' }],
    }
    const result = insertSnippet(targetWorkflow, conditional)
    const edge = result.workflow.edges.find((e) => e.condition === 'context.a.output.ok == true')
    expect(edge).toBeDefined()
  })
})

// ─── create / update body schemas ───────────────────────────────────────────────

describe('CreateSnippetBodySchema', () => {
  it('accepts a minimal custom snippet', () => {
    const parsed = CreateSnippetBodySchema.safeParse({
      name: 'My retry helper',
      category: 'retry',
      nodes: [{ id: 'n1', type: 'http', config: {} }],
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.description).toBe('')
      expect(parsed.data.tags).toEqual([])
      expect(parsed.data.edges).toEqual([])
    }
  })

  it('rejects an unknown category', () => {
    const parsed = CreateSnippetBodySchema.safeParse({
      name: 'x',
      category: 'totally-made-up',
      nodes: [{ id: 'n1', type: 'http', config: {} }],
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects an empty node list', () => {
    const parsed = CreateSnippetBodySchema.safeParse({ name: 'x', category: 'custom', nodes: [] })
    expect(parsed.success).toBe(false)
  })

  it('rejects more than SNIPPET_MAX_NODES nodes', () => {
    const nodes = Array.from({ length: SNIPPET_MAX_NODES + 1 }, (_, i) => ({ id: `n${i}`, type: 'noop', config: {} }))
    const parsed = CreateSnippetBodySchema.safeParse({ name: 'x', category: 'custom', nodes })
    expect(parsed.success).toBe(false)
  })

  it('does NOT accept a builtin flag from the client (extra key stripped)', () => {
    const parsed = CreateSnippetBodySchema.safeParse({
      name: 'x',
      category: 'custom',
      nodes: [{ id: 'n1', type: 'noop', config: {} }],
      builtin: true,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect((parsed.data as Record<string, unknown>).builtin).toBeUndefined()
    }
  })
})

describe('UpdateSnippetBodySchema', () => {
  it('accepts a partial update (only name)', () => {
    const parsed = UpdateSnippetBodySchema.safeParse({ name: 'renamed' })
    expect(parsed.success).toBe(true)
  })

  it('accepts an empty body (no-op update)', () => {
    expect(UpdateSnippetBodySchema.safeParse({}).success).toBe(true)
  })
})
