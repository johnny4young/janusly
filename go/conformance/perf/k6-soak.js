// k6 soak — sustained mixed load for hours, not seconds. Unlike the
// sequential bench scenarios, everything runs CONCURRENTLY at a steady,
// deliberately moderate rate: the goal is memory/goroutine stability
// over time, not peak throughput. Driven by conformance/run-soak.mjs
// (make soak), which samples RSS/goroutines from the internal /metrics
// while this file applies the load.
import http from "k6/http";
import { sleep } from "k6";
import { Counter } from "k6/metrics";

const BASE = __ENV.SOAK_BASE || "http://127.0.0.1:4600";
const ORG = `soak-${__ENV.SOAK_RUN_ID || "local"}`;
const DURATION = __ENV.SOAK_DURATION || "1h";

const errors = new Counter("soak_errors");

export const options = {
  scenarios: {
    starts: { executor: "constant-vus", vus: 4, duration: DURATION, exec: "startLinear", gracefulStop: "30s" },
    reads: { executor: "constant-vus", vus: 8, duration: DURATION, exec: "readPaths", gracefulStop: "10s" },
  },
  discardResponseBodies: false,
};

const HEADERS = {
  "Content-Type": "application/json",
  "x-org-id": ORG,
  "x-user-id": "k6-soak",
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

export function startLinear() {
  const started = http.post(`${BASE}/v1/start`, LINEAR, { headers: HEADERS });
  if (started.status !== 200) {
    errors.add(1);
    sleep(1);
    return;
  }
  const runId = started.json("data.runId");
  for (let i = 0; i < 100; i++) {
    const status = http.get(`${BASE}/v1/status?runId=${runId}`, { headers: HEADERS });
    const state = status.json("data.run.status");
    if (state === "succeeded" || state === "failed") return;
    sleep(0.2);
  }
  errors.add(1);
}

export function readPaths() {
  const list = http.get(`${BASE}/v1/runs?limit=50`, { headers: HEADERS });
  if (list.status !== 200) errors.add(1);
  const health = http.get(`${BASE}/health`);
  if (health.status !== 200) errors.add(1);
  sleep(0.5);
}
