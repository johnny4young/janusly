/**
 * Route-level tests for the inbound-trigger ingestion seam.
 *
 * Covers the behavior that lives at the API layer:
 *   - config / payload validation (400 on bad payload),
 *   - payload size caps (413 when the email body exceeds 1 MiB),
 *   - per-trigger rate-limit storm guard (429 + event recorded `skipped`),
 *   - cross-org isolation (the resolver only sees the authenticated org;
 *     an event with no matching trigger in THAT org → 404),
 *   - run spawn on success (`started`),
 *   - replay correctness (`POST /triggers/events/:id/replay` re-runs the
 *     stored payload via the same resolve + spawn path).
 *
 * The DB-backed repo, `startRun`, the object store, the rate limiter, and
 * the audit helper are all mocked so the test exercises the route's control
 * flow without Postgres / Redis.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../auth", () => ({ requireAuth: vi.fn() }));
vi.mock("../permissions", () => ({ requireRole: vi.fn(), requirePermission: vi.fn() }));
vi.mock("../audit-helper", () => ({ auditAction: vi.fn(async () => undefined) }));
vi.mock("../rate-limit", () => ({ enforceRateLimit: vi.fn(async () => undefined) }));

vi.mock("@janusly/data", () => ({
  recordSystemAudit: vi.fn(async () => undefined),
  recordTriggerEvent: vi.fn(),
  findTriggerEventByDedupeKey: vi.fn(),
  resolveTriggerNode: vi.fn(),
  getTriggerEvent: vi.fn(),
  listTriggerEvents: vi.fn(),
  markTriggerEventSkipped: vi.fn(async () => undefined),
  markTriggerEventFailed: vi.fn(async () => undefined),
  markTriggerEventBuffered: vi.fn(async () => undefined),
  claimBufferedTriggerEvents: vi.fn(async () => []),
  releaseTriggerEventBackfillClaim: vi.fn(async () => true),
  retireTriggerEventBackfillClaim: vi.fn(async () => true),
  listBufferedTriggerEvents: vi.fn(async () => []),
  countBufferedTriggerEvents: vi.fn(async () => 0),
  getWorkflowStatus: vi.fn(async () => ({ status: "active", pausedReason: null })),
  resolveWorkflowPauseAction: (status: string | null | undefined, entryPoint: string) => {
    if (!status || status === "active") return { kind: "proceed" };
    if (entryPoint === "start") return { kind: "reject", code: status === "paused_circuit_breaker" ? "workflow_circuit_breaker_paused" : "upstream_degraded", status };
    if (entryPoint === "trigger") return { kind: "buffer", reason: status };
    return { kind: "drop", reason: status };
  },
  WORKFLOW_STATUS_ACTIVE: "active",
}));

vi.mock("@janusly/engine/src/start-run", () => ({
  startRun: vi.fn(),
  TriggerEventStartConflictError: class TriggerEventStartConflictError extends Error {},
}));
// Stable object-store `put` spy so a test can assert NO upload happens on a
// duplicate inbound email (the orphaned-attachment regression).
const objectStorePut = vi.hoisted(() => vi.fn(async (_input: { key: string; body: Buffer; contentType?: string }) => ({
  ok: true,
  provider: "noop",
  key: "k",
  url: "u",
})));
vi.mock("@janusly/engine/src/object-store", () => ({
  getObjectStore: vi.fn(() => ({ put: objectStorePut })),
}));

import { requireAuth } from "../auth";
import { auditAction } from "../audit-helper";
import { requireRole } from "../permissions";
import { enforceRateLimit } from "../rate-limit";
import {
  findTriggerEventByDedupeKey,
  claimBufferedTriggerEvents,
  getTriggerEvent,
  markTriggerEventBuffered,
  markTriggerEventFailed,
  markTriggerEventSkipped,
  countBufferedTriggerEvents,
  getWorkflowStatus,
  listTriggerEvents,
  recordTriggerEvent,
  releaseTriggerEventBackfillClaim,
  retireTriggerEventBackfillClaim,
  resolveTriggerNode,
} from "@janusly/data";
import { startRun, TriggerEventStartConflictError } from "@janusly/engine/src/start-run";
import { createApiServer } from "../server";
import { backfillBufferedTriggerEvents, TRIGGER_BACKFILL_MAX_PER_RESUME, triggerIngestRoutes } from "./trigger-ingest-routes";

const requireAuthMock = vi.mocked(requireAuth);
const auditActionMock = vi.mocked(auditAction);
const requireRoleMock = vi.mocked(requireRole);
const enforceRateLimitMock = vi.mocked(enforceRateLimit);
const recordTriggerEventMock = vi.mocked(recordTriggerEvent);
const findByDedupeMock = vi.mocked(findTriggerEventByDedupeKey);
const resolveTriggerNodeMock = vi.mocked(resolveTriggerNode);
const getTriggerEventMock = vi.mocked(getTriggerEvent);
const markSkippedMock = vi.mocked(markTriggerEventSkipped);
const markFailedMock = vi.mocked(markTriggerEventFailed);
const markBufferedMock = vi.mocked(markTriggerEventBuffered);
const claimBufferedMock = vi.mocked(claimBufferedTriggerEvents);
const releaseBackfillClaimMock = vi.mocked(releaseTriggerEventBackfillClaim);
const retireBackfillClaimMock = vi.mocked(retireTriggerEventBackfillClaim);
const listTriggerEventsMock = vi.mocked(listTriggerEvents);
const countBufferedMock = vi.mocked(countBufferedTriggerEvents);
const getWorkflowStatusMock = vi.mocked(getWorkflowStatus);
const startRunMock = vi.mocked(startRun);

const SIMPLE_DAG = {
  dslVersion: "1.0" as const,
  nodes: [{ id: "inbox", type: "email_received", config: { aliasKey: "ops" } }],
  edges: [],
};

function resolvedFor(orgConfig: Record<string, unknown> = { aliasKey: "ops" }) {
  return {
    workflowId: "wf-1",
    workflowVersionId: "ver-1",
    nodeId: "inbox",
    nodeConfig: orgConfig,
    dagJson: SIMPLE_DAG,
  };
}

function claimedFor(id = "evt-1") {
  return {
    id,
    workflowVersionId: "ver-1",
    nodeId: "inbox",
    triggerType: "email_received",
    claimToken: `claim-${id}`,
  };
}

async function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

async function close(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

function authAsEditor(orgId = "org-a") {
  requireAuthMock.mockResolvedValue({ orgId, userId: "user-1", mode: "service-token", source: "service" });
  requireRoleMock.mockResolvedValue("editor");
}

beforeEach(() => {
  authAsEditor();
  // Default: no prior event for the dedupe key (fresh inbound), so the email
  // path proceeds to upload + record.
  findByDedupeMock.mockResolvedValue(null);
  // Default: a fresh event is recorded.
  recordTriggerEventMock.mockResolvedValue({ event: { id: "evt-1", orgId: "org-a", runId: null } as never, wasCreated: true });
  // `startRun`'s return type pins `runId` to a UUID template literal; the test
  // value is a readable placeholder, so cast through `unknown`.
  startRunMock.mockResolvedValue({ runId: "run-1" } as unknown as Awaited<ReturnType<typeof startRun>>);
});

afterEach(() => {
  vi.clearAllMocks();
});

async function postEmail(baseUrl: string, body: unknown) {
  return fetch(`${baseUrl}/triggers/email/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("route declarations", () => {
  it("the three ingest routes declare editor + triggers.ingest", () => {
    for (const path of ["/triggers/email/ingest", "/triggers/file/ingest", "/triggers/mcp/ingest"]) {
      const route = triggerIngestRoutes.find((r) => (typeof r.match === "string" ? r.match === path : r.match(path)) && r.method === "POST");
      expect(route?.role).toBe("editor");
      expect(route?.permission).toBe("triggers.ingest");
    }
  });

  it("the event feed declares viewer + triggers.read", () => {
    const route = triggerIngestRoutes.find((r) => r.method === "GET" && (typeof r.match !== "string" && r.match("/triggers/events")));
    expect(route?.role).toBe("viewer");
    expect(route?.permission).toBe("triggers.read");
  });

  it("passes the buffered status to the event feed", async () => {
    listTriggerEventsMock.mockResolvedValue([]);
    const server = createApiServer({ routes: triggerIngestRoutes });
    const baseUrl = await listen(server);
    try {
      const res = await fetch(`${baseUrl}/triggers/events?status=buffered`);
      expect(res.status).toBe(200);
      expect(listTriggerEventsMock).toHaveBeenCalledWith("org-a", expect.objectContaining({ status: "buffered" }));
    } finally {
      await close(server);
    }
  });
});

describe("email_received ingestion", () => {
  it("rejects a malformed payload with 400 (no run spawned)", async () => {
    const server = createApiServer({ routes: triggerIngestRoutes });
    const baseUrl = await listen(server);
    try {
      const res = await postEmail(baseUrl, { subject: "no alias or from" });
      expect(res.status).toBe(400);
      expect(startRunMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("rejects an oversized body with 413 (size cap)", async () => {
    resolveTriggerNodeMock.mockResolvedValue(resolvedFor());
    const server = createApiServer({ routes: triggerIngestRoutes });
    const baseUrl = await listen(server);
    try {
      // 1 MiB + 1 byte of ASCII body.
      const res = await postEmail(baseUrl, { aliasKey: "ops", from: "a@b.com", dkimPass: true, body: "a".repeat(1_048_577) });
      expect(res.status).toBe(413);
      expect(startRunMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("returns 404 when no trigger node in the authenticated org matches the alias (cross-org isolation)", async () => {
    resolveTriggerNodeMock.mockResolvedValue(null);
    const server = createApiServer({ routes: triggerIngestRoutes });
    const baseUrl = await listen(server);
    try {
      const res = await postEmail(baseUrl, { aliasKey: "other-org-alias", from: "a@b.com", dkimPass: true, body: "hi" });
      expect(res.status).toBe(404);
      const payload = await res.json() as { code: string };
      expect(payload.code).toBe("trigger_no_matching_node");
      // The resolver was called scoped to the authenticated org only.
      expect(resolveTriggerNodeMock).toHaveBeenCalledWith("org-a", "email_received", expect.any(Function));
      expect(startRunMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("rejects a non-DKIM message when the node requires DKIM (403)", async () => {
    resolveTriggerNodeMock.mockResolvedValue(resolvedFor({ aliasKey: "ops", dkimRequired: true }));
    const server = createApiServer({ routes: triggerIngestRoutes });
    const baseUrl = await listen(server);
    try {
      const res = await postEmail(baseUrl, { aliasKey: "ops", from: "a@b.com", dkimPass: false, body: "hi" });
      expect(res.status).toBe(403);
      expect(startRunMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("spawns a run and consumes the event in the same transaction", async () => {
    resolveTriggerNodeMock.mockResolvedValue(resolvedFor());
    const server = createApiServer({ routes: triggerIngestRoutes });
    const baseUrl = await listen(server);
    try {
      const res = await postEmail(baseUrl, { aliasKey: "ops", from: "a@b.com", subject: "hi", dkimPass: true, body: "hello", messageId: "msg-123" });
      expect(res.status).toBe(200);
      const payload = await res.json() as { ok: boolean; runId: string; triggerEventId: string };
      expect(payload.ok).toBe(true);
      expect(payload.runId).toBe("run-1");
      // Structured event persisted BEFORE the run, with the inbound message-id as the dedupe key.
      expect(recordTriggerEventMock).toHaveBeenCalledWith(expect.objectContaining({
        orgId: "org-a",
        triggerType: "email_received",
        dedupeKey: "email:msg-123",
      }));
      // Run spawned scoped to the authenticated org, carrying the normalized event.
      expect(startRunMock).toHaveBeenCalledWith(expect.objectContaining({
        orgId: "org-a",
        versionId: "ver-1",
        triggerEventStart: { id: "evt-1" },
      }));
      const startArg = startRunMock.mock.calls[0]![0] as { input: { event: { from: string } } };
      expect(startArg.input.event.from).toBe("a@b.com");
    } finally {
      await close(server);
    }
  });

  it("uses one deterministic attachment namespace for concurrent retries", async () => {
    resolveTriggerNodeMock.mockResolvedValue(resolvedFor());
    const server = createApiServer({ routes: triggerIngestRoutes });
    const baseUrl = await listen(server);
    const body = {
      aliasKey: "ops",
      from: "a@b.com",
      dkimPass: true,
      body: "hi",
      messageId: "msg-attachments",
      attachments: [{ filename: "report.pdf", contentType: "application/pdf", sizeBytes: 4 }],
      attachmentBodies: { "report.pdf": Buffer.from("test").toString("base64") },
    };
    try {
      const [first, second] = await Promise.all([postEmail(baseUrl, body), postEmail(baseUrl, body)]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const eventIds = recordTriggerEventMock.mock.calls.map(([input]) => input.id);
      expect(eventIds).toHaveLength(2);
      expect(eventIds[0]).toMatch(/^email-[a-f0-9]{40}$/);
      expect(eventIds[1]).toBe(eventIds[0]);
      const objectKeys = objectStorePut.mock.calls.map(([input]) => input.key);
      expect(objectKeys).toHaveLength(2);
      expect(objectKeys[1]).toBe(objectKeys[0]);
    } finally {
      await close(server);
    }
  });

  it("short-circuits a duplicate inbound event without spawning a second run (idempotency)", async () => {
    resolveTriggerNodeMock.mockResolvedValue(resolvedFor());
    recordTriggerEventMock.mockResolvedValue({
      event: { id: "evt-1", orgId: "org-a", status: "started", runId: "run-prior" } as never,
      wasCreated: false,
    });
    const server = createApiServer({ routes: triggerIngestRoutes });
    const baseUrl = await listen(server);
    try {
      const res = await postEmail(baseUrl, { aliasKey: "ops", from: "a@b.com", dkimPass: true, body: "hi", messageId: "msg-dup" });
      expect(res.status).toBe(200);
      const payload = await res.json() as { duplicate: boolean; runId: string };
      expect(payload.duplicate).toBe(true);
      expect(payload.runId).toBe("run-prior");
      expect(startRunMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("resumes a previously persisted received event after an interrupted attempt", async () => {
    resolveTriggerNodeMock.mockResolvedValue(resolvedFor());
    findByDedupeMock.mockResolvedValue({
      id: "evt-1",
      orgId: "org-a",
      workflowId: "wf-1",
      workflowVersionId: "ver-1",
      nodeId: "inbox",
      triggerType: "email_received",
      status: "received",
      runId: null,
      payloadJson: { event: { from: "original@sender.com", body: "original" } },
    } as never);
    const server = createApiServer({ routes: triggerIngestRoutes });
    const baseUrl = await listen(server);
    try {
      const res = await postEmail(baseUrl, {
        aliasKey: "ops",
        from: "a@b.com",
        dkimPass: true,
        body: "hi",
        messageId: "msg-interrupted",
      });

      expect(res.status).toBe(200);
      expect(startRunMock).toHaveBeenCalledWith(expect.objectContaining({
        triggerEventStart: { id: "evt-1" },
        input: expect.objectContaining({
          event: expect.objectContaining({ from: "original@sender.com" }),
        }),
      }));
      expect(recordTriggerEventMock).not.toHaveBeenCalled();
      expect(objectStorePut).not.toHaveBeenCalled();
      expect(auditActionMock).not.toHaveBeenCalledWith(
        expect.anything(),
        "trigger.event.received",
        expect.anything(),
      );
    } finally {
      await close(server);
    }
  });

  it("returns the winning run when another request consumes the event concurrently", async () => {
    resolveTriggerNodeMock.mockResolvedValue(resolvedFor());
    getTriggerEventMock.mockResolvedValue({
      id: "evt-1",
      orgId: "org-a",
      status: "started",
      runId: "run-winner",
    } as never);
    startRunMock.mockRejectedValueOnce(new TriggerEventStartConflictError());
    const server = createApiServer({ routes: triggerIngestRoutes });
    const baseUrl = await listen(server);
    try {
      const res = await postEmail(baseUrl, {
        aliasKey: "ops",
        from: "a@b.com",
        dkimPass: true,
        body: "hi",
        messageId: "msg-concurrent",
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        ok: true,
        duplicate: true,
        triggerEventId: "evt-1",
        runId: "run-winner",
      });
    } finally {
      await close(server);
    }
  });

  it("keeps a received event retryable after a transient run-start failure", async () => {
    resolveTriggerNodeMock.mockResolvedValue(resolvedFor());
    startRunMock.mockRejectedValueOnce(new Error("database unavailable"));
    const server = createApiServer({ routes: triggerIngestRoutes });
    const baseUrl = await listen(server);
    try {
      const res = await postEmail(baseUrl, {
        aliasKey: "ops",
        from: "a@b.com",
        dkimPass: true,
        body: "hi",
        messageId: "msg-transient",
      });

      expect(res.status).toBe(500);
      expect(markFailedMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("skips the attachment upload entirely when the dedupe key already has an event (no orphaned objects)", async () => {
    resolveTriggerNodeMock.mockResolvedValue(resolvedFor());
    // A relay retry: the messageId already produced an event row earlier.
    findByDedupeMock.mockResolvedValue({ id: "evt-prior", orgId: "org-a", runId: "run-prior" } as never);
    const server = createApiServer({ routes: triggerIngestRoutes });
    const baseUrl = await listen(server);
    try {
      const res = await postEmail(baseUrl, {
        aliasKey: "ops",
        from: "a@b.com",
        dkimPass: true,
        body: "hi",
        messageId: "msg-dup",
        attachments: [{ filename: "report.pdf", contentType: "application/pdf", sizeBytes: 4 }],
        attachmentBodies: { "report.pdf": Buffer.from("test").toString("base64") },
      });
      expect(res.status).toBe(200);
      const payload = await res.json() as { duplicate: boolean; triggerEventId: string; runId: string };
      expect(payload.duplicate).toBe(true);
      expect(payload.triggerEventId).toBe("evt-prior");
      // The regression: NO object-store upload and NO second event row.
      expect(objectStorePut).not.toHaveBeenCalled();
      expect(recordTriggerEventMock).not.toHaveBeenCalled();
      expect(startRunMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("records the event skipped and returns 429 when the storm guard trips", async () => {
    resolveTriggerNodeMock.mockResolvedValue(resolvedFor());
    const rate429 = Object.assign(new Error("Rate limit exceeded"), { statusCode: 429 });
    enforceRateLimitMock.mockRejectedValueOnce(rate429);
    const server = createApiServer({ routes: triggerIngestRoutes });
    const baseUrl = await listen(server);
    try {
      const res = await postEmail(baseUrl, { aliasKey: "ops", from: "a@b.com", dkimPass: true, body: "hi" });
      expect(res.status).toBe(429);
      const payload = await res.json() as { skipped: boolean; reason: string };
      expect(payload.skipped).toBe(true);
      expect(payload.reason).toBe("rate_limited");
      expect(markSkippedMock).toHaveBeenCalledWith("org-a", "evt-1", "rate_limited");
      // The event row was persisted, but no run spawned.
      expect(recordTriggerEventMock).toHaveBeenCalled();
      expect(startRunMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });
});

describe("trigger event replay", () => {
  it("re-runs the stored payload against the current latest version (replay correctness)", async () => {
    getTriggerEventMock.mockResolvedValue({
      id: "evt-old",
      orgId: "org-a",
      workflowId: "wf-1",
      nodeId: "inbox",
      triggerType: "email_received",
      runId: "run-old",
      payloadJson: { event: { from: "alice@partner.com", subject: "Invoice", body: "pay me" } },
    } as never);
    resolveTriggerNodeMock.mockResolvedValue(resolvedFor());

    const server = createApiServer({ routes: triggerIngestRoutes });
    const baseUrl = await listen(server);
    try {
      const res = await fetch(`${baseUrl}/triggers/events/evt-old/replay`, { method: "POST" });
      expect(res.status).toBe(200);
      const payload = await res.json() as { ok: boolean; runId: string };
      expect(payload.ok).toBe(true);
      expect(payload.runId).toBe("run-1");
      // The replay spawned a run with the STORED event payload.
      const startArg = startRunMock.mock.calls[0]![0] as { input: { event: { from: string } } };
      expect(startArg.input.event.from).toBe("alice@partner.com");
      // Replay gets a fresh dedupe key (the original consumed the inbound key).
      expect(recordTriggerEventMock).toHaveBeenCalledWith(expect.objectContaining({
        dedupeKey: expect.stringContaining("replay:evt-old"),
      }));
      expect(resolveTriggerNodeMock).toHaveBeenCalledWith(
        "org-a",
        "email_received",
        expect.any(Function),
        { workflowId: "wf-1", nodeId: "inbox" },
      );
    } finally {
      await close(server);
    }
  });

  it("returns 404 when the trigger event does not exist for this org", async () => {
    getTriggerEventMock.mockResolvedValue(null);
    const server = createApiServer({ routes: triggerIngestRoutes });
    const baseUrl = await listen(server);
    try {
      const res = await fetch(`${baseUrl}/triggers/events/missing/replay`, { method: "POST" });
      expect(res.status).toBe(404);
      const payload = await res.json() as { code: string };
      expect(payload.code).toBe("trigger_event_not_found");
      expect(startRunMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });
});

describe("pause gate — a paused workflow must not spawn runs from ANY entry point", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = createApiServer({ routes: triggerIngestRoutes });
    baseUrl = await listen(server);
    resolveTriggerNodeMock.mockResolvedValue(resolvedFor() as never);
  });
  afterEach(async () => { await close(server); });

  const inbound = { aliasKey: "ops", from: "a@b.com", subject: "Invoice", body: "hi", dkimPass: true };

  it("buffers the event instead of running it, and never spawns", async () => {
    // The flood that trips a breaker is webhooks and crons, not someone
    // clicking Run — a pause `/start` alone respects is not a pause.
    getWorkflowStatusMock.mockResolvedValue({ status: "paused_circuit_breaker", pausedReason: "5 consecutive" } as never);

    const res = await postEmail(baseUrl, inbound);

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true, buffered: true, reason: "paused_circuit_breaker" });
    expect(startRunMock).not.toHaveBeenCalled();
    expect(markBufferedMock).toHaveBeenCalledWith("org-a", "evt-1", "paused_circuit_breaker");
  });

  it("buffers an upstream-outage pause too — the gate is about the status, not its source", async () => {
    getWorkflowStatusMock.mockResolvedValue({ status: "paused_upstream_degraded", pausedReason: "stripe" } as never);

    const res = await postEmail(baseUrl, inbound);

    expect(res.status).toBe(202);
    expect(startRunMock).not.toHaveBeenCalled();
  });

  it("does NOT mark it skipped — a buffered event is still owed a run", async () => {
    // `skipped` means deliberately discarded (deduped, rate-limited).
    // Conflating the two would make backfill silently lose the window.
    getWorkflowStatusMock.mockResolvedValue({ status: "paused_circuit_breaker", pausedReason: null } as never);

    await postEmail(baseUrl, inbound);

    expect(markSkippedMock).not.toHaveBeenCalled();
  });

  it("runs normally when the workflow is active", async () => {
    getWorkflowStatusMock.mockResolvedValue({ status: "active", pausedReason: null } as never);

    const res = await postEmail(baseUrl, inbound);

    expect(res.status).toBe(200);
    expect(startRunMock).toHaveBeenCalledTimes(1);
    expect(markBufferedMock).not.toHaveBeenCalled();
  });

  it("runs when the workflow row is missing rather than stranding the event", async () => {
    // An unresolvable status is not evidence of a pause; failing closed here
    // would silently buffer every event for an org whose row read hiccuped.
    getWorkflowStatusMock.mockResolvedValue(null as never);

    const res = await postEmail(baseUrl, inbound);

    expect(res.status).toBe(200);
    expect(startRunMock).toHaveBeenCalledTimes(1);
  });
});

describe("backfillBufferedTriggerEvents — the pause must not eat the events", () => {
  const auth = { orgId: "org-a", userId: "user-1", mode: "service-token", source: "service" } as never;

  beforeEach(() => {
    resolveTriggerNodeMock.mockResolvedValue(resolvedFor() as never);
    getWorkflowStatusMock.mockResolvedValue({ status: "active", pausedReason: null } as never);
    getTriggerEventMock.mockResolvedValue({
      id: "evt-1", orgId: "org-a", workflowId: "wf-1", nodeId: "inbox", triggerType: "email_received",
      payloadJson: { event: { aliasKey: "ops", from: "a@b.com", dkimPass: true } }, runId: null,
    } as never);
  });

  it("transitions the buffered row to started instead of cloning it into a new event", async () => {
    // Cloning (what reusing the ingest path did) doubles the table AND leaves
    // the original still owed a run — the backfill silently never converges.
    claimBufferedMock.mockResolvedValue([claimedFor()] as never);
    countBufferedMock.mockResolvedValue(0);

    await backfillBufferedTriggerEvents({ auth, workflowId: "wf-1" });

    expect(startRunMock).toHaveBeenCalledWith(expect.objectContaining({
      triggerEventStart: { id: "evt-1", claimToken: "claim-evt-1" },
    }));
    expect(recordTriggerEventMock).not.toHaveBeenCalled();
    expect(resolveTriggerNodeMock).toHaveBeenCalledWith(
      "org-a",
      "email_received",
      expect.any(Function),
      { workflowId: "wf-1", nodeId: "inbox" },
    );
  });

  it("is not throttled by the INGEST storm guard — the storm it replays was already absorbed", async () => {
    // Live regression: routing the backfill through the ingest path put it
    // behind the per-trigger rate limit, so a 100-event backfill reported
    // `backfilled: 0, failed: 100` and left every row still buffered.
    claimBufferedMock.mockResolvedValue(
      Array.from({ length: 40 }, (_, i) => claimedFor(`evt-${i}`)) as never,
    );
    countBufferedMock.mockResolvedValue(0);

    const result = await backfillBufferedTriggerEvents({ auth, workflowId: "wf-1" });

    expect(enforceRateLimitMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ backfilled: 40, failed: 0 });
  });

  it("replays the buffered window oldest-first", async () => {
    claimBufferedMock.mockResolvedValue([claimedFor("evt-1"), claimedFor("evt-2")] as never);
    countBufferedMock.mockResolvedValue(0);

    const result = await backfillBufferedTriggerEvents({ auth, workflowId: "wf-1" });

    expect(result).toMatchObject({ backfilled: 2, failed: 0, remaining: 0 });
    expect(startRunMock).toHaveBeenCalledTimes(2);
    // Oldest first: the payloads are a causal sequence — replaying "order
    // updated" before "order created" inverts the upstream's story.
    expect(claimBufferedMock).toHaveBeenCalledWith("org-a", "wf-1", TRIGGER_BACKFILL_MAX_PER_RESUME);
  });

  it("reports what it could not replay in one breath, instead of dumping the whole window", async () => {
    // Firing an unbounded backlog at resume re-creates the flood the pause
    // just stopped. The remainder stays buffered and is reported.
    claimBufferedMock.mockResolvedValue([claimedFor()] as never);
    countBufferedMock.mockResolvedValue(37);

    const result = await backfillBufferedTriggerEvents({ auth, workflowId: "wf-1" });

    expect(result).toMatchObject({ backfilled: 1, remaining: 37 });
  });

  it("caps the window it asks for, even when the caller asks for more", async () => {
    claimBufferedMock.mockResolvedValue([] as never);
    countBufferedMock.mockResolvedValue(0);

    await backfillBufferedTriggerEvents({ auth, workflowId: "wf-1", limit: 10_000 });

    expect(claimBufferedMock).toHaveBeenCalledWith("org-a", "wf-1", TRIGGER_BACKFILL_MAX_PER_RESUME);
  });

  it("one poisoned payload cannot strand the events behind it", async () => {
    claimBufferedMock.mockResolvedValue([claimedFor("evt-1"), claimedFor("evt-2")] as never);
    countBufferedMock.mockResolvedValue(0);
    getTriggerEventMock.mockRejectedValueOnce(new Error("row read exploded"));

    const result = await backfillBufferedTriggerEvents({ auth, workflowId: "wf-1" });

    expect(result).toMatchObject({ backfilled: 1, failed: 1 });
    expect(releaseBackfillClaimMock).toHaveBeenCalledWith("org-a", "evt-1", "claim-evt-1");
  });

  it("retires an event whose trigger node the fix deleted, instead of owing it forever", async () => {
    claimBufferedMock.mockResolvedValue([claimedFor()] as never);
    countBufferedMock.mockResolvedValue(0);
    resolveTriggerNodeMock.mockResolvedValue(null as never);

    const result = await backfillBufferedTriggerEvents({ auth, workflowId: "wf-1" });

    expect(result).toMatchObject({ backfilled: 0, failed: 1 });
    expect(retireBackfillClaimMock).toHaveBeenCalledWith(
      "org-a",
      "evt-1",
      "claim-evt-1",
      "skipped",
      "backfill_no_trigger_node",
    );
    expect(markSkippedMock).not.toHaveBeenCalled();
    expect(startRunMock).not.toHaveBeenCalled();
  });

  it("does not report a stale worker as failed after its lease was replaced", async () => {
    claimBufferedMock.mockResolvedValue([claimedFor()] as never);
    countBufferedMock.mockResolvedValue(0);
    getTriggerEventMock.mockRejectedValueOnce(new Error("slow stale worker"));
    releaseBackfillClaimMock.mockResolvedValueOnce(false);

    const result = await backfillBufferedTriggerEvents({ auth, workflowId: "wf-1" });

    expect(result).toMatchObject({ backfilled: 0, failed: 0 });
  });

  it("never throws — a backfill fault must not read as a failed resume", async () => {
    claimBufferedMock.mockRejectedValue(new Error("db down"));

    await expect(backfillBufferedTriggerEvents({ auth, workflowId: "wf-1" })).resolves
      .toMatchObject({ backfilled: 0, remaining: 0 });
  });

  it("does nothing when the pause buffered nothing", async () => {
    claimBufferedMock.mockResolvedValue([] as never);
    countBufferedMock.mockResolvedValue(0);

    const result = await backfillBufferedTriggerEvents({ auth, workflowId: "wf-1" });

    expect(result).toMatchObject({ backfilled: 0, failed: 0, remaining: 0 });
    expect(startRunMock).not.toHaveBeenCalled();
  });
});
