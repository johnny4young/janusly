/**
 * Workflow CRUD + readiness + health rollups.
 *
 * Route ordering inside this module matters:
 *   1. `/workflows/versions` and `/workflows/latest` come BEFORE
 *      `/workflows` so the prefix-but-not-`/workflows/` matcher
 *      doesn't shadow them.
 *   2. `/workflows/health/delta` comes BEFORE `/workflows/health` so
 *      the more-specific path wins in the first-match-wins dispatcher.
 *
 * MCP-source mutations (`/workflows/save`) gate on the
 * process-wide `JANUSLY_MCP_WRITES_ENABLED` env AND the tenant's
 * `mcp.writeConsent` flag. Both must be true; otherwise 403 with a
 * stable code the MCP client can render. Per-tool rate limit fires for
 * MCP-source traffic so a misbehaving client can't flood a tenant.
 */

import { and, desc, eq, gte, isNull, isNotNull } from "drizzle-orm";

import {
  db,
  deadLetters,
  runs,
  workflows,
  workflowVersions,
} from "@janusly/db";
import {
  queryHealthSignals,
  DEFAULT_HEALTH_WINDOW_DAYS,
  findScheduleEntriesForWorkflow,
  getWorkflowSlo,
  listDeletedWorkflowsWithRunSummary,
  listDistinctWorkflowFoldersForOrg,
  listDistinctWorkflowTagsForOrg,
  listWorkflowsWithRunSummary,
  queryScheduleFires,
  setWorkflowSlo,
} from "@janusly/data";
import { unregisterAllForWorkflow, syncWorkflowSchedules } from "@janusly/engine/src/schedule-scheduler";
import {
  bucketScheduleFires,
  computeNextFires,
  DEFAULT_NEXT_FIRES,
  MAX_FIRE_ROWS,
  MAX_HISTORY_DAYS,
  MAX_NEXT_FIRES,
} from "@janusly/engine/src/schedule-history";
import { computeWorkflowHealth, MIN_RUNS_FOR_DELTA } from "@janusly/engine/src/workflow-health";
import { checkWorkflowReadiness, type ReadinessIssue, type ReadinessResult } from "@janusly/engine/src/workflow-readiness";
import { validateWorkflow } from "@janusly/engine/src/workflow-validation";
import { UpstreamHealthSourceTagsSchema, WORKFLOW_METADATA_TAGS_MAX, WorkflowSchema, WorkflowSloSchema } from "@janusly/shared";
import { normalizeErrorSignature } from "@janusly/shared/src/error-signature";
import { z } from "zod";

import { auditAction } from "../audit-helper";
import { FAILED_RUN_STATUS_SET, MAX_JSON_BODY_BYTES, OPEN_RUN_STATUS_SET } from "../api-config";
import { asRecord, readJson, sendError, sendJson } from "../http";
import { guardMcpWrite } from "../mcp-consent";
import { parseKeysetCursor } from "../run-pagination";
import {
  checkRollbackAvailability,
  getCredentialReadinessIssues,
  mergeReadiness,
  productionSecretRefResolver,
} from "../readiness-helpers";
import type { Route } from "../routes";
import { rollbackAuditMetadata, rollbackWorkflowToVersion } from "../workflows-rollback";
import { saveWorkflowVersion } from "../workflows-save";

/**
 * Parse a `?before=<iso>|<id>` keyset cursor for the Flows-list "Load more" into
 * the `{ createdAt, id }` the repo expects, or `undefined` for a missing /
 * malformed value (so it degrades to the first page). Thin adapter over the
 * shared `parseKeysetCursor` (run-pagination.ts) — one parser per wire format.
 */
function parseBeforeCursor(raw: string | null): { createdAt: Date; id: string } | undefined {
  return parseKeysetCursor(raw) ?? undefined;
}

export const workflowsRoutes: Route[] = [
  // Workflows — list + version reads + save
  // NOTE: `/workflows/versions` and `/workflows/latest` come BEFORE `/workflows`
  // so the prefix-but-not-`/workflows/` matcher doesn't shadow them.
  { method: "GET", match: (url) => url.startsWith("/workflows/versions"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const workflowId = url.searchParams.get("workflowId");
      if (!workflowId) return sendError(res, "workflows_workflow_id_required", "workflowId is required", 400);
      const owned = await db
        .select({ id: workflows.id })
        .from(workflows)
        .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, auth.orgId), isNull(workflows.deletedAt)))
        .limit(1);
      if (owned.length === 0) return sendError(res, "workflow_not_found", "Workflow not found", 404);
      const versions = await db.select().from(workflowVersions).where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.orgId, auth.orgId))).orderBy(desc(workflowVersions.version));
      return sendJson(res, versions);
    } },
  { method: "GET", match: (url) => url.startsWith("/workflows/latest"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const workflowId = url.searchParams.get("workflowId");
      if (!workflowId) return sendError(res, "workflows_workflow_id_required", "workflowId is required", 400);
      const owned = await db
        .select({ id: workflows.id })
        .from(workflows)
        .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, auth.orgId), isNull(workflows.deletedAt)))
        .limit(1);
      if (owned.length === 0) return sendError(res, "workflow_not_found", "Workflow not found", 404);
      const versions = await db.select().from(workflowVersions).where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.orgId, auth.orgId))).orderBy(desc(workflowVersions.version));
      return sendJson(res, versions[0] ?? null);
    } },
  // The org's distinct workflow tags, for the Flows-list tag-filter picker.
  // Registered BEFORE the `/workflows` list route (which excludes `/workflows/`)
  // so first-match-wins routes it correctly; org-scoped in the repo.
  { method: "GET", match: (url) => url.startsWith("/workflows/tags"), permission: "workflows.read",
    handler: async ({ res, auth }) => {
      const tags = await listDistinctWorkflowTagsForOrg(auth.orgId);
      return sendJson(res, { tags });
    } },
  // The org's distinct workflow folders, for the Flows-list folder-filter
  // dropdown. Registered BEFORE the `/workflows` list route (same first-match
  // reason as `/workflows/tags`); org-scoped in the repo.
  { method: "GET", match: (url) => url.startsWith("/workflows/folders"), permission: "workflows.read",
    handler: async ({ res, auth }) => {
      const folders = await listDistinctWorkflowFoldersForOrg(auth.orgId);
      return sendJson(res, { folders });
    } },
  // The org's soft-deleted workflows (the Flows "Trash" view). Registered BEFORE
  // the bare `/workflows` list matcher (same first-match reason as the sibling
  // routes above) so it isn't shadowed. Bounded by the retention sweep, so v1 is
  // a single capped read with no keyset cursor; org-scoped in the repo.
  { method: "GET", match: (url) => url.startsWith("/workflows/trash"), permission: "workflows.read",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const limitParam = Number(url.searchParams.get("limit"));
      const limitValue = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 100;
      // Keyset "Load more" cursor — `parseBeforeCursor` decodes a generic
      // `<iso>|<id>`; here the instant carries the row's `deletedAt` (the trash
      // list orders by deletedAt DESC, not createdAt). Malformed/absent → unpaged.
      const cursor = parseBeforeCursor(url.searchParams.get("before"));
      const before = cursor ? { deletedAt: cursor.createdAt, id: cursor.id } : undefined;
      const rows = await listDeletedWorkflowsWithRunSummary(auth.orgId, limitValue, before);
      return sendJson(res, rows);
    } },
  { method: "GET", match: (url) => url.startsWith("/workflows") && !url.startsWith("/workflows/"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const limitParam = Number(url.searchParams.get("limit"));
      const limitValue = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 100;
      // Optional `?tag=` (repeatable — multiple AND together) / `?folder=` filter
      // the list (both applied before the cap in the repo). Trim + length-guard
      // against junk input (tag ≤40, folder ≤60 — matching their Zod maxes);
      // dedupe + cap the tag set (a row carries ≤ WORKFLOW_METADATA_TAGS_MAX tags,
      // so a longer AND can never match — bounding it keeps the containment small).
      const tags = [
        ...new Set(
          url.searchParams
            .getAll("tag")
            .map((t) => t.trim())
            .filter((t) => t.length > 0 && t.length <= 40),
        ),
      ].slice(0, WORKFLOW_METADATA_TAGS_MAX);
      const folderParam = url.searchParams.get("folder")?.trim();
      const folder = folderParam && folderParam.length > 0 && folderParam.length <= 60 ? folderParam : undefined;
      // Optional `?q=` name/id search (case-insensitive substring, applied before
      // the cap in the repo so a match surfaces beyond the newest page). Trimmed +
      // length-guarded (≤100) to bound the ILIKE pattern.
      const qParam = url.searchParams.get("q")?.trim();
      const search = qParam && qParam.length > 0 && qParam.length <= 100 ? qParam : undefined;
      // Optional `?before=<iso>|<id>` keyset cursor for "Load more" — pages past
      // the cap by returning rows older than the given `(createdAt, id)`. Parsed
      // defensively (split on the LAST `|`, reject NaN dates / empty id) → a
      // malformed cursor degrades to the unpaginated first page.
      const before = parseBeforeCursor(url.searchParams.get("before"));
      const rows = await listWorkflowsWithRunSummary(auth.orgId, limitValue, { tags, folder, search, before });
      return sendJson(res, rows);
    } },
  { method: "POST", match: "/workflows/save", role: "editor", permission: "workflows.write",
    handler: async ({ req, res, auth }) => {
      // MCP-source mutations gate on the process-wide env AND the tenant's
      // `mcp.writeConsent` flag (+ per-tool rate limit). No-op for non-MCP
      // callers. Audit `source:"mcp"` tagging is automatic via `auditAction`.
      const saveMcpGate = await guardMcpWrite(auth, "workflows.save");
      if (!saveMcpGate.ok) return sendJson(res, saveMcpGate.body, saveMcpGate.status);

      const workflow = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const validation = validateWorkflow(workflow);
      if (!validation.valid) return sendJson(res, { error: "Validation failed", issues: validation.issues }, 400);
      const parsedWorkflow = WorkflowSchema.parse(workflow);

      // Optional upstream-health source tags — a sibling field on the save body
      // (NOT part of the DAG JSON, mirroring how the SLO lives on its own
      // column). `undefined` carries forward the prior version's tags; an
      // explicit array (incl. `[]`) overrides. Validated against the bounded
      // string-array shape; an invalid value is rejected with 422.
      let upstreamHealthSources: string[] | undefined;
      if (Object.hasOwn(workflow, "upstreamHealthSources")) {
        const parsedTags = UpstreamHealthSourceTagsSchema.safeParse(workflow.upstreamHealthSources);
        if (!parsedTags.success) {
          return sendJson(res, { error: "invalid upstreamHealthSources", issues: parsedTags.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 422);
        }
        upstreamHealthSources = parsedTags.data;
      }

      // Concurrent saves for the same `(orgId, workflowId)` resolve via
      // a bounded unique-constraint retry inside `saveWorkflowVersion`.
      // On exhausted retries the helper returns `kind: "conflict"` so
      // the operator sees a clean 409 ("please retry") instead of the
      // 5xx the inline transaction used to emit.
      const result = await saveWorkflowVersion({
        orgId: auth.orgId,
        userId: auth.userId,
        parsedWorkflow,
        upstreamHealthSources,
      });

      if (result.kind === "conflict") {
        return sendJson(res, {
          error: "Concurrent save conflict — please retry",
          attempts: result.attempts,
        }, 409);
      }

      // A soft-deleted workflow behaves as "not found" for writes too —
      // saving never silently resurrects it; restore it first.
      if (result.kind === "deleted") {
        return sendError(res, "workflow_not_found", "Workflow not found", 404);
      }

      const auditMetadata: Record<string, unknown> = {
        version: result.version,
        attempts: result.attempts,
      };
      await auditAction(auth, "workflow.saved", { targetType: "workflow", targetId: result.workflowId, metadata: auditMetadata });
      return sendJson(res, {
        workflowId: result.workflowId,
        versionId: result.versionId,
        version: result.version,
      });
    } },
  { method: "POST", match: "/workflows/rollback", role: "editor",
    handler: async ({ req, res, auth }) => {
      const rollbackMcpGate = await guardMcpWrite(auth, "workflows.rollback");
      if (!rollbackMcpGate.ok) return sendJson(res, rollbackMcpGate.body, rollbackMcpGate.status);
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const workflowId = typeof body.workflowId === "string" ? body.workflowId : "";
      const sourceVersionId = typeof body.sourceVersionId === "string" ? body.sourceVersionId : "";
      if (!workflowId || !sourceVersionId) {
        return sendError(res, "workflows_rollback_ids_required", "workflowId and sourceVersionId are required", 400);
      }
      const result = await rollbackWorkflowToVersion({
        orgId: auth.orgId,
        userId: auth.userId,
        workflowId,
        sourceVersionId,
      });
      if (!result.ok) {
        // A soft-deleted workflow behaves as "not found" for writes too.
        if (result.code === "deleted") {
          return sendError(res, "workflow_not_found", "Workflow not found", 404);
        }
        return sendError(res, "workflows_source_version_not_found", "Source version not found", 404);
      }
      await auditAction(auth, "workflow.rolled_back", { targetType: "workflow", targetId: workflowId, metadata: rollbackAuditMetadata(result) });
      return sendJson(res, {
        workflowId,
        versionId: result.versionId,
        version: result.version,
        sourceVersion: result.sourceVersion,
      });
    } },
  // POST /workflows/:id/slo — declare or update the workflow's SLO. Admin-only.
  // Writes the SLO blob onto the latest workflow_versions row in place via
  // `setWorkflowSlo`; the save chokepoint copies it forward to every
  // subsequent version. Body: `{ slo: WorkflowSlo | null }` where `null`
  // clears the declaration.
  { method: "POST",
    match: (url) => {
      if (!url.startsWith("/workflows/")) return false;
      const rest = url.slice("/workflows/".length).split("?")[0];
      const segments = rest.split("/");
      return segments.length === 2 && segments[1] === "slo" && segments[0].length > 0;
    },
    role: "admin",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const workflowId = url.pathname.slice("/workflows/".length).split("/")[0];
      if (!workflowId) return sendError(res, "workflows_workflow_id_required", "workflowId is required", 400);

      // Multi-tenant gate first — same enumeration-safe shape the sibling
      // DELETE /workflows/:id and GET /workflows/health routes use.
      const owned = await db
        .select({ id: workflows.id })
        .from(workflows)
        .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, auth.orgId), isNull(workflows.deletedAt)))
        .limit(1);
      if (owned.length === 0) return sendError(res, "workflow_not_found", "Workflow not found", 404);

      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const parsed = z.object({ slo: WorkflowSloSchema.nullable() }).safeParse(body);
      if (!parsed.success) {
        return sendJson(res, {
          error: "Invalid SLO body",
          issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        }, 400);
      }

      const result = await setWorkflowSlo(auth.orgId, workflowId, parsed.data.slo);
      if (!result) return sendError(res, "workflow_not_found", "Workflow not found", 404);

      await auditAction(auth, "workflow.slo.set", { targetType: "workflow", targetId: workflowId, metadata: {
        slo: parsed.data.slo,
        previousSlo: result.previousSlo,
        versionId: result.versionId,
      } });
      return sendJson(res, { workflowId, slo: parsed.data.slo, versionId: result.versionId });
    } },
  // GET /workflows/:id/schedule-history — cron-observability heatmap.
  // Returns a 90-day day-of-week × hour-of-day grid of scheduled-fire
  // timestamps (bucketed in UTC) with a per-cell success/fail ratio, plus a
  // next-N-fires preview computed from each enabled schedule entry's cron
  // expression (cron-parser is DST-safe). Read-only — viewer role suffices.
  // The fire history comes from `runs` the scheduler created (joined through
  // `workflow_versions` for tenant + workflow scope); `schedule_entries`
  // supplies the cron expressions for the preview and a `last_run_at` marker
  // for entries whose run rows aged out of the window. Bounded: window ≤ 90
  // days, row scan ≤ 1000.
  { method: "GET",
    match: (url) => {
      if (!url.startsWith("/workflows/")) return false;
      const rest = url.slice("/workflows/".length).split("?")[0];
      const segments = rest.split("/");
      return segments.length === 2 && segments[1] === "schedule-history" && segments[0].length > 0;
    },
    role: "viewer", permission: "workflows.read",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const workflowId = decodeURIComponent(url.pathname.slice("/workflows/".length).split("/")[0]);
      if (!workflowId) return sendError(res, "workflows_workflow_id_required", "workflowId is required", 400);

      // Multi-tenant gate first — same enumeration-safe 404 the sibling
      // `/workflows/health` and `/workflows/:id/slo` routes use.
      const owned = await db
        .select({ id: workflows.id })
        .from(workflows)
        .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, auth.orgId), isNull(workflows.deletedAt)))
        .limit(1);
      if (owned.length === 0) return sendError(res, "workflow_not_found", "Workflow not found", 404);

      // windowDays clamps to [1, 90]; default to the full 90-day lookback so
      // the heatmap is populated even for sparse weekly crons.
      const rawWindow = Number(url.searchParams.get("windowDays") ?? NaN);
      const windowDays = Number.isInteger(rawWindow)
        ? Math.min(MAX_HISTORY_DAYS, Math.max(1, rawWindow))
        : MAX_HISTORY_DAYS;
      // nextFires clamps to [0, MAX_NEXT_FIRES]; default 5.
      const rawNext = Number(url.searchParams.get("nextFires") ?? NaN);
      const nextFiresCount = Number.isInteger(rawNext)
        ? Math.min(MAX_NEXT_FIRES, Math.max(0, rawNext))
        : DEFAULT_NEXT_FIRES;

      const [fires, entries] = await Promise.all([
        queryScheduleFires(auth.orgId, workflowId, windowDays, MAX_FIRE_ROWS),
        findScheduleEntriesForWorkflow(auth.orgId, workflowId),
      ]);

      const heatmap = bucketScheduleFires(fires);

      // One next-fires preview per schedule entry, keyed by node id. Only
      // enabled entries can actually fire, so disabled ones report an empty
      // preview (the cron expression is still surfaced so the UI can show it
      // greyed out). cron-parser handles DST internally; a corrupt cron row
      // degrades to `[]` rather than 500ing the observability surface.
      const upcoming = entries.map((entry) => ({
        nodeId: entry.nodeId,
        cronExpression: entry.cronExpression,
        enabled: entry.enabled,
        lastRunAt: entry.lastRunAt ? entry.lastRunAt.toISOString() : null,
        lastRunId: entry.lastRunId,
        nextFires: entry.enabled ? computeNextFires(entry.cronExpression, nextFiresCount) : [],
      }));

      return sendJson(res, {
        workflowId,
        windowDays,
        rowCap: MAX_FIRE_ROWS,
        // Whether the row cap was hit — the UI labels the heatmap as a sample
        // when true so operators know a busy cron's grid is partial.
        capped: fires.length >= MAX_FIRE_ROWS,
        heatmap,
        schedules: upcoming,
      });
    } },

  // DELETE /workflows/:id — SOFT-deletes the workflow (sets `deletedAt`) so a
  // deletion is recoverable via POST /workflows/:id/restore. Schedulers are
  // unregistered immediately (a deleted workflow must stop running), but the
  // `workflow_versions` + `workflow_metadata` rows are KEPT for restore; the
  // `system:retention` sweep hard-purges them once `deletedAt` is older than
  // `retention.deletedWorkflowsDays`. Runs/audit rows stay (orphan-tolerant,
  // no FK). Match excludes the single-segment sub-route names (GET or POST) so a
  // `DELETE /workflows/<name>` can't treat a sibling sub-route's name as a
  // workflow id — keep this in sync when a new `/workflows/<name>` route lands.
  { method: "DELETE",
    match: (url) => {
      if (!url.startsWith("/workflows/")) return false;
      const rest = url.slice("/workflows/".length).split("?")[0];
      if (rest.length === 0 || rest.includes("/")) return false;
      const reserved = new Set([
        "save", "rollback", "versions", "latest", "validate", "readiness", "health", "tags", "folders", "trash",
      ]);
      return !reserved.has(rest);
    },
    role: "editor",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const workflowId = url.pathname.slice("/workflows/".length);
      if (!workflowId) return sendError(res, "workflows_workflow_id_required", "workflowId is required", 400);

      // Only an active (not already soft-deleted) workflow can be deleted;
      // an absent/already-deleted id returns the same enumeration-safe 404.
      // The `RETURNING` makes the active→deleted transition a CAS, so two
      // concurrent DELETEs cannot both audit the same tombstone.
      const deleted = await db
        .update(workflows)
        .set({ deletedAt: new Date() })
        .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, auth.orgId), isNull(workflows.deletedAt)))
        .returning({ id: workflows.id });
      if (deleted.length === 0) return sendError(res, "workflow_not_found", "Workflow not found", 404);

      // Schedule teardown fails open — a Redis blip shouldn't block a
      // workflow delete from completing. A soft-deleted workflow is excluded
      // from every read + run path, so a stuck BullMQ scheduler is harmless
      // and self-clears; restore re-registers from the latest version.
      try {
        await unregisterAllForWorkflow(auth.orgId, workflowId);
      } catch (err) {
        console.error("[workflows-delete] schedule teardown failed", { workflowId, err });
      }

      await auditAction(auth, "workflow.deleted", { targetType: "workflow", targetId: workflowId, metadata: { soft: true } });
      return sendJson(res, { workflowId, ok: true });
    } },

  // POST /workflows/:id/restore — reverse a soft delete: clear `deletedAt` and
  // re-register schedules from the latest version (soft-delete unregistered
  // them). 404 if the workflow isn't currently soft-deleted.
  { method: "POST",
    match: (url) => {
      const path = url.split("?")[0];
      return path.startsWith("/workflows/") && path.endsWith("/restore");
    },
    role: "editor",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const matched = url.pathname.match(/^\/workflows\/([^/]+)\/restore$/);
      const workflowId = matched?.[1];
      if (!workflowId) return sendError(res, "workflows_workflow_id_required", "workflowId is required", 400);

      const restored = await db
        .update(workflows)
        .set({ deletedAt: null })
        .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, auth.orgId), isNotNull(workflows.deletedAt)))
        .returning({ id: workflows.id });
      if (restored.length === 0) return sendError(res, "workflow_not_found", "Workflow not found", 404);

      // Re-sync schedules from the latest version. Fails open like save —
      // a Redis blip shouldn't undo the restore; the worker's cold-start
      // replay reconciles via the deterministic scheduler id.
      try {
        const latest = await db
          .select({ id: workflowVersions.id, dagJson: workflowVersions.dagJson })
          .from(workflowVersions)
          .where(and(eq(workflowVersions.orgId, auth.orgId), eq(workflowVersions.workflowId, workflowId)))
          .orderBy(desc(workflowVersions.version))
          .limit(1);
        const parsed = latest[0] ? WorkflowSchema.safeParse(latest[0].dagJson) : null;
        if (latest[0] && parsed?.success) {
          await syncWorkflowSchedules({
            orgId: auth.orgId,
            workflowId,
            workflowVersionId: latest[0].id,
            nodes: parsed.data.nodes,
            createdBy: auth.userId,
          });
        }
      } catch (err) {
        console.error("[workflows-restore] schedule re-sync failed", { workflowId, err });
      }

      await auditAction(auth, "workflow.restored", { targetType: "workflow", targetId: workflowId });
      return sendJson(res, { workflowId, ok: true });
    } },

  // Validate
  { method: "POST", match: "/validate", role: "editor",
    handler: async ({ req, res }) => sendJson(res, validateWorkflow(await readJson(req, MAX_JSON_BODY_BYTES))) },

  // Production-readiness gate. Sister to `/validate` — this asserts
  // production posture (retries, bounds, raw secrets, approval upstream of
  // write-side actions, output declarations, rollback availability) on
  // top of the structural validation `/validate` already covers. The
  // engine portion is pure; the rollback-availability check is layered
  // here because it needs `workflow_versions` access. Body shape: either
  // a flat workflow JSON or `{ workflow }` envelope (mirrors `/validate`).
  { method: "POST", match: "/workflows/readiness", role: "editor",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const candidate = (body.workflow && typeof body.workflow === "object") ? asRecord(body.workflow) : body;
      const validation = validateWorkflow(candidate);
      if (!validation.valid) {
        const issues: ReadinessIssue[] = validation.issues.map((issue) => ({
          code: `invalid_workflow_${issue.code}`,
          severity: "fail" as const,
          message: issue.message,
          nodeId: issue.nodeId,
          edgeId: issue.edgeId,
        }));
        return sendJson(res, { status: "fail", issues } satisfies ReadinessResult);
      }
      const parsed = WorkflowSchema.parse(candidate);
      const baseResult = checkWorkflowReadiness(parsed);
      const [rollbackIssues, credentialIssues] = await Promise.all([
        checkRollbackAvailability(auth.orgId, parsed.id),
        getCredentialReadinessIssues(auth.orgId, parsed, productionSecretRefResolver),
      ]);
      const merged = mergeReadiness(baseResult, [...rollbackIssues, ...credentialIssues]);
      return sendJson(res, merged);
    } },

  // Workflow health rollup. Sister to /workflows/readiness — readiness is
  // a static rules-only gate; health is the rolled-up score across the
  // last 30 days of run activity (success rate, DLQ count, retry events,
  // p95 latency, cost-per-run, rollback availability) plus the static
  // readiness signal as the safety dimension. Returns a 0–100 score with
  // a per-category breakdown the web badge renders. Read-only — viewer
  // role suffices.
  // Recovery before/after delta — registered BEFORE `/workflows/health`
  // so the more-specific path wins in the first-match-wins dispatcher.
  // Splits the same time window by version cutoff: runs whose version
  // < `afterVersion` form the "before" side; runs whose version >= cutoff
  // form the "after" side. Returns both health scores plus a per-signal
  // delta, the run-status counter (always populated), the same-failure
  // check (when the caller supplies the prior signature), and the prior
  // version's id (for the regression-rollback affordance in the dialog).
  { method: "GET", match: (url) => url === "/workflows/health/delta" || url.startsWith("/workflows/health/delta?"), role: "viewer",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const workflowId = url.searchParams.get("workflowId");
      const rawAfter = url.searchParams.get("afterVersion");
      const parsedAfterVersion = rawAfter == null ? NaN : Number(rawAfter);
      const afterVersion = Number.isInteger(parsedAfterVersion) ? parsedAfterVersion : NaN;
      if (!workflowId) return sendError(res, "workflows_workflow_id_required", "workflowId is required", 400);
      if (!Number.isFinite(afterVersion) || afterVersion < 1) {
        return sendError(res, "workflows_after_version_invalid", "afterVersion must be a positive integer", 400);
      }
      const parsedWindowDays = Number(url.searchParams.get("windowDays") ?? NaN);
      // Default to the same 30-day window the bare /workflows/health route
      // uses. With a 1-day default, production runs accumulating over weeks
      // would never meet the 5-run threshold and the dialog would
      // perpetually show the gathering-data state.
      const windowDays = Number.isInteger(parsedWindowDays)
        ? Math.min(30, Math.max(1, parsedWindowDays))
        : DEFAULT_HEALTH_WINDOW_DAYS;
      const rawSignature = url.searchParams.get("priorFailureSignature");
      const priorFailureSignature = rawSignature && rawSignature.length <= 256 ? rawSignature : null;

      // Multi-tenant gate first — same enumeration-safe message as the
      // bare `/workflows/health` route.
      const owned = await db
        .select({ id: workflows.id })
        .from(workflows)
        .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, auth.orgId), isNull(workflows.deletedAt)))
        .limit(1);
      if (owned.length === 0) return sendError(res, "workflow_not_found", "Workflow not found", 404);

      // Latest version drives readiness (the workflow JSON the operator
      // currently saved is the post-Apply state). The before-side health
      // score uses the same readiness — it's per-DAG, not per-window.
      const latestVersion = await db
        .select({ dagJson: workflowVersions.dagJson })
        .from(workflowVersions)
        .where(and(eq(workflowVersions.orgId, auth.orgId), eq(workflowVersions.workflowId, workflowId)))
        .orderBy(desc(workflowVersions.version))
        .limit(1);
      if (latestVersion.length === 0) {
        return sendError(res, "workflows_no_versions", "Workflow has no versions", 404);
      }
      const parsedWorkflow = WorkflowSchema.safeParse(latestVersion[0].dagJson);
      if (!parsedWorkflow.success) {
        return sendError(res, "workflows_version_malformed", "Workflow version is malformed", 422);
      }

      const baseReadiness = checkWorkflowReadiness(parsedWorkflow.data);
      const [rollbackIssues, credentialIssues] = await Promise.all([
        checkRollbackAvailability(auth.orgId, workflowId),
        getCredentialReadinessIssues(auth.orgId, parsedWorkflow.data, productionSecretRefResolver),
      ]);
      const readiness = mergeReadiness(baseReadiness, [...rollbackIssues, ...credentialIssues]);

      // Before/after signal collection in parallel — each side reuses the
      // same query plan with a single new `lt`/`gte` predicate on the
      // joined `workflow_versions.version` column.
      const [beforeSignals, afterSignals] = await Promise.all([
        queryHealthSignals(auth.orgId, workflowId, windowDays, { side: "before", cutoffVersion: afterVersion }),
        queryHealthSignals(auth.orgId, workflowId, windowDays, { side: "after", cutoffVersion: afterVersion }),
      ]);

      // Same SLO declaration applies to both sides — the operator's
      // current contract is what they expect the workflow to satisfy
      // regardless of which historical run window we're scoring.
      const sloEntry = await getWorkflowSlo(auth.orgId, workflowId);
      const declaredSlo = sloEntry?.slo ?? null;
      const before = computeWorkflowHealth({ workflow: parsedWorkflow.data, readiness, signals: beforeSignals, slo: declaredSlo });
      const after = computeWorkflowHealth({ workflow: parsedWorkflow.data, readiness, signals: afterSignals, slo: declaredSlo });

      // Run-status counter — distinct from `after.signals.totalRuns`
      // because the health rollup counts only terminal runs. The counter
      // surfaces in-flight runs so the operator sees "1 running, 0
      // terminal" right after Apply rather than a dead "0 runs".
      // Excludes sandbox/validation runs (replayMode = "validation") so a
      // dry-run from the Recovery dialog's validation gate doesn't appear
      // as a phantom production run in the counter.
      const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
      const recentRunsRows = await db
        .select({ status: runs.status })
        .from(runs)
        .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
        .where(and(
          eq(workflowVersions.orgId, auth.orgId),
          eq(workflowVersions.workflowId, workflowId),
          gte(workflowVersions.version, afterVersion),
          gte(runs.createdAt, since),
          isNull(runs.replayMode),
        ));
      const recentRunsAgainstAfter = {
        totalRuns: recentRunsRows.length,
        succeeded: recentRunsRows.filter((row) => row.status === "succeeded").length,
        failed: recentRunsRows.filter((row) => FAILED_RUN_STATUS_SET.has(row.status)).length,
        running: recentRunsRows.filter((row) => OPEN_RUN_STATUS_SET.has(row.status)).length,
      };

      // Same-failure check — only when the caller supplies the original
      // signature. We re-normalize each new DLQ row and count matches.
      // Defense-in-depth: the response only echoes back the
      // caller-supplied signature, never a freshly-derived one, so a
      // leaked-secret-in-error-message can't slip through this surface.
      let sameFailureSinceApply: { count: number; sampleDeadLetterIds: string[]; priorSignature: string } | null = null;
      if (priorFailureSignature) {
        const dlqRows = await db
          .select({
            id: deadLetters.id,
            errorJson: deadLetters.errorJson,
            nodeId: deadLetters.nodeId,
            nodeJson: deadLetters.nodeJson,
          })
          .from(deadLetters)
          .innerJoin(runs, eq(runs.id, deadLetters.runId))
          .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
          .where(and(
            eq(deadLetters.orgId, auth.orgId),
            eq(workflowVersions.orgId, auth.orgId),
            eq(workflowVersions.workflowId, workflowId),
            gte(workflowVersions.version, afterVersion),
            gte(deadLetters.createdAt, since),
          ))
          .limit(100);
        const matchingIds: string[] = [];
        for (const row of dlqRows) {
          const nodeJson = row.nodeJson as { type?: string } | null;
          const sig = normalizeErrorSignature(row.errorJson, {
            nodeId: row.nodeId,
            nodeType: nodeJson?.type,
          });
          if (sig.signature === priorFailureSignature) {
            matchingIds.push(row.id);
          }
        }
        sameFailureSinceApply = {
          count: matchingIds.length,
          sampleDeadLetterIds: matchingIds.slice(0, 5),
          // Echo the caller-supplied signature only — never a derived one.
          priorSignature: priorFailureSignature,
        };
      }

      // Prior version availability — drives the regression-rollback
      // affordance in the dialog. We only need {version, versionId}; the
      // dagJson is fetched lazily on button click via /workflows/versions.
      let priorVersion: { version: number; versionId: string } | null = null;
      if (afterVersion > 1) {
        const priorRows = await db
          .select({ version: workflowVersions.version, versionId: workflowVersions.id })
          .from(workflowVersions)
          .where(and(
            eq(workflowVersions.orgId, auth.orgId),
            eq(workflowVersions.workflowId, workflowId),
            eq(workflowVersions.version, afterVersion - 1),
          ))
          .limit(1);
        if (priorRows.length > 0 && priorRows[0]) {
          priorVersion = { version: priorRows[0].version, versionId: priorRows[0].versionId };
        }
      }

      // Delta math — only meaningful with enough samples on the after side.
      const hasEnoughData = afterSignals.totalRuns >= MIN_RUNS_FOR_DELTA;
      let delta: { score: number; p95LatencyMs: number | null; costPerRunUsd: number | null } | null = null;
      if (hasEnoughData) {
        const p95Delta = (afterSignals.p95LatencyMs == null || beforeSignals.p95LatencyMs == null)
          ? null
          : afterSignals.p95LatencyMs - beforeSignals.p95LatencyMs;
        const costPerRunBefore = beforeSignals.totalRuns > 0 ? beforeSignals.totalCostUsd / beforeSignals.totalRuns : null;
        const costPerRunAfter = afterSignals.totalRuns > 0 ? afterSignals.totalCostUsd / afterSignals.totalRuns : null;
        const costDelta = (costPerRunBefore == null || costPerRunAfter == null) ? null : costPerRunAfter - costPerRunBefore;
        delta = {
          score: after.score - before.score,
          p95LatencyMs: p95Delta,
          costPerRunUsd: costDelta,
        };
      }

      return sendJson(res, {
        workflowId,
        afterVersion,
        windowDays,
        hasEnoughData,
        before,
        after,
        delta,
        recentRunsAgainstAfter,
        sameFailureSinceApply,
        priorVersion,
      });
    } },

  { method: "GET", match: (url) => url === "/workflows/health" || url.startsWith("/workflows/health?"), role: "viewer",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const workflowId = url.searchParams.get("workflowId");
      if (!workflowId) return sendError(res, "workflows_workflow_id_required", "workflowId is required", 400);

      // Multi-tenant gate: confirm the workflow belongs to the caller's org
      // before doing any work.
      const owned = await db
        .select({ id: workflows.id })
        .from(workflows)
        .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, auth.orgId), isNull(workflows.deletedAt)))
        .limit(1);
      if (owned.length === 0) return sendError(res, "workflow_not_found", "Workflow not found", 404);

      // Latest version drives the readiness check (the workflow JSON the
      // operator currently saved). Falling back to readiness on the
      // latest snapshot mirrors the dashboard expectation: "what does
      // production look like right now?"
      const latestVersion = await db
        .select({ dagJson: workflowVersions.dagJson })
        .from(workflowVersions)
        .where(and(eq(workflowVersions.orgId, auth.orgId), eq(workflowVersions.workflowId, workflowId)))
        .orderBy(desc(workflowVersions.version))
        .limit(1);
      if (latestVersion.length === 0) {
        return sendError(res, "workflows_no_versions", "Workflow has no versions", 404);
      }

      const parsedWorkflow = WorkflowSchema.safeParse(latestVersion[0].dagJson);
      if (!parsedWorkflow.success) {
        return sendError(res, "workflows_version_malformed", "Workflow version is malformed", 422);
      }
      // Layer rollback-availability on top of the static readiness check
      // so the health rollup's safety dimension counts the same issues
      // /workflows/readiness reports — single-version workflows otherwise
      // score higher on safety in the health badge than the readiness
      // badge admits.
      const baseReadiness = checkWorkflowReadiness(parsedWorkflow.data);
      const [rollbackIssues, credentialIssues] = await Promise.all([
        checkRollbackAvailability(auth.orgId, workflowId),
        getCredentialReadinessIssues(auth.orgId, parsedWorkflow.data, productionSecretRefResolver),
      ]);
      const readiness = mergeReadiness(baseReadiness, [...rollbackIssues, ...credentialIssues]);
      const [signals, sloEntry] = await Promise.all([
        queryHealthSignals(auth.orgId, workflowId),
        getWorkflowSlo(auth.orgId, workflowId),
      ]);
      const health = computeWorkflowHealth({
        workflow: parsedWorkflow.data,
        readiness,
        signals,
        slo: sloEntry?.slo ?? null,
      });
      return sendJson(res, health);
    } },
];
