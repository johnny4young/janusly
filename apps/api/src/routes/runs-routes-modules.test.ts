import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { matchesRoute } from "../routes";
import { runsRoutes } from "./runs-routes";
import { runDiagnosticRoutes } from "./run-routes/diagnostics";
import { runLifecycleRoutes } from "./run-routes/lifecycle";
import { runReadRoutes } from "./run-routes/reads";
import { runRedriveRoutes } from "./run-routes/redrive";
import { replayLabRoutes } from "./run-routes/replay-lab";
import { runStreamRoutes } from "./run-routes/stream";

const ROUTE_MODULES = {
  diagnostics: runDiagnosticRoutes,
  lifecycle: runLifecycleRoutes,
  reads: runReadRoutes,
  redrive: runRedriveRoutes,
  "replay-lab": replayLabRoutes,
  stream: runStreamRoutes,
} as const;

const ORDERED_SEGMENTS = [
  runStreamRoutes,
  runReadRoutes,
  runRedriveRoutes,
  runLifecycleRoutes,
  replayLabRoutes,
  runDiagnosticRoutes,
] as const;

const EXPECTED_ROUTE_COUNTS = {
  diagnostics: 2,
  lifecycle: 3,
  reads: 4,
  redrive: 1,
  "replay-lab": 2,
  stream: 1,
} as const;

describe("run route module architecture", () => {
  it("preserves the first-match route composition and stable public surface", async () => {
    const registry = await import("./runs-routes");
    const composed = ORDERED_SEGMENTS.flatMap((routes) => routes);

    expect(runsRoutes).toEqual(composed);
    expect(runsRoutes).toHaveLength(13);
    expect(new Set(runsRoutes).size).toBe(runsRoutes.length);
    expect(Object.keys(registry)).toEqual(["runsRoutes"]);
  });

  it("keeps every responsibility segment complete", () => {
    for (const [name, routes] of Object.entries(ROUTE_MODULES)) {
      expect(routes, name).toHaveLength(
        EXPECTED_ROUTE_COUNTS[name as keyof typeof EXPECTED_ROUTE_COUNTS],
      );
    }

    expect(matchesRoute(runStreamRoutes[0]!.match, "/runs/run-1/stream")).toBe(true);
    expect(matchesRoute(runReadRoutes[0]!.match, "/run/usage?runId=run-1")).toBe(true);
    expect(matchesRoute(runReadRoutes[1]!.match, "/runs?limit=1")).toBe(true);
    expect(matchesRoute(runReadRoutes[2]!.match, "/run?runId=run-1")).toBe(true);
    expect(matchesRoute(runReadRoutes[3]!.match, "/status?runId=run-1")).toBe(true);
    expect(matchesRoute(runReadRoutes[1]!.match, "/runs/run-1/stream")).toBe(true);
    expect(matchesRoute(runReadRoutes[1]!.match, "/runs/compare?baseRunId=a&replayRunId=b"))
      .toBe(false);
    expect(runsRoutes.findIndex((route) => (
      route.method === "GET" && matchesRoute(route.match, "/runs/run-1/stream")
    ))).toBe(0);
    expect(matchesRoute(
      runDiagnosticRoutes[0]!.match,
      "/runs/compare?baseRunId=a&replayRunId=b",
    )).toBe(true);
    expect(matchesRoute(
      runDiagnosticRoutes[1]!.match,
      "/causal?runId=a&eventId=b&nodeId=c",
    )).toBe(true);
  });

  it("keeps the internal inventory bounded, acyclic, and off the registry barrel", () => {
    const files = readdirSync(new URL("./run-routes", import.meta.url))
      .filter((name) => name.endsWith(".ts"))
      .sort();

    expect(files).toEqual(Object.keys(ROUTE_MODULES).map((name) => `${name}.ts`).sort());
    expect(existsSync(new URL("./runs-routes", import.meta.url))).toBe(false);

    for (const file of files) {
      const source = readFileSync(new URL(`./run-routes/${file}`, import.meta.url), "utf8");
      expect(source.split("\n").length, file).toBeLessThanOrEqual(700);
      expect(source).not.toMatch(/from\s+["']\.\.\/runs-routes["']/);
      expect(source).not.toMatch(/from\s+["']\.\//);
    }
  });
});
