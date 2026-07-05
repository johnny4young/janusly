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

import {
  queryFailureSamples,
} from "@janusly/data";
import { db, runs, workflowVersions } from "@janusly/db";
import { DLQReplayAdapter } from "@janusly/engine/src/adapters/dlq-replay";
import { clusterFailureSamples } from "@janusly/engine/src/cluster-failures";
import { NodeSchema, WorkflowSchema, type Workflow } from "@janusly/shared";

import { orgLlmRuntime, sanitizeAiWorkflow } from "../ai-runtime";
import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { RATE_LIMIT_WINDOW_MS } from "../constants";
import { CLUSTER_MEMBERS_DEFAULT_LIMIT, CLUSTER_MEMBERS_MAX_LIMIT, findClusterMembers, recheckSignature } from "../cluster-recovery";
import { countDeadLettersByStatus, decodeRecoveryQueueCursor, getDeadLetter, isDeadLetterStatus, isRecoveryQueueSort, listRecoveryQueue, markDeadLetterReplayed, markDeadLetterResolved, queryRecoveryQueuePage } from "../dlq";
import { RECOVERY_ITEM_SEVERITIES, type RecoveryItemSeverity } from "@janusly/shared";
import {
  autoResolveRecoveryItemFromReplay,
  createRecoveryItemForDeadLetter,
} from "@janusly/engine/src/recovery/recovery-item-hook";
import { asRecord, readJson, sendError, sendJson } from "../http";
import { guardMcpWrite } from "../mcp-consent";
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
      const samples = await queryFailureSamples(auth.orgId, windowDays);
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
      if (!signature) return sendError(res, "dlq_field_required", "signature is required", 400, { field: "signature" });
      const rawWindow = Number.parseInt(url.searchParams.get("windowDays") ?? "", 10);
      const windowDays = Number.isFinite(rawWindow) ? Math.min(90, Math.max(1, rawWindow)) : 30;
      const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit = Number.isFinite(rawLimit) ? rawLimit : CLUSTER_MEMBERS_DEFAULT_LIMIT;
      const result = await findClusterMembers(auth.orgId, signature, windowDays, limit);
      return sendJson(res, { ...result, windowDays });
    } },
  // Recovery queue — keyset ("load more") pagination over the SAME cap-correct
  // join as the bare `/dlq` array, returning a { items, nextCursor, hasMore }
  // envelope. Registered BEFORE the generic /dlq dispatcher for the same
  // first-match-wins reason as `/dlq/clusters`, and kept a SEPARATE route so
  // bare `/dlq` stays an array for the home-preview + MCP `dlq.list` consumers.
  { method: "GET", match: (url) => url === "/dlq/queue" || url.startsWith("/dlq/queue?"), role: "viewer",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const status = url.searchParams.get("status");
      const severity = url.searchParams.get("severity");
      const sortParam = url.searchParams.get("sort");
      const ownerParam = url.searchParams.get("owner");
      const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const pageSize = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
      // Optional `?search=` substring over node id / run id / error message
      // (case-insensitive, applied server-side before the page cap). Length-
      // guarded (≤100) to bound the ILIKE pattern, mirroring the Flows `?q=`.
      const searchParam = url.searchParams.get("search")?.trim();
      const search = searchParam && searchParam.length > 0 && searchParam.length <= 100 ? searchParam : undefined;

      if (status && !isDeadLetterStatus(status)) {
        return sendError(res, "dlq_invalid_status", "Invalid DLQ status", 400);
      }
      if (severity && !(RECOVERY_ITEM_SEVERITIES as readonly string[]).includes(severity)) {
        return sendError(res, "dlq_invalid_severity", "Invalid severity", 400);
      }
      if (sortParam && !isRecoveryQueueSort(sortParam)) {
        return sendError(res, "dlq_invalid_sort", "Invalid sort", 400);
      }
      const sort = sortParam && isRecoveryQueueSort(sortParam) ? sortParam : undefined;
      // `owner=me` resolves to the caller's stable user id (mirrors `/dlq`).
      const owner = ownerParam === "me" ? auth.userId : ownerParam;
      // Decode the cursor against the EFFECTIVE sort so a cursor minted under a
      // different sort is ignored (→ page 1) rather than mis-ordering the page.
      const cursor = decodeRecoveryQueueCursor(url.searchParams.get("cursor"), sort ?? "newest");

      return sendJson(
        res,
        await queryRecoveryQueuePage(
          auth.orgId,
          {
            status,
            owner,
            severity: severity ? (severity as RecoveryItemSeverity) : undefined,
            search,
            sort,
            cursor,
          },
          pageSize,
        ),
      );
    } },
  // Recovery-queue mini-grid counts — the ORG-WIDE status breakdown
  // (Total / Open / Retried / Resolved), unscoped by the operator's
  // filter/sort/page. Registered BEFORE the generic /dlq dispatcher for the
  // same first-match-wins reason as `/dlq/queue`. Separate from the filtered
  // `/dlq/queue` page so the summary stays the whole-queue health snapshot.
  { method: "GET", match: (url) => url === "/dlq/counts" || url.startsWith("/dlq/counts?"), role: "viewer",
    handler: async ({ res, auth }) => {
      return sendJson(res, await countDeadLettersByStatus(auth.orgId));
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
      const severity = url.searchParams.get("severity");
      const sort = url.searchParams.get("sort");
      const ownerParam = url.searchParams.get("owner");
      const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
      // Optional `?search=` substring over node id / run id / error message,
      // symmetric with `/dlq/queue` (and available to the MCP `dlq.list`
      // consumer). Length-guarded (≤100) to bound the ILIKE pattern.
      const searchParam = url.searchParams.get("search")?.trim();
      const search = searchParam && searchParam.length > 0 && searchParam.length <= 100 ? searchParam : undefined;

      if (id) {
        const item = await getDeadLetter(auth.orgId, id);
        if (!item) return sendError(res, "dlq_not_found", "Not found", 404);
        return sendJson(res, item);
      }
      if (status && !isDeadLetterStatus(status)) {
        return sendError(res, "dlq_invalid_status", "Invalid DLQ status", 400);
      }
      if (severity && !(RECOVERY_ITEM_SEVERITIES as readonly string[]).includes(severity)) {
        return sendError(res, "dlq_invalid_severity", "Invalid severity", 400);
      }
      if (sort && !isRecoveryQueueSort(sort)) {
        return sendError(res, "dlq_invalid_sort", "Invalid sort", 400);
      }
      // `owner=me` resolves to the caller's stable user id (mirrors
      // `/recovery/items`); any other value is treated as a literal owner id.
      const owner = ownerParam === "me" ? auth.userId : ownerParam;

      return sendJson(
        res,
        await listRecoveryQueue(auth.orgId, {
          status,
          owner,
          severity: severity ? (severity as RecoveryItemSeverity) : undefined,
          search,
          sort: sort && isRecoveryQueueSort(sort) ? sort : undefined,
          limit,
        }),
      );
    } },
  { method: "POST", match: "/dlq/resolve", role: "editor",
    handler: async ({ req, res, auth }) => {
      const { id } = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      if (typeof id !== "string") return sendError(res, "dlq_field_required", "id is required", 400, { field: "id" });

      await markDeadLetterResolved(auth.orgId, id);
      await auditAction(auth, "dlq.resolved", { targetType: "dlq", targetId: id });

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
  // Bulk-dismiss several dead letters in one request — the multi-select
  // equivalent of POST /dlq/resolve. Mirrors /dlq/cluster-apply's loop +
  // partial-success envelope, but resolves (accepts the loss) instead of
  // replaying. Each entry is the same operation as a single resolve, so it
  // reuses the `dlq.resolved` audit action (metadata.bulk flags the batch).
  { method: "POST", match: "/dlq/bulk-resolve", role: "editor",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const idsRaw = body.deadLetterIds;
      if (!Array.isArray(idsRaw) || idsRaw.length === 0) {
        return sendError(res, "dlq_ids_required", "deadLetterIds is required and must be a non-empty array", 400);
      }
      if (idsRaw.length > CLUSTER_MEMBERS_MAX_LIMIT) {
        return sendError(res, "dlq_ids_cap_exceeded", "deadLetterIds exceeds the per-request cap of {{cap}}", 400, { cap: CLUSTER_MEMBERS_MAX_LIMIT });
      }
      const deadLetterIds: string[] = [];
      for (const candidate of idsRaw) {
        if (typeof candidate !== "string" || candidate.length === 0) {
          return sendError(res, "dlq_ids_invalid_entries", "deadLetterIds must contain non-empty strings", 400);
        }
        deadLetterIds.push(candidate);
      }

      const errors: Array<{ deadLetterId: string; error: string }> = [];
      let resolved = 0;

      for (const id of deadLetterIds) {
        const item = await getDeadLetter(auth.orgId, id);
        if (!item) {
          errors.push({ deadLetterId: id, error: "DLQ entry not found" });
          continue;
        }
        try {
          await markDeadLetterResolved(auth.orgId, id);
          await auditAction(auth, "dlq.resolved", { targetType: "dlq", targetId: id, metadata: { bulk: true } });
          // Manual dismiss is not a replay — keep the linked recovery item's
          // resolution reason honest (accepted_loss), mirroring single resolve.
          await autoResolveRecoveryItemFromReplay({
            orgId: auth.orgId,
            deadLetterId: id,
            actor: auth.userId,
            resolutionReason: "accepted_loss",
            via: "dlq_resolve",
          });
          resolved += 1;
        } catch (err) {
          errors.push({ deadLetterId: id, error: err instanceof Error ? err.message : String(err) });
        }
      }

      return sendJson(res, { resolved, failed: errors.length, errors });
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
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: RATE_LIMIT_WINDOW_MS, max: orgConfig.ai.rateLimitPerMin });
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));

      const deadLetterId = typeof body.deadLetterId === "string" ? body.deadLetterId : null;
      if (!deadLetterId) return sendError(res, "dlq_field_required", "deadLetterId is required", 400, { field: "deadLetterId" });
      const suggestedWorkflow = body.suggestedWorkflow;
      if (!suggestedWorkflow || typeof suggestedWorkflow !== "object") {
        return sendError(res, "dlq_field_required", "suggestedWorkflow is required", 400, { field: "suggestedWorkflow" });
      }

      const item = await getDeadLetter(auth.orgId, deadLetterId);
      if (!item) return sendError(res, "dlq_not_found", "DLQ entry not found", 404);

      // Validate the proposed workflow through the same grammar gate
      // `/ai/patch-workflow` runs on its output: strict schema parse +
      // expression-grammar sanitization. Reject early so the validation
      // run can't be seeded with a malformed DAG.
      const parsed = WorkflowSchema.safeParse(suggestedWorkflow);
      if (!parsed.success) {
        return sendError(res, "dlq_workflow_schema_invalid", "suggestedWorkflow failed schema validation: {{reason}}", 400, { reason: parsed.error.issues[0]?.message ?? "unknown" });
      }
      let sanitized: Workflow;
      try {
        sanitized = sanitizeAiWorkflow(parsed.data);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return sendError(res, "dlq_workflow_sanitize_failed", "suggestedWorkflow sanitize failed: {{reason}}", 400, { reason });
      }

      const failingNode = sanitized.nodes.find((n) => n.id === item.nodeId);
      if (!failingNode) {
        return sendError(res, "dlq_failing_node_missing", 'suggestedWorkflow does not contain the failing node id "{{nodeId}}"', 400, { nodeId: item.nodeId });
      }

      const { runId } = await dlqReplay.replayDeadLetterAsValidation({
        orgId: auth.orgId,
        originalRunId: item.runId,
        suggestedWorkflow: sanitized,
        failingNode,
        createdBy: auth.userId,
      });

      await auditAction(auth, "recovery.validation_started", { targetType: "dlq", targetId: deadLetterId, metadata: {
        validationRunId: runId,
      } });

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
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: RATE_LIMIT_WINDOW_MS, max: orgConfig.ai.rateLimitPerMin });
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));

      const clusterSignature = typeof body.clusterSignature === "string" ? body.clusterSignature : null;
      if (!clusterSignature) return sendError(res, "dlq_field_required", "clusterSignature is required", 400, { field: "clusterSignature" });
      const idsRaw = body.deadLetterIds;
      if (!Array.isArray(idsRaw) || idsRaw.length === 0) {
        return sendError(res, "dlq_ids_required", "deadLetterIds is required and must be a non-empty array", 400);
      }
      if (idsRaw.length > CLUSTER_MEMBERS_MAX_LIMIT) {
        return sendError(res, "dlq_ids_cap_exceeded", "deadLetterIds exceeds the per-request cap of {{cap}}", 400, { cap: CLUSTER_MEMBERS_MAX_LIMIT });
      }
      const deadLetterIds: string[] = [];
      for (const candidate of idsRaw) {
        if (typeof candidate !== "string" || candidate.length === 0) {
          return sendError(res, "dlq_ids_invalid_entries", "deadLetterIds must contain non-empty strings", 400);
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
          await auditAction(auth, "recovery.cluster_apply", { targetType: "dlq", targetId: id, metadata: {
            clusterSignature,
            sequenceIndex: i,
            totalInCluster,
          } });
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
  // Bulk replay across an arbitrary multi-select — the multi-select
  // equivalent of POST /dlq/replay, and the retry-many sibling of
  // /dlq/bulk-resolve. Unlike /dlq/cluster-apply it does NOT require the
  // selected rows to share an error-cluster signature, so an operator can
  // replay a mixed batch ("upstream is back — retry all of these") in one
  // request. Mirrors bulk-resolve's loop + 200 partial-success envelope; each
  // replayed row reuses the `dlq.replayed` audit action (metadata.bulk flags
  // the batch). Only `open` rows are replayed — an already-replayed/resolved
  // selection is reported in `errors` so a large batch can't double-enqueue
  // downstream work. Carries `dlq.replay` permission to match single replay.
  { method: "POST", match: "/dlq/bulk-replay", role: "editor", permission: "dlq.replay",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const idsRaw = body.deadLetterIds;
      if (!Array.isArray(idsRaw) || idsRaw.length === 0) {
        return sendError(res, "dlq_ids_required", "deadLetterIds is required and must be a non-empty array", 400);
      }
      if (idsRaw.length > CLUSTER_MEMBERS_MAX_LIMIT) {
        return sendError(res, "dlq_ids_cap_exceeded", "deadLetterIds exceeds the per-request cap of {{cap}}", 400, { cap: CLUSTER_MEMBERS_MAX_LIMIT });
      }
      const deadLetterIds: string[] = [];
      for (const candidate of idsRaw) {
        if (typeof candidate !== "string" || candidate.length === 0) {
          return sendError(res, "dlq_ids_invalid_entries", "deadLetterIds must contain non-empty strings", 400);
        }
        deadLetterIds.push(candidate);
      }

      const errors: Array<{ deadLetterId: string; error: string }> = [];
      let replayed = 0;
      const total = deadLetterIds.length;

      for (let i = 0; i < deadLetterIds.length; i += 1) {
        const id = deadLetterIds[i]!;
        const item = await getDeadLetter(auth.orgId, id);
        if (!item) {
          errors.push({ deadLetterId: id, error: "DLQ entry not found" });
          continue;
        }
        // Only open entries are replayable. Re-firing an already-replayed row
        // across a batch would double-enqueue downstream work, so skip-and-report
        // instead (mirrors /dlq/cluster-apply's status guard).
        if (item.status !== "open") {
          errors.push({ deadLetterId: id, error: `DLQ entry already ${item.status}` });
          continue;
        }
        try {
          await dlqReplay.replayDeadLetter({
            runId: item.runId,
            workflow: WorkflowSchema.parse(item.workflowJson),
            node: NodeSchema.parse(item.nodeJson),
          });
          await markDeadLetterReplayed(auth.orgId, id);
          await auditAction(auth, "dlq.replayed", { targetType: "dlq", targetId: id, metadata: { bulk: true, sequenceIndex: i, total } });
          // Auto-close the recovery_item linked to this DLQ row, if any —
          // mirrors single /dlq/replay (no cluster-apply ensure-then-close).
          await autoResolveRecoveryItemFromReplay({
            orgId: auth.orgId,
            deadLetterId: id,
            actor: auth.userId,
          });
          replayed += 1;
        } catch (err) {
          errors.push({ deadLetterId: id, error: err instanceof Error ? err.message : String(err) });
        }
      }

      return sendJson(res, { replayed, failed: errors.length, errors });
    } },
  { method: "POST", match: "/dlq/replay", role: "editor", permission: "dlq.replay",
    handler: async ({ req, res, auth }) => {
      const replayMcpGate = await guardMcpWrite(auth, "dlq.replay");
      if (!replayMcpGate.ok) return sendJson(res, replayMcpGate.body, replayMcpGate.status);
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));

      if (typeof body.deadLetterId === "string") {
        const item = await getDeadLetter(auth.orgId, body.deadLetterId);
        if (!item) return sendError(res, "dlq_not_found", "Not found", 404);

        await dlqReplay.replayDeadLetter({
          runId: item.runId,
          workflow: WorkflowSchema.parse(item.workflowJson),
          node: NodeSchema.parse(item.nodeJson),
        });

        await markDeadLetterReplayed(auth.orgId, body.deadLetterId);
        await auditAction(auth, "dlq.replayed", { targetType: "dlq", targetId: body.deadLetterId });

        // Auto-close the recovery_item linked to this DLQ row, if any.
        await autoResolveRecoveryItemFromReplay({
          orgId: auth.orgId,
          deadLetterId: body.deadLetterId,
          actor: auth.userId,
        });

        return sendJson(res, { ok: true });
      }

      const { runId, nodeId } = body;
      if (typeof runId !== "string" || typeof nodeId !== "string") return sendError(res, "dlq_fields_required", "runId and nodeId are required", 400);

      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendError(res, "dlq_forbidden", "Forbidden", 403);

      const version = await db.select().from(workflowVersions).where(eq(workflowVersions.id, run[0].workflowVersionId));
      if (!version[0] || version[0].orgId !== auth.orgId) return sendError(res, "dlq_workflow_version_not_found", "Workflow version not found", 404);

      const workflow = WorkflowSchema.parse(version[0].dagJson);
      const node = workflow.nodes.find(candidate => candidate.id === nodeId);
      if (!node) return sendError(res, "dlq_node_not_found", "Node not found in workflow", 404);

      await dlqReplay.replayDeadLetter({ runId, workflow, node });
      await auditAction(auth, "dlq.replayed", { targetType: "run", targetId: runId, metadata: { nodeId } });

      return sendJson(res, { ok: true });
    } },
];
