#!/usr/bin/env node

// Destructive only inside resources this script creates: one temporary
// PostgreSQL database and one ephemeral Redis container. It exercises the
// production handoff CLI, BullMQ scheduler retirement, execution drain,
// Go-to-Node outbox replay through Node's real reconciler, exact Node claim,
// and the next Go migration's stale-wakeup cleanup.

import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { NODE_ORACLE_COMMIT } from "./queue-handoff-policy.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const goRoot = resolve(scriptDir, "..");
const repoRoot = resolve(goRoot, "..");
const cliPath = resolve(scriptDir, "queue-handoff.mjs");
const composePath = resolve(goRoot, "queue-handoff.compose.yml");
const requireFromEngine = createRequire(new URL("../../packages/engine/package.json", import.meta.url));
const { Queue, Worker } = requireFromEngine("bullmq");
const IORedis = requireFromEngine("ioredis");
const postgres = requireFromEngine("postgres");

const redisPort = Number(process.env.JANUSLY_HANDOFF_REDIS_PORT ?? 4633);
if (!Number.isSafeInteger(redisPort) || redisPort < 1024 || redisPort > 65535) {
  throw new Error("JANUSLY_HANDOFF_REDIS_PORT must be a non-privileged TCP port");
}
const redisUrl = `redis://127.0.0.1:${redisPort}`;
const composeProject = `janusly-go-handoff-${process.pid}`;
const baseDatabaseUrl = process.env.JANUSLY_GO_DATABASE_URL ??
  "postgres://janusly:janusly-go-local@127.0.0.1:4632/janusly_go";
const databaseName = `janusly_handoff_${process.pid}_${Date.now()}`;

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
}

function runGate(direction, databaseUrl, expectedStatus) {
  const child = spawnSync(process.execPath, [cliPath, "verify", `--direction=${direction}`], {
    cwd: goRoot,
    env: {
      ...process.env,
      REDIS_URL: redisUrl,
      JANUSLY_HANDOFF_DATABASE_URL: databaseUrl,
    },
    encoding: "utf8",
  });
  if (child.status !== expectedStatus) {
    throw new Error(`handoff ${direction} exited ${child.status}, expected ${expectedStatus}: ${child.stderr}\n${child.stdout}`);
  }
  return JSON.parse(child.stdout);
}

function blockerCodes(report) {
  return [...new Set(report.verdict.blockers.map(row => row.code))].sort();
}

async function waitFor(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function databaseUrls() {
  const target = new URL(baseDatabaseUrl);
  target.pathname = `/${databaseName}`;
  const admin = new URL(baseDatabaseUrl);
  admin.pathname = "/postgres";
  return { target: target.toString(), admin: admin.toString() };
}

async function invokeNodePublicationReconciler(databaseUrl) {
  const code = `
    (async () => {
      const reconciler = await import('./src/queue-publication-reconciler.ts');
      const queue = await import('./src/queue.ts');
      const db = await import('@janusly/db');
      await reconciler.handleQueuePublicationReconcilerTrigger();
      await Promise.all([queue.workflowQueue.close(), queue.maintenanceQueue.close()]);
      await queue.connection.quit();
      await db.client.end({ timeout: 5 });
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  run("corepack", ["pnpm", "--filter", "@janusly/engine", "exec", "tsx", "-e", code], {
    env: { DATABASE_URL: databaseUrl, REDIS_URL: redisUrl, NODE_ENV: "test" },
  });
}

async function invokeExactNodeClaim(databaseUrl, payload) {
  const literal = JSON.stringify(payload);
  const code = `
    (async () => {
      const input = ${literal};
      const node = await import('./src/persistence-ports/node.ts');
      const db = await import('@janusly/db');
      const result = await node.claimNodeForExecution(
        input.runId, input.nodeId, input.attempt,
        input.recoveryClaimToken || undefined, input.publicationGeneration,
      );
      process.stdout.write(result + '\\n');
      await db.client.end({ timeout: 5 });
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  return run("corepack", ["pnpm", "--filter", "@janusly/engine", "exec", "tsx", "-e", code], {
    env: { DATABASE_URL: databaseUrl, REDIS_URL: redisUrl, NODE_ENV: "test" },
  }).trim().split("\n").at(-1);
}

async function main() {
  const { target: databaseUrl, admin: adminUrl } = databaseUrls();
  let admin;
  let sql;
  let connection;
  let queues = [];
  let unknownQueue;
  let databaseCreated = false;
  const evidence = {
    schemaVersion: 1,
    nodeOracleCommit: NODE_ORACLE_COMMIT,
    // The receipt itself cannot be a member of the tree it hashes. Stage the
    // candidate first, pass git write-tree here, then add the generated receipt.
    testedTree: process.env.JANUSLY_HANDOFF_TESTED_TREE ??
      run("git", ["rev-parse", "HEAD^{tree}"]).trim(),
    phases: {},
  };

  try {
    run("docker", ["compose", "-p", composeProject, "-f", composePath, "up", "-d", "--wait"], {
      cwd: goRoot,
      env: { JANUSLY_HANDOFF_REDIS_PORT: String(redisPort) },
    });

    admin = postgres(adminUrl, { max: 1, prepare: false });
    await admin.unsafe(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    databaseCreated = true;
    run("go", ["run", "./cmd/api", "migrate"], {
      cwd: goRoot,
      env: { JANUSLY_GO_DATABASE_URL: databaseUrl, GOCACHE: "/private/tmp/janusly-go-build-cache" },
    });
    sql = postgres(databaseUrl, { max: 2, prepare: false });

    const timerAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const approvalAt = new Date(timerAt.getTime() + 60_000);
    await sql`
      INSERT INTO runs (id, org_id, workflow_version_id, status, input_json) VALUES
        ('handoff-exec-run', 'handoff-org', 'v-exec', 'running', '{}'::jsonb),
        ('handoff-timer-run', 'handoff-org', 'v-timer', 'running', '{}'::jsonb),
        ('handoff-approval-run', 'handoff-org', 'v-approval', 'running', '{}'::jsonb)
    `;
    await sql`
      INSERT INTO run_nodes (
        id, run_id, node_id, status, attempts, state_json,
        queue_publication_generation, queue_publication_repair_after
      ) VALUES
        ('handoff-exec-node', 'handoff-exec-run', 'execute', 'queued', 1, '{}'::jsonb, 1, NULL),
        ('handoff-timer-node', 'handoff-timer-run', 'wait', 'waiting', 1,
          ${sql.json({ waiting: { kind: "timer", wakeAt: timerAt.toISOString() } })}::jsonb, 1, NULL),
        ('handoff-approval-node', 'handoff-approval-run', 'gate', 'waiting', 1,
          ${sql.json({ waiting: { kind: "approval", deadlineAt: approvalAt.toISOString(), onTimeout: "fail" } })}::jsonb, 1, NULL)
    `;
    await sql`
      INSERT INTO go_pilot_wakeups (run_node_id, wake_at, reason) VALUES
        ('handoff-timer-node', ${timerAt}, 'wait_until'),
        ('handoff-approval-node', ${approvalAt}, 'approval_timeout')
    `;
    await sql`
      INSERT INTO replay_campaigns (
        id, org_id, name, cluster_signature, total_count, created_by, next_dispatch_at
      ) VALUES ('handoff-campaign', 'handoff-org', 'handoff', 'signature', 2, 'operator', ${timerAt})
    `;
    await sql`
      INSERT INTO schedule_entries (
        id, org_id, workflow_id, workflow_version_id, node_id,
        cron_expression, enabled, next_fire_at
      ) VALUES ('handoff-schedule', 'handoff-org', 'workflow', 'version', 'cron', '0 0 1 1 *', true, ${timerAt})
    `;

    connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    queues = [
      new Queue("workflow-nodes", { connection }),
      new Queue("maintenance-jobs", { connection }),
      new Queue("alerts-system", { connection }),
      new Queue("auto-healing-system", { connection }),
    ];
    const byName = new Map(queues.map(queue => [queue.name, queue]));
    await byName.get("workflow-nodes").upsertJobScheduler(
      "schedule:handoff-org:version:cron",
      { pattern: "0 0 1 1 *" },
      { name: "schedule-trigger", data: { scheduleEntryId: "handoff-schedule" } },
    );
    await byName.get("maintenance-jobs").upsertJobScheduler(
      "system:queue-publication-reconciler", { pattern: "* * * * *" },
      { name: "queue-publication-reconciler-trigger", data: {} },
    );
    await byName.get("alerts-system").upsertJobScheduler(
      "system:alerts-scanner", { pattern: "*/2 * * * *" },
      { name: "alerts-scan-trigger", data: {} },
    );
    await byName.get("auto-healing-system").upsertJobScheduler(
      "system:auto-healing-watcher", { pattern: "* * * * *" },
      { name: "auto-healing-watch-trigger", data: {} },
    );
    await byName.get("alerts-system").upsertJobScheduler(
      "system:unknown-handoff", { pattern: "0 0 1 1 *" },
      { name: "unknown-handoff-trigger", data: {} },
    );
    const unknownJob = await byName.get("auto-healing-system").add(
      "unknown-handoff-job", {},
      { delay: timerAt.getTime() - Date.now(), jobId: "handoff-unknown" },
    );
    unknownQueue = new Queue("unknown-handoff-lane", { connection });
    await unknownQueue.add("unreviewed-delivery", {}, {
      delay: timerAt.getTime() - Date.now(), jobId: "handoff-unknown-lane-job",
    });
    const executionJob = await byName.get("workflow-nodes").add(
      "execute-node",
      { runId: "handoff-exec-run", nodeId: "execute", attempt: 1, publicationGeneration: 1 },
      { jobId: "handoff-execution", removeOnComplete: false },
    );
    await byName.get("workflow-nodes").add(
      "wait-resume", { runId: "handoff-timer-run", nodeId: "wait" },
      { delay: timerAt.getTime() - Date.now(), jobId: "handoff-timer" },
    );
    await byName.get("workflow-nodes").add(
      "approval-timeout",
      { runId: "handoff-approval-run", nodeId: "gate", deadlineAt: approvalAt.toISOString() },
      { delay: approvalAt.getTime() - Date.now(), jobId: "handoff-approval" },
    );
    await byName.get("workflow-nodes").add(
      "replay-campaign-step", { campaignId: "handoff-campaign" },
      { delay: timerAt.getTime() - Date.now(), jobId: "handoff-campaign-step" },
    );
    await byName.get("maintenance-jobs").add(
      "memory-bulk-purge-trigger", { orgId: "handoff-org" },
      { delay: timerAt.getTime() - Date.now(), jobId: "handoff-memory-purge" },
    );

    const initial = runGate("node-to-go", databaseUrl, 2);
    evidence.phases.initialBlocked = {
      pass: !initial.verdict.pass,
      gatePass: initial.verdict.pass,
      blockerCodes: blockerCodes(initial),
    };
    for (const required of [
      "scheduler_present", "execution_job_present", "queued_nodes", "unknown_scheduler", "unknown_job", "unknown_queue",
    ]) {
      if (!evidence.phases.initialBlocked.blockerCodes.includes(required)) {
        throw new Error(`initial handoff did not prove blocker ${required}`);
      }
    }

    const refusedRetirement = spawnSync(process.execPath, [
      cliPath, "retire-schedulers", "--confirm-node-producers-stopped",
    ], {
      cwd: goRoot,
      env: { ...process.env, REDIS_URL: redisUrl },
      encoding: "utf8",
    });
    if (refusedRetirement.status !== 2) {
      throw new Error(`unknown scheduler did not fail closed: ${refusedRetirement.stderr}\n${refusedRetirement.stdout}`);
    }
    const refusedReport = JSON.parse(refusedRetirement.stdout);
    if (refusedReport.removed.length !== 0 ||
        !refusedReport.blockers.some(row => row.code === "unknown_scheduler") ||
        !refusedReport.blockers.some(row => row.code === "unknown_queue")) {
      throw new Error("scheduler retirement mutated Redis before rejecting unknown ownership");
    }
    evidence.phases.unknownStateRefused = { pass: true, schedulerRemovals: 0 };
    await byName.get("alerts-system").removeJobScheduler("system:unknown-handoff");
    await unknownJob.remove();
    await unknownQueue.obliterate({ force: true });
    await unknownQueue.close();
    unknownQueue = undefined;

    const retirement = spawnSync(process.execPath, [
      cliPath, "retire-schedulers", "--confirm-node-producers-stopped",
    ], {
      cwd: goRoot,
      env: { ...process.env, REDIS_URL: redisUrl },
      encoding: "utf8",
    });
    if (retirement.status !== 0) throw new Error(`scheduler retirement failed: ${retirement.stderr}\n${retirement.stdout}`);
    const retirementReport = JSON.parse(retirement.stdout);
    evidence.phases.schedulersRetired = {
      pass: retirementReport.pass,
      count: retirementReport.removed.length,
      queues: [...new Set(retirementReport.removed.map(row => row.queue))].sort(),
    };

    const workerConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    const worker = new Worker("workflow-nodes", async job => {
      if (job.name !== "execute-node" || job.id !== executionJob.id) {
        throw new Error(`unexpected rehearsal delivery ${job.name}/${job.id}`);
      }
      await sql`
        UPDATE run_nodes SET status='succeeded', finished_at=now()
        WHERE run_id='handoff-exec-run' AND node_id='execute' AND status='queued'
      `;
      await sql`UPDATE runs SET status='succeeded' WHERE id='handoff-exec-run'`;
      return { ok: true };
    }, { connection: workerConnection, concurrency: 1 });
    await waitFor(async () => (await executionJob.getState()) === "completed", "execution drain");
    await worker.close();
    await workerConnection.quit();

    const drained = runGate("node-to-go", databaseUrl, 0);
    evidence.phases.nodeToGoReady = {
      pass: drained.verdict.pass,
      parkedJobs: drained.queues.flatMap(queue => queue.jobs.map(job => job.name)).sort(),
    };

    // Leave enough wall time for a cold tsx process to prove the pre-deadline
    // scan. The production contract is the database instant, not this delay.
    const retryAt = new Date(Date.now() + 5_000);
    await sql`
      INSERT INTO runs (id, org_id, workflow_version_id, status, input_json)
      VALUES ('handoff-go-run', 'handoff-org', 'v-go', 'running', '{}'::jsonb)
    `;
    await sql`
      INSERT INTO run_nodes (
        id, run_id, node_id, status, attempts, state_json,
        queue_publication_generation, queue_publication_repair_after
      ) VALUES (
        'handoff-go-node', 'handoff-go-run', 'retry', 'queued', 2, '{}'::jsonb, 7, ${retryAt}
      )
    `;
    await sql`
      INSERT INTO go_pilot_wakeups (run_node_id, wake_at, reason)
      VALUES ('handoff-go-node', ${retryAt}, 'retry')
    `;
    const rollbackReady = runGate("go-to-node", databaseUrl, 0);
    evidence.phases.goToNodeReady = { pass: rollbackReady.verdict.pass, mirroredRetryAt: true };

    await invokeNodePublicationReconciler(databaseUrl);
    let markerBeforeDue;
    await sql`SELECT queue_publication_repair_after FROM run_nodes WHERE id='handoff-go-node'`
      .then(rows => { markerBeforeDue = rows[0].queue_publication_repair_after; });
    const preDueJobs = await byName.get("workflow-nodes").getJobs(["waiting", "delayed", "prioritized"], 0, 100, true);
    if (!markerBeforeDue || preDueJobs.some(job => job.data?.runId === "handoff-go-run")) {
      throw new Error("Node reconciler published the Go retry before its durable deadline");
    }
    evidence.phases.preDeadlinePreserved = { pass: true };

    await waitFor(() => Date.now() >= retryAt.getTime() + 50, "retry deadline", 10_000);
    await invokeNodePublicationReconciler(databaseUrl);
    const postDueRows = await sql`
      SELECT queue_publication_repair_after FROM run_nodes WHERE id='handoff-go-node'
    `;
    const postDueJobs = await byName.get("workflow-nodes").getJobs(["waiting", "delayed", "prioritized"], 0, 100, true);
    const rollbackJob = postDueJobs.find(job => job.data?.runId === "handoff-go-run" && job.data?.nodeId === "retry");
    if (postDueRows[0].queue_publication_repair_after !== null || !rollbackJob) {
      throw new Error("Node reconciler did not publish and acknowledge the due Go generation");
    }
    const published = runGate("go-to-node", databaseUrl, 0);
    evidence.phases.nodeRepublished = { pass: published.verdict.pass, exactGeneration: true };

    const claim = await invokeExactNodeClaim(databaseUrl, rollbackJob.data);
    if (claim !== "claimed") throw new Error(`Node rejected the rollback generation: ${claim}`);
    await rollbackJob.remove();
    await sql`
      UPDATE run_nodes SET status='succeeded', finished_at=now()
      WHERE id='handoff-go-node' AND status='running'
    `;
    await sql`UPDATE runs SET status='succeeded' WHERE id='handoff-go-run'`;
    run("go", ["run", "./cmd/api", "migrate"], {
      cwd: goRoot,
      env: { JANUSLY_GO_DATABASE_URL: databaseUrl, GOCACHE: "/private/tmp/janusly-go-build-cache" },
    });
    const wakeRows = await sql`SELECT count(*)::int AS count FROM go_pilot_wakeups WHERE run_node_id='handoff-go-node'`;
    if (Number(wakeRows[0].count) !== 0) throw new Error("next Go migration retained Node-consumed retry clock");
    evidence.phases.roundTrip = { pass: true, nodeClaim: claim, spentWakeupRemoved: true };

    const finalGate = runGate("node-to-go", databaseUrl, 0);
    evidence.phases.finalNodeToGoReady = { pass: finalGate.verdict.pass };
    evidence.pass = Object.values(evidence.phases).every(phase => phase.pass !== false);
    if (!evidence.pass) throw new Error("queue handoff rehearsal did not pass every phase");

    const output = process.env.JANUSLY_HANDOFF_EVIDENCE;
    const body = `${JSON.stringify(evidence, null, 2)}\n`;
    if (output) {
      const path = resolve(output);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body, { mode: 0o600 });
    }
    process.stdout.write(body);
  } finally {
    if (unknownQueue) await unknownQueue.close().catch(() => undefined);
    await Promise.allSettled(queues.map(queue => queue.close()));
    if (connection) await connection.quit().catch(() => connection.disconnect());
    if (sql) await sql.end({ timeout: 5 }).catch(() => undefined);
    if (databaseCreated && admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
    }
    if (admin) await admin.end({ timeout: 5 }).catch(() => undefined);
    try {
      run("docker", ["compose", "-p", composeProject, "-f", composePath, "down", "-v"], {
        cwd: goRoot,
        env: { JANUSLY_HANDOFF_REDIS_PORT: String(redisPort) },
      });
    } catch {
      // The primary error remains more useful; the unique project name lets
      // an operator remove a failed rehearsal container explicitly.
    }
  }
}

main().catch(error => {
  console.error(`[queue-handoff-rehearsal] ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
