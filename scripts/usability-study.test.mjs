import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  USABILITY_TASKS,
  buildUsabilityReport,
  completeUsabilitySession,
  createUsabilitySession,
  readUsabilitySession,
  recordUsabilityTask,
  renderUsabilityReportMarkdown,
  runUsabilityStudyCli,
  validateParticipantId,
  writePrivateJson,
} from "./usability-study.mjs";

const BASE_TIME = new Date("2026-07-31T12:00:00.000Z");

function completeParticipant(participantId, overrides = {}) {
  let session = createUsabilitySession({ participantId, locale: "en", now: BASE_TIME });
  for (const [index, task] of USABILITY_TASKS.entries()) {
    const taskOverrides = overrides[task.id] ?? {};
    session = recordUsabilityTask(session, {
      taskId: task.id,
      firstClickCorrect: taskOverrides.firstClickCorrect ?? true,
      completed: taskOverrides.completed ?? true,
      durationSeconds: taskOverrides.durationSeconds ?? (task.id === "create_workflow" ? 180 : 45 + index),
      wrongDestinationChoices: taskOverrides.wrongDestinationChoices ?? 0,
      usedDocumentation: taskOverrides.usedDocumentation ?? false,
      usedCommandPalette: taskOverrides.usedCommandPalette ?? false,
      confidence: taskOverrides.confidence ?? 4,
    }, { now: new Date(BASE_TIME.getTime() + index * 1_000) });
  }
  return completeUsabilitySession(session, { now: new Date(BASE_TIME.getTime() + 10_000) });
}

test("creates pseudonymous sessions and rejects identifiers that resemble email addresses", () => {
  const session = createUsabilitySession({ participantId: "participant_01", locale: "es", now: BASE_TIME });
  assert.equal(session.status, "in_progress");
  assert.deepEqual(Object.keys(session.tasks), USABILITY_TASKS.map((task) => task.id));
  assert.throws(() => validateParticipantId("person@example.com"), /pseudonymous/);
  assert.throws(() => validateParticipantId("contains spaces"), /pseudonymous/);
});

test("prints CLI help without creating study evidence", async () => {
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = chunk => {
    writes.push(String(chunk));
    return true;
  };
  try {
    await runUsabilityStudyCli(["--", "--help"]);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.match(writes.join(""), /Tasks: create_workflow/);
});

test("records each task once and preserves an explicit correction", () => {
  let session = createUsabilitySession({ participantId: "participant-02", locale: "en", now: BASE_TIME });
  const input = {
    taskId: "find_failed_run",
    firstClickCorrect: false,
    completed: true,
    durationSeconds: 65,
    wrongDestinationChoices: 1,
    usedDocumentation: false,
    usedCommandPalette: false,
    confidence: 3,
  };
  session = recordUsabilityTask(session, input, { now: BASE_TIME });
  assert.throws(() => recordUsabilityTask(session, input), /already recorded/);
  const corrected = recordUsabilityTask(session, { ...input, firstClickCorrect: true }, {
    replace: true,
    now: new Date(BASE_TIME.getTime() + 1_000),
  });
  assert.equal(corrected.tasks.find_failed_run.firstClickCorrect, true);
  assert.equal(corrected.revisions.length, 1);
  assert.equal(corrected.revisions[0].previous.firstClickCorrect, false);
});

test("does not finalize a session until every task has an observation", () => {
  const session = createUsabilitySession({ participantId: "participant-03", locale: "en", now: BASE_TIME });
  assert.throws(() => completeUsabilitySession(session), /missing tasks/);
  assert.throws(
    () => buildUsabilityReport([{ ...session, status: "completed", completedAt: BASE_TIME.toISOString() }]),
    /completed session is missing task/,
  );
});

test("reports insufficient evidence below five completed participants", () => {
  const report = buildUsabilityReport([
    completeParticipant("p01"),
    completeParticipant("p02"),
    completeParticipant("p03"),
    completeParticipant("p04"),
  ], { generatedAt: BASE_TIME });
  assert.equal(report.status, "insufficient_participants");
  assert.equal(report.thresholds.enoughParticipants, false);
  assert.equal(report.metrics.workflowSaveMedianSeconds, 180);
});

test("passes only when all explicit usability thresholds have five human sessions", () => {
  const report = buildUsabilityReport([
    completeParticipant("p01"),
    completeParticipant("p02"),
    completeParticipant("p03", { find_failed_run: { firstClickCorrect: false } }),
    completeParticipant("p04"),
    completeParticipant("p05"),
  ], { generatedAt: BASE_TIME });
  assert.equal(report.status, "passed");
  assert.equal(report.metrics.firstClickSuccessRate, 0.96);
  assert.equal(report.metrics.firstClickSuccessByTask.find_failed_run, 0.8);
  assert.equal(report.metrics.unassistedCompletionRate, 1);
  assert.equal(report.metrics.maximumWrongDestinationChoices, 0);
  assert.match(renderUsabilityReportMarkdown(report), /Completed participants: \*\*5\/5\*\*/);
});

test("fails a completed study when an acceptance threshold is missed", () => {
  const report = buildUsabilityReport([
    completeParticipant("p01"),
    completeParticipant("p02"),
    completeParticipant("p03", {
      create_workflow: { durationSeconds: 420 },
      recover_run: { wrongDestinationChoices: 2, usedDocumentation: true },
    }),
    completeParticipant("p04", { create_workflow: { durationSeconds: 420 } }),
    completeParticipant("p05", { create_workflow: { durationSeconds: 420 } }),
  ], { generatedAt: BASE_TIME });
  assert.equal(report.status, "failed_thresholds");
  assert.equal(report.thresholds.workflowSaveUnderFiveMinutes, false);
  assert.equal(report.thresholds.noMoreThanOneWrongDestination, false);
});

test("rejects duplicate participant aliases across session files", () => {
  assert.throws(
    () => buildUsabilityReport([completeParticipant("duplicate"), completeParticipant("duplicate")]),
    /must be unique/,
  );
});

test("writes session evidence atomically with owner-only permissions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "janusly-usability-"));
  const file = path.join(directory, "session.json");
  const session = createUsabilitySession({ participantId: "private01", locale: "en", now: BASE_TIME });
  await writePrivateJson(file, session);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readUsabilitySession(file), session);
  assert.equal((await readFile(file, "utf8")).includes("@"), false);
});

test("refuses to initialize over an existing participant session", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "janusly-usability-"));
  const file = path.join(directory, "session.json");
  await runUsabilityStudyCli([
    "init", "--file", file, "--participant", "original", "--locale", "en",
  ]);
  await assert.rejects(
    runUsabilityStudyCli([
      "init", "--file", file, "--participant", "replacement", "--locale", "es",
    ]),
    error => error?.code === "EEXIST",
  );
  assert.equal((await readUsabilitySession(file)).participantId, "original");
});
