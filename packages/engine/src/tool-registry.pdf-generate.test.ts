/**
 * Tests for the `pdf.generate` tool. Exercises the full chokepoint:
 * rate-limit gate, render, object-store upload, usage recorder fire,
 * and the AI-fallback envelope on every failure mode.
 *
 * Object store uses a captured-stub via `setObjectStoreForTests` so the
 * test never touches the real S3 SDK or the local filesystem (the
 * filesystem round-trip lives in `object-store.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setObjectStoreForTests, type ObjectStorePutInput, type ObjectStorePutResult } from "./object-store";
import {
  _resetPdfUsageRecorderForTests,
  setPdfUsageRecorder,
  type PdfUsageRecord,
} from "./pdf-usage";
import {
  _resetEngineRateLimiterForTests,
  setEngineRateLimiter,
} from "./rate-limit";
import { executeTool, isToolWriteSide, listTools } from "./tool-registry";

const captured: PdfUsageRecord[] = [];
const uploads: ObjectStorePutInput[] = [];

beforeEach(() => {
  captured.length = 0;
  uploads.length = 0;
  _resetEngineRateLimiterForTests();
  _resetPdfUsageRecorderForTests();
  setPdfUsageRecorder((record) => { captured.push(record); });
  setObjectStoreForTests({
    name: "local",
    async put(input): Promise<ObjectStorePutResult> {
      uploads.push(input);
      return { ok: true, provider: "local", url: `test://${input.key}`, key: input.key };
    },
  });
});

afterEach(() => {
  _resetEngineRateLimiterForTests();
  _resetPdfUsageRecorderForTests();
  setObjectStoreForTests(null);
  vi.unstubAllEnvs();
});

describe("pdf.generate — registry", () => {
  it("is registered, write-side, and exposed via listTools", () => {
    expect(isToolWriteSide("pdf.generate")).toBe(true);
    const surfaced = listTools().find((t) => t.name === "pdf.generate");
    expect(surfaced).toBeDefined();
    expect(surfaced?.required).toContain("template");
    expect(surfaced?.optional).toContain("variables");
    expect(surfaced?.optional).toContain("filename");
  });
});

describe("pdf.generate — happy path", () => {
  it("renders, uploads under the per-org key prefix, and fires the usage recorder", async () => {
    const result = await executeTool(
      "pdf.generate",
      {
        template: "# Invoice {{number}}\n\nAmount: **{{amount}}**\n",
        variables: { number: "INV-001", amount: "$100.00" },
        filename: "invoice.pdf",
      },
      {},
      { orgId: "org-1", runId: "run-1", nodeId: "node-1", workflowId: "wf-1" },
    );

    expect(result).toMatchObject({
      ok: true,
      provider: "local",
      key: "orgs/org-1/pdfs/run-1/node-1/invoice.pdf",
      url: "test://orgs/org-1/pdfs/run-1/node-1/invoice.pdf",
    });

    expect(uploads).toHaveLength(1);
    expect(uploads[0].key).toBe("orgs/org-1/pdfs/run-1/node-1/invoice.pdf");
    expect(uploads[0].contentType).toBe("application/pdf");
    expect(uploads[0].body.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      orgId: "org-1",
      runId: "run-1",
      nodeId: "node-1",
      workflowId: "wf-1",
      provider: "local",
      ok: true,
      key: "orgs/org-1/pdfs/run-1/node-1/invoice.pdf",
    });
    expect(captured[0].contentLength).toBeGreaterThan(0);
  });

  it("defaults filename to <nodeId>.pdf when not supplied", async () => {
    await executeTool(
      "pdf.generate",
      { template: "# X" },
      {},
      { orgId: "org-1", runId: "run-1", nodeId: "node-9" },
    );
    expect(uploads[0].key).toBe("orgs/org-1/pdfs/run-1/node-9/node-9.pdf");
  });
});

describe("pdf.generate — failure envelopes", () => {
  it("returns ok:false when the object store rejects, still firing the recorder", async () => {
    setObjectStoreForTests({
      name: "noop",
      async put(): Promise<ObjectStorePutResult> {
        return { ok: false, provider: "noop", error: "Object store not configured" };
      },
    });

    const result = await executeTool(
      "pdf.generate",
      { template: "# X" },
      {},
      { orgId: "org-1", runId: "r1", nodeId: "n1" },
    );

    expect(result).toMatchObject({ ok: false, provider: "noop", error: "Object store not configured" });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ ok: false, provider: "noop" });
  });

  it("returns ok:false when the rate-limit gate trips, BEFORE rendering", async () => {
    setEngineRateLimiter(async () => {
      throw new Error("Rate limit exceeded");
    });

    const result = await executeTool(
      "pdf.generate",
      { template: "# X" },
      {},
      { orgId: "org-1", runId: "r1", nodeId: "n1" },
    );

    expect(result).toMatchObject({ ok: false, error: "Rate limit exceeded" });
    expect(uploads).toHaveLength(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ ok: false, error: "Rate limit exceeded", contentLength: 0 });
  });

  it("rejects an empty template at the input schema layer", async () => {
    await expect(
      executeTool("pdf.generate", { template: "" }, {}, { orgId: "org-1" }),
    ).rejects.toThrow(/Invalid tool input/);
  });

  it("rejects an unsafe filename at the input schema layer", async () => {
    await expect(
      executeTool(
        "pdf.generate",
        { template: "# x", filename: "../escape.pdf" },
        {},
        { orgId: "org-1" },
      ),
    ).rejects.toThrow(/Invalid tool input/);
  });

  it("refuses to run without orgId so the per-org key prefix can never collapse to a shared bucket path", async () => {
    const result = await executeTool(
      "pdf.generate",
      { template: "# X" },
      {},
      {},
    );
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/multi-tenant context/),
    });
    expect(uploads).toHaveLength(0);
    expect(captured).toHaveLength(0);
  });
});

describe("pdf.generate — multi-tenant isolation", () => {
  it("never lets one org's call collide with another org's key prefix", async () => {
    await executeTool(
      "pdf.generate",
      { template: "# A", filename: "report.pdf" },
      {},
      { orgId: "org-A", runId: "r-A", nodeId: "n-1" },
    );
    await executeTool(
      "pdf.generate",
      { template: "# B", filename: "report.pdf" },
      {},
      { orgId: "org-B", runId: "r-B", nodeId: "n-1" },
    );

    expect(uploads.map((u) => u.key)).toEqual([
      "orgs/org-A/pdfs/r-A/n-1/report.pdf",
      "orgs/org-B/pdfs/r-B/n-1/report.pdf",
    ]);
  });
});
