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

import { and, desc, eq } from "drizzle-orm";
import { db, workflowMetadata } from "@janusly/db";
import type { WorkflowMetadata, WorkflowMetadataRecord } from "@janusly/shared";

type WorkflowMetadataRow = typeof workflowMetadata.$inferSelect;

function hydrate(row: WorkflowMetadataRow): WorkflowMetadataRecord {
  return {
    workflowId: row.workflowId,
    owners: Array.isArray(row.owners) ? (row.owners as string[]) : [],
    runbookMarkdown: row.runbookMarkdown,
    description: row.description,
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
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

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "Decision engine / RL".
