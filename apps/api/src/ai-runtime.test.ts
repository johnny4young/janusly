/**
 * Pure-unit tests for `resolveSurfaceModel` — the per-surface model
 * precedence helper. The per-request override wins, then the org's
 * per-surface default, then `undefined` (the LLM client's global default).
 */
import { describe, expect, it } from "vitest";

import { resolveSurfaceModel } from "./ai-runtime";

describe("resolveSurfaceModel", () => {
  const map = { "patch-workflow": "claude-sonnet-4-5", "generate-workflow": "claude-haiku-4-5" };

  it("prefers the per-request override over the per-surface default", () => {
    expect(resolveSurfaceModel(map, "patch-workflow", "anthropic/claude-opus-4")).toBe(
      "anthropic/claude-opus-4",
    );
  });

  it("trims a per-request override before routing", () => {
    expect(resolveSurfaceModel(map, "patch-workflow", " anthropic/claude-opus-4 ")).toBe(
      "anthropic/claude-opus-4",
    );
  });

  it("falls back to the per-surface default when no request override", () => {
    expect(resolveSurfaceModel(map, "patch-workflow")).toBe("claude-sonnet-4-5");
    expect(resolveSurfaceModel(map, "generate-workflow", undefined)).toBe("claude-haiku-4-5");
  });

  it("treats a blank request override as unset", () => {
    expect(resolveSurfaceModel(map, "patch-workflow", "")).toBe("claude-sonnet-4-5");
    expect(resolveSurfaceModel(map, "patch-workflow", "   ")).toBe("claude-sonnet-4-5");
  });

  it("ignores blank surface defaults after trimming", () => {
    expect(resolveSurfaceModel({ "patch-workflow": "   " }, "patch-workflow")).toBeUndefined();
  });

  it("returns undefined when neither override nor surface default is set", () => {
    expect(resolveSurfaceModel({}, "review-workflow")).toBeUndefined();
    expect(resolveSurfaceModel(map, "review-workflow")).toBeUndefined();
  });
});
