/**
 * Repository for `trigger_events` rows — structured inbound-trigger events
 * for the event-driven trigger node types (`email_received`, `file_dropped`,
 * `mcp_server_event`).
 *
 * The API ingestion seam (`apps/api/src/routes/trigger-ingest-routes.ts`)
 * persists one `received` row for every accepted inbound event BEFORE the run
 * is spawned, then flips the row to `started` / `skipped` / `failed`. The row
 * is the DLQ-style replay anchor: an operator can re-submit the same
 * normalized `payloadJson` to re-run the workflow.
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
 * - Resolution of the matching trigger node walks the org's LATEST workflow
 *   versions (org-scoped) — adding a trigger to a draft that was never saved
 *   does not fire.
 */

import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db, triggerEvents, workflowVersions } from "@janusly/db";
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

/** Flip a trigger-event row to `started`, attaching the spawned `runId`. Org-scoped. */
export async function markTriggerEventStarted(orgId: string, id: string, runId: string): Promise<void> {
  await db
    .update(triggerEvents)
    .set({ status: "started", runId })
    .where(and(eq(triggerEvents.orgId, orgId), eq(triggerEvents.id, id)));
}

/** Flip a trigger-event row to `skipped` with a human-readable reason. Org-scoped. */
export async function markTriggerEventSkipped(orgId: string, id: string, reason: string): Promise<void> {
  await db
    .update(triggerEvents)
    .set({ status: "skipped", skippedReason: reason.slice(0, 512) })
    .where(and(eq(triggerEvents.orgId, orgId), eq(triggerEvents.id, id)));
}

/** Flip a trigger-event row to `failed` with a human-readable reason. Org-scoped. */
export async function markTriggerEventFailed(orgId: string, id: string, reason: string): Promise<void> {
  await db
    .update(triggerEvents)
    .set({ status: "failed", skippedReason: reason.slice(0, 512) })
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
 * Load the org's LATEST workflow version per workflow id, capped. Used by the
 * trigger resolver to find a node whose authored config matches an inbound
 * event. Org-scoped — a relay authenticating as org A can only fire org A's
 * triggers (a trigger node in org B's workflow is structurally unreachable).
 *
 * One round-trip via `DISTINCT ON` (mirrors
 * `credentialHealthRepo.loadLatestWorkflowVersions`): the latest version per
 * workflow id, ordered by `version DESC`, covered by the
 * `(org_id, workflow_id, version)` index.
 */
async function loadLatestVersionsForOrg(orgId: string): Promise<LatestVersionRow[]> {
  const rows = await db.execute<{ id: string; workflow_id: string; dag_json: unknown }>(sql`
    SELECT DISTINCT ON (${workflowVersions.workflowId})
      ${workflowVersions.id} AS id,
      ${workflowVersions.workflowId} AS workflow_id,
      ${workflowVersions.dagJson} AS dag_json
    FROM ${workflowVersions}
    WHERE ${workflowVersions.orgId} = ${orgId}
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
 * a duplicate just fires the first-found workflow. Returns null when no node
 * matches (the seam records the inbound event as `skipped`).
 */
export async function resolveTriggerNode(
  orgId: string,
  triggerType: TriggerNodeType,
  matcher: (config: Record<string, unknown>) => boolean,
): Promise<ResolvedTriggerNode | null> {
  const versions = await loadLatestVersionsForOrg(orgId);
  for (const version of versions) {
    const triggerNodes = extractTriggerNodes(version.dagJson);
    for (const node of triggerNodes) {
      if (node.type !== triggerType) continue;
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
