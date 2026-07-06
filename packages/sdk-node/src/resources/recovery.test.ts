import { describe, expect, it, vi } from "vitest";
import { RecoveryResource } from "./recovery.ts";
import type { JanuslyClientConfig, RecoveryMetrics } from "../types.ts";

type FakeFetch = ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

function makeConfig(fetchImpl: FakeFetch): JanuslyClientConfig {
  return {
    baseUrl: "https://api.test.example.com",
    orgId: "org-1",
    auth: { kind: "service-token", token: "tk" },
    fetch: fetchImpl,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const SAMPLE_METRICS: RecoveryMetrics = {
  successRate: { value: 92, display: "92%", severity: "healthy", rationale: "ok", rationaleCode: "success_rate_healthy" },
  mttr: { value: 120_000, display: "2m", severity: "warn", rationale: "ok", rationaleCode: "mttr_warn" },
  p95Latency: { value: 4500, display: "4.5s", severity: "healthy", rationale: "ok", rationaleCode: "latency_healthy" },
  approvalsPending: { value: 3, display: "3", severity: "neutral", rationale: "ok", rationaleCode: "approvals_neutral" },
  replayRate: { value: 0.04, display: "4%", severity: "healthy", rationale: "ok", rationaleCode: "replay_healthy" },
  slaAttainment: {
    value: 90,
    display: "90.0%",
    severity: "healthy",
    rationale: "9 of 10 resolved within SLA.",
    rationaleCode: "sla_attainment.summary",
    rationaleMeta: { metSla: 9, resolvedInWindow: 10 },
    resolvedInWindow: 10,
    metSla: 9,
  },
  costThisWindow: {
    value: 12.5,
    display: "$12.50",
    severity: "healthy",
    rationale: "ok",
    rationaleCode: "cost_healthy",
    providers: [{ provider: "anthropic", costUsd: 12.5, spendShare: 1.0 }],
  },
  windowDays: 30,
  terminalRuns: 87,
  mttrTrend: [
    { day: "2026-07-01", seconds: 300 },
    { day: "2026-07-02", seconds: 180 },
  ],
  downtimeEndedMs: 480_000,
};

describe("RecoveryResource.getMetrics", () => {
  it("GETs /recovery/metrics without query when windowDays omitted", async () => {
    const captured: Array<{ url: string }> = [];
    const fetchImpl = vi.fn(async (url: unknown) => {
      captured.push({ url: String(url) });
      return jsonResponse(SAMPLE_METRICS);
    }) as unknown as FakeFetch;
    const recovery = new RecoveryResource(makeConfig(fetchImpl));
    const result = await recovery.getMetrics();
    expect(result).toEqual(SAMPLE_METRICS);
    expect(captured[0]!.url).toBe("https://api.test.example.com/recovery/metrics");
  });

  it("appends windowDays when provided", async () => {
    const captured: Array<{ url: string }> = [];
    const fetchImpl = vi.fn(async (url: unknown) => {
      captured.push({ url: String(url) });
      return jsonResponse(SAMPLE_METRICS);
    }) as unknown as FakeFetch;
    const recovery = new RecoveryResource(makeConfig(fetchImpl));
    await recovery.getMetrics({ windowDays: 14 });
    const url = new URL(captured[0]!.url);
    expect(url.searchParams.get("windowDays")).toBe("14");
  });
});
