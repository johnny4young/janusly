import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock must be hoisted before any import that pulls in the real module.
// The factory replaces `node:dns/promises` so vitest can drive `lookup` from
// each test (vi.spyOn on ESM exports is not configurable in this setup).
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

import { lookup as mockedLookup } from "node:dns/promises";
import { __testInternals, validateHttpTarget } from "./http-policy";

const lookupMock = vi.mocked(mockedLookup);

describe("HTTP target policy", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects non-HTTP protocols", async () => {
    vi.stubEnv("ALLOW_PRIVATE_HTTP_TARGETS", "false");
    await expect(validateHttpTarget("file:///etc/passwd")).rejects.toThrow("Unsupported HTTP target protocol");
  });

  it("blocks localhost targets by default", async () => {
    vi.stubEnv("ALLOW_PRIVATE_HTTP_TARGETS", "false");
    await expect(validateHttpTarget("http://localhost:3001/tools")).rejects.toThrow("private and blocked");
  });

  it("blocks private IPv4 targets by default", async () => {
    vi.stubEnv("ALLOW_PRIVATE_HTTP_TARGETS", "false");
    await expect(validateHttpTarget("http://127.0.0.1:3001/tools")).rejects.toThrow("private and blocked");
  });

  it("blocks IPv4-mapped IPv6 targets for private and link-local ranges", async () => {
    vi.stubEnv("ALLOW_PRIVATE_HTTP_TARGETS", "false");
    await expect(validateHttpTarget("http://[::ffff:169.254.169.254]/latest/meta-data")).rejects.toThrow("private and blocked");
    await expect(validateHttpTarget("http://[::ffff:172.16.0.10]/tools")).rejects.toThrow("private and blocked");
    await expect(validateHttpTarget("http://[::ffff:100.64.0.10]/tools")).rejects.toThrow("private and blocked");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("rejects when DNS resolution returns any private address among multiple A records", async () => {
    vi.stubEnv("ALLOW_PRIVATE_HTTP_TARGETS", "false");
    lookupMock.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ] as never);

    await expect(validateHttpTarget("http://mixed.example.com")).rejects.toThrow("resolves to a private address");
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  it("rejects when DNS resolution returns an IPv4-mapped IPv6 private address", async () => {
    vi.stubEnv("ALLOW_PRIVATE_HTTP_TARGETS", "false");
    lookupMock.mockResolvedValue([{ address: "::ffff:172.16.0.10", family: 6 }] as never);

    await expect(validateHttpTarget("http://mapped-private.example.com")).rejects.toThrow("resolves to a private address");
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  it("pins the resolved IP for the connect, defeating a public-then-private DNS rebinding", async () => {
    // The TOCTOU scenario: an attacker controls DNS so that the validation
    // lookup returns a public IP and the connect-time lookup would return a
    // private IP (e.g. 127.0.0.1, AWS metadata 169.254.169.254). With the
    // pinned dispatcher, the agent's pinned lookup must return the public IP
    // it was constructed with, regardless of any subsequent DNS shift.
    vi.stubEnv("ALLOW_PRIVATE_HTTP_TARGETS", "false");
    lookupMock.mockResolvedValueOnce([{ address: "203.0.113.10", family: 4 }] as never);

    const { pinnedLookup } = await __testInternals.resolveAndPin("evil.example.com");

    // Simulate the rebinding: the next DNS query would now return private,
    // but the pinned lookup must NOT call dns.lookup again — it returns the
    // address captured at validation time.
    lookupMock.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }] as never);

    const result = await new Promise<{ err: Error | null; address: string; family: number }>((resolve) => {
      pinnedLookup("evil.example.com", {}, (err, address, family) => {
        resolve({ err, address: String(address), family: Number(family) });
      });
    });

    expect(result).toEqual({ err: null, address: "203.0.113.10", family: 4 });
    // Crucial: only the validation call hit DNS. The pin short-circuits the
    // would-be second lookup that the rebinding attack relies on.
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });
});
