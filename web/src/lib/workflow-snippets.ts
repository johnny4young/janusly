/**
 * Workflow snippets library — composable node+edge fragments an operator
 * drops into a workflow being edited.
 *
 * Two flavours share one shape:
 *  1. **Built-in snippets** live in CODE (`BUILTIN_SNIPPETS` in the catalog module), are
 *     read-only, ship with every install, and carry EN/ES display copy.
 *  2. **Custom snippets** live in the `snippets` table per org and are
 *     authored through `POST /snippets` (admin only). The DB row matches
 *     `SnippetDefinitionSchema`.
 *
 * A snippet is NOT a runnable workflow — it has no trigger and never runs
 * standalone. Insertion is a PURE delta (`insertSnippet`) on the workflow
 * JSON the operator is currently editing: every snippet node gets a fresh
 * id (collisions with the existing graph are resolved), the snippet's own
 * internal edges are rewritten to the fresh ids, and (optionally) one
 * stitch edge wires the snippet's entry node to an operator-selected
 * target node already on the canvas.
 *
 * Pure, zero-I/O, zero runtime deps beyond `zod` — safe to import from the
 * web bundle + engine + api + data.
 *
 * Used by:
 *  - Backend snippet storage (custom-snippet CRUD; validates rows)
 *  - `internal/httpapi/productsurface.go` snippets routes (list built-ins + custom; create)
 *  - `web/src/components/SnippetInsertMenu.tsx` (Inspector "Insert snippet…")
 *  - `web/src/App.tsx` (Cmd+K palette → insert)
 *
 * Invariants:
 *  - `category` is the closed `SNIPPET_CATEGORIES` enum; adding a value is
 *    a one-line change here AND a new EN/ES `snippets.category.<value>`
 *    copy key on the web.
 *  - Built-in snippet ids are stable string slugs (`retry-with-backoff`,
 *    …). They are namespaced `builtin:<slug>` on the wire so a custom
 *    snippet can never shadow a built-in id.
 *  - `insertSnippet` NEVER mutates its inputs; it returns a fresh workflow
 *    plus the list of inserted node ids so the caller can select / focus.
 *  - Node `type` strings inside snippet templates are intentionally NOT
 *    validated against the engine's closed `nodeTypeValues` here — the
 *    inserted workflow re-validates through `WorkflowSchema` downstream.
 *    Keeping this module free of the node-type enum avoids a circular
 *    dependency on the workflow schema for a value-only constant.
 */

import * as z from 'zod/mini'

import { SNIPPET_CATEGORIES, SNIPPET_MAX_NODES, SNIPPET_MAX_EDGES, SNIPPET_MAX_TAGS } from './workflow-snippets-values'
export * from './workflow-snippets-values'
export * from './workflow-snippets-catalog'

// ---------- category ----------

/**
 * Closed set of snippet categories. `custom` is the catch-all for
 * org-authored snippets; the other five group the built-ins by intent.
 */
export const SnippetCategorySchema = /* @__PURE__ */ z.enum(SNIPPET_CATEGORIES)

// ---------- node / edge template shapes ----------

/**
 * A snippet node template. `id` is LOCAL to the snippet (it only has to be
 * unique within the snippet) — `insertSnippet` rewrites it to a fresh,
 * globally-unique id at insertion time. `config` is an opaque per-node
 * record, the same `Record<string, unknown>` the engine node config uses.
 */
export const SnippetNodeSchema = /* @__PURE__ */ z.object({
  id: z.string().check(z.trim(), z.minLength(1)),
  type: z.string().check(z.trim(), z.minLength(1)),
  config: z._default(z.record(z.string(), z.unknown()), {}),
})
export type SnippetNode = z.infer<typeof SnippetNodeSchema>

/**
 * A snippet-internal edge template. `from`/`to` reference the snippet's
 * LOCAL node ids; `insertSnippet` remaps them to the fresh ids.
 */
export const SnippetEdgeSchema = /* @__PURE__ */ z.object({
  from: z.string().check(z.trim(), z.minLength(1)),
  to: z.string().check(z.trim(), z.minLength(1)),
  condition: z.optional(z.string().check(z.trim(), z.minLength(1))),
})
export type SnippetEdge = z.infer<typeof SnippetEdgeSchema>

// ---------- snippet definition ----------

/**
 * The canonical snippet shape (built-in OR custom). `entryNodeId` names
 * the snippet's local entry node — the one a stitch edge connects FROM the
 * operator-selected target node INTO. When omitted, the first node is the
 * entry. `id` is `builtin:<slug>` for built-ins and a UUID for custom rows.
 */
export const SnippetDefinitionSchema = /* @__PURE__ */ z.object({
  id: z.string().check(z.trim(), z.minLength(1)),
  name: z.string().check(z.trim(), z.minLength(1), z.maxLength(120)),
  description: z._default(z.string().check(z.trim(), z.maxLength(400)), ''),
  category: SnippetCategorySchema,
  tags: z._default(
    z
      .array(z.string().check(z.trim(), z.minLength(1), z.maxLength(40)))
      .check(z.maxLength(SNIPPET_MAX_TAGS)),
    [],
  ),
  builtin: z._default(z.boolean(), false),
  nodes: z.array(SnippetNodeSchema).check(z.minLength(1), z.maxLength(SNIPPET_MAX_NODES)),
  edges: z._default(z.array(SnippetEdgeSchema).check(z.maxLength(SNIPPET_MAX_EDGES)), []),
  /** Local id of the snippet's entry node; defaults to `nodes[0].id`. */
  entryNodeId: z.optional(z.string().check(z.trim(), z.minLength(1))),
})
export type SnippetDefinition = z.infer<typeof SnippetDefinitionSchema>

/**
 * Create-body for `POST /snippets`. Built-ins are code-only, so the
 * create surface forbids `builtin: true` and forbids the `custom` category
 * being anything else — every org-authored snippet is `builtin: false`.
 * `id` is server-assigned (not accepted from the client).
 */
export const CreateSnippetBodySchema = /* @__PURE__ */ z.object({
  name: z.string().check(z.trim(), z.minLength(1), z.maxLength(120)),
  description: z._default(z.string().check(z.trim(), z.maxLength(400)), ''),
  category: SnippetCategorySchema,
  tags: z._default(
    z
      .array(z.string().check(z.trim(), z.minLength(1), z.maxLength(40)))
      .check(z.maxLength(SNIPPET_MAX_TAGS)),
    [],
  ),
  nodes: z.array(SnippetNodeSchema).check(z.minLength(1), z.maxLength(SNIPPET_MAX_NODES)),
  edges: z._default(z.array(SnippetEdgeSchema).check(z.maxLength(SNIPPET_MAX_EDGES)), []),
  entryNodeId: z.optional(z.string().check(z.trim(), z.minLength(1))),
})

/**
 * Update-body for `POST /snippets/:id`. Every field optional — only the
 * provided fields are written. `category` stays the closed enum.
 */
export const UpdateSnippetBodySchema = /* @__PURE__ */ z.object({
  name: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(120))),
  description: z.optional(z.string().check(z.trim(), z.maxLength(400))),
  category: z.optional(SnippetCategorySchema),
  tags: z.optional(
    z
      .array(z.string().check(z.trim(), z.minLength(1), z.maxLength(40)))
      .check(z.maxLength(SNIPPET_MAX_TAGS)),
  ),
  nodes: z.optional(
    z.array(SnippetNodeSchema).check(z.minLength(1), z.maxLength(SNIPPET_MAX_NODES)),
  ),
  edges: z.optional(z.array(SnippetEdgeSchema).check(z.maxLength(SNIPPET_MAX_EDGES))),
  entryNodeId: z.optional(z.string().check(z.trim(), z.minLength(1))),
})
