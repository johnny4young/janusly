/**
 * Tests for the `email.send` tool. Mocks the mailer and the DI seams
 * (rate-limit + email-usage recorder) so the tool's wrapper logic
 * (rate gate, recorder fire, output shape) can be exercised without
 * a real provider call. Pinned: `writeSide: true` in the registry,
 * happy path, mailer failure, rate-limit hit, recorder fires on both
 * success and failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetEmailUsageRecorderForTests,
  setEmailUsageRecorder,
  type EmailUsageRecord,
} from "./email-usage";
import {
  _resetEngineRateLimiterForTests,
  setEngineRateLimiter,
} from "./rate-limit";
import { setMailerForTests, type MailerProvider, type MailerSendResult } from "./mailer";
import { executeTool, isToolWriteSide, validateToolInput } from "./tool-registry";

const captured: EmailUsageRecord[] = [];

function makeMailer(result: MailerSendResult): MailerProvider {
  return {
    name: result.provider,
    send: vi.fn(async () => result),
  };
}

beforeEach(() => {
  captured.length = 0;
  setMailerForTests(null);
  _resetEngineRateLimiterForTests();
  _resetEmailUsageRecorderForTests();
  setEmailUsageRecorder((record) => { captured.push(record); });
});

afterEach(() => {
  setMailerForTests(null);
  _resetEngineRateLimiterForTests();
  _resetEmailUsageRecorderForTests();
});

describe("email.send tool registry", () => {
  it("registers as write-side", () => {
    expect(isToolWriteSide("email.send")).toBe(true);
  });
});

describe("email.send happy path", () => {
  it("returns ok:true + providerMessageId and writes a usage record", async () => {
    setMailerForTests(makeMailer({ ok: true, provider: "resend", providerMessageId: "re_msg_1" }));

    const result = await executeTool(
      "email.send",
      { to: "u@e.com", subject: "Hi", text: "Hello", from: "s@e.com" },
      {},
      { orgId: "org-1", runId: "run-1", nodeId: "send", workflowId: "wf-1" },
    );

    expect(result).toEqual({ ok: true, provider: "resend", providerMessageId: "re_msg_1" });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      orgId: "org-1",
      runId: "run-1",
      nodeId: "send",
      workflowId: "wf-1",
      to: "u@e.com",
      from: "s@e.com",
      provider: "resend",
      providerMessageId: "re_msg_1",
      ok: true,
    });
  });

  it("falls back the `from` to JANUSLY_MAILER_FROM when not in input", async () => {
    process.env.JANUSLY_MAILER_FROM = "default@e.com";
    const mailer = makeMailer({ ok: true, provider: "resend", providerMessageId: "re_msg" });
    setMailerForTests(mailer);

    await executeTool(
      "email.send",
      { to: "u@e.com", subject: "Hi", text: "Hello" },
      {},
      { orgId: "org-1" },
    );

    expect((mailer.send as ReturnType<typeof vi.fn>).mock.calls[0]![0].from).toBe("default@e.com");
    delete process.env.JANUSLY_MAILER_FROM;
  });

  it("uses tenant email config for default from and rate-limit cap", async () => {
    const limiter = vi.fn(async () => undefined);
    setEngineRateLimiter(limiter);
    const mailer = makeMailer({ ok: true, provider: "resend", providerMessageId: "re_msg" });
    setMailerForTests(mailer);

    await executeTool(
      "email.send",
      { to: "u@e.com", subject: "Hi", text: "Hello" },
      {},
      {
        orgId: "org-1",
        email: { provider: "resend", from: "billing@tenant.example", rateLimitPerMin: 7 },
      },
    );

    expect(limiter).toHaveBeenCalledWith("email.send", "org-1", { windowMs: 60_000, max: 7 });
    expect((mailer.send as ReturnType<typeof vi.fn>).mock.calls[0]![0].from).toBe("billing@tenant.example");
  });
});

describe("email.send mailer failure", () => {
  it("returns ok:false + error from the mailer and still records the audit row", async () => {
    setMailerForTests(makeMailer({ ok: false, provider: "resend", error: "Resend returned HTTP 401" }));

    const result = await executeTool(
      "email.send",
      { to: "u@e.com", subject: "Hi", text: "Hello", from: "s@e.com" },
      {},
      { orgId: "org-1" },
    );

    expect(result).toEqual({ ok: false, provider: "resend", error: "Resend returned HTTP 401" });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.ok).toBe(false);
    expect(captured[0]!.error).toBe("Resend returned HTTP 401");
  });

  it("returns ok:false from Noop when no mailer is configured", async () => {
    // No setMailerForTests — falls through to default (noop in the
    // absence of provider-env vars). But the test process can have
    // env vars set; force the noop path with an explicit mailer.
    setMailerForTests({
      name: "noop",
      send: async () => ({ ok: false, provider: "noop", error: "Mailer not configured" }),
    });
    const result = await executeTool(
      "email.send",
      { to: "u@e.com", subject: "Hi", text: "Hello", from: "s@e.com" },
      {},
      { orgId: "org-1" },
    );
    expect(result.provider).toBe("noop");
    expect(result.ok).toBe(false);
  });
});

describe("email.send rate limit", () => {
  it("returns ok:false when the limiter throws and skips the mailer call entirely", async () => {
    const mailerSend = vi.fn();
    setMailerForTests({
      name: "resend",
      send: mailerSend as MailerProvider["send"],
    });
    setEngineRateLimiter(async () => {
      throw new Error("Rate limit exceeded for email.send");
    });

    const result = await executeTool(
      "email.send",
      { to: "u@e.com", subject: "Hi", text: "Hello", from: "s@e.com" },
      {},
      { orgId: "org-1" },
    );

    expect(result).toEqual({
      ok: false,
      provider: "noop",
      error: "Rate limit exceeded for email.send",
    });
    expect(mailerSend).not.toHaveBeenCalled();
    // Audit row still fires for the rate-limit-rejected attempt — the
    // operator can see the over-limit pattern in the breakdown.
    expect(captured).toHaveLength(1);
    expect(captured[0]!.error).toContain("Rate limit exceeded");
  });

  it("does not call the limiter when no orgId is present (unit-test safety net)", async () => {
    const limiter = vi.fn();
    setEngineRateLimiter(limiter);
    setMailerForTests(makeMailer({ ok: true, provider: "noop", providerMessageId: "x" }));

    await executeTool(
      "email.send",
      { to: "u@e.com", subject: "Hi", text: "Hello", from: "s@e.com" },
      {},
      // No orgId → rate gate skipped (this test asserts the safety
      // net; production paths always thread orgId via NodeContext).
      {},
    );

    expect(limiter).not.toHaveBeenCalled();
  });
});

describe("email.send schema validation", () => {
  it("rejects when both `text` and `html` are missing", async () => {
    setMailerForTests(makeMailer({ ok: true, provider: "noop", providerMessageId: "x" }));
    await expect(executeTool(
      "email.send",
      { to: "u@e.com", subject: "Hi", from: "s@e.com" },
      {},
      { orgId: "org-1" },
    )).rejects.toThrow(/text.*html/i);
  });

  it("rejects when `to` is empty", async () => {
    await expect(executeTool(
      "email.send",
      { to: "", subject: "Hi", text: "x", from: "s@e.com" },
      {},
      { orgId: "org-1" },
    )).rejects.toThrow();
  });

  it("rejects oversized provider metadata before execution", () => {
    const metadata = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`k${index}`, "v"]));
    const result = validateToolInput("email.send", {
      to: "u@e.com",
      subject: "Hi",
      text: "Hello",
      from: "s@e.com",
      metadata,
    });

    expect(result.valid).toBe(false);
    expect(result.issues.join("\n")).toContain("at most 20 entries");
  });
});
