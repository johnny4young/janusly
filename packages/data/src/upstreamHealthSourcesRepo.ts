/**
 * Repository for the `upstream_health_sources` table plus the workflow
 * pause/resume operations that the upstream-health poller drives.
 *
 * Used by:
 *  - `apps/api/src/routes/upstream-health-routes.ts` (admin CRUD + force-run)
 *  - `packages/engine/src/upstream-health-poller.ts` (list + record status +
 *    pause/resume tagged workflows)
 *
 * Invariants:
 * - Multi-tenant scope: every CRUD query filters by `orgId`. The poller's
 *   `listSourcesToPoll` is intentionally cross-org (a global cron sweep) but
 *   each derived pause/resume is org-scoped via the source's own `orgId`.
 * - `kind` / `lastStatus` validation lives at the shared/Zod layer, NOT in
 *   the DB — a new provider kind doesn't require a migration.
 * - Pause/resume operate on the `workflows.status` column. The poller is the
 *   only writer of `paused_upstream_degraded`; the force-run route reads but
 *   does not clear it (a forced run is a one-off override, not a resume).
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db, upstreamHealthSources, workflows, workflowVersions } from "@janusly/db";
import type {
  UpstreamComponentStatus,
  UpstreamHealthKind,
  UpstreamHealthSourceConfig,
} from "@janusly/shared";

/** The workflow status the poller writes when a tagged source goes degraded. */
export const WORKFLOW_STATUS_ACTIVE = "active";
export const WORKFLOW_STATUS_PAUSED_UPSTREAM = "paused_upstream_degraded";

export type UpstreamHealthSourceRow = typeof upstreamHealthSources.$inferSelect;

/** Hydrated shape returned to the API + poller. */
export type UpstreamHealthSource = {
  id: string;
  orgId: string;
  name: string;
  kind: UpstreamHealthKind;
  url: string;
  expectedComponents: string[];
  checkIntervalSeconds: number;
  enabled: boolean;
  lastStatus: UpstreamComponentStatus | null;
  lastDegraded: boolean;
  lastCheckedAt: Date | null;
  lastErrorReason: string | null;
  createdBy: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

function hydrateRow(row: UpstreamHealthSourceRow): UpstreamHealthSource {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    kind: row.kind as UpstreamHealthKind,
    url: row.url,
    expectedComponents: (row.expectedComponents as string[]) ?? [],
    checkIntervalSeconds: row.checkIntervalSeconds,
    enabled: row.enabled,
    lastStatus: (row.lastStatus as UpstreamComponentStatus | null) ?? null,
    lastDegraded: row.lastDegraded,
    lastCheckedAt: row.lastCheckedAt,
    lastErrorReason: row.lastErrorReason,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─── reads ──────────────────────────────────────────────────────────────────

/** List every source for an org, alphabetically by name. */
export async function listUpstreamHealthSources(
  orgId: string,
): Promise<UpstreamHealthSource[]> {
  const rows = await db
    .select()
    .from(upstreamHealthSources)
    .where(eq(upstreamHealthSources.orgId, orgId))
    .orderBy(sql`lower(${upstreamHealthSources.name})`);
  return rows.map(hydrateRow);
}

/** Fetch one source by id, scoped to org. */
export async function getUpstreamHealthSourceById(
  orgId: string,
  id: string,
): Promise<UpstreamHealthSource | null> {
  const rows = await db
    .select()
    .from(upstreamHealthSources)
    .where(and(eq(upstreamHealthSources.orgId, orgId), eq(upstreamHealthSources.id, id)));
  return rows[0] ? hydrateRow(rows[0]) : null;
}

/** Fetch one source by name, scoped to org (the workflow join key). */
export async function findUpstreamHealthSourceByName(
  orgId: string,
  name: string,
): Promise<UpstreamHealthSource | null> {
  const rows = await db
    .select()
    .from(upstreamHealthSources)
    .where(and(eq(upstreamHealthSources.orgId, orgId), eq(upstreamHealthSources.name, name)));
  return rows[0] ? hydrateRow(rows[0]) : null;
}

/**
 * List every ENABLED source across ALL orgs for the poller's sweep. The poller
 * decides per-row whether the `checkIntervalSeconds` has elapsed since
 * `lastCheckedAt`. Cross-org by design (global cron); the derived pause is
 * org-scoped via each row's own `orgId`.
 */
export async function listSourcesToPoll(): Promise<UpstreamHealthSource[]> {
  const rows = await db
    .select()
    .from(upstreamHealthSources)
    .where(eq(upstreamHealthSources.enabled, true));
  return rows.map(hydrateRow);
}

// ─── writes (CRUD) ────────────────────────────────────────────────────────────

export type UpsertUpstreamHealthSourceInput = UpstreamHealthSourceConfig & {
  id?: string;
  createdBy?: string | null;
};

/** Insert a new source. The unique `(orgId, name)` index rejects duplicates. */
export async function createUpstreamHealthSource(
  orgId: string,
  input: UpsertUpstreamHealthSourceInput,
): Promise<UpstreamHealthSource> {
  const id = input.id ?? crypto.randomUUID();
  const now = new Date();
  await db.insert(upstreamHealthSources).values({
    id,
    orgId,
    name: input.name,
    kind: input.kind,
    url: input.url,
    expectedComponents: input.expectedComponents,
    checkIntervalSeconds: input.checkIntervalSeconds,
    enabled: input.enabled,
    createdBy: input.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  });
  const row = await findUpstreamHealthSourceByName(orgId, input.name);
  if (!row) throw new Error("upstream health source missing immediately after insert");
  return row;
}

/**
 * Update a source's config in place by id. Returns `{ before, after }` for the
 * audit row, or null when the row doesn't exist. The config fields fully
 * replace the row's config; derived status columns are left untouched.
 */
export async function updateUpstreamHealthSource(
  orgId: string,
  id: string,
  input: UpstreamHealthSourceConfig,
): Promise<{ before: UpstreamHealthSource; after: UpstreamHealthSource } | null> {
  const before = await getUpstreamHealthSourceById(orgId, id);
  if (!before) return null;
  await db
    .update(upstreamHealthSources)
    .set({
      name: input.name,
      kind: input.kind,
      url: input.url,
      expectedComponents: input.expectedComponents,
      checkIntervalSeconds: input.checkIntervalSeconds,
      enabled: input.enabled,
      updatedAt: new Date(),
    })
    .where(and(eq(upstreamHealthSources.orgId, orgId), eq(upstreamHealthSources.id, id)));
  const after = await getUpstreamHealthSourceById(orgId, id);
  if (!after) return null;
  return { before, after };
}

/** Hard-delete a source. Returns the deleted row for audit; orphan tags tolerated. */
export async function deleteUpstreamHealthSource(
  orgId: string,
  id: string,
): Promise<UpstreamHealthSource | null> {
  const before = await getUpstreamHealthSourceById(orgId, id);
  if (!before) return null;
  await db
    .delete(upstreamHealthSources)
    .where(and(eq(upstreamHealthSources.orgId, orgId), eq(upstreamHealthSources.id, id)));
  return before;
}

// ─── derived-status persistence (poller) ──────────────────────────────────────

/**
 * Record the outcome of a successful poll: the derived status + degraded flag.
 * Only called when the parse produced a usable status. Clears `lastErrorReason`.
 */
export async function recordUpstreamStatus(args: {
  orgId: string;
  id: string;
  status: UpstreamComponentStatus;
  degraded: boolean;
}): Promise<void> {
  await db
    .update(upstreamHealthSources)
    .set({
      lastStatus: args.status,
      lastDegraded: args.degraded,
      lastCheckedAt: new Date(),
      lastErrorReason: null,
      updatedAt: new Date(),
    })
    .where(and(eq(upstreamHealthSources.orgId, args.orgId), eq(upstreamHealthSources.id, args.id)));
}

/**
 * Record a FAIL-OPEN poll: the feed was unreachable / unparseable. Stores the
 * reason for operator visibility but leaves `lastStatus` / `lastDegraded`
 * UNCHANGED — a degraded flip must come only from a successful poll, never
 * from an outage of the status page itself.
 */
export async function recordUpstreamPollError(args: {
  orgId: string;
  id: string;
  reason: string;
}): Promise<void> {
  await db
    .update(upstreamHealthSources)
    .set({
      lastCheckedAt: new Date(),
      lastErrorReason: args.reason,
      updatedAt: new Date(),
    })
    .where(and(eq(upstreamHealthSources.orgId, args.orgId), eq(upstreamHealthSources.id, args.id)));
}

// ─── workflow pause / resume ──────────────────────────────────────────────────

/**
 * Find the ids of workflows tagged with a given source name, scoped to org.
 * Reads the LATEST version per workflow (highest `version`) — only the current
 * tag set decides subscription, so an older version that referenced the source
 * doesn't keep a workflow subscribed after the operator removes the tag.
 */
export async function listWorkflowIdsTaggedWithSource(
  orgId: string,
  sourceName: string,
): Promise<string[]> {
  const rows = await db
    .select({
      workflowId: workflowVersions.workflowId,
      version: workflowVersions.version,
      upstreamHealthSources: workflowVersions.upstreamHealthSources,
    })
    .from(workflowVersions)
    .where(eq(workflowVersions.orgId, orgId));

  const latestByWorkflow = new Map<string, { version: number; tags: string[] }>();
  for (const row of rows) {
    const existing = latestByWorkflow.get(row.workflowId);
    if (!existing || row.version > existing.version) {
      latestByWorkflow.set(row.workflowId, {
        version: row.version,
        tags: (row.upstreamHealthSources as string[] | null) ?? [],
      });
    }
  }

  const matched: string[] = [];
  for (const [workflowId, value] of latestByWorkflow) {
    if (value.tags.includes(sourceName)) matched.push(workflowId);
  }
  return matched;
}

/**
 * Pause every workflow currently `active` in the given id list. Idempotent —
 * an already-paused workflow is not touched (the `WHERE status = active`
 * predicate skips it), so a degraded poll that fires repeatedly doesn't churn
 * the row or re-fire the audit. Returns the ids that actually flipped.
 */
export async function pauseWorkflowsForUpstream(args: {
  orgId: string;
  workflowIds: string[];
  reason: string;
}): Promise<string[]> {
  if (args.workflowIds.length === 0) return [];
  const flipped = await db
    .update(workflows)
    .set({ status: WORKFLOW_STATUS_PAUSED_UPSTREAM, pausedReason: args.reason })
    .where(
      and(
        eq(workflows.orgId, args.orgId),
        inArray(workflows.id, args.workflowIds),
        eq(workflows.status, WORKFLOW_STATUS_ACTIVE),
      ),
    )
    .returning({ id: workflows.id });
  return flipped.map((r) => r.id);
}

/**
 * Resume every workflow in the id list that is currently paused-by-upstream.
 * Only flips rows whose status is exactly `paused_upstream_degraded` — a
 * workflow paused for another reason (future pause sources) is not auto-resumed
 * by an upstream recovery. Returns the ids that actually flipped.
 */
export async function resumeWorkflowsForUpstream(args: {
  orgId: string;
  workflowIds: string[];
}): Promise<string[]> {
  if (args.workflowIds.length === 0) return [];
  const flipped = await db
    .update(workflows)
    .set({ status: WORKFLOW_STATUS_ACTIVE, pausedReason: null })
    .where(
      and(
        eq(workflows.orgId, args.orgId),
        inArray(workflows.id, args.workflowIds),
        eq(workflows.status, WORKFLOW_STATUS_PAUSED_UPSTREAM),
      ),
    )
    .returning({ id: workflows.id });
  return flipped.map((r) => r.id);
}

/** Read a single workflow's status (for the `/start` pause gate). */
export async function getWorkflowStatus(
  orgId: string,
  workflowId: string,
): Promise<{ status: string; pausedReason: string | null } | null> {
  const rows = await db
    .select({ status: workflows.status, pausedReason: workflows.pausedReason })
    .from(workflows)
    .where(and(eq(workflows.orgId, orgId), eq(workflows.id, workflowId)));
  return rows[0] ?? null;
}

// Multi-tenant invariant: tenant-scoped reads/writes keep orgId in the predicate;
// the poller's `listSourcesToPoll` is the documented cross-org sweep exception
// (each derived pause is still org-scoped via the source's own orgId) — see
// AGENTS.md "Upstream health awareness".
