import assert from "node:assert/strict";
import test from "node:test";
import {
  assertLoadSoakRequest,
  percentile,
  summarizeLatencies,
  validateLoadSoakResult,
} from "./load-soak-policy.mjs";

function validResult() {
  return {
    config: {
      burstRuns: 2,
      soakRuns: 2,
      nodesPerRun: 3,
      maxAcceptLatencyMs: 5_000,
      maxTerminalLatencyMs: 60_000,
    },
    runs: [
      { runId: "run-1", status: "succeeded", acceptMs: 10, terminalMs: 100 },
      { runId: "run-2", status: "succeeded", acceptMs: 20, terminalMs: 200 },
      { runId: "run-3", status: "succeeded", acceptMs: 30, terminalMs: 300 },
      { runId: "run-4", status: "succeeded", acceptMs: 40, terminalMs: 400 },
    ],
    queue: {
      samples: 4,
      maxWaiting: 3,
      maxActive: 2,
      final: {
        waiting: 0,
        active: 0,
        maintenanceWaiting: 0,
        maintenanceActive: 0,
      },
    },
    database: {
      runs: 4,
      runNodes: 12,
      runStatuses: { succeeded: 4 },
      nodeStatuses: { succeeded: 12 },
      deadLetters: 0,
      pendingQueueRepairs: 0,
    },
    health: { failures: 0, degradedSamples: 0 },
    metrics: { apiPresent: true, workerPresent: true },
  };
}

test("requires explicit consent before destructive load qualification", () => {
  assert.throws(
    () => assertLoadSoakRequest([]),
    /repeat with --confirm-reset/u,
  );
  assert.doesNotThrow(
    () => assertLoadSoakRequest(["--confirm-reset"]),
  );
});

test("computes nearest-rank latency percentiles without mutating samples", () => {
  const samples = [400, 100, 300, 200];

  assert.equal(percentile(samples, 0.5), 200);
  assert.equal(percentile(samples, 0.95), 400);
  assert.equal(percentile([], 0.5), null);
  assert.deepEqual(samples, [400, 100, 300, 200]);
  assert.deepEqual(summarizeLatencies(samples), {
    count: 4,
    p50Ms: 200,
    p95Ms: 400,
    p99Ms: 400,
    maxMs: 400,
  });
});

test("accepts exact successful persistence, pressure, and drain evidence", () => {
  assert.deepEqual(validateLoadSoakResult(validResult()), {
    expectedRuns: 4,
    expectedNodes: 12,
    acceptLatency: {
      count: 4,
      p50Ms: 20,
      p95Ms: 40,
      p99Ms: 40,
      maxMs: 40,
    },
    terminalLatency: {
      count: 4,
      p50Ms: 200,
      p95Ms: 400,
      p99Ms: 400,
      maxMs: 400,
    },
  });
});

test("rejects duplicate run ids and hidden terminal failures", () => {
  const duplicate = validResult();
  duplicate.runs[3].runId = "run-1";
  assert.throws(
    () => validateLoadSoakResult(duplicate),
    /run ids must be unique/u,
  );

  const failed = validResult();
  failed.runs[2].status = "failed";
  assert.throws(
    () => validateLoadSoakResult(failed),
    /run-3 did not succeed/u,
  );
});

test("rejects undrained queues, orphan repair markers, and silent health loss", () => {
  const queued = validResult();
  queued.queue.final.waiting = 1;
  assert.throws(
    () => validateLoadSoakResult(queued),
    /remained after the drain boundary/u,
  );

  const repair = validResult();
  repair.database.pendingQueueRepairs = 1;
  assert.throws(
    () => validateLoadSoakResult(repair),
    /repair markers remained/u,
  );

  const unhealthy = validResult();
  unhealthy.health.failures = 1;
  assert.throws(
    () => validateLoadSoakResult(unhealthy),
    /health probing failed/u,
  );
});
