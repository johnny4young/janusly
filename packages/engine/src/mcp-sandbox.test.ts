import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  buildSandboxProfile,
  captureRedactedStderr,
  McpSandboxCommandNotAllowedError,
  SANDBOX_DEFAULT_LIFETIME_MS,
  SANDBOX_DEFAULT_STDERR_BYTES,
  SANDBOX_DEFAULT_VM_KB,
  SANDBOX_MAX_LIFETIME_MS,
  SANDBOX_MIN_LIFETIME_MS,
} from "./mcp-sandbox";

function fixedMkdtempSync(returnPath: string) {
  return vi.fn((prefix: string) => {
    expect(prefix).toContain("janusly-mcp-");
    return returnPath;
  });
}

describe("buildSandboxProfile", () => {
  it("rejects when the allowlist is empty (fail-closed)", () => {
    const mkdtempSync = vi.fn();
    expect(() =>
      buildSandboxProfile({
        command: "node",
        args: [],
        platform: "linux",
        allowedCommands: [],
        enforceLinuxUlimit: false,
        tempDir: "/tmp",
        mkdtempSync,
      }),
    ).toThrow(McpSandboxCommandNotAllowedError);
    // Allowlist failure happens BEFORE the cwd is allocated — no temp
    // dir leaks when the spawn is going to be refused.
    expect(mkdtempSync).not.toHaveBeenCalled();
  });

  it("rejects when the command is not in the allowlist", () => {
    const mkdtempSync = vi.fn();
    let captured: McpSandboxCommandNotAllowedError | null = null;
    try {
      buildSandboxProfile({
        command: "curl",
        args: ["-X", "POST"],
        platform: "linux",
        allowedCommands: ["node", "uvx"],
        enforceLinuxUlimit: false,
        tempDir: "/tmp",
        mkdtempSync,
      });
    } catch (err) {
      captured = err as McpSandboxCommandNotAllowedError;
    }
    expect(captured).toBeInstanceOf(McpSandboxCommandNotAllowedError);
    expect(captured?.reason).toBe("command_not_in_allowlist");
    expect(captured?.command).toBe("curl");
    expect(mkdtempSync).not.toHaveBeenCalled();
  });

  it("returns an unwrapped profile on non-Linux even when enforce flag is on", () => {
    const profile = buildSandboxProfile({
      command: "node",
      args: ["--inspect"],
      platform: "darwin",
      allowedCommands: ["node"],
      enforceLinuxUlimit: true, // ignored on darwin
      tempDir: "/tmp",
      mkdtempSync: fixedMkdtempSync("/tmp/janusly-mcp-abc"),
    });
    expect(profile.wrappedCommand).toBe("node");
    expect(profile.wrappedArgs).toEqual(["--inspect"]);
    expect(profile.enforced).toBe(false);
    expect(profile.cwd).toBe("/tmp/janusly-mcp-abc");
    expect(profile.maxLifetimeMs).toBe(SANDBOX_DEFAULT_LIFETIME_MS);
    expect(profile.maxStderrBytes).toBe(SANDBOX_DEFAULT_STDERR_BYTES);
  });

  it("wraps the command via /bin/sh + ulimit on production Linux with explicit vmKb", () => {
    const profile = buildSandboxProfile({
      command: "node",
      args: ["--inspect", "server.mjs"],
      platform: "linux",
      allowedCommands: ["node"],
      maxVmKb: 524_288,
      enforceLinuxUlimit: true,
      tempDir: "/tmp",
      mkdtempSync: fixedMkdtempSync("/tmp/janusly-mcp-xyz"),
    });
    expect(profile.wrappedCommand).toBe("/bin/sh");
    // The 5-element prefix is the constant `sh -c <script> <tag> <vm_kb>`,
    // followed by the original command + args. The shell tag never
    // appears in the executed command because $0 is consumed by `sh -c`.
    expect(profile.wrappedArgs).toEqual([
      "-c",
      'ulimit -v "$1"; shift; exec "$@"',
      "janusly-mcp-sandbox",
      "524288",
      "node",
      "--inspect",
      "server.mjs",
    ]);
    expect(profile.enforced).toBe(true);
  });

  it("uses the default vmKb when the caller omits it on Linux enforce", () => {
    const profile = buildSandboxProfile({
      command: "node",
      args: [],
      platform: "linux",
      allowedCommands: ["node"],
      enforceLinuxUlimit: true,
      tempDir: "/tmp",
      mkdtempSync: fixedMkdtempSync("/tmp/janusly-mcp-def"),
    });
    expect(profile.wrappedArgs[3]).toBe(String(SANDBOX_DEFAULT_VM_KB));
  });

  it("clamps lifetime caps below the floor + above the ceiling", () => {
    const profileLow = buildSandboxProfile({
      command: "node",
      args: [],
      platform: "darwin",
      allowedCommands: ["node"],
      maxLifetimeMs: 10,
      enforceLinuxUlimit: false,
      tempDir: "/tmp",
      mkdtempSync: fixedMkdtempSync("/tmp/janusly-mcp-low"),
    });
    expect(profileLow.maxLifetimeMs).toBe(SANDBOX_MIN_LIFETIME_MS);

    const profileHigh = buildSandboxProfile({
      command: "node",
      args: [],
      platform: "darwin",
      allowedCommands: ["node"],
      maxLifetimeMs: 999_999_999,
      enforceLinuxUlimit: false,
      tempDir: "/tmp",
      mkdtempSync: fixedMkdtempSync("/tmp/janusly-mcp-high"),
    });
    expect(profileHigh.maxLifetimeMs).toBe(SANDBOX_MAX_LIFETIME_MS);
  });
});

describe("captureRedactedStderr", () => {
  it("returns an empty snapshot when the stream is null", () => {
    const handle = captureRedactedStderr(null, { maxBytes: 1024 });
    const snap = handle.getSnapshot();
    expect(snap.capturedRedacted).toBe("");
    expect(snap.truncated).toBe(false);
    expect(snap.byteCount).toBe(0);
    // dispose() is safe to call on the null path.
    handle.dispose();
  });

  it("redacts known secret shapes (sk- / ghp_ / Bearer / JWT) in the snapshot", () => {
    const stream = new EventEmitter() as NodeJS.ReadableStream & EventEmitter;
    const handle = captureRedactedStderr(stream, { maxBytes: 4096 });

    stream.emit("data", Buffer.from("starting up...\nsk-FAKE1234567890ABCDEFGHIJ\nBearer eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.payload.sig\nghp_ABCDEFGHIJKLMNOPQRSTUV\n"));

    const snap = handle.getSnapshot();
    expect(snap.capturedRedacted).not.toContain("sk-FAKE1234567890ABCDEFGHIJ");
    expect(snap.capturedRedacted).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUV");
    expect(snap.capturedRedacted).not.toContain("eyJ0eXAi");
    expect(snap.capturedRedacted).toContain("[redacted]");
    expect(snap.truncated).toBe(false);
  });

  it("caps total bytes and fires onTruncate when the child overflows the buffer", () => {
    const stream = new EventEmitter() as NodeJS.ReadableStream & EventEmitter;
    const onTruncate = vi.fn();
    const handle = captureRedactedStderr(stream, { maxBytes: 1024, onTruncate });

    // Emit 2KB of plain text in one chunk → triggers the cap.
    stream.emit("data", Buffer.from("x".repeat(2048)));
    expect(onTruncate).toHaveBeenCalledTimes(1);

    // Subsequent chunks are dropped on the floor.
    stream.emit("data", Buffer.from("more text"));
    expect(onTruncate).toHaveBeenCalledTimes(1);

    const snap = handle.getSnapshot();
    expect(snap.truncated).toBe(true);
    expect(snap.capturedRedacted.length).toBeLessThanOrEqual(1024);
    expect(snap.byteCount).toBe(2048);
  });

  it("caps by UTF-8 bytes, not JavaScript string length", () => {
    const stream = new EventEmitter() as NodeJS.ReadableStream & EventEmitter;
    const onTruncate = vi.fn();
    const handle = captureRedactedStderr(stream, { maxBytes: 1024, onTruncate });

    // Each "é" is 2 bytes in UTF-8. A character-count cap would let
    // this entire 1400-byte payload through; the sandbox cap is byte-based.
    stream.emit("data", Buffer.from("é".repeat(700), "utf8"));

    const snap = handle.getSnapshot();
    expect(onTruncate).toHaveBeenCalledTimes(1);
    expect(snap.truncated).toBe(true);
    expect(Buffer.byteLength(snap.capturedRedacted, "utf8")).toBeLessThanOrEqual(1024);
    expect(snap.byteCount).toBe(1400);
  });
});
