/**
 * Org-level recovery surfaces — composed metrics rollup for the
 * Operations dashboard, plus the operator → system feedback channel
 * the RecoveryDialog calls on Apply / Cancel / Iterate.
 *
 * Audited as `recovery.feedback` per the AGENTS.md AI-mutation
 * contract; the LLM reads recent rows on subsequent recoveries to
 * deprioritize approaches the operator has already rejected.
 */

import { recordRecoveryFeedback } from "@janusly/data/src/recoveryFeedbackRepo";
import { collectRecoveryMetricsSignals } from "@janusly/data/src/recoveryMetricsRepo";
import { composeRecoveryMetrics } from "@janusly/engine/src/recovery-metrics";

import { RecoveryFeedbackBodySchema } from "../ai-patch-feedback";
import { audit } from "../audit";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { getDeadLetter } from "../dlq";
import { asRecord, readJson, sendJson } from "../http";
import { enforceRateLimit } from "../rate-limit";
import type { Route } from "../routes";

export const recoveryRoutes: Route[] = [
  // Org-level recovery metrics — composes run status counts, MTTR, p95
  // latency, approvals pending, replay rate, and cost-by-provider into
  // a single rollup the Operations dashboard renders.
  { method: "GET", match: (url) => url === "/recovery/metrics" || url.startsWith("/recovery/metrics?"),
    role: "viewer",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const rawWindow = Number.parseInt(url.searchParams.get("windowDays") ?? "", 10);
      const windowDays = Number.isFinite(rawWindow) ? Math.min(90, Math.max(1, rawWindow)) : 30;
      const signals = await collectRecoveryMetricsSignals(auth.orgId, windowDays);
      const metrics = composeRecoveryMetrics(signals, windowDays);
      return sendJson(res, metrics);
    } },

  // Operator → system feedback channel for the recovery loop. The
  // RecoveryDialog calls this on every decision (Apply / Cancel /
  // Iterate). The row gets read back by `/ai/patch-workflow` on
  // subsequent recoveries for the same workflow (via
  // `summarizePastFeedback` + `composeFeedbackHint`) so the LLM can
  // deprioritize approaches the operator has already rejected.
  // Audited as `recovery.feedback`. Editor role — viewers can't
  // capture their own decisions.
  { method: "POST", match: "/recovery/feedback", role: "editor",
    handler: async ({ req, res, auth }) => {
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: 60_000, max: 120 });
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const parsed = RecoveryFeedbackBodySchema.safeParse(body);
      if (!parsed.success) {
        return sendJson(res, { error: "Invalid feedback body", issues: parsed.error.issues }, 400);
      }
      const dlq = await getDeadLetter(auth.orgId, parsed.data.deadLetterId);
      if (!dlq) return sendJson(res, { error: "DLQ entry not found" }, 404);

      const failingWorkflowJson = dlq.workflowJson as { id?: unknown } | null;
      const workflowId = typeof failingWorkflowJson?.id === "string" ? failingWorkflowJson.id : null;
      if (!workflowId) {
        // Anonymous (ad-hoc) workflows have no aggregation key — the
        // dialog only opens on saved workflows in practice, so this is
        // defensive.
        return sendJson(res, { error: "Feedback is only recorded for saved workflows" }, 422);
      }

      await recordRecoveryFeedback({
        orgId: auth.orgId,
        userId: auth.userId,
        deadLetterId: parsed.data.deadLetterId,
        workflowId,
        suggestionMode: parsed.data.suggestionMode,
        approachLabel: parsed.data.approachLabel,
        accepted: parsed.data.accepted,
        comment: parsed.data.comment ?? null,
      });

      await audit(auth.orgId, auth.userId, "recovery.feedback", "dead_letter", parsed.data.deadLetterId, {
        approachLabel: parsed.data.approachLabel,
        suggestionMode: parsed.data.suggestionMode,
        accepted: parsed.data.accepted,
      });

      return sendJson(res, { ok: true });
    } },
];
