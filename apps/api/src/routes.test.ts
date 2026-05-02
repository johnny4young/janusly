import { describe, expect, it } from "vitest";
import { matchesRoute } from "./routes";

describe("matchesRoute", () => {
  it("matches exact URL strings", () => {
    expect(matchesRoute("/health", "/health")).toBe(true);
    expect(matchesRoute("/health", "/health?verbose=true")).toBe(false);
  });

  it("matches predicate routes", () => {
    expect(matchesRoute((url) => url.startsWith("/runs"), "/runs?limit=10")).toBe(true);
    expect(matchesRoute((url) => url.startsWith("/runs"), "/run?runId=1")).toBe(false);
  });
});
