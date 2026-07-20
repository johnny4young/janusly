/**
 * Inbound-trigger ingestion seam + replay + recent-event feed.
 *
 * The three event-driven trigger node types (`email_received`,
 * `file_dropped`, `mcp_server_event`) start runs through this surface. Each
 * `POST /triggers/<kind>/ingest` route accepts a NORMALIZED inbound payload
 * (a real SMTP relay, an SES/Mailgun forwarder, a bucket-event listener, or
 * an MCP subscriber all produce the same shape) and runs the same pipeline:
 *
 *   1. Auth + `triggers.ingest` permission (multi-tenant: the relay
 *      authenticates as the tenant; an event can only fire that tenant's
 *      triggers — a node in another org's workflow is structurally
 *      unreachable because the resolver only loads the caller's versions).
 *   2. Payload schema validation + size caps (email body 1 MiB; attachments
 *      / object metadata / MCP payload 64 KiB) → 413 on overflow.
 *   3. Resolve the matching trigger node in the org's LATEST workflow
 *      versions → 404 `trigger_no_matching_node` when none matches.
 *   4. Per-trigger rate-limit storm guard (default 60/min, operator-
 *      overridable via the node config) → records the inbound event as
 *      `skipped` and returns 429 rather than spawning a run.
 *   5. Persist a structured `trigger_events` row (the DLQ-style replay
 *      anchor) BEFORE spawning the run, idempotent on the inbound dedupe key.
 *   6. (email) upload attachments to the object store under
 *      `orgs/<orgId>/email/...` and replace the bodies with object keys.
 *   7. Spawn the run via `startRun` with the normalized event as the input,
 *      atomically attach the event to that run, and audit.
 *
 * `POST /triggers/events/:id/replay` re-runs a persisted event's stored
 * payload (the DLQ-style replay), reusing the same resolve + spawn path.
 *
 * Invariants:
 * - Multi-tenant scope on every DB read/write (`eq(<table>.orgId,
 *   auth.orgId)`); the resolver never trusts an org claim in the payload.
 * - `payloadJson` goes through `safePersistPayload` before persistence so a
 *   secret-shaped field in an email body / MCP resource is redacted at rest.
 * - Audit on every outcome (`received` / `started` / `skipped` / `replayed`).
 */

import { createHash } from "node:crypto";

import {
  EmailReceivedPayloadSchema,
  FileDroppedPayloadSchema,
  McpServerEventPayloadSchema,
  EMAIL_BODY_MAX_BYTES,
  FILE_METADATA_MAX_BYTES,
  MCP_EVENT_PAYLOAD_MAX_BYTES,
  resolveTriggerRateLimitPerMin,
  utf8ByteLength,
  isTriggerNodeType,
  type TriggerEventStatus,
  type TriggerNodeType,
} from "@janusly/shared/src/trigger-types";
import { WorkflowSchema } from "@janusly/shared";
import {
  countBufferedTriggerEvents,
  claimBufferedTriggerEvents,
  findTriggerEventByDedupeKey,
  getTriggerEvent,
  getWorkflowStatus,
  resolveWorkflowPauseAction,
  listTriggerEvents,
  markTriggerEventBuffered,
  markTriggerEventFailed,
  markTriggerEventSkipped,
  recordTriggerEvent,
  releaseTriggerEventBackfillClaim,
  retireTriggerEventBackfillClaim,
  resolveTriggerNode,
  type TriggerEvent,
  type ResolvedTriggerNode,
} from "@janusly/data";
import { startRun, TriggerEventStartConflictError } from "@janusly/engine/src/start-run";
import { WorkflowInputValidationError } from "@janusly/engine/src/inputs-validator";
import { safePersistPayload } from "@janusly/engine/src/safe-persist";
import { getObjectStore } from "@janusly/engine/src/object-store";

import type { AuthContext } from "../auth";
import { auditAction } from "../audit-helper";
import { RATE_LIMIT_WINDOW_MS } from "../constants";
import { errorEnvelope } from "../error-codes";
import { asRecord, readJson, sendError, sendJson } from "../http";
import { enforceRateLimit } from "../rate-limit";
import type { Route } from "../routes";

// Email ingestion accepts a larger JSON body than the default 1 MiB cap
// because the normalized envelope carries the (1 MiB) body PLUS attachment
// metadata + headers. Bodies are still re-checked against the 1 MiB byte cap
// after parse; the object-store offload keeps attachment BODIES out of band.
const EMAIL_INGEST_MAX_JSON_BYTES = 4 * 1_048_576;
const TRIGGER_INGEST_MAX_JSON_BYTES = 1_048_576;

type StatusFilter = TriggerEventStatus | undefined;

function parseStatusFilter(value: string | null): StatusFilter {
  if (value === "received" || value === "started" || value === "skipped" || value === "failed" || value === "buffered" || value === "backfilling") return value;
  return undefined;
}

/** Build the per-trigger storm-guard bucket name (namespaces the Redis key per node). */
function triggerRateLimitBucket(resolved: ResolvedTriggerNode): string {
  // The Redis key is `janusly:rate:<name>:<orgId>` so the org is the counter
  // key; the bucket name carries the per-trigger discriminator. Keep it
  // bounded — the workflow-version id + node id uniquely identify the trigger.
  return `trigger.${resolved.workflowVersionId}.${resolved.nodeId}`;
}

/** True when a thrown error is the limiter's status-bearing 429. */
function isRateLimit429(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { statusCode?: unknown }).statusCode === 429);
}

/**
 * Shared tail of every ingestion / replay path: persist the structured event,
 * apply the storm guard, spawn the run, and audit. Returns the HTTP response
 * the route should send. `replayOfEventId` is set on the replay path so the
 * audit row distinguishes a replay from a fresh inbound event.
 */
async function persistEventAndSpawnRun(args: {
  auth: AuthContext;
  triggerType: TriggerNodeType;
  resolved: ResolvedTriggerNode;
  /** Normalized payload (already size-checked; attachment bodies offloaded). */
  payload: Record<string, unknown>;
  dedupeKey: string | null;
  replayOfEventId?: string;
  /**
   * Pre-minted event row id. The email path passes the id it already used as
   * the attachment object-store key prefix so the persisted row and its
   * attachments share one id. Defaults to a fresh UUID inside the repo.
   */
  eventId?: string;
  /** Existing `received` row recovered before attachment offload. */
  existingEvent?: TriggerEvent;
}): Promise<{ status: number; body: unknown }> {
  const { auth, triggerType, resolved, payload, dedupeKey, replayOfEventId, eventId, existingEvent } = args;

  // 1. Persist the structured event BEFORE the run (DLQ-style replay anchor),
  //    idempotent on (orgId, dedupeKey) so a relay retry converges.
  const recorded = existingEvent
    ? { event: existingEvent, wasCreated: false }
    : await recordTriggerEvent({
        orgId: auth.orgId,
        triggerType,
        workflowId: resolved.workflowId,
        workflowVersionId: resolved.workflowVersionId,
        nodeId: resolved.nodeId,
        dedupeKey,
        payloadJson: safePersistPayload({ event: payload }),
        id: eventId,
      });
  const { event, wasCreated } = recorded;

  if (!wasCreated && event.status !== "received") {
    // Duplicate inbound event (same dedupe key already processed). Don't
    // spawn a second run — return the prior event so the relay sees 200.
    return {
      status: 200,
      body: { ok: true, duplicate: true, triggerEventId: event.id, runId: event.runId ?? null },
    };
  }

  let effectiveTriggerType = triggerType;
  let effectiveResolved = resolved;
  let effectivePayload = payload;
  if (!wasCreated) {
    if (!isTriggerNodeType(event.triggerType)) {
      await markTriggerEventFailed(auth.orgId, event.id, "invalid_persisted_trigger_type");
      return {
        status: 422,
        body: errorEnvelope("trigger_invalid_payload", "Persisted trigger event has an invalid type"),
      };
    }
    const persistedResolved = await resolveTriggerNode(
      auth.orgId,
      event.triggerType,
      () => true,
      event.workflowId ? { workflowId: event.workflowId, nodeId: event.nodeId } : undefined,
    );
    if (!persistedResolved) {
      await markTriggerEventFailed(auth.orgId, event.id, "persisted_trigger_node_missing");
      return {
        status: 404,
        body: errorEnvelope("trigger_no_matching_node", "Persisted trigger node no longer exists"),
      };
    }
    effectiveTriggerType = event.triggerType;
    effectiveResolved = persistedResolved;
    effectivePayload = (event.payloadJson && typeof event.payloadJson === "object" && !Array.isArray(event.payloadJson)
      ? (event.payloadJson as { event?: Record<string, unknown> }).event
      : undefined) ?? {};
  }

  if (wasCreated) {
    await auditAction(auth, "trigger.event.received", {
      targetType: "trigger_event",
      targetId: event.id,
      metadata: { triggerType: effectiveTriggerType, workflowId: effectiveResolved.workflowId, nodeId: effectiveResolved.nodeId, replay: Boolean(replayOfEventId) },
    });
  }

  // 2. Per-trigger storm guard. Over-limit → record skipped + 429.
  const ratePerMin = resolveTriggerRateLimitPerMin(effectiveResolved.nodeConfig.rateLimitPerMin);
  try {
    await enforceRateLimit(auth.orgId, {
      name: triggerRateLimitBucket(effectiveResolved),
      windowMs: RATE_LIMIT_WINDOW_MS,
      max: ratePerMin,
    });
  } catch (err) {
    if (isRateLimit429(err)) {
      await markTriggerEventSkipped(auth.orgId, event.id, "rate_limited");
      await auditAction(auth, "trigger.event.skipped", {
        targetType: "trigger_event",
        targetId: event.id,
        metadata: { triggerType: effectiveTriggerType, reason: "rate_limited", ratePerMin },
      });
      return {
        status: 429,
        body: { ok: false, skipped: true, reason: "rate_limited", triggerEventId: event.id },
      };
    }
    throw err;
  }

  // 3. Pause gate. A paused workflow must not spawn runs from ANY entry
  //    point — `/start` alone was never the flood. But an inbound event is
  //    data the upstream system already committed and will not re-send, so
  //    dropping it trades a run flood for silent data loss. Park it as
  //    `buffered` instead; resume backfills the window. 202, not 200: the
  //    event is accepted, its run is deferred — 200 would claim it ran, and
  //    a 4xx/5xx would make the relay retry or give up.
  if (effectiveResolved.workflowId) {
    const wfStatus = await getWorkflowStatus(auth.orgId, effectiveResolved.workflowId);
    const pauseAction = resolveWorkflowPauseAction(wfStatus?.status, "trigger");
    if (pauseAction.kind === "buffer") {
      await markTriggerEventBuffered(auth.orgId, event.id, pauseAction.reason);
      await auditAction(auth, "trigger.event.buffered", {
        targetType: "trigger_event",
        targetId: event.id,
        metadata: { triggerType: effectiveTriggerType, reason: pauseAction.reason, workflowId: effectiveResolved.workflowId, nodeId: effectiveResolved.nodeId },
      });
      return {
        status: 202,
        body: { ok: true, buffered: true, reason: pauseAction.reason, triggerEventId: event.id },
      };
    }
  }

  // 4. Spawn the run with the normalized event as the input. The trigger
  //    executor reads `input.event` and passes it to downstream nodes.
  const parsed = WorkflowSchema.safeParse(effectiveResolved.dagJson);
  if (!parsed.success) {
    await markTriggerEventFailed(auth.orgId, event.id, "workflow_parse_failed");
    return {
      status: 422,
      body: errorEnvelope("trigger_invalid_payload", "Resolved workflow failed schema validation"),
    };
  }

  try {
    const { runId } = await startRun({
      ...parsed.data,
      orgId: auth.orgId,
      versionId: effectiveResolved.workflowVersionId,
      createdBy: auth.userId,
      input: { triggeredBy: effectiveTriggerType, triggerEventId: event.id, event: effectivePayload },
      triggerEventStart: { id: event.id },
    });
    await auditAction(auth, replayOfEventId ? "trigger.event.replayed" : "trigger.event.started", {
      targetType: "trigger_event",
      targetId: event.id,
      metadata: { triggerType: effectiveTriggerType, runId, workflowId: effectiveResolved.workflowId, nodeId: effectiveResolved.nodeId, ...(replayOfEventId ? { replayOf: replayOfEventId } : {}) },
    });
    return { status: 200, body: { ok: true, triggerEventId: event.id, runId } };
  } catch (err) {
    if (err instanceof TriggerEventStartConflictError) {
      const existing = await getTriggerEvent(auth.orgId, event.id);
      return {
        status: 200,
        body: {
          ok: true,
          duplicate: true,
          triggerEventId: event.id,
          runId: existing?.runId ?? null,
        },
      };
    }
    if (err instanceof WorkflowInputValidationError) {
      await markTriggerEventFailed(auth.orgId, event.id, "workflow_input_invalid");
      return {
        status: 422,
        body: errorEnvelope("trigger_invalid_payload", "Trigger payload does not satisfy workflow inputs"),
      };
    }
    // Infrastructure failure: keep the row `received` so an upstream retry
    // can safely finish the atomic event-to-run transition.
    return { status: 500, body: { ok: false, error: "run_spawn_failed", triggerEventId: event.id } };
  }
}

/**
 * Upload an email's inline attachments to the object store under the per-org
 * `orgs/<orgId>/email/...` prefix and return the attachment metadata with the
 * stored object keys. Attachment bodies arrive base64-encoded on the
 * normalized envelope's `attachmentBodies` field (out-of-band from the schema
 * so the body cap stays on the text body); each is byte-capped before upload.
 * Upload failures degrade to `{ stored: false }` — the run still starts; the
 * operator sees the attachment was dropped.
 */
async function offloadEmailAttachments(args: {
  orgId: string;
  triggerEventId: string;
  attachments: Array<{ filename: string; contentType?: string; sizeBytes?: number }>;
  attachmentBodies: Record<string, string> | undefined;
}): Promise<Array<{ filename: string; contentType?: string; sizeBytes: number; stored: boolean; objectKey?: string }>> {
  const { orgId, triggerEventId, attachments, attachmentBodies } = args;
  const store = getObjectStore();
  const out: Array<{ filename: string; contentType?: string; sizeBytes: number; stored: boolean; objectKey?: string }> = [];
  for (let i = 0; i < attachments.length; i += 1) {
    const meta = attachments[i]!;
    const rawBase64 = attachmentBodies?.[meta.filename] ?? attachmentBodies?.[String(i)];
    if (typeof rawBase64 !== "string" || rawBase64.length === 0) {
      out.push({ filename: meta.filename, contentType: meta.contentType, sizeBytes: meta.sizeBytes ?? 0, stored: false });
      continue;
    }
    let body: Buffer;
    try {
      body = Buffer.from(rawBase64, "base64");
    } catch {
      out.push({ filename: meta.filename, contentType: meta.contentType, sizeBytes: 0, stored: false });
      continue;
    }
    // Per-attachment 1 MiB cap — oversized attachments are dropped, not stored.
    if (body.byteLength > EMAIL_BODY_MAX_BYTES) {
      out.push({ filename: meta.filename, contentType: meta.contentType, sizeBytes: body.byteLength, stored: false });
      continue;
    }
    // Sanitize the filename into the object key — the per-org prefix is the
    // tenant-isolation boundary; never let a `../` in the filename escape it.
    const safeName = meta.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200) || "attachment";
    const objectKey = `orgs/${orgId}/email/${triggerEventId}/${i}-${safeName}`;
    const result = await store.put({ key: objectKey, body, contentType: meta.contentType });
    out.push({
      filename: meta.filename,
      contentType: meta.contentType,
      sizeBytes: body.byteLength,
      stored: result.ok,
      objectKey: result.ok ? objectKey : undefined,
    });
  }
  return out;
}

/**
 * Cap on how many buffered events one resume replays. A long pause can buffer
 * more than a single resume should fire in one breath: dumping the whole
 * window back into the queue re-creates the flood the pause just stopped.
 * The remainder stays `buffered` and the caller reports it.
 */
export const TRIGGER_BACKFILL_MAX_PER_RESUME = 100;

/**
 * Replay the events a workflow buffered while paused, oldest first.
 *
 * Deliberately does NOT go through `persistEventAndSpawnRun`, for two reasons
 * a live backfill made obvious:
 *
 * 1. That path is guarded by the per-trigger INGEST rate limit — a storm
 *    guard against an upstream flooding us. A backfill is the opposite: it is
 *    operator-initiated, already capped, and replaying a storm that was
 *    already absorbed. Running it through the guard throttles the backfill
 *    into failure.
 * 2. That path RECORDS A NEW EVENT ROW (correct for `/replay`, where a replay
 *    is genuinely a new event). For a backfill the buffered row IS the event
 *    that is owed a run — cloning it doubles the table and leaves the original
 *    still owed.
 *
 * So this leases and transitions the existing row
 * `buffered -> backfilling -> started` against the CURRENT latest version:
 * the operator resumed because they fixed something, and the backfill should
 * run on the fix.
 *
 * Never throws: the workflow is already resumed by the time this runs, and a
 * backfill fault must not read as a failed resume. A per-event failure is
 * counted and the rest continue — one poisoned payload can't strand the
 * window behind it.
 */
export async function backfillBufferedTriggerEvents(args: {
  auth: AuthContext;
  workflowId: string;
  limit?: number;
}): Promise<{ backfilled: number; failed: number; remaining: number }> {
  const limit = Math.min(args.limit ?? TRIGGER_BACKFILL_MAX_PER_RESUME, TRIGGER_BACKFILL_MAX_PER_RESUME);
  let backfilled = 0;
  let failed = 0;
  try {
    const pending = await claimBufferedTriggerEvents(args.auth.orgId, args.workflowId, limit);
    for (const row of pending) {
      try {
        const event = await getTriggerEvent(args.auth.orgId, row.id);
        if (!event) {
          await releaseTriggerEventBackfillClaim(args.auth.orgId, row.id, row.claimToken).catch(() => {});
          continue;
        }

        const triggerType = event.triggerType as TriggerNodeType;
        const resolved = await resolveTriggerNode(args.auth.orgId, triggerType, () => true, {
          workflowId: args.workflowId,
          nodeId: event.nodeId,
        });
        if (!resolved) {
          // The trigger node is gone from the current version — the event can
          // never run again. Retire it so it stops counting as owed work.
          const retired = await retireTriggerEventBackfillClaim(
            args.auth.orgId,
            row.id,
            row.claimToken,
            "skipped",
            "backfill_no_trigger_node",
          );
          if (retired) failed += 1;
          continue;
        }

        const parsed = WorkflowSchema.safeParse(resolved.dagJson);
        if (!parsed.success) {
          const retired = await retireTriggerEventBackfillClaim(
            args.auth.orgId,
            row.id,
            row.claimToken,
            "failed",
            "workflow_parse_failed",
          );
          if (retired) failed += 1;
          continue;
        }

        const storedPayload = (event.payloadJson && typeof event.payloadJson === "object" && !Array.isArray(event.payloadJson)
          ? (event.payloadJson as { event?: Record<string, unknown> }).event
          : undefined) ?? {};

        const { runId } = await startRun({
          ...parsed.data,
          orgId: args.auth.orgId,
          versionId: resolved.workflowVersionId,
          createdBy: args.auth.userId,
          input: { triggeredBy: triggerType, triggerEventId: row.id, backfilled: true, event: storedPayload },
          triggerEventStart: { id: row.id, claimToken: row.claimToken },
        });
        await auditAction(args.auth, "trigger.event.started", {
          targetType: "trigger_event",
          targetId: row.id,
          metadata: { triggerType, runId, workflowId: args.workflowId, nodeId: resolved.nodeId, backfilled: true },
        });
        backfilled += 1;
      } catch {
        const released = await releaseTriggerEventBackfillClaim(args.auth.orgId, row.id, row.claimToken).catch(() => false);
        if (released) failed += 1;
      }
    }
    const remaining = await countBufferedTriggerEvents(args.auth.orgId, args.workflowId);
    return { backfilled, failed, remaining };
  } catch {
    return { backfilled, failed, remaining: 0 };
  }
}

export const triggerIngestRoutes: Route[] = [
  // ── email_received ────────────────────────────────────────────────────
  {
    method: "POST",
    match: "/triggers/email/ingest",
    role: "editor",
    permission: "triggers.ingest",
    handler: async ({ req, res, auth }) => {
      const raw = asRecord(await readJson(req, EMAIL_INGEST_MAX_JSON_BYTES));
      const parsed = EmailReceivedPayloadSchema.safeParse(raw);
      if (!parsed.success) {
        return sendError(res, "trigger_invalid_payload", parsed.error.issues[0]?.message ?? "Invalid email payload", 400);
      }
      const payload = parsed.data;

      // Body byte cap (1 MiB). The schema allows 2x chars as a guard; this is
      // the authoritative byte-length gate.
      if (utf8ByteLength(payload.body) > EMAIL_BODY_MAX_BYTES) {
        return sendError(res, "trigger_payload_too_large", "Email body exceeds 1 MiB cap", 413);
      }

      const resolved = await resolveTriggerNode(auth.orgId, "email_received", (config) => {
        return typeof config.aliasKey === "string" && config.aliasKey.trim().toLowerCase() === payload.aliasKey.trim().toLowerCase();
      });
      if (!resolved) {
        return sendError(res, "trigger_no_matching_node", "No email_received trigger matches this alias", 404);
      }

      // DKIM gate — the node opts INTO requiring DKIM (default true). An
      // unverified sender is rejected unless the operator opted out.
      const dkimRequired = resolved.nodeConfig.dkimRequired !== false;
      if (dkimRequired && !payload.dkimPass) {
        return sendError(res, "trigger_dkim_required", "Inbound email failed the DKIM check", 403);
      }

      // Optional sender-domain allow-list.
      const fromDomains = Array.isArray(resolved.nodeConfig.fromDomains)
        ? (resolved.nodeConfig.fromDomains as unknown[]).filter((d): d is string => typeof d === "string")
        : [];
      if (fromDomains.length > 0) {
        const senderDomain = payload.from.split("@").pop()?.toLowerCase() ?? "";
        if (!fromDomains.some((d) => d.toLowerCase() === senderDomain)) {
          return sendError(res, "trigger_dkim_required", "Sender domain is not in the allow-list", 403);
        }
      }

      // Idempotency pre-check BEFORE any object-store upload. A relay that
      // retries the same message (same `messageId` dedupe key) must NOT
      // re-upload its attachments — `recordTriggerEvent` would return the
      // original row and the freshly-uploaded objects would be orphaned. Skip
      // the upload entirely and report the duplicate. (NULL messageId never
      // dedupes, so it always uploads — there's nothing to converge on.)
      const emailDedupeKey = payload.messageId ? `email:${payload.messageId}` : null;
      const priorEmailEvent = await findTriggerEventByDedupeKey(auth.orgId, emailDedupeKey);
      if (priorEmailEvent) {
        if (priorEmailEvent.status === "received") {
          const result = await persistEventAndSpawnRun({
            auth,
            triggerType: "email_received",
            resolved,
            payload: {},
            dedupeKey: emailDedupeKey,
            existingEvent: priorEmailEvent,
          });
          return sendJson(res, result.body, result.status);
        }
        return sendJson(res, {
          ok: true,
          duplicate: true,
          triggerEventId: priorEmailEvent.id,
          runId: priorEmailEvent.runId ?? null,
        }, 200);
      }

      // Offload attachments to the object store BEFORE persisting the event,
      // so the persisted payload carries object keys (not the bodies). The
      // base64 bodies ride an out-of-band `attachmentBodies` field.
      const attachmentBodies = raw.attachmentBodies && typeof raw.attachmentBodies === "object" && !Array.isArray(raw.attachmentBodies)
        ? (raw.attachmentBodies as Record<string, string>)
        : undefined;
      const triggerEventId = emailDedupeKey
        ? `email-${createHash("sha256").update(`${auth.orgId}\0${emailDedupeKey}`).digest("hex").slice(0, 40)}`
        : crypto.randomUUID();
      const storedAttachments = await offloadEmailAttachments({
        orgId: auth.orgId,
        triggerEventId,
        attachments: payload.attachments,
        attachmentBodies,
      });

      const normalizedPayload: Record<string, unknown> = {
        aliasKey: payload.aliasKey,
        from: payload.from,
        to: payload.to,
        subject: payload.subject,
        body: payload.body,
        dkimPass: payload.dkimPass,
        messageId: payload.messageId,
        attachments: storedAttachments,
        receivedAt: payload.receivedAt ?? new Date().toISOString(),
      };

      const result = await persistEventAndSpawnRun({
        auth,
        triggerType: "email_received",
        resolved,
        payload: normalizedPayload,
        dedupeKey: emailDedupeKey,
        // Reuse the id used for the attachment object-store key prefix so the
        // persisted row and its attachments line up.
        eventId: triggerEventId,
      });
      return sendJson(res, result.body, result.status);
    },
  },

  // ── file_dropped ──────────────────────────────────────────────────────
  {
    method: "POST",
    match: "/triggers/file/ingest",
    role: "editor",
    permission: "triggers.ingest",
    handler: async ({ req, res, auth }) => {
      const raw = asRecord(await readJson(req, TRIGGER_INGEST_MAX_JSON_BYTES));
      const parsed = FileDroppedPayloadSchema.safeParse(raw);
      if (!parsed.success) {
        return sendError(res, "trigger_invalid_payload", parsed.error.issues[0]?.message ?? "Invalid file-dropped payload", 400);
      }
      const payload = parsed.data;

      if (utf8ByteLength(JSON.stringify(payload)) > FILE_METADATA_MAX_BYTES) {
        return sendError(res, "trigger_payload_too_large", "File event metadata exceeds the cap", 413);
      }

      const resolved = await resolveTriggerNode(auth.orgId, "file_dropped", (config) => {
        if (typeof config.bucket !== "string" || config.bucket !== payload.bucket) return false;
        const prefix = typeof config.prefix === "string" ? config.prefix : "";
        if (prefix && !payload.key.startsWith(prefix)) return false;
        const extensions = Array.isArray(config.extensions)
          ? (config.extensions as unknown[]).filter((e): e is string => typeof e === "string")
          : [];
        if (extensions.length > 0) {
          const ext = payload.key.split(".").pop()?.toLowerCase() ?? "";
          if (!extensions.some((e) => e.toLowerCase() === ext)) return false;
        }
        return true;
      });
      if (!resolved) {
        return sendError(res, "trigger_no_matching_node", "No file_dropped trigger matches this object", 404);
      }

      const result = await persistEventAndSpawnRun({
        auth,
        triggerType: "file_dropped",
        resolved,
        payload: {
          bucket: payload.bucket,
          key: payload.key,
          sizeBytes: payload.sizeBytes,
          contentType: payload.contentType,
          etag: payload.etag,
          eventName: payload.eventName,
          receivedAt: payload.receivedAt ?? new Date().toISOString(),
        },
        // Dedupe on (bucket, key, etag) so the same object-event retry
        // converges; etag changes per object version so re-uploads re-fire.
        dedupeKey: `file:${payload.bucket}:${payload.key}:${payload.etag ?? ""}`,
      });
      return sendJson(res, result.body, result.status);
    },
  },

  // ── mcp_server_event ──────────────────────────────────────────────────
  {
    method: "POST",
    match: "/triggers/mcp/ingest",
    role: "editor",
    permission: "triggers.ingest",
    handler: async ({ req, res, auth }) => {
      const raw = asRecord(await readJson(req, TRIGGER_INGEST_MAX_JSON_BYTES));
      const parsed = McpServerEventPayloadSchema.safeParse(raw);
      if (!parsed.success) {
        return sendError(res, "trigger_invalid_payload", parsed.error.issues[0]?.message ?? "Invalid MCP server-event payload", 400);
      }
      const payload = parsed.data;

      if (payload.payload && utf8ByteLength(JSON.stringify(payload.payload)) > MCP_EVENT_PAYLOAD_MAX_BYTES) {
        return sendError(res, "trigger_payload_too_large", "MCP resource payload exceeds the cap", 413);
      }

      const resolved = await resolveTriggerNode(auth.orgId, "mcp_server_event", (config) => {
        if (typeof config.connectionAlias !== "string" || config.connectionAlias !== payload.connectionAlias) return false;
        if (typeof config.resourceUri !== "string" || config.resourceUri !== payload.resourceUri) return false;
        const eventTypes = Array.isArray(config.eventTypes)
          ? (config.eventTypes as unknown[]).filter((e): e is string => typeof e === "string")
          : [];
        if (eventTypes.length > 0 && !eventTypes.includes(payload.eventType)) return false;
        return true;
      });
      if (!resolved) {
        return sendError(res, "trigger_no_matching_node", "No mcp_server_event trigger matches this notification", 404);
      }

      const result = await persistEventAndSpawnRun({
        auth,
        triggerType: "mcp_server_event",
        resolved,
        payload: {
          connectionAlias: payload.connectionAlias,
          resourceUri: payload.resourceUri,
          eventType: payload.eventType,
          payload: payload.payload ?? {},
          receivedAt: payload.receivedAt ?? new Date().toISOString(),
        },
        // No natural idempotency key for resource-changed notifications —
        // every notification spawns a run (the upstream is the de-dup point).
        dedupeKey: null,
      });
      return sendJson(res, result.body, result.status);
    },
  },

  // ── replay a persisted trigger event ──────────────────────────────────
  {
    method: "POST",
    match: (url) => /^\/triggers\/events\/[^/]+\/replay$/.test(url.split("?")[0] ?? ""),
    role: "editor",
    permission: "triggers.ingest",
    handler: async ({ req, res, auth }) => {
      const eventId = (req.url ?? "").split("?")[0]!.split("/")[3]!;
      const event = await getTriggerEvent(auth.orgId, eventId);
      if (!event) {
        return sendError(res, "trigger_event_not_found", "Trigger event not found", 404);
      }

      // Re-resolve the trigger node so a replay runs against the CURRENT
      // latest workflow version (the operator may have fixed the DAG since
      // the original failure). Match by the event's persisted node id /
      // version where possible; fall back to the type + stored payload.
      const storedPayload = (event.payloadJson && typeof event.payloadJson === "object" && !Array.isArray(event.payloadJson)
        ? (event.payloadJson as { event?: Record<string, unknown> }).event
        : undefined) ?? {};

      const triggerType = event.triggerType as TriggerNodeType;
      const resolved = await resolveTriggerNode(
        auth.orgId,
        triggerType,
        () => true,
        event.workflowId ? { workflowId: event.workflowId, nodeId: event.nodeId } : undefined,
      );
      if (!resolved) {
        return sendError(res, "trigger_no_matching_node", "No trigger node of this type exists to replay against", 404);
      }

      const result = await persistEventAndSpawnRun({
        auth,
        triggerType,
        resolved,
        payload: storedPayload as Record<string, unknown>,
        // Replays get a fresh dedupe key so they always spawn (the original
        // event already consumed the inbound dedupe key).
        dedupeKey: `replay:${event.id}:${Date.now()}`,
        replayOfEventId: event.id,
      });
      return sendJson(res, result.body, result.status);
    },
  },

  // ── recent inbound-trigger event feed ─────────────────────────────────
  {
    method: "GET",
    match: (url) => url === "/triggers/events" || url.startsWith("/triggers/events?"),
    role: "viewer",
    permission: "triggers.read",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const status = parseStatusFilter(url.searchParams.get("status"));
      const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit = Number.isFinite(rawLimit) ? rawLimit : undefined;
      const events = await listTriggerEvents(auth.orgId, { status, limit });
      return sendJson(res, { events });
    },
  },
];
