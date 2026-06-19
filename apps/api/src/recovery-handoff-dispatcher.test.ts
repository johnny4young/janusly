/**
 * Tests for the recovery incident-handoff dispatcher's per-destination tool
 * routing. The dispatcher now calls the shared per-tool invocation helpers in
 * `report-delivery.ts`; those helpers call `executeTool`, so mocking
 * `@janusly/engine/src/tool-registry` at module level intercepts the round-trip
 * for every destination.
 *
 * Coverage targets:
 * - Each of the 4 destinations routes to the correct tool with the correct
 *   `executeTool(name, input, {}, { orgId })` args (the behavior-preservation
 *   contract for the consolidation).
 * - GitHub append branch (existing numeric externalId) → `github.add_issue_comment`,
 *   preserving the original issue ref; create branch → `github.create_issue`.
 * - webhook + linear carry the `x-idempotency-key` header + `idempotencyKey` in
 *   the payload; linear is webhook.send disguised.
 * - Result mapping (`externalId` / `externalUrl` / `commentId`) and the
 *   never-throws contract (a thrown `executeTool` becomes `{ ok: false }`).
 *
 * Message composition + cooldown + schema have their own suite
 * (`packages/shared/src/recovery-handoff.test.ts`); this file is the dispatch
 * wiring's unit-under-test.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeToolMock } = vi.hoisted(() => ({ executeToolMock: vi.fn() }));
vi.mock("@janusly/engine/src/tool-registry", () => ({ executeTool: executeToolMock }));

import { composeHandoffMessage } from "@janusly/shared";
import type { RecoveryItemHandoff } from "@janusly/data";

import { dispatchHandoff, type DispatchContext } from "./recovery-handoff-dispatcher";

const message = composeHandoffMessage({
  recoveryItemId: "ri_1",
  deadLetterId: "dlq_1",
  workflowId: "wf_1",
  severity: "p2",
  status: "open",
});

function makeCtx(overrides: Partial<DispatchContext>): DispatchContext {
  return {
    orgId: "org1",
    recoveryItemId: "ri_1",
    destination: "slack",
    credentialName: "cred",
    message,
    existing: null,
    request: {},
    ...overrides,
  };
}

beforeEach(() => {
  executeToolMock.mockReset();
});

describe("dispatchHandoff — per-destination tool routing via the shared helpers", () => {
  it("slack → slack.post with the composed markdown", async () => {
    executeToolMock.mockResolvedValueOnce({ ok: true, statusCode: 200, latencyMs: 3 });
    const out = await dispatchHandoff(makeCtx({ destination: "slack" }));
    const [name, input, ctxArg, exec] = executeToolMock.mock.calls[0]!;
    expect(name).toBe("slack.post");
    expect(input).toEqual({ credential: "cred", text: message.markdown });
    expect(ctxArg).toEqual({});
    expect(exec).toEqual({ orgId: "org1" });
    expect(out).toMatchObject({ destination: "slack", ok: true, statusCode: 200 });
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("github create branch → github.create_issue, maps issueNumber→externalId + url→externalUrl", async () => {
    executeToolMock.mockResolvedValueOnce({
      ok: true,
      statusCode: 201,
      latencyMs: 4,
      issueNumber: 42,
      url: "https://github.com/o/r/issues/42",
    });
    const out = await dispatchHandoff(
      makeCtx({ destination: "github", request: { owner: "o", repo: "r", labels: ["bug"], assignees: ["u1"] } }),
    );
    const [name, input] = executeToolMock.mock.calls[0]!;
    expect(name).toBe("github.create_issue");
    expect(input).toEqual({
      credential: "cred",
      owner: "o",
      repo: "r",
      title: message.subject,
      body: message.markdown,
      labels: ["bug"],
      assignees: ["u1"],
    });
    expect(out).toMatchObject({
      destination: "github",
      ok: true,
      externalId: "42",
      externalUrl: "https://github.com/o/r/issues/42",
    });
  });

  it("github append branch (existing numeric externalId) → github.add_issue_comment, preserves the original issue ref", async () => {
    executeToolMock.mockResolvedValueOnce({
      ok: true,
      statusCode: 201,
      latencyMs: 2,
      commentId: 99,
      commentUrl: "https://github.com/o/r/issues/42#c99",
    });
    const existing = {
      externalId: "42",
      externalUrl: "https://github.com/o/r/issues/42",
      dispatchCount: 1,
    } as unknown as RecoveryItemHandoff;
    const out = await dispatchHandoff(
      makeCtx({ destination: "github", existing, request: { owner: "o", repo: "r" } }),
    );
    const [name, input] = executeToolMock.mock.calls[0]!;
    expect(name).toBe("github.add_issue_comment");
    expect(input).toEqual({ credential: "cred", owner: "o", repo: "r", issueNumber: 42, body: message.markdown });
    expect(out).toMatchObject({
      destination: "github",
      ok: true,
      externalId: "42",
      externalUrl: "https://github.com/o/r/issues/42",
      commentId: "99",
    });
  });

  it("webhook → webhook.send with the structured payload + x-idempotency-key header", async () => {
    executeToolMock.mockResolvedValueOnce({ ok: true, statusCode: 200, latencyMs: 5 });
    const out = await dispatchHandoff(makeCtx({ destination: "webhook", request: { url: "https://hooks.test/x" } }));
    const [name, input, ctxArg, exec] = executeToolMock.mock.calls[0]!;
    expect(name).toBe("webhook.send");
    expect(input).toMatchObject({
      credential: "cred",
      url: "https://hooks.test/x",
      payload: expect.objectContaining({ recoveryItemId: "ri_1", idempotencyKey: "ri_1:webhook" }),
      headers: { "x-idempotency-key": "ri_1:webhook" },
    });
    expect(ctxArg).toEqual({});
    expect(exec).toEqual({ orgId: "org1" });
    expect(out).toMatchObject({ destination: "webhook", ok: true });
  });

  it("linear → webhook.send with the linear-scoped idempotency key", async () => {
    executeToolMock.mockResolvedValueOnce({ ok: true, latencyMs: 1 });
    const out = await dispatchHandoff(makeCtx({ destination: "linear", request: { url: "https://hooks.test/linear" } }));
    const [name, input] = executeToolMock.mock.calls[0]!;
    expect(name).toBe("webhook.send");
    expect(input).toMatchObject({ headers: { "x-idempotency-key": "ri_1:linear" } });
    expect(out.destination).toBe("linear");
  });

  it("never throws — a thrown executeTool becomes { ok: false } with the (sliced) error", async () => {
    executeToolMock.mockRejectedValueOnce(new Error("network boom"));
    const out = await dispatchHandoff(makeCtx({ destination: "slack" }));
    expect(out).toMatchObject({ destination: "slack", ok: false });
    expect(out.error).toContain("network boom");
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
