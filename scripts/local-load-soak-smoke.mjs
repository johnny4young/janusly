/** Destructive local qualification of workflow admission, queueing, and drain. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertLoadSoakRequest,
  validateLoadSoakResult,
} from "./load-soak-policy.mjs";
import {
  getLocalStackSettings,
  parseEnvFile,
} from "./local-env.mjs";
import { runQualificationWithCleanup } from "./qualification-cleanup.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidenceDirectory = process.env.JANUSLY_EVIDENCE_DIR
  ?? fileURLToPath(
    new URL("../output/review/2026-07-30-load-soak-qualification", import.meta.url),
  );

function boundedInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer in ${minimum}..${maximum}`);
  }
  return parsed;
}

const config = {
  burstRuns: boundedInteger("JANUSLY_LOAD_BURST_RUNS", 200, 20, 2_000),
  burstConcurrency: boundedInteger("JANUSLY_LOAD_BURST_CONCURRENCY", 20, 1, 100),
  soakSeconds: boundedInteger("JANUSLY_SOAK_SECONDS", 45, 10, 600),
  soakRps: boundedInteger("JANUSLY_SOAK_RPS", 4, 1, 50),
  nodesPerRun: 6,
  maxAcceptLatencyMs: boundedInteger(
    "JANUSLY_LOAD_MAX_ACCEPT_LATENCY_MS",
    5_000,
    100,
    60_000,
  ),
  maxTerminalLatencyMs: boundedInteger(
    "JANUSLY_LOAD_MAX_TERMINAL_LATENCY_MS",
    120_000,
    5_000,
    600_000,
  ),
};
config.soakRuns = config.soakSeconds * config.soakRps;

const stamp = `${Date.now().toString(36)}-${process.pid}`;
const workflow = {
  dslVersion: "1.0",
  id: `load-soak-${stamp}`,
  name: `Load soak ${stamp}`,
  nodes: [
    { id: "admit", type: "noop", config: {} },
    { id: "lane_a", type: "noop", config: {} },
    { id: "lane_b", type: "noop", config: {} },
    { id: "lane_c", type: "noop", config: {} },
    { id: "converge", type: "noop", config: {} },
    { id: "complete", type: "noop", config: {} },
  ],
  edges: [
    { from: "admit", to: "lane_a" },
    { from: "admit", to: "lane_b" },
    { from: "admit", to: "lane_c" },
    { from: "lane_a", to: "converge" },
    { from: "lane_b", to: "converge" },
    { from: "lane_c", to: "converge" },
    { from: "converge", to: "complete" },
  ],
};
const screenshots = [
  "load-soak-activity-en.png",
  "load-soak-infrastructure-es.png",
  "load-soak-infrastructure-es-mobile.png",
];
const failureDiagnosticsPath = join(evidenceDirectory, "load-soak-failure-diagnostics.json");

assertLoadSoakRequest(process.argv.slice(2));
await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
await chmod(evidenceDirectory, 0o700);
await rm(failureDiagnosticsPath, { force: true });

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function run(command, argumentsList, extraEnvironment = {}, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, argumentsList, {
      cwd: root,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      env: { ...process.env, ...extraEnvironment },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolvePromise({ stdout, stderr })
      : reject(new Error(
        `${command} ${argumentsList.join(" ")} exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
      )));
  });
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await mapper(items[index], index);
      }
    }),
  );
  return results;
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function requestJson(url, options = {}) {
  const { timeoutMs = 10_000, ...requestOptions } = options;
  const response = await fetch(url, {
    ...requestOptions,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${new URL(url).pathname} returned ${response.status}: ${text}`,
    );
  }
  return body;
}

async function readDatabaseSnapshot(workflowId, orgId) {
  const query = `WITH target_runs AS (
    SELECT id, status, created_at
    FROM runs
    WHERE org_id = ${sqlLiteral(orgId)}
      AND workflow_version_id = ${sqlLiteral(workflowId)}
  )
  SELECT json_build_object(
    'runs', (SELECT count(*)::integer FROM target_runs),
    'runNodes', (
      SELECT count(*)::integer
      FROM run_nodes n
      JOIN target_runs r ON r.id = n.run_id
    ),
    'runStatuses', (
      SELECT coalesce(json_object_agg(status, count), '{}'::json)
      FROM (
        SELECT status, count(*)::integer AS count
        FROM target_runs
        GROUP BY status
      ) status_counts
    ),
    'nodeStatuses', (
      SELECT coalesce(json_object_agg(status, count), '{}'::json)
      FROM (
        SELECT n.status, count(*)::integer AS count
        FROM run_nodes n
        JOIN target_runs r ON r.id = n.run_id
        GROUP BY n.status
      ) status_counts
    ),
    'deadLetters', (
      SELECT count(*)::integer
      FROM dead_letters d
      JOIN target_runs r ON r.id = d.run_id
    ),
    'pendingQueueRepairs', (
      SELECT count(*)::integer
      FROM run_nodes n
      JOIN target_runs r ON r.id = n.run_id
      WHERE n.queue_publication_repair_after IS NOT NULL
    ),
    'nonTerminalRuns', (
      SELECT coalesce(json_agg(json_build_object(
        'runId', r.id,
        'status', r.status,
        'nodes', (
          SELECT coalesce(json_agg(json_build_object(
            'nodeId', n.node_id,
            'status', n.status,
            'attempts', n.attempts,
            'publicationGeneration', n.queue_publication_generation,
            'publicationRepairAfter', n.queue_publication_repair_after,
            'startedAt', n.started_at,
            'finishedAt', n.finished_at,
            'error', n.error_json
          ) ORDER BY n.node_id), '[]'::json)
          FROM run_nodes n
          WHERE n.run_id = r.id
        )
      ) ORDER BY r.id), '[]'::json)
      FROM (
        SELECT id, status
        FROM target_runs
        WHERE status NOT IN ('succeeded', 'failed', 'cancelled')
        ORDER BY id
        LIMIT 20
      ) r
    ),
    'terminalLatencies', (
      SELECT coalesce(json_agg(json_build_object(
        'runId', id,
        'terminalMs', terminal_ms
      ) ORDER BY id), '[]'::json)
      FROM (
        SELECT
          r.id,
          round(extract(epoch FROM (max(n.finished_at) - r.created_at)) * 1000)::integer
            AS terminal_ms
        FROM target_runs r
        JOIN run_nodes n ON n.run_id = r.id
        GROUP BY r.id, r.created_at
      ) durations
    )
  )::text;`;
  const result = await run(
    "docker",
    [
      "exec",
      "supabase_db_janusly-local",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-Atqc",
      query,
    ],
    {},
    { capture: true },
  );
  assert.ok(result.stdout.trim(), "load/soak database snapshot is missing");
  return JSON.parse(result.stdout.trim());
}

async function qualifyLoadSoak() {
  await run(process.execPath, ["scripts/local-stack.mjs", "reset"]);
  await run(process.execPath, ["scripts/local-stack.mjs", "up"]);
  const settings = await getLocalStackSettings();
  const localFile = parseEnvFile(
    await readFile(new URL("../deploy/local/local.env", import.meta.url), "utf8"),
  );
  const apiMetricsUrl = `http://127.0.0.1:${
    process.env.JANUSLY_LOCAL_API_METRICS_PORT
      || localFile.JANUSLY_LOCAL_API_METRICS_PORT
      || "9464"
  }/metrics`;
  const workerMetricsUrl = `http://127.0.0.1:${
    process.env.JANUSLY_LOCAL_WORKER_METRICS_PORT
      || localFile.JANUSLY_LOCAL_WORKER_METRICS_PORT
      || "9465"
  }/metrics`;
  const headers = {
    "content-type": "application/json",
    "x-org-id": settings.orgId,
    "x-user-id": "local-load-soak",
  };

  await requestJson(`${settings.apiUrl}/workflows/save`, {
    method: "POST",
    headers,
    body: JSON.stringify(workflow),
  });

  const queueSamples = [];
  const health = { failures: 0, degradedSamples: 0 };
  let sample = true;
  const sampler = (async () => {
    while (sample) {
      const sampledAt = new Date().toISOString();
      const [queueResult, healthResult] = await Promise.allSettled([
        requestJson(`${settings.apiUrl}/system/queue`, { headers }),
        requestJson(`${settings.apiUrl}/health`),
      ]);
      if (queueResult.status === "fulfilled" && queueResult.value) {
        const snapshot = queueResult.value;
        queueSamples.push({
          sampledAt,
          waiting: snapshot.waiting,
          active: snapshot.active,
          oldestWaitingSeconds: snapshot.oldestWaitingSeconds,
          maintenanceWaiting: snapshot.maintenance?.waiting ?? 0,
          maintenanceActive: snapshot.maintenance?.active ?? 0,
        });
      } else {
        health.failures += 1;
      }
      if (healthResult.status === "fulfilled") {
        if (healthResult.value.queue?.degraded === true) {
          health.degradedSamples += 1;
        }
      } else {
        health.failures += 1;
      }
      await delay(250);
    }
  })();

  let sequence = 0;
  async function submitRun(phase) {
    sequence += 1;
    const startedAt = Date.now();
    const accepted = await requestJson(`${settings.apiUrl}/start`, {
      method: "POST",
      headers,
      body: JSON.stringify(workflow),
      timeoutMs: config.maxAcceptLatencyMs + 1_000,
    });
    assert.equal(typeof accepted.runId, "string", "start response omitted runId");
    return {
      runId: accepted.runId,
      phase,
      sequence,
      acceptedAt: Date.now(),
      acceptMs: Date.now() - startedAt,
      terminalMs: null,
      terminalObservedMs: null,
      status: "accepted",
    };
  }

  const burst = await mapConcurrent(
    Array.from({ length: config.burstRuns }, (_, index) => index),
    config.burstConcurrency,
    () => submitRun("burst"),
  );
  const soak = [];
  const soakStartedAt = Date.now();
  const intervalMs = 1_000 / config.soakRps;
  for (let index = 0; index < config.soakRuns; index += 1) {
    const dueAt = soakStartedAt + Math.floor(index * intervalMs);
    if (Date.now() < dueAt) await delay(dueAt - Date.now());
    soak.push(await submitRun("soak"));
  }
  const acceptedRuns = [...burst, ...soak];

  const pending = new Map(acceptedRuns.map((entry) => [entry.runId, entry]));
  const terminalDeadline = Date.now() + config.maxTerminalLatencyMs;
  while (pending.size > 0 && Date.now() < terminalDeadline) {
    await mapConcurrent(
      [...pending.values()],
      40,
      async (entry) => {
        const status = await requestJson(
          `${settings.apiUrl}/status?runId=${encodeURIComponent(entry.runId)}`,
          { headers },
        );
        if (["succeeded", "failed", "cancelled"].includes(status.run.status)) {
          entry.status = status.run.status;
          entry.terminalObservedMs = Date.now() - entry.acceptedAt;
          pending.delete(entry.runId);
        }
      },
    );
    if (pending.size > 0) await delay(250);
  }
  if (pending.size > 0) {
    const [database, queue, apiRuns] = await Promise.all([
      readDatabaseSnapshot(workflow.id, settings.orgId),
      requestJson(`${settings.apiUrl}/system/queue`, { headers }).catch((error) => ({
        error: error instanceof Error ? error.message : String(error),
      })),
      mapConcurrent(
        [...pending.values()].slice(0, 20),
        10,
        async (entry) => {
          try {
            return await requestJson(
              `${settings.apiUrl}/status?runId=${encodeURIComponent(entry.runId)}`,
              { headers },
            );
          } catch (error) {
            return {
              runId: entry.runId,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
      ),
    ]);
    await writeFile(
      failureDiagnosticsPath,
      `${JSON.stringify({
        capturedAt: new Date().toISOString(),
        pendingCount: pending.size,
        pendingRunIds: [...pending.keys()].slice(0, 20),
        queue,
        database,
        apiRuns,
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  assert.equal(
    pending.size,
    0,
    `${pending.size} load/soak runs did not reach a terminal status`,
  );

  let finalQueue = null;
  const drainDeadline = Date.now() + 30_000;
  while (Date.now() < drainDeadline) {
    const snapshot = await requestJson(`${settings.apiUrl}/system/queue`, { headers });
    finalQueue = {
      waiting: snapshot.waiting,
      active: snapshot.active,
      maintenanceWaiting: snapshot.maintenance?.waiting ?? 0,
      maintenanceActive: snapshot.maintenance?.active ?? 0,
    };
    if (Object.values(finalQueue).every((value) => value === 0)) break;
    await delay(1_000);
  }
  sample = false;
  await sampler;

  const [apiMetrics, workerMetrics] = await Promise.all([
    fetch(apiMetricsUrl, { signal: AbortSignal.timeout(5_000) }).then((response) =>
      response.ok ? response.text() : ""),
    fetch(workerMetricsUrl, { signal: AbortSignal.timeout(5_000) }).then((response) =>
      response.ok ? response.text() : ""),
  ]);
  const metrics = {
    apiPresent: apiMetrics.includes("janusly_rate_limit_degraded_buckets"),
    workerPresent: [
      "workflow_queue_waiting_jobs",
      "workflow_queue_active_jobs",
      "maintenance_queue_waiting_jobs",
      "maintenance_queue_active_jobs",
    ].every((name) => workerMetrics.includes(name)),
  };
  const database = await readDatabaseSnapshot(workflow.id, settings.orgId);
  const terminalLatencyByRun = new Map(
    database.terminalLatencies.map(({ runId, terminalMs }) => [runId, terminalMs]),
  );
  for (const entry of acceptedRuns) {
    entry.terminalMs = terminalLatencyByRun.get(entry.runId) ?? null;
  }
  const observed = {
    config,
    runs: acceptedRuns,
    queue: {
      samples: queueSamples.length,
      maxWaiting: Math.max(...queueSamples.map(({ waiting }) => waiting), 0),
      maxActive: Math.max(...queueSamples.map(({ active }) => active), 0),
      maxOldestWaitingSeconds: Math.max(
        ...queueSamples.map(({ oldestWaitingSeconds }) => oldestWaitingSeconds ?? 0),
        0,
      ),
      final: finalQueue,
    },
    database,
    health,
    metrics,
  };
  const validation = validateLoadSoakResult(observed);

  await run(
    "pnpm",
    [
      "--filter", "@janusly/web", "exec", "playwright", "test",
      "e2e/local-load-soak.spec.ts",
      "--project=chromium",
      "--workers=1",
    ],
    {
      JANUSLY_LOCAL_LOAD_SOAK_E2E: "1",
      JANUSLY_LOCAL_ORG_ID: settings.orgId,
      JANUSLY_EVIDENCE_DIR: evidenceDirectory,
      JANUSLY_LOAD_WORKFLOW_NAME: workflow.name,
      JANUSLY_LOAD_EXPECTED_RUNS: String(validation.expectedRuns),
      E2E_API_URL: settings.apiUrl,
      E2E_API_METRICS_URL: apiMetricsUrl,
      E2E_WORKER_METRICS_URL: workerMetricsUrl,
      PLAYWRIGHT_BASE_URL: settings.webUrl,
      PLAYWRIGHT_SKIP_WEB_SERVER: "1",
    },
  );
  await Promise.all(
    screenshots.map((name) => chmod(join(evidenceDirectory, name), 0o600)),
  );

  return {
    qualifiedAt: new Date().toISOString(),
    runtime: { node: process.version },
    urls: {
      web: settings.webUrl,
      api: settings.apiUrl,
      apiMetrics: apiMetricsUrl,
      workerMetrics: workerMetricsUrl,
    },
    scope: {
      orgId: settings.orgId,
    },
    workflow: {
      id: workflow.id,
      name: workflow.name,
      nodesPerRun: config.nodesPerRun,
    },
    workload: {
      burstRuns: config.burstRuns,
      burstConcurrency: config.burstConcurrency,
      soakRuns: config.soakRuns,
      soakSeconds: config.soakSeconds,
      soakRps: config.soakRps,
    },
    outcomes: {
      runs: validation.expectedRuns,
      nodes: validation.expectedNodes,
      statuses: database.runStatuses,
      nodeStatuses: database.nodeStatuses,
      deadLetters: database.deadLetters,
      pendingQueueRepairs: database.pendingQueueRepairs,
    },
    latency: {
      admission: validation.acceptLatency,
      terminal: validation.terminalLatency,
    },
    queue: observed.queue,
    health,
    metrics,
    browser: {
      activityVisible: true,
      queuesClearAfterDrain: true,
      bilingual: true,
      accessibility: true,
      overflow: false,
      runtimeErrors: false,
    },
    screenshots,
  };
}

const report = await runQualificationWithCleanup(
  qualifyLoadSoak,
  () => run(process.execPath, ["scripts/local-stack.mjs", "reset"]),
  "load/soak qualification",
);
report.cleanup = {
  localPersistentDataRemoved: true,
  stackStopped: true,
};

await writeFile(
  join(evidenceDirectory, "load-soak-qualification.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  { mode: 0o600 },
);
await writeFile(
  join(evidenceDirectory, "qualification-summary.md"),
  `# Local load/soak qualification

- A burst and a sustained admission phase exercise a six-node fan-out/fan-in workflow through the real API, PostgreSQL, BullMQ, Redis, and worker.
- Every accepted run id must be unique, terminal-successful, and represented by the exact expected run/node rows.
- Queue pressure must be observed before both workflow and maintenance lanes drain completely.
- Public health remains available and non-degraded; API and worker Prometheus instruments remain scrapeable.
- Admission and terminal p50/p95/p99 are recorded as a local-machine baseline, not a production capacity claim.
- Activity and infrastructure UI are checked in English and Spanish, including a compact viewport.
- Generated workload data is removed and the local stack is stopped after success or failure.

## Key Learnings:

1. Load qualification should gate correctness, uniqueness, durability, and drain while recording machine-dependent latency instead of presenting a laptop benchmark as production capacity.
2. Queue pressure is meaningful only when it is observed through the same bounded admin surface operators use.
3. A sustained phase catches resource leaks and cache/observability drift that a single burst can miss.
`,
  { mode: 0o600 },
);

console.log(`[local] load/soak evidence: ${evidenceDirectory}`);
