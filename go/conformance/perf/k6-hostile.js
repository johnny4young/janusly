// Hostile-world bench: measure the READ paths while the platform
// is having a bad day. Three phases:
//
//   baseline_reads (0-20s)  — runs/dlq/health p95 with the system quiet.
//   chaos_writes  (20-55s)  — continuous failing starts (unresolvable
//                             upstream) so the DLQ grows and the circuit
//                             breaker trips the workflow into pause.
//   hostile_reads (30-55s)  — the SAME reads measured under that chaos.
//
// The wrapper (run-hostile-bench.mjs) computes hostile-p95 / baseline-p95
// per read family and fails when any ratio exceeds 2× — the bounded-
// degradation contract. Fixed metric names keep cardinality bounded;
// run identifiers never appear in a series name.
import http from "k6/http";
import { sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

const BASE = __ENV.BENCH_BASE || "http://127.0.0.1:4600";
const ORG = `hostile-${__ENV.BENCH_RUN_ID || "local"}`;

const baselineRuns = new Trend("baseline_runs_ms");
const baselineDlq = new Trend("baseline_dlq_ms");
const baselineHealth = new Trend("baseline_health_ms");
const hostileRuns = new Trend("hostile_runs_ms");
const hostileDlq = new Trend("hostile_dlq_ms");
const hostileHealth = new Trend("hostile_health_ms");
const chaosStarts = new Counter("chaos_starts");
const readErrors = new Counter("read_errors");

export const options = {
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)"],
  scenarios: {
    baseline_reads: {
      executor: "constant-vus", vus: 8, duration: "20s",
      exec: "readsBaseline", gracefulStop: "5s",
    },
    chaos_writes: {
      executor: "constant-vus", vus: 6, duration: "35s",
      startTime: "20s", exec: "chaosWrites", gracefulStop: "10s",
    },
    hostile_reads: {
      executor: "constant-vus", vus: 8, duration: "25s",
      startTime: "30s", exec: "readsHostile", gracefulStop: "5s",
    },
  },
};

const HEADERS = {
  "content-type": "application/json",
  "x-org-id": ORG,
  "x-user-id": "hostile-bench",
};

function readOnce(runsTrend, dlqTrend, healthTrend) {
  let res = http.get(`${BASE}/v1/runs?limit=50`, { headers: HEADERS, tags: { name: "runs_list" } });
  if (res.status !== 200) readErrors.add(1);
  runsTrend.add(res.timings.duration);
  res = http.get(`${BASE}/v1/dlq`, { headers: HEADERS, tags: { name: "dlq_list" } });
  if (res.status !== 200) readErrors.add(1);
  dlqTrend.add(res.timings.duration);
  res = http.get(`${BASE}/health`, { headers: HEADERS, tags: { name: "health" } });
  if (res.status !== 200) readErrors.add(1);
  healthTrend.add(res.timings.duration);
  sleep(0.05);
}

export function readsBaseline() {
  readOnce(baselineRuns, baselineDlq, baselineHealth);
}

export function readsHostile() {
  readOnce(hostileRuns, hostileDlq, hostileHealth);
}

// The hostile generator: every iteration starts a run that dead-letters
// (unresolvable .invalid upstream, one attempt). The SAME workflow id
// keeps failing so the consecutive-failure breaker trips it into pause —
// paused starts then 409/422 which is exactly the hostile-world shape.
export function chaosWrites() {
  const workflow = {
    id: `hostile-${ORG}`,
    name: "Hostile ingest",
    dslVersion: "1.0",
    nodes: [{
      id: "fetch", type: "http",
      config: { url: "https://hostile-bench.invalid/feed", retry: { maxAttempts: 1 } },
    }],
    edges: [],
  };
  const res = http.post(`${BASE}/start`, JSON.stringify({ workflow }), {
    headers: HEADERS, tags: { name: "chaos_start" },
  });
  if (res.status === 200) chaosStarts.add(1);
  sleep(0.1);
}
