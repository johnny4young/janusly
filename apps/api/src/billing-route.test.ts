/**
 * Tests for the `?breakdown=` parser used by `GET /billing/usage`. The
 * route handler itself reads the parser output and dispatches to
 * `getUsageSummary` / `getUsageBreakdown`, so the parser is the only
 * load-bearing logic — the dispatch is straight-line.
 */
import { describe, expect, it } from "vitest";
import { isUsageBreakdownDimension, type UsageBreakdownDimension } from "@janusly/engine/src/billing";

/**
 * Mirrors the route-handler's parsing logic. Pulled out so we can pin
 * it without standing up the HTTP dispatcher. The route delegates to
 * the same comma-split + isUsageBreakdownDimension chain.
 */
function parseBreakdownQuery(raw: string | null): { dimensions: UsageBreakdownDimension[] } | { error: string } {
  const tokens = (raw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const dimensions: UsageBreakdownDimension[] = [];
  for (const token of tokens) {
    if (!isUsageBreakdownDimension(token)) {
      return { error: `Unknown breakdown dimension: ${token}` };
    }
    if (!dimensions.includes(token)) dimensions.push(token);
  }
  return { dimensions };
}

describe("/billing/usage breakdown query parser", () => {
  it("returns empty dimensions when ?breakdown= is unset (back-compat path)", () => {
    expect(parseBreakdownQuery(null)).toEqual({ dimensions: [] });
  });

  it("returns empty dimensions when ?breakdown= is the empty string", () => {
    expect(parseBreakdownQuery("")).toEqual({ dimensions: [] });
  });

  it("parses a single dimension", () => {
    expect(parseBreakdownQuery("provider")).toEqual({ dimensions: ["provider"] });
  });

  it("parses multiple comma-separated dimensions in order", () => {
    expect(parseBreakdownQuery("provider,model,mode")).toEqual({
      dimensions: ["provider", "model", "mode"],
    });
  });

  it("accepts the node and workflow dimensions (the operator-grade axes)", () => {
    expect(parseBreakdownQuery("node")).toEqual({ dimensions: ["node"] });
    expect(parseBreakdownQuery("workflow")).toEqual({ dimensions: ["workflow"] });
    expect(parseBreakdownQuery("workflow,node")).toEqual({ dimensions: ["workflow", "node"] });
  });

  it("trims whitespace around dimension tokens", () => {
    expect(parseBreakdownQuery(" provider , model ")).toEqual({
      dimensions: ["provider", "model"],
    });
  });

  it("dedupes repeated dimensions while preserving first-occurrence order", () => {
    expect(parseBreakdownQuery("provider,provider,model,provider")).toEqual({
      dimensions: ["provider", "model"],
    });
  });

  it("rejects an unknown dimension with a 400-shaped error envelope", () => {
    const result = parseBreakdownQuery("provider,evil");
    expect(result).toHaveProperty("error");
    if ("error" in result) {
      expect(result.error).toContain("evil");
      expect(result.error).toContain("Unknown breakdown dimension");
    }
  });

  it("rejects on the first invalid token even when valid tokens follow", () => {
    const result = parseBreakdownQuery("evil,provider");
    expect(result).toHaveProperty("error");
    if ("error" in result) {
      expect(result.error).toContain("evil");
    }
  });

  it("ignores empty tokens between commas (e.g. `,provider,,model,`)", () => {
    expect(parseBreakdownQuery(",provider,,model,")).toEqual({
      dimensions: ["provider", "model"],
    });
  });
});
