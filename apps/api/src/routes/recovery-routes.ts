/**
 * Org-level recovery surfaces — composed metrics rollup for the
 * Operations dashboard, plus the operator → system feedback channel
 * the RecoveryDialog calls on Apply / Cancel / Iterate.
 *
 * Audited as `recovery.feedback` per the AGENTS.md AI-mutation
 * contract; the LLM reads recent rows on subsequent recoveries to
 * deprioritize approaches the operator has already rejected.
 */

import {
  commitMemory,
  DEFAULT_CALIBRATION_WINDOW_DAYS,
  isMemoryAllowed,
  getOrgConfigSnapshot,
  listCalibrations,
  queryOperatorRecoveryCount,
  queryRecoveryFeedbackHealth,
  queryRecoveryLedger,
  queryRecoveryValidation,
  recordRecoveryFeedback,
  queryRecoveryHeatmap,
  getRecoveryCase,
  listRecoveryCases,
  listRecoveryCaseTransitions,
  resolveRecoveryCaseAutonomyProfile,
} from "@janusly/data";
import { MIN_CALIBRATION_SAMPLES } from "@janusly/engine/src/confidence-calibration";
import { recoverSemanticOutcome } from "@janusly/engine/src/semantic-recovery";
import { normalizeErrorSignature } from "@janusly/shared/src/error-signature";

import {
  composePatchRationaleContent,
  composeRecoveryRationaleContent,
  RecoveryFeedbackBodySchema,
} from "../ai-patch-feedback";
import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { RATE_LIMIT_DEFAULTS_PER_MIN, RATE_LIMIT_WINDOW_MS } from "../constants";
import { getDeadLetter } from "../dlq";
import { asRecord, readJson, sendError, sendJson } from "../http";
import { guardMcpWrite } from "../mcp-consent";
import { enforceRateLimit } from "../rate-limit";
import { queryRecoveryMetricsReadModel } from "../recovery-read-models";
import type { Route } from "../routes";
import {
  recoveryLedgerContract,
  getRecoveryCaseContract,
  listRecoveryCasesContract,
  recoveryMetricsContract,
  recoveryMyWinsContract,
  recoverSemanticCaseContract,
} from "../api-contracts";

/** Extract the saved workflow identifier from a DLQ snapshot without trusting client input. */
function workflowIdFromSnapshot(workflowJson: unknown): string | null {
  const id = (workflowJson as { id?: unknown } | null)?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

type ParsedRecoveryCaseId =
  | { ok: true; caseId: string }
  | { ok: false; code: "not_found" | "invalid" };

function parseRecoveryCaseId(
  rawUrl: string | undefined,
  pattern: RegExp,
): ParsedRecoveryCaseId {
  const pathname = new URL(rawUrl ?? "", "http://localhost").pathname;
  const match = pathname.match(pattern);
  if (!match?.[1]) return { ok: false, code: "not_found" };
  try {
    const caseId = decodeURIComponent(match[1]);
    return caseId.length > 0
      ? { ok: true, caseId }
      : { ok: false, code: "not_found" };
  } catch {
    return { ok: false, code: "invalid" };
  }
}

export const recoveryRoutes: Route[] = [
  {
    method: "GET",
    match: (url) =>
      url === "/recovery/cases" ||
      url.startsWith("/recovery/cases?"),
    role: "viewer",
    permission: "recovery.read",
    contract: listRecoveryCasesContract,
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const rawLimit = Number(url.searchParams.get("limit"));
      const limit = Number.isInteger(rawLimit)
        ? Math.min(Math.max(rawLimit, 1), 200)
        : 100;
      return sendJson(res, {
        cases: await listRecoveryCases(auth.orgId, {
          openOnly:
            url.searchParams.get("openOnly") !== "false",
          runId: url.searchParams.get("runId") ?? undefined,
          limit,
        }),
      });
    },
  },

  {
    method: "GET",
    match: (url) =>
      /^\/recovery\/cases\/[^/?]+(\?|$)/.test(url) &&
      !/^\/recovery\/cases\/[^/?]+\/resolve(\?|$)/.test(url),
    role: "viewer",
    permission: "recovery.read",
    contract: getRecoveryCaseContract,
    handler: async ({ req, res, auth }) => {
      const parsedCaseId = parseRecoveryCaseId(
        req.url,
        /^\/recovery\/cases\/([^/]+)$/,
      );
      if (!parsedCaseId.ok) {
        return sendError(
          res,
          parsedCaseId.code === "invalid"
            ? "invalid_input"
            : "recovery_case_not_found",
          parsedCaseId.code === "invalid"
            ? "Invalid recovery case id"
            : "Recovery case not found",
          parsedCaseId.code === "invalid" ? 400 : 404,
        );
      }
      const recoveryCase = await getRecoveryCase(
        auth.orgId,
        parsedCaseId.caseId,
      );
      if (!recoveryCase) {
        return sendError(
          res,
          "recovery_case_not_found",
          "Recovery case not found",
          404,
        );
      }
      const [transitions, autonomy] = await Promise.all([
        listRecoveryCaseTransitions(
          auth.orgId,
          parsedCaseId.caseId,
        ),
        resolveRecoveryCaseAutonomyProfile(
          auth.orgId,
          recoveryCase,
        ),
      ]);
      return sendJson(res, {
        case: recoveryCase,
        transitions,
        autonomy,
      });
    },
  },

  {
    method: "POST",
    match: (url) =>
      /^\/recovery\/cases\/[^/?]+\/resolve(\?|$)/.test(url),
    role: "editor",
    permission: "recovery.write",
    contract: recoverSemanticCaseContract,
    handler: async ({ req, res, auth }) => {
      const mcpGate = await guardMcpWrite(
        auth,
        "recovery.cases.resolve",
      );
      if (!mcpGate.ok) {
        return sendJson(res, mcpGate.body, mcpGate.status);
      }
      const parsedCaseId = parseRecoveryCaseId(
        req.url,
        /^\/recovery\/cases\/([^/]+)\/resolve$/,
      );
      if (!parsedCaseId.ok) {
        return sendError(
          res,
          parsedCaseId.code === "invalid"
            ? "invalid_input"
            : "recovery_case_not_found",
          parsedCaseId.code === "invalid"
            ? "Invalid recovery case id"
            : "Recovery case not found",
          parsedCaseId.code === "invalid" ? 400 : 404,
        );
      }
      const parsed =
        recoverSemanticCaseContract.request.body.safeParse(
          await readJson(req, MAX_JSON_BODY_BYTES),
        );
      if (!parsed.success) {
        return sendError(
          res,
          "invalid_input",
          "Invalid semantic recovery decision",
          400,
          {
            issueCount: parsed.error.issues.length,
            firstIssue:
              parsed.error.issues[0]?.message ?? "Invalid input",
          },
        );
      }
      const result = await recoverSemanticOutcome({
        orgId: auth.orgId,
        caseId: parsedCaseId.caseId,
        actorId: auth.userId,
        ...parsed.data,
      });
      if (result.status === "not_found") {
        return sendError(
          res,
          "recovery_case_not_found",
          "Recovery case not found",
          404,
        );
      }
      if (result.status === "conflict") {
        return sendError(
          res,
          "recovery_case_conflict",
          result.reason,
          409,
        );
      }
      if (result.status === "invalid_output") {
        return sendError(
          res,
          "recovery_semantic_output_invalid",
          "Replacement output does not satisfy the recovery contract",
          422,
          {
            violationCount: result.violations.length,
            firstViolation:
              result.violations[0]?.message ??
              "Semantic detector failed",
          },
        );
      }
      if (result.status === "policy_blocked") {
        return sendError(
          res,
          "recovery_autonomy_policy_blocked",
          "The effective recovery autonomy policy does not permit applying a replacement",
          409,
          {
            level: result.profile.level ?? "unavailable",
            detectorCount: result.profile.detectorIds.length,
          },
        );
      }

      await auditAction(auth, "recovery.semantic_resolved", {
        targetType: "recovery_case",
        targetId: parsedCaseId.caseId,
        metadata: {
          runId: result.runId,
          sourceNodeId: result.sourceNodeId,
          decision: result.decision,
          resumed: result.resumed,
          resolvedCaseIds: result.resolvedCaseIds,
        },
      });
      return sendJson(res, {
        ok: true,
        runId: result.runId,
        sourceNodeId: result.sourceNodeId,
        decision: result.decision,
        resumed: result.resumed,
        resolvedCaseIds: result.resolvedCaseIds,
      });
    },
  },

  // Org-level recovery metrics — composes run status counts, MTTR, p95
  // latency, approvals pending, replay rate, and cost-by-provider into
  // a single rollup the Operations dashboard renders.
  { method: "GET", match: (url) => url === "/recovery/metrics" || url.startsWith("/recovery/metrics?"),
    role: "viewer",
    permission: "recovery.read",
    contract: recoveryMetricsContract,
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const rawWindow = Number.parseInt(url.searchParams.get("windowDays") ?? "", 10);
      const windowDays = Number.isFinite(rawWindow) ? Math.min(90, Math.max(1, rawWindow)) : 30;
      return sendJson(
        res,
        await queryRecoveryMetricsReadModel(
          auth.orgId,
          windowDays,
        ),
      );
    } },

  // Lifetime measured recovery value. This remains separate from the rolling
  // metrics cache because it is a constant-time durable projection and has no
  // window-dependent assumptions.
  { method: "GET", match: "/recovery/ledger",
    role: "viewer",
    permission: "recovery.read",
    contract: recoveryLedgerContract,
    handler: async ({ res, auth }) => sendJson(res, await queryRecoveryLedger(auth.orgId)) },

  // Controlled-drill evidence is separate from aggregate production metrics.
  // It stays bounded to the newest 100 drills and exposes no actor identifiers.
  { method: "GET", match: (url) => url === "/recovery/validation" || url.startsWith("/recovery/validation?"),
    role: "viewer",
    permission: "reports.read",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const rawWindow = Number.parseInt(url.searchParams.get("windowDays") ?? "", 10);
      const windowDays = Number.isFinite(rawWindow) ? Math.min(90, Math.max(1, rawWindow)) : 30;
      return sendJson(res, await queryRecoveryValidation(auth.orgId, windowDays));
    } },

  // Personal momentum for the authenticated operator. The route accepts no
  // user id from the caller; identity comes exclusively from AuthContext.
  { method: "GET", match: (url) => url === "/recovery/my-wins" || url.startsWith("/recovery/my-wins?"),
    role: "viewer",
    permission: "recovery.read",
    contract: recoveryMyWinsContract,
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const rawDays = Number(url.searchParams.get("days") ?? Number.NaN);
      const windowDays = Number.isInteger(rawDays) ? Math.min(90, Math.max(1, rawDays)) : 30;
      const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
      const recovered = await queryOperatorRecoveryCount(auth.orgId, auth.userId, since);
      return sendJson(res, { recovered, windowDays });
    } },

  // Read-only view of the curves that already calibrate patch suggestions.
  // Keep the server locale-neutral: the web owns labels, percentages, and
  // timestamp formatting. No feedback comments or source rows leave here.
  { method: "GET", match: (url) => url === "/recovery/calibration-status" || url.startsWith("/recovery/calibration-status?"),
    role: "viewer",
    permission: "recovery.read",
    handler: async ({ res, auth }) => {
      const [orgConfig, calibrations] = await Promise.all([
        getOrgConfigSnapshot(auth.orgId),
        listCalibrations(auth.orgId),
      ]);
      return sendJson(res, {
        enabled: orgConfig.ai.confidenceCalibrationEnabled,
        windowDays: DEFAULT_CALIBRATION_WINDOW_DAYS,
        minimumSampleSize: MIN_CALIBRATION_SAMPLES,
        calibrations,
      });
    } },

  // Per-day failure/recovery heatmap for the Recovery Center calendar. Pure
  // aggregation (one GROUP BY over dead_letters); no cache needed — it's read
  // less often than the metric strip and the grid tolerates one-tick staleness.
  { method: "GET", match: (url) => url === "/recovery/heatmap" || url.startsWith("/recovery/heatmap?"),
    role: "viewer",
    permission: "recovery.read",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const rawDays = Number.parseInt(url.searchParams.get("days") ?? "", 10);
      const days = Number.isFinite(rawDays) ? Math.min(90, Math.max(1, rawDays)) : 90;
      const heatmap = await queryRecoveryHeatmap(auth.orgId, days);
      return sendJson(res, { days: heatmap, windowDays: days });
    } },

  // Report whether the per-workflow feedback loop still has a fresh accepted
  // fix. Resolve the workflow from an org-scoped DLQ row instead of accepting
  // a caller-supplied workflow id, so this read cannot cross tenant bounds.
  { method: "GET", match: (url) => url === "/recovery/feedback-health" || url.startsWith("/recovery/feedback-health?"),
    role: "viewer",
    permission: "recovery.read",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const deadLetterId = url.searchParams.get("deadLetterId");
      if (!deadLetterId) {
        return sendError(res, "dlq_field_required", "deadLetterId is required", 400, { field: "deadLetterId" });
      }
      const dlq = await getDeadLetter(auth.orgId, deadLetterId);
      if (!dlq) return sendError(res, "dlq_not_found", "DLQ entry not found", 404);
      const workflowId = workflowIdFromSnapshot(dlq.workflowJson);
      if (!workflowId) {
        return sendError(res, "recovery_feedback_saved_only", "Feedback is only recorded for saved workflows", 422);
      }
      return sendJson(res, await queryRecoveryFeedbackHealth(auth.orgId, workflowId));
    } },

  // Operator → system feedback channel for the recovery loop. The
  // RecoveryDialog calls this on every decision (Apply / Cancel /
  // Iterate). The row gets read back by `/ai/patch-workflow` on
  // subsequent recoveries for the same workflow (via
  // `summarizePastFeedback` + `composeFeedbackHint`) so the LLM can
  // deprioritize approaches the operator has already rejected.
  // Audited as `recovery.feedback`. Editor role — viewers can't
  // capture their own decisions.
  { method: "POST", match: "/recovery/feedback", role: "editor", permission: "recovery.write",
    handler: async ({ req, res, auth }) => {
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_DEFAULTS_PER_MIN.recovery });
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const parsed = RecoveryFeedbackBodySchema.safeParse(body);
      if (!parsed.success) {
        return sendError(res, "recovery_invalid_feedback_body", "Invalid feedback body", 400);
      }
      const dlq = await getDeadLetter(auth.orgId, parsed.data.deadLetterId);
      if (!dlq) return sendError(res, "dlq_not_found", "DLQ entry not found", 404);

      const workflowId = workflowIdFromSnapshot(dlq.workflowJson);
      if (!workflowId) {
        // Anonymous (ad-hoc) workflows have no aggregation key — the
        // dialog only opens on saved workflows in practice, so this is
        // defensive.
        return sendError(res, "recovery_feedback_saved_only", "Feedback is only recorded for saved workflows", 422);
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
        evalConsent: parsed.data.evalConsent ?? false,
        rawConfidence: parsed.data.rawConfidence ?? null,
      });

      await auditAction(auth, "recovery.feedback", { targetType: "dead_letter", targetId: parsed.data.deadLetterId, metadata: {
        approachLabel: parsed.data.approachLabel,
        suggestionMode: parsed.data.suggestionMode,
        accepted: parsed.data.accepted,
        evalConsent: parsed.data.evalConsent ?? false,
      } });

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
