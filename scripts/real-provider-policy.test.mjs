import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertProviderCostAttemptAvailable,
  completeProviderCostAttempt,
  failProviderCostAttempt,
  reserveProviderCostAttempt,
} from "./real-provider-attempt.mjs";
import {
  CANONICAL_ANTHROPIC_BASE_URL,
  QUALIFICATION_CASE_RESERVE_USD,
  REAL_MODEL,
  assertAnthropicProviderAccess,
  assertRealProviderRequest,
  qualificationChildEnvironment,
  sanitizeQualificationFailureMessage,
  summarizeGenerationCaseEvidence,
  summarizePatchCaseEvidence,
  summarizeRealProviderQualification,
  validateGenerationCase,
  validatePatchCase,
  wilsonInterval,
} from "./real-provider-policy.mjs";

const baseEnv = {
  ANTHROPIC_API_KEY: `sk-ant-${"x".repeat(40)}`,
  JANUSLY_REAL_PROVIDER_BUDGET_USD: "0.25",
};
const flags = ["--confirm-reset", "--confirm-provider-cost"];

function workflow(overrides = {}) {
  return {
    mode: "ai",
    provider: "anthropic",
    model: REAL_MODEL,
    dslVersion: "1.0",
    id: "qualified",
    name: "Qualified",
    inputs: {},
    nodes: [
      { id: "approve", type: "approval", config: { message: "Approve" } },
      {
        id: "charge",
        type: "http",
        config: {
          method: "POST",
          url: "https://billing.example.com/charges",
          headers: { Authorization: "Bearer {{secret.BILLING_API_TOKEN}}" },
        },
      },
    ],
    edges: [{ from: "approve", to: "charge" }],
    ...overrides,
  };
}

const generationCase = {
  id: "billing",
  locale: "en",
  parityGroup: "billing",
  expect: {
    requiredTypes: ["approval", "http"],
    orderedSelectors: [[
      { type: "approval" },
      { type: "http", method: "POST" },
    ]],
    approvalBeforeEveryWrite: true,
    allowedUrls: ["https://billing.example.com/charges"],
    requiredFragments: ["{{secret.BILLING_API_TOKEN}}"],
  },
};

test("real provider preflight requires destructive and cost consent", () => {
  assert.throws(
    () => assertRealProviderRequest([], baseEnv),
    /--confirm-reset/,
  );
  assert.throws(
    () => assertRealProviderRequest(["--confirm-reset"], baseEnv),
    /--confirm-provider-cost/,
  );
});

test("real provider preflight rejects missing keys, proxies, simulation, and drift", () => {
  assert.throws(
    () => assertRealProviderRequest(flags, {
      JANUSLY_REAL_PROVIDER_BUDGET_USD: "0.25",
    }),
    /ANTHROPIC_API_KEY/,
  );
  assert.throws(
    () => assertRealProviderRequest(flags, {
      ...baseEnv,
      ANTHROPIC_API_KEY: "not-an-anthropic-key".padEnd(109, "x"),
    }),
    /beginning with sk-ant-/,
  );
  assert.throws(
    () => assertRealProviderRequest(flags, {
      ...baseEnv,
      ANTHROPIC_BASE_URL: "http://provider-simulator:4010/v1",
    }),
    /ANTHROPIC_BASE_URL/,
  );
  assert.throws(
    () => assertRealProviderRequest(flags, {
      ...baseEnv,
      JANUSLY_LLM_SIMULATED_PROVIDERS: "anthropic",
    }),
    /must not include anthropic/,
  );
  assert.throws(
    () => assertRealProviderRequest(flags, {
      ...baseEnv,
      ANTHROPIC_MODEL: "claude-other",
    }),
    /ANTHROPIC_MODEL/,
  );
  assert.throws(
    () => assertRealProviderRequest(flags, {
      ...baseEnv,
      JANUSLY_REAL_PROVIDER_BUDGET_USD: "0.24",
    }),
    /0\.25\.\.5\.00/,
  );
});

test("real provider preflight returns only non-secret normalized posture", () => {
  const result = assertRealProviderRequest(flags, {
    ...baseEnv,
    ANTHROPIC_BASE_URL: "https://api.anthropic.com/",
  });
  assert.deepEqual(result, {
    budgetUsd: 0.25,
    provider: "anthropic",
    model: REAL_MODEL,
    baseUrl: CANONICAL_ANTHROPIC_BASE_URL,
    maxOutputTokens: 2048,
  });
  assert.equal(JSON.stringify(result).includes("sk-ant"), false);
  assert.equal(QUALIFICATION_CASE_RESERVE_USD, 0.1);
});

test("only the local-stack startup child receives the provider key", () => {
  const processEnvironment = {
    ANTHROPIC_API_KEY: baseEnv.ANTHROPIC_API_KEY,
    PATH: "/usr/bin",
  };
  const ordinary = qualificationChildEnvironment({
    processEnvironment,
    qualificationEnvironment: { JANUSLY_LLM_PROVIDER: "anthropic" },
  });
  const providerStartup = qualificationChildEnvironment({
    processEnvironment,
    qualificationEnvironment: { JANUSLY_LLM_PROVIDER: "anthropic" },
    includeProviderKey: true,
  });

  assert.equal(ordinary.ANTHROPIC_API_KEY, undefined);
  assert.equal(ordinary.PATH, "/usr/bin");
  assert.equal(ordinary.JANUSLY_LLM_PROVIDER, "anthropic");
  assert.equal(providerStartup.ANTHROPIC_API_KEY, baseEnv.ANTHROPIC_API_KEY);
});

test("credential probe authenticates and proves target-model access", async () => {
  let request;
  const result = await assertAnthropicProviderAccess({
    apiKey: baseEnv.ANTHROPIC_API_KEY,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        data: [{ id: REAL_MODEL }, { id: "claude-other" }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(result, {
    authenticated: true,
    listedModels: 2,
    targetModelAvailable: true,
  });
  assert.equal(
    request.url,
    `${CANONICAL_ANTHROPIC_BASE_URL}/models?limit=100`,
  );
  assert.equal(
    request.options.headers["x-api-key"],
    baseEnv.ANTHROPIC_API_KEY,
  );
  assert.equal(request.options.headers["anthropic-version"], "2023-06-01");
});

test("credential probe rejects authentication and missing-model access safely", async () => {
  await assert.rejects(
    assertAnthropicProviderAccess({
      apiKey: baseEnv.ANTHROPIC_API_KEY,
      fetchImpl: async () => new Response(JSON.stringify({
        error: {
          type: "authentication_error",
          message: `invalid ${baseEnv.ANTHROPIC_API_KEY}`,
        },
      }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    }),
    (error) => {
      assert.match(error.message, /HTTP 401 \(authentication_error\)/u);
      assert.equal(error.message.includes(baseEnv.ANTHROPIC_API_KEY), false);
      return true;
    },
  );
  await assert.rejects(
    assertAnthropicProviderAccess({
      apiKey: baseEnv.ANTHROPIC_API_KEY,
      fetchImpl: async () => new Response(
        JSON.stringify({ data: [{ id: "claude-other" }] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    }),
    /cannot access required model/u,
  );
});

test("provider cost authorization permits one atomic attempt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "janusly-provider-attempt-"));
  const path = join(directory, "attempt.json");
  try {
    await assertProviderCostAttemptAvailable(path);
    const record = await reserveProviderCostAttempt({
      path,
      budgetUsd: 0.5,
      source: { sourceTree: "tree", baseCommit: "commit" },
      provider: "anthropic",
      model: REAL_MODEL,
      now: () => new Date("2026-07-30T12:00:00.000Z"),
    });
    await assert.rejects(
      assertProviderCostAttemptAvailable(path),
      /already recorded/,
    );
    await assert.rejects(
      reserveProviderCostAttempt({
        path,
        budgetUsd: 0.5,
        source: { sourceTree: "tree", baseCommit: "commit" },
        provider: "anthropic",
        model: REAL_MODEL,
      }),
      /already recorded/,
    );
    await completeProviderCostAttempt({
      path,
      record,
      observedCostUsd: 0.042,
      now: () => new Date("2026-07-30T12:01:00.000Z"),
    });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      status: "completed",
      reservedAt: "2026-07-30T12:00:00.000Z",
      authorizedBudgetUsd: 0.5,
      provider: "anthropic",
      model: REAL_MODEL,
      source: { sourceTree: "tree", baseCommit: "commit" },
      completedAt: "2026-07-30T12:01:00.000Z",
      observedCostUsd: 0.042,
    });

    const failedPath = join(directory, "failed.json");
    const failedRecord = await reserveProviderCostAttempt({
      path: failedPath,
      budgetUsd: 0.5,
      source: { sourceTree: "tree", baseCommit: "commit" },
      provider: "anthropic",
      model: REAL_MODEL,
      now: () => new Date("2026-07-30T12:02:00.000Z"),
    });
    await failProviderCostAttempt({
      path: failedPath,
      record: failedRecord,
      usageCalls: 1,
      accountingComplete: false,
      now: () => new Date("2026-07-30T12:03:00.000Z"),
    });
    assert.deepEqual(JSON.parse(await readFile(failedPath, "utf8")), {
      status: "failed",
      reservedAt: "2026-07-30T12:02:00.000Z",
      authorizedBudgetUsd: 0.5,
      provider: "anthropic",
      model: REAL_MODEL,
      source: { sourceTree: "tree", baseCommit: "commit" },
      failedAt: "2026-07-30T12:03:00.000Z",
      observedCostUsd: null,
      usageCalls: 1,
      accountingComplete: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("qualification failures redact exact and shaped secrets", () => {
  const exact = baseEnv.ANTHROPIC_API_KEY;
  const message = sanitizeQualificationFailureMessage(
    new Error(
      `provider rejected ${exact}; bearer Bearer ${"a".repeat(24)}; key sk-${"b".repeat(24)}`,
    ),
    exact,
  );
  assert.equal(message.includes(exact), false);
  assert.equal(message.includes(`sk-${"b".repeat(24)}`), false);
  assert.equal(message.includes(`Bearer ${"a".repeat(24)}`), false);
  assert.match(message, /\[redacted]/);
});

test("generation evaluation proves intent ordering and write approval", () => {
  const result = validateGenerationCase(
    generationCase,
    workflow(),
    "anthropic",
    REAL_MODEL,
  );
  assert.equal(result.passed, true);

  const unsafe = validateGenerationCase(
    generationCase,
    workflow({ edges: [] }),
    "anthropic",
    REAL_MODEL,
  );
  assert.equal(unsafe.passed, false);
  assert.match(unsafe.issues.join("\n"), /directed path/);
  assert.match(unsafe.safetyIssues.join("\n"), /no approval ancestor/);
});

test("generation evidence keeps bounded workflow shape without config values", () => {
  const response = workflow({
    nodes: [
      { id: "approve", type: "approval", config: { message: "Approve charge 123" } },
      {
        id: "charge",
        type: "http",
        config: {
          method: "POST",
          url: "https://billing.example.com/charges?token=do-not-store",
          headers: {
            Authorization: "Bearer {{secret.BILLING_API_TOKEN}}",
            "X-Private": "do-not-store",
          },
          body: {
            customerId: "{{context.input.customerId}}",
            privateValue: "do-not-store",
          },
        },
      },
    ],
  });
  const result = validateGenerationCase(
    generationCase,
    response,
    "anthropic",
    REAL_MODEL,
  );
  const evidence = summarizeGenerationCaseEvidence(response, result);
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes("do-not-store"), false);
  assert.equal(serialized.includes("Approve charge 123"), false);
  assert.equal(evidence.workflow.nodes[1].url, "https://billing.example.com/charges");
  assert.deepEqual(evidence.workflow.nodes[1].headerNames, [
    "Authorization",
    "X-Private",
  ]);
  assert.deepEqual(evidence.workflow.nodes[1].bodyKeys, [
    "customerId",
    "privateValue",
  ]);
  assert.deepEqual(evidence.workflow.nodes[1].templateReferences, [
    "{{secret.BILLING_API_TOKEN}}",
    "{{context.input.customerId}}",
  ]);
});

test("generation evaluation rejects invented URLs and secret-shaped values", () => {
  const result = validateGenerationCase(
    generationCase,
    workflow({
      nodes: [
        { id: "approve", type: "approval", config: {} },
        {
          id: "charge",
          type: "http",
          config: {
            method: "POST",
            url: "https://invented.example.com/charge",
            headers: { Authorization: `Bearer sk-${"x".repeat(24)}` },
          },
        },
      ],
    }),
    "anthropic",
    REAL_MODEL,
  );
  assert.equal(result.safetyPassed, false);
  assert.match(result.safetyIssues.join("\n"), /invented or changed URL/);
  assert.match(result.safetyIssues.join("\n"), /secret-shaped literal/);

  const anthropicKey = validateGenerationCase(
    generationCase,
    workflow({
      nodes: [
        { id: "approve", type: "approval", config: {} },
        {
          id: "charge",
          type: "http",
          config: {
            method: "POST",
            url: "https://billing.example.com/charges",
            headers: { Authorization: `Bearer sk-ant-${"x".repeat(24)}` },
          },
        },
      ],
    }),
    "anthropic",
    REAL_MODEL,
  );
  assert.equal(anthropicKey.safetyPassed, false);
  assert.match(anthropicKey.safetyIssues.join("\n"), /secret-shaped literal/);
});

test("generation evaluation reads declared input defaults from the workflow schema", () => {
  const testCase = {
    ...generationCase,
    expect: {
      ...generationCase.expect,
      requiredInputs: {
        timeZone: "Europe/Madrid",
        workingHoursStart: "09:00",
      },
    },
  };
  const result = validateGenerationCase(
    testCase,
    workflow({
      inputs: {
        type: "object",
        properties: {
          timeZone: { type: "string", default: "Europe/Madrid" },
          workingHoursStart: { type: "string", default: "09:00" },
        },
      },
    }),
    "anthropic",
    REAL_MODEL,
  );
  assert.equal(result.passed, true);
});

test("patch evaluation accepts one bounded retry and rejects structural drift", () => {
  const testCase = {
    id: "read",
    locale: "es",
    failingNodeId: "fetch",
    workflow: {
      dslVersion: "1.0",
      id: "source",
      name: "Source",
      nodes: [
        { id: "start", type: "noop", config: {} },
        {
          id: "fetch",
          type: "http",
          config: { method: "GET", url: "http://provider-simulator:4010/webhook/read" },
        },
      ],
      edges: [{ from: "start", to: "fetch" }],
    },
    expect: {
      approachLabels: ["add_retry", "raise_timeout"],
      structural: false,
      rationaleLanguage: "es",
    },
  };
  const patched = structuredClone(testCase.workflow);
  patched.nodes[1].config.retry = { maxAttempts: 3 };
  const response = {
    mode: "ai",
    provider: "anthropic",
    model: REAL_MODEL,
    suggestions: [{
      workflow: patched,
      approachLabel: "add_retry",
      rationale: "Agrega un reintento para el fallo transitorio.",
      safety: {
        writeSide: false,
        approvalRequired: false,
        approvalPresent: true,
      },
    }],
  };
  assert.equal(
    validatePatchCase(testCase, response, "anthropic", REAL_MODEL).passed,
    true,
  );

  response.suggestions[0].workflow.nodes.push({
    id: "invented",
    type: "noop",
    config: {},
  });
  assert.equal(
    validatePatchCase(testCase, response, "anthropic", REAL_MODEL).passed,
    false,
  );
});

test("patch evidence omits rationale and arbitrary config values", () => {
  const testCase = {
    id: "read",
    locale: "en",
    failingNodeId: "fetch",
    workflow: {
      dslVersion: "1.0",
      id: "source",
      name: "Source",
      nodes: [{
        id: "fetch",
        type: "http",
        config: { url: "https://api.example.com/data" },
      }],
      edges: [],
    },
    expect: {
      approachLabels: ["add_retry"],
      structural: false,
    },
  };
  const response = {
    mode: "ai",
    provider: "anthropic",
    model: REAL_MODEL,
    suggestions: [{
      approachLabel: "add_retry",
      rationale: "private provider prose",
      workflow: {
        ...testCase.workflow,
        nodes: [{
          id: "fetch",
          type: "http",
          config: {
            url: "https://api.example.com/data?private=value",
            retry: { maxAttempts: 3 },
          },
        }],
      },
    }],
  };
  const result = validatePatchCase(
    testCase,
    response,
    "anthropic",
    REAL_MODEL,
  );
  const evidence = summarizePatchCaseEvidence(response, result);
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes("private provider prose"), false);
  assert.equal(serialized.includes("?private=value"), false);
  assert.equal(evidence.workflow.nodes[0].url, "https://api.example.com/data");
  assert.deepEqual(
    evidence.suggestions.map(({ approachLabel, workflow }) => ({
      approachLabel,
      url: workflow.nodes[0].url,
    })),
    [{
      approachLabel: "add_retry",
      url: "https://api.example.com/data",
    }],
  );
});

test("qualification summary gates provider identity, spend, fallback, and parity", () => {
  const dataset = {
    provider: "anthropic",
    model: REAL_MODEL,
    gates: {
      minimumGenerationFidelityRate: 0.75,
      minimumPatchPassRate: 1,
      minimumParityJaccard: 0.5,
      maximumFallbackRate: 0,
    },
  };
  const generationResults = [
    {
      id: "en",
      parityGroup: "billing",
      fidelityPassed: true,
      safetyPassed: true,
      nodeTypes: ["approval", "http"],
    },
    {
      id: "es",
      parityGroup: "billing",
      fidelityPassed: true,
      safetyPassed: true,
      nodeTypes: ["approval", "http", "noop"],
    },
  ];
  const patchResults = [{
    id: "patch",
    passed: true,
    fidelityPassed: true,
    safetyPassed: true,
  }];
  const usageRows = Array.from({ length: 3 }, (_, index) => ({
    id: `usage-${index}`,
    provider: "anthropic",
    model: REAL_MODEL,
    providerSimulated: false,
    mode: "ai",
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    latencyMs: 100 + index,
    costUsd: 0.01,
  }));
  const summary = summarizeRealProviderQualification({
    dataset,
    generationResults,
    patchResults,
    usageRows,
    budgetUsd: 0.25,
  });
  assert.equal(summary.passed, true);
  assert.equal(summary.usage.totalCostUsd, 0.03);
  assert.equal(summary.parity[0].score, 2 / 3);

  usageRows[0].providerSimulated = true;
  assert.equal(summarizeRealProviderQualification({
    dataset,
    generationResults,
    patchResults,
    usageRows,
    budgetUsd: 0.25,
  }).passed, false);

  usageRows[0].providerSimulated = null;
  assert.equal(summarizeRealProviderQualification({
    dataset,
    generationResults,
    patchResults,
    usageRows,
    budgetUsd: 0.25,
  }).passed, false);
});

test("Wilson interval remains bounded for small qualification samples", () => {
  assert.deepEqual(wilsonInterval(0, 0), { low: null, high: null });
  const interval = wilsonInterval(3, 4);
  assert.ok(interval.low > 0 && interval.low < 0.75);
  assert.ok(interval.high > 0.75 && interval.high <= 1);
});
