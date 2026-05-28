/**
 * Tests for the recovery-feedback memory-write side. The route's primary
 * `recordRecoveryFeedback` + audit path is exercised by the existing
 * e2e seed flow; this suite pins the NEW behavior: when an operator
 * accepts a recovery suggestion on a memory-enabled org, the route
 * commits `recovery_rationale` (always) and optionally `patch_rationale`
 * (when the body carries `rationale`) — and when memory is OFF, the
 * route behavior is byte-for-byte identical to before (no commitMemory
 * call, no `usage_events` pollution, no audit row).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@janusly/data/src/memoryEntriesRepo", () => ({
  commitMemory: vi.fn(),
}));

vi.mock("@janusly/data/src/memoryConsent", () => ({
  isMemoryAllowed: vi.fn(),
}));

vi.mock("@janusly/data/src/recoveryFeedbackRepo", () => ({
  recordRecoveryFeedback: vi.fn(),
}));

vi.mock("@janusly/data/src/recoveryMetricsRepo", () => ({
  queryRecoveryMetricsSignals: vi.fn(),
}));

vi.mock("@janusly/engine/src/recovery-metrics", () => ({
  composeRecoveryMetrics: vi.fn(),
}));

vi.mock("../dlq", () => ({
  getDeadLetter: vi.fn(),
}));

vi.mock("../audit", () => ({
  audit: vi.fn(),
}));

vi.mock("../rate-limit", () => ({
  enforceRateLimit: vi.fn(),
}));

vi.mock("../http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http")>();
  return {
    ...actual,
    readJson: vi.fn(),
    sendJson: vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status })),
  };
});

import { commitMemory } from "@janusly/data/src/memoryEntriesRepo";
import { isMemoryAllowed } from "@janusly/data/src/memoryConsent";
import { recordRecoveryFeedback } from "@janusly/data/src/recoveryFeedbackRepo";

import {
  composePatchRationaleContent,
  composeRecoveryRationaleContent,
} from "../ai-patch-feedback";
import { audit } from "../audit";
import { getDeadLetter } from "../dlq";
import { readJson, sendJson } from "../http";
import { enforceRateLimit } from "../rate-limit";
import type { Route } from "../routes";
import { recoveryRoutes } from "./recovery-routes";

const commitMemoryMock = vi.mocked(commitMemory);
const isMemoryAllowedMock = vi.mocked(isMemoryAllowed);
const recordRecoveryFeedbackMock = vi.mocked(recordRecoveryFeedback);
const getDeadLetterMock = vi.mocked(getDeadLetter);
const auditMock = vi.mocked(audit);
const enforceRateLimitMock = vi.mocked(enforceRateLimit);
const readJsonMock = vi.mocked(readJson);
const sendJsonMock = vi.mocked(sendJson);

const auth = {
  orgId: "org-1",
  userId: "user-1",
  mode: "dev-headers",
  source: "dev",
} as const;

const dlqRow = {
  id: "dlq-1",
  orgId: "org-1",
  runId: "run-1",
  nodeId: "fetch-billing",
  errorJson: { message: "HTTP 401 unauthorized" },
  workflowJson: { id: "wf-billing", nodes: [], edges: [] },
  nodeJson: { id: "fetch-billing", type: "http" },
  createdAt: new Date("2026-05-01"),
  status: "open",
} as const;

function findFeedbackRoute(): Route {
  const route = recoveryRoutes.find((candidate) => {
    if (candidate.method !== "POST") return false;
    return typeof candidate.match === "string"
      ? candidate.match === "/recovery/feedback"
      : candidate.match("/recovery/feedback");
  });
  if (!route) throw new Error("route not found: POST /recovery/feedback");
  return route;
}

async function callFeedback(body: Record<string, unknown>) {
  readJsonMock.mockResolvedValueOnce(body);
  const route = findFeedbackRoute();
  return route.handler({
    req: { url: "/recovery/feedback" } as never,
    res: {} as never,
    auth: auth as never,
  });
}

async function flushMicrotasks() {
  // The route's `void Promise.allSettled([...])` runs commits async on
  // the event loop after the response. Two ticks lets the settled
  // promises resolve and the mock recorders capture the calls.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  commitMemoryMock.mockReset();
  isMemoryAllowedMock.mockReset();
  recordRecoveryFeedbackMock.mockReset();
  getDeadLetterMock.mockReset();
  auditMock.mockReset();
  enforceRateLimitMock.mockReset();
  readJsonMock.mockReset();
  sendJsonMock.mockClear();
  enforceRateLimitMock.mockResolvedValue(undefined);
  recordRecoveryFeedbackMock.mockResolvedValue(undefined);
  auditMock.mockResolvedValue(undefined);
  getDeadLetterMock.mockResolvedValue(dlqRow as never);
  commitMemoryMock.mockResolvedValue({ ok: true, entryId: "entry-1" });
});

// ─── Pure helpers ──────────────────────────────────────────────────────────

describe("composeRecoveryRationaleContent (pure)", () => {
  it("renders accept + signature + comment in a stable shape", () => {
    const content = composeRecoveryRationaleContent({
      approachLabel: "add_retry",
      accepted: true,
      comment: "transient under load",
      signature: "http_error:5xx on http node",
    });
    expect(content).toBe(
      'approachLabel=add_retry — operator accepted. Failure signature: http_error:5xx on http node. Comment: transient under load',
    );
  });

  it("substitutes (none) when comment is empty / null", () => {
    const noComment = composeRecoveryRationaleContent({
      approachLabel: "swap_secret_ref",
      accepted: true,
      comment: null,
      signature: "secret_missing:STRIPE_API_KEY",
    });
    expect(noComment).toMatch(/Comment: \(none\)$/);
    const emptyComment = composeRecoveryRationaleContent({
      approachLabel: "swap_secret_ref",
      accepted: false,
      comment: "   ",
      signature: "secret_missing:STRIPE_API_KEY",
    });
    expect(emptyComment).toMatch(/operator rejected/);
    expect(emptyComment).toMatch(/Comment: \(none\)$/);
  });

  it("scrubs secret-shape values out of comment + signature", () => {
    const content = composeRecoveryRationaleContent({
      approachLabel: "swap_secret_ref",
      accepted: true,
      comment: "header had Bearer aaaaaaaaaaaaaaaaaa exposed",
      signature: "http_error:401 with leak sk-aaaaaaaaaaaaaaaaaaaa",
    });
    expect(content).not.toContain("aaaaaaaaaaaaaaaaaa");
    expect(content).not.toContain("sk-aaaaaaaaaaaaaaaaaaaa");
    expect(content).toContain("[redacted]");
  });
});

describe("composePatchRationaleContent (pure)", () => {
  it("renders approachLabel + scrubbed rationale", () => {
    const content = composePatchRationaleContent({
      approachLabel: "add_retry",
      rationale: "5xx from Stripe is usually transient; retry with backoff should resolve.",
    });
    expect(content).toBe(
      "approachLabel=add_retry. Rationale: 5xx from Stripe is usually transient; retry with backoff should resolve.",
    );
  });

  it("truncates long rationale with a trailing ellipsis", () => {
    const content = composePatchRationaleContent({
      approachLabel: "raise_timeout",
      rationale: "x".repeat(2000),
    });
    expect(content).toContain("…");
    expect(content.length).toBeLessThanOrEqual(1300);
  });

  it("scrubs secret-shape substrings", () => {
    const content = composePatchRationaleContent({
      approachLabel: "swap_secret_ref",
      rationale: "swap the literal Bearer aaaaaaaaaaaaaaaaaaaa for the env reference",
    });
    expect(content).not.toContain("aaaaaaaaaaaaaaaaaaaa");
    expect(content).toContain("[redacted]");
  });
});

// ─── Route — memory write block ────────────────────────────────────────────

describe("POST /recovery/feedback — memory-disabled zero behavior change", () => {
  it("skips commitMemory entirely when isMemoryAllowed returns denied (process_disabled)", async () => {
    isMemoryAllowedMock.mockResolvedValueOnce({
      allowed: false,
      reason: "process_disabled",
      message: "off",
    });
    const result = await callFeedback({
      deadLetterId: "dlq-1",
      suggestionMode: "ai",
      approachLabel: "add_retry",
      accepted: true,
      rationale: "would have written patch_rationale",
    });
    await flushMicrotasks();
    expect(commitMemoryMock).not.toHaveBeenCalled();
    expect(result).toEqual({ payload: { ok: true }, status: 200 });
    expect(recordRecoveryFeedbackMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "recovery.feedback",
      "dead_letter",
      "dlq-1",
      expect.objectContaining({ accepted: true }),
    );
  });

  it("skips commitMemory entirely when tenant consent is off (tenant_disabled)", async () => {
    isMemoryAllowedMock.mockResolvedValueOnce({
      allowed: false,
      reason: "tenant_disabled",
      message: "off",
    });
    await callFeedback({
      deadLetterId: "dlq-1",
      suggestionMode: "ai",
      approachLabel: "add_retry",
      accepted: true,
    });
    await flushMicrotasks();
    expect(commitMemoryMock).not.toHaveBeenCalled();
  });
});

describe("POST /recovery/feedback — accepted=false skips memory writes", () => {
  it("never calls isMemoryAllowed nor commitMemory on rejection", async () => {
    await callFeedback({
      deadLetterId: "dlq-1",
      suggestionMode: "ai",
      approachLabel: "swap_secret_ref",
      accepted: false,
      comment: "no era el secret, era el rate limit",
    });
    await flushMicrotasks();
    expect(isMemoryAllowedMock).not.toHaveBeenCalled();
    expect(commitMemoryMock).not.toHaveBeenCalled();
    // Existing path still ran:
    expect(recordRecoveryFeedbackMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "recovery.feedback",
      "dead_letter",
      "dlq-1",
      expect.objectContaining({ accepted: false }),
    );
  });
});

describe("POST /recovery/feedback — accepted=true with consent allowed", () => {
  beforeEach(() => {
    isMemoryAllowedMock.mockResolvedValue({ allowed: true });
  });

  it("commits ONLY recovery_rationale when the body omits rationale", async () => {
    await callFeedback({
      deadLetterId: "dlq-1",
      suggestionMode: "ai",
      approachLabel: "add_retry",
      accepted: true,
      // no rationale → no patch_rationale commit
    });
    await flushMicrotasks();
    expect(commitMemoryMock).toHaveBeenCalledTimes(1);
    const call = commitMemoryMock.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      orgId: "org-1",
      workflowId: "wf-billing",
      runId: "run-1",
      kind: "recovery_rationale",
      metadata: expect.objectContaining({
        approachLabel: "add_retry",
        accepted: true,
        suggestionMode: "ai",
        deadLetterId: "dlq-1",
      }),
    });
    expect(call?.content).toContain("approachLabel=add_retry");
    expect(call?.content).toContain("operator accepted");
    expect(call?.content).toContain("Failure signature: HTTP 401 on http node");
  });

  it("commits BOTH recovery_rationale + patch_rationale when rationale is present", async () => {
    await callFeedback({
      deadLetterId: "dlq-1",
      suggestionMode: "ai",
      approachLabel: "add_retry",
      accepted: true,
      rationale: "5xx from upstream is transient; retry with backoff should resolve.",
    });
    await flushMicrotasks();
    expect(commitMemoryMock).toHaveBeenCalledTimes(2);
    const kinds = commitMemoryMock.mock.calls.map((c) => (c[0] as { kind: string }).kind);
    expect(kinds).toContain("recovery_rationale");
    expect(kinds).toContain("patch_rationale");
    const patchCall = commitMemoryMock.mock.calls.find(
      (c) => (c[0] as { kind: string }).kind === "patch_rationale",
    )?.[0];
    expect(patchCall?.content).toContain("approachLabel=add_retry. Rationale:");
    expect(patchCall?.content).toContain("retry with backoff");
  });

  it("passes orgId through to BOTH commit calls (tenant isolation)", async () => {
    await callFeedback({
      deadLetterId: "dlq-1",
      suggestionMode: "ai",
      approachLabel: "add_retry",
      accepted: true,
      rationale: "test",
    });
    await flushMicrotasks();
    for (const call of commitMemoryMock.mock.calls) {
      expect((call[0] as { orgId: string }).orgId).toBe("org-1");
    }
  });

  it("memory commit failure does NOT break the feedback response", async () => {
    commitMemoryMock.mockRejectedValueOnce(new Error("embedding service unreachable"));
    const result = await callFeedback({
      deadLetterId: "dlq-1",
      suggestionMode: "ai",
      approachLabel: "add_retry",
      accepted: true,
      rationale: "test",
    });
    await flushMicrotasks();
    expect(result).toEqual({ payload: { ok: true }, status: 200 });
    // The feedback row + audit completed before the memory write.
    expect(recordRecoveryFeedbackMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "recovery.feedback",
      expect.any(String),
      expect.any(String),
      expect.any(Object),
    );
  });
});
