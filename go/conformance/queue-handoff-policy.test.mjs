import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  classifyJob,
  classifyScheduler,
  evaluateHandoff,
  QUEUE_NAMES,
} from "./queue-handoff-policy.mjs";

function emptySnapshot(direction) {
  return {
    direction,
    inventoryTruncated: false,
    queues: QUEUE_NAMES.map(name => ({ name, jobs: [], schedulers: [] })),
    database: {
      runningNodes: 0,
      queuedNodes: [],
      waitingCheckpoints: [],
      replayCampaignIds: [],
      invalidWaitingCheckpoints: [],
      unarmedSchedules: [],
    },
  };
}

function workflowQueue(snapshot) {
  return snapshot.queues.find(queue => queue.name === "workflow-nodes");
}

test("scheduler catalog accepts only the frozen queue/id/name tuples", () => {
  assert.deepEqual(
    classifyScheduler("workflow-nodes", {
      key: "schedule:org:version:node", name: "schedule-trigger",
    }),
    { known: true, kind: "workflow_schedule" },
  );
  assert.equal(classifyScheduler("workflow-nodes", {
    key: "schedule:org:version:node:extra", name: "schedule-trigger",
  }).known, false);
  assert.equal(classifyScheduler("maintenance-jobs", {
    key: "system:queue-publication-reconciler", name: "queue-publication-reconciler-trigger",
  }).known, true);
  assert.equal(classifyScheduler("maintenance-jobs", {
    key: "system:queue-publication-reconciler", name: "wrong",
  }).known, false);
  assert.equal(classifyScheduler("alerts-system", {
    key: "system:alerts-scanner", name: "alerts-scan-trigger",
  }).known, true);
  assert.equal(classifyScheduler("auto-healing-system", {
    key: "system:auto-healing-watcher", name: "auto-healing-watch-trigger",
  }).known, true);
});

test("node-to-go accepts only durable parked jobs after execution drain", () => {
  const snapshot = emptySnapshot("node-to-go");
  workflowQueue(snapshot).jobs.push(
    {
      id: "timer-job", name: "wait-resume", state: "delayed",
      data: { runId: "run-timer", nodeId: "wait" },
    },
    {
      id: "approval-job", name: "approval-timeout", state: "delayed",
      data: { runId: "run-approval", nodeId: "gate", deadlineAt: "2026-08-03T13:00:00.000Z" },
    },
    {
      id: "campaign-job", name: "replay-campaign-step", state: "delayed",
      data: { campaignId: "campaign-1" },
    },
  );
  snapshot.database.waitingCheckpoints.push(
    {
      runId: "run-timer", nodeId: "wait", status: "waiting", waitingKind: "timer",
      waitingTarget: "2026-08-03T12:00:00Z", wakeupAt: "2026-08-03T12:00:00.000Z",
      wakeupReason: "wait_until",
    },
    {
      runId: "run-approval", nodeId: "gate", status: "waiting", waitingKind: "approval",
      waitingTarget: "2026-08-03T13:00:00Z", wakeupAt: "2026-08-03T13:00:00.000Z",
      wakeupReason: "approval_timeout",
    },
  );
  snapshot.database.replayCampaignIds.push("campaign-1");
  assert.deepEqual(evaluateHandoff(snapshot), {
    pass: true, direction: "node-to-go", blockers: [], warnings: [],
  });
});

test("node-to-go fails closed on scheduler, execution, schedule, unknown, and database work", () => {
  const snapshot = emptySnapshot("node-to-go");
  workflowQueue(snapshot).schedulers.push({
    key: "schedule:org:version:node", name: "schedule-trigger",
  });
  workflowQueue(snapshot).jobs.push(
    { id: "execute", name: "execute-node", state: "delayed", data: { runId: "r", nodeId: "n" } },
    { id: "tick", name: "schedule-trigger", state: "delayed", data: { scheduleEntryId: "s" } },
    { id: "poison", name: "future-job", state: "waiting", data: {} },
  );
  snapshot.database.runningNodes = 1;
  snapshot.database.queuedNodes.push({ runId: "r", nodeId: "n" });
  const verdict = evaluateHandoff(snapshot);
  assert.equal(verdict.pass, false);
  assert.deepEqual(new Set(verdict.blockers.map(row => row.code)), new Set([
    "scheduler_present", "execution_job_present", "schedule_tick_present",
    "unknown_job", "running_nodes", "queued_nodes",
  ]));
});

test("cross-store inventory rejects unknown queues, legacy repeatables, and moving snapshots", () => {
  const snapshot = emptySnapshot("node-to-go");
  snapshot.inventoryUnstable = true;
  snapshot.unknownQueueNames = ["stale-worker-lane"];
  workflowQueue(snapshot).repeatables = [{ key: "legacy:key", name: "legacy-cron" }];
  const verdict = evaluateHandoff(snapshot);
  assert.deepEqual(new Set(verdict.blockers.map(row => row.code)), new Set([
    "inventory_unstable", "unknown_queue", "legacy_repeatable_present",
  ]));
});

test("go-to-node requires the shared outbox and mirrors retry due time exactly", () => {
  const snapshot = emptySnapshot("go-to-node");
  snapshot.database.queuedNodes.push({
    runId: "run", nodeId: "node", attempt: 2, publicationGeneration: 4,
    recoveryClaimToken: "", repairAfter: null,
    wakeupReason: "retry", wakeupAt: "2026-08-03T12:00:00Z",
  });
  let verdict = evaluateHandoff(snapshot);
  assert.equal(verdict.pass, false);
  assert.deepEqual(verdict.blockers.map(row => row.code), [
    "rollback_publication_missing", "rollback_retry_clock_mismatch",
  ]);

  snapshot.database.queuedNodes[0].repairAfter = "2026-08-03T12:00:00.000Z";
  verdict = evaluateHandoff(snapshot);
  assert.equal(verdict.pass, true);
});

test("go-to-node accepts an exact already-published BullMQ generation", () => {
  const snapshot = emptySnapshot("go-to-node");
  snapshot.database.queuedNodes.push({
    runId: "run", nodeId: "node", attempt: 3, publicationGeneration: 8,
    recoveryClaimToken: "token-fingerprint", repairAfter: null,
    wakeupReason: null, wakeupAt: null,
  });
  workflowQueue(snapshot).jobs.push({
    id: "job", name: "execute-node", state: "waiting",
    data: {
      runId: "run", nodeId: "node", attempt: 3, publicationGeneration: 8,
      recoveryClaimToken: "token-fingerprint",
    },
  });
  assert.equal(evaluateHandoff(snapshot).pass, true);
  workflowQueue(snapshot).jobs[0].data.publicationGeneration = 7;
  assert.equal(evaluateHandoff(snapshot).pass, false);
});

test("catalog matches every literal workflow producer in the candidate source", async () => {
  const queueSource = await readFile(new URL("../../packages/engine/src/queue.ts", import.meta.url), "utf8");
  const producedNames = [...queueSource.matchAll(/workflowQueue\.add\(\s*"([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(new Set(producedNames), new Set([
    "execute-node", "wait-resume", "approval-deadline-arm", "approval-timeout", "replay-campaign-step",
  ]));
  for (const name of producedNames) assert.notEqual(classifyJob("workflow-nodes", name), "unknown");

  const namesSource = await readFile(new URL("../../packages/engine/src/queue-names.ts", import.meta.url), "utf8");
  for (const name of ["workflow-nodes", "maintenance-jobs"]) assert.match(namesSource, new RegExp(`"${name}"`));
});

test("catalog matches every recurring scheduler in the candidate source", async () => {
  const maintenanceFiles = [
    "identity-retention-scheduler.ts",
    "memory-retention-scheduler.ts",
    "audit-logs-retention-scheduler.ts",
    "scim-events-retention-scheduler.ts",
    "retention-scheduler.ts",
    "upstream-health-poller.ts",
    "confidence-calibration-scheduler.ts",
    "stalled-node-reaper.ts",
    "waiting-checkpoint-reconciler.ts",
    "queue-publication-reconciler.ts",
    "subworkflow-terminal-reconciler.ts",
    "workflow-rollout-reconciler.ts",
    "replay-campaign.ts",
  ];
  for (const file of maintenanceFiles) {
    const source = await readFile(new URL(`../../packages/engine/src/${file}`, import.meta.url), "utf8");
    const id = source.match(/export const [A-Z_]+_JOB_ID = "([^"]+)"/)?.[1];
    const name = source.match(/export const [A-Z_]+_JOB_NAME = "([^"]+)"/)?.[1];
    assert.ok(id && name, `${file} must expose one stable scheduler tuple`);
    assert.equal(classifyScheduler("maintenance-jobs", { key: id, name }).known, true, file);
    assert.equal(classifyScheduler("workflow-nodes", { key: id, name }).known, true, `${file} legacy lane`);
    assert.notEqual(classifyJob("maintenance-jobs", name), "unknown", file);
  }

  const apiSchedulers = [
    ["../../apps/api/src/alerts/scanner.ts", "alerts-system"],
    ["../../apps/api/src/auto-healing-scanner.ts", "auto-healing-system"],
    ["../../apps/api/src/auto-healing-watcher.ts", "auto-healing-system"],
  ];
  for (const [file, queue] of apiSchedulers) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    const id = source.match(/export const [A-Z_]+_JOB_ID = "([^"]+)"/)?.[1];
    const name = source.match(/export const [A-Z_]+_JOB_NAME = "([^"]+)"/)?.[1];
    assert.ok(id && name, `${file} must expose one stable scheduler tuple`);
    assert.equal(classifyScheduler(queue, { key: id, name }).known, true, file);
    assert.notEqual(classifyJob(queue, name), "unknown", file);
  }
});
