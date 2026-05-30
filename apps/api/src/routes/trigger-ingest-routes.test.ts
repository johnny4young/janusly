/**
 * Route-level tests for the inbound-trigger ingestion seam.
 *
 * Covers the AC slices that live at the API layer:
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
  recordTriggerEvent: vi.fn(),
  findTriggerEventByDedupeKey: vi.fn(),
  resolveTriggerNode: vi.fn(),
  getTriggerEvent: vi.fn(),
  listTriggerEvents: vi.fn(),
  markTriggerEventStarted: vi.fn(async () => undefined),
  markTriggerEventSkipped: vi.fn(async () => undefined),
  markTriggerEventFailed: vi.fn(async () => undefined),
}));

vi.mock("@janusly/engine/src/start-run", () => ({ startRun: vi.fn() }));
// Stable object-store `put` spy so a test can assert NO upload happens on a
// duplicate inbound email (the orphaned-attachment regression).
const objectStorePut = vi.hoisted(() => vi.fn(async () => ({ ok: true, provider: "noop", key: "k", url: "u" })));
vi.mock("@janusly/engine/src/object-store", () => ({
  getObjectStore: vi.fn(() => ({ put: objectStorePut })),
}));

import { requireAuth } from "../auth";
import { requireRole } from "../permissions";
import { enforceRateLimit } from "../rate-limit";
import {
  findTriggerEventByDedupeKey,
  getTriggerEvent,
  markTriggerEventSkipped,
  markTriggerEventStarted,
  recordTriggerEvent,
  resolveTriggerNode,
} from "@janusly/data";
import { startRun } from "@janusly/engine/src/start-run";
import { createApiServer } from "../server";
import { triggerIngestRoutes } from "./trigger-ingest-routes";

const requireAuthMock = vi.mocked(requireAuth);
const requireRoleMock = vi.mocked(requireRole);
const enforceRateLimitMock = vi.mocked(enforceRateLimit);
const recordTriggerEventMock = vi.mocked(recordTriggerEvent);
const findByDedupeMock = vi.mocked(findTriggerEventByDedupeKey);
const resolveTriggerNodeMock = vi.mocked(resolveTriggerNode);
const getTriggerEventMock = vi.mocked(getTriggerEvent);
const markSkippedMock = vi.mocked(markTriggerEventSkipped);
const markStartedMock = vi.mocked(markTriggerEventStarted);
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

  it("spawns a run and marks the event started on a valid DKIM-passing message", async () => {
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
        dedupeKey: "msg-123",
      }));
      // Run spawned scoped to the authenticated org, carrying the normalized event.
      expect(startRunMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-a", versionId: "ver-1" }));
      const startArg = startRunMock.mock.calls[0]![0] as { input: { event: { from: string } } };
      expect(startArg.input.event.from).toBe("a@b.com");
      expect(markStartedMock).toHaveBeenCalledWith("org-a", "evt-1", "run-1");
    } finally {
      await close(server);
    }
  });

  it("short-circuits a duplicate inbound event without spawning a second run (idempotency)", async () => {
    resolveTriggerNodeMock.mockResolvedValue(resolvedFor());
    recordTriggerEventMock.mockResolvedValue({ event: { id: "evt-1", orgId: "org-a", runId: "run-prior" } as never, wasCreated: false });
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
