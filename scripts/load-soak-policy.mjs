import assert from "node:assert/strict";

export function assertLoadSoakRequest(argumentsList) {
  if (!argumentsList.includes("--confirm-reset")) {
    throw new Error(
      "load/soak qualification removes all local Janusly data; repeat with --confirm-reset",
    );
  }
}

function finiteNonNegative(value, label) {
  assert.ok(
    Number.isFinite(value) && value >= 0,
    `${label} must be a finite non-negative number`,
  );
}

export function percentile(values, quantile) {
  assert.ok(
    Number.isFinite(quantile) && quantile >= 0 && quantile <= 1,
    "quantile must be between zero and one",
  );
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  return sorted[index];
}

export function summarizeLatencies(values) {
  for (const [index, value] of values.entries()) {
    finiteNonNegative(value, `latency ${index}`);
  }
  return {
    count: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maxMs: values.length === 0 ? null : Math.max(...values),
  };
}

export function validateLoadSoakResult(result) {
  const { config, runs, queue, database, health, metrics } = result;
  const expectedRuns = config.burstRuns + config.soakRuns;

  assert.equal(runs.length, expectedRuns, "accepted run count drifted");
  assert.equal(
    new Set(runs.map(({ runId }) => runId)).size,
    expectedRuns,
    "run ids must be unique",
  );
  for (const run of runs) {
    assert.equal(run.status, "succeeded", `${run.runId} did not succeed`);
    finiteNonNegative(run.acceptMs, `${run.runId} accept latency`);
    finiteNonNegative(run.terminalMs, `${run.runId} terminal latency`);
    assert.ok(
      run.acceptMs <= config.maxAcceptLatencyMs,
      `${run.runId} exceeded the bounded accept latency`,
    );
    assert.ok(
      run.terminalMs <= config.maxTerminalLatencyMs,
      `${run.runId} exceeded the bounded terminal latency`,
    );
  }

  assert.ok(queue.samples > 0, "queue sampling never ran");
  assert.ok(queue.maxWaiting > 0, "the workload never created observable queue pressure");
  assert.ok(queue.maxActive > 0, "the workflow worker was never observed active");
  assert.deepEqual(
    queue.final,
    {
      waiting: 0,
      active: 0,
      maintenanceWaiting: 0,
      maintenanceActive: 0,
    },
    "workflow or maintenance work remained after the drain boundary",
  );

  assert.equal(database.runs, expectedRuns, "persisted run count drifted");
  assert.equal(
    database.runNodes,
    expectedRuns * config.nodesPerRun,
    "persisted node count drifted",
  );
  assert.deepEqual(
    database.runStatuses,
    { succeeded: expectedRuns },
    "persisted runs did not converge to succeeded",
  );
  assert.deepEqual(
    database.nodeStatuses,
    { succeeded: expectedRuns * config.nodesPerRun },
    "persisted nodes did not converge to succeeded",
  );
  assert.equal(database.deadLetters, 0, "load created dead letters");
  assert.equal(database.pendingQueueRepairs, 0, "queue publication repair markers remained");

  assert.equal(health.failures, 0, "health probing failed during the workload");
  assert.equal(health.degradedSamples, 0, "public health reported degraded queue state");
  assert.equal(metrics.apiPresent, true, "API metrics were unavailable");
  assert.equal(metrics.workerPresent, true, "worker metrics were unavailable");

  return {
    expectedRuns,
    expectedNodes: expectedRuns * config.nodesPerRun,
    acceptLatency: summarizeLatencies(runs.map(({ acceptMs }) => acceptMs)),
    terminalLatency: summarizeLatencies(runs.map(({ terminalMs }) => terminalMs)),
  };
}
