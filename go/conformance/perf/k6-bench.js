// k6 regression bench — the pilot's three canonical scenarios, run
// SEQUENTIALLY (startTime offsets) so they never contend with each other:
//
//   start   — POST /v1/start of a linear two-node workflow, polling
//             /v1/status to terminal; latency = start → terminal.
//   list    — hot GET /v1/runs?limit=50 read path.
//   diamond — the F09 fan-out/fan-in DAG, same start → terminal latency.
//
// Driven by conformance/run-bench.mjs (make bench), which boots the Go
// binary, runs this file, and appends the summary to the time series.
import http from "k6/http";
import { sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

const BASE = __ENV.BENCH_BASE || "http://127.0.0.1:4600";
const ORG = `bench-${__ENV.BENCH_RUN_ID || "local"}`;
const DURATION = 20; // seconds per scenario — keep in sync with scenarios{}

const startLatency = new Trend("start_to_terminal_ms");
const diamondLatency = new Trend("diamond_to_terminal_ms");
const listLatency = new Trend("list_ms");
const startIterations = new Counter("start_iterations");
const diamondIterations = new Counter("diamond_iterations");
const listIterations = new Counter("list_iterations");
const errors = new Counter("bench_errors");

export const options = {
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)"],
  scenarios: {
    start: { executor: "constant-vus", vus: 10, duration: `${DURATION}s`, exec: "startLinear", gracefulStop: "30s" },
    list: { executor: "constant-vus", vus: 50, duration: `${DURATION}s`, exec: "listRuns", startTime: "35s", gracefulStop: "10s" },
    diamond: { executor: "constant-vus", vus: 10, duration: `${DURATION}s`, exec: "diamondDag", startTime: "70s", gracefulStop: "30s" },
  },
  discardResponseBodies: false,
};

const HEADERS = {
  "Content-Type": "application/json",
  "x-org-id": ORG,
  "x-user-id": "k6-bench",
};

const LINEAR = JSON.stringify({
  workflow: {
    nodes: [
      { id: "shape", type: "transform", config: { mapping: { verdict: "ok" } } },
      { id: "done", type: "noop", config: {} },
    ],
    edges: [{ from: "shape", to: "done" }],
  },
});

const DIAMOND = JSON.stringify({
  workflow: {
    nodes: [
      { id: "root", type: "noop", config: {} },
      { id: "left", type: "transform", config: { mapping: { side: "l" } } },
      { id: "right", type: "transform", config: { mapping: { side: "r" } } },
      { id: "merge", type: "noop", config: {} },
    ],
    edges: [
      { from: "root", to: "left" }, { from: "root", to: "right" },
      { from: "left", to: "merge" }, { from: "right", to: "merge" },
    ],
  },
});

function runToTerminal(payload, latencyTrend, iterationCounter) {
  const began = Date.now();
  const started = http.post(`${BASE}/v1/start`, payload, { headers: HEADERS });
  if (started.status !== 200) {
    errors.add(1);
    sleep(0.1);
    return;
  }
  const runId = started.json("data.runId");
  for (;;) {
    const res = http.get(`${BASE}/v1/status?runId=${runId}`, { headers: HEADERS });
    if (res.status !== 200) {
      errors.add(1);
      return;
    }
    const status = res.json("data.run.status");
    if (status === "succeeded") break;
    if (status === "failed" || status === "cancelled") {
      errors.add(1);
      return;
    }
    if (Date.now() - began > 60_000) {
      errors.add(1);
      return;
    }
    sleep(0.02);
  }
  latencyTrend.add(Date.now() - began);
  iterationCounter.add(1);
}

export function startLinear() {
  runToTerminal(LINEAR, startLatency, startIterations);
}

export function diamondDag() {
  runToTerminal(DIAMOND, diamondLatency, diamondIterations);
}

export function listRuns() {
  const began = Date.now();
  const res = http.get(`${BASE}/v1/runs?limit=50`, { headers: HEADERS });
  if (res.status !== 200) {
    errors.add(1);
    return;
  }
  listLatency.add(Date.now() - began);
  listIterations.add(1);
}

export function handleSummary(data) {
  const trend = (name) => {
    const metric = data.metrics[name];
    if (!metric) return null;
    const v = metric.values;
    return { p50: v.med, p95: v["p(95)"], p99: v["p(99)"], avg: v.avg };
  };
  const count = (name) => data.metrics[name]?.values.count ?? 0;
  const summary = {
    durationSeconds: DURATION,
    start: { iterations: count("start_iterations"), ratePerSec: count("start_iterations") / DURATION, ...trend("start_to_terminal_ms") },
    list: { iterations: count("list_iterations"), ratePerSec: count("list_iterations") / DURATION, ...trend("list_ms") },
    diamond: { iterations: count("diamond_iterations"), ratePerSec: count("diamond_iterations") / DURATION, ...trend("diamond_to_terminal_ms") },
    errors: count("bench_errors"),
  };
  return { "go/conformance/perf/k6-last.json": JSON.stringify(summary, null, 2) };
}
