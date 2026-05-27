/**
 * Org-level recovery surfaces — composed metrics rollup for the
 * Operations dashboard, plus the operator → system feedback channel
 * the RecoveryDialog calls on Apply / Cancel / Iterate.
 *
 * Audited as `recovery.feedback` per the AGENTS.md AI-mutation
 * contract; the LLM reads recent rows on subsequent recoveries to
 * deprioritize approaches the operator has already rejected.
 */

import { commitMemory } from "@janusly/data/src/memoryEntriesRepo";
import { isMemoryAllowed } from "@janusly/data/src/memoryConsent";
import { getOrgConfigSnapshot } from "@janusly/data/src/orgConfigRepo";
import { recordRecoveryFeedback } from "@janusly/data/src/recoveryFeedbackRepo";
import { collectRecoveryMetricsSignals } from "@janusly/data/src/recoveryMetricsRepo";
import { composeRecoveryMetrics } from "@janusly/engine/src/recovery-metrics";
import { normalizeErrorSignature } from "@janusly/shared/src/error-signature";

import {
  composePatchRationaleContent,
  composeRecoveryRationaleContent,
  RecoveryFeedbackBodySchema,
} from "../ai-patch-feedback";
import { audit } from "../audit";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { RATE_LIMIT_DEFAULTS_PER_MIN, RATE_LIMIT_WINDOW_MS } from "../constants";
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
      // Read the value-dashboard assumptions in parallel with the
      // metrics signals. The rollup is fully additive — clients that
      // don't read `valueEstimate` / `clustersResolved` get the same
      // shape as before plus the new fields, byte-for-byte back-compat.
      const [signals, snapshot] = await Promise.all([
        collectRecoveryMetricsSignals(auth.orgId, windowDays),
        getOrgConfigSnapshot(auth.orgId),
      ]);
      const metrics = composeRecoveryMetrics(signals, windowDays, snapshot.value);
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
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_DEFAULTS_PER_MIN.recovery });
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

      // Memory-write side of the recovery loop. Fires ONLY when the
      // operator accepts a suggestion AND the org has memory enabled.
      // Two consent gates: (a) `isMemoryAllowed` short-circuit FIRST so
      // memory-disabled orgs see byte-for-byte zero behavior change (no
      // `commitMemory` call, no `usage_events` row, no `memory.*` audit
      // pollution); (b) accept-only gate — rejections still land in
      // `recovery_feedback` for the workflow-scoped `pastFeedbackSummary`
      // path, but do not seed the substrate. A future product decision
      // to also capture rejections is a one-line change (the catalog's
      // `memory.allowedKinds` already supports per-kind opt-in).
      //
      // Memory writes are fire-and-forget via `Promise.allSettled` so a
      // commitMemory failure NEVER breaks the feedback `{ ok: true }`
      // response. The repo writes its own `memory.entry.failed` audit
      // on failure paths; the route's `console.warn` provides the
      // operator-traceable signal in the warn log.
      if (parsed.data.accepted) {
        const consent = await isMemoryAllowed(auth.orgId);
        if (consent.allowed) {
          const signature = (() => {
            try {
              const node = dlq.nodeJson as { type?: unknown; config?: { tool?: unknown } } | null;
              const nodeType = typeof node?.type === "string" ? node.type : undefined;
              const toolName = typeof node?.config?.tool === "string" ? node.config.tool : undefined;
              return normalizeErrorSignature(dlq.errorJson, { nodeType, toolName }).signature;
            } catch {
              return "unknown";
            }
          })();
          const recoveryContent = composeRecoveryRationaleContent({
            approachLabel: parsed.data.approachLabel,
            accepted: parsed.data.accepted,
            comment: parsed.data.comment ?? null,
            signature,
          });
          const patchContent = parsed.data.rationale
            ? composePatchRationaleContent({
                approachLabel: parsed.data.approachLabel,
                rationale: parsed.data.rationale,
              })
            : null;
          const commits: Promise<unknown>[] = [
            commitMemory({
              orgId: auth.orgId,
              workflowId,
              runId: dlq.runId ?? undefined,
              kind: "recovery_rationale",
              content: recoveryContent,
              metadata: {
                approachLabel: parsed.data.approachLabel,
                accepted: parsed.data.accepted,
                suggestionMode: parsed.data.suggestionMode,
                deadLetterId: parsed.data.deadLetterId,
              },
            }),
          ];
          if (patchContent) {
            commits.push(
              commitMemory({
                orgId: auth.orgId,
                workflowId,
                runId: dlq.runId ?? undefined,
                kind: "patch_rationale",
                content: patchContent,
                metadata: {
                  approachLabel: parsed.data.approachLabel,
                  suggestionMode: parsed.data.suggestionMode,
                  deadLetterId: parsed.data.deadLetterId,
                },
              }),
            );
          }
          // `Promise.allSettled` never rejects by spec — a `.catch` here
          // would be dead code. Inspect the per-commit results so an
          // unexpected throw inside `commitMemory` (which would normally
          // resolve to `{ ok: false, error }`) still surfaces in the warn
          // log alongside the repo's own `memory.entry.failed` audit row.
          void Promise.allSettled(commits).then((results) => {
            for (const result of results) {
              if (result.status === "rejected") {
                console.warn("[recovery-feedback] memory commit threw", {
                  deadLetterId: parsed.data.deadLetterId,
                  reason: result.reason,
                });
              }
            }
          });
        }
      }

      return sendJson(res, { ok: true });
    } },
];
