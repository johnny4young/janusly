/** Run comparison and causal replay diagnostics. */

import { and, eq } from "drizzle-orm";

import { getRunComparison } from "@janusly/data";
import { db, runEvents, runs } from "@janusly/db";
import { replayDecision } from "@janusly/domain";

import { decisionCandidatesFromPayload } from "../../ai-runtime";
import { asRecord, sendError, sendJson } from "../../http";
import type { Route } from "../../routes";

export const runDiagnosticRoutes: Route[] = [
  // Run comparison — per-node bundle the Replay Lab's comparison view
  // consumes. Both runs are org-scoped via `getRunComparison`; either
  // run missing or not owned by `auth.orgId` returns the same 404
  // envelope (no enumeration leak).
  { method: "GET", match: (url) => url.startsWith("/runs/compare"), role: "viewer", permission: "runs.read",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const baseRunId = url.searchParams.get("baseRunId");
      const replayRunId = url.searchParams.get("replayRunId");
      if (!baseRunId || !replayRunId) {
        return sendError(res, "runs_base_and_replay_run_id_required", "baseRunId and replayRunId are required", 400);
      }
      const result = await getRunComparison({ orgId: auth.orgId, baseRunId, replayRunId });
      if ("error" in result) {
        const message = result.error === "base_run_not_found"
          ? "Base run not found"
          : "Replay run not found";
        return sendError(res, "runs_compare_run_not_found", message, 404);
      }
      return sendJson(res, result);
    } },

  // Causal replay
  { method: "GET", match: (url) => url === "/causal" || url.startsWith("/causal?"), permission: "runs.read",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const runId = url.searchParams.get("runId");
      const eventId = url.searchParams.get("eventId");
      const nodeId = url.searchParams.get("nodeId");
      if (!runId || !eventId || !nodeId) {
        return sendError(res, "runs_run_id_event_id_and_node_id_required", "runId, eventId, and nodeId are required", 400);
      }

      const run = await db.select().from(runs)
        .where(and(eq(runs.id, runId), eq(runs.orgId, auth.orgId)))
        .limit(1);
      if (!run[0]) return sendError(res, "runs_forbidden", "Forbidden", 403);

      const events = await db.select().from(runEvents)
        .where(and(
          eq(runEvents.id, eventId),
          eq(runEvents.runId, runId),
          eq(runEvents.nodeId, nodeId),
          eq(runEvents.type, "decision.made"),
        ))
        .limit(1);
      const decisionEvent = events[0];
      if (!decisionEvent) return sendError(res, "runs_no_decision_event", "No decision event", 404);

      const payload = asRecord(decisionEvent.payload);
      const result = replayDecision({
        chosenNodeId: typeof payload.chosenNodeId === "string" ? payload.chosenNodeId : undefined,
        candidates: decisionCandidatesFromPayload(payload),
        strategy: "auto",
      });

      return sendJson(res, result);
    } },
];
