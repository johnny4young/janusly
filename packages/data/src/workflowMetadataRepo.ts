/**
 * Repository for the `workflow_metadata` table — per-workflow owners,
 * runbook Markdown, description, tags, Slack / Linear coordinates, and
 * default severity.
 *
 * One row per `(orgId, workflowId)` triple. The unique index makes
 * `upsertWorkflowMetadata` safe under concurrent operator edits — Postgres
 * serialises the INSERT ON CONFLICT. The repo returns the previous row
 * on every upsert so the API can write a `workflow.metadata.set` audit row
 * with `{ before, after }` for traceability.
 *
 * Used by:
 *  - `apps/api/src/routes/workflow-metadata-routes.ts` (GET + POST)
 *  - `apps/api/src/workflow-metadata-bootstrap.ts` (DI seam wiring)
 *  - `apps/api/src/routes/recovery-items-routes.ts` (owner default on assign)
 *
 * Invariants:
 *  - Every read filters by `orgId`. No helper bypasses the predicate.
 *  - `upsertWorkflowMetadata` is the SOLE write path; closed-enum
 *    validation lives in `@janusly/shared/src/workflow-metadata` (Zod).
 *  - The repo doesn't re-validate inputs.
 */

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db, workflowMetadata } from "@janusly/db";
import type { WorkflowMetadata, WorkflowMetadataRecord } from "@janusly/shared";

/** Upper bound on the distinct-tag dropdown so a pathological org can't return an unbounded list. */
const WORKFLOW_TAGS_DROPDOWN_MAX = 500;

/** Upper bound on the distinct-folder dropdown so a pathological org can't return an unbounded list. */
const WORKFLOW_FOLDERS_DROPDOWN_MAX = 500;

type WorkflowMetadataRow = typeof workflowMetadata.$inferSelect;

function hydrate(row: WorkflowMetadataRow): WorkflowMetadataRecord {
  return {
    workflowId: row.workflowId,
    owners: Array.isArray(row.owners) ? (row.owners as string[]) : [],
    runbookMarkdown: row.runbookMarkdown,
    description: row.description,
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    folder: row.folder ?? null,
    slackChannel: row.slackChannel,
    linearProject: row.linearProject,
    severityDefault:
      row.severityDefault === "p1" ||
      row.severityDefault === "p2" ||
      row.severityDefault === "p3" ||
      row.severityDefault === "p4"
        ? row.severityDefault
        : null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Single-row read; returns null when no metadata exists. */
export async function getWorkflowMetadata(
  orgId: string,
  workflowId: string,
): Promise<WorkflowMetadataRecord | null> {
  const rows = await db
    .select()
    .from(workflowMetadata)
    .where(
      and(
        eq(workflowMetadata.orgId, orgId),
        eq(workflowMetadata.workflowId, workflowId),
      ),
    )
    .limit(1);
  return rows[0] ? hydrate(rows[0]) : null;
}

/** Recent-updates feed for an org (admin debugging UI). Capped at 100 by default. */
export async function listWorkflowMetadataForOrg(
  orgId: string,
  limit = 50,
): Promise<WorkflowMetadataRecord[]> {
  const safeLimit = Math.min(Math.max(1, limit), 100);
  const rows = await db
    .select()
    .from(workflowMetadata)
    .where(eq(workflowMetadata.orgId, orgId))
    .orderBy(desc(workflowMetadata.updatedAt))
    .limit(safeLimit);
  return rows.map(hydrate);
}

/**
 * The distinct set of tags used across an org's workflows, sorted ascending —
 * powers the workflow-list tag-filter dropdown. Flattens every
 * `workflow_metadata.tags` jsonb array via `jsonb_array_elements_text`, dedupes,
 * and caps the result. Org-scoped (a tag from another org never appears).
 */
export async function listDistinctWorkflowTagsForOrg(orgId: string): Promise<string[]> {
  // ORDER BY the SRF expression itself, NOT the result alias — drizzle emits a
  // raw-sql `selectDistinct` field without an `AS tag`, so `ORDER BY tag` would
  // reference a non-existent column.
  const rows = await db
    .selectDistinct({ tag: sql<string>`jsonb_array_elements_text(${workflowMetadata.tags})` })
    .from(workflowMetadata)
    .where(eq(workflowMetadata.orgId, orgId))
    .orderBy(sql`jsonb_array_elements_text(${workflowMetadata.tags}) asc`)
    .limit(WORKFLOW_TAGS_DROPDOWN_MAX);
  return rows.map((r) => r.tag);
}

/**
 * The distinct set of folders used across an org's workflows, sorted ascending —
 * powers the workflow-list folder-filter dropdown. Folder is a scalar column, so
 * this is a plain `selectDistinct` on it (no jsonb unnest) filtered to non-null
 * values. Org-scoped (a folder from another org never appears).
 */
export async function listDistinctWorkflowFoldersForOrg(orgId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ folder: workflowMetadata.folder })
    .from(workflowMetadata)
    .where(and(eq(workflowMetadata.orgId, orgId), isNotNull(workflowMetadata.folder)))
    .orderBy(workflowMetadata.folder)
    .limit(WORKFLOW_FOLDERS_DROPDOWN_MAX);
  // `isNotNull` guarantees non-null, but narrow defensively for the string[] return.
  return rows.map((r) => r.folder).filter((f): f is string => f !== null);
}

export type UpsertWorkflowMetadataInput = {
  orgId: string;
  workflowId: string;
  metadata: WorkflowMetadata;
  actorUserId: string | null;
};

/**
 * INSERT … ON CONFLICT DO UPDATE on `(orgId, workflowId)`. Returns the
 * full new row plus the previous one (when present) so the API can
 * audit `{ before, after }` without an extra round-trip.
 */
export async function upsertWorkflowMetadata(
  input: UpsertWorkflowMetadataInput,
): Promise<{ record: WorkflowMetadataRecord; previous: WorkflowMetadataRecord | null }> {
  const previous = await getWorkflowMetadata(input.orgId, input.workflowId);

  const id = previous ? `existing-${input.workflowId}` : crypto.randomUUID();
  const now = new Date();

  await db
    .insert(workflowMetadata)
    .values({
      id,
      orgId: input.orgId,
      workflowId: input.workflowId,
      owners: input.metadata.owners ?? [],
      runbookMarkdown: input.metadata.runbookMarkdown ?? null,
      description: input.metadata.description ?? null,
      tags: input.metadata.tags ?? [],
      folder: input.metadata.folder ?? null,
      slackChannel: input.metadata.slackChannel ?? null,
      linearProject: input.metadata.linearProject ?? null,
      severityDefault: input.metadata.severityDefault ?? null,
      createdBy: input.actorUserId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [workflowMetadata.orgId, workflowMetadata.workflowId],
      set: {
        owners: input.metadata.owners ?? [],
        runbookMarkdown: input.metadata.runbookMarkdown ?? null,
        description: input.metadata.description ?? null,
        tags: input.metadata.tags ?? [],
        folder: input.metadata.folder ?? null,
        slackChannel: input.metadata.slackChannel ?? null,
        linearProject: input.metadata.linearProject ?? null,
        severityDefault: input.metadata.severityDefault ?? null,
        updatedAt: now,
      },
    });

  const record = await getWorkflowMetadata(input.orgId, input.workflowId);
  if (!record) throw new Error("workflow_metadata row missing immediately after upsert");
  return { record, previous };
}

/** Input for the narrow folder-only writer. `folder` of `null` ungroups the workflow. */
export type SetWorkflowFolderInput = {
  orgId: string;
  workflowId: string;
  folder: string | null;
  actorUserId: string | null;
};

/**
 * Reassign ONLY a workflow's `folder` without touching the rest of its
 * metadata. Atomic `INSERT … ON CONFLICT DO UPDATE` whose conflict `set`
 * carries just `{ folder, updatedAt }` — owners / tags / runbook / Slack /
 * Linear / severity on an existing row are left intact. When no row exists yet
 * it inserts a defaults row carrying only the folder. Returns the previous row
 * (when present) alongside the new one so the API can audit `{ before, after }`
 * without an extra round-trip, mirroring `upsertWorkflowMetadata`.
 *
 * This is the SOLE narrow folder writer (the Flows-list drag-to-folder path);
 * a full-object `upsertWorkflowMetadata` from a surface that only knows the
 * folder would clobber every other field, which is exactly what this avoids.
 */
export async function setWorkflowFolder(
  input: SetWorkflowFolderInput,
): Promise<{ record: WorkflowMetadataRecord; previous: WorkflowMetadataRecord | null }> {
  const previous = await getWorkflowMetadata(input.orgId, input.workflowId);
  const now = new Date();

  await db
    .insert(workflowMetadata)
    .values({
      id: previous ? `existing-${input.workflowId}` : crypto.randomUUID(),
      orgId: input.orgId,
      workflowId: input.workflowId,
      owners: [],
      runbookMarkdown: null,
      description: null,
      tags: [],
      folder: input.folder,
      slackChannel: null,
      linearProject: null,
      severityDefault: null,
      createdBy: input.actorUserId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [workflowMetadata.orgId, workflowMetadata.workflowId],
      // ONLY the folder + updatedAt move on conflict — every other column on an
      // existing row is deliberately untouched.
      set: { folder: input.folder, updatedAt: now },
    });

  const record = await getWorkflowMetadata(input.orgId, input.workflowId);
  if (!record) throw new Error("workflow_metadata row missing immediately after setWorkflowFolder");
  return { record, previous };
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "AuthContext is Janusly-resolved".
