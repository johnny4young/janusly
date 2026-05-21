import { describe, expect, it, vi } from "vitest";
import { ReportsResource } from "./reports.ts";
import type { JanuslyClientConfig } from "../types.ts";

type FakeFetch = ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

function makeConfig(fetchImpl: FakeFetch): JanuslyClientConfig {
  return {
    baseUrl: "https://api.test.example.com",
    orgId: "org-1",
    auth: { kind: "service-token", token: "tk" },
    fetch: fetchImpl,
  };
}

function reportResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/markdown", ...headers },
  });
}

describe("ReportsResource.exportRunExplain", () => {
  it("downloads a markdown run-explain report with the server filename", async () => {
    const captured: Array<{ url: string }> = [];
    const fetchImpl = vi.fn(async (url: unknown) => {
      captured.push({ url: String(url) });
      return reportResponse("# Report", {
        "content-disposition": "attachment; filename=\"run-explain-run_abc.md\"",
      });
    }) as unknown as FakeFetch;

    const reports = new ReportsResource(makeConfig(fetchImpl));
    const result = await reports.exportRunExplain("run abc");

    const url = new URL(captured[0]!.url);
    expect(url.pathname).toBe("/reports/run-explain");
    expect(url.searchParams.get("runId")).toBe("run abc");
    expect(result).toEqual({
      body: "# Report",
      filename: "run-explain-run_abc.md",
      contentType: "text/markdown",
    });
  });

  it("passes the requested JSON format", async () => {
    const captured: Array<{ url: string }> = [];
    const fetchImpl = vi.fn(async (url: unknown) => {
      captured.push({ url: String(url) });
      return reportResponse("{\"summary\":true}", { "content-type": "application/json" });
    }) as unknown as FakeFetch;

    const reports = new ReportsResource(makeConfig(fetchImpl));
    const result = await reports.exportRunExplain("run-1", { format: "json" });

    const url = new URL(captured[0]!.url);
    expect(url.searchParams.get("format")).toBe("json");
    expect(result.contentType).toBe("application/json");
    expect(result.body).toBe("{\"summary\":true}");
  });

  it("decodes RFC 5987 filenames from Content-Disposition", async () => {
    const fetchImpl = vi.fn(async () =>
      reportResponse("body", {
        "content-disposition": "attachment; filename*=UTF-8''run%20explain.md",
      }),
    ) as unknown as FakeFetch;

    const reports = new ReportsResource(makeConfig(fetchImpl));
    const result = await reports.exportRunExplain("run-1");

    expect(result.filename).toBe("run explain.md");
  });
});
