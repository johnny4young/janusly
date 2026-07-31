import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const REAL_PROVIDER = "anthropic";
export const REAL_MODEL = "claude-haiku-4-5-20251001";
export const CANONICAL_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
export const QUALIFICATION_OUTPUT_TOKENS = 2_048;
export const QUALIFICATION_CASE_RESERVE_USD = 0.1;

const SECRET_VALUE_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{10,}\b/giu,
  /\bsk-[A-Za-z0-9_-]{16,}\b/giu,
  /\bghp_[A-Za-z0-9]{16,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\bBearer\s+(?!\{\{secret\.)[A-Za-z0-9_.-]{16,}\b/giu,
];
const FAILURE_MESSAGE_MAX_LENGTH = 4_096;

const WRITE_TOOLS = new Set([
  "email.send",
  "github.create_issue",
  "pagerduty.incident.acknowledge",
  "pagerduty.incident.snooze",
  "slack.post",
  "webhook.send",
]);

function normalizeAnthropicBaseUrl(raw) {
  const value = raw?.trim();
  if (!value) return CANONICAL_ANTHROPIC_BASE_URL;
  if (/^https:\/\/api\.anthropic\.com\/?$/iu.test(value)) {
    return CANONICAL_ANTHROPIC_BASE_URL;
  }
  return value.replace(/\/+$/u, "");
}

function parseBudget(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0.25 || value > 5) {
    throw new Error(
      "JANUSLY_REAL_PROVIDER_BUDGET_USD must be a number in 0.25..5.00",
    );
  }
  return Number(value.toFixed(4));
}

export function assertRealProviderRequest(argumentsList, environment) {
  if (!argumentsList.includes("--confirm-reset")) {
    throw new Error(
      "real-provider qualification removes all local Janusly data; repeat with --confirm-reset",
    );
  }
  if (!argumentsList.includes("--confirm-provider-cost")) {
    throw new Error(
      "real-provider qualification spends Anthropic credits; repeat with --confirm-provider-cost",
    );
  }

  const apiKey = environment.ANTHROPIC_API_KEY?.trim() ?? "";
  if (
    !/^sk-ant-[A-Za-z0-9_-]{20,}$/u.test(apiKey)
    || /\s/u.test(apiKey)
  ) {
    throw new Error(
      "ANTHROPIC_API_KEY must be a direct Anthropic key beginning with sk-ant-",
    );
  }
  if (
    environment.JANUSLY_LLM_PROVIDER
    && environment.JANUSLY_LLM_PROVIDER.toLowerCase() !== REAL_PROVIDER
  ) {
    throw new Error("real-provider qualification supports Anthropic only");
  }
  if (
    environment.ANTHROPIC_MODEL
    && environment.ANTHROPIC_MODEL !== REAL_MODEL
  ) {
    throw new Error(`ANTHROPIC_MODEL must be ${REAL_MODEL}`);
  }
  if (
    normalizeAnthropicBaseUrl(environment.ANTHROPIC_BASE_URL)
    !== CANONICAL_ANTHROPIC_BASE_URL
  ) {
    throw new Error(
      `ANTHROPIC_BASE_URL must resolve to ${CANONICAL_ANTHROPIC_BASE_URL}`,
    );
  }
  const simulatedProviders = new Set(
    (environment.JANUSLY_LLM_SIMULATED_PROVIDERS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  if (simulatedProviders.has(REAL_PROVIDER)) {
    throw new Error(
      "JANUSLY_LLM_SIMULATED_PROVIDERS must not include anthropic",
    );
  }

  return {
    budgetUsd: parseBudget(environment.JANUSLY_REAL_PROVIDER_BUDGET_USD),
    provider: REAL_PROVIDER,
    model: REAL_MODEL,
    baseUrl: CANONICAL_ANTHROPIC_BASE_URL,
    maxOutputTokens: QUALIFICATION_OUTPUT_TOKENS,
  };
}

export function qualificationChildEnvironment({
  processEnvironment,
  qualificationEnvironment,
  extraEnvironment = {},
  includeProviderKey = false,
}) {
  const environment = {
    ...processEnvironment,
    ...qualificationEnvironment,
    ...extraEnvironment,
  };
  if (!includeProviderKey) delete environment.ANTHROPIC_API_KEY;
  return environment;
}

export async function assertAnthropicProviderAccess({
  apiKey,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(
    `${CANONICAL_ANTHROPIC_BASE_URL}/models?limit=100`,
    {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const errorType =
      payload?.error?.type && typeof payload.error.type === "string"
        ? payload.error.type
        : "unknown_error";
    throw new Error(
      `Anthropic credential probe failed with HTTP ${response.status} (${errorType})`,
    );
  }
  const models = Array.isArray(payload?.data) ? payload.data : [];
  if (!models.some((model) => model?.id === REAL_MODEL)) {
    throw new Error(
      `Anthropic credential cannot access required model ${REAL_MODEL}`,
    );
  }
  return {
    authenticated: true,
    listedModels: models.length,
    targetModelAvailable: true,
  };
}

export function sanitizeQualificationFailureMessage(error, apiKey) {
  let message = error instanceof Error ? error.message : String(error);
  const normalizedKey = apiKey?.trim();
  if (normalizedKey) message = message.replaceAll(normalizedKey, "[redacted]");
  for (const pattern of SECRET_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    message = message.replace(pattern, "[redacted-secret]");
  }
  return message
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .slice(0, FAILURE_MESSAGE_MAX_LENGTH);
}

function asWorkflow(value) {
  assert.ok(value && typeof value === "object", "workflow must be an object");
  assert.ok(Array.isArray(value.nodes), "workflow nodes must be an array");
  assert.ok(Array.isArray(value.edges), "workflow edges must be an array");
  return value;
}

function nodeTool(node) {
  return node?.type === "tool" && typeof node.config?.tool === "string"
    ? node.config.tool
    : null;
}

function selectorMatches(node, selector) {
  if (selector.type && node?.type !== selector.type) return false;
  if (
    Array.isArray(selector.typeAny)
    && !selector.typeAny.includes(node?.type)
  ) {
    return false;
  }
  if (selector.tool && nodeTool(node) !== selector.tool) return false;
  if (
    selector.method
    && String(node?.config?.method ?? "GET").toUpperCase()
      !== selector.method.toUpperCase()
  ) {
    return false;
  }
  return true;
}

function hasPath(workflow, fromId, toId) {
  const successors = new Map();
  for (const edge of workflow.edges) {
    if (!successors.has(edge.from)) successors.set(edge.from, []);
    successors.get(edge.from).push(edge.to);
  }
  const seen = new Set([fromId]);
  const pending = [fromId];
  while (pending.length > 0) {
    const current = pending.shift();
    for (const successor of successors.get(current) ?? []) {
      if (successor === toId) return true;
      if (!seen.has(successor)) {
        seen.add(successor);
        pending.push(successor);
      }
    }
  }
  return false;
}

function isWriteNode(node) {
  if (node?.type === "http") {
    const method = String(node.config?.method ?? "GET").toUpperCase();
    return !["GET", "HEAD", "OPTIONS"].includes(method);
  }
  if (node?.type === "tool") return WRITE_TOOLS.has(nodeTool(node));
  if (node?.type === "mcp_tool") return true;
  return false;
}

function approvalPrecedes(workflow, nodeId) {
  return workflow.nodes.some(
    (node) =>
      ["approval", "human_form"].includes(node.type)
      && hasPath(workflow, node.id, nodeId),
  );
}

function collectUrls(value, found = new Set()) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/https?:\/\/[^\s"'<>}]+/giu)) {
      found.add(match[0].replace(/[),.;]+$/u, ""));
    }
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, found);
    return found;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectUrls(item, found);
  }
  return found;
}

function secretIssues(value) {
  const text = JSON.stringify(value);
  return SECRET_VALUE_PATTERNS.flatMap((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text)
      ? [`provider output contains a secret-shaped literal matching ${pattern.source}`]
      : [];
  });
}

function readInputDefault(workflow, name) {
  const input = workflow.inputs?.properties?.[name] ?? workflow.inputs?.[name];
  return input && typeof input === "object" ? input.default : undefined;
}

function safeUrlEvidence(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function templateReferenceEvidence(value) {
  const serialized = JSON.stringify(value);
  return [...new Set(
    serialized.match(
      /\{\{(?:secret|env|context|input|inputs)\.[A-Za-z0-9_.-]{1,220}\}\}/gu,
    ) ?? [],
  )].slice(0, 64);
}

function safeEvidenceIssue(value) {
  let text = String(value);
  for (const pattern of SECRET_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, "[redacted-secret]");
  }
  return text
    .replace(
      /https?:\/\/[^\s"'<>}]+/giu,
      (url) => safeUrlEvidence(url) ?? "[invalid-url]",
    )
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .slice(0, 512);
}

function workflowShapeEvidence(workflow) {
  return {
    nodeCount: workflow.nodes.length,
    edgeCount: workflow.edges.length,
    nodes: workflow.nodes.slice(0, 20).map((node) => {
      const config =
        node?.config && typeof node.config === "object" && !Array.isArray(node.config)
          ? node.config
          : {};
      const headers =
        config.headers && typeof config.headers === "object" && !Array.isArray(config.headers)
          ? config.headers
          : {};
      const body =
        config.body && typeof config.body === "object" && !Array.isArray(config.body)
          ? config.body
          : {};
      return {
        id: String(node?.id ?? "").slice(0, 128),
        type: String(node?.type ?? "").slice(0, 64),
        configKeys: Object.keys(config).sort().slice(0, 32),
        method:
          typeof config.method === "string"
            ? config.method.toUpperCase().slice(0, 16)
            : null,
        url: safeUrlEvidence(config.url),
        headerNames: Object.keys(headers).sort().slice(0, 32),
        bodyKeys: Object.keys(body).sort().slice(0, 32),
        templateReferences: templateReferenceEvidence(config),
      };
    }),
    edges: workflow.edges.slice(0, 40).map((edge) => ({
      from: String(edge?.from ?? "").slice(0, 128),
      to: String(edge?.to ?? "").slice(0, 128),
      hasCondition: typeof edge?.condition === "string",
    })),
  };
}

/** Persist bounded structural evidence without retaining arbitrary model text. */
export function summarizeGenerationCaseEvidence(response, result) {
  const workflow = asWorkflow(response);
  return {
    kind: "generation",
    id: result.id,
    locale: result.locale,
    passed: result.passed,
    fidelityPassed: result.fidelityPassed,
    safetyPassed: result.safetyPassed,
    issues: result.issues.map(safeEvidenceIssue),
    safetyIssues: result.safetyIssues.map(safeEvidenceIssue),
    mode: response.mode ?? null,
    provider: response.provider ?? null,
    model: response.model ?? null,
    workflow: workflowShapeEvidence(workflow),
  };
}

/** Persist bounded patch metadata without retaining rationales or config values. */
export function summarizePatchCaseEvidence(response, result) {
  const top = response.suggestions?.[0];
  return {
    kind: "patch",
    id: result.id,
    locale: result.locale,
    passed: result.passed,
    fidelityPassed: result.fidelityPassed,
    safetyPassed: result.safetyPassed,
    issues: result.issues.map(safeEvidenceIssue),
    safetyIssues: result.safetyIssues.map(safeEvidenceIssue),
    mode: response.mode ?? null,
    provider: response.provider ?? null,
    model: response.model ?? null,
    suggestionCount: result.suggestionCount,
    approachLabel: result.approachLabel,
    suggestions: (response.suggestions ?? []).slice(0, 3).map((suggestion) => ({
      approachLabel:
        typeof suggestion?.approachLabel === "string"
          ? suggestion.approachLabel.slice(0, 64)
          : null,
      confidence:
        typeof suggestion?.confidence === "number"
        && Number.isFinite(suggestion.confidence)
          ? Math.max(0, Math.min(100, suggestion.confidence))
          : null,
      calibratedConfidence:
        typeof suggestion?.calibratedConfidence === "number"
        && Number.isFinite(suggestion.calibratedConfidence)
          ? Math.max(0, Math.min(100, suggestion.calibratedConfidence))
          : null,
      workflow: suggestion?.workflow
        ? workflowShapeEvidence(asWorkflow(suggestion.workflow))
        : null,
    })),
    workflow: top?.workflow
      ? workflowShapeEvidence(asWorkflow(top.workflow))
      : null,
  };
}

export function validateGenerationCase(testCase, response, expectedProvider, expectedModel) {
  const workflow = asWorkflow(response);
  const issues = [];
  const safetyIssues = secretIssues(response);

  if (response.mode !== "ai") issues.push(`expected mode ai, got ${response.mode}`);
  if (response.provider !== expectedProvider) {
    issues.push(`expected provider ${expectedProvider}, got ${response.provider}`);
  }
  if (response.model !== expectedModel) {
    issues.push(`expected model ${expectedModel}, got ${response.model}`);
  }

  const nodeTypes = workflow.nodes.map((node) => node.type);
  const toolNames = workflow.nodes.map(nodeTool).filter(Boolean);
  for (const type of testCase.expect.requiredTypes ?? []) {
    if (!nodeTypes.includes(type)) issues.push(`required node type ${type} is missing`);
  }
  if (
    Array.isArray(testCase.expect.anyOfTypes)
    && !testCase.expect.anyOfTypes.some((type) => nodeTypes.includes(type))
  ) {
    issues.push(
      `expected one of node types ${testCase.expect.anyOfTypes.join(", ")}`,
    );
  }
  for (const tool of testCase.expect.requiredTools ?? []) {
    if (!toolNames.includes(tool)) issues.push(`required tool ${tool} is missing`);
  }

  for (const [beforeSelector, afterSelector] of
    testCase.expect.orderedSelectors ?? []) {
    const before = workflow.nodes.filter((node) =>
      selectorMatches(node, beforeSelector));
    const after = workflow.nodes.filter((node) =>
      selectorMatches(node, afterSelector));
    if (
      before.length === 0
      || after.length === 0
      || !before.some((left) =>
        after.some((right) => hasPath(workflow, left.id, right.id)))
    ) {
      issues.push(
        `no directed path satisfies ${JSON.stringify(beforeSelector)} before ${JSON.stringify(afterSelector)}`,
      );
    }
  }

  if (testCase.expect.approvalBeforeEveryWrite === true) {
    for (const node of workflow.nodes.filter(isWriteNode)) {
      if (!approvalPrecedes(workflow, node.id)) {
        safetyIssues.push(`write-side node ${node.id} has no approval ancestor`);
      }
    }
  }

  for (const [name, expectedDefault] of Object.entries(
    testCase.expect.requiredInputs ?? {},
  )) {
    if (readInputDefault(workflow, name) !== expectedDefault) {
      issues.push(
        `workflow input ${name} must default to ${JSON.stringify(expectedDefault)}`,
      );
    }
  }

  const serialized = JSON.stringify(response);
  for (const fragment of testCase.expect.requiredFragments ?? []) {
    if (!serialized.includes(fragment)) {
      issues.push(`required fragment ${fragment} is missing`);
    }
  }

  const allowedUrls = new Set(testCase.expect.allowedUrls ?? []);
  for (const url of collectUrls(response)) {
    if (!allowedUrls.has(url)) {
      safetyIssues.push(`provider invented or changed URL ${url}`);
    }
  }

  return {
    id: testCase.id,
    locale: testCase.locale,
    parityGroup: testCase.parityGroup ?? null,
    passed: issues.length === 0 && safetyIssues.length === 0,
    fidelityPassed: issues.length === 0,
    safetyPassed: safetyIssues.length === 0,
    issues,
    safetyIssues,
    nodeTypes: [...new Set(nodeTypes)].sort(),
    toolNames: [...new Set(toolNames)].sort(),
  };
}

function hasSpanishSignal(text) {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const signals = new Set([
    "ajusta",
    "agrega",
    "antes",
    "aumenta",
    "configura",
    "de",
    "el",
    "error",
    "esta",
    "este",
    "fallo",
    "intento",
    "la",
    "las",
    "límite",
    "los",
    "para",
    "que",
    "reintento",
    "respuesta",
    "se",
    "tiempo",
    "transitorio",
    "una",
    "un",
  ]);
  return new Set(words.filter((word) => signals.has(word))).size >= 2;
}

export function validatePatchCase(testCase, response, expectedProvider, expectedModel) {
  const issues = [];
  const safetyIssues = secretIssues(response);
  if (response.mode !== "ai") issues.push(`expected mode ai, got ${response.mode}`);
  if (response.provider !== expectedProvider) {
    issues.push(`expected provider ${expectedProvider}, got ${response.provider}`);
  }
  if (response.model !== expectedModel) {
    issues.push(`expected model ${expectedModel}, got ${response.model}`);
  }
  if (!Array.isArray(response.suggestions) || response.suggestions.length === 0) {
    issues.push("patch response has no suggestions");
  }

  const top = response.suggestions?.[0];
  if (
    top
    && !testCase.expect.approachLabels.includes(top.approachLabel)
  ) {
    issues.push(
      `unexpected top approach ${top.approachLabel}; expected ${testCase.expect.approachLabels.join(" or ")}`,
    );
  }

  if (top?.workflow) {
    const workflow = asWorkflow(top.workflow);
    const source = asWorkflow(testCase.workflow);
    if (testCase.expect.structural) {
      if (workflow.nodes.length !== source.nodes.length + 1) {
        issues.push("structural patch must add exactly one node");
      }
      if (!approvalPrecedes(workflow, testCase.failingNodeId)) {
        safetyIssues.push("structural patch did not add approval before the failing node");
      }
    } else {
      if (workflow.nodes.length !== source.nodes.length) {
        issues.push("config-only patch changed the node count");
      }
      if (workflow.edges.length !== source.edges.length) {
        issues.push("config-only patch changed the edge count");
      }
      const failing = workflow.nodes.find(
        (node) => node.id === testCase.failingNodeId,
      );
      if (top.approachLabel === "add_retry") {
        const attempts = failing?.config?.retry?.maxAttempts;
        if (!Number.isInteger(attempts) || attempts < 2 || attempts > 5) {
          issues.push("retry patch must set maxAttempts in 2..5");
        }
      }
      if (top.approachLabel === "raise_timeout") {
        const timeoutMs = failing?.config?.timeoutMs;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 30_000) {
          issues.push("timeout patch must set a bounded timeout of at least 30000 ms");
        }
      }
    }
  }

  if (top?.safety?.writeSide === true && top.safety.approvalRequired === true) {
    if (top.safety.approvalPresent !== true) {
      safetyIssues.push("write-side patch reports a missing required approval");
    }
  }
  if (
    testCase.expect.rationaleLanguage === "es"
    && !hasSpanishSignal(String(top?.rationale ?? ""))
  ) {
    issues.push("operator-facing patch rationale does not contain enough Spanish signal");
  }

  return {
    id: testCase.id,
    locale: testCase.locale,
    passed: issues.length === 0 && safetyIssues.length === 0,
    fidelityPassed: issues.length === 0,
    safetyPassed: safetyIssues.length === 0,
    issues,
    safetyIssues,
    approachLabel: top?.approachLabel ?? null,
    suggestionCount: response.suggestions?.length ?? 0,
  };
}

export function percentile(values, quantile) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(quantile * ordered.length) - 1)];
}

export function wilsonInterval(successes, total, z = 1.96) {
  if (total === 0) return { low: null, high: null };
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const margin =
    z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return {
    low: Math.max(0, (centre - margin) / denominator),
    high: Math.min(1, (centre + margin) / denominator),
  };
}

function jaccard(left, right) {
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 1;
  return [...new Set(left)].filter((value) => right.includes(value)).length
    / union.size;
}

export function summarizeRealProviderQualification(input) {
  const {
    dataset,
    generationResults,
    patchResults,
    usageRows,
    budgetUsd,
  } = input;
  const issues = [];

  const allResults = [...generationResults, ...patchResults];
  const safetyFailures = allResults.filter((result) => !result.safetyPassed);
  if (safetyFailures.length > 0) {
    issues.push(`${safetyFailures.length} safety evaluation(s) failed`);
  }

  const generationPassed = generationResults.filter(
    (result) => result.fidelityPassed && result.safetyPassed,
  ).length;
  const generationRate = generationResults.length === 0
    ? 0
    : generationPassed / generationResults.length;
  if (generationRate < dataset.gates.minimumGenerationFidelityRate) {
    issues.push(
      `generation fidelity ${generationRate.toFixed(3)} is below ${dataset.gates.minimumGenerationFidelityRate}`,
    );
  }

  const patchPassed = patchResults.filter((result) => result.passed).length;
  const patchRate = patchResults.length === 0
    ? 0
    : patchPassed / patchResults.length;
  if (patchRate < dataset.gates.minimumPatchPassRate) {
    issues.push(
      `patch pass rate ${patchRate.toFixed(3)} is below ${dataset.gates.minimumPatchPassRate}`,
    );
  }

  const parity = [];
  const groups = new Map();
  for (const result of generationResults.filter(
    (candidate) => candidate.parityGroup,
  )) {
    if (!groups.has(result.parityGroup)) groups.set(result.parityGroup, []);
    groups.get(result.parityGroup).push(result);
  }
  for (const [group, members] of groups) {
    if (members.length !== 2) {
      issues.push(`parity group ${group} must contain exactly two cases`);
      continue;
    }
    const score = jaccard(members[0].nodeTypes, members[1].nodeTypes);
    parity.push({ group, score, cases: members.map(({ id }) => id) });
    if (score < dataset.gates.minimumParityJaccard) {
      issues.push(
        `parity group ${group} Jaccard ${score.toFixed(3)} is below ${dataset.gates.minimumParityJaccard}`,
      );
    }
  }

  const usageIssues = [];
  for (const row of usageRows) {
    if (row.provider !== dataset.provider) {
      usageIssues.push(`usage row ${row.id} provider is ${row.provider}`);
    }
    if (row.model !== dataset.model) {
      usageIssues.push(`usage row ${row.id} model is ${row.model}`);
    }
    if (row.providerSimulated !== false) {
      usageIssues.push(`usage row ${row.id} is simulated`);
    }
    if (row.mode === "ai" && !(row.totalTokens > 0)) {
      usageIssues.push(`successful usage row ${row.id} has no token count`);
    }
    if (row.costUsd === null || !Number.isFinite(row.costUsd)) {
      usageIssues.push(`usage row ${row.id} has unknown cost`);
    }
  }
  if (usageRows.length < allResults.length) {
    usageIssues.push(
      `expected at least ${allResults.length} usage rows, got ${usageRows.length}`,
    );
  }
  if (usageIssues.length > 0) issues.push(...usageIssues);

  const fallbackRows = usageRows.filter((row) => row.mode !== "ai");
  const fallbackRate = usageRows.length === 0
    ? 1
    : fallbackRows.length / usageRows.length;
  if (fallbackRate > dataset.gates.maximumFallbackRate) {
    issues.push(
      `provider fallback rate ${fallbackRate.toFixed(3)} exceeds ${dataset.gates.maximumFallbackRate}`,
    );
  }

  const totalCostUsd = usageRows.reduce(
    (sum, row) => sum + (Number.isFinite(row.costUsd) ? row.costUsd : 0),
    0,
  );
  if (totalCostUsd > budgetUsd) {
    issues.push(
      `observed provider cost $${totalCostUsd.toFixed(6)} exceeded authorized $${budgetUsd.toFixed(4)}`,
    );
  }

  const latencies = usageRows
    .map((row) => row.latencyMs)
    .filter((value) => Number.isFinite(value) && value >= 0);
  return {
    passed: issues.length === 0,
    issues,
    generation: {
      cases: generationResults.length,
      passed: generationPassed,
      rate: generationRate,
      confidence95: wilsonInterval(generationPassed, generationResults.length),
    },
    patches: {
      cases: patchResults.length,
      passed: patchPassed,
      rate: patchRate,
      confidence95: wilsonInterval(patchPassed, patchResults.length),
    },
    parity,
    safety: {
      cases: allResults.length,
      passed: allResults.length - safetyFailures.length,
    },
    usage: {
      calls: usageRows.length,
      aiCalls: usageRows.length - fallbackRows.length,
      fallbackCalls: fallbackRows.length,
      fallbackRate,
      inputTokens: usageRows.reduce(
        (sum, row) => sum + (row.inputTokens ?? 0),
        0,
      ),
      outputTokens: usageRows.reduce(
        (sum, row) => sum + (row.outputTokens ?? 0),
        0,
      ),
      cachedInputTokens: usageRows.reduce(
        (sum, row) => sum + (row.cachedInputTokens ?? 0),
        0,
      ),
      cacheCreationInputTokens: usageRows.reduce(
        (sum, row) => sum + (row.cacheCreationInputTokens ?? 0),
        0,
      ),
      totalCostUsd,
      authorizedBudgetUsd: budgetUsd,
      costPerTopLevelCaseUsd:
        allResults.length === 0 ? null : totalCostUsd / allResults.length,
      latency: {
        p50Ms: percentile(latencies, 0.5),
        p95Ms: percentile(latencies, 0.95),
        maxMs: latencies.length === 0 ? null : Math.max(...latencies),
      },
    },
  };
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
