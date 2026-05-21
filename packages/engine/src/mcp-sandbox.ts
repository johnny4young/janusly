/**
 * Sandbox profile builder + stderr capture for stdio MCP child processes.
 *
 * Pure module — no spawn, no I/O outside the explicit `mkdtempSync`
 * injection. Used by `mcp-client.ts`'s stdio factory to compute the
 * effective spawn config (potentially wrapped through `/bin/sh -c
 * 'ulimit -v "$1"; shift; exec "$@"'` on production Linux) and to
 * consume the child's stderr stream into a bounded, secret-shape
 * redacted buffer.
 *
 * Five defensive layers, applied in order:
 *
 *   a. **Command allowlist re-check.** Empty allowlist or command not
 *      in the list → throws `McpSandboxCommandNotAllowedError` BEFORE
 *      the SDK opens any transport. Defense in depth against allowlist
 *      drift after a connection is registered.
 *   b. **Ephemeral cwd.** Each spawn gets its own `mkdtemp` directory.
 *      The child's working dir is confined to it (best effort — NOT
 *      chroot; the child can still write absolute paths). Cleanup is
 *      the caller's responsibility (it owns the directory path).
 *   c. **Lifetime cap.** The caller installs a `setTimeout` that
 *      eventually SIGTERMs the child and (after a grace period)
 *      SIGKILLs. The default 600s window matches "long-lived MCP
 *      worker should never sit idle for ten minutes without traffic".
 *   d. **Stderr byte cap with secret-shape redaction.** The caller
 *      hands the child's stderr stream to `captureRedactedStderr`,
 *      which buffers raw bytes (bounded), runs `scrubSecretShapes` at
 *      snapshot time, and invokes the caller-supplied `onTruncate`
 *      callback when the cap is exceeded so the caller can kill the
 *      child.
 *   e. **Linux `ulimit -v` wrap (opt-in).** When `process.platform ===
 *      'linux'` AND `enforceLinuxUlimit === true`, the original
 *      command is wrapped via `/bin/sh -c 'ulimit -v "$1"; shift; exec
 *      "$@"' janusly-mcp-sandbox <vm_kb> <orig-cmd> <orig-args...>`.
 *      Portable POSIX shell — works on every system that has `/bin/sh`.
 *      The shell-tag `janusly-mcp-sandbox` becomes `$0` and never
 *      appears in the executed command.
 *
 * Used by:
 * - `packages/engine/src/mcp-client.ts` — `createStdioMcpClient` applies
 *   the profile, intercepts stderr, kills on lifetime cap, and removes
 *   the ephemeral cwd dir on `close()`.
 *
 * Invariants:
 * - The `cwd` is best-effort, NOT a security boundary. The threat model
 *   is "limit casual reads from the worker tree", not "block determined
 *   attacker". Real isolation needs `firejail` / container namespaces.
 * - The captured stderr buffer is RAW between chunks; redaction runs
 *   only at snapshot time. The closure ensures the raw buffer never
 *   leaks — `getSnapshot()` always returns a scrubbed string. This way
 *   secret prefixes that straddle two chunk boundaries are still
 *   scrubbed by the time the snapshot is taken.
 * - `maxVmKb` only applies on Linux. macOS / Windows get the cwd +
 *   lifetime + stderr layers but skip the memory wrap entirely.
 *   "Linux-primary" posture is intentional and documented in AGENTS.md.
 */

import { scrubSecretShapes } from "@janusly/shared/src/error-signature";

/** Defaults. Exposed for tests + the org_config catalog's default cells. */
export const SANDBOX_DEFAULT_LIFETIME_MS = 600_000;
export const SANDBOX_DEFAULT_STDERR_BYTES = 65_536;
export const SANDBOX_DEFAULT_VM_KB = 524_288;

/** Hard clamps. Below MIN_VM_KB the JS heap can't start cleanly. */
export const SANDBOX_MIN_LIFETIME_MS = 60_000;
export const SANDBOX_MAX_LIFETIME_MS = 3_600_000;
export const SANDBOX_MIN_STDERR_BYTES = 1024;
export const SANDBOX_MAX_STDERR_BYTES = 1_048_576;
export const SANDBOX_MIN_VM_KB = 131_072;
export const SANDBOX_MAX_VM_KB = 4_194_304;

/** Grace period between SIGTERM and SIGKILL on lifetime kill. */
export const SANDBOX_KILL_GRACE_MS = 500;

export type SandboxProfileInput = {
  command: string;
  args: string[];
  /** Pass `process.platform` in production; tests pass `'darwin'` / `'win32'`. */
  platform: NodeJS.Platform;
  /** Union of env CSV + tenant CSV. Already parsed + trimmed by the caller. */
  allowedCommands: string[];
  maxLifetimeMs?: number;
  maxStderrBytes?: number;
  /** Ignored when `platform !== 'linux'` or `enforceLinuxUlimit === false`. */
  maxVmKb?: number;
  enforceLinuxUlimit: boolean;
  /** Pass `os.tmpdir()` in production. */
  tempDir: string;
  /** Pass `fs.mkdtempSync` in production; tests pass a deterministic stub. */
  mkdtempSync: (prefix: string) => string;
};

export type SandboxProfile = {
  wrappedCommand: string;
  wrappedArgs: string[];
  /** Absolute path to the ephemeral cwd dir. The caller is responsible for cleanup. */
  cwd: string;
  maxLifetimeMs: number;
  maxStderrBytes: number;
  /** True when the Linux `ulimit -v` wrap is applied. False on macOS / Windows. */
  enforced: boolean;
};

/** Thrown by `buildSandboxProfile` when the allowlist rejects the command. */
export class McpSandboxCommandNotAllowedError extends Error {
  readonly code = "mcp_sandbox_command_rejected" as const;
  readonly command: string;
  readonly reason: "allowlist_empty" | "command_not_in_allowlist";
  constructor(command: string, reason: "allowlist_empty" | "command_not_in_allowlist") {
    super(
      reason === "allowlist_empty"
        ? "stdio command allowlist is empty (fail-closed)"
        : `stdio command "${command}" not in allowlist`,
    );
    this.name = "McpSandboxCommandNotAllowedError";
    this.command = command;
    this.reason = reason;
  }
}

/** Thrown by the lifetime watchdog when the child outlives `maxLifetimeMs`. */
export class McpSandboxLifetimeExceededError extends Error {
  readonly code = "mcp_sandbox_lifetime_exceeded" as const;
  constructor(maxLifetimeMs: number) {
    super(`mcp stdio child exceeded lifetime cap (${maxLifetimeMs}ms)`);
    this.name = "McpSandboxLifetimeExceededError";
  }
}

/** Thrown by the stderr capture when the child writes past the byte cap. */
export class McpSandboxStderrExceededError extends Error {
  readonly code = "mcp_sandbox_stderr_exceeded" as const;
  constructor(maxBytes: number) {
    super(`mcp stdio child exceeded stderr cap (${maxBytes} bytes)`);
    this.name = "McpSandboxStderrExceededError";
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/**
 * Compute the spawn profile. Throws if the allowlist rejects the command;
 * otherwise allocates the ephemeral cwd, clamps the caller-supplied caps,
 * and returns the wrapped command shape.
 */
export function buildSandboxProfile(input: SandboxProfileInput): SandboxProfile {
  // a. Allowlist re-check. Spawn-time enforcement — defense in depth
  // against the registration-time list having drifted.
  if (input.allowedCommands.length === 0) {
    throw new McpSandboxCommandNotAllowedError(input.command, "allowlist_empty");
  }
  if (!input.allowedCommands.includes(input.command)) {
    throw new McpSandboxCommandNotAllowedError(input.command, "command_not_in_allowlist");
  }

  // b. Ephemeral cwd. The caller cleans up on close(); a leaked dir
  // here lives in /tmp until the OS rolls it.
  const cwd = input.mkdtempSync(joinTempPrefix(input.tempDir, "janusly-mcp-"));

  // c + d. Caps with hard clamps.
  const maxLifetimeMs = clamp(
    input.maxLifetimeMs ?? SANDBOX_DEFAULT_LIFETIME_MS,
    SANDBOX_MIN_LIFETIME_MS,
    SANDBOX_MAX_LIFETIME_MS,
  );
  const maxStderrBytes = clamp(
    input.maxStderrBytes ?? SANDBOX_DEFAULT_STDERR_BYTES,
    SANDBOX_MIN_STDERR_BYTES,
    SANDBOX_MAX_STDERR_BYTES,
  );

  // e. Linux ulimit -v wrap. Gated by platform AND opt-in flag. The
  // wrap form `sh -c 'ulimit -v "$1"; shift; exec "$@"' <tag> <kb> <cmd> <args...>`
  // is portable POSIX — the `<tag>` becomes $0 and never reaches the
  // executed command. After `shift`, $@ holds <cmd> + <args>, so
  // quoting is preserved exactly through `exec "$@"`.
  if (input.platform === "linux" && input.enforceLinuxUlimit) {
    const vmKb = clamp(input.maxVmKb ?? SANDBOX_DEFAULT_VM_KB, SANDBOX_MIN_VM_KB, SANDBOX_MAX_VM_KB);
    return {
      wrappedCommand: "/bin/sh",
      wrappedArgs: [
        "-c",
        'ulimit -v "$1"; shift; exec "$@"',
        "janusly-mcp-sandbox",
        String(vmKb),
        input.command,
        ...input.args,
      ],
      cwd,
      maxLifetimeMs,
      maxStderrBytes,
      enforced: true,
    };
  }

  // Non-Linux or opt-out: unwrapped command. The cwd + lifetime +
  // stderr layers still apply.
  return {
    wrappedCommand: input.command,
    wrappedArgs: [...input.args],
    cwd,
    maxLifetimeMs,
    maxStderrBytes,
    enforced: false,
  };
}

/** OS-agnostic temp-prefix join. Avoids pulling in `path` for one operation. */
function joinTempPrefix(tempDir: string, prefix: string): string {
  if (tempDir.endsWith("/") || tempDir.endsWith("\\")) return tempDir + prefix;
  return tempDir + "/" + prefix;
}

export type StderrCaptureSnapshot = {
  /** Redacted captured stderr. Bounded by `maxBytes`. */
  capturedRedacted: string;
  /** True when the child wrote past the cap and was (or should be) killed. */
  truncated: boolean;
  /** Total bytes consumed from the source stream before truncation. */
  byteCount: number;
};

export type StderrCaptureHandle = {
  /** Pure snapshot: run scrub at read time. The internal raw buffer never leaks. */
  getSnapshot(): StderrCaptureSnapshot;
  /** Stop listening (called by mcp-client on `close()`). */
  dispose(): void;
};

/**
 * Wire up a Readable-like stream and return a handle that exposes the
 * snapshot. The handle's `getSnapshot()` scrubs the entire captured
 * buffer through `scrubSecretShapes` before returning — chunk-boundary
 * secret splits are tolerated because the scrub sees the whole buffer
 * at once.
 *
 * When the child writes past `maxBytes`, the capture sets `truncated:
 * true`, stops appending, and invokes `onTruncate` (the caller wires
 * that to kill the child).
 *
 * Robust to `stream === null` (some StdioClientTransport options yield
 * no stderr stream). In that case `getSnapshot()` returns an empty
 * snapshot and `dispose()` is a no-op.
 */
export function captureRedactedStderr(
  stream: NodeJS.ReadableStream | null,
  options: { maxBytes: number; onTruncate?: () => void },
): StderrCaptureHandle {
  const maxBytes = Math.max(SANDBOX_MIN_STDERR_BYTES, Math.min(SANDBOX_MAX_STDERR_BYTES, options.maxBytes));
  let rawBuffer = Buffer.alloc(0);
  let byteCount = 0;
  let truncated = false;
  let active = stream !== null;

  function onData(chunk: unknown) {
    if (!active || truncated) return;
    const bytes = chunk instanceof Buffer
      ? chunk
      : typeof chunk === "string"
        ? Buffer.from(chunk, "utf8")
        : Buffer.alloc(0);
    const incomingBytes = bytes.length;
    byteCount += incomingBytes;
    if (rawBuffer.length + incomingBytes > maxBytes) {
      // Append up to the cap, then mark truncated so subsequent
      // chunks are dropped on the floor (and trigger the kill).
      const remaining = Math.max(0, maxBytes - rawBuffer.length);
      if (remaining > 0) rawBuffer = Buffer.concat([rawBuffer, bytes.subarray(0, remaining)]);
      truncated = true;
      if (options.onTruncate) {
        try {
          options.onTruncate();
        } catch {
          // Caller's kill path may throw if the child already exited;
          // dropping silently keeps this capture's contract simple.
        }
      }
      return;
    }
    rawBuffer = Buffer.concat([rawBuffer, bytes]);
  }

  if (stream) {
    stream.on("data", onData);
  }

  return {
    getSnapshot() {
      // Scrub at snapshot time so secret prefixes split across two
      // chunks (e.g. `sk-FAK` + `E0123…`) still match the regex once
      // the whole buffer is concatenated.
      const capturedRedacted = truncateUtf8(scrubSecretShapes(rawBuffer.toString("utf8")), maxBytes);
      return { capturedRedacted, truncated, byteCount };
    },
    dispose() {
      if (!active) return;
      active = false;
      if (stream) {
        try {
          stream.off("data", onData);
        } catch {
          // Some streams may not support `off`; ignore.
        }
      }
    },
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  let used = 0;
  let out = "";
  for (const char of value) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return out;
}
