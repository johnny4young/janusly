/**
 * Cross-team incident handoff route — `POST /recovery/items/:id/handoff`.
 *
 * Operator-driven dispatch of full incident context (severity, owner,
 * error signature, recent comments, deep link) to one of four
 * destinations: `slack` / `linear` / `github` / `webhook`. The route
 * itself is thin — it validates the body, looks up the recovery item +
 * dead letter row, enforces a cooldown for Slack, calls the
 * per-destination dispatcher, upserts the handoff row, and writes the
 * audit. All third-party calls go through `executeTool` so SSRF /
 * rate-limit / usage events apply.
 *
 * Multi-tenant scope is enforced by the repo (`eq(recoveryItems.orgId,
 * orgId)`). Dry-run / validation runs skip the handoff entirely — a
 * sandbox replay must NOT spam the team's incident channel.
 */

import { and, eq } from "drizzle-orm";
import { db, runs } from "@janusly/db";
import {
  HandoffRequestBodySchema,
  SLACK_HANDOFF_COOLDOWN_SECONDS,
  buildHandoffIdempotencyKey,
  composeHandoffMessage,
  isSlackHandoffCoolingDown,
  type HandoffDispatchResult,
  type RecoveryHandoffDestination,
} from "@janusly/shared";
import { getRecoveryItemById } from "@janusly/data/src/recoveryItemsRepo";
import {
  getHandoffByKey,
  upsertHandoff,
} from "@janusly/data/src/recoveryItemHandoffsRepo";
import { normalizeErrorSignature } from "@janusly/shared/src/error-signature";

import { audit } from "../audit";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { getDeadLetter } from "../dlq";
import { asRecord, readJson, sendJson } from "../http";
import { enforceRateLimit } from "../rate-limit";
import { dispatchHandoff, composeAppendMessage } from "../recovery-handoff-dispatcher";
import type { Route } from "../routes";

const HANDOFF_RATE_LIMIT_BUCKET = "reports.deliver";
const HANDOFF_RATE_LIMIT_WINDOW_MS = 60_000;
const HANDOFF_RATE_LIMIT_MAX = 60;

function idFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const path = url.split("?")[0] ?? "";
  const m = path.match(/^\/recovery\/items\/([^/?]+)\/handoff$/);
  return m ? m[1] : null;
}

/** Resolve recovery-center URL from env so the handoff message carries a deep link. */
function buildRecoveryCenterUrl(): string | null {
  const base = (process.env.JANUSLY_PUBLIC_APP_URL ?? process.env.JANUSLY_WEB_BASE_URL)?.replace(/\/$/, "");
  return base ? `${base}/operations` : null;
}

async function isValidationRun(orgId: string, runId: string | null): Promise<boolean> {
  if (!runId) return false;
  const rows = await db
    .select({ replayMode: runs.replayMode })
    .from(runs)
    .where(and(eq(runs.orgId, orgId), eq(runs.id, runId)))
    .limit(1);
  return rows[0]?.replayMode === "validation";
}

function auditAction(destination: RecoveryHandoffDestination): string {
  return `recovery.handoff.${destination}`;
}

export const recoveryHandoffRoutes: Route[] = [
  {
    method: "POST",
    match: (url) => /^\/recovery\/items\/[^/?]+\/handoff$/.test(url),
    role: "editor",
    permission: "recovery.write",
    handler: async ({ req, res, auth }) => {
      const recoveryItemId = idFromUrl(req.url);
      if (!recoveryItemId) return sendJson(res, { error: "id required" }, 400);

      const parsed = HandoffRequestBodySchema.safeParse(asRecord(await readJson(req, MAX_JSON_BODY_BYTES)));
      if (!parsed.success) {
        return sendJson(
          res,
          {
            error: "invalid handoff body",
            code: "recovery_handoff_invalid",
            issues: parsed.error.issues.map((iss) => ({
              path: iss.path.join("."),
              message: iss.message,
            })),
          },
          422,
        );
      }
      const body = parsed.data;

      // Org-scoped rate limit BEFORE any DB / executeTool spend.
      await enforceRateLimit(auth.orgId, {
        name: HANDOFF_RATE_LIMIT_BUCKET,
        windowMs: HANDOFF_RATE_LIMIT_WINDOW_MS,
        max: HANDOFF_RATE_LIMIT_MAX,
      });

      // Lookup recovery item + dead letter for context enrichment.
      const item = await getRecoveryItemById(auth.orgId, recoveryItemId);
      if (!item) {
        return sendJson(res, { error: "recovery item not found", code: "recovery_item_not_found" }, 404);
      }
      const deadLetter = await getDeadLetter(auth.orgId, item.deadLetterId);
      if (!deadLetter) {
        return sendJson(res, { error: "dead letter not found", code: "recovery_handoff_dl_not_found" }, 404);
      }
      const existing = await getHandoffByKey(auth.orgId, recoveryItemId, body.destination);
      const idempotencyKey = buildHandoffIdempotencyKey(recoveryItemId, body.destination);

      // Dry-run gate: sandbox replays MUST NOT page the team channel.
      if (await isValidationRun(auth.orgId, deadLetter.runId)) {
        await audit(auth.orgId, auth.userId, auditAction(body.destination), "recovery-item", recoveryItemId, {
          recoveryItemId,
          deadLetterId: item.deadLetterId,
          destination: body.destination,
          credentialName: body.credentialName,
          ok: false,
          statusCode: null,
          error: null,
          latencyMs: 0,
          idempotencyKey,
          dispatchCount: existing?.dispatchCount ?? 0,
          externalId: existing?.externalId ?? null,
          externalUrl: existing?.externalUrl ?? null,
          skipped: true,
          reason: "validation_run",
        });
        return sendJson(res, {
          ok: false,
          skipped: true,
          reason: "validation_run",
          message: "handoff skipped for sandbox replay run",
        });
      }

      // Slack cooldown short-circuit. v1 ships post-only on Slack (no
      // thread API on incoming webhooks), so the operator's second click
      // within the cooldown window returns 200 with `alreadyDispatched`
      // metadata instead of re-firing the slack.post tool.
      if (
        body.destination === "slack" &&
        existing &&
        existing.lastOutcome === "delivered" &&
        isSlackHandoffCoolingDown(existing.lastDispatchedAt)
      ) {
        await audit(auth.orgId, auth.userId, auditAction("slack"), "recovery-item", recoveryItemId, {
          recoveryItemId,
          deadLetterId: item.deadLetterId,
          destination: "slack",
          credentialName: body.credentialName,
          ok: true,
          statusCode: null,
          error: null,
          latencyMs: 0,
          idempotencyKey,
          alreadyDispatched: true,
          dispatchCount: existing.dispatchCount,
          externalId: existing.externalId,
          externalUrl: existing.externalUrl,
          cooldownSeconds: SLACK_HANDOFF_COOLDOWN_SECONDS,
          lastDispatchedAtIso: existing.lastDispatchedAt.toISOString(),
        });
        return sendJson(res, {
          ok: true,
          alreadyDispatched: true,
          handoff: {
            id: existing.id,
            destination: existing.destination,
            dispatchCount: existing.dispatchCount,
            externalUrl: existing.externalUrl,
            firstDispatchedAt: existing.firstDispatchedAt.toISOString(),
            lastDispatchedAt: existing.lastDispatchedAt.toISOString(),
          },
        });
      }

      // Build the composed message. When `existing` is present and the
      // destination supports append (currently github only), the
      // dispatcher will re-compose with `appendMode: true` so the
      // message reads "Recovery item update".
      const errorSignature = normalizeErrorSignature(deadLetter.errorJson, {}).signature;
      const recentComments = item.comments.slice(-3).map((c) => ({
        authorUserId: c.authorUserId,
        body: c.body,
        createdAt: c.createdAt,
      }));
      const baseMessage = {
        recoveryItemId: item.id,
        deadLetterId: item.deadLetterId,
        workflowId: item.workflowId,
        runId: deadLetter.runId,
        nodeId: deadLetter.nodeId,
        errorSignature,
        severity: item.severity,
        status: item.status,
        owner: item.owner,
        slaTargetAtIso: item.slaTargetAt.toISOString(),
        recentComments,
        recoveryCenterUrl: buildRecoveryCenterUrl(),
      };
      const existingIssueNumber = existing?.externalId ?? "";
      const shouldAppendToGithub = body.destination === "github" && /^\d+$/.test(existingIssueNumber);
      const message =
        shouldAppendToGithub && existing
          ? composeAppendMessage(baseMessage, existing)
          : composeHandoffMessage(baseMessage);

      const result: HandoffDispatchResult = await dispatchHandoff({
        orgId: auth.orgId,
        recoveryItemId,
        destination: body.destination,
        credentialName: body.credentialName,
        message,
        existing,
        request: {
          owner: body.owner,
          repo: body.repo,
          labels: body.labels,
          assignees: body.assignees,
          url: body.url,
          channel: body.channel,
        },
      });

      const handoff = await upsertHandoff({
        orgId: auth.orgId,
        recoveryItemId,
        destination: body.destination,
        credentialName: body.credentialName,
        idempotencyKey,
        outcome: result.ok ? "delivered" : "delivery_failed",
        statusCode: result.statusCode ?? null,
        error: result.error ?? null,
        latencyMs: result.latencyMs,
        externalId: result.externalId ?? null,
        externalUrl: result.externalUrl ?? null,
        createdBy: auth.userId,
      });

      await audit(auth.orgId, auth.userId, auditAction(body.destination), "recovery-item", recoveryItemId, {
        recoveryItemId,
        deadLetterId: item.deadLetterId,
        destination: body.destination,
        credentialName: body.credentialName,
        ok: result.ok,
        statusCode: result.statusCode ?? null,
        error: result.error ?? null,
        latencyMs: result.latencyMs,
        idempotencyKey,
        dispatchCount: handoff.dispatchCount,
        externalId: handoff.externalId,
        externalUrl: handoff.externalUrl,
        commentId: result.commentId ?? null,
      });

      return sendJson(res, {
        ok: result.ok,
        handoff: {
          id: handoff.id,
          destination: handoff.destination,
          dispatchCount: handoff.dispatchCount,
          externalId: handoff.externalId,
          externalUrl: handoff.externalUrl,
          firstDispatchedAt: handoff.firstDispatchedAt.toISOString(),
          lastDispatchedAt: handoff.lastDispatchedAt.toISOString(),
          lastOutcome: handoff.lastOutcome,
          lastStatusCode: handoff.lastStatusCode,
          lastError: handoff.lastError,
        },
      });
    },
  },
];
