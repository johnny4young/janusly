/**
 * Dead-letter queue + recovery surfaces.
 *
 * Route ordering inside this module matters: cluster rollup
 * (`/dlq/clusters`) and cluster-members listing
 * (`/dlq/cluster-members`) MUST register BEFORE the generic `/dlq`
 * dispatcher because the registry is first-match-wins; otherwise the
 * wildcard handler below would swallow them.
 *
 * Sandbox replay (`/dlq/validate-fix`) emits `runs.replayMode =
 * "validation"` so the engine's HTTP and tool executors gate write-side
 * actions via `NodeContext.dryRun`. Validation runs are excluded from
 * health, cluster, and recovery metric rollups.
 */

import { eq } from "drizzle-orm";

import { collectFailureSamples } from "@janusly/data/src/failureClusterRepo";
import { db, runs, workflowVersions } from "@janusly/db";
import { DLQReplayAdapter } from "@janusly/engine/src/adapters/dlq-replay";
import { clusterFailureSamples } from "@janusly/engine/src/cluster-failures";
import { NodeSchema, WorkflowSchema, type Workflow } from "@janusly/shared";

import { orgLlmRuntime, sanitizeAiWorkflow } from "../ai-runtime";
import { audit } from "../audit";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { CLUSTER_MEMBERS_DEFAULT_LIMIT, CLUSTER_MEMBERS_MAX_LIMIT, findClusterMembers, recheckSignature } from "../cluster-recovery";
import { getDeadLetter, isDeadLetterStatus, listDeadLetters, markDeadLetterReplayed, markDeadLetterResolved } from "../dlq";
import {
  autoResolveRecoveryItemFromReplay,
  createRecoveryItemForDeadLetter,
} from "@janusly/engine/src/recovery/recovery-item-hook";
import { errorEnvelope } from "../error-codes";
import { asRecord, readJson, sendJson } from "../http";
import { enforceRateLimit } from "../rate-limit";
import type { Route } from "../routes";

// Shared DLQ replay adapter used by validate-fix, cluster-apply, and
// the canonical replay route. Module-scoped so the three routes share
// one adapter instance.
const dlqReplay = new DLQReplayAdapter();

export const dlqRoutes: Route[] = [
  // DLQ — cluster rollup must register BEFORE the generic /dlq dispatcher
  // because the registry is first-match-wins; otherwise the wildcard
  // handler below would swallow `/dlq/clusters` requests.
  { method: "GET", match: (url) => url === "/dlq/clusters" || url.startsWith("/dlq/clusters?"), role: "viewer",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const rawWindow = Number.parseInt(url.searchParams.get("windowDays") ?? "", 10);
      const windowDays = Number.isFinite(rawWindow) ? Math.min(90, Math.max(1, rawWindow)) : 30;
      const samples = await collectFailureSamples(auth.orgId, windowDays);
      const clusters = clusterFailureSamples(samples);
      return sendJson(res, { clusters, totalSamples: samples.length, windowDays });
    } },
  // Cluster member listing — feeds the bulk recovery dialog with the
  // bounded list of DLQ ids whose normalized error signature matches a
  // claimed cluster. Registered BEFORE the generic /dlq dispatcher for
  // the same first-match-wins reason as `/dlq/clusters`.
  { method: "GET", match: (url) => url.startsWith("/dlq/cluster-members"), role: "viewer",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const signature = url.searchParams.get("signature");
      if (!signature) return sendJson(res, { error: "signature is required" }, 400);
      const rawWindow = Number.parseInt(url.searchParams.get("windowDays") ?? "", 10);
      const windowDays = Number.isFinite(rawWindow) ? Math.min(90, Math.max(1, rawWindow)) : 30;
      const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit = Number.isFinite(rawLimit) ? rawLimit : CLUSTER_MEMBERS_DEFAULT_LIMIT;
      const result = await findClusterMembers(auth.orgId, signature, windowDays, limit);
      return sendJson(res, { ...result, windowDays });
    } },
  // DLQ — viewer gate is symmetric with `/dlq/clusters` and
  // `/dlq/cluster-members` above; omitting `role:` lets any
  // authenticated caller (e.g. service token without an `org_members`
  // row) reach the handler.
  { method: "GET", match: (url) => url.startsWith("/dlq"), role: "viewer",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const id = url.searchParams.get("id");
      const status = url.searchParams.get("status");
      const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;

      if (id) {
        const item = await getDeadLetter(auth.orgId, id);
        if (!item) return sendJson(res, { error: "Not found" }, 404);
        return sendJson(res, item);
      }
      if (status && !isDeadLetterStatus(status)) {
        return sendJson(res, { error: "Invalid DLQ status" }, 400);
      }

      return sendJson(res, await listDeadLetters(auth.orgId, status, limit));
    } },
  { method: "POST", match: "/dlq/resolve", role: "editor",
    handler: async ({ req, res, auth }) => {
      const { id } = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      if (typeof id !== "string") return sendJson(res, { error: "id is required" }, 400);

      await markDeadLetterResolved(auth.orgId, id);
      await audit(auth.orgId, auth.userId, "dlq.resolved", "dlq", id);

      // Auto-close the recovery_item linked to this DLQ row (no-op when
      // no item exists). Manual DLQ resolve is not a replay, so keep the
      // linked recovery item's resolution reason honest.
      await autoResolveRecoveryItemFromReplay({
        orgId: auth.orgId,
        deadLetterId: id,
        actor: auth.userId,
        resolutionReason: "accepted_loss",
        via: "dlq_resolve",
      });

      return sendJson(res, { ok: true });
    } },
  // Sandbox replay — execute the failing DLQ entry against a proposed
  // workflow patch in a fresh validation run WITHOUT writing a
  // `workflow_versions` row. Recovery dialog calls this between Review
  // and Apply; the production save+replay only fires after the
  // validation run reaches `succeeded`. Validation runs carry
  // `runs.replayMode = "validation"` so they're excluded from health,
  // cluster, and recovery metric rollups, and so the engine's HTTP and
  // tool executors can gate write-side actions via `NodeContext.dryRun`.
  { method: "POST", match: "/dlq/validate-fix", role: "editor",
    handler: async ({ req, res, auth }) => {
      const { orgConfig } = await orgLlmRuntime(auth.orgId);
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: 60_000, max: orgConfig.ai.rateLimitPerMin });
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));

      const deadLetterId = typeof body.deadLetterId === "string" ? body.deadLetterId : null;
      if (!deadLetterId) return sendJson(res, errorEnvelope("dlq_field_required", "deadLetterId is required", { field: "deadLetterId" }), 400);
      const suggestedWorkflow = body.suggestedWorkflow;
      if (!suggestedWorkflow || typeof suggestedWorkflow !== "object") {
        return sendJson(res, { error: "suggestedWorkflow is required" }, 400);
      }

      const item = await getDeadLetter(auth.orgId, deadLetterId);
      if (!item) return sendJson(res, errorEnvelope("dlq_not_found", "DLQ entry not found"), 404);

      // Validate the proposed workflow through the same grammar gate
      // `/ai/patch-workflow` runs on its output: strict schema parse +
      // expression-grammar sanitization. Reject early so the validation
      // run can't be seeded with a malformed DAG.
      const parsed = WorkflowSchema.safeParse(suggestedWorkflow);
      if (!parsed.success) {
        return sendJson(res, {
          error: `suggestedWorkflow failed schema validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
        }, 400);
      }
      let sanitized: Workflow;
      try {
        sanitized = sanitizeAiWorkflow(parsed.data);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return sendJson(res, { error: `suggestedWorkflow sanitize failed: ${reason}` }, 400);
      }

      const failingNode = sanitized.nodes.find((n) => n.id === item.nodeId);
      if (!failingNode) {
        return sendJson(res, {
          error: `suggestedWorkflow does not contain the failing node id "${item.nodeId}"`,
        }, 400);
      }

      const { runId } = await dlqReplay.replayDeadLetterAsValidation({
        orgId: auth.orgId,
        originalRunId: item.runId,
        suggestedWorkflow: sanitized,
        failingNode,
        createdBy: auth.userId,
      });

      await audit(auth.orgId, auth.userId, "recovery.validation_started", "dlq", deadLetterId, {
        validationRunId: runId,
      });

      return sendJson(res, { runId });
    } },
  // Bulk recovery apply — replay up to 100 DLQ entries that share a
  // cluster signature, in series, after the operator has approved the
  // patch and the sandbox gate has passed on the representative entry.
  // Each row is re-validated against the claimed signature server-side
  // so a stale member list (some rows replayed via another path between
  // fetch and apply) doesn't sneak through. Each replayed row gets a
  // `recovery.cluster_apply` audit row tagged with the cluster signature
  // and its sequence index in the batch.
  { method: "POST", match: "/dlq/cluster-apply", role: "editor",
    handler: async ({ req, res, auth }) => {
      const { orgConfig } = await orgLlmRuntime(auth.orgId);
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: 60_000, max: orgConfig.ai.rateLimitPerMin });
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));

      const clusterSignature = typeof body.clusterSignature === "string" ? body.clusterSignature : null;
      if (!clusterSignature) return sendJson(res, { error: "clusterSignature is required" }, 400);
      const idsRaw = body.deadLetterIds;
      if (!Array.isArray(idsRaw) || idsRaw.length === 0) {
        return sendJson(res, { error: "deadLetterIds is required and must be a non-empty array" }, 400);
      }
      if (idsRaw.length > CLUSTER_MEMBERS_MAX_LIMIT) {
        return sendJson(res, {
          error: `deadLetterIds exceeds the per-request cap of ${CLUSTER_MEMBERS_MAX_LIMIT}`,
        }, 400);
      }
      const deadLetterIds: string[] = [];
      for (const candidate of idsRaw) {
        if (typeof candidate !== "string" || candidate.length === 0) {
          return sendJson(res, { error: "deadLetterIds must contain non-empty strings" }, 400);
        }
        deadLetterIds.push(candidate);
      }

      const errors: Array<{ deadLetterId: string; error: string }> = [];
      let replayed = 0;
      const totalInCluster = deadLetterIds.length;

      for (let i = 0; i < deadLetterIds.length; i += 1) {
        const id = deadLetterIds[i]!;
        const item = await getDeadLetter(auth.orgId, id);
        if (!item) {
          errors.push({ deadLetterId: id, error: "DLQ entry not found" });
          continue;
        }
        if (item.status !== "open") {
          errors.push({ deadLetterId: id, error: `DLQ entry already ${item.status}` });
          continue;
        }
        if (!recheckSignature(item, clusterSignature)) {
          errors.push({ deadLetterId: id, error: "DLQ entry signature no longer matches the claimed cluster" });
          continue;
        }

        try {
          const workflow = WorkflowSchema.parse(item.workflowJson);
          await dlqReplay.replayDeadLetter({
            runId: item.runId,
            workflow,
            node: NodeSchema.parse(item.nodeJson),
          });
          await markDeadLetterReplayed(auth.orgId, id);
          // Ensure the recovery_item exists (idempotent) so the cluster
          // accounts for it AND auto-close it because the replay succeeded.
          await createRecoveryItemForDeadLetter({
            orgId: auth.orgId,
            deadLetterId: id,
            createdBy: auth.userId,
            workflowId: workflow.id ?? null,
          });
          await autoResolveRecoveryItemFromReplay({
            orgId: auth.orgId,
            deadLetterId: id,
            actor: auth.userId,
          });
          await audit(auth.orgId, auth.userId, "recovery.cluster_apply", "dlq", id, {
            clusterSignature,
            sequenceIndex: i,
            totalInCluster,
          });
          replayed += 1;
        } catch (err) {
          errors.push({
            deadLetterId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return sendJson(res, { replayed, failed: errors.length, errors });
    } },
  { method: "POST", match: "/dlq/replay", role: "editor", permission: "dlq.replay",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));

      if (typeof body.deadLetterId === "string") {
        const item = await getDeadLetter(auth.orgId, body.deadLetterId);
        if (!item) return sendJson(res, { error: "Not found" }, 404);

        await dlqReplay.replayDeadLetter({
          runId: item.runId,
          workflow: WorkflowSchema.parse(item.workflowJson),
          node: NodeSchema.parse(item.nodeJson),
        });

        await markDeadLetterReplayed(auth.orgId, body.deadLetterId);
        await audit(auth.orgId, auth.userId, "dlq.replayed", "dlq", body.deadLetterId);

        // Auto-close the recovery_item linked to this DLQ row, if any.
        await autoResolveRecoveryItemFromReplay({
          orgId: auth.orgId,
          deadLetterId: body.deadLetterId,
          actor: auth.userId,
        });

        return sendJson(res, { ok: true });
      }

      const { runId, nodeId } = body;
      if (typeof runId !== "string" || typeof nodeId !== "string") return sendJson(res, { error: "runId and nodeId are required" }, 400);

      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendJson(res, { error: "Forbidden" }, 403);

      const version = await db.select().from(workflowVersions).where(eq(workflowVersions.id, run[0].workflowVersionId));
      if (!version[0] || version[0].orgId !== auth.orgId) return sendJson(res, { error: "Workflow version not found" }, 404);

      const workflow = WorkflowSchema.parse(version[0].dagJson);
      const node = workflow.nodes.find(candidate => candidate.id === nodeId);
      if (!node) return sendJson(res, { error: "Node not found in workflow" }, 404);

      await dlqReplay.replayDeadLetter({ runId, workflow, node });
      await audit(auth.orgId, auth.userId, "dlq.replayed", "run", runId, { nodeId });

      return sendJson(res, { ok: true });
    } },
];
