/** Snippet insertion, categories and bounds; recipes and validation stay separate. */

import type { SnippetDefinition } from './workflow-snippets'
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

/** Type guard: is this id a built-in snippet's namespaced id? */
export function isBuiltinSnippetId(id: string): boolean {
  return id.startsWith(BUILTIN_SNIPPET_ID_PREFIX)
}
