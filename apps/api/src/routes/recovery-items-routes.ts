/**
 * Recovery items (incidents) CRUD + transition routes.
 *
 * Ten routes registered into the global `routes: Route[]` registry:
 *
 *   - `GET    /recovery/items`                        — list paginated     (viewer, recovery.read)
 *   - `GET    /recovery/items/:id`                    — single item        (viewer, recovery.read)
 *   - `POST   /recovery/items/:id/acknowledge`        — open|reopened →    (editor, recovery.write)
 *   - `POST   /recovery/items/:id/in-progress`        — ack|waiting →      (editor, recovery.write)
 *   - `POST   /recovery/items/:id/waiting-external`   — ack|in_prog →      (editor, recovery.write)
 *   - `POST   /recovery/items/:id/escalate`           — severity bump      (editor, recovery.write)
 *   - `POST   /recovery/items/:id/assign`             — owner reassign     (editor, recovery.write)
 *   - `POST   /recovery/items/:id/resolve`            — !resolved →        (editor, recovery.write)
 *   - `POST   /recovery/items/:id/reopen`             — resolved →         (editor, recovery.write)
 *   - `POST   /recovery/items/:id/comment`            — append comment     (editor, recovery.write)
 *
 * Body validation via Zod schemas in `@janusly/shared/src/recovery-item`.
 * CAS-loser transitions return 409 with
 * `{ code: "recovery_item_transition_invalid", currentStatus }`. Every
 * mutation writes audit `recovery.item.<transition>` with
 * `{ before, after }` metadata.
 *
 * Multi-tenant scope enforced by the repo (`eq(recoveryItems.orgId, orgId)`).
 */

import {
  AcknowledgeBodySchema,
  AssignOwnerBodySchema,
  CommentBodySchema,
  EscalateBodySchema,
  InProgressBodySchema,
  ListRecoveryItemsFilterSchema,
  ReopenBodySchema,
  ResolveBodySchema,
  WaitingExternalBodySchema,
  isSeverityEscalation,
} from "@janusly/shared";
import {
  acknowledgeRecoveryItem,
  appendCommentToRecoveryItem,
  assignOwnerRecoveryItem,
  escalateRecoveryItem,
  getRecoveryItemById,
  listRecoveryItems,
  reopenRecoveryItem,
  resolveRecoveryItem,
  setInProgressRecoveryItem,
  setWaitingExternalRecoveryItem,
} from "@janusly/data/src/recoveryItemsRepo";
import { listHandoffsForItem } from "@janusly/data/src/recoveryItemHandoffsRepo";
import { getWorkflowMetadata } from "@janusly/data/src/workflowMetadataRepo";

import { audit } from "../audit";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { asRecord, readJson, sendJson } from "../http";
import type { Route } from "../routes";

function idFromUrl(url: string | undefined, verb?: string): string | null {
  if (!url) return null;
  const path = url.split("?")[0] ?? "";
  const re = verb
    ? new RegExp(`^\\/recovery\\/items\\/([^/?]+)\\/${verb}$`)
    : /^\/recovery\/items\/([^/?]+)$/;
  const m = path.match(re);
  return m ? m[1] : null;
}

function statusCodeFromTransition(currentStatus: string): { code: number; body: Record<string, unknown> } {
  return {
    code: 409,
    body: {
      error: "transition not allowed from current status",
      code: "recovery_item_transition_invalid",
      currentStatus,
    },
  };
}

export const recoveryItemsRoutes: Route[] = [
  {
    method: "GET",
    match: (url) => url === "/recovery/items" || url.startsWith("/recovery/items?"),
    role: "viewer",
    permission: "recovery.read",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "/recovery/items", "http://internal");
      const params: Record<string, unknown> = {};
      const status = url.searchParams.get("status");
      const owner = url.searchParams.get("owner");
      const severity = url.searchParams.get("severity");
      const limit = url.searchParams.get("limit");
      const cursor = url.searchParams.get("cursor");
      if (status) params.status = status;
      if (owner) params.owner = owner === "me" ? auth.userId : owner;
      if (severity) params.severity = severity;
      if (limit) params.limit = Number.parseInt(limit, 10);
      if (cursor) params.cursorIso = cursor;
      const parsed = ListRecoveryItemsFilterSchema.safeParse(params);
      if (!parsed.success) {
        return sendJson(res, { error: "invalid filter", code: "invalid_filter" }, 400);
      }
      const result = await listRecoveryItems({ orgId: auth.orgId, ...parsed.data });
      return sendJson(res, result);
    },
  },
  {
    method: "GET",
    match: (url) => /^\/recovery\/items\/[^/?]+$/.test(url.split("?")[0] ?? ""),
    role: "viewer",
    permission: "recovery.read",
    handler: async ({ req, res, auth }) => {
      const id = idFromUrl(req.url);
      if (!id) return sendJson(res, { error: "id required" }, 400);
      const item = await getRecoveryItemById(auth.orgId, id);
      if (!item) return sendJson(res, { error: "not found", code: "recovery_item_not_found" }, 404);
      const handoffs = await listHandoffsForItem(auth.orgId, id);
      return sendJson(res, { item, handoffs });
    },
  },
  {
    method: "POST",
    match: (url) => /^\/recovery\/items\/[^/?]+\/acknowledge$/.test(url),
    role: "editor",
    permission: "recovery.write",
    handler: async ({ req, res, auth }) => {
      const id = idFromUrl(req.url, "acknowledge");
      if (!id) return sendJson(res, { error: "id required" }, 400);
      const body = AcknowledgeBodySchema.safeParse(asRecord(await readJson(req, MAX_JSON_BODY_BYTES)));
      if (!body.success) return sendJson(res, { error: "invalid body", issues: body.error.issues }, 422);
      const current = await getRecoveryItemById(auth.orgId, id);
      if (!current) return sendJson(res, { error: "not found", code: "recovery_item_not_found" }, 404);
      const result = await acknowledgeRecoveryItem(auth.orgId, id, body.data);
      if (!result) {
        const { code, body: errBody } = statusCodeFromTransition(current.status);
        return sendJson(res, errBody, code);
      }
      await audit(auth.orgId, auth.userId, "recovery.item.acknowledged", "recovery-item", id, {
        before: { status: result.before.status, owner: result.before.owner, severity: result.before.severity },
        after: { status: result.after.status, owner: result.after.owner, severity: result.after.severity },
      });
      return sendJson(res, { item: result.after });
    },
  },
  {
    method: "POST",
    match: (url) => /^\/recovery\/items\/[^/?]+\/in-progress$/.test(url),
    role: "editor",
    permission: "recovery.write",
    handler: async ({ req, res, auth }) => {
      const id = idFromUrl(req.url, "in-progress");
      if (!id) return sendJson(res, { error: "id required" }, 400);
      const body = InProgressBodySchema.safeParse(asRecord(await readJson(req, MAX_JSON_BODY_BYTES)));
      if (!body.success) return sendJson(res, { error: "invalid body", issues: body.error.issues }, 422);
      const current = await getRecoveryItemById(auth.orgId, id);
      if (!current) return sendJson(res, { error: "not found", code: "recovery_item_not_found" }, 404);
      const result = await setInProgressRecoveryItem(auth.orgId, id, body.data);
      if (!result) {
        const { code, body: errBody } = statusCodeFromTransition(current.status);
        return sendJson(res, errBody, code);
      }
      await audit(auth.orgId, auth.userId, "recovery.item.in_progress", "recovery-item", id, {
        before: { status: result.before.status, owner: result.before.owner },
        after: { status: result.after.status, owner: result.after.owner },
      });
      return sendJson(res, { item: result.after });
    },
  },
  {
    method: "POST",
    match: (url) => /^\/recovery\/items\/[^/?]+\/waiting-external$/.test(url),
    role: "editor",
    permission: "recovery.write",
    handler: async ({ req, res, auth }) => {
      const id = idFromUrl(req.url, "waiting-external");
      if (!id) return sendJson(res, { error: "id required" }, 400);
      const body = WaitingExternalBodySchema.safeParse(asRecord(await readJson(req, MAX_JSON_BODY_BYTES)));
      if (!body.success) return sendJson(res, { error: "invalid body", issues: body.error.issues }, 422);
      const current = await getRecoveryItemById(auth.orgId, id);
      if (!current) return sendJson(res, { error: "not found", code: "recovery_item_not_found" }, 404);
      const result = await setWaitingExternalRecoveryItem(auth.orgId, id, { owner: body.data.owner });
      if (!result) {
        const { code, body: errBody } = statusCodeFromTransition(current.status);
        return sendJson(res, errBody, code);
      }
      if (body.data.comment) {
        await appendCommentToRecoveryItem({
          orgId: auth.orgId,
          id,
          authorUserId: auth.userId,
          body: body.data.comment,
        });
      }
      await audit(auth.orgId, auth.userId, "recovery.item.waiting_external", "recovery-item", id, {
        before: { status: result.before.status, owner: result.before.owner },
        after: { status: result.after.status, owner: result.after.owner },
      });
      return sendJson(res, { item: result.after });
    },
  },
  {
    method: "POST",
    match: (url) => /^\/recovery\/items\/[^/?]+\/escalate$/.test(url),
    role: "editor",
    permission: "recovery.write",
    handler: async ({ req, res, auth }) => {
      const id = idFromUrl(req.url, "escalate");
      if (!id) return sendJson(res, { error: "id required" }, 400);
      const body = EscalateBodySchema.safeParse(asRecord(await readJson(req, MAX_JSON_BODY_BYTES)));
      if (!body.success) return sendJson(res, { error: "invalid body", issues: body.error.issues }, 422);
      const current = await getRecoveryItemById(auth.orgId, id);
      if (!current) return sendJson(res, { error: "not found", code: "recovery_item_not_found" }, 404);
      if (!isSeverityEscalation(current.severity, body.data.severity)) {
        return sendJson(
          res,
          {
            error: "severity must increase on escalation",
            code: "recovery_item_not_escalation",
            currentSeverity: current.severity,
          },
          422,
        );
      }
      const result = await escalateRecoveryItem(auth.orgId, id, {
        severity: body.data.severity,
        slaTargetAtOverrideIso: body.data.slaTargetAtOverrideIso,
      });
      if (!result) {
        const { code, body: errBody } = statusCodeFromTransition(current.status);
        return sendJson(res, errBody, code);
      }
      if (body.data.comment) {
        await appendCommentToRecoveryItem({
          orgId: auth.orgId,
          id,
          authorUserId: auth.userId,
          body: body.data.comment,
        });
      }
      const escalation = isSeverityEscalation(result.before.severity, result.after.severity);
      await audit(auth.orgId, auth.userId, "recovery.item.escalated", "recovery-item", id, {
        before: { severity: result.before.severity, slaTargetAt: result.before.slaTargetAt.toISOString() },
        after: { severity: result.after.severity, slaTargetAt: result.after.slaTargetAt.toISOString() },
        isEscalation: escalation,
      });
      return sendJson(res, { item: result.after, isEscalation: escalation });
    },
  },
  {
    method: "POST",
    match: (url) => /^\/recovery\/items\/[^/?]+\/assign$/.test(url),
    role: "editor",
    permission: "recovery.write",
    handler: async ({ req, res, auth }) => {
      const id = idFromUrl(req.url, "assign");
      if (!id) return sendJson(res, { error: "id required" }, 400);
      const body = AssignOwnerBodySchema.safeParse(asRecord(await readJson(req, MAX_JSON_BODY_BYTES)));
      if (!body.success) return sendJson(res, { error: "invalid body", issues: body.error.issues }, 422);
      const current = await getRecoveryItemById(auth.orgId, id);
      if (!current) return sendJson(res, { error: "not found", code: "recovery_item_not_found" }, 404);

      // Default-owner integration: when the operator omits `owner` AND
      // the item is linked to a workflow, fall back to the workflow's
      // primary owner (the first entry in workflow_metadata.owners).
      // Operator-supplied owners always win; the default only fills
      // omitted/null input. Failures degrade silently — the assign still
      // runs with `owner: null` so the operator can retry from the UI.
      let owner = body.data.owner ?? null;
      let defaultedFromMetadata = false;
      if (owner === null && current.workflowId) {
        try {
          const metadata = await getWorkflowMetadata(auth.orgId, current.workflowId);
          const primary = metadata?.owners?.[0];
          if (primary && primary.length > 0) {
            owner = primary;
            defaultedFromMetadata = true;
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("[recovery-items] default-owner lookup failed", {
            orgId: auth.orgId,
            workflowId: current.workflowId,
            err,
          });
        }
      }

      const result = await assignOwnerRecoveryItem(auth.orgId, id, { owner });
      if (!result) {
        const { code, body: errBody } = statusCodeFromTransition(current.status);
        return sendJson(res, errBody, code);
      }
      await audit(auth.orgId, auth.userId, "recovery.item.assigned", "recovery-item", id, {
        before: { owner: result.before.owner },
        after: { owner: result.after.owner },
        defaultedFromMetadata,
      });
      return sendJson(res, { item: result.after, defaultedFromMetadata });
    },
  },
  {
    method: "POST",
    match: (url) => /^\/recovery\/items\/[^/?]+\/resolve$/.test(url),
    role: "editor",
    permission: "recovery.write",
    handler: async ({ req, res, auth }) => {
      const id = idFromUrl(req.url, "resolve");
      if (!id) return sendJson(res, { error: "id required" }, 400);
      const body = ResolveBodySchema.safeParse(asRecord(await readJson(req, MAX_JSON_BODY_BYTES)));
      if (!body.success) return sendJson(res, { error: "invalid body", issues: body.error.issues }, 422);
      const current = await getRecoveryItemById(auth.orgId, id);
      if (!current) return sendJson(res, { error: "not found", code: "recovery_item_not_found" }, 404);
      const result = await resolveRecoveryItem(auth.orgId, id, {
        actor: auth.userId,
        reason: body.data.resolutionReason,
      });
      if (!result) {
        const { code, body: errBody } = statusCodeFromTransition(current.status);
        return sendJson(res, errBody, code);
      }
      if (body.data.comment) {
        await appendCommentToRecoveryItem({
          orgId: auth.orgId,
          id,
          authorUserId: auth.userId,
          body: body.data.comment,
        });
      }
      await audit(auth.orgId, auth.userId, "recovery.item.resolved", "recovery-item", id, {
        before: { status: result.before.status, resolutionReason: result.before.resolutionReason },
        after: { status: result.after.status, resolutionReason: result.after.resolutionReason },
        resolutionReason: body.data.resolutionReason,
      });
      return sendJson(res, { item: result.after });
    },
  },
  {
    method: "POST",
    match: (url) => /^\/recovery\/items\/[^/?]+\/reopen$/.test(url),
    role: "editor",
    permission: "recovery.write",
    handler: async ({ req, res, auth }) => {
      const id = idFromUrl(req.url, "reopen");
      if (!id) return sendJson(res, { error: "id required" }, 400);
      const body = ReopenBodySchema.safeParse(asRecord(await readJson(req, MAX_JSON_BODY_BYTES)));
      if (!body.success) return sendJson(res, { error: "invalid body", issues: body.error.issues }, 422);
      const current = await getRecoveryItemById(auth.orgId, id);
      if (!current) return sendJson(res, { error: "not found", code: "recovery_item_not_found" }, 404);
      const result = await reopenRecoveryItem(auth.orgId, id, { actor: auth.userId });
      if (!result) {
        const { code, body: errBody } = statusCodeFromTransition(current.status);
        return sendJson(res, errBody, code);
      }
      if (body.data.comment) {
        await appendCommentToRecoveryItem({
          orgId: auth.orgId,
          id,
          authorUserId: auth.userId,
          body: body.data.comment,
        });
      }
      await audit(auth.orgId, auth.userId, "recovery.item.reopened", "recovery-item", id, {
        before: { status: result.before.status, resolutionReason: result.before.resolutionReason },
        after: { status: result.after.status, resolutionReason: result.after.resolutionReason },
      });
      return sendJson(res, { item: result.after });
    },
  },
  {
    method: "POST",
    match: (url) => /^\/recovery\/items\/[^/?]+\/comment$/.test(url),
    role: "editor",
    permission: "recovery.write",
    handler: async ({ req, res, auth }) => {
      const id = idFromUrl(req.url, "comment");
      if (!id) return sendJson(res, { error: "id required" }, 400);
      const body = CommentBodySchema.safeParse(asRecord(await readJson(req, MAX_JSON_BODY_BYTES)));
      if (!body.success) return sendJson(res, { error: "invalid body", issues: body.error.issues }, 422);
      const result = await appendCommentToRecoveryItem({
        orgId: auth.orgId,
        id,
        authorUserId: auth.userId,
        body: body.data.body,
      });
      if (!result.ok && result.reason === "not_found") {
        return sendJson(res, { error: "not found", code: "recovery_item_not_found" }, 404);
      }
      if (!result.ok && result.reason === "comment_cap_reached") {
        return sendJson(
          res,
          { error: "comment cap reached", code: "recovery_item_comment_cap_reached" },
          422,
        );
      }
      const bodyPreview = body.data.body.slice(0, 200);
      await audit(auth.orgId, auth.userId, "recovery.item.commented", "recovery-item", id, {
        commentId: result.ok ? result.comment.id : null,
        bodyPreview,
      });
      return sendJson(res, { comment: result.ok ? result.comment : null });
    },
  },
];
