// Co-scheduled A/B benchmark for the Go migration gate. Candidate and frozen
// baseline execute the same scenario at the same time against separate
// PostgreSQL 18 instances, so both observe the same host-load window.
import http from "k6/http";
import { sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

const CANDIDATE_BASE = __ENV.BENCH_CANDIDATE_BASE || "http://127.0.0.1:4640";
const BASELINE_BASE = __ENV.BENCH_BASELINE_BASE || "http://127.0.0.1:4642";
const RUN_ID = __ENV.BENCH_RUN_ID || "local";
const DURATION = 20;

function metrics(prefix) {
  return {
    startLatency: new Trend(`${prefix}_start_to_terminal_ms`),
    diamondLatency: new Trend(`${prefix}_diamond_to_terminal_ms`),
    listLatency: new Trend(`${prefix}_list_ms`),
    startIterations: new Counter(`${prefix}_start_iterations`),
    diamondIterations: new Counter(`${prefix}_diamond_iterations`),
    listIterations: new Counter(`${prefix}_list_iterations`),
    errors: new Counter(`${prefix}_errors`),
  };
}

const candidateMetrics = metrics("candidate");
const baselineMetrics = metrics("baseline");

export const options = {
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)"],
  scenarios: {
    candidate_start: { executor: "constant-vus", vus: 10, duration: `${DURATION}s`, exec: "candidateStart", gracefulStop: "30s" },
    baseline_start: { executor: "constant-vus", vus: 10, duration: `${DURATION}s`, exec: "baselineStart", gracefulStop: "30s" },
    candidate_list: { executor: "constant-vus", vus: 50, duration: `${DURATION}s`, exec: "candidateList", startTime: "35s", gracefulStop: "10s" },
    baseline_list: { executor: "constant-vus", vus: 50, duration: `${DURATION}s`, exec: "baselineList", startTime: "35s", gracefulStop: "10s" },
    candidate_diamond: { executor: "constant-vus", vus: 10, duration: `${DURATION}s`, exec: "candidateDiamond", startTime: "70s", gracefulStop: "30s" },
    baseline_diamond: { executor: "constant-vus", vus: 10, duration: `${DURATION}s`, exec: "baselineDiamond", startTime: "70s", gracefulStop: "30s" },
  },
  discardResponseBodies: false,
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

function headers(side) {
  return {
    "Content-Type": "application/json",
    "x-org-id": `bench-${RUN_ID}-${side}`,
    "x-user-id": "k6-bench",
  };
}

function runToTerminal(base, sideHeaders, sideMetrics, payload, latencyTrend, iterationCounter) {
  const began = Date.now();
  const started = http.post(`${base}/v1/start`, payload, { headers: sideHeaders });
  if (started.status !== 200) {
    sideMetrics.errors.add(1);
    sleep(0.1);
    return;
  }
  const runId = started.json("data.runId");
  for (;;) {
    const response = http.get(`${base}/v1/status?runId=${runId}`, { headers: sideHeaders });
    if (response.status !== 200) {
      sideMetrics.errors.add(1);
      return;
    }
    const status = response.json("data.run.status");
    if (status === "succeeded") break;
    if (status === "failed" || status === "cancelled") {
      sideMetrics.errors.add(1);
      return;
    }
    if (Date.now() - began > 60_000) {
      sideMetrics.errors.add(1);
      return;
    }
    sleep(0.02);
  }
  latencyTrend.add(Date.now() - began);
  iterationCounter.add(1);
}

function listRuns(base, sideHeaders, sideMetrics) {
  const began = Date.now();
  const response = http.get(`${base}/v1/runs?limit=50`, { headers: sideHeaders });
  if (response.status !== 200) {
    sideMetrics.errors.add(1);
    return;
  }
  sideMetrics.listLatency.add(Date.now() - began);
  sideMetrics.listIterations.add(1);
}

const candidateHeaders = headers("candidate");
const baselineHeaders = headers("baseline");

export function candidateStart() {
  runToTerminal(CANDIDATE_BASE, candidateHeaders, candidateMetrics, LINEAR,
    candidateMetrics.startLatency, candidateMetrics.startIterations);
}

export function baselineStart() {
  runToTerminal(BASELINE_BASE, baselineHeaders, baselineMetrics, LINEAR,
    baselineMetrics.startLatency, baselineMetrics.startIterations);
}

export function candidateList() {
  listRuns(CANDIDATE_BASE, candidateHeaders, candidateMetrics);
}

export function baselineList() {
  listRuns(BASELINE_BASE, baselineHeaders, baselineMetrics);
}

export function candidateDiamond() {
  runToTerminal(CANDIDATE_BASE, candidateHeaders, candidateMetrics, DIAMOND,
    candidateMetrics.diamondLatency, candidateMetrics.diamondIterations);
}

export function baselineDiamond() {
  runToTerminal(BASELINE_BASE, baselineHeaders, baselineMetrics, DIAMOND,
    baselineMetrics.diamondLatency, baselineMetrics.diamondIterations);
}

function sideSummary(data, prefix) {
  const trend = (name) => {
    const metric = data.metrics[`${prefix}_${name}`];
    if (!metric) return null;
    const values = metric.values;
    return { p50: values.med, p95: values["p(95)"], p99: values["p(99)"], avg: values.avg };
  };
  const count = (name) => data.metrics[`${prefix}_${name}`]?.values.count ?? 0;
  return {
    durationSeconds: DURATION,
    start: {
      iterations: count("start_iterations"),
      ratePerSec: count("start_iterations") / DURATION,
      ...trend("start_to_terminal_ms"),
    },
    list: {
      iterations: count("list_iterations"),
      ratePerSec: count("list_iterations") / DURATION,
      ...trend("list_ms"),
    },
    diamond: {
      iterations: count("diamond_iterations"),
      ratePerSec: count("diamond_iterations") / DURATION,
      ...trend("diamond_to_terminal_ms"),
    },
    errors: count("errors"),
  };
}

export function handleSummary(data) {
  const candidate = sideSummary(data, "candidate");
  const baseline = sideSummary(data, "baseline");
  const candidateOutput = __ENV.BENCH_CANDIDATE_SUMMARY_PATH || "artifacts/go-benchmark-candidate.json";
  const baselineOutput = __ENV.BENCH_BASELINE_SUMMARY_PATH || "artifacts/go-benchmark-baseline.json";
  return {
    [candidateOutput]: JSON.stringify(candidate, null, 2),
    [baselineOutput]: JSON.stringify(baseline, null, 2),
  };
}
