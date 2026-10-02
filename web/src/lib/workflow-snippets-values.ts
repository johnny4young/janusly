/** Snippet insertion and built-in values; request validation stays in workflow-snippets. */

import type { SnippetNode, SnippetEdge, SnippetDefinition } from './workflow-snippets'
export type { SnippetNode, SnippetEdge, SnippetDefinition } from './workflow-snippets'

export const SNIPPET_CATEGORIES = [
  'retry',
  'approval',
  'error_handling',
  'notification',
  'transform',
  'trigger',
  'custom',
] as const
export type SnippetCategory = (typeof SNIPPET_CATEGORIES)[number]

// ---------- bounds ----------

/** Max nodes a single snippet may carry (built-in or custom). */
export const SNIPPET_MAX_NODES = 20
/** Max edges a single snippet may carry. */
export const SNIPPET_MAX_EDGES = 40
/** Max operator-supplied tags on a custom snippet. */
export const SNIPPET_MAX_TAGS = 10
/** Prefix that namespaces built-in snippet ids on the wire. */
export const BUILTIN_SNIPPET_ID_PREFIX = 'builtin:'

// ---------- id generation (nanoid-shaped, zero-dep) ----------

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const DEFAULT_ID_LENGTH = 8

/**
 * Generate a short, URL-safe, collision-resistant id (nanoid-shaped) using
 * the platform crypto RNG. Works in both Node and the browser without a
 * dependency. The caller still resolves collisions against the existing
 * graph via `resolveFreshNodeId`, so this only needs to be probabilistically
 * unique, not guaranteed.
 */
export function generateNodeId(length = DEFAULT_ID_LENGTH): string {
  const bytes = new Uint8Array(length)
  // `crypto` is a global in Node 24 and every modern browser.
  crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < length; i += 1) {
    out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length]
  }
  return out
}

/**
 * Resolve a fresh node id that does not collide with `taken`. Tries a
 * generated id; on the rare collision, appends a numeric suffix and retries.
 * Mutating callers should add the returned id to `taken` before the next call.
 */
export function resolveFreshNodeId(taken: ReadonlySet<string>): string {
  let candidate = generateNodeId()
  let attempt = 0
  while (taken.has(candidate)) {
    attempt += 1
    candidate = `${generateNodeId()}-${attempt}`
    // Safety valve: a 36^8 space makes this loop effectively never spin,
    // but cap it so a pathological mock RNG can't hang the UI thread.
    if (attempt > 64) {
      candidate = `${generateNodeId(12)}-${attempt}`
      break
    }
  }
  return candidate
}

// ---------- insertion delta ----------

/** Minimal workflow shape `insertSnippet` operates on (subset of `Workflow`). */
export type SnippetTargetWorkflow = {
  nodes: Array<{ id: string; type: string; config?: Record<string, unknown> }>
  edges: Array<{ from: string; to: string; condition?: string }>
}

export type InsertSnippetResult = {
  /** Fresh workflow with the snippet's nodes + edges (and optional stitch) appended. */
  workflow: SnippetTargetWorkflow
  /** The fresh ids of the inserted snippet nodes, in template order. */
  insertedNodeIds: string[]
  /** The fresh id of the snippet's entry node (target of the stitch edge). */
  insertedEntryNodeId: string
}

/**
 * Insert a snippet into a workflow as a pure delta.
 *
 * Steps:
 *  1. For every snippet node, mint a fresh id that does not collide with the
 *     existing graph OR with already-minted snippet ids (id-collision
 *     resolution). Build a `localId → freshId` map.
 *  2. Append the remapped snippet nodes to the workflow's node list.
 *  3. Remap the snippet's internal edges (`from`/`to`) through the map and
 *     append them.
 *  4. When `targetNodeId` is supplied AND exists in the workflow, append ONE
 *     stitch edge `target → entry` so the snippet wires into the selected
 *     node. When `targetNodeId` is null / missing, no stitch edge is added
 *     (the snippet lands disconnected for the operator to wire manually).
 *
 * Never mutates `workflow` or `snippet`.
 */
export function insertSnippet(
  workflow: SnippetTargetWorkflow,
  snippet: Pick<SnippetDefinition, 'nodes' | 'edges' | 'entryNodeId'>,
  targetNodeId?: string | null,
): InsertSnippetResult {
  const taken = new Set<string>(workflow.nodes.map((node) => node.id))
  const idMap = new Map<string, string>()

  const remappedNodes = snippet.nodes.map((node) => {
    const freshId = resolveFreshNodeId(taken)
    taken.add(freshId)
    idMap.set(node.id, freshId)
    return {
      id: freshId,
      type: node.type,
      config: node.config ?? {},
    }
  })

  const remappedEdges = snippet.edges
    // Defensive: drop any edge whose endpoints aren't snippet-local nodes
    // (a malformed custom snippet) rather than stitching to a stale id.
    .filter((edge) => idMap.has(edge.from) && idMap.has(edge.to))
    .map((edge) => ({
      from: idMap.get(edge.from) as string,
      to: idMap.get(edge.to) as string,
      ...(edge.condition ? { condition: edge.condition } : {}),
    }))

  // Resolve the entry node: declared `entryNodeId` if it maps, else the
  // first snippet node.
  const entryLocalId =
    snippet.entryNodeId && idMap.has(snippet.entryNodeId)
      ? snippet.entryNodeId
      : snippet.nodes[0].id
  const insertedEntryNodeId = idMap.get(entryLocalId) as string

  const stitchEdges: SnippetTargetWorkflow['edges'] = []
  if (targetNodeId && workflow.nodes.some((node) => node.id === targetNodeId)) {
    stitchEdges.push({ from: targetNodeId, to: insertedEntryNodeId })
  }

  return {
    workflow: {
      nodes: [...workflow.nodes, ...remappedNodes],
      edges: [...workflow.edges, ...remappedEdges, ...stitchEdges],
    },
    insertedNodeIds: remappedNodes.map((node) => node.id),
    insertedEntryNodeId,
  }
}

// ---------- built-in snippets (code, read-only) ----------

/**
 * The nine built-in snippets that ship with every install. These live in
 * CODE (never the DB), are `builtin: true`, and are surfaced read-only by
 * `GET /snippets`. Their `id`s are `builtin:<slug>`; their display copy is
 * resolved on the web via the EN/ES `snippets.builtin.<slug>.*` keys, so
 * the `name`/`description` here are English fallbacks only.
 *
 * Each snippet's node `config` is a sensible default the operator tunes
 * after insertion. Node-type strings match the engine's closed node-type
 * vocabulary; the inserted workflow re-validates through `WorkflowSchema`.
 */
function builtin(
  slug: string,
  name: string,
  description: string,
  category: SnippetCategory,
  tags: string[],
  nodes: SnippetNode[],
  edges: SnippetEdge[],
  entryNodeId?: string,
): SnippetDefinition {
  return {
    id: `${BUILTIN_SNIPPET_ID_PREFIX}${slug}`,
    name,
    description,
    category,
    tags,
    builtin: true,
    nodes,
    edges,
    ...(entryNodeId ? { entryNodeId } : {}),
  }
}

export const BUILTIN_SNIPPETS: readonly SnippetDefinition[] = [
  builtin(
    'retry-with-backoff',
    'Retry with backoff',
    'An HTTP call wrapped with bounded exponential-backoff retries.',
    'retry',
    ['http', 'resilience'],
    [
      {
        id: 'call',
        type: 'http',
        config: {
          method: 'GET',
          url: 'https://api.example.com/resource',
          retry: { maxAttempts: 4, backoff: 'exponential', delayMs: 500 },
        },
      },
    ],
    [],
    'call',
  ),
  builtin(
    'approval-with-timeout',
    'Approval with timeout',
    'A human approval gate that fails closed when its one-hour decision deadline expires.',
    'approval',
    ['approval', 'human-in-the-loop'],
    [
      {
        id: 'approve',
        type: 'approval',
        config: {
          message: 'Approve before continuing?',
          decisionTimeoutMs: 3_600_000,
          onTimeout: 'fail',
        },
      },
    ],
    [],
    'approve',
  ),
  builtin(
    'slack-on-failure',
    'Slack on failure',
    'Post a Slack message when an upstream step fails (wire the condition edge to your failure branch).',
    'notification',
    ['slack', 'alerting'],
    [
      {
        id: 'notify',
        type: 'tool',
        config: {
          tool: 'slack.post',
          resultPolicy: 'require_ok',
          input: { credential: 'slack_webhook', text: 'A workflow step failed.' },
        },
      },
    ],
    [],
    'notify',
  ),
  builtin(
    'condition-then-branch',
    'Condition then branch',
    'A condition node that splits into a true branch and a false branch.',
    'transform',
    ['condition', 'branching'],
    [
      { id: 'check', type: 'condition', config: { expression: 'context.input.amount > 100' } },
      { id: 'high', type: 'noop', config: {} },
      { id: 'low', type: 'noop', config: {} },
    ],
    [
      { from: 'check', to: 'high', condition: 'context.input.amount > 100' },
      { from: 'check', to: 'low' },
    ],
    'check',
  ),
  builtin(
    'parallel-fan-out',
    'Parallel fan-out',
    'Fork into two parallel branches and join their results.',
    'transform',
    ['parallel', 'fan-out'],
    [
      { id: 'fork', type: 'parallel_fork', config: { branches: [{ label: 'a' }, { label: 'b' }] } },
      { id: 'branch_a', type: 'noop', config: {} },
      { id: 'branch_b', type: 'noop', config: {} },
      { id: 'join', type: 'join', config: { sources: { a: 'branch_a', b: 'branch_b' } } },
    ],
    [
      { from: 'fork', to: 'branch_a' },
      { from: 'fork', to: 'branch_b' },
      { from: 'branch_a', to: 'join' },
      { from: 'branch_b', to: 'join' },
    ],
    'fork',
  ),
  builtin(
    'transform-and-enrich',
    'Transform and enrich',
    'Reshape an upstream payload, then add a deterministic metadata field.',
    'transform',
    ['transform', 'mapping'],
    [
      {
        id: 'shape',
        type: 'transform',
        config: { mapping: { id: '{{context.fetch.output.id}}', total: '{{context.fetch.output.amount}}' } },
      },
      {
        id: 'enrich',
        type: 'tool',
        config: {
          tool: 'json.set',
          input: {
            path: 'metadata.prepared',
            value: true,
            source: '{{context.shape.output}}',
          },
        },
      },
    ],
    [{ from: 'shape', to: 'enrich' }],
    'shape',
  ),
  builtin(
    'http-with-circuit-breaker',
    'HTTP with circuit breaker',
    'An HTTP call guarded by a condition that short-circuits when the upstream is unhealthy.',
    'error_handling',
    ['http', 'circuit-breaker', 'resilience'],
    [
      { id: 'breaker', type: 'condition', config: { expression: 'context.health.output.healthy == true' } },
      {
        id: 'request',
        type: 'http',
        config: {
          method: 'POST',
          url: 'https://api.example.com/action',
        },
      },
      { id: 'short_circuit', type: 'noop', config: { note: 'upstream unhealthy — skipped' } },
    ],
    [
      { from: 'breaker', to: 'request', condition: 'context.health.output.healthy == true' },
      { from: 'breaker', to: 'short_circuit' },
    ],
    'breaker',
  ),
  builtin(
    'dlq-friendly-error-flow',
    'DLQ-friendly error flow',
    'A write action that fails closed into governed recovery without an unsafe blind retry.',
    'error_handling',
    ['dlq', 'error-handling', 'resilience'],
    [
      {
        id: 'action',
        type: 'http',
        config: {
          method: 'POST',
          url: 'https://api.example.com/submit',
        },
      },
    ],
    [],
    'action',
  ),
  builtin(
    'webhook-to-transform',
    'Webhook to transform',
    'Receive a named webhook event and reshape its payload for downstream steps.',
    'trigger',
    ['webhook', 'trigger'],
    [
      { id: 'inbox', type: 'webhook_received', config: { endpointKey: 'orders' } },
      {
        id: 'shape',
        type: 'transform',
        config: { mapping: { total: '{{context.inbox.output.event.payload.total}}' } },
      },
    ],
    [{ from: 'inbox', to: 'shape' }],
    'inbox',
  ),
]

/** Quick lookup by wire id (`builtin:<slug>`). */
const BUILTIN_BY_ID: ReadonlyMap<string, SnippetDefinition> = new Map(
  BUILTIN_SNIPPETS.map((snippet) => [snippet.id, snippet]),
)

/** Resolve a built-in snippet by its `builtin:<slug>` wire id, or null. */
export function getBuiltinSnippet(id: string): SnippetDefinition | null {
  return BUILTIN_BY_ID.get(id) ?? null
}

/** Type guard: is this id a built-in snippet's namespaced id? */
export function isBuiltinSnippetId(id: string): boolean {
  return id.startsWith(BUILTIN_SNIPPET_ID_PREFIX)
}
