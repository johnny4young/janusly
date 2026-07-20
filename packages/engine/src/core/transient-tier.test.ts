/**
 * Tests for the transient-error fast path. The module is pure, so the
 * matrix here IS the contract: which errors are transient, which are pointedly
 * not, the write-side hard line, ladder exhaustion, and the crash-resume read.
 */

import { describe, expect, it } from "vitest";

import type { SerializedError } from "./types";
import {
  TRANSIENT_LADDER_MS,
  classifyTransient,
  decideTransient,
  isTransientTierEnabled,
  transientAttemptFromCounters,
} from "./transient-tier";

function err(overrides: Partial<SerializedError>): SerializedError {
  return { message: "boom", ...overrides };
}

describe("classifyTransient", () => {
  it("maps a 429 to rate_limit", () => {
    expect(classifyTransient(err({ statusCode: 429, message: "Too Many Requests" }))).toBe("rate_limit");
  });

  it("maps timeouts by message and by code", () => {
    expect(classifyTransient(err({ message: "Node timed out after 30000ms" }))).toBe("timeout");
    expect(classifyTransient(err({ code: "ETIMEDOUT", message: "socket hang up" }))).toBe("timeout");
  });

  it("maps connection faults by code and by message", () => {
    expect(classifyTransient(err({ code: "ECONNRESET", message: "reset" }))).toBe("connection");
    expect(classifyTransient(err({ code: "ENOTFOUND", message: "dns" }))).toBe("connection");
    expect(classifyTransient(err({ code: "ECONNREFUSED", message: "refused" }))).toBe("connection");
    expect(classifyTransient(err({ message: "network unreachable" }))).toBe("connection");
  });

  it("does NOT treat a 503 or a 500 as transient — a server fault may need a real fix", () => {
    expect(classifyTransient(err({ statusCode: 503, message: "Service Unavailable" }))).toBeNull();
    expect(classifyTransient(err({ statusCode: 500, message: "Internal Server Error" }))).toBeNull();
  });

  it("does NOT treat ordinary application failures as transient", () => {
    expect(classifyTransient(err({ statusCode: 404, message: "Not Found" }))).toBeNull();
    expect(classifyTransient(err({ statusCode: 401, message: "Unauthorized" }))).toBeNull();
    expect(classifyTransient(err({ message: "Template '{{context.x}}' could not resolve" }))).toBeNull();
  });

  it("prefers timeout over connection when an error carries both flavours", () => {
    // ETIMEDOUT adds the `timeout` label; the longer ladder is the safer read.
    expect(classifyTransient(err({ code: "ETIMEDOUT", message: "network timeout" }))).toBe("timeout");
  });
});

describe("decideTransient", () => {
  it("walks the class ladder and then dead-letters", () => {
    const error = err({ statusCode: 429, message: "rate limited" });
    const ladder = TRANSIENT_LADDER_MS.rate_limit;

    for (let step = 0; step < ladder.length; step += 1) {
      const decision = decideTransient({ error, transientAttempt: step, enabled: true });
      expect(decision).toEqual({
        kind: "transient_retry",
        transientClass: "rate_limit",
        delayMs: ladder[step],
        transientAttempt: step + 1,
        ladderLength: ladder.length,
      });
    }

    // Ladder spent → the DLQ finally gets it.
    expect(decideTransient({ error, transientAttempt: ladder.length, enabled: true })).toEqual({ kind: "dead_letter" });
  });

  it("NEVER retries a write-side error, even a textbook-transient one", () => {
    // The hard line: a possibly-committed external write is an operator
    // decision — duplicate side effects are worse than a dead letter.
    const decision = decideTransient({
      error: err({ statusCode: 429, message: "rate limited", writeSide: true }),
      transientAttempt: 0,
      enabled: true,
    });
    expect(decision).toEqual({ kind: "dead_letter" });
  });

  it("dead-letters non-transient errors and respects the kill switch", () => {
    expect(decideTransient({ error: err({ statusCode: 404, message: "nope" }), transientAttempt: 0, enabled: true }))
      .toEqual({ kind: "dead_letter" });
    expect(decideTransient({ error: err({ statusCode: 429, message: "rate limited" }), transientAttempt: 0, enabled: false }))
      .toEqual({ kind: "dead_letter" });
  });

  it("gives each class its own ladder", () => {
    const first = (statusCodeOrCode: Partial<SerializedError>) =>
      decideTransient({ error: err(statusCodeOrCode), transientAttempt: 0, enabled: true });

    expect(first({ statusCode: 429 })).toMatchObject({ delayMs: TRANSIENT_LADDER_MS.rate_limit[0] });
    expect(first({ code: "ECONNRESET" })).toMatchObject({ delayMs: TRANSIENT_LADDER_MS.connection[0] });
    expect(first({ message: "timed out" })).toMatchObject({ delayMs: TRANSIENT_LADDER_MS.timeout[0] });
  });
});

describe("transientAttemptFromCounters", () => {
  it("starts the ladder at 0 on the attempt that exhausts the node's retries", () => {
    // No retry config (maxAttempts defaults to 1): the first failure is rung 0.
    expect(transientAttemptFromCounters(1, 1)).toBe(0);
    // maxAttempts=3: attempts 1-3 are ordinary retries, so 3 is rung 0.
    expect(transientAttemptFromCounters(3, 3)).toBe(0);
  });

  it("walks the ladder with the persisted attempt counter (crash-resume for free)", () => {
    expect(transientAttemptFromCounters(4, 3)).toBe(1);
    expect(transientAttemptFromCounters(5, 3)).toBe(2);
    expect(transientAttemptFromCounters(6, 3)).toBe(3);
  });

  it("clamps defensively for legacy / stale counters", () => {
    expect(transientAttemptFromCounters(1, 3)).toBe(0);
    expect(transientAttemptFromCounters(1, 0)).toBe(0);
  });
});

describe("isTransientTierEnabled", () => {
  it("defaults ON and opts out only on the explicit string 'false'", () => {
    expect(isTransientTierEnabled({})).toBe(true);
    expect(isTransientTierEnabled({ JANUSLY_TRANSIENT_TIER_ENABLED: "true" })).toBe(true);
    expect(isTransientTierEnabled({ JANUSLY_TRANSIENT_TIER_ENABLED: "false" })).toBe(false);
  });
});
