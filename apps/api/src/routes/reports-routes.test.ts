import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  auditMock,
  buildRunExplainReportMock,
  composeRecoveryMetricsMock,
  queryRecoveryMetricsSignalsMock,
  getOrgConfigSnapshotMock,
  selectRowsBox,
  sendJsonMock,
  resWriteHeadMock,
  resEndMock,
  executeToolMock,
  enforceRateLimitMock,
} = vi.hoisted(() => ({
  auditMock: vi.fn(),
  buildRunExplainReportMock: vi.fn(),
  composeRecoveryMetricsMock: vi.fn(),
  queryRecoveryMetricsSignalsMock: vi.fn(),
  getOrgConfigSnapshotMock: vi.fn(),
  selectRowsBox: { rows: [] as unknown[][] },
  sendJsonMock: vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status })),
  resWriteHeadMock: vi.fn(),
  resEndMock: vi.fn(),
  executeToolMock: vi.fn(),
  enforceRateLimitMock: vi.fn(),
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

vi.mock("@janusly/engine/src/recovery-metrics", () => ({
  composeRecoveryMetrics: composeRecoveryMetricsMock,
}));

vi.mock("@janusly/data/src/recoveryMetricsRepo", () => ({
  queryRecoveryMetricsSignals: queryRecoveryMetricsSignalsMock,
}));

vi.mock("@janusly/data/src/orgConfigRepo", () => ({
  getOrgConfigSnapshot: getOrgConfigSnapshotMock,
}));

vi.mock("@janusly/engine/src/tool-registry", () => ({
  executeTool: executeToolMock,
}));

vi.mock("../audit", () => ({ audit: auditMock }));

vi.mock("../rate-limit", () => ({
  enforceRateLimit: enforceRateLimitMock,
}));

vi.mock("../http", async (importOriginal) => {
  const original = await importOriginal<typeof import("../http")>();
  return {
    ...original,
    sendJson: sendJsonMock,
    sendError: vi.fn((_res: unknown, code: string, message: string, status = 400, params?: Record<string, unknown>) =>
      sendJsonMock(_res, params === undefined ? { error: message, code } : { error: message, code, params }, status)),
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

function deliverRoute() {
  return reportsRoutes[1]!;
}

function valueDashboardRoute() {
  return reportsRoutes[2]!;
}

/** Build a Node-`http`-shaped request that yields a JSON body via the
 *  same `data` / `end` events the `readJson` helper subscribes to. */
function makeJsonRequest(body: unknown) {
  const handlers: Record<string, ((chunk?: unknown) => void)[]> = { data: [], end: [], error: [] };
  const req = {
    url: "/reports/run-explain/deliver",
    on(event: string, handler: (chunk?: unknown) => void) {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
      return req;
    },
    destroy() {},
  };
  // readJson awaits the promise so we need to fire the events on the
  // next tick after the listener subscribes.
  queueMicrotask(() => {
    const json = JSON.stringify(body);
    handlers.data.forEach((handler) => handler(json));
    handlers.end.forEach((handler) => handler());
  });
  return req;
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

const valueSignals = {
  runStatusCounts: { succeeded: 8, failed: 2, cancelled: 0 },
  mttrDurations: [60_000],
  approvalsPending: 1,
  costByProvider: [],
  p95LatencyMs: 12_000,
  replayOutcomes: { totalEntries: 2, replayedSuccess: 2, replayedAndReopened: 0 },
  resolvedClusters: { totalClusters: 4, totalEntries: 9, capped: false },
};

const valueAssumptions = {
  hourlyCost: 80,
  minutesSavedPerRecovery: 45,
  baselineMttrSeconds: 1800,
};

const valueMetrics = {
  successRate: { value: 80, display: "80%", severity: "healthy", rationale: "8 of 10 runs succeeded." },
  mttr: { value: 60_000, display: "1m", severity: "healthy", rationale: "Recovered quickly." },
  p95Latency: { value: 12_000, display: "12s", severity: "neutral", rationale: "Within bounds." },
  approvalsPending: { value: 1, display: "1", severity: "neutral", rationale: "One approval pending." },
  replayRate: { value: 100, display: "100%", severity: "healthy", rationale: "Both replays succeeded." },
  slaAttainment: { value: 90, display: "90.0%", severity: "healthy", rationale: "9 of 10 resolved within SLA.", resolvedInWindow: 10, metSla: 9 },
  costThisWindow: { value: 12.34, display: "$12.34", severity: "neutral", rationale: "AI spend this window.", providers: [] },
  clustersResolved: {
    value: 4,
    display: "4 clusters",
    severity: "healthy",
    rationale: "4 distinct signatures resolved.",
    totalEntries: 9,
    capped: false,
  },
  valueEstimate: {
    hoursSaved: 3,
    dollarSaved: 240,
    mttrDeltaSeconds: 1740,
    assumptions: valueAssumptions,
  },
  windowDays: 30,
  terminalRuns: 10,
};

beforeEach(() => {
  selectRowsBox.rows = [];
  auditMock.mockReset();
  buildRunExplainReportMock.mockReset();
  composeRecoveryMetricsMock.mockReset();
  queryRecoveryMetricsSignalsMock.mockReset();
  getOrgConfigSnapshotMock.mockReset();
  sendJsonMock.mockClear();
  resWriteHeadMock.mockReset();
  resEndMock.mockReset();
  executeToolMock.mockReset();
  enforceRateLimitMock.mockReset();
  buildRunExplainReportMock.mockReturnValue(baseReport);
  queryRecoveryMetricsSignalsMock.mockResolvedValue(valueSignals);
  getOrgConfigSnapshotMock.mockResolvedValue({ value: valueAssumptions });
  composeRecoveryMetricsMock.mockReturnValue(valueMetrics);
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
      expect.objectContaining({ format: "markdown", recoveryAuditFound: false }),
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
      expect.objectContaining({ format: "json", recoveryAuditFound: false }),
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
      expect.objectContaining({ format: "markdown", recoveryAuditFound: true }),
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
      { error: "runId is required", code: "reports_run_id_required" },
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
      { error: "Run not found", code: "reports_run_not_found" },
      404,
    );
    expect(buildRunExplainReportMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe("/reports/value-dashboard — export", () => {
  it("declares a viewer GET route that matches the value-dashboard path", () => {
    const route = valueDashboardRoute();
    expect(route.method).toBe("GET");
    expect(route.role).toBe("viewer");
    expect(typeof route.match).toBe("function");
    expect((route.match as (url: string) => boolean)("/reports/value-dashboard?format=markdown")).toBe(true);
  });

  it("returns Markdown with estimate formula, attachment headers, and audit row", async () => {
    await valueDashboardRoute().handler({
      req: { url: "/reports/value-dashboard?windowDays=30&format=markdown" } as never,
      res: makeRes() as never,
      auth,
    });

    expect(queryRecoveryMetricsSignalsMock).toHaveBeenCalledWith("org-1", 30);
    expect(getOrgConfigSnapshotMock).toHaveBeenCalledWith("org-1");
    expect(composeRecoveryMetricsMock).toHaveBeenCalledWith(valueSignals, 30, valueAssumptions);
    expect(resWriteHeadMock).toHaveBeenCalledTimes(1);
    const headers = resWriteHeadMock.mock.calls[0]![1] as Record<string, string>;
    expect(headers["Content-Type"]).toBe("text/markdown; charset=utf-8");
    expect(headers["Content-Disposition"]).toContain("janusly-value-dashboard-org-1-");
    expect(headers["Content-Disposition"]).toContain("-30d.md");
    const markdown = resEndMock.mock.calls[0]![0] as string;
    expect(markdown).toContain("**SLA attainment**: 90.0% — 9 of 10 resolved within SLA.");
    expect(markdown).toContain("Estimate based on operator-supplied assumptions");
    expect(markdown).toContain("dollarSaved = hoursSaved");
    expect(markdown).toContain("Engineer hourly cost: $80.00");
    expect(auditMock).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "report.value_dashboard.exported",
      "org",
      "org-1",
      expect.objectContaining({ format: "markdown", windowDays: 30 }),
    );
  });

  it("returns the JSON payload with the same metrics envelope", async () => {
    await valueDashboardRoute().handler({
      req: { url: "/reports/value-dashboard?windowDays=7&format=json" } as never,
      res: makeRes() as never,
      auth,
    });

    expect(queryRecoveryMetricsSignalsMock).toHaveBeenCalledWith("org-1", 7);
    const headers = resWriteHeadMock.mock.calls[0]![1] as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Content-Disposition"]).toContain("-7d.json");
    const body = JSON.parse(resEndMock.mock.calls[0]![0] as string) as { org: { orgId: string; windowDays: number }; metrics: unknown };
    expect(body.org).toMatchObject({ orgId: "org-1", windowDays: 7 });
    expect(body.metrics).toEqual(valueMetrics);
  });

  it("rejects unknown formats before querying metrics or writing audit", async () => {
    await valueDashboardRoute().handler({
      req: { url: "/reports/value-dashboard?format=pdf" } as never,
      res: makeRes() as never,
      auth,
    });

    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ error: expect.stringContaining("Unknown format") }),
      400,
    );
    expect(queryRecoveryMetricsSignalsMock).not.toHaveBeenCalled();
    expect(getOrgConfigSnapshotMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /reports/run-explain/deliver — route through the integration-tool
// chokepoint. Asserts each of the three destinations + every failure mode
// (multi-tenant gate, malformed body, missing credential, rate-limit on
// outer + inner buckets, audit-on-both-paths posture).
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_INPUT_JSON = { workflow: { name: "Billing flow", id: "wf_billing" } };

function stageReportLoad(run: { id: string; status: string; inputJson?: unknown }) {
  // `Object.hasOwn(run, "inputJson")` distinguishes "caller wanted null"
  // from "caller didn't set it" so a test exercising the ad-hoc-workflow
  // fallback path can pass `inputJson: null` explicitly.
  const inputJson = Object.hasOwn(run, "inputJson") ? run.inputJson : DEFAULT_INPUT_JSON;
  selectRowsBox.rows = [
    [{
      id: run.id,
      orgId: "org-1",
      status: run.status,
      createdAt: new Date("2026-05-12T14:55:00Z"),
      inputJson,
    }],
    [], // runNodes
    [], // runEvents
    [], // auditLogs
  ];
}

describe("/reports/run-explain/deliver — happy paths", () => {
  it("delivers to slack via the slack.post tool with a truncated header+summary body", async () => {
    stageReportLoad({ id: "run_abc", status: "failed" });
    executeToolMock.mockResolvedValueOnce({ ok: true, statusCode: 200, latencyMs: 12 });

    await deliverRoute().handler({
      req: makeJsonRequest({
        runId: "run_abc",
        destination: { kind: "slack", credentialName: "ops-channel" },
      }) as never,
      res: makeRes() as never,
      auth,
    });

    expect(executeToolMock).toHaveBeenCalledTimes(1);
    const [toolName, toolInput, ctxArg, execCtx] = executeToolMock.mock.calls[0]!;
    expect(toolName).toBe("slack.post");
    expect(toolInput).toMatchObject({ credential: "ops-channel" });
    expect(typeof (toolInput as { text?: string }).text).toBe("string");
    expect((toolInput as { text: string }).text).toContain("Janusly run explain");
    expect((toolInput as { text: string }).text).toContain("Billing flow");
    expect(ctxArg).toEqual({});
    expect(execCtx).toMatchObject({ orgId: "org-1", runId: "run_abc" });

    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ok: true, destination: "slack", statusCode: 200, latencyMs: 12 }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "report.run_explain.delivered",
      "run",
      "run_abc",
      expect.objectContaining({
        destination: "slack",
        format: "markdown",
        ok: true,
        statusCode: 200,
        runId: "run_abc",
        workflowId: "wf_billing",
        workflowName: "Billing flow",
        runStatus: "failed",
        credentialName: "ops-channel",
      }),
    );
  });

  it("delivers to github via github.create_issue and surfaces the issue URL as deliveryId", async () => {
    stageReportLoad({ id: "run_abc", status: "failed" });
    executeToolMock.mockResolvedValueOnce({
      ok: true,
      statusCode: 201,
      latencyMs: 35,
      issueNumber: 7,
      url: "https://github.com/janusly/demo/issues/7",
    });

    await deliverRoute().handler({
      req: makeJsonRequest({
        runId: "run_abc",
        destination: { kind: "github", credentialName: "bot-github", owner: "janusly", repo: "demo", labels: ["incident"] },
      }) as never,
      res: makeRes() as never,
      auth,
    });

    const [toolName, toolInput] = executeToolMock.mock.calls[0]!;
    expect(toolName).toBe("github.create_issue");
    expect(toolInput).toMatchObject({
      credential: "bot-github",
      owner: "janusly",
      repo: "demo",
      labels: ["incident"],
      body: baseReport.markdown,
    });
    expect(typeof (toolInput as { title?: string }).title).toBe("string");
    expect((toolInput as { title: string }).title).toContain("Billing flow");

    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ok: true,
        destination: "github",
        statusCode: 201,
        deliveryId: "https://github.com/janusly/demo/issues/7",
      }),
    );
  });

  it("delivers to webhook via webhook.send with the JSON envelope as payload", async () => {
    stageReportLoad({ id: "run_abc", status: "failed" });
    executeToolMock.mockResolvedValueOnce({ ok: true, statusCode: 202, latencyMs: 18 });

    await deliverRoute().handler({
      req: makeJsonRequest({
        runId: "run_abc",
        destination: { kind: "webhook", credentialName: "partner-secret", url: "https://partner.example.com/hooks/janusly" },
      }) as never,
      res: makeRes() as never,
      auth,
    });

    const [toolName, toolInput] = executeToolMock.mock.calls[0]!;
    expect(toolName).toBe("webhook.send");
    expect(toolInput).toMatchObject({
      credential: "partner-secret",
      url: "https://partner.example.com/hooks/janusly",
      payload: baseReport.json,
    });

    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ok: true, destination: "webhook", statusCode: 202 }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "report.run_explain.delivered",
      "run",
      "run_abc",
      expect.objectContaining({ destination: "webhook", format: "json", ok: true }),
    );
  });

  it("falls back to the (ad-hoc workflow) label when the run has no saved workflow name", async () => {
    stageReportLoad({ id: "run_abc", status: "failed", inputJson: null });
    executeToolMock.mockResolvedValueOnce({ ok: true, statusCode: 200, latencyMs: 10 });

    await deliverRoute().handler({
      req: makeJsonRequest({
        runId: "run_abc",
        destination: { kind: "slack", credentialName: "ops-channel" },
      }) as never,
      res: makeRes() as never,
      auth,
    });

    const [, toolInput] = executeToolMock.mock.calls[0]!;
    expect((toolInput as { text: string }).text).toContain("(ad-hoc workflow)");
    expect(auditMock).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "report.run_explain.delivered",
      "run",
      "run_abc",
      expect.objectContaining({ workflowName: null, workflowId: null }),
    );
  });

  it("truncates slack text and appends an ellipsis when the body would exceed the per-block cap", async () => {
    // Build a synthetic report whose nextAction alone pushes the body
    // well past the 2500-char Slack cap; the route should truncate and
    // tail with the ellipsis sentinel.
    const oversized = "X".repeat(5000);
    const bigReport = {
      markdown: "# Big report",
      json: {
        ...baseReport.json,
        nextAction: oversized,
      },
    };
    buildRunExplainReportMock.mockReturnValueOnce(bigReport);
    stageReportLoad({ id: "run_abc", status: "failed" });
    executeToolMock.mockResolvedValueOnce({ ok: true, statusCode: 200, latencyMs: 10 });

    await deliverRoute().handler({
      req: makeJsonRequest({
        runId: "run_abc",
        destination: { kind: "slack", credentialName: "ops-channel" },
      }) as never,
      res: makeRes() as never,
      auth,
    });

    const [, toolInput] = executeToolMock.mock.calls[0]!;
    const text = (toolInput as { text: string }).text;
    // Hard cap below Slack's 3000-char per-block limit.
    expect(text.length).toBeLessThanOrEqual(2500);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("/reports/run-explain/deliver — rejection + failure paths", () => {
  it("rejects malformed slack body (missing credentialName) with 400 and no audit row", async () => {
    await deliverRoute().handler({
      req: makeJsonRequest({
        runId: "run_abc",
        destination: { kind: "slack" },
      }) as never,
      res: makeRes() as never,
      auth,
    });

    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ error: expect.stringContaining("Invalid request") }),
      400,
    );
    expect(executeToolMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("rejects github body missing owner / repo with 400", async () => {
    await deliverRoute().handler({
      req: makeJsonRequest({
        runId: "run_abc",
        destination: { kind: "github", credentialName: "bot" },
      }) as never,
      res: makeRes() as never,
      auth,
    });

    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: "reports_invalid_request", params: expect.objectContaining({ path: expect.stringContaining("owner") }) }),
      400,
    );
    expect(executeToolMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("rejects webhook body missing url with 400", async () => {
    await deliverRoute().handler({
      req: makeJsonRequest({
        runId: "run_abc",
        destination: { kind: "webhook", credentialName: "partner" },
      }) as never,
      res: makeRes() as never,
      auth,
    });

    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: "reports_invalid_request", params: expect.objectContaining({ path: expect.stringContaining("url") }) }),
      400,
    );
    expect(executeToolMock).not.toHaveBeenCalled();
  });

  it("returns 404 (no enumeration leak) when the run is missing or cross-org", async () => {
    // Empty rows from the org-scoped runs query — same envelope for
    // missing-id and cross-org.
    selectRowsBox.rows = [[]];

    await deliverRoute().handler({
      req: makeJsonRequest({
        runId: "other-org-run",
        destination: { kind: "slack", credentialName: "ops" },
      }) as never,
      res: makeRes() as never,
      auth,
    });

    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      { error: "Run not found", code: "reports_run_not_found" },
      404,
    );
    expect(executeToolMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("propagates the generic missing-credential error (no env-var leak) and audits with ok:false", async () => {
    stageReportLoad({ id: "run_abc", status: "failed" });
    executeToolMock.mockResolvedValueOnce({
      ok: false,
      error: "credential secret missing for ops-channel",
      latencyMs: 2,
    });

    await deliverRoute().handler({
      req: makeJsonRequest({
        runId: "run_abc",
        destination: { kind: "slack", credentialName: "ops-channel" },
      }) as never,
      res: makeRes() as never,
      auth,
    });

    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ok: false,
        destination: "slack",
        error: "credential secret missing for ops-channel",
      }),
    );
    // Audit row written even on the failure path; env-var name not present.
    const auditMetadata = auditMock.mock.calls[0]![5];
    expect(auditMetadata).toMatchObject({ ok: false, error: "credential secret missing for ops-channel" });
    // Sanity check: the credentialName surfaced is the operator-supplied identifier,
    // not the env-var (which would have been e.g. SLACK_OPS_WEBHOOK_URL).
    expect(JSON.stringify(auditMetadata)).not.toMatch(/SLACK_.*_WEBHOOK_URL/);
  });

  it("returns 429 + writes an audit row when the outer reports.deliver bucket is exhausted", async () => {
    const rateError = Object.assign(new Error("Rate limit exceeded for reports.deliver. Retry in 30s."), { statusCode: 429 });
    enforceRateLimitMock.mockRejectedValueOnce(rateError);

    await deliverRoute().handler({
      req: makeJsonRequest({
        runId: "run_abc",
        destination: { kind: "slack", credentialName: "ops-channel" },
      }) as never,
      res: makeRes() as never,
      auth,
    });

    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ error: expect.stringContaining("Rate limit exceeded") }),
      429,
    );
    expect(executeToolMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "report.run_explain.delivered",
      "run",
      "run_abc",
      expect.objectContaining({ ok: false, error: "rate_limit_exceeded", destination: "slack", format: "markdown" }),
    );
  });

  it("surfaces inner per-tool rate-limit rejections as { ok: false } with an audit row", async () => {
    stageReportLoad({ id: "run_abc", status: "failed" });
    executeToolMock.mockResolvedValueOnce({
      ok: false,
      error: "Rate limit exceeded for tool.slack.post. Retry in 60s.",
      latencyMs: 1,
    });

    await deliverRoute().handler({
      req: makeJsonRequest({
        runId: "run_abc",
        destination: { kind: "slack", credentialName: "ops-channel" },
      }) as never,
      res: makeRes() as never,
      auth,
    });

    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ok: false, destination: "slack" }),
    );
    const auditMetadata = auditMock.mock.calls[0]![5];
    expect(auditMetadata).toMatchObject({ ok: false, destination: "slack" });
    expect((auditMetadata as { error: string }).error).toContain("Rate limit exceeded");
  });

  it("does not throw when executeTool throws — surfaces { ok: false } and writes the audit row", async () => {
    stageReportLoad({ id: "run_abc", status: "failed" });
    executeToolMock.mockRejectedValueOnce(new Error("synthetic network blip"));

    await deliverRoute().handler({
      req: makeJsonRequest({
        runId: "run_abc",
        destination: { kind: "slack", credentialName: "ops-channel" },
      }) as never,
      res: makeRes() as never,
      auth,
    });

    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ok: false, destination: "slack" }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "report.run_explain.delivered",
      "run",
      "run_abc",
      expect.objectContaining({ ok: false, destination: "slack" }),
    );
  });
});

describe("/reports/run-explain/deliver — route shape", () => {
  it("declares editor role + POST method on /reports/run-explain/deliver", () => {
    const route = deliverRoute();
    expect(route.method).toBe("POST");
    expect(route.role).toBe("editor");
    // Match shape — exact string per the registry pattern, not a predicate.
    expect(route.match).toBe("/reports/run-explain/deliver");
  });
});
