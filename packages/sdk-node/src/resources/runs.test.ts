import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JanuslyTimeoutError } from "../errors.ts";
import { RunsResource } from "./runs.ts";
import type { JanuslyClientConfig, RunDetails, RunSummary } from "../types.ts";

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

function runSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: "run-1",
    status: "running",
    workflowVersionId: "wv-1",
    createdAt: "2026-05-20T00:00:00.000Z",
    ...overrides,
  };
}

function runDetails(overrides: Partial<RunDetails> = {}, runOverrides: Partial<RunSummary> = {}): RunDetails {
  return {
    run: runSummary(runOverrides),
    nodes: [],
    events: [],
    eventsHasMore: false,
    eventsCursor: null,
    ...overrides,
  };
}

describe("RunsResource.start", () => {
  it("loads the latest saved workflow before POSTing /start with workflow + optional input", async () => {
    const captured: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      captured.push({ url: String(url), init: init ?? {} });
      if (String(url).includes("/workflows/latest")) {
        return jsonResponse({
          id: "wv-1",
          dagJson: { id: "wf-1", nodes: [{ id: "n", type: "noop", config: {} }], edges: [] },
        });
      }
      return jsonResponse({ runId: "run-xyz" });
    }) as unknown as FakeFetch;
    const runs = new RunsResource(makeConfig(fetchImpl));
    const result = await runs.start({ workflowId: "wf 1", input: { ticketId: "T-1" } });
    expect(result).toEqual({ runId: "run-xyz" });
    expect(captured[0]!.url).toBe("https://api.test.example.com/workflows/latest?workflowId=wf+1");
    expect(captured[1]!.url).toBe("https://api.test.example.com/start");
    expect(JSON.parse(captured[1]!.init.body as string)).toEqual({
      workflow: { id: "wf-1", nodes: [{ id: "n", type: "noop", config: {} }], edges: [] },
      input: { ticketId: "T-1" },
    });
  });

  it("omits the input field when starting a saved workflow without input", async () => {
    const captured: Array<{ init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      captured.push({ init: init ?? {} });
      if (String(url).includes("/workflows/latest")) {
        return jsonResponse({
          id: "wv-1",
          dagJson: { id: "wf-1", nodes: [{ id: "n", type: "noop", config: {} }], edges: [] },
        });
      }
      return jsonResponse({ runId: "r" });
    }) as unknown as FakeFetch;
    const runs = new RunsResource(makeConfig(fetchImpl));
    await runs.start({ workflowId: "wf-1" });
    const body = JSON.parse(captured[1]!.init.body as string);
    expect(body).toEqual({ workflow: { id: "wf-1", nodes: [{ id: "n", type: "noop", config: {} }], edges: [] } });
    expect("input" in body).toBe(false);
  });
});

describe("RunsResource.get", () => {
  it("builds the query string from runId + paginator params", async () => {
    const captured: Array<{ url: string }> = [];
    const fetchImpl = vi.fn(async (url: unknown) => {
      captured.push({ url: String(url) });
      return jsonResponse(runDetails());
    }) as unknown as FakeFetch;
    const runs = new RunsResource(makeConfig(fetchImpl));
    await runs.get("run-1", { eventsLimit: 50, eventsCursor: "2026-05-20T00:00:00.000Z|evt-42" });
    const url = new URL(captured[0]!.url);
    expect(url.pathname).toBe("/run");
    expect(url.searchParams.get("runId")).toBe("run-1");
    expect(url.searchParams.get("eventsLimit")).toBe("50");
    expect(url.searchParams.get("eventsCursor")).toBe("2026-05-20T00:00:00.000Z|evt-42");
  });
});

describe("RunsResource.list", () => {
  it("iterates the current /runs array response via for-await", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([
      runSummary({ id: "r-1" }),
      runSummary({ id: "r-2" }),
      runSummary({ id: "r-3" }),
    ])) as unknown as FakeFetch;
    const runs = new RunsResource(makeConfig(fetchImpl));
    const collected: string[] = [];
    for await (const run of runs.list()) collected.push(run.id);
    expect(collected).toEqual(["r-1", "r-2", "r-3"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stops iterating when the caller breaks early — no extra round-trips", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ runs: [runSummary({ id: "r-1" }), runSummary({ id: "r-2" })], nextCursor: "next" }),
    ) as unknown as FakeFetch;
    const runs = new RunsResource(makeConfig(fetchImpl));
    let collected = 0;
    for await (const _run of runs.list()) {
      collected += 1;
      if (collected === 1) break;
    }
    expect(collected).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("respects the soft-cap limit option", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ runs: [runSummary({ id: "r-1" }), runSummary({ id: "r-2" }), runSummary({ id: "r-3" })], nextCursor: null }),
    ) as unknown as FakeFetch;
    const runs = new RunsResource(makeConfig(fetchImpl));
    const collected: string[] = [];
    for await (const run of runs.list({ limit: 2 })) collected.push(run.id);
    expect(collected).toEqual(["r-1", "r-2"]);
  });
});

describe("RunsResource.pollUntilTerminal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns immediately on a terminal status", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(runDetails({}, { status: "succeeded" }))) as unknown as FakeFetch;
    const runs = new RunsResource(makeConfig(fetchImpl));
    const result = await runs.pollUntilTerminal("run-1", { intervalMs: 1000 });
    expect(result.run.status).toBe("succeeded");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("polls until status becomes terminal", async () => {
    const responses = [
      jsonResponse(runDetails({}, { status: "running" })),
      jsonResponse(runDetails({}, { status: "running" })),
      jsonResponse(runDetails({}, { status: "failed" })),
    ];
    let idx = 0;
    const fetchImpl = vi.fn(async () => responses[idx++]!) as unknown as FakeFetch;
    const runs = new RunsResource(makeConfig(fetchImpl));
    const promise = runs.pollUntilTerminal("run-1", { intervalMs: 100 });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.run.status).toBe("failed");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("throws JanuslyTimeoutError when no terminal status arrives before deadline", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(runDetails({}, { status: "running" }))) as unknown as FakeFetch;
    const runs = new RunsResource(makeConfig(fetchImpl));
    const promise = runs.pollUntilTerminal("run-1", { intervalMs: 100, timeoutMs: 250 });
    promise.catch(() => {}); // suppress unhandled rejection during vi.runAllTimersAsync
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toBeInstanceOf(JanuslyTimeoutError);
  });
});

describe("RunsResource.streamEvents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("yields events in chronological order across multiple poll cycles", async () => {
    const cycle1 = runDetails({
      events: [
        { id: "e1", type: "run.started", createdAt: "2026-05-20T00:00:01.000Z" },
        { id: "e2", type: "node.started", createdAt: "2026-05-20T00:00:02.000Z" },
      ],
      eventsCursor: "2026-05-20T00:00:01.000Z|e1",
    }, { status: "running" });
    const cycle2 = runDetails({
      events: [
        { id: "e3", type: "node.completed", createdAt: "2026-05-20T00:00:03.000Z" },
      ],
      eventsCursor: null,
    }, { status: "succeeded" });
    const responses = [jsonResponse(cycle1), jsonResponse(cycle2)];
    const captured: string[] = [];
    let idx = 0;
    const fetchImpl = vi.fn(async (url: unknown) => {
      captured.push(String(url));
      return responses[idx++]!;
    }) as unknown as FakeFetch;
    const runs = new RunsResource(makeConfig(fetchImpl));

    const collected: string[] = [];
    const promise = (async () => {
      for await (const event of runs.streamEvents("run-1", { intervalMs: 50 })) {
        collected.push(event.id);
      }
    })();
    await vi.runAllTimersAsync();
    await promise;

    // Chronological order means oldest-first within each page.
    expect(collected).toEqual(["e1", "e2", "e3"]);
    expect(new URL(captured[1]!).searchParams.has("eventsCursor")).toBe(false);
  });

  it("exits when the run reaches a terminal status (no infinite loop)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(runDetails({}, { status: "cancelled" })),
    ) as unknown as FakeFetch;
    const runs = new RunsResource(makeConfig(fetchImpl));
    const collected: string[] = [];
    for await (const event of runs.streamEvents("run-1", { intervalMs: 1000 })) {
      collected.push(event.id);
    }
    expect(collected).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does NOT yield duplicate events across poll cycles", async () => {
    const sharedEvent = { id: "e1", type: "run.started", createdAt: "2026-05-20T00:00:00.000Z" };
    const cycle1 = runDetails({
      events: [sharedEvent],
      eventsCursor: null,
    }, { status: "running" });
    const cycle2 = runDetails({
      events: [sharedEvent, { id: "e2", type: "run.succeeded", createdAt: "2026-05-20T00:00:01.000Z" }],
      eventsCursor: null,
    }, { status: "succeeded" });
    const responses = [jsonResponse(cycle1), jsonResponse(cycle2)];
    let idx = 0;
    const fetchImpl = vi.fn(async () => responses[idx++]!) as unknown as FakeFetch;
    const runs = new RunsResource(makeConfig(fetchImpl));

    const collected: string[] = [];
    const promise = (async () => {
      for await (const event of runs.streamEvents("run-1", { intervalMs: 50 })) {
        collected.push(event.id);
      }
    })();
    await vi.runAllTimersAsync();
    await promise;

    expect(collected).toEqual(["e1", "e2"]);
  });

  it("throws an AbortError when the signal aborts mid-stream", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(runDetails({}, { status: "running" })),
    ) as unknown as FakeFetch;
    const runs = new RunsResource(makeConfig(fetchImpl));
    const controller = new AbortController();
    const collected: string[] = [];
    const promise = (async () => {
      for await (const event of runs.streamEvents("run-1", { intervalMs: 100 }, { signal: controller.signal })) {
        collected.push(event.id);
      }
    })();
    promise.catch(() => {}); // suppress unhandled rejection during timers
    // Schedule abort during the first poll cycle.
    setTimeout(() => controller.abort(), 50);
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("RunsResource.resumeNode", () => {
  it("POSTs /resume with the runId + nodeId + input + resumeToken when supplied", async () => {
    const captured: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      captured.push({ url: String(url), init: init ?? {} });
      return jsonResponse({ resumed: true });
    }) as unknown as FakeFetch;
    const runs = new RunsResource(makeConfig(fetchImpl));
    const result = await runs.resumeNode({
      runId: "run-1",
      nodeId: "node-2",
      input: { approved: true },
      resumeToken: "tok-abc",
    });
    expect(result).toEqual({ resumed: true });
    expect(captured[0]!.url).toBe("https://api.test.example.com/resume");
    expect(JSON.parse(captured[0]!.init.body as string)).toEqual({
      runId: "run-1",
      nodeId: "node-2",
      input: { approved: true },
      resumeToken: "tok-abc",
    });
  });
});
