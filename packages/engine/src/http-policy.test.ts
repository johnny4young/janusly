import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

// vi.mock must be hoisted before any import that pulls in the real module.
// The factory replaces `node:dns/promises` so vitest can drive `lookup` from
// each test (vi.spyOn on ESM exports is not configurable in this setup).
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

import { lookup as mockedLookup } from "node:dns/promises";
import { __testInternals, fetchHttpTarget, validateHttpTarget } from "./http-policy";

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

// ---------------------------------------------------------------------------
// Bound execution: timeout, body cap, redirect handling
// ---------------------------------------------------------------------------
//
// These tests stand up a real `node:http` server on a kernel-assigned port
// (`listen(0)` on `127.0.0.1`) and drive `fetchHttpTarget` through it. The
// server is private from an SSRF perspective, so the suite sets
// `ALLOW_PRIVATE_HTTP_TARGETS=true` in `beforeEach` to bypass the pin for the
// fixture itself. Tests that need to assert SSRF-revalidation on redirect
// flip the env back to `false` inside the response handler — see the
// "revalidates redirect targets" test for the trick.
//
// We track open sockets so that the timeout test (hung server) doesn't keep
// `afterEach` from finishing — `server.close()` only refuses new
// connections.

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

interface TrackedServer extends Server {
  __sockets?: Set<Socket>;
}

async function startTestServer(handler: Handler): Promise<{ server: TrackedServer; url: string }> {
  return new Promise((resolve) => {
    const server: TrackedServer = createServer(handler);
    const sockets = new Set<Socket>();
    server.__sockets = sockets;
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}/` });
    });
  });
}

async function stopTestServer(server: TrackedServer) {
  for (const socket of server.__sockets ?? []) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("HTTP bound execution", () => {
  let servers: TrackedServer[] = [];

  beforeEach(() => {
    vi.stubEnv("ALLOW_PRIVATE_HTTP_TARGETS", "true");
  });

  afterEach(async () => {
    await Promise.all(servers.map((server) => stopTestServer(server)));
    servers = [];
    vi.unstubAllEnvs();
  });

  async function spawn(handler: Handler) {
    const { server, url } = await startTestServer(handler);
    servers.push(server);
    return url;
  }

  it("rejects requests that exceed the timeout budget", async () => {
    // Server never responds: the handler holds the request open. The
    // AbortController fires at `timeoutMs`, undici closes the socket, and
    // fetchHttpTarget converts the AbortError into a clear timeout message.
    const url = await spawn(() => {
      // Deliberately do nothing — no `res.end()`, no eventual write.
    });
    await expect(fetchHttpTarget(url, { timeoutMs: 50 })).rejects.toThrow(/timed out after 50ms/);
  });

  it("rejects oversized declared body via Content-Length pre-check", async () => {
    const url = await spawn((_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Length", "999999999");
      res.setHeader("Content-Type", "application/octet-stream");
      // Don't actually write 1 GB; the pre-check fires before consumption.
      res.end("partial");
    });
    await expect(fetchHttpTarget(url, { maxResponseBytes: 1_000 })).rejects.toThrow(/Content-Length 999999999/);
  });

  it("rejects oversized streamed body when no Content-Length is sent", async () => {
    const chunkSize = 64 * 1024;
    const totalChunks = 32; // 2 MB total, written via chunked transfer-encoding.
    const url = await spawn((_req, res) => {
      res.statusCode = 200;
      // Omitting Content-Length forces chunked encoding, exercising the
      // streaming counter path rather than the pre-check.
      res.setHeader("Content-Type", "application/octet-stream");
      const buf = Buffer.alloc(chunkSize, 0x41);
      for (let i = 0; i < totalChunks; i++) {
        res.write(buf);
      }
      res.end();
    });
    await expect(fetchHttpTarget(url, { maxResponseBytes: 100_000 })).rejects.toThrow(/exceeds maxResponseBytes after \d+ bytes/);
  });

  it("revalidates redirect targets through the SSRF pin (302 to private IP blocked)", async () => {
    // The test server itself is on 127.0.0.1, so the FIRST hop needs
    // ALLOW_PRIVATE_HTTP_TARGETS=true. We flip it to false inside the
    // response handler, so the recursive call's validateAndResolveTarget
    // rejects the redirect target as private — proving revalidation runs.
    const url = await spawn((_req, res) => {
      vi.stubEnv("ALLOW_PRIVATE_HTTP_TARGETS", "false");
      res.statusCode = 302;
      res.setHeader("Location", "http://169.254.169.254/latest/meta-data");
      res.end();
    });
    await expect(fetchHttpTarget(url)).rejects.toThrow(/private and blocked/);
  });

  it("follows redirect chains up to maxRedirects", async () => {
    // Three-server chain: A -> B -> C. C returns the final body.
    const cUrl = await spawn((_req, res) => {
      res.statusCode = 200;
      res.end("final");
    });
    const bUrl = await spawn((_req, res) => {
      res.statusCode = 302;
      res.setHeader("Location", cUrl);
      res.end();
    });
    const aUrl = await spawn((_req, res) => {
      res.statusCode = 302;
      res.setHeader("Location", bUrl);
      res.end();
    });

    const ok = await fetchHttpTarget(aUrl, { maxRedirects: 3 });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("final");

    await expect(fetchHttpTarget(aUrl, { maxRedirects: 1 })).rejects.toThrow(/redirect limit exceeded/);
  });

  it("returns a normal HttpResult for a sane upstream within all defaults", async () => {
    const url = await spawn((_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ hello: "world" }));
    });
    const result = await fetchHttpTarget(url);
    expect(result.statusCode).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.body).toBe(JSON.stringify({ hello: "world" }));
    expect(result.headers["content-type"]).toContain("application/json");
  });

  it("per-call maxResponseBytes override raises the runtime default", async () => {
    // Body sized to land between the default 1 MB cap and the override.
    const buf = Buffer.alloc(2_000_000, 0x42);
    const url = await spawn((_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Length", String(buf.byteLength));
      res.end(buf);
    });

    // Default cap (1 MB) rejects.
    await expect(fetchHttpTarget(url)).rejects.toThrow(/exceeds maxResponseBytes/);

    // Override to 5 MB — same upstream, success now.
    const result = await fetchHttpTarget(url, { maxResponseBytes: 5_000_000 });
    expect(result.statusCode).toBe(200);
    expect(result.body.length).toBe(buf.byteLength);
  });

  it("falls back to safe defaults when workflow-provided bounds are malformed", async () => {
    const buf = Buffer.alloc(2_000_000, 0x43);
    const url = await spawn((_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Length", String(buf.byteLength));
      res.end(buf);
    });

    // The `http` workflow node can pass arbitrary JSON config directly into
    // fetchHttpTarget. Malformed values must not coerce comparisons to NaN and
    // accidentally disable the byte cap.
    await expect(fetchHttpTarget(url, { maxResponseBytes: "not-a-number" } as never))
      .rejects.toThrow(/exceeds maxResponseBytes/);
  });
});
