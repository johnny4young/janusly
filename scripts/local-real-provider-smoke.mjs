/** Destructive, explicit-cost qualification against the canonical Anthropic API. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_ANTHROPIC_BASE_URL,
  QUALIFICATION_CASE_RESERVE_USD,
  QUALIFICATION_OUTPUT_TOKENS,
  REAL_MODEL,
  REAL_PROVIDER,
  assertAnthropicProviderAccess,
  assertRealProviderRequest,
  qualificationChildEnvironment,
  sanitizeQualificationFailureMessage,
  sha256,
  summarizeGenerationCaseEvidence,
  summarizePatchCaseEvidence,
  summarizeRealProviderQualification,
  validateGenerationCase,
  validatePatchCase,
} from "./real-provider-policy.mjs";
import {
  assertProviderCostAttemptAvailable,
  completeProviderCostAttempt,
  failProviderCostAttempt,
  reserveProviderCostAttempt,
} from "./real-provider-attempt.mjs";
import { getLocalStackSettings } from "./local-env.mjs";
import { runQualificationWithCleanup } from "./qualification-cleanup.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const datasetPath = fileURLToPath(
  new URL("../evals/provider-qualification.json", import.meta.url),
);
const evidenceDirectory = process.env.JANUSLY_EVIDENCE_DIR
  ?? fileURLToPath(
    new URL(
      "../output/review/2026-07-30-real-provider-qualification",
      import.meta.url,
    ),
  );
const safePosture = assertRealProviderRequest(
  process.argv.slice(2),
  process.env,
);
const qualificationEnvironment = {
  JANUSLY_LOCAL_ORG_ID: `provider-qualification-${Date.now().toString(36)}`,
  JANUSLY_LLM_PROVIDER: REAL_PROVIDER,
  ANTHROPIC_MODEL: REAL_MODEL,
  ANTHROPIC_BASE_URL: CANONICAL_ANTHROPIC_BASE_URL,
  JANUSLY_LLM_SIMULATED_PROVIDERS: "",
  JANUSLY_LLM_MAX_OUTPUT_UNITS: String(QUALIFICATION_OUTPUT_TOKENS),
  JANUSLY_LOCAL_INTEGRATION_SIMULATOR: "true",
};
const screenshots = [
  "real-provider-ai-studio-en.png",
  "real-provider-usage-es.png",
  "real-provider-usage-es-mobile.png",
];
const providerCostAttemptPath = join(
  evidenceDirectory,
  "provider-cost-attempt.json",
);
const caseAttemptsPath = join(evidenceDirectory, "qualification-case-attempts.json");
let activeProviderAttempt = null;
const caseAttemptEvidence = [];

await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
await chmod(evidenceDirectory, 0o700);
await assertProviderCostAttemptAvailable(providerCostAttemptPath);
await Promise.all(
  [
    "provider-qualification.json",
    "qualification-summary.md",
    "qualification-failure.json",
    "browser-generation-result.json",
    "qualification-case-attempts.json",
    ...screenshots,
  ].map((name) => rm(join(evidenceDirectory, name), { force: true })),
);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function run(command, argumentsList, extraEnvironment = {}, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, argumentsList, {
      cwd: root,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      env: qualificationChildEnvironment({
        processEnvironment: process.env,
        qualificationEnvironment,
        extraEnvironment,
        includeProviderKey: options.includeProviderKey === true,
      }),
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolvePromise({ stdout, stderr })
      : reject(new Error(
        `${command} ${argumentsList.join(" ")} exited ${code}${
          options.sensitive || !stderr ? "" : `: ${stderr.trim()}`
        }`,
      )));
  });
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function requestJson(url, options = {}) {
  const { timeoutMs = 90_000, ...requestOptions } = options;
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
      `${requestOptions.method ?? "GET"} ${new URL(url).pathname} returned ${response.status}: ${text}`,
    );
  }
  return body;
}

async function assertStagedSourceTree() {
  const status = await run(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {},
    { capture: true },
  );
  const unsafe = status.stdout
    .split("\n")
    .filter(Boolean)
    .filter((line) => line.startsWith("??") || line[1] !== " ");
  assert.deepEqual(
    unsafe,
    [],
    "stage every tracked qualification change before spending provider credits",
  );
  const [baseCommit, sourceTree] = await Promise.all([
    run("git", ["rev-parse", "HEAD"], {}, { capture: true }),
    run("git", ["write-tree"], {}, { capture: true }),
  ]);
  return {
    baseCommit: baseCommit.stdout.trim(),
    sourceTree: sourceTree.stdout.trim(),
  };
}

async function configureOrg(apiUrl, headers) {
  const values = [
    ["ai.provider", REAL_PROVIDER],
    ["ai.anthropic.model", REAL_MODEL],
    ["ai.generationMode", "free_json"],
    ["ai.generationCandidates", 1],
    ["ai.maxRetries", 0],
    ["ai.timeoutMs", 60_000],
    ["ai.maxOutputUnits", QUALIFICATION_OUTPUT_TOKENS],
    ["ai.budgetMonthlyUsd", safePosture.budgetUsd],
    ["ai.budgetWarnPercent", 80],
    ["ai.budgetExceededPolicy", "block"],
  ];
  for (const [key, value] of values) {
    await requestJson(`${apiUrl}/org/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({ key, value }),
    });
  }
}

async function readUsageRows(orgId, startedAt) {
  const query = `SELECT coalesce(json_agg(json_build_object(
    'id', id,
    'provider', metadata->>'provider',
    'model', metadata->>'model',
    'providerSimulated', CASE
      WHEN metadata ? 'providerSimulated'
        THEN (metadata->>'providerSimulated')::boolean
      ELSE NULL
    END,
    'mode', metadata->>'mode',
    'aiError', metadata->>'aiError',
    'inputTokens', nullif(metadata->>'inputTokens', '')::integer,
    'outputTokens', nullif(metadata->>'outputTokens', '')::integer,
    'totalTokens', quantity,
    'cachedInputTokens', nullif(metadata->>'cachedInputTokens', '')::integer,
    'cacheCreationInputTokens', nullif(metadata->>'cacheCreationInputTokens', '')::integer,
    'latencyMs', nullif(metadata->>'latencyMs', '')::double precision,
    'costUsd', nullif(metadata->>'costUsd', '')::double precision,
    'createdAt', created_at
  ) ORDER BY created_at, id), '[]'::json)::text
  FROM usage_events
  WHERE org_id = ${sqlLiteral(orgId)}
    AND metric = 'llm.completion'
    AND created_at >= ${sqlLiteral(startedAt)}::timestamptz;`;
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
  return JSON.parse(result.stdout.trim() || "[]");
}

async function waitForUsageRows(orgId, startedAt, minimum) {
  const deadline = Date.now() + 15_000;
  let rows = [];
  let previousCount = -1;
  let stableReads = 0;
  while (Date.now() < deadline) {
    rows = await readUsageRows(orgId, startedAt);
    if (rows.length >= minimum && rows.length === previousCount) {
      stableReads += 1;
      if (stableReads >= 2) return rows;
    } else {
      stableReads = 0;
    }
    previousCount = rows.length;
    await delay(500);
  }
  throw new Error(
    `usage recorder did not stabilize at ${minimum} rows (observed ${rows.length})`,
  );
}

async function assertBudgetHeadroom(orgId, startedAt) {
  const rows = await readUsageRows(orgId, startedAt);
  const spent = rows.reduce(
    (sum, row) => sum + (Number.isFinite(row.costUsd) ? row.costUsd : 0),
    0,
  );
  assert.ok(
    spent <= safePosture.budgetUsd - QUALIFICATION_CASE_RESERVE_USD,
    `less than $${QUALIFICATION_CASE_RESERVE_USD.toFixed(2)} remains from the authorized provider budget (spent $${spent.toFixed(6)})`,
  );
}

function assertCasePassed(result, label) {
  assert.deepEqual(
    {
      issues: result.issues,
      safetyIssues: result.safetyIssues,
    },
    {
      issues: [],
      safetyIssues: [],
    },
    `${label} failed qualification`,
  );
}

async function recordCaseAttempt(evidence) {
  caseAttemptEvidence.push({
    recordedAt: new Date().toISOString(),
    ...evidence,
  });
  await writeFile(
    caseAttemptsPath,
    `${JSON.stringify(caseAttemptEvidence, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function captureFailedProviderAttempt() {
  if (!activeProviderAttempt) return;
  let usageRows = null;
  try {
    await delay(1_000);
    usageRows = await readUsageRows(
      activeProviderAttempt.orgId,
      activeProviderAttempt.startedAt,
    );
  } catch {
    usageRows = null;
  }
  const knownCosts = usageRows !== null
    && usageRows.every((row) => Number.isFinite(row.costUsd));
  await failProviderCostAttempt({
    path: providerCostAttemptPath,
    record: activeProviderAttempt.record,
    observedCostUsd: knownCosts
      ? usageRows.reduce((sum, row) => sum + row.costUsd, 0)
      : null,
    usageCalls: usageRows?.length ?? null,
    accountingComplete: knownCosts,
  });
}

async function pollRun(apiUrl, headers, runId) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const snapshot = await requestJson(
      `${apiUrl}/run?runId=${encodeURIComponent(runId)}`,
      { headers },
    );
    if (["succeeded", "failed", "cancelled"].includes(snapshot.run.status)) {
      return snapshot;
    }
    await delay(250);
  }
  throw new Error(`run ${runId} did not reach a terminal state`);
}

async function createDeadLetter(apiUrl, simulatorUrl, headers, testCase) {
  await requestJson(`${simulatorUrl}/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: testCase.providerFailure,
      mode: "failure",
    }),
  });
  await requestJson(`${apiUrl}/workflows/save`, {
    method: "POST",
    headers,
    body: JSON.stringify(testCase.workflow),
  });
  const accepted = await requestJson(`${apiUrl}/start`, {
    method: "POST",
    headers,
    body: JSON.stringify(testCase.workflow),
  });
  const snapshot = await pollRun(apiUrl, headers, accepted.runId);
  assert.equal(snapshot.run.status, "failed", `${testCase.id} must fail`);
  const failedNode = snapshot.nodes.find(
    (node) => node.nodeId === testCase.failingNodeId,
  );
  assert.equal(
    failedNode?.status,
    "failed",
    `${testCase.id} failing node did not fail`,
  );
  const queue = await requestJson(
    `${apiUrl}/v1/dlq?status=open&search=${encodeURIComponent(accepted.runId)}&limit=10`,
    { headers },
  );
  const deadLetter = queue.data?.find(
    (entry) =>
      entry.runId === accepted.runId
      && entry.nodeId === testCase.failingNodeId,
  );
  assert.ok(deadLetter?.id, `${testCase.id} did not create a dead letter`);
  return { runId: accepted.runId, deadLetterId: deadLetter.id };
}

async function qualifyRealProvider() {
  const source = await assertStagedSourceTree();
  const datasetRaw = await readFile(datasetPath, "utf8");
  const dataset = JSON.parse(datasetRaw);
  assert.equal(dataset.provider, REAL_PROVIDER);
  assert.equal(dataset.model, REAL_MODEL);
  assert.equal(
    dataset.generationCases.filter(({ execution }) => execution === "browser").length,
    1,
    "exactly one generation case must exercise the browser",
  );
  const providerAccess = await assertAnthropicProviderAccess({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  await run(process.execPath, ["scripts/local-stack.mjs", "reset"]);
  await run(
    process.execPath,
    ["scripts/local-stack.mjs", "up"],
    {},
    { includeProviderKey: true },
  );
  const settings = await getLocalStackSettings();
  const orgId = qualificationEnvironment.JANUSLY_LOCAL_ORG_ID;
  const headers = {
    "content-type": "application/json",
    "x-org-id": orgId,
    "x-user-id": "local-real-provider",
  };
  const startedAt = new Date().toISOString();

  await configureOrg(settings.apiUrl, headers);
  const health = await requestJson(`${settings.apiUrl}/ai/health`, { headers });
  assert.deepEqual(
    {
      enabled: health.enabled,
      provider: health.provider,
      model: health.model,
    },
    {
      enabled: true,
      provider: REAL_PROVIDER,
      model: REAL_MODEL,
    },
    "AI health does not prove the canonical Anthropic posture",
  );

  const providerCostAttempt = await reserveProviderCostAttempt({
    path: providerCostAttemptPath,
    budgetUsd: safePosture.budgetUsd,
    source,
    provider: REAL_PROVIDER,
    model: REAL_MODEL,
  });
  activeProviderAttempt = {
    record: providerCostAttempt,
    orgId,
    startedAt,
  };

  const generationResults = [];
  for (const testCase of dataset.generationCases.filter(
    ({ execution }) => execution === "api",
  )) {
    await assertBudgetHeadroom(orgId, startedAt);
    const response = await requestJson(
      `${settings.apiUrl}/ai/generate-workflow`,
      {
        method: "POST",
        headers: {
          ...headers,
          "accept-language": testCase.locale,
        },
        body: JSON.stringify({
          prompt: testCase.prompt,
          model: `${REAL_PROVIDER}/${REAL_MODEL}`,
        }),
        timeoutMs: 180_000,
      },
    );
    const result = validateGenerationCase(
      testCase,
      response,
      REAL_PROVIDER,
      REAL_MODEL,
    );
    generationResults.push(result);
    await recordCaseAttempt(
      summarizeGenerationCaseEvidence(response, result),
    );
    assertCasePassed(result, testCase.id);
  }

  const patchResults = [];
  const patchEvidence = [];
  for (const testCase of dataset.patchCases) {
    const failure = await createDeadLetter(
      settings.apiUrl,
      settings.simulatorUrl,
      headers,
      testCase,
    );
    await assertBudgetHeadroom(orgId, startedAt);
    const response = await requestJson(
      `${settings.apiUrl}/ai/patch-workflow`,
      {
        method: "POST",
        headers: {
          ...headers,
          "accept-language": testCase.locale,
        },
        body: JSON.stringify({
          deadLetterId: failure.deadLetterId,
          model: `${REAL_PROVIDER}/${REAL_MODEL}`,
        }),
        timeoutMs: 180_000,
      },
    );
    const result = validatePatchCase(
      testCase,
      response,
      REAL_PROVIDER,
      REAL_MODEL,
    );
    patchResults.push(result);
    await recordCaseAttempt(summarizePatchCaseEvidence(response, result));
    assertCasePassed(result, testCase.id);
    patchEvidence.push({
      id: testCase.id,
      runId: failure.runId,
      deadLetterId: failure.deadLetterId,
    });
  }
  await requestJson(`${settings.simulatorUrl}/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "webhook", mode: "success" }),
  });

  await assertBudgetHeadroom(orgId, startedAt);
  await run(
    "pnpm",
    [
      "--filter",
      "@janusly/web",
      "exec",
      "playwright",
      "test",
      "e2e/local-real-provider.spec.ts",
      "--project=chromium",
      "--workers=1",
    ],
    {
      JANUSLY_REAL_PROVIDER_E2E: "1",
      JANUSLY_EVIDENCE_DIR: evidenceDirectory,
      JANUSLY_LOCAL_ORG_ID: orgId,
      E2E_API_URL: settings.apiUrl,
      PLAYWRIGHT_BASE_URL: settings.webUrl,
      PLAYWRIGHT_SKIP_WEB_SERVER: "1",
    },
  );
  const browserResult = JSON.parse(
    await readFile(
      join(evidenceDirectory, "browser-generation-result.json"),
      "utf8",
    ),
  );
  generationResults.push(browserResult);
  await recordCaseAttempt({
    kind: "browser-generation",
    ...browserResult,
  });
  await Promise.all(
    screenshots.map((name) => chmod(join(evidenceDirectory, name), 0o600)),
  );

  const expectedTopLevelCases =
    dataset.generationCases.length + dataset.patchCases.length;
  const usageRows = await waitForUsageRows(
    orgId,
    startedAt,
    expectedTopLevelCases,
  );
  const validation = summarizeRealProviderQualification({
    dataset,
    generationResults,
    patchResults,
    usageRows,
    budgetUsd: safePosture.budgetUsd,
  });
  assert.deepEqual(validation.issues, [], "real provider qualification failed");
  await completeProviderCostAttempt({
    path: providerCostAttemptPath,
    record: providerCostAttempt,
    observedCostUsd: validation.usage.totalCostUsd,
  });
  activeProviderAttempt = null;

  return {
    qualifiedAt: new Date().toISOString(),
    source,
    dataset: {
      path: "evals/provider-qualification.json",
      version: dataset.datasetVersion,
      sha256: sha256(datasetRaw),
    },
    environment: {
      runtime: process.version,
      provider: REAL_PROVIDER,
      model: REAL_MODEL,
      baseUrl: CANONICAL_ANTHROPIC_BASE_URL,
      providerSimulated: false,
      credentialProbe: providerAccess,
      generationMode: "free_json",
      generationCandidates: 1,
      maxRetries: 0,
      timeoutMs: 60_000,
      maxOutputTokens: QUALIFICATION_OUTPUT_TOKENS,
      organizationId: orgId,
    },
    validation,
    cases: {
      generation: generationResults,
      patch: patchResults,
      patchEvidence,
    },
    browser: {
      bilingual: true,
      accessibility: true,
      overflow: false,
      runtimeErrors: false,
      screenshots,
    },
    limitations: [
      "This is a bounded local qualification corpus, not a statistically broad model certification.",
      "Wilson intervals are reported because one sample per case leaves wide uncertainty.",
      "The Janusly budget gate and runner stop additional top-level cases after observed spend; only an Anthropic account spending limit is a hard invoice ceiling.",
      "External-provider availability and latency remain time-dependent and must be re-qualified after model, prompt, schema, SDK, or pricing changes.",
    ],
  };
}

async function assertTextEvidenceContainsNoApiKey() {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return;
  const textFiles = [
    "provider-cost-attempt.json",
    "provider-qualification.json",
    "qualification-summary.md",
    "qualification-failure.json",
    "browser-generation-result.json",
    "qualification-case-attempts.json",
  ];
  for (const name of textFiles) {
    const path = join(evidenceDirectory, name);
    let content;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (content.includes(apiKey)) {
      await rm(path, { force: true });
      throw new Error(`sensitive provider key detected in evidence file ${name}`);
    }
  }
}

let report;
try {
  report = await runQualificationWithCleanup(
    qualifyRealProvider,
    () => run(process.execPath, ["scripts/local-stack.mjs", "reset"]),
    "real Anthropic provider qualification",
    { beforeCleanup: captureFailedProviderAttempt },
  );
} catch (error) {
  const message = sanitizeQualificationFailureMessage(
    error,
    process.env.ANTHROPIC_API_KEY,
  );
  await writeFile(
    join(evidenceDirectory, "qualification-failure.json"),
    `${JSON.stringify({
      failedAt: new Date().toISOString(),
      message,
      cleanupAttempted: true,
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  throw new Error(message);
}

report.cleanup = {
  localPersistentDataRemoved: true,
  stackStopped: true,
};
await writeFile(
  join(evidenceDirectory, "provider-qualification.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  { mode: 0o600 },
);
await writeFile(
  join(evidenceDirectory, "qualification-summary.md"),
  `# Real Anthropic provider qualification

- The canonical Anthropic endpoint and pinned Haiku model are required; provider-compatible simulators and proxies are rejected before startup.
- Explicit destructive and provider-cost consent are mandatory, and the operator supplies the observed-spend ceiling.
- The corpus exercises prompt-to-workflow intent, English/Spanish parity, write-side approval ordering, time-window routing, human review, transient-failure diagnosis, and structural recovery.
- Every provider call must persist usage with the exact provider/model, \`providerSimulated=false\`, known tokens, latency, and cost.
- One browser generation runs through the real AI Studio; Usage then proves the recorded provider cost in Spanish and at a compact viewport.
- Generated tenant data is removed and the local stack is stopped after success or failure.

## Key Learnings:

1. Real-provider readiness requires provider identity and persisted usage proof, not only a successful HTTP response.
2. A small corpus should gate deterministic safety invariants and report uncertainty instead of claiming broad model quality.
3. Output-token bounds and explicit cost consent make local provider qualification predictable enough to repeat deliberately.
`,
  { mode: 0o600 },
);
await assertTextEvidenceContainsNoApiKey();
console.log(`[local] real provider evidence: ${evidenceDirectory}`);
