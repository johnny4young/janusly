import { describe, expect, it } from "vitest";

import { sanitizeConsideredAlternatives } from "./ai-patch-alternatives";

describe("sanitizeConsideredAlternatives", () => {
  it("bounds, flattens, and scrubs model-authored summaries", () => {
    const secret = `sk-${"a".repeat(20)}`;
    expect(sanitizeConsideredAlternatives([
      { approach: `  Raise\ntimeout ${secret}`, rejectedBecause: "Adds latency\u202ewithout fixing auth." },
      { approach: "Swap provider", rejectedBecause: "Not configured for this tenant." },
      { approach: "Third", rejectedBecause: "Must be dropped." },
    ])).toEqual([
      { approach: "Raise timeout [redacted]", rejectedBecause: "Adds latency without fixing auth." },
      { approach: "Swap provider", rejectedBecause: "Not configured for this tenant." },
    ]);
  });

  it("drops malformed or incomplete rows", () => {
    expect(sanitizeConsideredAlternatives([null, {}, { approach: "Retry", rejectedBecause: "" }])).toEqual([]);
    expect(sanitizeConsideredAlternatives(null)).toEqual([]);
  });

  it("scrubs DSNs, provider tokens, and private-key blocks", () => {
    const privateKey = "-----BEGIN PRIVATE KEY-----\nvery-secret-material\n-----END PRIVATE KEY-----";
    const rows = sanitizeConsideredAlternatives([
      {
        approach: `Query postgres://operator:password@db.internal/acme with sk-ant-${"a".repeat(24)}`,
        rejectedBecause: `Would expose ${privateKey}`,
      },
    ]);

    expect(rows).toEqual([{
      approach: "Query [redacted] with [redacted]",
      rejectedBecause: "Would expose [redacted]",
    }]);
  });
});
