/**
 * Pins the contract for `composeFeedbackHint` — the pure helper that
 * turns aggregated `recovery_feedback` rows into a one-line hint
 * string for the patch-workflow prompt. No DB, no I/O — every case
 * stands on the structural shape alone.
 */
import { describe, expect, it } from "vitest";
import type { FeedbackSummary } from "@janusly/data/src/recoveryFeedbackRepo";
import { MAX_HINT_CHARS, RecoveryFeedbackBodySchema, composeFeedbackHint } from "./ai-patch-feedback";

describe("composeFeedbackHint", () => {
  it("returns an empty string when the summary is empty (first-time recovery)", () => {
    expect(composeFeedbackHint([])).toBe("");
  });

  it("renders accepted/rejected counts + a quoted rejection comment for one approach", () => {
    const summary: FeedbackSummary[] = [
      {
        approachLabel: "add_retry",
        acceptedCount: 1,
        rejectedCount: 2,
        rejectionComments: ["timeout still fires under load", "Wrong approach"],
      },
    ];
    const hint = composeFeedbackHint(summary);
    expect(hint).toContain("add_retry");
    expect(hint).toContain("accepted 1/3");
    // The most recent rejection comment is inlined as the example reason.
    expect(hint).toContain("timeout still fires");
  });

  it("joins multiple approaches with semicolons", () => {
    const summary: FeedbackSummary[] = [
      { approachLabel: "add_retry", acceptedCount: 0, rejectedCount: 2, rejectionComments: ["Wrong approach"] },
      { approachLabel: "raise_timeout", acceptedCount: 1, rejectedCount: 0, rejectionComments: [] },
    ];
    const hint = composeFeedbackHint(summary);
    expect(hint).toMatch(/add_retry.*raise_timeout/);
    expect(hint).toContain(";");
  });

  it("scrubs token-shaped substrings out of inlined rejection comments", () => {
    const summary: FeedbackSummary[] = [
      {
        approachLabel: "swap_secret_ref",
        acceptedCount: 0,
        rejectedCount: 1,
        rejectionComments: ["Token Bearer sk-abcdefghijklmnopqrstuvwxyz expired"],
      },
    ];
    const hint = composeFeedbackHint(summary);
    expect(hint).toContain("[redacted]");
    expect(hint).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("truncates the joined hint at MAX_HINT_CHARS with a trailing ellipsis", () => {
    const summary: FeedbackSummary[] = [
      // 6 buckets each with a 60-char comment — together they would
      // overrun MAX_HINT_CHARS ≈ 280.
      { approachLabel: "add_retry", acceptedCount: 0, rejectedCount: 1, rejectionComments: ["a".repeat(60)] },
      { approachLabel: "raise_timeout", acceptedCount: 0, rejectedCount: 1, rejectionComments: ["b".repeat(60)] },
      { approachLabel: "swap_secret_ref", acceptedCount: 0, rejectedCount: 1, rejectionComments: ["c".repeat(60)] },
      { approachLabel: "add_approval", acceptedCount: 0, rejectedCount: 1, rejectionComments: ["d".repeat(60)] },
      { approachLabel: "fix_url", acceptedCount: 0, rejectedCount: 1, rejectionComments: ["e".repeat(60)] },
      { approachLabel: "other", acceptedCount: 0, rejectedCount: 1, rejectionComments: ["f".repeat(60)] },
    ];
    const hint = composeFeedbackHint(summary);
    expect(hint.length).toBeLessThanOrEqual(MAX_HINT_CHARS);
    expect(hint.endsWith("…")).toBe(true);
  });

  it("skips approaches with zero total samples", () => {
    const summary: FeedbackSummary[] = [
      { approachLabel: "add_retry", acceptedCount: 0, rejectedCount: 0, rejectionComments: [] },
    ];
    expect(composeFeedbackHint(summary)).toBe("");
  });
});

describe("RecoveryFeedbackBodySchema", () => {
  const valid = {
    deadLetterId: "dlq-1",
    suggestionMode: "ai" as const,
    approachLabel: "add_retry" as const,
    accepted: true,
    comment: "Worked great",
  };

  it("accepts a fully-populated valid body", () => {
    const result = RecoveryFeedbackBodySchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("accepts a body without `comment`", () => {
    const { comment: _, ...rest } = valid;
    const result = RecoveryFeedbackBodySchema.safeParse(rest);
    expect(result.success).toBe(true);
  });

  it("rejects an unknown approachLabel", () => {
    const result = RecoveryFeedbackBodySchema.safeParse({ ...valid, approachLabel: "guess_and_pray" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown suggestionMode", () => {
    const result = RecoveryFeedbackBodySchema.safeParse({ ...valid, suggestionMode: "telepathy" });
    expect(result.success).toBe(false);
  });

  it("rejects a comment longer than 2000 chars", () => {
    const result = RecoveryFeedbackBodySchema.safeParse({ ...valid, comment: "x".repeat(2001) });
    expect(result.success).toBe(false);
  });

  it("rejects a missing deadLetterId", () => {
    const { deadLetterId: _, ...rest } = valid;
    const result = RecoveryFeedbackBodySchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});
