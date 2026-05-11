/**
 * Janusly API — plain Node `http.createServer` with a typed route registry.
 * No Express, no Fastify, no tRPC (the tRPC stub is intentionally deleted
 * per AGENTS.md; don't reintroduce it).
 *
 * Boot sequence:
 *   1. `assertMigrationsApplied()` — fail-fast on an unmigrated DB.
 *   2. Per-request: route registry match → `requireAuth` → route-declared
 *      `requireRole` → handler.
 *   3. AI surfaces create a provider-neutral `LlmClient` from tenant config
 *      + env API keys and wrap the call in try/catch, degrading to
 *      `{ mode: "fallback", aiError, ... }` (AGENTS.md AI-fallback contract).
 *
 * Used by `apps/web` (the only browser client today) and any external
 * caller that respects dev headers or the Supabase JWT auth.
 *
 * Invariants:
 * - Multi-tenant: every DB query passes `eq(<table>.orgId, auth.orgId)`.
 * - Pagination cap: `GET /runs` and `GET /workflows` cap at 100/200 rows
 *   (`?limit=` opt-in). `GET /run` and `GET /status` cap nested events at
 *   200/500 with a composite cursor.
 * - Rate limiter: AI surfaces gate on Redis-backed `enforceRateLimit`
 *   (fails open with `[rate-limit]` warn on Redis errors).
 * - `/ai/generate-workflow` calls `llm.generateObject({ schema: WorkflowSchema })`
 *   so the model returns a typed workflow directly. The post-Zod
 *   `sanitizeAiWorkflow` step still filters edge `condition` strings and
 *   `condition`-node expressions through `validateExpression` — keep it,
 *   since Zod's `z.string()` is looser than the engine's grammar.
 * - Audit logs: every mutation writes a row with a stable `action` string;
 *   AI mutations write audit on success AND on fallback.
 */

import http from "http";
import { assertMigrationsApplied } from "@janusly/db/src/migrations";
import { startRun } from "@janusly/engine/src/start-run";
import { WorkflowInputValidationError } from "@janusly/engine/src/inputs-validator";
import { resumeRun } from "@janusly/engine/src/resume-run";
import { cancelRun } from "@janusly/engine/src/persistence";
import { validateWorkflow } from "@janusly/engine/src/workflow-validation";
import { validateExpression } from "@janusly/engine/src/expression";
import { listTools } from "@janusly/engine/src/tool-registry";
import { safePersistPayload } from "@janusly/engine/src/safe-persist";
import { checkWorkflowReadiness, type ReadinessIssue, type ReadinessResult } from "@janusly/engine/src/workflow-readiness";
import { buildReviewFallback, mergeReviewFindings, sanitizeAiReview, type ReviewFindings } from "@janusly/engine/src/workflow-review-fallback";
import { computeWorkflowHealth, MIN_RUNS_FOR_DELTA } from "@janusly/engine/src/workflow-health";
import { collectHealthSignals, DEFAULT_HEALTH_WINDOW_DAYS } from "@janusly/data/src/workflowHealthRepo";
import { normalizeErrorSignature } from "@janusly/shared/src/error-signature";
import { clusterFailureSamples } from "@janusly/engine/src/cluster-failures";
import {
  CLUSTER_MEMBERS_DEFAULT_LIMIT,
  CLUSTER_MEMBERS_MAX_LIMIT,
  findClusterMembers,
  recheckSignature,
} from "./cluster-recovery";
import { collectFailureSamples } from "@janusly/data/src/failureClusterRepo";
import { composeRecoveryMetrics } from "@janusly/engine/src/recovery-metrics";
import { collectRecoveryMetricsSignals } from "@janusly/data/src/recoveryMetricsRepo";
import { recordRecoveryFeedback, summarizePastFeedback } from "@janusly/data/src/recoveryFeedbackRepo";
import { composeFeedbackHint, RecoveryFeedbackBodySchema } from "./ai-patch-feedback";
import "@janusly/engine/src/subworkflow";
import {
  DEFAULT_USAGE_WINDOW_DAYS,
  getUsageBreakdown,
  getUsageSummary,
  isUsageBreakdownDimension,
  type UsageBreakdownDimension,
} from "@janusly/engine/src/billing";
import { DLQReplayAdapter } from "@janusly/engine/src/adapters/dlq-replay";
import { createLlmClient, explainRun, resolveLlmConfig, setUsageRecorder, suggestWorkflowImprovement, suggestWorkflowPatch, RUN_EVENT_PROMPT_CAP, type PatchSuggestion, type SuggestImprovementResult } from "@janusly/ai";
import {
  applyOrgConfigToEnv,
  getOrgConfigSnapshot,
  listOrgConfig,
  upsertOrgConfig,
} from "@janusly/data/src/orgConfigRepo";
import { recordEmailUsage, recordUsage } from "@janusly/data/src/usageRepo";
import { setEngineRateLimiter } from "@janusly/engine/src/rate-limit";
import { setEmailUsageRecorder } from "@janusly/engine/src/email-usage";
import { replayDecision, type DecisionCandidate } from "@janusly/domain";
import { requireAuth, type AuthContext } from "./auth";
import { isRole, requireRole } from "./permissions";
import { workflowTemplates } from "./templates";
import { db } from "@janusly/db";
import {
  workflows,
  workflowVersions,
  runs,
  runNodes,
  runEvents,
  credentials,
  installedPlugins,
  auditLogs,
  orgMembers,
  deadLetters,
} from "@janusly/db";
import { eq, desc, asc, and, gt, gte, isNull, lt, or } from "drizzle-orm";
import { NodeSchema, WorkflowSchema, type Workflow } from "@janusly/shared";
import { z } from "zod";
import {
  AiGenerationWorkflowSchema,
  AiSuggestImprovementEnvelope,
  patchEnvelopeForNodeType,
  ReviewFindingsSchema,
} from "./ai-schemas";
import { applyConfigPatchToWorkflow } from "./patch-workflow-merge";
import { rollbackAuditMetadata, rollbackWorkflowToVersion } from "./workflows-rollback";
import { saveWorkflowVersion } from "./workflows-save";
import { unregisterAllForWorkflow } from "@janusly/engine/src/schedule-scheduler";
import { isTerminalRunStatus, runOpenStatusValues, runTerminalStatusValues } from "@janusly/shared/src/status";
import {
  getDeadLetter,
  isDeadLetterStatus,
  listDeadLetters,
  markDeadLetterReplayed,
  markDeadLetterResolved,
} from "./dlq";
import {
  asNumber,
  asRecord,
  corsHeaders,
  httpError,
  readJson,
  sendEvent,
  sendJson,
  type CorsAwareResponse,
} from "./http";
import { enforceRateLimit } from "./rate-limit";
import { paginateRunEvents, parseEventsCursor, parseEventsLimit } from "./run-pagination";
import { matchesRoute, type Route } from "./routes";

const PORT = Number(process.env.PORT || 3001);
const MAX_JSON_BODY_BYTES = Number(process.env.API_MAX_JSON_BODY_BYTES || 1_048_576);
const AUDIT_PAGE_SIZE = 100;
const RUN_EVENTS_DEFAULT_LIMIT = 200;
const RUN_EVENTS_MAX_LIMIT = 500;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OPEN_RUN_STATUS_SET = new Set<string>(runOpenStatusValues);
const FAILED_RUN_STATUS_SET = new Set<string>(runTerminalStatusValues.filter((status) => status !== "succeeded"));

const dlqReplay = new DLQReplayAdapter();

/**
 * System prompt for `/ai/generate-workflow`. Joined with `"\n"` so the
 * provider-neutral `LlmClient.generateText` accepts it as a single string
 * (the AI SDK collapses `system` + `prompt` into the right wire format per
 * provider). The grammar listed here is intentionally narrow — the AI SDK's
 * structured-output path enforces shape, and `sanitizeAiWorkflow` filters
 * grammar-invalid edge / condition expressions post-validation.
 */
const GENERATE_WORKFLOW_SYSTEM_PROMPT = [
  "You generate Janusly workflow DAGs as JSON. Output only the JSON object — no prose.",
  "Shape: {dslVersion:'1.0',id,name,nodes:[{id,type,config}],edges:[{from,to,condition?}]}.",
  "Use snake_case ids (start, fetch, decide). Node `id`s must be unique. Every edge `from`/`to` must reference a node `id`.",
  "SUPPORTED AI-GENERATION TYPES: only emit nodes of these 11 types: 'noop', 'http', 'transform', 'condition', 'ai', 'tool', 'agent', 'router', 'approval', 'multi_agent', 'loop'. The platform supports 8 more operator-only types (wait_until, webhook, agent_reflection, router_llm, subworkflow, parallel_fork, join, schedule), but those are added by the operator in the Inspector after generation. If a prompt asks for one of those eight, use 'noop' as a placeholder named after the requested step (e.g. id='wait_24h' type='noop', id='ext_webhook' type='noop', id='schedule_daily' type='noop'). Use 'multi_agent' when the prompt explicitly asks for a team/crew/group of agents working together; use 'agent' for a single autonomous step. Use 'approval' when the prompt mentions a human gate, sign-off, or confirmation step. Use 'loop' for batch / for-each iterations.",
  "PLACEHOLDER RULE: when the user prompt mentions a branch name or step that has NO concrete action (e.g. 'fast_path', 'accurate_path', 'review', 'send_email') without specifying a URL, tool name, AI prompt, or backend action, use type 'noop' for that step. NEVER emit an 'http' node without a real URL or an 'ai' node without a prompt — the workflow will fail validation. Use 'http' only when the user explicitly gives a URL or describes calling a specific API. Use 'ai' only when the user wants the model to summarize, decide, or generate text. Use 'tool' only with a tool name from the list below.",
  "ROUTER RULE: every router/router_llm node MUST have at least one candidate, and every candidate's `nodeId` MUST match the `id` of another node in the same workflow. Add the target nodes (typically as 'noop' placeholders) before the router references them.",
  "Node types and required config:",
  "- http: { url:string, method?:'GET'|'POST'|... } — runtime defaults: timeoutMs 30000, maxResponseBytes 1MB, maxRedirects 5. Retry, timeout, and bounds adjustments are added by the operator in the Inspector after generation; do not include them in the JSON you emit.",
  "- noop: {} (good for explicit start/end markers)",
  "- transform: { mapping: object } — value templates may reference {{context.<nodeId>.output.<field>}}",
  "- condition: { expression: string } — expression must use the limited grammar in `edges[].condition` below",
  "- webhook: {} (waits for external resume)",
  "- approval: { message?: string } (waits for human approval)",
  "- ai: { prompt: string, model?: string }",
  "- tool: { tool: 'http.request'|'text.uppercase'|'text.lowercase'|'text.trim'|'text.replace'|'text.regex'|'json.pick'|'json.set'|'json.merge'|'json.jq'|'csv.parse'|'csv.stringify'|'csv.filter'|'time.now'|'time.parse'|'time.format'|'time.diff'|'time.add'|'crypto.sha256'|'crypto.hmac'|'crypto.uuid', input?: { [key: string]: string } } — the input is a flat string-keyed map of template values. Tools needing richer inputs (csv rows, nested config) are filled by the operator after generation.",
  "- agent: { goal: string, planner?: 'rules'|'openai', maxSteps?: number, value?: string }",
  "- multi_agent: { goal: string, mode?: 'sequential'|'parallel', agents: Array<{name,role,goal,persona?}>, reflection?: boolean }",
  "- agent_reflection: { input?: string } — typically a template referencing a prior agent's output, e.g. \"{{context.agent.output}}\".",
  "- loop: { items: string | string[], mapping?: { [key: string]: string } } — `items` is either a comma-separated template string or a string array; `mapping` is a flat string-keyed map of templates per item.",
  "- router: { candidates: Array<{nodeId: string, avgCost?: number, avgLatencyMs?: number, successRate?: number}>, strategy?: 'cheapest'|'fastest'|'balanced'|'auto' } — `nodeId` must reference an existing node id; scoring fields are optional and the runtime seeds them from prior runs when stats are available",
  "- router_llm: { candidates: Array<{nodeId: string}> } — same candidate identifier shape as router with scoring fields omitted; downstream steps can inspect the decision output from context",
  "- subworkflow: { workflowId: string, input?: { [key: string]: string } } (calls another saved workflow; child outputs become this node's output. Multi-tenant: child must be in the same org. Recursion guard: depth limit JANUSLY_MAX_SUBWORKFLOW_DEPTH, default 5.)",
  "- wait_until: { duration: string } (ISO 8601 duration; pauses the run until the deadline elapses, e.g. \"P3D\" = 3 days, \"PT2H30M\" = 2.5 hours. Output is empty {}.)",
  "- schedule: { cronExpression: string, enabled?: boolean } (cron trigger registered by the operator after generation; use noop placeholders in AI output for scheduled starts.)",
  "edges[].condition grammar (optional, leave it out unless you really need branching):",
  "  - boolean literals: true / false",
  "  - numbers, single/double-quoted strings, null",
  "  - paths starting with `context.` or `inputs.` (e.g. context.fetch.output.statusCode)",
  "  - comparisons: ===, !==, ==, !=, >, <, >=, <=",
  "  - boolean composition: &&, ||, !, parentheses",
  "  - INVALID: bare identifiers (e.g. risk_is_high), function calls, string concatenation, regex.",
  "If you can't express a condition with this grammar, omit `condition` and route via a `condition` or `router` node instead.",
  "Pick 2–6 nodes for most prompts. Prefer the simplest valid DAG.",
  "EXAMPLE — abstract router prompt (\"smart router that picks between fast_path and accurate_path\"):",
  '{"dslVersion":"1.0","id":"smart_router_demo","name":"Smart Router Demo","nodes":[{"id":"start","type":"noop","config":{}},{"id":"pick","type":"router","config":{"candidates":[{"nodeId":"fast_path"},{"nodeId":"accurate_path"}],"strategy":"auto"}},{"id":"fast_path","type":"noop","config":{}},{"id":"accurate_path","type":"noop","config":{}}],"edges":[{"from":"start","to":"pick"}]}',
].join("\n");

/**
 * System prompt for `/ai/review-workflow`. Sister to the deterministic
 * readiness gate — this is the AI semantic-pass that catches things
 * rules can't (ambiguous prompts, PII risk in downstream context refs,
 * malformed-but-shape-valid tool inputs). The structured-output schema
 * (`ReviewFindingsSchema`) enforces the response shape; this prompt
 * gives the model the policy + checklist + severity rubric.
 */
const REVIEW_WORKFLOW_SYSTEM_PROMPT = [
  "You are a Janusly production-readiness reviewer. Review the workflow JSON the user submits and emit structured findings only — no prose, no explanation outside the schema.",
  "Severity rules:",
  "- 'fail': blocking issue an operator must fix before production. Examples: hardcoded secret, missing retries on external call, dangerous action without an approval ancestor, malformed router (candidates that don't reference real node ids), unknown tool name.",
  "- 'warn': non-blocking but worth flagging. Examples: missing HTTP timeoutMs override on a slow upstream, ambiguous AI prompt, missing outputs declaration, write-side action without explicit human gate.",
  "- 'info': neutral observation that improves quality but isn't a defect. Examples: workflow could benefit from a transform step to shape AI input.",
  "Checks to apply (non-exhaustive — flag anything you'd hesitate to ship):",
  "- Retries on http/tool/ai/agent nodes (config.retry.maxAttempts).",
  "- HTTP bounds (timeoutMs / maxResponseBytes / maxRedirects) — defaults are sensible but explicit values record operator intent.",
  "- Hardcoded secrets in node config — a string value that looks like a token, key, or bearer literal should be a {{secret.X}} / {{env.X}} / {{credential.X}} template.",
  "- Approval gate upstream of write-side actions (POST/PUT/PATCH/DELETE http nodes; tool calls that send/create/delete; multi_agent crews making external changes).",
  "- Unknown tools — a `tool` node whose `tool` field doesn't match a real registered tool name; flag as ambiguous.",
  "- Malformed routers — router/router_llm with empty candidates, candidates pointing at nodes that don't exist in the workflow, or candidates that all do the same work (no real choice).",
  "- Missing outputs declaration — workflow.outputs is missing or empty.",
  "- Ambiguous AI prompts — prompts lacking concrete grounding in context (e.g. \"do something useful\" instead of \"summarize {{context.fetch.output.body}} in 2 sentences\").",
  "- PII / sensitive-action risk — an AI prompt that includes a body field from a user-data upstream without scrubbing or redaction.",
  "Per-finding format:",
  "- code: snake_case stable identifier (e.g. http_missing_retry, raw_secret_in_config). Reuse readiness codes when the AI semantic finding matches a deterministic rule.",
  "- severity: 'info' | 'warn' | 'fail'.",
  "- message: one-sentence problem statement.",
  "- nodeId: id of the affected node when locatable. Omit for workflow-level issues.",
  "- edgeId: id of the affected edge when locatable.",
  "- rationale: why this matters in production. Be specific.",
  "- suggestion: one concrete edit that fixes the finding (e.g. 'set config.retry.maxAttempts to 3 with backoff: exponential').",
  "Roll up status: any 'fail' → 'fail'; otherwise any 'warn' → 'warn'; clean → 'pass'.",
].join("\n");

async function orgLlmRuntime(orgId: string) {
  const orgConfig = await getOrgConfigSnapshot(orgId);
  const llmConfig = resolveLlmConfig(applyOrgConfigToEnv(orgConfig));
  return { orgConfig, llm: llmConfig ? createLlmClient(llmConfig) : null, llmConfig };
}

async function aiStatus(orgId: string) {
  // Env still provides API keys and global defaults; `org_configs` can
  // override safe tenant-level choices such as provider/model and limits.
  const { orgConfig, llmConfig } = await orgLlmRuntime(orgId);
  const provider = llmConfig?.provider ?? orgConfig.ai.provider;
  const model =
    llmConfig?.defaultModels[provider] ??
    (provider === "anthropic" ? orgConfig.ai.anthropicModel : orgConfig.ai.openaiModel);
  return {
    enabled: Boolean(llmConfig?.apiKeys[provider]),
    provider,
    model,
    timeoutMs: orgConfig.ai.timeoutMs,
    maxRetries: orgConfig.ai.maxRetries,
  };
}

/**
 * Post-Zod sanitization for `/ai/generate-workflow`. The LLM-emitted
 * workflow has already been validated against `WorkflowSchema` by the AI SDK's
 * structured-output path; this step only filters edge `condition` strings and
 * `condition`-node expressions through `validateExpression` (Janusly's limited
 * grammar). Without this, valid-shaped-but-grammar-invalid expressions would
 * crash at runtime instead of being silently dropped or normalised. The
 * `looseAiWorkflow` shape-coercer is intentionally not used now that the
 * route calls `generateObject({ schema: WorkflowSchema })`.
 */
function sanitizeAiWorkflow(workflow: Workflow): Workflow {
  const sanitizedEdges = workflow.edges.map((edge) => {
    if (!edge.condition) return edge;
    return validateExpression(edge.condition).valid ? edge : { ...edge, condition: undefined };
  });
  const sanitizedNodes = workflow.nodes.map((node) => {
    if (node.type !== "condition") return node;
    const expression = node.config && typeof (node.config as { expression?: unknown }).expression === "string"
      ? String((node.config as { expression: string }).expression)
      : "";
    if (expression && !validateExpression(expression).valid) {
      return { ...node, config: { ...(node.config ?? {}), expression: "true" } };
    }
    return node;
  });
  const sanitized = { ...workflow, nodes: sanitizedNodes, edges: sanitizedEdges };

  const validation = validateWorkflow(sanitized);
  if (!validation.valid) {
    throw httpError(`AI returned a workflow with validation issues: ${validation.issues.map(issue => issue.message).join(", ")}`, 502);
  }

  return sanitized;
}

const stepLabels: Record<string, string> = {
  http: "Call an API",
  noop: "Do nothing",
  transform: "Shape data",
  condition: "Branch rule",
  webhook: "Wait for webhook",
  approval: "Ask approval",
  ai: "AI prompt",
  tool: "Run a tool",
  agent: "Agent",
  router: "Smart router",
  router_llm: "AI router",
  loop: "Repeat list",
  agent_reflection: "Review result",
  multi_agent: "Agent team",
};

function fallbackExplainWorkflow(workflow: unknown) {
  const parsed = WorkflowSchema.safeParse(workflow);
  if (!parsed.success) {
    return "Janusly could not read this flow yet. Check that it has valid steps and paths.";
  }

  const data = parsed.data;
  const labelFor = (nodeId: string) => {
    const node = data.nodes.find(candidate => candidate.id === nodeId);
    return node ? stepLabels[node.type] ?? node.type.replaceAll("_", " ") : nodeId;
  };
  const incoming = new Set(data.edges.map(edge => edge.to));
  const startNodes = data.nodes.filter(node => !incoming.has(node.id)).map(node => labelFor(node.id));
  const nodeNames = data.nodes.map(node => `- ${stepLabels[node.type] ?? node.type.replaceAll("_", " ")} (${node.id})`).join("\n");
  const flow = data.edges.length
    ? data.edges.map(edge => `${labelFor(edge.from)} -> ${labelFor(edge.to)}${edge.condition ? " when the rule passes" : ""}`).join("\n")
    : "No paths yet; this flow has one or more standalone steps.";

  return [
    `${data.name ?? data.id ?? "This flow"} has ${data.nodes.length} step${data.nodes.length === 1 ? "" : "s"}.`,
    `It starts with: ${startNodes.length ? startNodes.join(", ") : "no clear start step"}.`,
    `Steps:\n${nodeNames || "none"}`,
    `Path:\n${flow}`,
    "Next check: validate the flow, run it, then ask Janusly what happened.",
  ].join("\n");
}

function fallbackWorkflowForPrompt(prompt: unknown) {
  const text = typeof prompt === "string" ? prompt.toLowerCase() : "";
  const templateId = text.includes("approval") || text.includes("approve") || text.includes("aprob") || text.includes("human") || text.includes("risk")
    ? "approval-gate"
    : text.includes("transform") || text.includes("map") || text.includes("tool") || text.includes("herramient") || text.includes("backend")
      ? "api-transform-tool"
      : "http-ai-summary";

  return workflowTemplates.find(template => template.id === templateId)?.workflow ?? workflowTemplates[0]?.workflow;
}

function decisionCandidatesFromPayload(payload: unknown): DecisionCandidate[] {
  const record = asRecord(payload);
  const ranking = Array.isArray(record.ranking) ? record.ranking : [];

  return ranking.flatMap(item => {
    const candidate = asRecord(item);
    const breakdown = asRecord(candidate.breakdown);
    const nodeId = typeof candidate.nodeId === "string" ? candidate.nodeId : "";
    if (!nodeId) return [];

    return [{
      nodeId,
      avgCost: asNumber(breakdown.cost),
      avgLatencyMs: asNumber(breakdown.latency),
      successRate: asNumber(breakdown.quality),
    }];
  });
}

// Audit metadata cap — audit rows are read by humans and should stay tight.
// 64 KB lets a row carry an explanation + a small input snapshot but caps
// before a megabyte of caller payload sneaks into the audit log.
const AUDIT_METADATA_MAX_BYTES = 64_000;

async function audit(orgId: string, userId: string, action: string, targetType?: string, targetId?: string, metadata: unknown = {}) {
  try {
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      orgId,
      userId,
      action,
      targetType,
      targetId,
      // Sanitizer chokepoint scrubs sensitive keys (`secret*`, `token*`,
      // `Authorization`, etc.) and bounds the row size with a `__truncated`
      // sentinel for over-cap payloads. Same sensitive-key regex the
      // engine writes go through, so audit + run_events stay consistent.
      metadata: safePersistPayload(metadata, { maxBytes: AUDIT_METADATA_MAX_BYTES }),
    });
  } catch (error) {
    console.warn("audit write failed", error);
  }
}

/**
 * Layer the DB-aware rollback-availability check on top of the pure
 * `checkWorkflowReadiness` result. Workflows with only one persisted
 * version have no rollback target if a future save introduces a
 * regression; the readiness gate surfaces this as a `warn` so the
 * operator knows. Anonymous workflows (no `id`) skip the check —
 * `workflow_versions` is keyed by the saved id, so an ad-hoc workflow
 * has nothing to count.
 */
async function checkRollbackAvailability(orgId: string, workflowId: string | undefined): Promise<ReadinessIssue[]> {
  if (!workflowId) return [];
  const rows = await db
    .select({ id: workflowVersions.id })
    .from(workflowVersions)
    .where(and(eq(workflowVersions.orgId, orgId), eq(workflowVersions.workflowId, workflowId)));
  if (rows.length >= 2) return [];
  return [{
    code: "workflow_missing_rollback_version",
    severity: "warn",
    message: "Only one workflow version exists. If a future save introduces a regression there is no prior version to roll back to.",
    suggestion: "Save the workflow at least once more (or duplicate the current version) so the runtime improvement path can roll back if confidence drops.",
  }];
}

/** Combine the pure readiness result with extra issues from DB-aware checks. Re-rolls up status to the worst severity across the union. */
function mergeReadiness(base: ReadinessResult, extra: ReadinessIssue[]): ReadinessResult {
  const issues = [...base.issues, ...extra];
  const status = issues.some((issue) => issue.severity === "fail")
    ? "fail"
    : issues.some((issue) => issue.severity === "warn")
      ? "warn"
      : "pass";
  return { status, issues };
}

/**
 * Route registry. New routes plug in via `routes.push({...})` or
 * by appending to this literal — the dispatcher (`http.createServer` below)
 * stays closed for modification. First-match-wins; preserve ordering when
 * adding routes that overlap (e.g. `/runs` prefix vs `/run?` exact).
 *
 * Every route's `handler` runs AFTER `requireAuth` + (optionally) `requireRole`
 * — handlers receive `auth` already-validated. Multi-tenant scope (per-row
 * `orgId` checks) still lives inside the handler per AGENTS.md.
 */
export const routes: Route[] = [
  // Health (no auth)
  { method: "GET", match: "/health", skipAuth: true,
    handler: async ({ res }) => sendJson(res, { ok: true }) },

  // Catalog reads (any role)
  { method: "GET", match: "/tools",
    handler: async ({ res }) => sendJson(res, listTools()) },
  { method: "GET", match: "/templates",
    handler: async ({ res }) => sendJson(res, workflowTemplates) },
  // Usage reporting. Default response is the existing flat
  // `Record<metric, quantity>` for back-compat. When the caller passes
  // `?breakdown=provider,model,mode,day,node,workflow` (any combination of the
  // closed-enum dimensions), the response also includes a `breakdown`
  // array of per-bucket aggregates (token totals, call count, fallback
  // count, costUsd, latency p50/p95/avg). Both paths read the same
  // bounded 30-day / 10k-row slice — the unbounded-scan invariant
  // stays intact.
  { method: "GET", match: (url) => url === "/billing/usage" || url.startsWith("/billing/usage?"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const raw = url.searchParams.get("breakdown");
      const tokens = (raw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      const dimensions: UsageBreakdownDimension[] = [];
      for (const token of tokens) {
        if (!isUsageBreakdownDimension(token)) {
          return sendJson(res, { error: `Unknown breakdown dimension: ${token}` }, 400);
        }
        if (!dimensions.includes(token)) dimensions.push(token);
      }
      const summary = await getUsageSummary(auth.orgId);
      if (dimensions.length === 0) {
        return sendJson(res, summary);
      }
      const breakdown = await getUsageBreakdown(auth.orgId, dimensions);
      return sendJson(res, { summary, breakdown, windowDays: DEFAULT_USAGE_WINDOW_DAYS });
    } },
  { method: "GET", match: "/org/config",
    handler: async ({ res, auth }) => sendJson(res, { config: await listOrgConfig(auth.orgId) }) },
  { method: "POST", match: "/org/config", role: "admin",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const key = typeof body.key === "string" ? body.key : "";
      if (!key) return sendJson(res, { error: "key is required" }, 400);
      if (!Object.hasOwn(body, "value")) return sendJson(res, { error: "value is required" }, 400);

      try {
        const entry = await upsertOrgConfig({ orgId: auth.orgId, key, value: body.value, userId: auth.userId });
        await audit(auth.orgId, auth.userId, "org.config.updated", "org_config", key, { key, value: entry.value });
        return sendJson(res, entry);
      } catch (error) {
        return sendJson(res, { error: error instanceof Error ? error.message : "Invalid org config" }, 400);
      }
    } },

  // Members / roles
  { method: "GET", match: "/members",
    handler: async ({ res, auth }) => {
      const rows = await db.select().from(orgMembers).where(eq(orgMembers.orgId, auth.orgId));
      return sendJson(res, rows);
    } },
  { method: "POST", match: "/members/invite", role: "admin",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const email = typeof body.email === "string" ? body.email.trim() : "";
      const role = isRole(body.role) ? body.role : "viewer";
      if (!email) return sendJson(res, { error: "email is required" }, 400);
      if (!EMAIL_PATTERN.test(email) || email.length > 254) {
        return sendJson(res, { error: "email format is invalid" }, 400);
      }
      // Until invite-acceptance flow is in place, user_id starts as the email so the
      // member row is queryable by it; replace on first sign-in or accept event.
      const userId = typeof body.userId === "string" && body.userId.trim() ? body.userId.trim() : email;
      const existing = await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, auth.orgId), eq(orgMembers.userId, userId)));
      if (existing[0]) return sendJson(res, { error: "Member already exists for this org" }, 409);
      const id = crypto.randomUUID();
      await db.insert(orgMembers).values({ id, orgId: auth.orgId, userId, email, role, invitedBy: auth.userId });
      await audit(auth.orgId, auth.userId, "member.invited", "member", userId, { email, role });
      return sendJson(res, { id });
    } },
  { method: "POST", match: "/members/role", role: "admin",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const userId = typeof body.userId === "string" ? body.userId : "";
      if (!userId) return sendJson(res, { error: "userId is required" }, 400);
      if (!isRole(body.role)) return sendJson(res, { error: "role must be viewer, editor, or admin" }, 400);
      await db.update(orgMembers).set({ role: body.role }).where(and(eq(orgMembers.orgId, auth.orgId), eq(orgMembers.userId, userId)));
      await audit(auth.orgId, auth.userId, "member.role.updated", "member", userId, { role: body.role });
      return sendJson(res, { ok: true });
    } },
  { method: "DELETE", match: (url) => url.startsWith("/members"), role: "admin",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const userId = url.searchParams.get("userId");
      if (!userId) return sendJson(res, { error: "userId is required" }, 400);
      await db.delete(orgMembers).where(and(eq(orgMembers.orgId, auth.orgId), eq(orgMembers.userId, userId)));
      await audit(auth.orgId, auth.userId, "member.removed", "member", userId);
      return sendJson(res, { ok: true });
    } },

  // Workflows — list + version reads + save
  // NOTE: `/workflows/versions` and `/workflows/latest` come BEFORE `/workflows`
  // so the prefix-but-not-`/workflows/` matcher doesn't shadow them.
  { method: "GET", match: (url) => url.startsWith("/workflows/versions"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const workflowId = url.searchParams.get("workflowId");
      if (!workflowId) return sendJson(res, { error: "workflowId is required" }, 400);
      const versions = await db.select().from(workflowVersions).where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.orgId, auth.orgId))).orderBy(desc(workflowVersions.version));
      return sendJson(res, versions);
    } },
  { method: "GET", match: (url) => url.startsWith("/workflows/latest"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const workflowId = url.searchParams.get("workflowId");
      if (!workflowId) return sendJson(res, { error: "workflowId is required" }, 400);
      const versions = await db.select().from(workflowVersions).where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.orgId, auth.orgId))).orderBy(desc(workflowVersions.version));
      return sendJson(res, versions[0] ?? null);
    } },
  { method: "GET", match: (url) => url.startsWith("/workflows") && !url.startsWith("/workflows/"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const limitParam = Number(url.searchParams.get("limit"));
      const limitValue = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 100;
      const rows = await db.select().from(workflows).where(eq(workflows.orgId, auth.orgId)).orderBy(desc(workflows.createdAt)).limit(limitValue);
      return sendJson(res, rows);
    } },
  { method: "POST", match: "/workflows/save", role: "editor",
    handler: async ({ req, res, auth }) => {
      const workflow = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const validation = validateWorkflow(workflow);
      if (!validation.valid) return sendJson(res, { error: "Validation failed", issues: validation.issues }, 400);
      const parsedWorkflow = WorkflowSchema.parse(workflow);

      // Concurrent saves for the same `(orgId, workflowId)` resolve via
      // a bounded unique-constraint retry inside `saveWorkflowVersion`.
      // On exhausted retries the helper returns `kind: "conflict"` so
      // the operator sees a clean 409 ("please retry") instead of the
      // 5xx the inline transaction used to emit.
      const result = await saveWorkflowVersion({
        orgId: auth.orgId,
        userId: auth.userId,
        parsedWorkflow,
      });

      if (result.kind === "conflict") {
        return sendJson(res, {
          error: "Concurrent save conflict — please retry",
          attempts: result.attempts,
        }, 409);
      }

      await audit(auth.orgId, auth.userId, "workflow.saved", "workflow", result.workflowId, {
        version: result.version,
        attempts: result.attempts,
      });
      return sendJson(res, {
        workflowId: result.workflowId,
        versionId: result.versionId,
        version: result.version,
      });
    } },
  { method: "POST", match: "/workflows/rollback", role: "editor",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const workflowId = typeof body.workflowId === "string" ? body.workflowId : "";
      const sourceVersionId = typeof body.sourceVersionId === "string" ? body.sourceVersionId : "";
      if (!workflowId || !sourceVersionId) {
        return sendJson(res, { error: "workflowId and sourceVersionId are required" }, 400);
      }
      const result = await rollbackWorkflowToVersion({
        orgId: auth.orgId,
        userId: auth.userId,
        workflowId,
        sourceVersionId,
      });
      if (!result.ok) {
        return sendJson(res, { error: "Source version not found" }, 404);
      }
      await audit(auth.orgId, auth.userId, "workflow.rolled_back", "workflow", workflowId, rollbackAuditMetadata(result));
      return sendJson(res, {
        workflowId,
        versionId: result.versionId,
        version: result.version,
        sourceVersion: result.sourceVersion,
      });
    } },
  // DELETE /workflows/:id — hard-deletes the workflow + every persisted
  // version + every cron-driven schedule entry (and its BullMQ
  // scheduler). Runs and audit rows stay; their `workflow_version_id`
  // text column has no FK constraint, so orphan references are tolerated
  // for history. Match excludes special POST-only subpaths so a future
  // edit can't accidentally route `/workflows/save` here on the wrong
  // method.
  { method: "DELETE",
    match: (url) => {
      if (!url.startsWith("/workflows/")) return false;
      const rest = url.slice("/workflows/".length).split("?")[0];
      if (rest.length === 0 || rest.includes("/")) return false;
      const reserved = new Set(["save", "rollback", "versions", "latest", "validate", "readiness", "health"]);
      return !reserved.has(rest);
    },
    role: "editor",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const workflowId = url.pathname.slice("/workflows/".length);
      if (!workflowId) return sendJson(res, { error: "workflowId is required" }, 400);

      const existing = await db.select().from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.orgId, auth.orgId)));
      if (!existing[0]) return sendJson(res, { error: "Workflow not found" }, 404);

      // Schedule teardown fails open — a Redis blip shouldn't block a
      // workflow delete from completing. The worker's cold-start replay
      // won't re-register entries whose DB rows are gone, so a stuck
      // BullMQ scheduler self-clears after the rows go away.
      try {
        await unregisterAllForWorkflow(auth.orgId, workflowId);
      } catch (err) {
        console.error("[workflows-delete] schedule teardown failed", { workflowId, err });
      }
      await db.delete(workflowVersions).where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.orgId, auth.orgId)));
      await db.delete(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.orgId, auth.orgId)));

      await audit(auth.orgId, auth.userId, "workflow.deleted", "workflow", workflowId, {});
      return sendJson(res, { workflowId, ok: true });
    } },

  // Plugins / credentials
  { method: "GET", match: "/plugins",
    handler: async ({ res, auth }) => {
      const installed = await db.select().from(installedPlugins).where(eq(installedPlugins.orgId, auth.orgId));
      return sendJson(res, { available: listTools(), installed });
    } },
  { method: "POST", match: "/plugins/install", role: "admin",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const pluginId = typeof body.pluginId === "string" ? body.pluginId : "";
      if (!pluginId) return sendJson(res, { error: "pluginId is required" }, 400);
      const id = crypto.randomUUID();
      await db.insert(installedPlugins).values({ id, orgId: auth.orgId, pluginId, configJson: body.config ?? {}, installedBy: auth.userId });
      await audit(auth.orgId, auth.userId, "plugin.installed", "plugin", pluginId, body.config ?? {});
      return sendJson(res, { id });
    } },
  { method: "GET", match: "/credentials",
    handler: async ({ res, auth }) => {
      const rows = await db.select().from(credentials).where(eq(credentials.orgId, auth.orgId));
      return sendJson(res, rows);
    } },
  { method: "POST", match: "/credentials", role: "admin",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      if (typeof body.name !== "string" || typeof body.kind !== "string" || typeof body.secretRef !== "string") {
        return sendJson(res, { error: "name, kind, and secretRef are required" }, 400);
      }
      const id = crypto.randomUUID();
      await db.insert(credentials).values({ id, orgId: auth.orgId, name: body.name, kind: body.kind, secretRef: body.secretRef, metadata: body.metadata ?? {}, createdBy: auth.userId });
      await audit(auth.orgId, auth.userId, "credential.created", "credential", id, { kind: body.kind });
      return sendJson(res, { id });
    } },

  // Audit
  { method: "GET", match: (url) => url.startsWith("/audit"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const limitParam = Number(url.searchParams.get("limit"));
      const limitValue = Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(limitParam, 200)
        : AUDIT_PAGE_SIZE;
      const rows = await db.select().from(auditLogs)
        .where(eq(auditLogs.orgId, auth.orgId))
        .orderBy(desc(auditLogs.createdAt))
        .limit(limitValue);
      return sendJson(res, rows);
    } },

  // Validate
  { method: "POST", match: "/validate", role: "editor",
    handler: async ({ req, res }) => sendJson(res, validateWorkflow(await readJson(req, MAX_JSON_BODY_BYTES))) },

  // Production-readiness gate. Sister to `/validate` — this asserts
  // production posture (retries, bounds, raw secrets, approval upstream of
  // write-side actions, output declarations, rollback availability) on
  // top of the structural validation `/validate` already covers. The
  // engine portion is pure; the rollback-availability check is layered
  // here because it needs `workflow_versions` access. Body shape: either
  // a flat workflow JSON or `{ workflow }` envelope (mirrors `/validate`).
  { method: "POST", match: "/workflows/readiness", role: "editor",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const candidate = (body.workflow && typeof body.workflow === "object") ? asRecord(body.workflow) : body;
      const validation = validateWorkflow(candidate);
      if (!validation.valid) {
        const issues: ReadinessIssue[] = validation.issues.map((issue) => ({
          code: `invalid_workflow_${issue.code}`,
          severity: "fail" as const,
          message: issue.message,
          nodeId: issue.nodeId,
        }));
        return sendJson(res, { status: "fail", issues } satisfies ReadinessResult);
      }
      const parsed = WorkflowSchema.parse(candidate);
      const baseResult = checkWorkflowReadiness(parsed);
      const rollbackIssues = await checkRollbackAvailability(auth.orgId, parsed.id);
      const merged = mergeReadiness(baseResult, rollbackIssues);
      return sendJson(res, merged);
    } },

  // Workflow health rollup. Sister to /workflows/readiness — readiness is
  // a static rules-only gate; health is the rolled-up score across the
  // last 30 days of run activity (success rate, DLQ count, retry events,
  // p95 latency, cost-per-run, rollback availability) plus the static
  // readiness signal as the safety dimension. Returns a 0–100 score with
  // a per-category breakdown the web badge renders. Read-only — viewer
  // role suffices.
  // Recovery before/after delta — registered BEFORE `/workflows/health`
  // so the more-specific path wins in the first-match-wins dispatcher.
  // Splits the same time window by version cutoff: runs whose version
  // < `afterVersion` form the "before" side; runs whose version >= cutoff
  // form the "after" side. Returns both health scores plus a per-signal
  // delta, the run-status counter (always populated), the same-failure
  // check (when the caller supplies the prior signature), and the prior
  // version's id (for the regression-rollback affordance in the dialog).
  { method: "GET", match: (url) => url === "/workflows/health/delta" || url.startsWith("/workflows/health/delta?"), role: "viewer",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const workflowId = url.searchParams.get("workflowId");
      const rawAfter = url.searchParams.get("afterVersion");
      const parsedAfterVersion = rawAfter == null ? NaN : Number(rawAfter);
      const afterVersion = Number.isInteger(parsedAfterVersion) ? parsedAfterVersion : NaN;
      if (!workflowId) return sendJson(res, { error: "workflowId is required" }, 400);
      if (!Number.isFinite(afterVersion) || afterVersion < 1) {
        return sendJson(res, { error: "afterVersion must be a positive integer" }, 400);
      }
      const parsedWindowDays = Number(url.searchParams.get("windowDays") ?? NaN);
      // Default to the same 30-day window the bare /workflows/health route
      // uses. With a 1-day default, production runs accumulating over weeks
      // would never meet the 5-run threshold and the dialog would
      // perpetually show the gathering-data state.
      const windowDays = Number.isInteger(parsedWindowDays)
        ? Math.min(30, Math.max(1, parsedWindowDays))
        : DEFAULT_HEALTH_WINDOW_DAYS;
      const rawSignature = url.searchParams.get("priorFailureSignature");
      const priorFailureSignature = rawSignature && rawSignature.length <= 256 ? rawSignature : null;

      // Multi-tenant gate first — same enumeration-safe message as the
      // bare `/workflows/health` route.
      const owned = await db
        .select({ id: workflows.id })
        .from(workflows)
        .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, auth.orgId)))
        .limit(1);
      if (owned.length === 0) return sendJson(res, { error: "Workflow not found" }, 404);

      // Latest version drives readiness (the workflow JSON the operator
      // currently saved is the post-Apply state). The before-side health
      // score uses the same readiness — it's per-DAG, not per-window.
      const latestVersion = await db
        .select({ dagJson: workflowVersions.dagJson })
        .from(workflowVersions)
        .where(and(eq(workflowVersions.orgId, auth.orgId), eq(workflowVersions.workflowId, workflowId)))
        .orderBy(desc(workflowVersions.version))
        .limit(1);
      if (latestVersion.length === 0) {
        return sendJson(res, { error: "Workflow has no versions" }, 404);
      }
      const parsedWorkflow = WorkflowSchema.safeParse(latestVersion[0].dagJson);
      if (!parsedWorkflow.success) {
        return sendJson(res, { error: "Workflow version is malformed" }, 422);
      }

      const baseReadiness = checkWorkflowReadiness(parsedWorkflow.data);
      const rollbackIssues = await checkRollbackAvailability(auth.orgId, workflowId);
      const readiness = mergeReadiness(baseReadiness, rollbackIssues);

      // Before/after signal collection in parallel — each side reuses the
      // same query plan with a single new `lt`/`gte` predicate on the
      // joined `workflow_versions.version` column.
      const [beforeSignals, afterSignals] = await Promise.all([
        collectHealthSignals(auth.orgId, workflowId, windowDays, { side: "before", cutoffVersion: afterVersion }),
        collectHealthSignals(auth.orgId, workflowId, windowDays, { side: "after", cutoffVersion: afterVersion }),
      ]);

      const before = computeWorkflowHealth({ workflow: parsedWorkflow.data, readiness, signals: beforeSignals });
      const after = computeWorkflowHealth({ workflow: parsedWorkflow.data, readiness, signals: afterSignals });

      // Run-status counter — distinct from `after.signals.totalRuns`
      // because the health rollup counts only terminal runs. The counter
      // surfaces in-flight runs so the operator sees "1 running, 0
      // terminal" right after Apply rather than a dead "0 runs".
      // Excludes sandbox/validation runs (replayMode = "validation") so a
      // dry-run from the Recovery dialog's validation gate doesn't appear
      // as a phantom production run in the counter.
      const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
      const recentRunsRows = await db
        .select({ status: runs.status })
        .from(runs)
        .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
        .where(and(
          eq(workflowVersions.orgId, auth.orgId),
          eq(workflowVersions.workflowId, workflowId),
          gte(workflowVersions.version, afterVersion),
          gte(runs.createdAt, since),
          isNull(runs.replayMode),
        ));
      const recentRunsAgainstAfter = {
        totalRuns: recentRunsRows.length,
        succeeded: recentRunsRows.filter((row) => row.status === "succeeded").length,
        failed: recentRunsRows.filter((row) => FAILED_RUN_STATUS_SET.has(row.status)).length,
        running: recentRunsRows.filter((row) => OPEN_RUN_STATUS_SET.has(row.status)).length,
      };

      // Same-failure check — only when the caller supplies the original
      // signature. We re-normalize each new DLQ row and count matches.
      // Defense-in-depth: the response only echoes back the
      // caller-supplied signature, never a freshly-derived one, so a
      // leaked-secret-in-error-message can't slip through this surface.
      let sameFailureSinceApply: { count: number; sampleDeadLetterIds: string[]; priorSignature: string } | null = null;
      if (priorFailureSignature) {
        const dlqRows = await db
          .select({
            id: deadLetters.id,
            errorJson: deadLetters.errorJson,
            nodeId: deadLetters.nodeId,
            nodeJson: deadLetters.nodeJson,
          })
          .from(deadLetters)
          .innerJoin(runs, eq(runs.id, deadLetters.runId))
          .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
          .where(and(
            eq(deadLetters.orgId, auth.orgId),
            eq(workflowVersions.orgId, auth.orgId),
            eq(workflowVersions.workflowId, workflowId),
            gte(workflowVersions.version, afterVersion),
            gte(deadLetters.createdAt, since),
          ))
          .limit(100);
        const matchingIds: string[] = [];
        for (const row of dlqRows) {
          const nodeJson = row.nodeJson as { type?: string } | null;
          const sig = normalizeErrorSignature(row.errorJson, {
            nodeId: row.nodeId,
            nodeType: nodeJson?.type,
          });
          if (sig.signature === priorFailureSignature) {
            matchingIds.push(row.id);
          }
        }
        sameFailureSinceApply = {
          count: matchingIds.length,
          sampleDeadLetterIds: matchingIds.slice(0, 5),
          // Echo the caller-supplied signature only — never a derived one.
          priorSignature: priorFailureSignature,
        };
      }

      // Prior version availability — drives the regression-rollback
      // affordance in the dialog. We only need {version, versionId}; the
      // dagJson is fetched lazily on button click via /workflows/versions.
      let priorVersion: { version: number; versionId: string } | null = null;
      if (afterVersion > 1) {
        const priorRows = await db
          .select({ version: workflowVersions.version, versionId: workflowVersions.id })
          .from(workflowVersions)
          .where(and(
            eq(workflowVersions.orgId, auth.orgId),
            eq(workflowVersions.workflowId, workflowId),
            eq(workflowVersions.version, afterVersion - 1),
          ))
          .limit(1);
        if (priorRows.length > 0 && priorRows[0]) {
          priorVersion = { version: priorRows[0].version, versionId: priorRows[0].versionId };
        }
      }

      // Delta math — only meaningful with enough samples on the after side.
      const hasEnoughData = afterSignals.totalRuns >= MIN_RUNS_FOR_DELTA;
      let delta: { score: number; p95LatencyMs: number | null; costPerRunUsd: number | null } | null = null;
      if (hasEnoughData) {
        const p95Delta = (afterSignals.p95LatencyMs == null || beforeSignals.p95LatencyMs == null)
          ? null
          : afterSignals.p95LatencyMs - beforeSignals.p95LatencyMs;
        const costPerRunBefore = beforeSignals.totalRuns > 0 ? beforeSignals.totalCostUsd / beforeSignals.totalRuns : null;
        const costPerRunAfter = afterSignals.totalRuns > 0 ? afterSignals.totalCostUsd / afterSignals.totalRuns : null;
        const costDelta = (costPerRunBefore == null || costPerRunAfter == null) ? null : costPerRunAfter - costPerRunBefore;
        delta = {
          score: after.score - before.score,
          p95LatencyMs: p95Delta,
          costPerRunUsd: costDelta,
        };
      }

      return sendJson(res, {
        workflowId,
        afterVersion,
        windowDays,
        hasEnoughData,
        before,
        after,
        delta,
        recentRunsAgainstAfter,
        sameFailureSinceApply,
        priorVersion,
      });
    } },

  { method: "GET", match: (url) => url === "/workflows/health" || url.startsWith("/workflows/health?"), role: "viewer",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const workflowId = url.searchParams.get("workflowId");
      if (!workflowId) return sendJson(res, { error: "workflowId is required" }, 400);

      // Multi-tenant gate: confirm the workflow belongs to the caller's org
      // before doing any work.
      const owned = await db
        .select({ id: workflows.id })
        .from(workflows)
        .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, auth.orgId)))
        .limit(1);
      if (owned.length === 0) return sendJson(res, { error: "Workflow not found" }, 404);

      // Latest version drives the readiness check (the workflow JSON the
      // operator currently saved). Falling back to readiness on the
      // latest snapshot mirrors the dashboard expectation: "what does
      // production look like right now?"
      const latestVersion = await db
        .select({ dagJson: workflowVersions.dagJson })
        .from(workflowVersions)
        .where(and(eq(workflowVersions.orgId, auth.orgId), eq(workflowVersions.workflowId, workflowId)))
        .orderBy(desc(workflowVersions.version))
        .limit(1);
      if (latestVersion.length === 0) {
        return sendJson(res, { error: "Workflow has no versions" }, 404);
      }

      const parsedWorkflow = WorkflowSchema.safeParse(latestVersion[0].dagJson);
      if (!parsedWorkflow.success) {
        return sendJson(res, { error: "Workflow version is malformed" }, 422);
      }
      // Layer rollback-availability on top of the static readiness check
      // so the health rollup's safety dimension counts the same issues
      // /workflows/readiness reports — single-version workflows otherwise
      // score higher on safety in the health badge than the readiness
      // badge admits.
      const baseReadiness = checkWorkflowReadiness(parsedWorkflow.data);
      const rollbackIssues = await checkRollbackAvailability(auth.orgId, workflowId);
      const readiness = mergeReadiness(baseReadiness, rollbackIssues);
      const signals = await collectHealthSignals(auth.orgId, workflowId);
      const health = computeWorkflowHealth({ workflow: parsedWorkflow.data, readiness, signals });
      return sendJson(res, health);
    } },

  // Org-level recovery metrics — composes run status counts, MTTR, p95
  // latency, approvals pending, replay rate, and cost-by-provider into
  // a single rollup the Operations dashboard renders.
  { method: "GET", match: (url) => url === "/recovery/metrics" || url.startsWith("/recovery/metrics?"),
    role: "viewer",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const rawWindow = Number.parseInt(url.searchParams.get("windowDays") ?? "", 10);
      const windowDays = Number.isFinite(rawWindow) ? Math.min(90, Math.max(1, rawWindow)) : 30;
      const signals = await collectRecoveryMetricsSignals(auth.orgId, windowDays);
      const metrics = composeRecoveryMetrics(signals, windowDays);
      return sendJson(res, metrics);
    } },

  // Operator → system feedback channel for the recovery loop. The
  // RecoveryDialog calls this on every decision (Apply / Cancel /
  // Iterate). The row gets read back by `/ai/patch-workflow` on
  // subsequent recoveries for the same workflow (via
  // `summarizePastFeedback` + `composeFeedbackHint`) so the LLM can
  // deprioritize approaches the operator has already rejected.
  // Audited as `recovery.feedback`. Editor role — viewers can't
  // capture their own decisions.
  { method: "POST", match: "/recovery/feedback", role: "editor",
    handler: async ({ req, res, auth }) => {
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: 60_000, max: 120 });
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const parsed = RecoveryFeedbackBodySchema.safeParse(body);
      if (!parsed.success) {
        return sendJson(res, { error: "Invalid feedback body", issues: parsed.error.issues }, 400);
      }
      const dlq = await getDeadLetter(auth.orgId, parsed.data.deadLetterId);
      if (!dlq) return sendJson(res, { error: "DLQ entry not found" }, 404);

      const failingWorkflowJson = dlq.workflowJson as { id?: unknown } | null;
      const workflowId = typeof failingWorkflowJson?.id === "string" ? failingWorkflowJson.id : null;
      if (!workflowId) {
        // Anonymous (ad-hoc) workflows have no aggregation key — the
        // dialog only opens on saved workflows in practice, so this is
        // defensive.
        return sendJson(res, { error: "Feedback is only recorded for saved workflows" }, 422);
      }

      await recordRecoveryFeedback({
        orgId: auth.orgId,
        userId: auth.userId,
        deadLetterId: parsed.data.deadLetterId,
        workflowId,
        suggestionMode: parsed.data.suggestionMode,
        approachLabel: parsed.data.approachLabel,
        accepted: parsed.data.accepted,
        comment: parsed.data.comment ?? null,
      });

      await audit(auth.orgId, auth.userId, "recovery.feedback", "dead_letter", parsed.data.deadLetterId, {
        approachLabel: parsed.data.approachLabel,
        suggestionMode: parsed.data.suggestionMode,
        accepted: parsed.data.accepted,
      });

      return sendJson(res, { ok: true });
    } },

  // AI helpers
  { method: "GET", match: "/ai/health",
    handler: async ({ res, auth }) => sendJson(res, await aiStatus(auth.orgId)) },
  { method: "POST", match: "/ai/generate-workflow",
    handler: async ({ req, res, auth }) => {
      const { orgConfig, llm } = await orgLlmRuntime(auth.orgId);
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: 60_000, max: orgConfig.ai.rateLimitPerMin });
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const promptText = typeof body.prompt === "string" ? body.prompt : "";
      const modelOverride = typeof body.model === "string" ? body.model : undefined;
      if (promptText.length > orgConfig.ai.promptMaxChars) {
        return sendJson(res, { error: `prompt exceeds ${orgConfig.ai.promptMaxChars} characters` }, 413);
      }
      const fallbackWorkflow = fallbackWorkflowForPrompt(promptText);
      if (!llm) {
        return sendJson(res, {
          mode: "fallback",
          ...(fallbackWorkflow ?? {}),
        });
      }
      try {
        // Schema-aware generation. The AI SDK plumbs `WorkflowSchema`
        // through each provider's structured-output capability and validates
        // the response. The shape-coercing `looseAiWorkflow` pre-pass that
        // existed before this is gone — schema enforcement is now real.
        // Failures (LLM emits non-conformant JSON) throw inside the SDK and
        // flow through the existing try/catch into the fallback contract.
        const result = await llm.generateObject<z.infer<typeof AiGenerationWorkflowSchema>>({
          schema: AiGenerationWorkflowSchema,
          schemaName: "JanuslyWorkflow",
          schemaDescription: "Workflow DAG for /ai/generate-workflow.",
          system: GENERATE_WORKFLOW_SYSTEM_PROMPT,
          prompt: promptText,
          modelHint: modelOverride,
          context: { orgId: auth.orgId, userId: auth.userId },
        });
        // Cast: the AI-side discriminated-union node configs are strict
        // subsets of the engine's loose `config: Record<string, unknown>`,
        // so the inferred AI shape structurally satisfies `Workflow`. The
        // post-validation `sanitizeAiWorkflow` re-parses through
        // `WorkflowSchema` so a bad cast can never reach persistence.
        const workflow = sanitizeAiWorkflow(result.object as unknown as Workflow);
        await audit(auth.orgId, auth.userId, "ai.workflow.generated", "ai", workflow.id, { mode: "ai", model: result.model, provider: result.provider });
        return sendJson(res, { mode: "ai", model: result.model, provider: result.provider, ...workflow });
      } catch (err) {
        const message = err instanceof Error ? err.message : "AI request failed";
        await audit(auth.orgId, auth.userId, "ai.workflow.generated", "ai", fallbackWorkflow?.id, { mode: "fallback", error: message });
        return sendJson(res, {
          mode: "fallback",
          aiError: message,
          ...(fallbackWorkflow ?? {}),
        });
      }
    } },
  { method: "POST", match: "/ai/explain-workflow",
    handler: async ({ req, res, auth }) => {
      const { orgConfig, llm } = await orgLlmRuntime(auth.orgId);
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: 60_000, max: orgConfig.ai.rateLimitPerMin });
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const { workflow } = body;
      const modelOverride = typeof body.model === "string" ? body.model : undefined;
      if (!llm) {
        return sendJson(res, {
          mode: "fallback",
          explanation: fallbackExplainWorkflow(workflow),
        });
      }
      try {
        const explainWorkflowId = (workflow && typeof workflow === "object" && "id" in workflow && typeof (workflow as { id?: unknown }).id === "string")
          ? (workflow as { id: string }).id
          : undefined;
        const result = await llm.generateText({
          prompt: `You are a workflow assistant. Explain this DAG clearly with bullet points covering purpose, flow, and any noteworthy nodes:\n${JSON.stringify(workflow, null, 2)}`,
          modelHint: modelOverride,
          context: { orgId: auth.orgId, userId: auth.userId, workflowId: explainWorkflowId },
        });
        await audit(auth.orgId, auth.userId, "ai.workflow.explained", "ai", undefined, { mode: "ai", model: result.model, provider: result.provider });
        return sendJson(res, { mode: "ai", model: result.model, provider: result.provider, explanation: result.text });
      } catch (err) {
        const message = err instanceof Error ? err.message : "AI request failed";
        await audit(auth.orgId, auth.userId, "ai.workflow.explained", "ai", undefined, { mode: "fallback", error: message });
        return sendJson(res, {
          mode: "fallback",
          aiError: message,
          explanation: fallbackExplainWorkflow(workflow),
        });
      }
    } },

  // AI second-pass workflow review. Sister to the deterministic readiness
  // gate at /workflows/readiness — this calls the LLM with a structured-
  // output schema to surface semantic issues rules can't see (ambiguous
  // prompts, PII risk, malformed-but-shape-valid tool inputs). Falls back
  // to the deterministic readiness check when LLM is unavailable so the
  // route always returns useful findings — `mode: "fallback"` flags the
  // source per the AGENTS.md AI-fallback contract.
  { method: "POST", match: "/ai/review-workflow",
    handler: async ({ req, res, auth }) => {
      const { orgConfig, llm } = await orgLlmRuntime(auth.orgId);
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: 60_000, max: orgConfig.ai.rateLimitPerMin });
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const candidate = (body.workflow && typeof body.workflow === "object") ? asRecord(body.workflow) : body;
      const modelOverride = typeof body.model === "string" ? body.model : undefined;
      const parsed = WorkflowSchema.safeParse(candidate);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => ({
          code: "invalid_workflow_shape",
          severity: "fail" as const,
          message: `${issue.path.join(".") || "workflow"}: ${issue.message}`,
          rationale: "The workflow JSON failed structural validation before review could run.",
          suggestion: "Fix the schema-level errors and re-submit.",
        }));
        // Audit even shape-invalid fallbacks — every AI mutation surface
        // must record success AND fallback per the AGENTS.md AI-fallback
        // contract. Without this, "shape invalid" requests leave no
        // operator audit trail.
        await audit(auth.orgId, auth.userId, "ai.workflow.reviewed", "ai", undefined, { mode: "fallback", reason: "invalid_workflow_shape" });
        return sendJson(res, { mode: "fallback", aiError: "Workflow shape invalid", review: { status: "fail", issues } });
      }

      const workflow = parsed.data;
      if (!llm) {
        await audit(auth.orgId, auth.userId, "ai.workflow.reviewed", "ai", workflow.id, { mode: "fallback", reason: "no_llm_configured" });
        return sendJson(res, {
          mode: "fallback",
          review: buildReviewFallback(workflow),
        });
      }

      try {
        const result = await llm.generateObject<ReviewFindings>({
          schema: ReviewFindingsSchema,
          schemaName: "JanuslyWorkflowReview",
          schemaDescription: "Production-readiness review of a Janusly workflow DAG.",
          system: REVIEW_WORKFLOW_SYSTEM_PROMPT,
          prompt: JSON.stringify(workflow),
          modelHint: modelOverride,
          context: { orgId: auth.orgId, userId: auth.userId, workflowId: workflow.id },
        });
        const review = mergeReviewFindings(
          sanitizeAiReview(result.object as ReviewFindings, workflow),
          buildReviewFallback(workflow),
        );
        await audit(auth.orgId, auth.userId, "ai.workflow.reviewed", "ai", workflow.id, {
          mode: "ai",
          model: result.model,
          provider: result.provider,
          totalIssues: review.issues.length,
          blockingCount: review.issues.filter((issue) => issue.severity === "fail").length,
        });
        return sendJson(res, { mode: "ai", model: result.model, provider: result.provider, review });
      } catch (err) {
        const message = err instanceof Error ? err.message : "AI review failed";
        await audit(auth.orgId, auth.userId, "ai.workflow.reviewed", "ai", workflow.id, { mode: "fallback", error: message });
        return sendJson(res, {
          mode: "fallback",
          aiError: message,
          review: buildReviewFallback(workflow),
        });
      }
    } },

  // Failure recovery — suggest workflow patches for a failing DLQ entry.
  // Dispatches to a per-failing-node-type envelope schema that wraps
  // 1-3 config-only suggestions. Each envelope stays a single non-union
  // shape so the LLM call works against both Anthropic (compiled-grammar
  // cap) and OpenAI (strict-mode `oneOf` ban). The route composes each
  // suggested workflow server-side by merging into the original snapshot,
  // then re-validates through the same `WorkflowSchema.safeParse` +
  // `sanitizeAiWorkflow` chain `/ai/generate-workflow` uses. Audits both
  // AI-mode and fallback paths per the AGENTS.md AI-mutation contract.
  { method: "POST", match: "/ai/patch-workflow", role: "editor",
    handler: async ({ req, res, auth }) => {
      const { orgConfig, llm } = await orgLlmRuntime(auth.orgId);
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: 60_000, max: orgConfig.ai.rateLimitPerMin });
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const deadLetterId = typeof body.deadLetterId === "string" ? body.deadLetterId : null;
      if (!deadLetterId) return sendJson(res, { error: "deadLetterId is required" }, 400);

      // Multi-tenant gate via the existing repo helper.
      const dlq = await getDeadLetter(auth.orgId, deadLetterId);
      if (!dlq) return sendJson(res, { error: "DLQ entry not found" }, 404);

      // Recent events around the failure for run context. Multi-tenant
      // scope flows through runs.orgId on the run row.
      const run = await db.select().from(runs).where(eq(runs.id, dlq.runId));
      if (!run[0] || run[0].orgId !== auth.orgId) {
        return sendJson(res, { error: "Run not found" }, 404);
      }
      const events = (await db
        .select({
          type: runEvents.type,
          nodeId: runEvents.nodeId,
          payload: runEvents.payload,
          createdAt: runEvents.createdAt,
        })
        .from(runEvents)
        .where(eq(runEvents.runId, dlq.runId))
        .orderBy(desc(runEvents.createdAt), desc(runEvents.id))
        .limit(RUN_EVENT_PROMPT_CAP)).reverse();

      // Pick the per-type envelope based on the failing node's type.
      // The typed envelopes wrap a `suggestions` array of 1-3 items —
      // single repeated shape, no full-workflow union — so the compiled
      // grammar stays small for Anthropic and the JSON Schema has no
      // `oneOf` keyword (works for OpenAI strict mode too).
      const failingNode = NodeSchema.safeParse(dlq.nodeJson);
      const failingNodeType = failingNode.success ? failingNode.data.type : "unknown";
      const envelope = patchEnvelopeForNodeType(failingNodeType);

      // Tool-typed failures benefit from per-tool field-name hints —
      // the LLM otherwise has to infer required input field names from
      // a possibly-misleading runtime error message. The tool registry's
      // `listTools()` already produces the operator-facing description
      // (`required` / `optional` / `inputExample`); pluck the entry for
      // the failing node's tool and pass it through `extraContext`.
      // Returns undefined for non-tool failures, unknown tools, or
      // failing nodes without a `config.tool` string — the helper
      // omits the field in those cases.
      const toolInputContract = (() => {
        if (envelope.kind !== "tool") return undefined;
        const failingNodeJson = dlq.nodeJson as { config?: { tool?: unknown } } | null;
        const toolName = typeof failingNodeJson?.config?.tool === "string" ? failingNodeJson.config.tool : null;
        if (!toolName) return undefined;
        const entry = listTools().find((tool) => tool.name === toolName);
        if (!entry) return undefined;
        return {
          name: entry.name,
          description: entry.description,
          required: entry.required,
          optional: entry.optional ?? [],
          inputExample: entry.inputExample,
        };
      })();

      // Past-feedback enrichment — the operator → system half of the
      // recovery loop. If the failing workflow has a saved id, look up
      // the operator's recent accept/reject decisions for it and slip
      // a one-line summary into the prompt as soft prior, so the LLM
      // can deprioritize approaches the operator has already rejected.
      // Returns "" for first-time recoveries (no rows match) — the
      // prompt then has the same shape it had pre-enrichment.
      const failingWorkflowJson = dlq.workflowJson as { id?: unknown } | null;
      const failingWorkflowId = typeof failingWorkflowJson?.id === "string" ? failingWorkflowJson.id : null;
      const pastFeedbackSummary = failingWorkflowId
        ? composeFeedbackHint(await summarizePastFeedback(auth.orgId, failingWorkflowId))
        : "";

      const extraContext: Record<string, unknown> = {
        ...(toolInputContract ? { toolInputContract } : {}),
        ...(pastFeedbackSummary ? { pastFeedbackSummary } : {}),
      };

      const helperResult: PatchSuggestion = await suggestWorkflowPatch({
        llm,
        envelopeSchema: envelope.schema,
        workflow: dlq.workflowJson,
        failedNodeId: dlq.nodeId,
        errorJson: safePersistPayload(dlq.errorJson ?? null),
        extraContext: Object.keys(extraContext).length > 0 ? extraContext : undefined,
        context: { orgId: auth.orgId, userId: auth.userId, workflowId: failingWorkflowId ?? undefined },
        // Pass every event payload through the persistence chokepoint
        // before it leaves the API boundary. `safe-persist` was applied at
        // write time which key-redacted known sensitive keys, but free-form
        // value content (e.g. an `http` node's response body) survives
        // verbatim — a re-application here scrubs any nested
        // sensitive-keyed fields that landed inside an inner object since
        // the original write. Defense in depth: never ship the prompt to a
        // remote LLM with un-scrubbed payloads.
        runEvents: events.map((event) => ({
          type: event.type,
          nodeId: event.nodeId ?? null,
          payload: safePersistPayload(event.payload ?? null),
          createdAt: event.createdAt ?? null,
        })),
      });

      // Fan-out merge: each helper-emitted suggestion goes through the
      // strict `WorkflowSchema` + `sanitizeAiWorkflow` chain that the
      // single-suggestion path used. Suggestions that fail validation
      // are dropped without breaking the rest of the batch. Survivors
      // are sorted by confidence desc so the dialog's default tab is
      // the model's most-confident pick.
      type ValidatedSuggestion = {
        workflow: Workflow;
        rationale: string;
        approachLabel: string;
        confidence: number;
      };
      let response: {
        mode: "ai" | "fallback";
        suggestedWorkflow: Workflow | unknown;
        rationale: string;
        suggestions: ValidatedSuggestion[];
        model?: string;
        provider?: string;
        aiError?: string;
      };

      if (helperResult.mode === "ai") {
        const originalParsed = WorkflowSchema.safeParse(dlq.workflowJson);
        const validated: ValidatedSuggestion[] = [];
        if (originalParsed.success) {
          for (const item of helperResult.suggestions) {
            try {
              const merged = applyConfigPatchToWorkflow(originalParsed.data, dlq.nodeId, item.patchedConfig);
              const sanitized = sanitizeAiWorkflow(merged);
              validated.push({
                workflow: sanitized,
                rationale: item.rationale,
                approachLabel: item.approachLabel,
                confidence: item.confidence,
              });
            } catch {
              // Drop this suggestion; keep going. If none survive, the
              // empty-list branch below degrades to fallback.
            }
          }
          validated.sort((a, b) => b.confidence - a.confidence);
        }

        if (validated.length > 0) {
          const top = validated[0]!;
          response = {
            mode: "ai",
            // Back-compat: legacy callers reading these top-level fields
            // see the highest-confidence suggestion's content. The new UI
            // reads the `suggestions` array directly.
            suggestedWorkflow: top.workflow,
            rationale: top.rationale,
            suggestions: validated,
            model: helperResult.model,
            provider: helperResult.provider,
          };
        } else {
          // No suggestion survived validation — degrade to fallback.
          const reason = originalParsed.success
            ? "All AI suggestions failed validation."
            : `Original workflow failed strict schema: ${originalParsed.error.issues[0]?.message ?? "unknown"}`;
          response = {
            mode: "fallback",
            suggestedWorkflow: dlq.workflowJson,
            rationale: `AI returned suggestions that could not be applied safely. The original workflow is unchanged. Reason: ${reason}`,
            suggestions: [{
              workflow: dlq.workflowJson as Workflow,
              rationale: `AI returned suggestions that could not be applied safely. ${reason}`,
              approachLabel: "other",
              confidence: 0,
            }],
            model: helperResult.model,
            provider: helperResult.provider,
            aiError: helperResult.aiError ?? "no_valid_suggestions",
          };
        }
      } else {
        const fallbackItem = helperResult.suggestions[0]!;
        response = {
          mode: "fallback",
          suggestedWorkflow: dlq.workflowJson,
          rationale: fallbackItem.rationale,
          suggestions: [{
            workflow: dlq.workflowJson as Workflow,
            rationale: fallbackItem.rationale,
            approachLabel: fallbackItem.approachLabel,
            confidence: fallbackItem.confidence,
          }],
          model: helperResult.model,
          provider: helperResult.provider,
          aiError: helperResult.aiError,
        };
      }

      await audit(auth.orgId, auth.userId, "ai.workflow.patch_suggested", "dlq", deadLetterId, {
        mode: response.mode,
        model: response.model,
        provider: response.provider,
        aiError: response.aiError,
        envelopeKind: envelope.kind,
        suggestionsCount: response.suggestions.length,
        topApproachLabel: response.suggestions[0]?.approachLabel,
      });

      return sendJson(res, response);
    } },

  // Authoring assistant — suggest 1-3 high-impact improvements to a
  // workflow snapshot the operator is currently reviewing in the
  // Compare panel. Sister to /ai/patch-workflow but operates without a
  // failing-node id and emits FULL workflow snapshots (the diff renderer
  // already handles add/remove/changed rows). The route validates each
  // suggestion through the same `WorkflowSchema.safeParse` +
  // `sanitizeAiWorkflow` chain `/ai/generate-workflow` uses, drops
  // invalid suggestions, sorts survivors by confidence desc, and
  // degrades to fallback when none survive. Audits both AI-mode and
  // fallback paths per the AGENTS.md AI-mutation contract. Read-only
  // by design — the route never mutates workflows; the operator applies
  // a chosen suggestion through the existing /workflows/save flow.
  { method: "POST", match: "/ai/suggest-improvement", role: "editor",
    handler: async ({ req, res, auth }) => {
      const { orgConfig, llm } = await orgLlmRuntime(auth.orgId);
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: 60_000, max: orgConfig.ai.rateLimitPerMin });
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const candidate = (body.workflow && typeof body.workflow === "object") ? asRecord(body.workflow) : body;
      const focus = typeof body.focus === "string" ? body.focus : undefined;
      const modelOverride = typeof body.model === "string" ? body.model : undefined;

      const parsed = WorkflowSchema.safeParse(candidate);
      if (!parsed.success) {
        await audit(auth.orgId, auth.userId, "ai.workflow.improvement_suggested", "ai", undefined, {
          mode: "fallback",
          reason: "invalid_workflow_shape",
        });
        return sendJson(res, {
          mode: "fallback",
          aiError: "Workflow shape invalid",
          suggestions: [],
          rationale: `Workflow failed structural validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
        });
      }

      const workflow = parsed.data;
      const helperResult: SuggestImprovementResult = await suggestWorkflowImprovement({
        llm,
        envelopeSchema: AiSuggestImprovementEnvelope,
        workflow,
        focus,
        model: modelOverride,
        context: { orgId: auth.orgId, userId: auth.userId, workflowId: workflow.id },
      });

      // Fan-out validation: each suggestion's `patchedWorkflowJson` must
      // pass the engine's strict schema and the AI sanitisation chain.
      // Suggestions that fail validation are dropped without breaking
      // the rest of the batch. Survivors are sorted by confidence desc
      // so the dialog's default chip is the model's most-confident pick.
      type ValidatedSuggestion = {
        workflow: Workflow;
        rationale: string;
        approachLabel: string;
        confidence: number;
      };
      let response: {
        mode: "ai" | "fallback";
        suggestedWorkflow: Workflow | unknown;
        rationale: string;
        suggestions: ValidatedSuggestion[];
        model?: string;
        provider?: string;
        aiError?: string;
      };

      if (helperResult.mode === "ai") {
        const validated: ValidatedSuggestion[] = [];
        for (const item of helperResult.suggestions) {
          try {
            // The LLM emits the workflow as a JSON-stringified blob to
            // keep the structured-output schema small enough for
            // Anthropic's compiled-grammar cap; parse + validate +
            // sanitise here. JSON.parse, WorkflowSchema.safeParse, and
            // sanitizeAiWorkflow are all in the try/catch — any failure
            // drops THIS suggestion without breaking the loop.
            const parsedWorkflow = JSON.parse(item.patchedWorkflowJson);
            const reparsed = WorkflowSchema.safeParse(parsedWorkflow);
            if (!reparsed.success) continue;
            const sanitized = sanitizeAiWorkflow(reparsed.data);
            validated.push({
              workflow: sanitized,
              rationale: item.rationale,
              approachLabel: item.approachLabel,
              confidence: item.confidence,
            });
          } catch {
            // Drop this suggestion; keep going. If none survive, the
            // empty-list branch below degrades to fallback.
          }
        }
        validated.sort((a, b) => b.confidence - a.confidence);

        if (validated.length > 0) {
          const top = validated[0]!;
          response = {
            mode: "ai",
            // Back-compat: legacy callers reading these top-level
            // fields see the highest-confidence suggestion. The new UI
            // reads the `suggestions` array directly.
            suggestedWorkflow: top.workflow,
            rationale: top.rationale,
            suggestions: validated,
            model: helperResult.model,
            provider: helperResult.provider,
          };
        } else {
          response = {
            mode: "fallback",
            suggestedWorkflow: workflow,
            rationale: "AI returned suggestions that could not be applied safely. The original workflow is unchanged.",
            suggestions: [{
              workflow,
              rationale: "AI returned suggestions that could not be applied safely. The original workflow is unchanged.",
              approachLabel: "other",
              confidence: 0,
            }],
            model: helperResult.model,
            provider: helperResult.provider,
            aiError: helperResult.aiError ?? "no_valid_suggestions",
          };
        }
      } else {
        const fallbackItem = helperResult.suggestions[0]!;
        response = {
          mode: "fallback",
          suggestedWorkflow: workflow,
          rationale: fallbackItem.rationale,
          suggestions: [{
            workflow,
            rationale: fallbackItem.rationale,
            approachLabel: fallbackItem.approachLabel,
            confidence: fallbackItem.confidence,
          }],
          model: helperResult.model,
          provider: helperResult.provider,
          aiError: helperResult.aiError,
        };
      }

      await audit(auth.orgId, auth.userId, "ai.workflow.improvement_suggested", "ai", workflow.id, {
        mode: response.mode,
        model: response.model,
        provider: response.provider,
        aiError: response.aiError,
        suggestionsCount: response.suggestions.length,
        topApproachLabel: response.suggestions[0]?.approachLabel,
        focusProvided: typeof focus === "string" && focus.trim().length > 0,
      });

      return sendJson(res, response);
    } },

  { method: "POST", match: "/ai/explain-run",
    handler: async ({ req, res, auth }) => {
      const { orgConfig, llm } = await orgLlmRuntime(auth.orgId);
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: 60_000, max: orgConfig.ai.rateLimitPerMin });
      const { runId, question } = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      if (typeof runId !== "string") return sendJson(res, { error: "runId is required" }, 400);
      const questionText = typeof question === "string" ? question : undefined;
      if (questionText && questionText.length > orgConfig.ai.promptMaxChars) {
        return sendJson(res, { error: `question exceeds ${orgConfig.ai.promptMaxChars} characters` }, 413);
      }

      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendJson(res, { error: "Run not found" }, 404);

      // Resolve the workflow id via the same join `getRunMetadata` uses
      // so the recorder can attribute usage rows to the workflow. The
      // join is multi-tenant scoped via the prior `run[0].orgId` check.
      const versionRow = await db
        .select({ workflowId: workflowVersions.workflowId })
        .from(workflowVersions)
        .where(and(eq(workflowVersions.id, run[0].workflowVersionId), eq(workflowVersions.orgId, auth.orgId)));
      const explainRunWorkflowId = versionRow[0]?.workflowId ?? undefined;

      const events = await db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.createdAt));
      const result = await explainRun({
        llm,
        run: run[0],
        events,
        question: questionText,
        context: { orgId: auth.orgId, userId: auth.userId, runId, workflowId: explainRunWorkflowId },
      });
      await audit(auth.orgId, auth.userId, "ai.run.explained", "run", runId, {
        mode: result.mode,
        model: result.model,
        provider: result.provider,
        aiError: result.aiError,
      });
      return sendJson(res, result);
    } },

  // Runs — list + reads
  // NOTE: `/runs` prefix excludes `/run?` so the next entry can claim it.
  // Optional `?workflowId=<id>` filter joins through `workflow_versions` so
  // the caller can scope the listing to one workflow's runs.
  { method: "GET", match: (url) => url.startsWith("/runs") && !url.startsWith("/run?"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const limitParam = Number(url.searchParams.get("limit"));
      const limitValue = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 100;
      const workflowIdFilter = url.searchParams.get("workflowId");

      if (workflowIdFilter) {
        const rows = await db
          .select({
            id: runs.id,
            orgId: runs.orgId,
            workflowVersionId: runs.workflowVersionId,
            status: runs.status,
            inputJson: runs.inputJson,
            outputJson: runs.outputJson,
            parentRunId: runs.parentRunId,
            parentNodeId: runs.parentNodeId,
            traceId: runs.traceId,
            replayMode: runs.replayMode,
            createdBy: runs.createdBy,
            createdAt: runs.createdAt,
          })
          .from(runs)
          .leftJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
          .where(and(
            eq(runs.orgId, auth.orgId),
            or(
              and(
                eq(workflowVersions.orgId, auth.orgId),
                eq(workflowVersions.workflowId, workflowIdFilter),
              ),
              eq(runs.workflowVersionId, workflowIdFilter),
            ),
          ))
          .orderBy(desc(runs.createdAt))
          .limit(limitValue);
        return sendJson(res, rows);
      }

      const rows = await db.select().from(runs).where(eq(runs.orgId, auth.orgId)).orderBy(desc(runs.createdAt)).limit(limitValue);
      return sendJson(res, rows);
    } },
  { method: "GET", match: (url) => url.startsWith("/run?"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const runId = url.searchParams.get("runId");
      if (!runId) return sendJson(res, { error: "runId is required" }, 400);
      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendJson(res, { error: "Forbidden" }, 403);
      const nodes = await db.select().from(runNodes).where(eq(runNodes.runId, runId)).orderBy(asc(runNodes.startedAt), asc(runNodes.nodeId));
      const limit = parseEventsLimit(url.searchParams.get("eventsLimit"), RUN_EVENTS_DEFAULT_LIMIT, RUN_EVENTS_MAX_LIMIT);
      const cursor = parseEventsCursor(url.searchParams.get("eventsCursor"));
      // Composite (createdAt, id) keyset cursor: events sharing exact createdAt
      // (e.g. inserts within one transaction) tie-break on id so pagination
      // always advances and never skips peers.
      const filter = cursor
        ? and(
            eq(runEvents.runId, runId),
            or(
              lt(runEvents.createdAt, cursor.createdAt),
              and(eq(runEvents.createdAt, cursor.createdAt), lt(runEvents.id, cursor.id)),
            ),
          )
        : eq(runEvents.runId, runId);
      const rows = await db
        .select()
        .from(runEvents)
        .where(filter)
        .orderBy(desc(runEvents.createdAt), desc(runEvents.id))
        .limit(limit + 1);
      const page = paginateRunEvents(rows, limit);
      return sendJson(res, { run: run[0], nodes, ...page });
    } },
  { method: "GET", match: (url) => url.startsWith("/status"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const runId = url.searchParams.get("runId");
      if (!runId) return sendJson(res, { error: "runId is required" }, 400);
      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendJson(res, { error: "Forbidden" }, 403);
      const nodes = await db.select().from(runNodes).where(eq(runNodes.runId, runId)).orderBy(asc(runNodes.startedAt), asc(runNodes.nodeId));
      const limit = parseEventsLimit(url.searchParams.get("eventsLimit"), RUN_EVENTS_DEFAULT_LIMIT, RUN_EVENTS_MAX_LIMIT);
      const rows = await db
        .select()
        .from(runEvents)
        .where(eq(runEvents.runId, runId))
        .orderBy(desc(runEvents.createdAt), desc(runEvents.id))
        .limit(limit + 1);
      const page = paginateRunEvents(rows, limit);
      return sendJson(res, { run: run[0], nodes, ...page });
    } },
  { method: "GET", match: (url) => url.startsWith("/events"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const runId = url.searchParams.get("runId");
      if (!runId) return sendJson(res, { error: "runId is required" }, 400);
      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendJson(res, { error: "Forbidden" }, 403);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", ...corsHeaders(res) });
      let lastSeen: Date | null = null;
      let closed = false;
      const tick = async () => {
        if (closed) return;
        const filter = lastSeen
          ? and(eq(runEvents.runId, runId), gt(runEvents.createdAt, lastSeen))
          : eq(runEvents.runId, runId);
        const events = await db.select().from(runEvents).where(filter).orderBy(asc(runEvents.createdAt));
        if (closed) return;
        if (events.length) {
          lastSeen = events[events.length - 1].createdAt ?? lastSeen;
          sendEvent(res, events);
        }
      };
      const interval = setInterval(() => { void tick(); }, 1000);
      void tick();
      req.on("close", () => {
        closed = true;
        clearInterval(interval);
      });
    } },

  // Run lifecycle (start / resume / cancel)
  { method: "POST", match: "/start", role: "editor",
    handler: async ({ req, res, auth }) => {
      // Body shape: either a flat workflow (legacy) or `{ workflow, input }`
      // for typed workflow inputs. The flat form keeps existing callers
      // working; the wrapped form is required when the workflow declares
      // `inputs`.
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const workflow = (body.workflow && typeof body.workflow === "object")
        ? asRecord(body.workflow)
        : body;
      const inputValue = Object.hasOwn(body, "input") ? body.input : {};

      const validation = validateWorkflow(workflow);
      if (!validation.valid) return sendJson(res, { error: "Validation failed", issues: validation.issues }, 400);
      const parsedWorkflow = WorkflowSchema.parse(workflow);

      // Production-mode opt-in gate: when `JANUSLY_PRODUCTION_MODE=true`, the
      // deterministic readiness check runs before `startRun` and rejects
      // fail-level issues with HTTP 422. The check is the same one
      // `/workflows/readiness` exposes, layered with the rollback-availability
      // helper. Dev mode (env unset) keeps the existing behaviour — anything
      // structurally valid runs. Operators that need per-workflow opt-in
      // should set the env in their production deploy and leave it unset
      // locally. Adhoc unsaved workflows skip the rollback check (no
      // workflow_versions rows to count).
      if (process.env.JANUSLY_PRODUCTION_MODE === "true") {
        const baseReadiness = checkWorkflowReadiness(parsedWorkflow);
        const rollbackIssues = await checkRollbackAvailability(auth.orgId, parsedWorkflow.id);
        const readiness = mergeReadiness(baseReadiness, rollbackIssues);
        if (readiness.status === "fail") {
          return sendJson(res, { error: "Workflow not production-ready", readiness }, 422);
        }
      }

      // Track whether this run is for a workflow we've persisted (saved) or
      // an ad-hoc one constructed in the request body. Ad-hoc starts are
      // legitimate (AI Studio "Run" before Save) but operators may want to
      // forbid them per tenant via `runs.requireSavedWorkflow`.
      const { runs: runConfig } = await getOrgConfigSnapshot(auth.orgId);
      const requireSaved = runConfig.requireSavedWorkflow;
      let isAdhoc = true;
      if (typeof parsedWorkflow.id === "string" && parsedWorkflow.id) {
        const owned = await db
          .select({ id: workflows.id })
          .from(workflows)
          .where(and(eq(workflows.id, parsedWorkflow.id), eq(workflows.orgId, auth.orgId)));
        isAdhoc = owned.length === 0;
      }
      if (requireSaved && isAdhoc) {
        return sendJson(res, { error: "Ad-hoc workflows are disabled. Save the workflow first." }, 403);
      }

      try {
        const result = await startRun({
          ...parsedWorkflow,
          input: inputValue,
          orgId: auth.orgId,
          createdBy: auth.userId,
        });
        await audit(auth.orgId, auth.userId, isAdhoc ? "run.started.adhoc" : "run.started", "run", result.runId, {
          workflowId: parsedWorkflow.id,
          adhoc: isAdhoc,
        });
        return sendJson(res, result);
      } catch (err) {
        if (err instanceof WorkflowInputValidationError) {
          return sendJson(res, { error: "Input validation failed", errors: err.errors }, 400);
        }
        throw err;
      }
    } },
  { method: "POST", match: "/resume", role: "editor",
    handler: async ({ req, res, auth }) => {
      const { runId, nodeId } = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      if (typeof runId !== "string" || typeof nodeId !== "string") return sendJson(res, { error: "runId and nodeId are required" }, 400);
      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendJson(res, { error: "Forbidden" }, 403);
      const result = await resumeRun(runId, nodeId);
      await audit(auth.orgId, auth.userId, "run.resumed", "run", runId, { nodeId });
      return sendJson(res, result);
    } },
  // Cancel an in-flight run. Mirrors `/resume`'s shape; `cancelRun`
  // (engine helper) flips run + non-running nodes to "cancelled" and emits a
  // `run.cancelled` event. The worker's running job continues to completion;
  // the cancelled-stays-cancelled rollup absorbs the post-cancel writes.
  { method: "POST", match: "/run/cancel", role: "editor",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const runId = typeof body.runId === "string" ? body.runId : null;
      const reason = body.reason;
      if (!runId) return sendJson(res, { error: "runId is required" }, 400);

      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0]) return sendJson(res, { error: "Run not found" }, 404);
      if (run[0].orgId !== auth.orgId) return sendJson(res, { error: "Forbidden" }, 403);

      if (isTerminalRunStatus(run[0].status)) {
        return sendJson(res, { error: `Run is already ${run[0].status}; cannot cancel` }, 409);
      }

      await cancelRun(runId, reason);
      await audit(auth.orgId, auth.userId, "run.cancelled", "run", runId, { reason });
      return sendJson(res, { runId, status: "cancelled" });
    } },

  // Causal replay
  { method: "GET", match: (url) => url.startsWith("/causal"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const runId = url.searchParams.get("runId");
      const nodeId = url.searchParams.get("nodeId");
      if (!runId || !nodeId) return sendJson(res, { error: "runId and nodeId are required" }, 400);

      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendJson(res, { error: "Forbidden" }, 403);

      const events = await db.select().from(runEvents).where(eq(runEvents.runId, runId));
      const decisionEvent = events.find(event => event.type === "decision.made" && event.nodeId === nodeId);
      if (!decisionEvent) return sendJson(res, { error: "No decision event" }, 404);

      const payload = asRecord(decisionEvent.payload);
      const result = replayDecision({
        chosenNodeId: typeof payload.chosenNodeId === "string" ? payload.chosenNodeId : undefined,
        candidates: decisionCandidatesFromPayload(payload),
        strategy: "auto",
      });

      return sendJson(res, result);
    } },

  // DLQ — cluster rollup must register BEFORE the generic /dlq dispatcher
  // because the registry is first-match-wins; otherwise the wildcard
  // handler below would swallow `/dlq/clusters` requests.
  { method: "GET", match: (url) => url === "/dlq/clusters" || url.startsWith("/dlq/clusters?"), role: "viewer",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const rawWindow = Number.parseInt(url.searchParams.get("windowDays") ?? "", 10);
      const windowDays = Number.isFinite(rawWindow) ? Math.min(90, Math.max(1, rawWindow)) : 30;
      const samples = await collectFailureSamples(auth.orgId, windowDays);
      const clusters = clusterFailureSamples(samples);
      return sendJson(res, { clusters, totalSamples: samples.length, windowDays });
    } },
  // Cluster member listing — feeds the bulk recovery dialog with the
  // bounded list of DLQ ids whose normalized error signature matches a
  // claimed cluster. Registered BEFORE the generic /dlq dispatcher for
  // the same first-match-wins reason as `/dlq/clusters`.
  { method: "GET", match: (url) => url.startsWith("/dlq/cluster-members"), role: "viewer",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const signature = url.searchParams.get("signature");
      if (!signature) return sendJson(res, { error: "signature is required" }, 400);
      const rawWindow = Number.parseInt(url.searchParams.get("windowDays") ?? "", 10);
      const windowDays = Number.isFinite(rawWindow) ? Math.min(90, Math.max(1, rawWindow)) : 30;
      const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit = Number.isFinite(rawLimit) ? rawLimit : CLUSTER_MEMBERS_DEFAULT_LIMIT;
      const result = await findClusterMembers(auth.orgId, signature, windowDays, limit);
      return sendJson(res, { ...result, windowDays });
    } },
  // DLQ
  { method: "GET", match: (url) => url.startsWith("/dlq"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const id = url.searchParams.get("id");
      const status = url.searchParams.get("status");
      const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;

      if (id) {
        const item = await getDeadLetter(auth.orgId, id);
        if (!item) return sendJson(res, { error: "Not found" }, 404);
        return sendJson(res, item);
      }
      if (status && !isDeadLetterStatus(status)) {
        return sendJson(res, { error: "Invalid DLQ status" }, 400);
      }

      return sendJson(res, await listDeadLetters(auth.orgId, status, limit));
    } },
  { method: "POST", match: "/dlq/resolve", role: "editor",
    handler: async ({ req, res, auth }) => {
      const { id } = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      if (typeof id !== "string") return sendJson(res, { error: "id is required" }, 400);

      await markDeadLetterResolved(auth.orgId, id);
      await audit(auth.orgId, auth.userId, "dlq.resolved", "dlq", id);

      return sendJson(res, { ok: true });
    } },
  // Sandbox replay — execute the failing DLQ entry against a proposed
  // workflow patch in a fresh validation run WITHOUT writing a
  // `workflow_versions` row. Recovery dialog calls this between Review
  // and Apply; the production save+replay only fires after the
  // validation run reaches `succeeded`. Validation runs carry
  // `runs.replayMode = "validation"` so they're excluded from health,
  // cluster, and recovery metric rollups, and so the engine's HTTP and
  // tool executors can gate write-side actions via `NodeContext.dryRun`.
  { method: "POST", match: "/dlq/validate-fix", role: "editor",
    handler: async ({ req, res, auth }) => {
      const { orgConfig } = await orgLlmRuntime(auth.orgId);
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: 60_000, max: orgConfig.ai.rateLimitPerMin });
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));

      const deadLetterId = typeof body.deadLetterId === "string" ? body.deadLetterId : null;
      if (!deadLetterId) return sendJson(res, { error: "deadLetterId is required" }, 400);
      const suggestedWorkflow = body.suggestedWorkflow;
      if (!suggestedWorkflow || typeof suggestedWorkflow !== "object") {
        return sendJson(res, { error: "suggestedWorkflow is required" }, 400);
      }

      const item = await getDeadLetter(auth.orgId, deadLetterId);
      if (!item) return sendJson(res, { error: "DLQ entry not found" }, 404);

      // Validate the proposed workflow through the same grammar gate
      // `/ai/patch-workflow` runs on its output: strict schema parse +
      // expression-grammar sanitization. Reject early so the validation
      // run can't be seeded with a malformed DAG.
      const parsed = WorkflowSchema.safeParse(suggestedWorkflow);
      if (!parsed.success) {
        return sendJson(res, {
          error: `suggestedWorkflow failed schema validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
        }, 400);
      }
      let sanitized: Workflow;
      try {
        sanitized = sanitizeAiWorkflow(parsed.data);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return sendJson(res, { error: `suggestedWorkflow sanitize failed: ${reason}` }, 400);
      }

      const failingNode = sanitized.nodes.find((n) => n.id === item.nodeId);
      if (!failingNode) {
        return sendJson(res, {
          error: `suggestedWorkflow does not contain the failing node id "${item.nodeId}"`,
        }, 400);
      }

      const { runId } = await dlqReplay.replayDeadLetterAsValidation({
        orgId: auth.orgId,
        originalRunId: item.runId,
        suggestedWorkflow: sanitized,
        failingNode,
        createdBy: auth.userId,
      });

      await audit(auth.orgId, auth.userId, "recovery.validation_started", "dlq", deadLetterId, {
        validationRunId: runId,
      });

      return sendJson(res, { runId });
    } },
  // Bulk recovery apply — replay up to 100 DLQ entries that share a
  // cluster signature, in series, after the operator has approved the
  // patch and the sandbox gate has passed on the representative entry.
  // Each row is re-validated against the claimed signature server-side
  // so a stale member list (some rows replayed via another path between
  // fetch and apply) doesn't sneak through. Each replayed row gets a
  // `recovery.cluster_apply` audit row tagged with the cluster signature
  // and its sequence index in the batch.
  { method: "POST", match: "/dlq/cluster-apply", role: "editor",
    handler: async ({ req, res, auth }) => {
      const { orgConfig } = await orgLlmRuntime(auth.orgId);
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: 60_000, max: orgConfig.ai.rateLimitPerMin });
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));

      const clusterSignature = typeof body.clusterSignature === "string" ? body.clusterSignature : null;
      if (!clusterSignature) return sendJson(res, { error: "clusterSignature is required" }, 400);
      const idsRaw = body.deadLetterIds;
      if (!Array.isArray(idsRaw) || idsRaw.length === 0) {
        return sendJson(res, { error: "deadLetterIds is required and must be a non-empty array" }, 400);
      }
      if (idsRaw.length > CLUSTER_MEMBERS_MAX_LIMIT) {
        return sendJson(res, {
          error: `deadLetterIds exceeds the per-request cap of ${CLUSTER_MEMBERS_MAX_LIMIT}`,
        }, 400);
      }
      const deadLetterIds: string[] = [];
      for (const candidate of idsRaw) {
        if (typeof candidate !== "string" || candidate.length === 0) {
          return sendJson(res, { error: "deadLetterIds must contain non-empty strings" }, 400);
        }
        deadLetterIds.push(candidate);
      }

      const errors: Array<{ deadLetterId: string; error: string }> = [];
      let replayed = 0;
      const totalInCluster = deadLetterIds.length;

      for (let i = 0; i < deadLetterIds.length; i += 1) {
        const id = deadLetterIds[i]!;
        const item = await getDeadLetter(auth.orgId, id);
        if (!item) {
          errors.push({ deadLetterId: id, error: "DLQ entry not found" });
          continue;
        }
        if (item.status !== "open") {
          errors.push({ deadLetterId: id, error: `DLQ entry already ${item.status}` });
          continue;
        }
        if (!recheckSignature(item, clusterSignature)) {
          errors.push({ deadLetterId: id, error: "DLQ entry signature no longer matches the claimed cluster" });
          continue;
        }

        try {
          await dlqReplay.replayDeadLetter({
            runId: item.runId,
            workflow: WorkflowSchema.parse(item.workflowJson),
            node: NodeSchema.parse(item.nodeJson),
          });
          await markDeadLetterReplayed(auth.orgId, id);
          await audit(auth.orgId, auth.userId, "recovery.cluster_apply", "dlq", id, {
            clusterSignature,
            sequenceIndex: i,
            totalInCluster,
          });
          replayed += 1;
        } catch (err) {
          errors.push({
            deadLetterId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return sendJson(res, { replayed, failed: errors.length, errors });
    } },
  { method: "POST", match: "/dlq/replay", role: "editor",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));

      if (typeof body.deadLetterId === "string") {
        const item = await getDeadLetter(auth.orgId, body.deadLetterId);
        if (!item) return sendJson(res, { error: "Not found" }, 404);

        await dlqReplay.replayDeadLetter({
          runId: item.runId,
          workflow: WorkflowSchema.parse(item.workflowJson),
          node: NodeSchema.parse(item.nodeJson),
        });

        await markDeadLetterReplayed(auth.orgId, body.deadLetterId);
        await audit(auth.orgId, auth.userId, "dlq.replayed", "dlq", body.deadLetterId);

        return sendJson(res, { ok: true });
      }

      const { runId, nodeId } = body;
      if (typeof runId !== "string" || typeof nodeId !== "string") return sendJson(res, { error: "runId and nodeId are required" }, 400);

      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendJson(res, { error: "Forbidden" }, 403);

      const version = await db.select().from(workflowVersions).where(eq(workflowVersions.id, run[0].workflowVersionId));
      if (!version[0] || version[0].orgId !== auth.orgId) return sendJson(res, { error: "Workflow version not found" }, 404);

      const workflow = WorkflowSchema.parse(version[0].dagJson);
      const node = workflow.nodes.find(candidate => candidate.id === nodeId);
      if (!node) return sendJson(res, { error: "Node not found in workflow" }, 404);

      await dlqReplay.replayDeadLetter({ runId, workflow, node });
      await audit(auth.orgId, auth.userId, "dlq.replayed", "run", runId, { nodeId });

      return sendJson(res, { ok: true });
    } },
];

const server = http.createServer(async (req, res) => {
  (res as CorsAwareResponse).requestOrigin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(res));
    return res.end();
  }

  try {
    const url = req.url ?? "";
    const matched = routes.find((route) => route.method === req.method && matchesRoute(route.match, url));

    if (!matched) {
      return sendJson(res, { error: "Not found" }, 404);
    }

    let auth: AuthContext;
    if (matched.skipAuth) {
      // Only `/health` opts out; its handler doesn't read `auth`.
      auth = undefined as unknown as AuthContext;
    } else {
      auth = await requireAuth(req);
      if (matched.role) {
        await requireRole(auth.orgId, auth.userId, matched.role, auth.mode);
      }
    }

    await matched.handler({ req, res: res as CorsAwareResponse, auth });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    const statusCode = err && typeof err === "object" && "statusCode" in err ? Number((err as { statusCode?: number }).statusCode) : 500;
    return sendJson(res, { error: message }, statusCode || 500);
  }
});

await assertMigrationsApplied();

// Register the usage_events writer once at boot. Every LLM client call fires
// it fire-and-forget through the provider-neutral AI package.
setUsageRecorder(recordUsage);

// Inject the Redis-backed rate limiter into the engine for write-side
// tools (today: `email.send`). The engine can't import from `apps/api`
// directly without inverting the dependency graph; this DI seam is the
// bridge. Adapter shape: the engine signs `(bucket, orgId, options)`
// while `enforceRateLimit` expects `(key, { name, windowMs, max })` —
// the bucket name namespaces the Redis key, `orgId` is the per-tenant
// counter key. Same fail-open Redis-blip behavior as the LLM rate gate.
setEngineRateLimiter(async (bucket, orgId, options) => {
  await enforceRateLimit(orgId, { name: bucket, windowMs: options.windowMs, max: options.max });
});

// Mirror of `setUsageRecorder` for the `email.send` tool. Every send
// (success OR failure) writes a `usage_events` row with `metric:
// "email.sent"`, surfacing in the existing breakdown UI without
// changes.
setEmailUsageRecorder(recordEmailUsage);

server.listen(PORT, () => console.log(`API running on port ${PORT}`));
