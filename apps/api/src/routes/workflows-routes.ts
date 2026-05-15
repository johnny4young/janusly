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

import { and, desc, eq, gte, isNull } from "drizzle-orm";

import {
  db,
  deadLetters,
  runs,
  workflows,
  workflowVersions,
} from "@janusly/db";
import { collectHealthSignals, DEFAULT_HEALTH_WINDOW_DAYS } from "@janusly/data/src/workflowHealthRepo";
import { unregisterAllForWorkflow } from "@janusly/engine/src/schedule-scheduler";
import { computeWorkflowHealth, MIN_RUNS_FOR_DELTA } from "@janusly/engine/src/workflow-health";
import { checkWorkflowReadiness, type ReadinessIssue, type ReadinessResult } from "@janusly/engine/src/workflow-readiness";
import { validateWorkflow } from "@janusly/engine/src/workflow-validation";
import { WorkflowSchema } from "@janusly/shared";
import { normalizeErrorSignature } from "@janusly/shared/src/error-signature";

import { audit } from "../audit";
import { FAILED_RUN_STATUS_SET, MAX_JSON_BODY_BYTES, OPEN_RUN_STATUS_SET } from "../api-config";
import { errorEnvelope } from "../error-codes";
import { asRecord, readJson, sendJson } from "../http";
import { isMcpWriteAllowed, mcpAuditMetadata, mcpRateLimitBucket } from "../mcp-consent";
import { enforceRateLimit } from "../rate-limit";
import { checkRollbackAvailability, mergeReadiness } from "../readiness-helpers";
import type { Route } from "../routes";
import { rollbackAuditMetadata, rollbackWorkflowToVersion } from "../workflows-rollback";
import { saveWorkflowVersion } from "../workflows-save";

export const workflowsRoutes: Route[] = [
  // Workflows — list + version reads + save
  // NOTE: `/workflows/versions` and `/workflows/latest` come BEFORE `/workflows`
  // so the prefix-but-not-`/workflows/` matcher doesn't shadow them.
  { method: "GET", match: (url) => url.startsWith("/workflows/versions"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const workflowId = url.searchParams.get("workflowId");
      if (!workflowId) return sendJson(res, { error: "workflowId is required" }, 400);
      const versions = await db.select().from(workflowVersions).where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.orgId, auth.orgId))).orderBy(desc(workflowVersions.version));
      return sendJson(res, versions);
    } },
  { method: "GET", match: (url) => url.startsWith("/workflows/latest"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const workflowId = url.searchParams.get("workflowId");
      if (!workflowId) return sendJson(res, { error: "workflowId is required" }, 400);
      const versions = await db.select().from(workflowVersions).where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.orgId, auth.orgId))).orderBy(desc(workflowVersions.version));
      return sendJson(res, versions[0] ?? null);
    } },
  { method: "GET", match: (url) => url.startsWith("/workflows") && !url.startsWith("/workflows/"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const limitParam = Number(url.searchParams.get("limit"));
      const limitValue = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 100;
      const rows = await db.select().from(workflows).where(eq(workflows.orgId, auth.orgId)).orderBy(desc(workflows.createdAt)).limit(limitValue);
      return sendJson(res, rows);
    } },
  { method: "POST", match: "/workflows/save", role: "editor", permission: "workflows.write",
    handler: async ({ req, res, auth }) => {
      // MCP-source mutations gate on the process-wide env AND the
      // tenant's `mcp.writeConsent` flag. Both must be true; otherwise
      // 403 with a stable code the MCP client can render. Per-tool rate
      // limit fires for MCP-source traffic so a misbehaving client
      // can't flood a tenant.
      if (auth.source === "mcp") {
        const consent = await isMcpWriteAllowed(auth.orgId);
        if (!consent.allowed) {
          return sendJson(res, { error: consent.message, code: `mcp_${consent.reason}` }, 403);
        }
        await enforceRateLimit(auth.orgId, {
          name: mcpRateLimitBucket("workflows.save"),
          windowMs: 60_000,
          max: 60,
        });
      }

      const workflow = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const validation = validateWorkflow(workflow);
      if (!validation.valid) return sendJson(res, { error: "Validation failed", issues: validation.issues }, 400);
      const parsedWorkflow = WorkflowSchema.parse(workflow);

      // Concurrent saves for the same `(orgId, workflowId)` resolve via
      // a bounded unique-constraint retry inside `saveWorkflowVersion`.
      // On exhausted retries the helper returns `kind: "conflict"` so
      // the operator sees a clean 409 ("please retry") instead of the
      // 5xx the inline transaction used to emit.
      const result = await saveWorkflowVersion({
        orgId: auth.orgId,
        userId: auth.userId,
        parsedWorkflow,
      });

      if (result.kind === "conflict") {
        return sendJson(res, {
          error: "Concurrent save conflict — please retry",
          attempts: result.attempts,
        }, 409);
      }

      const auditMetadata: Record<string, unknown> = {
        version: result.version,
        attempts: result.attempts,
      };
      if (auth.source === "mcp") {
        Object.assign(auditMetadata, mcpAuditMetadata(auth));
      }
      await audit(auth.orgId, auth.userId, "workflow.saved", "workflow", result.workflowId, auditMetadata);
      return sendJson(res, {
        workflowId: result.workflowId,
        versionId: result.versionId,
        version: result.version,
      });
    } },
  { method: "POST", match: "/workflows/rollback", role: "editor",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const workflowId = typeof body.workflowId === "string" ? body.workflowId : "";
      const sourceVersionId = typeof body.sourceVersionId === "string" ? body.sourceVersionId : "";
      if (!workflowId || !sourceVersionId) {
        return sendJson(res, { error: "workflowId and sourceVersionId are required" }, 400);
      }
      const result = await rollbackWorkflowToVersion({
        orgId: auth.orgId,
        userId: auth.userId,
        workflowId,
        sourceVersionId,
      });
      if (!result.ok) {
        return sendJson(res, { error: "Source version not found" }, 404);
      }
      await audit(auth.orgId, auth.userId, "workflow.rolled_back", "workflow", workflowId, rollbackAuditMetadata(result));
      return sendJson(res, {
        workflowId,
        versionId: result.versionId,
        version: result.version,
        sourceVersion: result.sourceVersion,
      });
    } },
  // DELETE /workflows/:id — hard-deletes the workflow + every persisted
  // version + every cron-driven schedule entry (and its BullMQ
  // scheduler). Runs and audit rows stay; their `workflow_version_id`
  // text column has no FK constraint, so orphan references are tolerated
  // for history. Match excludes special POST-only subpaths so a future
  // edit can't accidentally route `/workflows/save` here on the wrong
  // method.
  { method: "DELETE",
    match: (url) => {
      if (!url.startsWith("/workflows/")) return false;
      const rest = url.slice("/workflows/".length).split("?")[0];
      if (rest.length === 0 || rest.includes("/")) return false;
      const reserved = new Set(["save", "rollback", "versions", "latest", "validate", "readiness", "health"]);
      return !reserved.has(rest);
    },
    role: "editor",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const workflowId = url.pathname.slice("/workflows/".length);
      if (!workflowId) return sendJson(res, { error: "workflowId is required" }, 400);

      const existing = await db.select().from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.orgId, auth.orgId)));
      if (!existing[0]) return sendJson(res, errorEnvelope("workflow_not_found", "Workflow not found"), 404);

      // Schedule teardown fails open — a Redis blip shouldn't block a
      // workflow delete from completing. The worker's cold-start replay
      // won't re-register entries whose DB rows are gone, so a stuck
      // BullMQ scheduler self-clears after the rows go away.
      try {
        await unregisterAllForWorkflow(auth.orgId, workflowId);
      } catch (err) {
        console.error("[workflows-delete] schedule teardown failed", { workflowId, err });
      }
      await db.delete(workflowVersions).where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.orgId, auth.orgId)));
      await db.delete(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.orgId, auth.orgId)));

      await audit(auth.orgId, auth.userId, "workflow.deleted", "workflow", workflowId, {});
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
        }));
        return sendJson(res, { status: "fail", issues } satisfies ReadinessResult);
      }
      const parsed = WorkflowSchema.parse(candidate);
      const baseResult = checkWorkflowReadiness(parsed);
      const rollbackIssues = await checkRollbackAvailability(auth.orgId, parsed.id);
      const merged = mergeReadiness(baseResult, rollbackIssues);
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
      if (!workflowId) return sendJson(res, { error: "workflowId is required" }, 400);
      if (!Number.isFinite(afterVersion) || afterVersion < 1) {
        return sendJson(res, { error: "afterVersion must be a positive integer" }, 400);
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
        .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, auth.orgId)))
        .limit(1);
      if (owned.length === 0) return sendJson(res, errorEnvelope("workflow_not_found", "Workflow not found"), 404);

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
        return sendJson(res, { error: "Workflow has no versions" }, 404);
      }
      const parsedWorkflow = WorkflowSchema.safeParse(latestVersion[0].dagJson);
      if (!parsedWorkflow.success) {
        return sendJson(res, { error: "Workflow version is malformed" }, 422);
      }

      const baseReadiness = checkWorkflowReadiness(parsedWorkflow.data);
      const rollbackIssues = await checkRollbackAvailability(auth.orgId, workflowId);
      const readiness = mergeReadiness(baseReadiness, rollbackIssues);

      // Before/after signal collection in parallel — each side reuses the
      // same query plan with a single new `lt`/`gte` predicate on the
      // joined `workflow_versions.version` column.
      const [beforeSignals, afterSignals] = await Promise.all([
        collectHealthSignals(auth.orgId, workflowId, windowDays, { side: "before", cutoffVersion: afterVersion }),
        collectHealthSignals(auth.orgId, workflowId, windowDays, { side: "after", cutoffVersion: afterVersion }),
      ]);

      const before = computeWorkflowHealth({ workflow: parsedWorkflow.data, readiness, signals: beforeSignals });
      const after = computeWorkflowHealth({ workflow: parsedWorkflow.data, readiness, signals: afterSignals });

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
      if (!workflowId) return sendJson(res, { error: "workflowId is required" }, 400);

      // Multi-tenant gate: confirm the workflow belongs to the caller's org
      // before doing any work.
      const owned = await db
        .select({ id: workflows.id })
        .from(workflows)
        .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, auth.orgId)))
        .limit(1);
      if (owned.length === 0) return sendJson(res, errorEnvelope("workflow_not_found", "Workflow not found"), 404);

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
        return sendJson(res, { error: "Workflow has no versions" }, 404);
      }

      const parsedWorkflow = WorkflowSchema.safeParse(latestVersion[0].dagJson);
      if (!parsedWorkflow.success) {
        return sendJson(res, { error: "Workflow version is malformed" }, 422);
      }
      // Layer rollback-availability on top of the static readiness check
      // so the health rollup's safety dimension counts the same issues
      // /workflows/readiness reports — single-version workflows otherwise
      // score higher on safety in the health badge than the readiness
      // badge admits.
      const baseReadiness = checkWorkflowReadiness(parsedWorkflow.data);
      const rollbackIssues = await checkRollbackAvailability(auth.orgId, workflowId);
      const readiness = mergeReadiness(baseReadiness, rollbackIssues);
      const signals = await collectHealthSignals(auth.orgId, workflowId);
      const health = computeWorkflowHealth({ workflow: parsedWorkflow.data, readiness, signals });
      return sendJson(res, health);
    } },
];
