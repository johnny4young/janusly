/**
 * Operator-facing routes for the supervised auto-healing decision
 * ledger. Four endpoints:
 *
 *   - `GET /auto-healing/pending` — list validated rows awaiting a
 *     decision. Capped at 100/200 per the project pagination rule.
 *   - `GET /auto-healing/:id` — detail view including the proposed
 *     patch JSON + validation run id. Used by the web card's expand.
 *   - `POST /auto-healing/:id/decide` — operator accept or decline.
 *     CAS-style write so a sibling watcher's auto-apply cycle can't
 *     race with the operator click; loser surfaces 409.
 *   - `POST /auto-healing/scan` — admin-only ad-hoc scan trigger
 *     (skip the cron wait). Rate-limited via the existing `"ai"`
 *     bucket because the scan spends LLM budget.
 *
 * The decide endpoint also writes a `recovery_feedback` row mirroring
 * the existing dialog's shape so the LLM's `pastFeedbackSummary` learns
 * from auto-healing decisions in the same way it learns from manual
 * recovery decisions.
 *
 * Multi-tenant scope is enforced via every read/write — `orgId` is
 * taken from `auth.orgId`, never from request input.
 */

import { z } from "zod";
import { runOrgScan } from "../auto-healing-scanner";
import {
  getByIdForOrg,
  listPendingForOrg,
  recordDecision,
  recordRecoveryFeedback,
} from "@janusly/data";
import { DLQReplayAdapter } from "@janusly/engine/src/adapters/dlq-replay";
import { WorkflowSchema, type Workflow, type WorkflowNode } from "@janusly/shared";

import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { RATE_LIMIT_DEFAULTS_PER_MIN, RATE_LIMIT_WINDOW_MS } from "../constants";
import { enforceRateLimit } from "../rate-limit";
import { asRecord, readJson, sendError, sendJson } from "../http";
import { db } from "@janusly/db";
import { deadLetters } from "@janusly/db";
import { and, eq } from "drizzle-orm";
import { markDeadLetterReplayed } from "../dlq";
import type { Route } from "../routes";

const dlqReplay = new DLQReplayAdapter();

const DecideBodySchema = z.object({
  accepted: z.boolean(),
  comment: z.string().max(2000).optional(),
});

function pathParam(url: string, segmentIndex: number): string | null {
  const path = url.split("?")[0] ?? "";
  const parts = path.split("/").filter(Boolean);
  return parts[segmentIndex] ?? null;
}

export const autoHealingRoutes: Route[] = [
  {
    method: "GET",
    match: "/auto-healing/pending",
    permission: "autohealing.read",
    handler: async ({ req, res, auth }) => {
      const limitRaw = new URL(req.url ?? "/", "http://x").searchParams.get("limit");
      const limit = limitRaw ? Math.max(1, Math.min(200, Number(limitRaw) || 100)) : 100;
      const rows = await listPendingForOrg(auth.orgId, limit);
      return sendJson(res, { rows });
    },
  },
  {
    method: "GET",
    match: (url) => /^\/auto-healing\/[^/?]+$/.test(url.split("?")[0] ?? ""),
    permission: "autohealing.read",
    handler: async ({ req, res, auth }) => {
      const id = pathParam(req.url ?? "", 1);
      if (!id) return sendError(res, "autoheal_missing_id", "missing id", 400);
      const row = await getByIdForOrg(auth.orgId, id);
      if (!row) return sendError(res, "autoheal_not_found", "Not found", 404);
      return sendJson(res, { row });
    },
  },
  {
    method: "POST",
    match: (url) => /^\/auto-healing\/[^/]+\/decide$/.test(url.split("?")[0] ?? ""),
    role: "editor",
    permission: "autohealing.decide",
    handler: async ({ req, res, auth }) => {
      const id = pathParam(req.url ?? "", 1);
      if (!id) return sendError(res, "autoheal_missing_id", "missing id", 400);
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const parse = DecideBodySchema.safeParse(body);
      if (!parse.success) {
        return sendError(res, "autoheal_invalid_body", "invalid body", 400);
      }
      const { accepted, comment } = parse.data;

      const row = await getByIdForOrg(auth.orgId, id);
      if (!row) return sendError(res, "autoheal_not_found", "Not found", 404);
      if (row.status !== "validated") {
        return sendError(
          res,
          "autoheal_not_pending",
          "Auto-healing row is not pending a decision",
          409,
        );
      }

      // Mirror the dialog's recovery_feedback write so the LLM's
      // pastFeedbackSummary learns from auto-healing decisions too.
      // Look up the DLQ row for the workflowId — needed by the
      // recoveryFeedbackRepo's input shape.
      const dlqRow = await db
        .select({
          runId: deadLetters.runId,
          workflowJson: deadLetters.workflowJson,
          nodeId: deadLetters.nodeId,
        })
        .from(deadLetters)
        .where(and(eq(deadLetters.orgId, auth.orgId), eq(deadLetters.id, row.deadLetterId)))
        .limit(1);

      let patchedWorkflow: Workflow | null = null;
      let failingNode: WorkflowNode | null = null;
      if (accepted) {
        // Preflight the apply inputs BEFORE the CAS decision claim.
        // Otherwise a corrupt stored patch or deleted DLQ row would
        // move the row to `applied` and write `auto_healing.applied`
        // even though production replay never happened.
        const workflowParse = WorkflowSchema.safeParse(row.proposedPatchJson);
        if (!workflowParse.success) {
          return sendError(res, "autoheal_patch_revalidation_failed", "Stored patch failed re-validation", 500);
        }
        patchedWorkflow = workflowParse.data;
        failingNode = (patchedWorkflow.nodes as WorkflowNode[]).find(
          (n) => n.id === dlqRow[0]?.nodeId,
        ) ?? null;
        if (!dlqRow[0] || !failingNode) {
          return sendError(res, "autoheal_dlq_or_node_missing", "DLQ row or failing node missing", 404);
        }
      }

      // CAS-style — second writer (race with the watcher's auto-apply)
      // gets `applied: false` and the route returns 409.
      const decision = await recordDecision(id, {
        actor: auth.userId,
        accepted,
        declineReason: accepted ? undefined : "manual_review",
      });
      if (!decision.applied) {
        return sendError(
          res,
          "autoheal_already_resolved",
          "Auto-healing row was already resolved",
          409,
        );
      }

      const workflowSnapshot = dlqRow[0]?.workflowJson as { id?: string } | undefined;
      const workflowId = typeof workflowSnapshot?.id === "string" ? workflowSnapshot.id : null;
      if (workflowId && row.approachLabel) {
        try {
          await recordRecoveryFeedback({
            orgId: auth.orgId,
            userId: auth.userId,
            deadLetterId: row.deadLetterId,
            workflowId,
            suggestionMode: "ai",
            approachLabel: row.approachLabel as never,
            accepted,
            comment: comment ?? null,
          });
        } catch (err) {
          console.warn("[auto-healing] recovery feedback write failed", { err });
        }
      }

      if (!accepted) {
        await auditAction(auth, "auto_healing.decline.manual", { targetType: "auto_healing_run", targetId: id, metadata: {
          decisionActor: auth.userId,
        } });
        return sendJson(res, { ok: true, accepted: false });
      }

      // Apply path — replay the failing node against the patched
      // workflow snapshot stored on the row.
      try {
        await dlqReplay.replayDeadLetter({
          runId: dlqRow[0]!.runId,
          workflow: patchedWorkflow!,
          node: failingNode!,
          deadLetterId: row.deadLetterId,
          recoveryActorId: auth.userId,
        });
        await markDeadLetterReplayed(auth.orgId, row.deadLetterId);
      } catch (err) {
        console.error("[auto-healing] manual apply replay failed", { id, err });
        return sendError(res, "autoheal_apply_replay_failed", "Apply replay failed", 500);
      }

      // Note: the audit row for `auto_healing.applied` is already
      // written by `recordDecision`. The route doesn't double-audit.
      return sendJson(res, { ok: true, accepted: true });
    },
  },
  {
    method: "POST",
    match: "/auto-healing/scan",
    role: "admin",
    permission: "autohealing.decide",
    handler: async ({ res, auth }) => {
      try {
        await enforceRateLimit(auth.orgId, { name: "ai", windowMs: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_DEFAULTS_PER_MIN.autoHealingDecide });
      } catch (err) {
        return sendError(res, "autoheal_rate_limited", (err as Error).message, 429);
      }
      // Trigger asynchronously so the route returns immediately. The
      // per-org call keeps the on-demand scan scoped to the caller's
      // tenant instead of walking every enabled org.
      void runOrgScan(auth.orgId).catch((err) => {
        console.error("[auto-healing] on-demand scan failed", { orgId: auth.orgId, err });
      });
      await auditAction(auth, "auto_healing.scan.triggered");
      return sendJson(res, { ok: true });
    },
  },
];
