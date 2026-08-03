/** Bounded run list, detail, status, and usage routes. */

import { and, asc, desc, eq, isNull, lt, or, sql } from "drizzle-orm";

import { queryRunUsage } from "@janusly/data";
import { db, runEvents, runNodes, runs, workflowVersions } from "@janusly/db";
import { runStatusValues } from "@janusly/shared/src/status";

import { RUN_EVENTS_DEFAULT_LIMIT, RUN_EVENTS_MAX_LIMIT } from "../../api-config";
import {
  getRunContract,
  getRunStatusContract,
  getRunUsageContract,
  listRunsContract,
} from "../../api-contracts";
import { sendError, sendJson } from "../../http";
import {
  paginateRunEvents,
  parseEventsCursor,
  parseEventsLimit,
  parseKeysetCursor,
} from "../../run-pagination";
import type { Route } from "../../routes";

// Summary projection for the `/runs` LIST surfaces. Deliberately excludes
// `inputJson`: it carries the full workflow snapshot captured by `startRun`,
// so a 100-row page would ship 100 workflow JSONs the list never renders.
// The `GET /run?runId=` detail read keeps the full row.
const runListColumns = {
  id: runs.id,
  orgId: runs.orgId,
  // Run rows created from the live authoring surface carry the workflow id
  // directly, while scheduled/triggered runs carry an immutable version id.
  // Resolve both into one stable list field without exposing the full version.
  workflowId: sql<string>`coalesce(${workflowVersions.workflowId}, ${runs.workflowVersionId})`,
  // Project only the captured display name from input_json. The list still
  // avoids returning the workflow snapshot and trigger payload.
  workflowName: sql<string | null>`${runs.inputJson}->'workflow'->>'name'`,
  workflowVersionId: runs.workflowVersionId,
  status: runs.status,
  // A run can remain `running` while one of its nodes is waiting for a human.
  // Project the actionable condition without changing the durable run state.
  hasWaitingNodes: sql<boolean>`exists (
    select 1
    from ${runNodes}
    where ${runNodes.runId} = ${runs.id}
      and ${runNodes.status} = 'waiting'
  )`,
  outcomeStatus: runs.outcomeStatus,
  semanticViolationCount: runs.semanticViolationCount,
  outputJson: runs.outputJson,
  parentRunId: runs.parentRunId,
  parentNodeId: runs.parentNodeId,
  traceId: runs.traceId,
  replayMode: runs.replayMode,
  validationEvidenceLevel: runs.validationEvidenceLevel,
  createdBy: runs.createdBy,
  createdAt: runs.createdAt,
};

// Public run-node projection shared by legacy and `/v1` detail reads.
// Recovery claim columns are internal worker CAS state and must never become
// an accidental wire-contract addition through Drizzle's select-all shape.
const runNodePublicColumns = {
  id: runNodes.id,
  runId: runNodes.runId,
  nodeId: runNodes.nodeId,
  status: runNodes.status,
  stateJson: runNodes.stateJson,
  attempts: runNodes.attempts,
  startedAt: runNodes.startedAt,
  finishedAt: runNodes.finishedAt,
  errorJson: runNodes.errorJson,
};

export const runReadRoutes: Route[] = [
  // Resource-backed run diagnostics. This exact read must precede the broad
  // `/runs` list matcher below. The run lookup preserves the legacy
  // non-enumerating forbidden response for missing and cross-tenant ids.
  { method: "GET", match: (url) => url === "/run/usage" || url.startsWith("/run/usage?"), permission: "runs.read",
    contract: getRunUsageContract,
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const runId = url.searchParams.get("runId");
      if (!runId) return sendError(res, "runs_run_id_required", "runId is required", 400);
      const run = await db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.id, runId), eq(runs.orgId, auth.orgId)))
        .limit(1);
      if (!run[0]) return sendError(res, "runs_forbidden", "Forbidden", 403);
      return sendJson(res, await queryRunUsage(auth.orgId, runId));
    } },

  // Runs — list + reads
  // NOTE: `/runs` prefix excludes `/run?` so the GET `/run?…` entry below
  // can claim it, and excludes `/runs/compare` so the Replay Lab compare
  // route below can claim it (both are first-match-wins).
  // Optional workflow/status filters compose with a stable keyset boundary.
  // The `workflow_versions` join is tenant-scoped: an inconsistent cross-org
  // version reference cannot resolve another tenant's workflow identity.
  { method: "GET", match: (url) => url.startsWith("/runs") && !url.startsWith("/run?") && !url.startsWith("/runs/compare"),
    contract: listRunsContract,
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const limitParam = Number(url.searchParams.get("limit"));
      const limitValue = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 100;
      const workflowIdFilter = url.searchParams.get("workflowId");
      const statusParam = url.searchParams.get("status");
      const runKindParam = url.searchParams.get("runKind");
      if (statusParam && !runStatusValues.some((status) => status === statusParam)) {
        return sendError(res, "invalid_input", "status must be a valid run status", 400);
      }
      if (runKindParam && runKindParam !== "production" && runKindParam !== "validation") {
        return sendError(res, "invalid_input", "runKind must be production or validation", 400);
      }
      const before = parseKeysetCursor(url.searchParams.get("before"));
      const filters = [eq(runs.orgId, auth.orgId)];
      if (workflowIdFilter) {
        filters.push(or(
          eq(workflowVersions.workflowId, workflowIdFilter),
          and(
            isNull(workflowVersions.id),
            eq(runs.workflowVersionId, workflowIdFilter),
          ),
        )!);
      }
      if (statusParam) filters.push(eq(runs.status, statusParam));
      if (runKindParam === "production") filters.push(isNull(runs.replayMode));
      if (runKindParam === "validation") filters.push(eq(runs.replayMode, "validation"));
      if (before) {
        filters.push(or(
          lt(runs.createdAt, before.createdAt),
          and(eq(runs.createdAt, before.createdAt), lt(runs.id, before.id)),
        )!);
      }

      const rows = await db
        .select(runListColumns)
        .from(runs)
        .leftJoin(workflowVersions, and(
          eq(workflowVersions.id, runs.workflowVersionId),
          eq(workflowVersions.orgId, auth.orgId),
        ))
        .where(and(...filters))
        .orderBy(desc(runs.createdAt), desc(runs.id))
        .limit(limitValue);
      return sendJson(res, rows);
    } },
  { method: "GET", match: (url) => url.startsWith("/run?"),
    contract: getRunContract,
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const runId = url.searchParams.get("runId");
      if (!runId) return sendError(res, "runs_run_id_required", "runId is required", 400);
      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendError(res, "runs_forbidden", "Forbidden", 403);
      const nodes = await db.select(runNodePublicColumns).from(runNodes).where(eq(runNodes.runId, runId)).orderBy(asc(runNodes.startedAt), asc(runNodes.nodeId));
      const limit = parseEventsLimit(url.searchParams.get("eventsLimit"), RUN_EVENTS_DEFAULT_LIMIT, RUN_EVENTS_MAX_LIMIT);
      const cursor = parseEventsCursor(url.searchParams.get("eventsCursor"));
      // Composite (createdAt, id) keyset cursor: events sharing exact createdAt
      // (e.g. inserts within one transaction) tie-break on id so pagination
      // always advances and never skips peers.
      const filter = cursor
        ? and(
            eq(runEvents.runId, runId),
            or(
              lt(runEvents.createdAt, cursor.createdAt),
              and(eq(runEvents.createdAt, cursor.createdAt), lt(runEvents.id, cursor.id)),
            ),
          )
        : eq(runEvents.runId, runId);
      const rows = await db
        .select()
        .from(runEvents)
        .where(filter)
        .orderBy(desc(runEvents.createdAt), desc(runEvents.id))
        .limit(limit + 1);
      const page = paginateRunEvents(rows, limit);
      return sendJson(res, { run: run[0], nodes, ...page });
    } },
  // Poll-oriented read: `/status` always returns the latest event page.
  // Historical pages use `/run?eventsCursor=...` so polling cannot get
  // stuck walking older history while the run is still changing.
  { method: "GET", match: (url) => url.startsWith("/status"),
    contract: getRunStatusContract,
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const runId = url.searchParams.get("runId");
      if (!runId) return sendError(res, "runs_run_id_required", "runId is required", 400);
      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendError(res, "runs_forbidden", "Forbidden", 403);
      const nodes = await db.select(runNodePublicColumns).from(runNodes).where(eq(runNodes.runId, runId)).orderBy(asc(runNodes.startedAt), asc(runNodes.nodeId));
      const limit = parseEventsLimit(url.searchParams.get("eventsLimit"), RUN_EVENTS_DEFAULT_LIMIT, RUN_EVENTS_MAX_LIMIT);
      const rows = await db
        .select()
        .from(runEvents)
        .where(eq(runEvents.runId, runId))
        .orderBy(desc(runEvents.createdAt), desc(runEvents.id))
        .limit(limit + 1);
      const page = paginateRunEvents(rows, limit);
      return sendJson(res, { run: run[0], nodes, ...page });
    } },
];
