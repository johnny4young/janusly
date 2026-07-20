/**
 * Repository for `trigger_events` rows — structured inbound-trigger events
 * for the event-driven trigger node types (`email_received`, `file_dropped`,
 * `mcp_server_event`).
 *
 * The API ingestion seam (`apps/api/src/routes/trigger-ingest-routes.ts`)
 * persists one `received` row for every accepted inbound event BEFORE the run
 * is spawned. `startRun` consumes `received → started` atomically with run
 * creation; pause, validation, and storm guards move it to their terminal or
 * buffered state. The row is the DLQ-style replay anchor: an operator can
 * re-submit the same normalized `payloadJson` to re-run the workflow.
 *
 * Used by:
 * - `apps/api/src/routes/trigger-ingest-routes.ts` — ingestion + replay.
 *
 * Invariants:
 * - Multi-tenant scope: every function takes `orgId` and filters via
 *   `eq(triggerEvents.orgId, orgId)`. There is NO un-scoped read here — an
 *   inbound event's org is resolved by the seam from the authenticated
 *   caller, never from a claim in the payload.
 * - `recordTriggerEvent` is idempotent on `(orgId, dedupeKey)` via
 *   `ON CONFLICT DO NOTHING` so a relay retry with the same upstream message
 *   id converges to one row (and one run). The `wasCreated` flag tells the
 *   caller whether to spawn a run or short-circuit a duplicate.
 * - Resolution of the matching trigger node walks the org's LATEST active
 *   workflow versions (org-scoped) — drafts and soft-deleted workflows do not
 *   fire.
 */

import { and, asc, desc, eq, lt, or, sql } from "drizzle-orm";
import { db, triggerEvents, workflows, workflowVersions } from "@janusly/db";
import {
  isTriggerNodeType,
  type TriggerEventStatus,
  type TriggerNodeType,
} from "@janusly/shared/src/trigger-types";

export type TriggerEvent = typeof triggerEvents.$inferSelect;

export type RecordTriggerEventInput = {
  orgId: string;
  triggerType: TriggerNodeType;
  workflowId: string | null;
  workflowVersionId: string;
  nodeId: string;
  /** Idempotency key — relay retries with the same key converge to one row. */
  dedupeKey: string | null;
  /** Normalized inbound payload; caller MUST have run it through `safePersistPayload`. */
  payloadJson: unknown;
  /**
   * Optional explicit row id. The email ingestion path mints the id up front
   * so attachment object-store keys (`orgs/<orgId>/email/<id>/...`) reference
   * the SAME id the persisted row carries. Defaults to a fresh UUID.
   */
  id?: string;
};

export type RecordTriggerEventResult = {
  event: TriggerEvent;
  /** False when an existing row already matched `(orgId, dedupeKey)` (relay retry). */
  wasCreated: boolean;
};

/**
 * Insert a `received` trigger-event row, idempotent on `(orgId, dedupeKey)`.
 * When `dedupeKey` is null the row always inserts (Postgres treats NULLs as
 * distinct in a unique index, so a missing message id never blocks an event).
 * When a row already exists for the key, returns it with `wasCreated: false`
 * so the caller can skip spawning a duplicate run.
 */
export async function recordTriggerEvent(input: RecordTriggerEventInput): Promise<RecordTriggerEventResult> {
  const id = input.id ?? crypto.randomUUID();
  const inserted = await db
    .insert(triggerEvents)
    .values({
      id,
      orgId: input.orgId,
      triggerType: input.triggerType,
      workflowId: input.workflowId,
      workflowVersionId: input.workflowVersionId,
      nodeId: input.nodeId,
      status: "received",
      dedupeKey: input.dedupeKey,
      payloadJson: input.payloadJson as object,
    })
    .onConflictDoNothing({ target: [triggerEvents.orgId, triggerEvents.dedupeKey] })
    .returning();

  if (inserted[0]) {
    return { event: inserted[0], wasCreated: true };
  }

  // Conflict — a row already exists for this (orgId, dedupeKey). Fetch it so
  // the caller can report the duplicate without spawning a second run.
  const existing = input.dedupeKey
    ? await db
        .select()
        .from(triggerEvents)
        .where(and(eq(triggerEvents.orgId, input.orgId), eq(triggerEvents.dedupeKey, input.dedupeKey)))
        .limit(1)
    : [];
  return { event: existing[0]!, wasCreated: false };
}

/**
 * Look up an existing trigger-event row by `(orgId, dedupeKey)`. Returns null
 * when `dedupeKey` is null (NULLs never dedupe) or no row matches. Used by the
 * email ingestion path to short-circuit a relay retry BEFORE it offloads
 * attachments to the object store — without this pre-check a duplicate inbound
 * email uploads its attachments under a fresh id that the deduped event row
 * never references, orphaning those objects.
 */
export async function findTriggerEventByDedupeKey(
  orgId: string,
  dedupeKey: string | null,
): Promise<TriggerEvent | null> {
  if (!dedupeKey) return null;
  const rows = await db
    .select()
    .from(triggerEvents)
    .where(and(eq(triggerEvents.orgId, orgId), eq(triggerEvents.dedupeKey, dedupeKey)))
    .limit(1);
  return rows[0] ?? null;
}

/** Flip a trigger-event row to `skipped` with a human-readable reason. Org-scoped. */
export async function markTriggerEventSkipped(orgId: string, id: string, reason: string): Promise<void> {
  await db
    .update(triggerEvents)
    .set({ status: "skipped", skippedReason: reason.slice(0, 512), backfillClaimToken: null, backfillClaimedAt: null })
    .where(and(eq(triggerEvents.orgId, orgId), eq(triggerEvents.id, id)));
}

/**
 * Park a trigger-event row as `buffered`: its workflow was paused when the
 * event arrived, so no run was spawned and the payload is owed one on resume.
 * Distinct from `skipped` (deliberately discarded) — backfill reads exactly
 * this status. Org-scoped.
 */
export async function markTriggerEventBuffered(orgId: string, id: string, reason: string): Promise<void> {
  await db
    .update(triggerEvents)
    .set({ status: "buffered", skippedReason: reason.slice(0, 512), backfillClaimToken: null, backfillClaimedAt: null })
    .where(and(eq(triggerEvents.orgId, orgId), eq(triggerEvents.id, id)));
}

/**
 * Oldest-first page of the events a workflow buffered while paused — the
 * backfill window. Oldest-first because the payloads are a causal sequence:
 * replaying "order updated" before "order created" inverts the story the
 * upstream system actually told.
 *
 * `limit` bounds the window: a long pause can buffer more than one resume
 * should replay in a single breath, and the caller paces what it gets.
 */
export async function listBufferedTriggerEvents(
  orgId: string,
  workflowId: string,
  limit: number,
): Promise<Array<{ id: string; workflowVersionId: string; nodeId: string; triggerType: string }>> {
  if (limit <= 0) return [];
  return db
    .select({
      id: triggerEvents.id,
      workflowVersionId: triggerEvents.workflowVersionId,
      nodeId: triggerEvents.nodeId,
      triggerType: triggerEvents.triggerType,
    })
    .from(triggerEvents)
    .where(and(
      eq(triggerEvents.orgId, orgId),
      eq(triggerEvents.workflowId, workflowId),
      eq(triggerEvents.status, "buffered"),
    ))
    .orderBy(asc(triggerEvents.createdAt))
    .limit(limit);
}

export type ClaimedTriggerEvent = {
  id: string;
  workflowVersionId: string;
  nodeId: string;
  triggerType: string;
  claimToken: string;
};

/** Lease duration shared by claims and operator-facing backlog projections. */
export const TRIGGER_BACKFILL_CLAIM_LEASE_MS = 5 * 60 * 1000;

/**
 * Atomically lease the next buffered page oldest-first. Concurrent callers
 * cannot receive the same row; a claim abandoned before run creation becomes
 * eligible again after the bounded lease.
 */
export async function claimBufferedTriggerEvents(
  orgId: string,
  workflowId: string,
  limit: number,
): Promise<ClaimedTriggerEvent[]> {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const boundedLimit = Math.min(1000, Math.max(1, Math.trunc(limit)));
  const claimToken = crypto.randomUUID();
  const staleBefore = new Date(Date.now() - TRIGGER_BACKFILL_CLAIM_LEASE_MS);
  const rows = await db.execute<{
    id: string;
    workflow_version_id: string;
    node_id: string;
    trigger_type: string;
  }>(sql`
    WITH candidates AS (
      SELECT ${triggerEvents.id}
      FROM ${triggerEvents}
      WHERE ${triggerEvents.orgId} = ${orgId}
        AND ${triggerEvents.workflowId} = ${workflowId}
        AND (
          ${triggerEvents.status} = 'buffered'
          OR (
            ${triggerEvents.status} = 'backfilling'
            AND ${triggerEvents.backfillClaimedAt} < ${sql.param(staleBefore, triggerEvents.backfillClaimedAt)}
          )
        )
      ORDER BY ${triggerEvents.createdAt} ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${boundedLimit}
    )
    UPDATE ${triggerEvents} AS event
    SET
      status = 'backfilling',
      backfill_claim_token = ${claimToken},
      backfill_claimed_at = NOW()
    FROM candidates
    WHERE event.id = candidates.id
    RETURNING
      event.id AS id,
      event.workflow_version_id AS workflow_version_id,
      event.node_id AS node_id,
      event.trigger_type AS trigger_type
  `);
  return rows.map((row) => ({
    id: row.id,
    workflowVersionId: row.workflow_version_id,
    nodeId: row.node_id,
    triggerType: row.trigger_type,
    claimToken,
  }));
}

/** Return an unconsumed lease to the buffered queue without losing its payload. */
export async function releaseTriggerEventBackfillClaim(
  orgId: string,
  id: string,
  claimToken: string,
): Promise<boolean> {
  const rows = await db
    .update(triggerEvents)
    .set({ status: "buffered", backfillClaimToken: null, backfillClaimedAt: null })
    .where(and(
      eq(triggerEvents.orgId, orgId),
      eq(triggerEvents.id, id),
      eq(triggerEvents.status, "backfilling"),
      eq(triggerEvents.backfillClaimToken, claimToken),
    ))
    .returning({ id: triggerEvents.id });
  return rows.length === 1;
}

/**
 * Retire a claimed event only while the caller still owns its lease. This
 * prevents an expired worker from overwriting a newer claim or a started run.
 */
export async function retireTriggerEventBackfillClaim(
  orgId: string,
  id: string,
  claimToken: string,
  status: "skipped" | "failed",
  reason: string,
): Promise<boolean> {
  const rows = await db
    .update(triggerEvents)
    .set({
      status,
      skippedReason: reason.slice(0, 512),
      backfillClaimToken: null,
      backfillClaimedAt: null,
    })
    .where(and(
      eq(triggerEvents.orgId, orgId),
      eq(triggerEvents.id, id),
      eq(triggerEvents.status, "backfilling"),
      eq(triggerEvents.backfillClaimToken, claimToken),
    ))
    .returning({ id: triggerEvents.id });
  return rows.length === 1;
}

/** How many events a workflow has buffered. Drives the operator-facing count. */
export async function countBufferedTriggerEvents(orgId: string, workflowId: string): Promise<number> {
  const staleBefore = new Date(Date.now() - TRIGGER_BACKFILL_CLAIM_LEASE_MS);
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(triggerEvents)
    .where(and(
      eq(triggerEvents.orgId, orgId),
      eq(triggerEvents.workflowId, workflowId),
      or(
        eq(triggerEvents.status, "buffered"),
        and(
          eq(triggerEvents.status, "backfilling"),
          lt(triggerEvents.backfillClaimedAt, staleBefore),
        ),
      ),
    ));
  return rows[0]?.count ?? 0;
}

/** Flip a trigger-event row to `failed` with a human-readable reason. Org-scoped. */
export async function markTriggerEventFailed(orgId: string, id: string, reason: string): Promise<void> {
  await db
    .update(triggerEvents)
    .set({ status: "failed", skippedReason: reason.slice(0, 512), backfillClaimToken: null, backfillClaimedAt: null })
    .where(and(eq(triggerEvents.orgId, orgId), eq(triggerEvents.id, id)));
}

/** Fetch a single trigger-event row by id, scoped to the caller's org. */
export async function getTriggerEvent(orgId: string, id: string): Promise<TriggerEvent | null> {
  const rows = await db
    .select()
    .from(triggerEvents)
    .where(and(eq(triggerEvents.orgId, orgId), eq(triggerEvents.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

const TRIGGER_EVENTS_DEFAULT_LIMIT = 50;
const TRIGGER_EVENTS_MAX_LIMIT = 200;

/**
 * List recent trigger events for an org, newest first, optionally filtered by
 * status and keyset-paginated by `createdAt`. Always bounded by an explicit
 * cap (per the getter convention — `list*` returns `T[]`).
 */
export async function listTriggerEvents(
  orgId: string,
  options?: { status?: TriggerEventStatus; limit?: number; before?: Date },
): Promise<TriggerEvent[]> {
  const limit = Math.min(
    TRIGGER_EVENTS_MAX_LIMIT,
    Math.max(1, options?.limit ?? TRIGGER_EVENTS_DEFAULT_LIMIT),
  );
  const predicates = [eq(triggerEvents.orgId, orgId)];
  if (options?.status) predicates.push(eq(triggerEvents.status, options.status));
  if (options?.before) predicates.push(lt(triggerEvents.createdAt, options.before));
  return db
    .select()
    .from(triggerEvents)
    .where(and(...predicates))
    .orderBy(desc(triggerEvents.createdAt))
    .limit(limit);
}

/**
 * One resolved trigger node: the workflow version + node id whose authored
 * config matched an inbound event, plus the parsed DAG so the seam can spawn
 * the run without a second DB read.
 */
export type ResolvedTriggerNode = {
  workflowId: string;
  workflowVersionId: string;
  nodeId: string;
  /** The matched trigger node's config (raw — the seam validates it). */
  nodeConfig: Record<string, unknown>;
  /** The full DAG JSON the run will execute. */
  dagJson: unknown;
};

type LatestVersionRow = {
  id: string;
  workflowId: string;
  dagJson: unknown;
};

const RESOLVER_VERSION_CAP = 1000;

/**
 * Load the org's LATEST active workflow version per workflow id, capped. Used
 * by the trigger resolver to find a node whose authored config matches an
 * inbound event. Org-scoped — a relay authenticating as org A can only fire
 * org A's triggers. A workflow id narrows replay and backfill to the workflow
 * that originally received the event.
 *
 * One round-trip via `DISTINCT ON` (mirrors
 * `credentialHealthRepo.loadLatestWorkflowVersions`): the latest version per
 * workflow id, ordered by `version DESC`, covered by the
 * `(org_id, workflow_id, version)` index.
 */
async function loadLatestVersionsForOrg(orgId: string, workflowId?: string): Promise<LatestVersionRow[]> {
  const workflowPredicate = workflowId
    ? sql`AND ${workflowVersions.workflowId} = ${workflowId}`
    : sql``;
  const rows = await db.execute<{ id: string; workflow_id: string; dag_json: unknown }>(sql`
    SELECT DISTINCT ON (${workflowVersions.workflowId})
      ${workflowVersions.id} AS id,
      ${workflowVersions.workflowId} AS workflow_id,
      ${workflowVersions.dagJson} AS dag_json
    FROM ${workflowVersions}
    INNER JOIN ${workflows}
      ON ${workflows.id} = ${workflowVersions.workflowId}
      AND ${workflows.orgId} = ${workflowVersions.orgId}
    WHERE ${workflowVersions.orgId} = ${orgId}
      AND ${workflows.orgId} = ${orgId}
      AND ${workflows.deletedAt} IS NULL
      ${workflowPredicate}
    ORDER BY ${workflowVersions.workflowId}, ${workflowVersions.version} DESC
    LIMIT ${RESOLVER_VERSION_CAP}
  `);
  const out: LatestVersionRow[] = [];
  for (const row of rows) {
    if (typeof row.id === "string" && typeof row.workflow_id === "string") {
      out.push({ id: row.id, workflowId: row.workflow_id, dagJson: row.dag_json });
    }
  }
  return out;
}

/** Pull the typed trigger nodes out of a DAG JSON blob (defensive — tolerates junk). */
function extractTriggerNodes(dagJson: unknown): Array<{ id: string; type: TriggerNodeType; config: Record<string, unknown> }> {
  if (!dagJson || typeof dagJson !== "object") return [];
  const nodes = (dagJson as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];
  const out: Array<{ id: string; type: TriggerNodeType; config: Record<string, unknown> }> = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const { id, type, config } = node as { id?: unknown; type?: unknown; config?: unknown };
    if (typeof id !== "string" || !isTriggerNodeType(type)) continue;
    out.push({
      id,
      type,
      config: config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>) : {},
    });
  }
  return out;
}

/**
 * Resolve which trigger node in the org's latest workflow versions matches an
 * inbound event. The `matcher` is a predicate over the node's `(type, config)`
 * supplied by the seam (e.g. "config.aliasKey === inbound.aliasKey"). Returns
 * the FIRST match — an operator should keep trigger keys unique per org, and
 * a duplicate just fires the first-found workflow. Recovery can constrain the
 * lookup to the persisted workflow and node ids. Returns null when no node
 * matches (the seam records the inbound event as `skipped`).
 */
export async function resolveTriggerNode(
  orgId: string,
  triggerType: TriggerNodeType,
  matcher: (config: Record<string, unknown>) => boolean,
  options: { workflowId?: string; nodeId?: string } = {},
): Promise<ResolvedTriggerNode | null> {
  const versions = await loadLatestVersionsForOrg(orgId, options.workflowId);
  for (const version of versions) {
    const triggerNodes = extractTriggerNodes(version.dagJson);
    for (const node of triggerNodes) {
      if (node.type !== triggerType) continue;
      if (options.nodeId && node.id !== options.nodeId) continue;
      if (!matcher(node.config)) continue;
      return {
        workflowId: version.workflowId,
        workflowVersionId: version.id,
        nodeId: node.id,
        nodeConfig: node.config,
        dagJson: version.dagJson,
      };
    }
  }
  return null;
}

// Multi-tenant invariant: every read/write keeps orgId in the predicate; the
// resolver only ever loads the caller-authenticated org's versions.
