/**
 * Recovery items (incidents) CRUD + transition routes.
 *
 * Eleven routes registered into the global `routes: Route[]` registry:
 *
 *   - `GET    /recovery/items`                        — list paginated     (viewer, recovery.read)
 *   - `GET    /recovery/items/:id`                    — single item        (viewer, recovery.read)
 *   - `GET    /recovery/items/:id/children`           — debounce occurrences (viewer, recovery.read)
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

import { z } from "zod";

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
  listHandoffsForItem,
  listRecoveryItemChildren,
  countRecoveryItemChildren,
  getWorkflowMetadata,
  resolveRecoveryEvidence,
} from "@janusly/data";
import { buildRecoveryEvidenceReport, type RecoveryEvidenceReportJson } from "@janusly/engine/src/recovery-evidence-report";

import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { HTTP_CAPS, RATE_LIMIT_WINDOW_MS } from "../constants";
import { asRecord, corsHeaders, readJson, sendJson } from "../http";
import type { CorsAwareResponse } from "../http";
import { enforceRateLimit } from "../rate-limit";
import {
  REPORTS_DELIVER_RATE_LIMIT_BUCKET,
  REPORTS_DELIVER_RATE_LIMIT_PER_MIN,
  deliverDestinationSchema,
  dispatchReportDelivery,
  refineDeliveryDestination,
} from "../report-delivery";
import {
  buildReportFilename,
  contentDispositionAttachment,
  type ReportFormat,
} from "../report-download";
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

/**
 * Send the uniform 409 a transition takes when the CAS UPDATE matched no
 * row (the item left the allowed pre-state between the read and the
 * write). The body carries the item's current status so the client can
 * re-render without a refetch.
 */
function sendTransitionConflict(res: CorsAwareResponse, currentStatus: string): void {
  sendJson(
    res,
    {
      error: "transition not allowed from current status",
      code: "recovery_item_transition_invalid",
      currentStatus,
    },
    409,
  );
}

/**
 * Body for `POST /recovery/items/:id/evidence/deliver` — the item id is in the
 * path, so only the destination rides the body (the run-explain deliver shape
 * minus `runId`). The shared `deliverDestinationSchema` + `refineDeliveryDestination`
 * keep the per-kind required-field rules identical across both deliver routes.
 */
const evidenceDeliverBodySchema = z
  .object({ destination: deliverDestinationSchema })
  .superRefine((value, ctx) => refineDeliveryDestination(value.destination, ctx));

/** Cap below Slack's per-block char limit; leaves headroom for the header. */
const EVIDENCE_SLACK_TEXT_MAX = HTTP_CAPS.SLACK_BLOCK_CHARS;

/**
 * Render the Slack-bound text for an evidence delivery from the report's
 * structured JSON (the source of truth — not the Markdown rendering). Surfaces
 * the highest-signal incident fields first; truncated + ellipsised over the cap.
 * The persisted JSON is already secret-scrubbed by the report builder.
 */
function buildEvidenceSlackText(json: RecoveryEvidenceReportJson): string {
  const { incident } = json;
  const displayName = incident.workflowId ?? "(ad-hoc workflow)";
  const lines: string[] = [
    `*Janusly incident evidence: ${displayName} – ${incident.severity} – ${incident.status}*`,
  ];
  const rootCause = incident.failureSignature ?? json.run?.rootCause?.signature ?? null;
  if (rootCause) lines.push(`Root cause: ${rootCause}`);
  if (json.run?.failedNode) {
    lines.push(`Failed node: ${json.run.failedNode.nodeId} — ${json.run.failedNode.errorSummary}`);
  }
  const body = lines.join("\n");
  return body.length <= EVIDENCE_SLACK_TEXT_MAX ? body : `${body.slice(0, EVIDENCE_SLACK_TEXT_MAX - 1)}…`;
}

/** GitHub issue title — `<workflow> – <severity> (<short_item_id>)`. */
function buildEvidenceGitHubTitle(json: RecoveryEvidenceReportJson): string {
  const { incident } = json;
  const displayName = incident.workflowId ?? "(ad-hoc workflow)";
  return `Janusly incident evidence: ${displayName} – ${incident.severity} (${incident.recoveryItemId.slice(0, 8)})`;
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
    // Child DLQ occurrences attached to this incident during a failure
    // storm (debounce). Powers the "N occurrences" drawer. Org-gated via
    // the parent lookup so a cross-org id leaks nothing.
    method: "GET",
    match: (url) => /^\/recovery\/items\/[^/?]+\/children$/.test(url.split("?")[0] ?? ""),
    role: "viewer",
    permission: "recovery.read",
    handler: async ({ req, res, auth }) => {
      const id = idFromUrl(req.url, "children");
      if (!id) return sendJson(res, { error: "id required" }, 400);
      const item = await getRecoveryItemById(auth.orgId, id);
      if (!item) return sendJson(res, { error: "not found", code: "recovery_item_not_found" }, 404);
      const [children, total] = await Promise.all([
        listRecoveryItemChildren(auth.orgId, id),
        countRecoveryItemChildren(auth.orgId, id),
      ]);
      return sendJson(res, { children, total });
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
        return sendTransitionConflict(res, current.status);
      }
      await auditAction(auth, "recovery.item.acknowledged", { targetType: "recovery-item", targetId: id, metadata: {
        before: { status: result.before.status, owner: result.before.owner, severity: result.before.severity },
        after: { status: result.after.status, owner: result.after.owner, severity: result.after.severity },
      } });
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
        return sendTransitionConflict(res, current.status);
      }
      await auditAction(auth, "recovery.item.in_progress", { targetType: "recovery-item", targetId: id, metadata: {
        before: { status: result.before.status, owner: result.before.owner },
        after: { status: result.after.status, owner: result.after.owner },
      } });
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
        return sendTransitionConflict(res, current.status);
      }
      if (body.data.comment) {
        await appendCommentToRecoveryItem({
          orgId: auth.orgId,
          id,
          authorUserId: auth.userId,
          body: body.data.comment,
        });
      }
      await auditAction(auth, "recovery.item.waiting_external", { targetType: "recovery-item", targetId: id, metadata: {
        before: { status: result.before.status, owner: result.before.owner },
        after: { status: result.after.status, owner: result.after.owner },
      } });
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
        return sendTransitionConflict(res, current.status);
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
      await auditAction(auth, "recovery.item.escalated", { targetType: "recovery-item", targetId: id, metadata: {
        before: { severity: result.before.severity, slaTargetAt: result.before.slaTargetAt.toISOString() },
        after: { severity: result.after.severity, slaTargetAt: result.after.slaTargetAt.toISOString() },
        isEscalation: escalation,
      } });
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
        return sendTransitionConflict(res, current.status);
      }
      await auditAction(auth, "recovery.item.assigned", { targetType: "recovery-item", targetId: id, metadata: {
        before: { owner: result.before.owner },
        after: { owner: result.after.owner },
        defaultedFromMetadata,
      } });
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
        return sendTransitionConflict(res, current.status);
      }
      if (body.data.comment) {
        await appendCommentToRecoveryItem({
          orgId: auth.orgId,
          id,
          authorUserId: auth.userId,
          body: body.data.comment,
        });
      }
      await auditAction(auth, "recovery.item.resolved", { targetType: "recovery-item", targetId: id, metadata: {
        before: { status: result.before.status, resolutionReason: result.before.resolutionReason },
        after: { status: result.after.status, resolutionReason: result.after.resolutionReason },
        resolutionReason: body.data.resolutionReason,
      } });
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
        return sendTransitionConflict(res, current.status);
      }
      if (body.data.comment) {
        await appendCommentToRecoveryItem({
          orgId: auth.orgId,
          id,
          authorUserId: auth.userId,
          body: body.data.comment,
        });
      }
      await auditAction(auth, "recovery.item.reopened", { targetType: "recovery-item", targetId: id, metadata: {
        before: { status: result.before.status, resolutionReason: result.before.resolutionReason },
        after: { status: result.after.status, resolutionReason: result.after.resolutionReason },
      } });
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
      await auditAction(auth, "recovery.item.commented", { targetType: "recovery-item", targetId: id, metadata: {
        commentId: result.ok ? result.comment.id : null,
        bodyPreview,
      } });
      return sendJson(res, { comment: result.ok ? result.comment : null });
    },
  },
  {
    // POST /recovery/items/:id/evidence?format=json|markdown
    //
    // Single downloadable "audit evidence" artefact for one incident —
    // run timeline (pagination cap respected), DLQ row, scrubbed failure
    // signature, AI explanation mode, selected patch diff (via shared
    // computeWorkflowDiff), sandbox validation result, approval trail,
    // audit rows scoped to (runId, deadLetterId, recoveryItemId), and a
    // rollback link. Mirrors the `/reports/run-explain` download shape
    // (JSON envelope + optional Markdown rendering, dual-form
    // Content-Disposition). Compliance buyers archive this per failure.
    //
    // `role: "editor"` AND `permission: "recovery.read"` — the registry
    // requires BOTH, so an editor-rank operator with recovery.read can
    // export; a plain viewer cannot (editor rank is the AC requirement).
    //
    // Multi-tenant gate lives in `resolveRecoveryEvidence` (the recovery
    // item read is org-scoped; a cross-org / missing id returns a uniform
    // 404 with no enumeration distinction). Secrets are redacted at the
    // safePersistPayload chokepoint (write time) AND again at render time
    // (scrubSecretShapes inside the builder). Every export writes a
    // `report.evidence.exported` audit row.
    method: "POST",
    match: (url) => /^\/recovery\/items\/[^/?]+\/evidence$/.test(url.split("?")[0] ?? ""),
    role: "editor",
    permission: "recovery.read",
    handler: async ({ req, res, auth }) => {
      const id = idFromUrl(req.url, "evidence");
      if (!id) return sendJson(res, { error: "id required" }, 400);

      const url = new URL(req.url ?? "", "http://internal");
      const formatRaw = (url.searchParams.get("format") ?? "json").toLowerCase();
      if (formatRaw !== "markdown" && formatRaw !== "json") {
        return sendJson(res, { error: `Unknown format: ${formatRaw}. Use "markdown" or "json".` }, 400);
      }
      const format = formatRaw as ReportFormat;

      const bundle = await resolveRecoveryEvidence(auth.orgId, id);
      if (!bundle) {
        return sendJson(res, { error: "not found", code: "recovery_item_not_found" }, 404);
      }

      const report = buildRecoveryEvidenceReport({
        recoveryItem: bundle.recoveryItem,
        deadLetter: bundle.deadLetter,
        originalRun: bundle.originalRun,
        originalRunNodes: bundle.originalRunNodes,
        originalRunEvents: bundle.originalRunEvents,
        originalRunEventsTruncated: bundle.originalRunEventsTruncated,
        validationRun: bundle.validationRun,
        validationRunNodes: bundle.validationRunNodes,
        auditRows: bundle.auditRows,
        rollback: bundle.rollback,
        appBaseUrl: process.env.JANUSLY_PUBLIC_APP_URL ?? null,
      });

      await auditAction(auth, "report.evidence.exported", {
        targetType: "recovery-item",
        targetId: id,
        metadata: {
          format,
          deadLetterId: bundle.recoveryItem.deadLetterId,
          workflowId: bundle.recoveryItem.workflowId,
          runId: bundle.deadLetter?.runId ?? null,
          validationRunId: bundle.validationRun?.id ?? null,
          hasPatchDiff: report.json.patchDiff !== null,
          auditRowCount: report.json.auditTrail.length,
        },
      });

      const { asciiFilename, utf8Filename } = buildReportFilename({
        runId: id,
        workflowName: bundle.recoveryItem.workflowId,
        status: `evidence-${bundle.recoveryItem.status}`,
        createdAt: bundle.recoveryItem.createdAt,
        format,
      });

      if (format === "json") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Disposition": contentDispositionAttachment(asciiFilename, utf8Filename),
          "Access-Control-Expose-Headers": "Content-Disposition",
          ...corsHeaders(res),
        });
        res.end(JSON.stringify(report.json));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": contentDispositionAttachment(asciiFilename, utf8Filename),
        "Access-Control-Expose-Headers": "Content-Disposition",
        ...corsHeaders(res),
      });
      res.end(report.markdown);
    },
  },
  {
    // POST /recovery/items/:id/evidence/deliver — dispatch the evidence report
    // to Slack / a GitHub issue / a signed webhook through the SAME shared
    // report-delivery layer run-explain deliver uses (executeTool → credential
    // resolution, per-tool rate-limit, usage events, SSRF / body-cap / timeout
    // guards). Multi-tenant gate lives in resolveRecoveryEvidence (uniform 404,
    // no enumeration leak). NEVER throws — missing-credential / non-2xx /
    // network failures return { ok: false, error } with the env-var name NEVER
    // echoed. Audits report.evidence.delivered on BOTH success AND failure.
    // Distinct from /handoff (a short incident notification, not the full report).
    method: "POST",
    match: (url) => /^\/recovery\/items\/[^/?]+\/evidence\/deliver$/.test(url.split("?")[0] ?? ""),
    role: "editor",
    permission: "recovery.read",
    handler: async ({ req, res, auth }) => {
      const id = idFromUrl(req.url, "evidence/deliver");
      if (!id) return sendJson(res, { error: "id required" }, 400);

      const rawBody = await readJson(req, MAX_JSON_BODY_BYTES);
      const parsed = evidenceDeliverBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        const firstIssue = parsed.error.issues[0];
        const path = firstIssue?.path.join(".") ?? "body";
        const message = firstIssue?.message ?? "invalid body";
        return sendJson(res, { error: `Invalid request: ${path}: ${message}` }, 400);
      }
      const { destination } = parsed.data;

      // `credentialName` is the operator-visible identifier — never the env-var
      // that backs the secret. safePersistPayload (inside `audit`) is the final
      // redaction, but the route never threads the env-var name in.
      const writeAuditRow = async (fields: Record<string, unknown>): Promise<void> => {
        await auditAction(auth, "report.evidence.delivered", {
          targetType: "recovery-item",
          targetId: id,
          metadata: fields,
        });
      };

      // Outer rate-limit (shared "reports.deliver" bucket). On exceed, record the
      // bucket exercise then 429.
      try {
        await enforceRateLimit(auth.orgId, {
          name: REPORTS_DELIVER_RATE_LIMIT_BUCKET,
          windowMs: RATE_LIMIT_WINDOW_MS,
          max: REPORTS_DELIVER_RATE_LIMIT_PER_MIN,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "rate limit exceeded";
        await writeAuditRow({
          destination: destination.kind,
          ok: false,
          error: "rate_limit_exceeded",
          latencyMs: 0,
          credentialName: destination.credentialName,
        });
        return sendJson(res, { error: message }, 429);
      }

      const bundle = await resolveRecoveryEvidence(auth.orgId, id);
      if (!bundle) {
        return sendJson(res, { error: "not found", code: "recovery_item_not_found" }, 404);
      }

      const report = buildRecoveryEvidenceReport({
        recoveryItem: bundle.recoveryItem,
        deadLetter: bundle.deadLetter,
        originalRun: bundle.originalRun,
        originalRunNodes: bundle.originalRunNodes,
        originalRunEvents: bundle.originalRunEvents,
        originalRunEventsTruncated: bundle.originalRunEventsTruncated,
        validationRun: bundle.validationRun,
        validationRunNodes: bundle.validationRunNodes,
        auditRows: bundle.auditRows,
        rollback: bundle.rollback,
        appBaseUrl: process.env.JANUSLY_PUBLIC_APP_URL ?? null,
      });

      const outcome = await dispatchReportDelivery({
        orgId: auth.orgId,
        ...(bundle.deadLetter?.runId ? { runId: bundle.deadLetter.runId } : {}),
        destination,
        slackText: buildEvidenceSlackText(report.json),
        githubTitle: buildEvidenceGitHubTitle(report.json),
        githubBody: report.markdown,
        webhookPayload: report.json as unknown as Record<string, unknown>,
      });

      await writeAuditRow({
        destination: destination.kind,
        ok: outcome.ok,
        statusCode: outcome.statusCode,
        error: outcome.error,
        latencyMs: outcome.latencyMs,
        deadLetterId: bundle.recoveryItem.deadLetterId,
        workflowId: bundle.recoveryItem.workflowId,
        runId: bundle.deadLetter?.runId ?? null,
        credentialName: destination.credentialName,
        deliveryId: outcome.deliveryId,
      });

      return sendJson(res, {
        ok: outcome.ok,
        destination: destination.kind,
        statusCode: outcome.statusCode,
        error: outcome.error,
        latencyMs: outcome.latencyMs,
        deliveryId: outcome.deliveryId,
      });
    },
  },
];
