/** Whole-run and targeted Replay Lab routes. */

import { and, eq } from "drizzle-orm";

import { db, runs, workflowVersions } from "@janusly/db";
import {
  replayRunAsValidation,
  replayRunAsValidationFork,
} from "@janusly/engine/src/adapters/replay-lab";
import { WorkflowSchema, type Workflow } from "@janusly/shared";

import { MAX_JSON_BODY_BYTES } from "../../api-config";
import { auditAction } from "../../audit-helper";
import { orgLlmRuntime, sanitizeAiWorkflow } from "../../ai-runtime";
import { RATE_LIMIT_WINDOW_MS } from "../../constants";
import { asRecord, readJson, sendError, sendJson } from "../../http";
import { enforceRateLimit } from "../../rate-limit";
import type { Route } from "../../routes";

export const replayLabRoutes: Route[] = [
  // Replay Lab — standalone sandbox replay. Creates a fresh validation
  // run from ANY source run (not just a DLQ entry) and re-executes the
  // workflow from root nodes. The source run's workflow snapshot is
  // pulled from `workflow_versions.dagJson` (saved workflow) or from
  // `runs.inputJson.workflow` (ad-hoc fallback); an optional caller
  // `suggestedWorkflow` overrides the snapshot and is validated through
  // the same `WorkflowSchema` + `sanitizeAiWorkflow` chain `/dlq/validate-fix`
  // uses. The new run carries `replayMode = "validation"` so the engine's
  // dryRun gating, write-side skips, and rollup exclusions apply
  // automatically; the audit row distinguishes the lab intent from the
  // recovery-dialog intent (`replay_lab.started` vs
  // `recovery.validation_started`).
  { method: "POST", match: "/runs/replay-lab", role: "editor", permission: "runs.start",
    handler: async ({ req, res, auth }) => {
      const { orgConfig } = await orgLlmRuntime(auth.orgId);
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: RATE_LIMIT_WINDOW_MS, max: orgConfig.ai.rateLimitPerMin });
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));

      const sourceRunId = typeof body.sourceRunId === "string" ? body.sourceRunId : null;
      if (!sourceRunId) return sendError(res, "runs_source_run_id_required", "sourceRunId is required", 400);

      // Org-scope the source run and reject cross-org / unknown ids with
      // an identical 404 envelope — no enumeration leak.
      const sourceRows = await db.select().from(runs).where(and(eq(runs.id, sourceRunId), eq(runs.orgId, auth.orgId)));
      const sourceRun = sourceRows[0];
      if (!sourceRun) return sendError(res, "runs_source_run_not_found", "Source run not found", 404);

      // No nested labs — a sandbox run is itself a validation run; replaying
      // it would just create a sibling sandbox with the same snapshot.
      if (sourceRun.replayMode) {
        return sendError(res, "nested_replay_lab", "Source run is itself a sandbox run; cannot start a nested lab", 400);
      }

      // Resolve the workflow snapshot. Precedence: caller-supplied patch >
      // saved workflow_versions.dagJson > ad-hoc runs.inputJson.workflow.
      let workflow: Workflow;
      const hasPatch = body.suggestedWorkflow !== undefined && body.suggestedWorkflow !== null;
      if (hasPatch) {
        if (typeof body.suggestedWorkflow !== "object") {
          return sendError(res, "runs_suggested_workflow_not_object", "suggestedWorkflow must be an object", 400);
        }
        const parsed = WorkflowSchema.safeParse(body.suggestedWorkflow);
        if (!parsed.success) {
          return sendError(
            res,
            "runs_suggested_workflow_invalid",
            "suggestedWorkflow failed schema validation: {{reason}}",
            400,
            { reason: parsed.error.issues[0]?.message ?? "unknown" },
          );
        }
        try {
          workflow = sanitizeAiWorkflow(parsed.data);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return sendError(res, "runs_suggested_workflow_sanitize_failed", "suggestedWorkflow sanitize failed: {{reason}}", 400, { reason });
        }
      } else {
        // No patch — load the source's own workflow snapshot. Try the saved
        // version first (most common), fall back to the ad-hoc inputJson.
        const versionRows = await db
          .select()
          .from(workflowVersions)
          .where(and(eq(workflowVersions.id, sourceRun.workflowVersionId), eq(workflowVersions.orgId, auth.orgId)));
        const version = versionRows[0];
        let snapshot: unknown = version?.dagJson;
        if (!snapshot) {
          const input = sourceRun.inputJson as Record<string, unknown> | null;
          snapshot = input && typeof input === "object" ? input.workflow : null;
        }
        if (!snapshot) {
          return sendError(res, "no_workflow_snapshot", "Source run has no workflow snapshot available; supply suggestedWorkflow", 400);
        }
        const parsed = WorkflowSchema.safeParse(snapshot);
        if (!parsed.success) {
          return sendError(
            res,
            "invalid_snapshot",
            "Source run snapshot failed schema validation: {{reason}}",
            400,
            { reason: parsed.error.issues[0]?.message ?? "unknown" },
          );
        }
        workflow = parsed.data;
      }

      // Propagate trigger-time input from the source run so workflows
      // that reference `{{input.*}}` behave identically in the sandbox.
      // `startRun` writes `inputJson: { workflow, input }` — read the
      // same key here. Falls back to `{}` for ad-hoc runs whose
      // inputJson predates the input field.
      const sourceInputJson = sourceRun.inputJson as Record<string, unknown> | null;
      const triggerInput = sourceInputJson && typeof sourceInputJson === "object"
        ? sourceInputJson.input
        : undefined;

      const { runId: replayRunId } = await replayRunAsValidation({
        orgId: auth.orgId,
        sourceRunId,
        workflow,
        input: triggerInput,
        createdBy: auth.userId,
        hasPatch,
      });

      await auditAction(auth, "replay_lab.started", { targetType: "run", targetId: sourceRunId, metadata: {
        replayRunId,
        hasPatch,
      } });

      return sendJson(res, { runId: replayRunId });
    } },
  // Targeted Replay Lab fork — re-run a workflow starting at one node
  // instead of from scratch. Predecessors of the fork node are cloned
  // from the source run's terminal state (status='succeeded' with
  // stateJson copied) so the fork node can read upstream outputs without
  // re-paying the cost of HTTP / AI / tool calls that already succeeded.
  // Same `replayMode='validation'` flag as the whole-run replay-lab so
  // the engine's dryRun gate skips write-side effects uniformly.
  // Audit action `replay_lab.fork_started` distinguishes forks from
  // whole-run replays at compliance read time.
  { method: "POST", match: "/runs/replay-lab/fork", role: "editor", permission: "runs.start",
    handler: async ({ req, res, auth }) => {
      const { orgConfig } = await orgLlmRuntime(auth.orgId);
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: RATE_LIMIT_WINDOW_MS, max: orgConfig.ai.rateLimitPerMin });
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));

      const sourceRunId = typeof body.sourceRunId === "string" ? body.sourceRunId : null;
      if (!sourceRunId) return sendError(res, "invalid_input", "sourceRunId is required", 400);

      const forkNodeId = typeof body.forkNodeId === "string" ? body.forkNodeId : null;
      if (!forkNodeId) return sendError(res, "invalid_input", "forkNodeId is required", 400);

      // Defensive cap on inputOverride size — same shape as the audit
      // metadata cap. Over-cap landings would balloon `run_nodes.stateJson`
      // and `run_events.payload` later; reject up-front with a clear code.
      if (body.inputOverride !== undefined) {
        const overrideBytes = Buffer.byteLength(JSON.stringify(body.inputOverride), "utf8");
        if (overrideBytes > 64_000) {
          return sendError(
            res,
            "override_too_large",
            "inputOverride exceeds 64 KiB cap ({{overrideBytes}} bytes)",
            422,
            { overrideBytes },
          );
        }
      }

      // Org-scope the source run. Cross-org / unknown id → 404 (no enumeration leak).
      const sourceRows = await db.select().from(runs).where(and(eq(runs.id, sourceRunId), eq(runs.orgId, auth.orgId)));
      const sourceRun = sourceRows[0];
      if (!sourceRun) return sendError(res, "not_found", "Source run not found", 404);

      // No nested forks — source run can't itself be a sandbox run.
      if (sourceRun.replayMode) {
        return sendError(res, "nested_replay_lab", "Source run is itself a sandbox run; cannot fork from it", 400);
      }

      // Resolve the workflow snapshot. v1 forks DO NOT accept a patched
      // workflow — they replay the source's own snapshot at the fork node
      // (patches go through the whole-run lab path so the patch validation
      // covers the full DAG). If a future use case wants "fork + patch",
      // it's a separate route.
      const versionRows = await db
        .select()
        .from(workflowVersions)
        .where(and(eq(workflowVersions.id, sourceRun.workflowVersionId), eq(workflowVersions.orgId, auth.orgId)));
      const version = versionRows[0];
      let snapshot: unknown = version?.dagJson;
      if (!snapshot) {
        const input = sourceRun.inputJson as Record<string, unknown> | null;
        snapshot = input && typeof input === "object" ? input.workflow : null;
      }
      if (!snapshot) {
        return sendError(res, "no_workflow_snapshot", "Source run has no workflow snapshot available; cannot fork", 400);
      }
      const parsed = WorkflowSchema.safeParse(snapshot);
      if (!parsed.success) {
        return sendError(
          res,
          "invalid_snapshot",
          "Source run snapshot failed schema validation: {{reason}}",
          400,
          { reason: parsed.error.issues[0]?.message ?? "unknown" },
        );
      }
      const workflow = parsed.data;

      // Propagate trigger-time input so `{{input.*}}` references resolve
      // to the same values the source run saw at predecessors.
      const sourceInputJson = sourceRun.inputJson as Record<string, unknown> | null;
      const triggerInput = sourceInputJson && typeof sourceInputJson === "object"
        ? sourceInputJson.input
        : undefined;

      const result = await replayRunAsValidationFork({
        orgId: auth.orgId,
        sourceRunId,
        workflow,
        forkNodeId,
        inputOverride: body.inputOverride,
        input: triggerInput,
        createdBy: auth.userId,
      });

      if (!result.ok) {
        // Map adapter discriminated errors to HTTP codes. `fork_node_not_found`
        // is a 422 (caller supplied a value the route accepted shape-wise
        // but the workflow doesn't have that node). `predecessor_not_succeeded`
        // is a 422 (we can't fork past an unreliable upstream).
        return sendError(res, result.code, result.message, 422);
      }

      await auditAction(auth, "replay_lab.fork_started", { targetType: "run", targetId: sourceRunId, metadata: {
        replayRunId: result.runId,
        forkNodeId,
        predecessorCount: result.predecessorCount,
        hasOverride: body.inputOverride !== undefined,
      } });

      return sendJson(res, {
        runId: result.runId,
        predecessorCount: result.predecessorCount,
      });
    } },
];
