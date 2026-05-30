/**
 * Repository for the `snippets` table — org-private reusable workflow
 * snippets (composable node+edge fragments).
 *
 * ONLY custom (org-authored) snippets live in this table. The eight
 * built-in snippets ship in code (`@janusly/shared:BUILTIN_SNIPPETS`) and
 * are NEVER persisted — the API route concatenates them with the custom
 * rows at read time and refuses any write that targets a `builtin:` id.
 *
 * Used by:
 *  - `apps/api/src/routes/snippets-routes.ts` (list / get / create / update / delete)
 *
 * Invariants:
 * - Multi-tenant scope: every read + write filters by `orgId`. No helper
 *   bypasses the predicate.
 * - The unique `(orgId, name)` index rejects duplicate names; the route
 *   checks up-front for a clean 409.
 * - Rows always store `builtin: false` (built-ins are code-only). Closed-enum
 *   `category` + node/edge bounds are validated at the shared/Zod layer
 *   before insert; the repo doesn't re-validate.
 * - Cascade posture: orphan-tolerant (no FK) — see the schema header.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { db, snippets } from "@janusly/db";
import type {
  SnippetCategory,
  SnippetDefinition,
  SnippetEdge,
  SnippetNode,
} from "@janusly/shared";

type SnippetRow = typeof snippets.$inferSelect;

function hydrate(row: SnippetRow): SnippetDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    category: row.category as SnippetCategory,
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    // DB rows are always custom; never trust a stray `true`.
    builtin: false,
    nodes: Array.isArray(row.nodesJson) ? (row.nodesJson as SnippetNode[]) : [],
    edges: Array.isArray(row.edgesJson) ? (row.edgesJson as SnippetEdge[]) : [],
    ...(row.entryNodeId ? { entryNodeId: row.entryNodeId } : {}),
  };
}

// ─── reads ──────────────────────────────────────────────────────────────────

/** List every custom snippet for an org, most-recently-updated first. Capped. */
export async function listSnippets(
  orgId: string,
  limit = 200,
): Promise<SnippetDefinition[]> {
  const safeLimit = Math.min(Math.max(1, limit), 500);
  const rows = await db
    .select()
    .from(snippets)
    .where(eq(snippets.orgId, orgId))
    .orderBy(desc(snippets.updatedAt))
    .limit(safeLimit);
  return rows.map(hydrate);
}

/** Fetch one custom snippet by id, scoped to org. Null when absent. */
export async function getSnippetById(
  orgId: string,
  id: string,
): Promise<SnippetDefinition | null> {
  const rows = await db
    .select()
    .from(snippets)
    .where(and(eq(snippets.orgId, orgId), eq(snippets.id, id)))
    .limit(1);
  return rows[0] ? hydrate(rows[0]) : null;
}

/** Fetch one custom snippet by name, scoped to org (the unique join key). */
export async function findSnippetByName(
  orgId: string,
  name: string,
): Promise<SnippetDefinition | null> {
  const rows = await db
    .select()
    .from(snippets)
    .where(and(eq(snippets.orgId, orgId), sql`lower(${snippets.name}) = lower(${name})`))
    .limit(1);
  return rows[0] ? hydrate(rows[0]) : null;
}

// ─── writes ──────────────────────────────────────────────────────────────────

export type CreateSnippetInput = {
  name: string;
  description: string;
  category: SnippetCategory;
  tags: string[];
  nodes: SnippetNode[];
  edges: SnippetEdge[];
  entryNodeId?: string;
  createdBy: string | null;
};

/**
 * Insert a new custom snippet. The unique `(orgId, name)` index rejects
 * duplicates (the route checks first for a clean 409). Always stores
 * `builtin: false`.
 */
export async function createSnippet(
  orgId: string,
  input: CreateSnippetInput,
): Promise<SnippetDefinition> {
  const id = crypto.randomUUID();
  const now = new Date();
  await db.insert(snippets).values({
    id,
    orgId,
    name: input.name,
    description: input.description,
    category: input.category,
    tags: input.tags,
    builtin: false,
    nodesJson: input.nodes,
    edgesJson: input.edges,
    entryNodeId: input.entryNodeId ?? null,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  });
  const row = await getSnippetById(orgId, id);
  if (!row) throw new Error("snippet row missing immediately after insert");
  return row;
}

export type UpdateSnippetFields = {
  name?: string;
  description?: string;
  category?: SnippetCategory;
  tags?: string[];
  nodes?: SnippetNode[];
  edges?: SnippetEdge[];
  entryNodeId?: string;
};

/**
 * Partial-update a custom snippet by id (only provided fields are written).
 * Returns `{ before, after }` for the audit row, or null when the row is
 * absent. `updatedAt` always bumps.
 */
export async function updateSnippet(
  orgId: string,
  id: string,
  fields: UpdateSnippetFields,
): Promise<{ before: SnippetDefinition; after: SnippetDefinition } | null> {
  const before = await getSnippetById(orgId, id);
  if (!before) return null;

  const set: Partial<typeof snippets.$inferInsert> = { updatedAt: new Date() };
  if (fields.name !== undefined) set.name = fields.name;
  if (fields.description !== undefined) set.description = fields.description;
  if (fields.category !== undefined) set.category = fields.category;
  if (fields.tags !== undefined) set.tags = fields.tags;
  if (fields.nodes !== undefined) set.nodesJson = fields.nodes;
  if (fields.edges !== undefined) set.edgesJson = fields.edges;
  if (fields.entryNodeId !== undefined) set.entryNodeId = fields.entryNodeId;

  await db
    .update(snippets)
    .set(set)
    .where(and(eq(snippets.orgId, orgId), eq(snippets.id, id)));

  const after = await getSnippetById(orgId, id);
  if (!after) return null;
  return { before, after };
}

/** Hard-delete a custom snippet by id. Returns the deleted row for the audit. */
export async function deleteSnippet(
  orgId: string,
  id: string,
): Promise<SnippetDefinition | null> {
  const before = await getSnippetById(orgId, id);
  if (!before) return null;
  await db.delete(snippets).where(and(eq(snippets.orgId, orgId), eq(snippets.id, id)));
  return before;
}

// Multi-tenant invariant: every read/write keeps orgId in the predicate.
