import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const USABILITY_STUDY_SCHEMA_VERSION = 1;
export const REQUIRED_PARTICIPANTS = 5;
export const USABILITY_TASKS = Object.freeze([
  { id: "create_workflow", label: "Create and save a two-step workflow" },
  { id: "find_failed_run", label: "Find a failed run" },
  { id: "recover_run", label: "Start recovery for a failed run" },
  { id: "add_connection", label: "Open the add-connection flow" },
  { id: "invite_teammate", label: "Open the teammate invitation flow" },
]);

const TASK_IDS = new Set(USABILITY_TASKS.map((task) => task.id));
const PARTICIPANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u;
const LOCALES = new Set(["en", "es"]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function assertPlainObject(value, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function parseBoolean(value, label) {
  invariant(value === "yes" || value === "no", `${label} must be yes or no`);
  return value === "yes";
}

function parseInteger(value, label, minimum, maximum) {
  invariant(typeof value === "string" && /^\d+$/u.test(value), `${label} must be an integer`);
  const parsed = Number.parseInt(value, 10);
  invariant(parsed >= minimum && parsed <= maximum, `${label} must be between ${minimum} and ${maximum}`);
  return parsed;
}

function assertIsoTimestamp(value, label) {
  invariant(typeof value === "string" && Number.isFinite(Date.parse(value)), `${label} must be an ISO timestamp`);
}

export function validateParticipantId(participantId) {
  invariant(
    typeof participantId === "string" && PARTICIPANT_ID_PATTERN.test(participantId),
    "participant id must be a pseudonymous 1-32 character identifier using letters, numbers, underscore, or dash",
  );
  return participantId;
}

export function createUsabilitySession({ participantId, locale, now = new Date() }) {
  validateParticipantId(participantId);
  invariant(LOCALES.has(locale), "locale must be en or es");
  const startedAt = now.toISOString();
  return {
    kind: "janusly_usability_session",
    schemaVersion: USABILITY_STUDY_SCHEMA_VERSION,
    participantId,
    locale,
    status: "in_progress",
    startedAt,
    completedAt: null,
    tasks: Object.fromEntries(USABILITY_TASKS.map((task) => [task.id, null])),
    revisions: [],
  };
}

export function validateUsabilitySession(value) {
  const session = assertPlainObject(value, "session");
  invariant(session.kind === "janusly_usability_session", "unsupported usability session kind");
  invariant(session.schemaVersion === USABILITY_STUDY_SCHEMA_VERSION, "unsupported usability session schema version");
  validateParticipantId(session.participantId);
  invariant(LOCALES.has(session.locale), "session locale must be en or es");
  invariant(session.status === "in_progress" || session.status === "completed", "invalid session status");
  assertIsoTimestamp(session.startedAt, "startedAt");
  if (session.status === "completed") {
    assertIsoTimestamp(session.completedAt, "completedAt");
  } else {
    invariant(session.completedAt === null, "in-progress sessions cannot have completedAt");
  }
  const tasks = assertPlainObject(session.tasks, "tasks");
  invariant(Object.keys(tasks).length === USABILITY_TASKS.length, "session must contain the closed usability task catalog");
  for (const task of USABILITY_TASKS) {
    invariant(Object.hasOwn(tasks, task.id), `session is missing task ${task.id}`);
    const result = tasks[task.id];
    if (result === null) {
      invariant(session.status === "in_progress", `completed session is missing task ${task.id}`);
      continue;
    }
    validateTaskResult(result, task.id);
  }
  invariant(Array.isArray(session.revisions), "session revisions must be an array");
  return session;
}

function validateTaskResult(value, expectedTaskId) {
  const result = assertPlainObject(value, `task ${expectedTaskId}`);
  invariant(result.taskId === expectedTaskId, `task result must target ${expectedTaskId}`);
  invariant(typeof result.firstClickCorrect === "boolean", "firstClickCorrect must be boolean");
  invariant(typeof result.completed === "boolean", "completed must be boolean");
  invariant(Number.isInteger(result.durationSeconds) && result.durationSeconds >= 1 && result.durationSeconds <= 7200, "durationSeconds must be between 1 and 7200");
  invariant(Number.isInteger(result.wrongDestinationChoices) && result.wrongDestinationChoices >= 0 && result.wrongDestinationChoices <= 20, "wrongDestinationChoices must be between 0 and 20");
  invariant(typeof result.usedDocumentation === "boolean", "usedDocumentation must be boolean");
  invariant(typeof result.usedCommandPalette === "boolean", "usedCommandPalette must be boolean");
  invariant(Number.isInteger(result.confidence) && result.confidence >= 1 && result.confidence <= 5, "confidence must be between 1 and 5");
  assertIsoTimestamp(result.recordedAt, "recordedAt");
  return result;
}

export function recordUsabilityTask(sessionValue, input, { replace = false, now = new Date() } = {}) {
  const session = structuredClone(validateUsabilitySession(sessionValue));
  invariant(session.status === "in_progress", "completed sessions are immutable");
  invariant(TASK_IDS.has(input.taskId), `unknown usability task ${input.taskId}`);
  const existing = session.tasks[input.taskId];
  invariant(existing === null || replace, `task ${input.taskId} is already recorded; use --replace yes to correct it explicitly`);
  const result = validateTaskResult({
    taskId: input.taskId,
    firstClickCorrect: input.firstClickCorrect,
    completed: input.completed,
    durationSeconds: input.durationSeconds,
    wrongDestinationChoices: input.wrongDestinationChoices,
    usedDocumentation: input.usedDocumentation,
    usedCommandPalette: input.usedCommandPalette,
    confidence: input.confidence,
    recordedAt: now.toISOString(),
  }, input.taskId);
  if (existing !== null) {
    session.revisions.push({
      taskId: input.taskId,
      replacedAt: now.toISOString(),
      previous: existing,
    });
  }
  session.tasks[input.taskId] = result;
  return session;
}

export function completeUsabilitySession(sessionValue, { now = new Date() } = {}) {
  const session = structuredClone(validateUsabilitySession(sessionValue));
  if (session.status === "completed") return session;
  const missing = USABILITY_TASKS.filter((task) => session.tasks[task.id] === null).map((task) => task.id);
  invariant(missing.length === 0, `cannot complete session; missing tasks: ${missing.join(", ")}`);
  session.status = "completed";
  session.completedAt = now.toISOString();
  return session;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function median(values) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[midpoint];
  return (ordered[midpoint - 1] + ordered[midpoint]) / 2;
}

function rounded(value, digits = 4) {
  return value === null ? null : Number(value.toFixed(digits));
}

export function buildUsabilityReport(sessionValues, { generatedAt = new Date() } = {}) {
  const sessions = sessionValues.map((session) => validateUsabilitySession(session));
  const participantIds = sessions.map((session) => session.participantId);
  invariant(new Set(participantIds).size === participantIds.length, "participant ids must be unique across session files");
  const completed = sessions.filter((session) => session.status === "completed");
  const attempts = completed.flatMap((session) => USABILITY_TASKS.map((task) => session.tasks[task.id]));
  const firstClickByTask = Object.fromEntries(USABILITY_TASKS.map((task) => {
    const results = completed.map((session) => session.tasks[task.id]);
    return [task.id, rounded(ratio(results.filter((result) => result.firstClickCorrect).length, results.length))];
  }));
  const workflowDurations = completed
    .map((session) => session.tasks.create_workflow)
    .filter((result) => result.completed)
    .map((result) => result.durationSeconds);
  const unassistedCompleted = attempts.filter((result) =>
    result.completed && !result.usedDocumentation && !result.usedCommandPalette);
  const confidenceValues = attempts.map((result) => result.confidence);
  const metrics = {
    firstClickSuccessRate: rounded(ratio(attempts.filter((result) => result.firstClickCorrect).length, attempts.length)),
    firstClickSuccessByTask: firstClickByTask,
    workflowSaveMedianSeconds: median(workflowDurations),
    maximumWrongDestinationChoices: attempts.length === 0
      ? null
      : Math.max(...attempts.map((result) => result.wrongDestinationChoices)),
    unassistedCompletionRate: rounded(ratio(unassistedCompleted.length, attempts.length)),
    completionRate: rounded(ratio(attempts.filter((result) => result.completed).length, attempts.length)),
    meanConfidence: rounded(ratio(confidenceValues.reduce((sum, value) => sum + value, 0), confidenceValues.length), 2),
  };
  const thresholds = {
    enoughParticipants: completed.length >= REQUIRED_PARTICIPANTS,
    workflowSaveUnderFiveMinutes: metrics.workflowSaveMedianSeconds !== null && metrics.workflowSaveMedianSeconds < 300,
    noMoreThanOneWrongDestination: metrics.maximumWrongDestinationChoices !== null && metrics.maximumWrongDestinationChoices <= 1,
    unassistedCompletionAtLeastEightyPercent: metrics.unassistedCompletionRate !== null && metrics.unassistedCompletionRate >= 0.8,
  };
  const thresholdValues = Object.values(thresholds);
  const status = !thresholds.enoughParticipants
    ? "insufficient_participants"
    : thresholdValues.every(Boolean)
      ? "passed"
      : "failed_thresholds";
  return {
    kind: "janusly_usability_report",
    schemaVersion: USABILITY_STUDY_SCHEMA_VERSION,
    generatedAt: generatedAt.toISOString(),
    status,
    participantCount: completed.length,
    requiredParticipantCount: REQUIRED_PARTICIPANTS,
    incompleteParticipantIds: sessions
      .filter((session) => session.status !== "completed")
      .map((session) => session.participantId)
      .sort(),
    metrics,
    thresholds,
    limitations: [
      "This report summarizes moderated human sessions; automated browser smoke is readiness evidence only.",
      "Participant identifiers must remain pseudonymous and the report contains no free-text observations.",
    ],
  };
}

function formatPercent(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

export function renderUsabilityReportMarkdown(report) {
  const statusLabel = report.status === "passed"
    ? "Passed"
    : report.status === "insufficient_participants"
      ? "Insufficient participants"
      : "Thresholds not met";
  const taskRows = USABILITY_TASKS.map((task) =>
    `| ${task.label} | ${formatPercent(report.metrics.firstClickSuccessByTask[task.id])} |`);
  return `# Moderated usability acceptance\n\n` +
    `- Status: **${statusLabel}**\n` +
    `- Completed participants: **${report.participantCount}/${report.requiredParticipantCount}**\n` +
    `- Generated: ${report.generatedAt}\n\n` +
    `## Acceptance metrics\n\n` +
    `| Metric | Result | Threshold | Pass |\n` +
    `| --- | ---: | ---: | :---: |\n` +
    `| First-click success | ${formatPercent(report.metrics.firstClickSuccessRate)} | Measured, no release threshold | — |\n` +
    `| Median time to saved two-step workflow | ${report.metrics.workflowSaveMedianSeconds ?? "n/a"}s | < 300s | ${report.thresholds.workflowSaveUnderFiveMinutes ? "Yes" : "No"} |\n` +
    `| Maximum wrong global destinations in one task | ${report.metrics.maximumWrongDestinationChoices ?? "n/a"} | ≤ 1 | ${report.thresholds.noMoreThanOneWrongDestination ? "Yes" : "No"} |\n` +
    `| Completion without docs or command palette | ${formatPercent(report.metrics.unassistedCompletionRate)} | ≥ 80% | ${report.thresholds.unassistedCompletionAtLeastEightyPercent ? "Yes" : "No"} |\n` +
    `| Overall completion | ${formatPercent(report.metrics.completionRate)} | Measured, no release threshold | — |\n` +
    `| Mean confidence | ${report.metrics.meanConfidence ?? "n/a"}/5 | Measured, no release threshold | — |\n\n` +
    `## First-click success by task\n\n` +
    `| Task | Success |\n| --- | ---: |\n${taskRows.join("\n")}\n\n` +
    `## Boundary\n\n` +
    `${report.limitations.map((limitation) => `- ${limitation}`).join("\n")}\n`;
}

export async function writePrivateJson(filePath, value, options) {
  await writePrivateFile(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

export async function writePrivateFile(filePath, content, { overwrite = true } = {}) {
  const resolved = path.resolve(filePath);
  await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const temporary = `${resolved}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    if (overwrite) {
      await rename(temporary, resolved);
    } else {
      await link(temporary, resolved);
      await unlink(temporary);
    }
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await chmod(resolved, 0o600);
}

export async function readUsabilitySession(filePath) {
  return validateUsabilitySession(JSON.parse(await readFile(filePath, "utf8")));
}

export async function readUsabilitySessions(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name))
    .sort();
  invariant(files.length > 0, `no usability session JSON files found in ${directory}`);
  return Promise.all(files.map(readUsabilitySession));
}

const CLI_OPTIONS = {
  file: { type: "string" },
  participant: { type: "string" },
  locale: { type: "string" },
  task: { type: "string" },
  "first-click": { type: "string" },
  completed: { type: "string" },
  "duration-seconds": { type: "string" },
  "wrong-destinations": { type: "string" },
  "used-docs": { type: "string" },
  "used-command-palette": { type: "string" },
  confidence: { type: "string" },
  replace: { type: "string" },
  sessions: { type: "string" },
  json: { type: "string" },
  markdown: { type: "string" },
};

function requireOption(values, name) {
  const value = values[name];
  invariant(typeof value === "string" && value.length > 0, `--${name} is required`);
  return value;
}

function usage() {
  return `Usage:\n` +
    `  pnpm usability:study -- init --file <session.json> --participant <alias> --locale <en|es>\n` +
    `  pnpm usability:study -- record --file <session.json> --task <task> --first-click <yes|no> --completed <yes|no> --duration-seconds <n> --wrong-destinations <n> --used-docs <yes|no> --used-command-palette <yes|no> --confidence <1-5> [--replace yes]\n` +
    `  pnpm usability:study -- finish --file <session.json>\n` +
    `  pnpm usability:study -- report --sessions <directory> --json <report.json> --markdown <report.md>\n\n` +
    `Tasks: ${USABILITY_TASKS.map((task) => task.id).join(", ")}\n`;
}

export async function runUsabilityStudyCli(argv = process.argv.slice(2)) {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const [command, ...args] = normalizedArgv;
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return;
  }
  invariant(command === "init" || command === "record" || command === "finish" || command === "report", usage());
  const { values, positionals } = parseArgs({ args, options: CLI_OPTIONS, allowPositionals: true, strict: true });
  invariant(positionals.length === 0, `unexpected arguments: ${positionals.join(" ")}`);

  if (command === "init") {
    const file = requireOption(values, "file");
    const session = createUsabilitySession({
      participantId: requireOption(values, "participant"),
      locale: requireOption(values, "locale"),
    });
    await writePrivateJson(file, session, { overwrite: false });
    process.stdout.write(`${JSON.stringify({ ok: true, command, file: path.resolve(file), participantId: session.participantId })}\n`);
    return;
  }

  if (command === "record") {
    const file = requireOption(values, "file");
    const taskId = requireOption(values, "task");
    const session = await readUsabilitySession(file);
    const updated = recordUsabilityTask(session, {
      taskId,
      firstClickCorrect: parseBoolean(requireOption(values, "first-click"), "--first-click"),
      completed: parseBoolean(requireOption(values, "completed"), "--completed"),
      durationSeconds: parseInteger(requireOption(values, "duration-seconds"), "--duration-seconds", 1, 7200),
      wrongDestinationChoices: parseInteger(requireOption(values, "wrong-destinations"), "--wrong-destinations", 0, 20),
      usedDocumentation: parseBoolean(requireOption(values, "used-docs"), "--used-docs"),
      usedCommandPalette: parseBoolean(requireOption(values, "used-command-palette"), "--used-command-palette"),
      confidence: parseInteger(requireOption(values, "confidence"), "--confidence", 1, 5),
    }, {
      replace: values.replace === undefined ? false : parseBoolean(values.replace, "--replace"),
    });
    await writePrivateJson(file, updated);
    process.stdout.write(`${JSON.stringify({ ok: true, command, file: path.resolve(file), taskId })}\n`);
    return;
  }

  if (command === "finish") {
    const file = requireOption(values, "file");
    const completed = completeUsabilitySession(await readUsabilitySession(file));
    await writePrivateJson(file, completed);
    process.stdout.write(`${JSON.stringify({ ok: true, command, file: path.resolve(file), participantId: completed.participantId })}\n`);
    return;
  }

  const sessions = await readUsabilitySessions(requireOption(values, "sessions"));
  const report = buildUsabilityReport(sessions);
  const jsonPath = requireOption(values, "json");
  const markdownPath = requireOption(values, "markdown");
  await Promise.all([
    writePrivateJson(jsonPath, report),
    writePrivateFile(markdownPath, renderUsabilityReportMarkdown(report)),
  ]);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command,
    status: report.status,
    participants: report.participantCount,
    json: path.resolve(jsonPath),
    markdown: path.resolve(markdownPath),
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runUsabilityStudyCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
