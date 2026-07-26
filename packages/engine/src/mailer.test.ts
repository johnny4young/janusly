/**
 * Tests for the mailer abstraction. Mocks `fetchHttpTarget` so the
 * Resend / SendGrid providers can be exercised without standing up
 * a real HTTP target. Resolution-order tests cover the env-driven
 * `getMailer()` switch + the test-override seam.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMailer,
  setMailerForTests,
  type MailerProvider,
  type MailerSendResult,
} from "./mailer";

vi.mock("./http-policy", () => ({
  fetchHttpTarget: vi.fn(),
}));

import { fetchHttpTarget } from "./http-policy";
const fetchHttpTargetMock = vi.mocked(fetchHttpTarget);

const ENV_KEYS = [
  "JANUSLY_MAILER_PROVIDER",
  "RESEND_API_KEY",
  "SENDGRID_API_KEY",
  "JANUSLY_MAILER_FROM",
  "JANUSLY_LOCAL_INTEGRATION_SIMULATOR",
  "JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL",
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  setMailerForTests(null);
  fetchHttpTargetMock.mockReset();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  setMailerForTests(null);
});

describe("getMailer — env-driven resolution", () => {
  it("returns the test override when set, regardless of env", () => {
    const fake: MailerProvider = {
      name: "noop",
      send: async (): Promise<MailerSendResult> => ({ ok: true, provider: "noop", providerMessageId: "fake" }),
    };
    process.env.JANUSLY_MAILER_PROVIDER = "resend";
    process.env.RESEND_API_KEY = "secret";
    setMailerForTests(fake);
    expect(getMailer()).toBe(fake);
  });

  it("returns the Resend provider when JANUSLY_MAILER_PROVIDER=resend AND RESEND_API_KEY is set", () => {
    process.env.JANUSLY_MAILER_PROVIDER = "resend";
    process.env.RESEND_API_KEY = "re_test_key";
    expect(getMailer().name).toBe("resend");
  });

  it("returns the SendGrid provider when JANUSLY_MAILER_PROVIDER=sendgrid AND SENDGRID_API_KEY is set", () => {
    process.env.JANUSLY_MAILER_PROVIDER = "sendgrid";
    process.env.SENDGRID_API_KEY = "SG.test";
    expect(getMailer().name).toBe("sendgrid");
  });

  it("returns the simulator only when its explicit local gate is enabled", () => {
    process.env.JANUSLY_MAILER_PROVIDER = "simulator";
    expect(getMailer().name).toBe("noop");
    process.env.JANUSLY_LOCAL_INTEGRATION_SIMULATOR = "true";
    process.env.JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL = "http://provider-simulator:4010";
    expect(getMailer().name).toBe("simulator");
  });

  it("falls back to Noop when JANUSLY_MAILER_PROVIDER is unset", () => {
    expect(getMailer().name).toBe("noop");
  });

  it("falls back to Noop when JANUSLY_MAILER_PROVIDER=resend but RESEND_API_KEY is missing", () => {
    process.env.JANUSLY_MAILER_PROVIDER = "resend";
    expect(getMailer().name).toBe("noop");
  });

  it("falls back to Noop when JANUSLY_MAILER_PROVIDER is an unknown value", () => {
    process.env.JANUSLY_MAILER_PROVIDER = "mailgun";
    process.env.SENDGRID_API_KEY = "SG.test";
    expect(getMailer().name).toBe("noop");
  });

  it("honors a tenant provider override", () => {
    process.env.JANUSLY_MAILER_PROVIDER = "resend";
    process.env.RESEND_API_KEY = "re_test_key";
    expect(getMailer("noop").name).toBe("noop");
  });
});

describe("SimulatorMailer.send", () => {
  beforeEach(() => {
    process.env.JANUSLY_MAILER_PROVIDER = "simulator";
    process.env.JANUSLY_LOCAL_INTEGRATION_SIMULATOR = "true";
    process.env.JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL = "http://provider-simulator:4010";
  });

  it("posts a local delivery and requires a returned message id", async () => {
    fetchHttpTargetMock.mockResolvedValueOnce({
      statusCode: 202,
      ok: true,
      body: '{"id":"local-email-42"}',
      headers: {},
    });

    const result = await getMailer().send({
      to: "user@example.test",
      from: "janusly@example.test",
      subject: "Local smoke",
      text: "Delivered locally",
    });

    expect(result).toEqual({ ok: true, provider: "simulator", providerMessageId: "local-email-42" });
    expect(fetchHttpTargetMock).toHaveBeenCalledWith(
      "http://provider-simulator:4010/email/send",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("ResendMailer.send", () => {
  beforeEach(() => {
    process.env.JANUSLY_MAILER_PROVIDER = "resend";
    process.env.RESEND_API_KEY = "re_test_key";
  });

  it("posts the right body and headers, returns the message id on 2xx", async () => {
    fetchHttpTargetMock.mockResolvedValueOnce({
      statusCode: 200,
      ok: true,
      body: JSON.stringify({ id: "re_msg_42", from: "a@b.c", to: "d@e.f" }),
      headers: {},
    });

    const result = await getMailer().send({
      to: "user@example.com",
      from: "sender@example.com",
      subject: "Hi",
      text: "Hello",
    });

    expect(result).toEqual({ ok: true, provider: "resend", providerMessageId: "re_msg_42" });
    const [url, init] = fetchHttpTargetMock.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.method).toBe("POST");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer re_test_key");
    const body = JSON.parse(init?.body as string);
    expect(body.from).toBe("sender@example.com");
    expect(body.to).toEqual(["user@example.com"]);
    expect(body.subject).toBe("Hi");
    expect(body.text).toBe("Hello");
  });

  it("translates metadata into Resend tags", async () => {
    fetchHttpTargetMock.mockResolvedValueOnce({ statusCode: 200, ok: true, body: '{"id":"x"}', headers: {} });
    await getMailer().send({
      to: "u@e.com",
      from: "s@e.com",
      subject: "x",
      text: "x",
      metadata: { campaign: "demo", env: "test" },
    });
    const body = JSON.parse(fetchHttpTargetMock.mock.calls[0]![1]?.body as string);
    expect(body.tags).toEqual([
      { name: "campaign", value: "demo" },
      { name: "env", value: "test" },
    ]);
  });

  it("returns ok:false on a non-2xx (no throw)", async () => {
    fetchHttpTargetMock.mockResolvedValueOnce({
      statusCode: 401,
      ok: false,
      body: '{"error":"Invalid API key"}',
      headers: {},
    });
    const result = await getMailer().send({
      to: "u@e.com",
      from: "s@e.com",
      subject: "x",
      text: "x",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.provider).toBe("resend");
    expect(result.error).toContain("HTTP 401");
  });

  it("returns ok:false when fetchHttpTarget throws (network failure, no provider crash)", async () => {
    fetchHttpTargetMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await getMailer().send({
      to: "u@e.com",
      from: "s@e.com",
      subject: "x",
      text: "x",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("ECONNREFUSED");
  });

  it("returns ok:false when the response body has no message id", async () => {
    fetchHttpTargetMock.mockResolvedValueOnce({
      statusCode: 200,
      ok: true,
      body: '{"unexpected":"shape"}',
      headers: {},
    });
    const result = await getMailer().send({
      to: "u@e.com",
      from: "s@e.com",
      subject: "x",
      text: "x",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("message id");
  });
});

describe("SendGridMailer.send", () => {
  beforeEach(() => {
    process.env.JANUSLY_MAILER_PROVIDER = "sendgrid";
    process.env.SENDGRID_API_KEY = "SG.test";
  });

  it("posts the v3/mail/send body shape, returns ok:true on 2xx", async () => {
    fetchHttpTargetMock.mockResolvedValueOnce({ statusCode: 202, ok: true, body: "", headers: {} });
    const result = await getMailer().send({
      to: "u@e.com",
      from: "s@e.com",
      subject: "Greetings",
      html: "<p>hi</p>",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provider).toBe("sendgrid");
    const [url, init] = fetchHttpTargetMock.mock.calls[0]!;
    expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
    const body = JSON.parse(init?.body as string);
    expect(body.personalizations[0].to[0].email).toBe("u@e.com");
    expect(body.from.email).toBe("s@e.com");
    expect(body.content).toEqual([{ type: "text/html", value: "<p>hi</p>" }]);
  });

  it("returns ok:false on non-2xx without throwing", async () => {
    fetchHttpTargetMock.mockResolvedValueOnce({ statusCode: 403, ok: false, body: "forbidden", headers: {} });
    const result = await getMailer().send({
      to: "u@e.com",
      from: "s@e.com",
      subject: "x",
      text: "x",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("HTTP 403");
  });
});

describe("NoopMailer.send", () => {
  it("returns ok:false with the configuration hint", async () => {
    const result = await getMailer().send({
      to: "u@e.com",
      from: "s@e.com",
      subject: "x",
      text: "x",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.provider).toBe("noop");
    expect(result.error).toContain("Mailer not configured");
  });
});
