#!/usr/bin/env node

// Operational BullMQ/Postgres handoff gate for the frozen Node oracle and the
// Go candidate. Reads every open job through BullMQ, joins the durable state
// through bounded SQL, and refuses unknown/truncated state. The only mutation
// this command supports is retiring reviewed BullMQ job schedulers through the
// public BullMQ API after the operator confirms Node producers are stopped.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyScheduler,
  evaluateHandoff,
  NODE_ORACLE_COMMIT,
  OPEN_JOB_STATES,
  QUEUE_NAMES,
} from "./queue-handoff-policy.mjs";

const requireFromEngine = createRequire(new URL("../../packages/engine/package.json", import.meta.url));
const { Queue } = requireFromEngine("bullmq");
const IORedis = requireFromEngine("ioredis");
const postgres = requireFromEngine("postgres");

const DEFAULT_MAX_ROWS = 10_000;
const HARD_MAX_ROWS = 100_000;

function openAuditRedis(redisUrl) {
  // Unlike a delivery Worker, the cutover gate must fail in bounded time when
  // Redis is unavailable. It never owns blocking queue consumption.
  const client = new IORedis(redisUrl, {
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    commandTimeout: 10_000,
    enableReadyCheck: true,
    retryStrategy: attempts => attempts <= 3 ? Math.min(100 * attempts, 500) : null,
  });
  // ioredis otherwise writes every retry as an "Unhandled error event" even
  // though the awaited BullMQ operation returns the final bounded error.
  client.on("error", () => {});
  return client;
}

function parseArgs(argv) {
  const [command = "verify", ...rest] = argv;
  const options = {};
  for (const raw of rest) {
    if (!raw.startsWith("--")) throw new Error(`Unexpected argument: ${raw}`);
    const [key, ...tail] = raw.slice(2).split("=");
    options[key] = tail.length > 0 ? tail.join("=") : true;
  }
  return { command, options };
}

function boundedRows(raw) {
  if (raw === undefined) return DEFAULT_MAX_ROWS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > HARD_MAX_ROWS) {
    throw new Error(`--max-rows must be an integer from 1 to ${HARD_MAX_ROWS}`);
  }
  return parsed;
}

function fingerprint(value) {
  if (value === undefined || value === null || value === "") return "";
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function iso(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

function summarizeJobData(name, raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  if (name === "execute-node") {
    return {
      runId: String(data.runId ?? ""),
      nodeId: String(data.nodeId ?? ""),
      attempt: Number(data.attempt ?? 1),
      publicationGeneration: Number(data.publicationGeneration ?? 0),
      recoveryClaimToken: fingerprint(data.recoveryClaimToken),
    };
  }
  if (name === "wait-resume" || name === "approval-deadline-arm" || name === "approval-timeout") {
    return {
      runId: String(data.runId ?? ""),
      nodeId: String(data.nodeId ?? ""),
      ...(data.deadlineAt ? { deadlineAt: String(data.deadlineAt) } : {}),
    };
  }
  if (name === "replay-campaign-step") return { campaignId: String(data.campaignId ?? "") };
  if (name === "memory-bulk-purge-trigger") return { orgId: String(data.orgId ?? "") };
  if (name === "schedule-trigger") return { scheduleEntryId: String(data.scheduleEntryId ?? "") };
  return {};
}

async function mapBatches(values, width, fn) {
  const output = [];
  for (let index = 0; index < values.length; index += width) {
    output.push(...await Promise.all(values.slice(index, index + width).map(fn)));
  }
  return output;
}

async function inspectQueue(queue, maxRows) {
  const [counts, schedulerCount] = await Promise.all([
    queue.getJobCounts(...OPEN_JOB_STATES),
    queue.getJobSchedulersCount(),
  ]);
  const repeatablesRaw = await queue.getRepeatableJobs(0, maxRows, true);
  const openCount = OPEN_JOB_STATES.reduce((total, state) => total + Number(counts[state] ?? 0), 0);
  const jobsRaw = openCount > 0
    ? await queue.getJobs(OPEN_JOB_STATES, 0, Math.min(openCount, maxRows) - 1, true)
    : [];
  const jobs = await mapBatches(jobsRaw, 64, async job => ({
    id: String(job.id ?? ""),
    name: String(job.name ?? ""),
    state: await job.getState(),
    timestamp: iso(job.timestamp),
    delay: Number(job.delay ?? 0),
    data: summarizeJobData(job.name, job.data),
  }));
  const schedulersRaw = schedulerCount > 0
    ? await queue.getJobSchedulers(0, Math.min(schedulerCount, maxRows) - 1, true)
    : [];
  const schedulers = schedulersRaw.map(row => ({
    key: String(row.key ?? ""),
    name: String(row.name ?? ""),
    next: iso(row.next),
    pattern: row.pattern ?? null,
  }));
  // BullMQ 5 exposes modern Job Schedulers through both APIs. Only rows not
  // represented by getJobSchedulers are deprecated repeatable ownership.
  const schedulerIdentities = new Set(schedulers.map(row => `${row.key}\u0000${row.name}`));
  const legacyRepeatablesRaw = repeatablesRaw.filter(row =>
    !schedulerIdentities.has(`${String(row.key ?? "")}\u0000${String(row.name ?? "")}`));
  const repeatableCount = legacyRepeatablesRaw.length;
  const repeatables = legacyRepeatablesRaw.slice(0, maxRows).map(row => ({
    key: String(row.key ?? ""),
    name: String(row.name ?? ""),
    next: iso(row.next),
    pattern: row.pattern ?? null,
  }));
  const [countsAfter, schedulerCountAfter, repeatablesAfter] = await Promise.all([
    queue.getJobCounts(...OPEN_JOB_STATES),
    queue.getJobSchedulersCount(),
    queue.getRepeatableJobs(0, maxRows, true),
  ]);
  const stable = schedulerCount === schedulerCountAfter && repeatablesRaw.length === repeatablesAfter.length &&
    OPEN_JOB_STATES.every(state => Number(counts[state] ?? 0) === Number(countsAfter[state] ?? 0));
  return {
    name: queue.name,
    counts,
    openCount,
    schedulerCount,
    repeatableCount,
    stable,
    truncated: openCount > maxRows || schedulerCount > maxRows || repeatablesRaw.length > maxRows,
    jobs,
    schedulers,
    repeatables,
  };
}

async function discoverQueueNames(connection, maxRows) {
  const names = new Set();
  let cursor = "0";
  let scanned = 0;
  do {
    const [next, keys] = await connection.scan(cursor, "MATCH", "bull:*:meta", "COUNT", "200");
    cursor = next;
    scanned += keys.length;
    for (const key of keys) {
      if (!key.startsWith("bull:") || !key.endsWith(":meta")) continue;
      names.add(key.slice("bull:".length, -":meta".length));
      if (names.size > maxRows) return { names: [...names].sort(), truncated: true };
    }
  } while (cursor !== "0" && scanned <= maxRows * 20);
  return { names: [...names].sort(), truncated: cursor !== "0" };
}

async function inspectQueues(redisUrl, maxRows) {
  const connection = openAuditRedis(redisUrl);
  let queues = [];
  try {
    const discovered = await discoverQueueNames(connection, maxRows);
    queues = QUEUE_NAMES.map(name => new Queue(name, { connection }));
    const snapshots = [];
    for (const queue of queues) snapshots.push(await inspectQueue(queue, maxRows));
    return {
      queues: snapshots,
      unknownQueueNames: discovered.names.filter(name => !QUEUE_NAMES.includes(name)),
      discoveryTruncated: discovered.truncated,
    };
  } finally {
    await Promise.allSettled(queues.map(queue => queue.close()));
    await connection.quit().catch(() => connection.disconnect());
  }
}

function relevantWaitingKeys(queues) {
  const seen = new Set();
  const keys = [];
  for (const queue of queues) {
    for (const job of queue.jobs) {
      if (!["wait-resume", "approval-deadline-arm", "approval-timeout"].includes(job.name)) continue;
      const runId = String(job.data?.runId ?? "");
      const nodeId = String(job.data?.nodeId ?? "");
      const key = `${runId}\u0000${nodeId}`;
      if (!runId || !nodeId || seen.has(key)) continue;
      seen.add(key);
      keys.push({ run_id: runId, node_id: nodeId });
    }
  }
  return keys;
}

function relevantCampaignIds(queues) {
  return [...new Set(queues.flatMap(queue => queue.jobs)
    .filter(job => job.name === "replay-campaign-step")
    .map(job => String(job.data?.campaignId ?? ""))
    .filter(Boolean))];
}

async function readDatabase(databaseUrl, queues, maxRows) {
  const sql = postgres(databaseUrl, {
    max: 2,
    idle_timeout: 5,
    connect_timeout: 10,
    prepare: false,
  });
  try {
    const [summary] = await sql`
      SELECT
        count(*) FILTER (WHERE rn.status='running')::int AS running_nodes,
        count(*) FILTER (WHERE rn.status='queued' AND r.status='running')::int AS queued_nodes
      FROM run_nodes rn
      JOIN runs r ON r.id=rn.run_id
    `;
    const queuedRows = await sql`
      SELECT rn.id, rn.run_id, rn.node_id, COALESCE(rn.attempts, 1)::int AS attempt,
             rn.recovery_claim_token, rn.queue_publication_generation,
             rn.queue_publication_repair_after, w.wake_at, w.reason AS wakeup_reason
      FROM run_nodes rn
      JOIN runs r ON r.id=rn.run_id
      LEFT JOIN go_pilot_wakeups w ON w.run_node_id=rn.id
      WHERE rn.status='queued' AND r.status='running'
      ORDER BY rn.id
      LIMIT ${maxRows + 1}
    `;

    const waitingKeys = relevantWaitingKeys(queues);
    const waitingRows = waitingKeys.length === 0 ? [] : await sql`
      WITH requested AS (
        SELECT * FROM jsonb_to_recordset(${sql.json(waitingKeys)}::jsonb)
          AS x(run_id text, node_id text)
      )
      SELECT x.run_id, x.node_id, rn.status,
             rn.state_json #>> '{waiting,kind}' AS waiting_kind,
             CASE
               WHEN rn.state_json #>> '{waiting,kind}'='approval'
                 THEN rn.state_json #>> '{waiting,deadlineAt}'
               ELSE rn.state_json #>> '{waiting,wakeAt}'
             END AS waiting_target,
             w.wake_at, w.reason AS wakeup_reason
      FROM requested x
      LEFT JOIN run_nodes rn ON rn.run_id=x.run_id AND rn.node_id=x.node_id
      LEFT JOIN go_pilot_wakeups w ON w.run_node_id=rn.id
    `;

    const waitingBridgeRows = await sql`
      SELECT rn.run_id, rn.node_id,
             rn.state_json #>> '{waiting,kind}' AS kind,
             CASE
               WHEN rn.state_json #>> '{waiting,kind}'='approval'
                 THEN rn.state_json #>> '{waiting,deadlineAt}'
               ELSE rn.state_json #>> '{waiting,wakeAt}'
             END AS waiting_target,
             w.wake_at, w.reason AS wakeup_reason
      FROM run_nodes rn
      LEFT JOIN go_pilot_wakeups w ON w.run_node_id=rn.id
      WHERE rn.status='waiting'
        AND (
          rn.state_json #>> '{waiting,kind}'='timer'
          OR
          (rn.state_json #>> '{waiting,kind}'='approval'
           AND COALESCE(rn.state_json #>> '{waiting,deadlineAt}', '') <> ''
           AND COALESCE(rn.state_json #>> '{waiting,timeoutState}', '') = '')
        )
      ORDER BY rn.id
      LIMIT ${maxRows + 1}
    `;
    const unarmedSchedules = await sql`
      SELECT id, workflow_id, node_id
      FROM schedule_entries
      WHERE enabled AND next_fire_at IS NULL
      ORDER BY id
      LIMIT ${maxRows + 1}
    `;

    const campaignIds = relevantCampaignIds(queues);
    const campaignRows = campaignIds.length === 0 ? [] : await sql`
      WITH requested AS (
        SELECT value AS id FROM jsonb_array_elements_text(${sql.json(campaignIds)}::jsonb)
      )
      SELECT c.id FROM replay_campaigns c JOIN requested r ON r.id=c.id
    `;

    const invalidWaiting = waitingBridgeRows.filter(row => {
      const expectedReason = row.kind === "approval" ? "approval_timeout" : "wait_until";
      const target = row.waiting_target ? Date.parse(row.waiting_target) : Number.NaN;
      const wake = row.wake_at ? new Date(row.wake_at).getTime() : Number.NaN;
      return row.wakeup_reason !== expectedReason || !Number.isFinite(target) || target !== wake;
    });

    return {
      runningNodes: Number(summary?.running_nodes ?? 0),
      queuedNodeCount: Number(summary?.queued_nodes ?? 0),
      queuedNodes: queuedRows.slice(0, maxRows).map(row => ({
        id: row.id,
        runId: row.run_id,
        nodeId: row.node_id,
        attempt: Number(row.attempt),
        recoveryClaimToken: fingerprint(row.recovery_claim_token),
        publicationGeneration: Number(row.queue_publication_generation),
        repairAfter: iso(row.queue_publication_repair_after),
        wakeupAt: iso(row.wake_at),
        wakeupReason: row.wakeup_reason ?? null,
      })),
      waitingCheckpoints: waitingRows.map(row => ({
        runId: row.run_id ?? "",
        nodeId: row.node_id ?? "",
        status: row.status ?? null,
        waitingKind: row.waiting_kind ?? null,
        waitingTarget: row.waiting_target ?? null,
        wakeupAt: iso(row.wake_at),
        wakeupReason: row.wakeup_reason ?? null,
      })),
      invalidWaitingCheckpoints: invalidWaiting.slice(0, maxRows).map(row => ({
        runId: row.run_id, nodeId: row.node_id, kind: row.kind,
      })),
      unarmedSchedules: unarmedSchedules.slice(0, maxRows).map(row => ({
        id: row.id, workflowId: row.workflow_id, nodeId: row.node_id,
      })),
      replayCampaignIds: campaignRows.map(row => row.id),
      truncated: Number(summary?.queued_nodes ?? 0) > maxRows ||
        waitingBridgeRows.length > maxRows || unarmedSchedules.length > maxRows,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function retireSchedulers(redisUrl, maxRows, confirmed) {
  if (!confirmed) {
    throw new Error("retire-schedulers requires --confirm-node-producers-stopped");
  }
  const connection = openAuditRedis(redisUrl);
  let queues = [];
  try {
    const discovery = await discoverQueueNames(connection, maxRows);
    queues = QUEUE_NAMES.map(name => new Queue(name, { connection }));
    const before = [];
    for (const queue of queues) before.push(await inspectQueue(queue, maxRows));
    const schedulers = before.flatMap(queue => queue.schedulers.map(row => ({ queue: queue.name, ...row })));
    const unknown = schedulers.filter(row => !classifyScheduler(row.queue, row).known);
    const unknownQueues = discovery.names.filter(name => !QUEUE_NAMES.includes(name));
    const repeatables = before.flatMap(queue => queue.repeatables.map(row => ({ queue: queue.name, ...row })));
    if (discovery.truncated || before.some(queue => queue.truncated || !queue.stable) ||
        unknown.length > 0 || unknownQueues.length > 0 || repeatables.length > 0) {
      return {
        pass: false,
        command: "retire-schedulers",
        removed: [],
        blockers: [
          ...(discovery.truncated || before.some(queue => queue.truncated) ? [{ code: "inventory_truncated" }] : []),
          ...(before.some(queue => !queue.stable) ? [{ code: "inventory_unstable" }] : []),
          ...unknownQueues.map(queue => ({ code: "unknown_queue", queue })),
          ...repeatables.map(row => ({ code: "legacy_repeatable_present", ...row })),
          ...unknown.map(row => ({ code: "unknown_scheduler", ...row })),
        ],
      };
    }
    const removed = [];
    for (const queue of queues) {
      const current = before.find(row => row.name === queue.name);
      for (const scheduler of current.schedulers) {
        const didRemove = await queue.removeJobScheduler(scheduler.key);
        if (didRemove) removed.push({ queue: queue.name, key: scheduler.key, name: scheduler.name });
      }
    }
    const remaining = [];
    for (const queue of queues) {
      const count = await queue.getJobSchedulersCount();
      if (count > 0) remaining.push({ queue: queue.name, count });
    }
    return {
      pass: remaining.length === 0 && removed.length === schedulers.length,
      command: "retire-schedulers",
      removed,
      remaining,
    };
  } finally {
    await Promise.allSettled(queues.map(queue => queue.close()));
    await connection.quit().catch(() => connection.disconnect());
  }
}

async function emit(report, output) {
  const body = `${JSON.stringify(report, null, 2)}\n`;
  if (output) {
    const path = resolve(String(output));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body, { mode: 0o600 });
  }
  process.stdout.write(body);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { command, options } = parseArgs(argv);
  const maxRows = boundedRows(options["max-rows"]);
  const redisUrl = env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL is required");

  if (command === "retire-schedulers") {
    const report = await retireSchedulers(
      redisUrl,
      maxRows,
      options["confirm-node-producers-stopped"] === true,
    );
    await emit({ observedAt: new Date().toISOString(), nodeOracleCommit: NODE_ORACLE_COMMIT, ...report }, options.output);
    return report.pass ? 0 : 2;
  }
  if (command !== "verify" && command !== "snapshot") {
    throw new Error(`Unknown command: ${command}`);
  }
  const direction = options.direction;
  if (direction !== "node-to-go" && direction !== "go-to-node") {
    throw new Error("--direction must be node-to-go or go-to-node");
  }
  const databaseUrl = env.JANUSLY_HANDOFF_DATABASE_URL ?? env.JANUSLY_GO_DATABASE_URL ?? env.DATABASE_URL;
  if (!databaseUrl) throw new Error("JANUSLY_HANDOFF_DATABASE_URL, JANUSLY_GO_DATABASE_URL, or DATABASE_URL is required");

  const before = await inspectQueues(redisUrl, maxRows);
  const database = await readDatabase(databaseUrl, before.queues, maxRows);
  const after = await inspectQueues(redisUrl, maxRows);
  const inventorySignature = inventory => JSON.stringify(inventory.queues.map(queue => ({
    name: queue.name,
    jobs: queue.jobs.map(job => [job.id, job.name, job.state]).sort(),
    schedulers: queue.schedulers.map(row => [row.key, row.name]).sort(),
    repeatables: queue.repeatables.map(row => [row.key, row.name]).sort(),
  })));
  const queues = after.queues;
  const snapshot = {
    direction,
    inventoryTruncated: before.discoveryTruncated || after.discoveryTruncated ||
      queues.some(queue => queue.truncated) || database.truncated,
    inventoryUnstable: before.queues.some(queue => !queue.stable) ||
      after.queues.some(queue => !queue.stable) || inventorySignature(before) !== inventorySignature(after),
    unknownQueueNames: [...new Set([...before.unknownQueueNames, ...after.unknownQueueNames])].sort(),
    queues,
    database,
  };
  const verdict = evaluateHandoff(snapshot);
  const report = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    nodeOracleCommit: NODE_ORACLE_COMMIT,
    command,
    ...snapshot,
    verdict,
  };
  await emit(report, options.output);
  return command === "verify" && !verdict.pass ? 2 : 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().then(code => {
    process.exitCode = code;
  }).catch(error => {
    console.error(`[queue-handoff] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
