import { afterEach, describe, expect, it, vi } from "vitest";
import { validateHttpTarget } from "./http-policy";

describe("HTTP target policy", () => {
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
});
