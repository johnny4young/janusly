import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  auditMock,
  buildRunExplainReportMock,
  selectRowsBox,
  sendJsonMock,
  resWriteHeadMock,
  resEndMock,
} = vi.hoisted(() => ({
  auditMock: vi.fn(),
  buildRunExplainReportMock: vi.fn(),
  selectRowsBox: { rows: [] as unknown[][] },
  sendJsonMock: vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status })),
  resWriteHeadMock: vi.fn(),
  resEndMock: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(() => ({})),
  asc: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
  or: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
}));

vi.mock("@janusly/db", () => {
  // Drizzle's QueryBuilder is awaitable at any terminal (the builder
  // itself is a Promise via the `.then` method). The mock mirrors that:
  // every chain method (`from`, `where`, `orderBy`, `limit`) returns
  // the same chain, and the chain's `.then` resolves the NEXT staged
  // row set from `selectRowsBox`. One row set per call to `db.select()`.
  const makeChain = () => {
    type Chain = {
      from: (...args: unknown[]) => Chain;
      where: (...args: unknown[]) => Chain;
      orderBy: (...args: unknown[]) => Chain;
      limit: (...args: unknown[]) => Chain;
      then: PromiseLike<unknown[]>["then"];
    };
    let cached: Promise<unknown[]> | null = null;
    const settle = (): Promise<unknown[]> => {
      if (!cached) cached = Promise.resolve(selectRowsBox.rows.shift() ?? []);
      return cached;
    };
    const chain: Chain = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      then: ((resolve, reject) => settle().then(resolve, reject)) as PromiseLike<unknown[]>["then"],
    };
    return chain;
  };
  return {
    db: { select: vi.fn(() => makeChain()) },
    runs: { id: "runs.id", orgId: "runs.org_id" },
    runNodes: { runId: "run_nodes.run_id", startedAt: "run_nodes.started_at", nodeId: "run_nodes.node_id" },
    runEvents: { runId: "run_events.run_id", createdAt: "run_events.created_at", id: "run_events.id" },
    auditLogs: {
      orgId: "audit_logs.org_id",
      action: "audit_logs.action",
      createdAt: "audit_logs.created_at",
      metadata: "audit_logs.metadata",
      targetId: "audit_logs.target_id",
    },
  };
});

vi.mock("@janusly/engine/src/run-explain-report", () => ({
  buildRunExplainReport: buildRunExplainReportMock,
}));

vi.mock("../audit", () => ({ audit: auditMock }));

vi.mock("../http", async (importOriginal) => {
  const original = await importOriginal<typeof import("../http")>();
  return {
    ...original,
    sendJson: sendJsonMock,
    corsHeaders: vi.fn(() => ({})),
  };
});

import { reportsRoutes } from "./reports-routes";

const auth = {
  orgId: "org-1",
  userId: "user-1",
  mode: "dev-headers" as const,
  source: "dev" as const,
};

function makeRes() {
  return {
    writeHead: resWriteHeadMock,
    end: resEndMock,
  };
}

function reportsRoute() {
  return reportsRoutes[0]!;
}

const baseReport = {
  markdown: "# Run Explain Report — run_abc",
  json: {
    generatedAt: "2026-05-12T15:00:00.000Z",
    summary: {
      runId: "run_abc",
      status: "failed",
      workflowVersionId: "wf_v3",
      parentRunId: null,
      replayMode: null,
      createdAt: "2026-05-12T14:55:00.000Z",
      isFailure: true,
    },
    rootCause: null,
    failedNode: null,
    timeline: [],
    timelineTruncated: false,
    suggestedFix: null,
    nextAction: "Inspect the run timeline.",
  },
};

beforeEach(() => {
  selectRowsBox.rows = [];
  auditMock.mockReset();
  buildRunExplainReportMock.mockReset();
  sendJsonMock.mockClear();
  resWriteHeadMock.mockReset();
  resEndMock.mockReset();
  buildRunExplainReportMock.mockReturnValue(baseReport);
});

describe("/reports/run-explain — happy path", () => {
  it("returns Markdown with attachment Content-Disposition by default", async () => {
    selectRowsBox.rows = [
      [{
        id: "run_abc",
        orgId: "org-1",
        status: "failed",
        createdAt: new Date("2026-05-12T14:55:00Z"),
        inputJson: { workflow: { name: "Billing flow" } },
      }],
      [], // runNodes
      [], // runEvents
      [], // auditLogs
    ];

    await reportsRoute().handler({
      req: { url: "/reports/run-explain?runId=run_abc" } as never,
      res: makeRes() as never,
      auth,
    });

    expect(buildRunExplainReportMock).toHaveBeenCalledTimes(1);
    expect(resWriteHeadMock).toHaveBeenCalledTimes(1);
    const writeHeadArgs = resWriteHeadMock.mock.calls[0]!;
    expect(writeHeadArgs[0]).toBe(200);
    const headers = writeHeadArgs[1] as Record<string, string>;
    expect(headers["Content-Type"]).toBe("text/markdown; charset=utf-8");
    expect(headers["Access-Control-Expose-Headers"]).toBe("Content-Disposition");
    // Filename pattern: janusly-<slug(workflow_name)>-<status>-<YYYY-MM-DD>-<short_id>.<ext>
    expect(headers["Content-Disposition"]).toContain('filename="janusly-billing-flow-failed-2026-05-12-run_abc.md"');
    expect(headers["Content-Disposition"]).toContain("filename*=UTF-8''");
    expect(resEndMock).toHaveBeenCalledWith(baseReport.markdown);
    expect(auditMock).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "report.run_explain.exported",
      "run",
      "run_abc",
      { format: "markdown", recoveryAuditFound: false },
    );
  });

  it("falls back to a generic run-<short> form when no workflow name is available", async () => {
    selectRowsBox.rows = [
      [{
        id: "b3dc412b-d85c-402a-90c7-dc67321e804b",
        orgId: "org-1",
        status: "succeeded",
        createdAt: new Date("2026-05-12T14:55:00Z"),
        inputJson: null,
      }],
      [], [], [],
    ];

    await reportsRoute().handler({
      req: { url: "/reports/run-explain?runId=b3dc412b-d85c-402a-90c7-dc67321e804b" } as never,
      res: makeRes() as never,
      auth,
    });

    const headers = resWriteHeadMock.mock.calls[0]![1] as Record<string, string>;
    expect(headers["Content-Disposition"]).toContain('filename="janusly-run-succeeded-2026-05-12-b3dc412b.md"');
  });

  it("scrubs secret-shaped values before deriving the download filename", async () => {
    const token = "ghp_aaaaaaaaaaaaaaaaaaaaaa";
    selectRowsBox.rows = [
      [{
        id: "run_secret",
        orgId: "org-1",
        status: "failed",
        createdAt: new Date("2026-05-12T14:55:00Z"),
        inputJson: { workflow: { name: `Billing ${token}` } },
      }],
      [], [], [],
    ];

    await reportsRoute().handler({
      req: { url: "/reports/run-explain?runId=run_secret" } as never,
      res: makeRes() as never,
      auth,
    });

    const headers = resWriteHeadMock.mock.calls[0]![1] as Record<string, string>;
    expect(headers["Content-Disposition"]).not.toContain(token);
    expect(headers["Content-Disposition"]).toContain("billing-redacted");
  });

  it("uses .json extension when format=json and surfaces Content-Disposition there too", async () => {
    selectRowsBox.rows = [
      [{
        id: "run_xyz",
        orgId: "org-1",
        status: "failed",
        createdAt: new Date("2026-05-12T14:55:00Z"),
        inputJson: { workflow: { name: "Billing flow" } },
      }],
      [], [], [],
    ];

    await reportsRoute().handler({
      req: { url: "/reports/run-explain?runId=run_xyz&format=json" } as never,
      res: makeRes() as never,
      auth,
    });

    expect(resWriteHeadMock).toHaveBeenCalledTimes(1);
    const headers = resWriteHeadMock.mock.calls[0]![1] as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Content-Disposition"]).toContain('filename="janusly-billing-flow-failed-2026-05-12-run_xyz.json"');
    expect(headers["Access-Control-Expose-Headers"]).toBe("Content-Disposition");
    // sendJsonMock should NOT have been called — we wrote the response manually.
    expect(sendJsonMock).not.toHaveBeenCalled();
  });

  it("returns the JSON envelope when format=json", async () => {
    selectRowsBox.rows = [
      [{ id: "run_abc", orgId: "org-1", status: "failed", createdAt: new Date("2026-05-12T14:55:00Z") }],
      [], [], [],
    ];

    await reportsRoute().handler({
      req: { url: "/reports/run-explain?runId=run_abc&format=json" } as never,
      res: makeRes() as never,
      auth,
    });

    // The JSON path also writes the response manually so the
    // Content-Disposition header sets a sensible download filename.
    expect(resWriteHeadMock).toHaveBeenCalledTimes(1);
    const headers = resWriteHeadMock.mock.calls[0]![1] as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(resEndMock).toHaveBeenCalledWith(JSON.stringify(baseReport.json));
    expect(auditMock).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "report.run_explain.exported",
      "run",
      "run_abc",
      { format: "json", recoveryAuditFound: false },
    );
  });

  it("records recoveryAuditFound=true when a matching audit row exists", async () => {
    selectRowsBox.rows = [
      [{ id: "run_abc", orgId: "org-1", status: "failed" }],
      [],
      [],
      [
        // Audit row with metadata.runId matching the requested run.
        {
          createdAt: new Date("2026-05-12T15:05:00Z"),
          targetId: "dlq-some-id",
          metadata: { runId: "run_abc", mode: "ai", topApproachLabel: "add_approval" },
        },
      ],
    ];

    await reportsRoute().handler({
      req: { url: "/reports/run-explain?runId=run_abc" } as never,
      res: makeRes() as never,
      auth,
    });

    expect(buildRunExplainReportMock.mock.calls[0]![0].recoveryAudit).toMatchObject({
      metadata: expect.objectContaining({ topApproachLabel: "add_approval" }),
    });
    expect(auditMock).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "report.run_explain.exported",
      "run",
      "run_abc",
      { format: "markdown", recoveryAuditFound: true },
    );
  });
});

describe("/reports/run-explain — rejection paths", () => {
  it("rejects missing runId with 400", async () => {
    await reportsRoute().handler({
      req: { url: "/reports/run-explain" } as never,
      res: makeRes() as never,
      auth,
    });

    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      { error: "runId is required" },
      400,
    );
    expect(buildRunExplainReportMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("rejects unknown format with 400", async () => {
    await reportsRoute().handler({
      req: { url: "/reports/run-explain?runId=run_abc&format=pdf" } as never,
      res: makeRes() as never,
      auth,
    });

    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ error: expect.stringContaining("Unknown format") }),
      400,
    );
    expect(buildRunExplainReportMock).not.toHaveBeenCalled();
  });

  it("rejects cross-org / missing run with 404 (no enumeration leak)", async () => {
    // Empty rows from the org-scoped runs query simulate either
    // a missing id OR a run owned by another org. Same envelope.
    selectRowsBox.rows = [[]];

    await reportsRoute().handler({
      req: { url: "/reports/run-explain?runId=other-org-run" } as never,
      res: makeRes() as never,
      auth,
    });

    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      { error: "Run not found" },
      404,
    );
    expect(buildRunExplainReportMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});
