/**
 * Janusly API — plain Node `http.createServer` with a typed route registry.
 * No Express, no Fastify, no tRPC (the tRPC stub is intentionally deleted
 * per AGENTS.md; don't reintroduce it).
 *
 * Boot sequence:
 *   1. `assertMigrationsApplied()` — fail-fast on an unmigrated DB.
 *   2. Per-request: route registry match → `requireAuth` → route-declared
 *      `requireRole` → handler.
 *   3. AI surfaces route through the provider-neutral `getLlmClient()` from
 *      `@janusly/ai` and wrap the call in try/catch, degrading to
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
import "@janusly/engine/src/subworkflow";
import { getUsageSummary } from "@janusly/engine/src/billing";
import { DLQReplayAdapter } from "@janusly/engine/src/adapters/dlq-replay";
import { explainRun, getLlmClient, resolveLlmConfig, setUsageRecorder } from "@janusly/ai";
import { recordUsage } from "@janusly/data/src/usageRepo";
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
} from "@janusly/db";
import { eq, desc, asc, and, gt, lt, or } from "drizzle-orm";
import { NodeSchema, WorkflowSchema, type Workflow } from "@janusly/shared";
import { isTerminalRunStatus } from "@janusly/shared/src/status";
import {
  getDeadLetter,
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
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 30_000);
const OPENAI_MAX_RETRIES = Number(process.env.OPENAI_MAX_RETRIES || 2);
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const AI_PROMPT_MAX_CHARS = Number(process.env.AI_PROMPT_MAX_CHARS || 4_000);
const AI_RATE_LIMIT_PER_MIN = Number(process.env.AI_RATE_LIMIT_PER_MIN || 30);
const AUDIT_PAGE_SIZE = 100;
const RUN_EVENTS_DEFAULT_LIMIT = 200;
const RUN_EVENTS_MAX_LIMIT = 500;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  "Node types and required config:",
  "- http: { url:string, method?:'GET'|'POST'|..., headers?:object, body?:object }",
  "- noop: {} (good for explicit start/end markers)",
  "- transform: { mapping: object } — value templates may reference {{context.<nodeId>.output.<field>}}",
  "- condition: { expression: string } — expression must use the limited grammar in `edges[].condition` below",
  "- webhook: {} (waits for external resume)",
  "- approval: { message?: string } (waits for human approval)",
  "- ai: { prompt: string, model?: string }",
  "- tool: { tool: 'http.request'|'text.uppercase'|'text.lowercase'|'text.trim'|'text.replace'|'text.regex'|'json.pick'|'json.set'|'json.merge'|'json.jq'|'csv.parse'|'csv.stringify'|'csv.filter'|'time.now'|'time.parse'|'time.format'|'time.diff'|'time.add'|'crypto.sha256'|'crypto.hmac'|'crypto.uuid', input: object }",
  "- agent: { goal: string, planner?: 'rules'|'openai', maxSteps?: number, value?: string }",
  "- multi_agent: { goal: string, mode?: 'sequential'|'parallel', agents: Array<{name,role,goal,persona?}>, reflection?: boolean }",
  "- agent_reflection: { input?: any }",
  "- loop: { items: string|array, mapping?: object }",
  "- router: { candidates: Array<{id, scoreFn?: string}>, strategy?: 'cheapest'|'fastest'|'balanced'|'auto' }",
  "- router_llm: { candidates: Array<{id}> }",
  "- subworkflow: { workflowId: string, input?: object } (calls another saved workflow; child outputs become this node's output. Multi-tenant: child must be in the same org. Recursion guard: depth limit JANUSLY_MAX_SUBWORKFLOW_DEPTH, default 5.)",
  "- wait_until: { duration: string } (ISO 8601 duration; pauses the run until the deadline elapses, e.g. \"P3D\" = 3 days, \"PT2H30M\" = 2.5 hours. Output is empty {}.)",
  "edges[].condition grammar (optional, leave it out unless you really need branching):",
  "  - boolean literals: true / false",
  "  - numbers, single/double-quoted strings, null",
  "  - paths starting with `context.` or `inputs.` (e.g. context.fetch.output.statusCode)",
  "  - comparisons: ===, !==, ==, !=, >, <, >=, <=",
  "  - boolean composition: &&, ||, !, parentheses",
  "  - INVALID: bare identifiers (e.g. risk_is_high), function calls, string concatenation, regex.",
  "If you can't express a condition with this grammar, omit `condition` and route via a `condition` or `router` node instead.",
  "Pick 2–6 nodes for most prompts. Prefer the simplest valid DAG.",
].join("\n");

function aiStatus() {
  // The provider abstraction (`packages/ai/src/llm-client.ts`) reads the env
  // directly; this surface keeps the legacy field names (`enabled`, `model`)
  // for back-compat while reflecting whichever provider/model is currently
  // active for default, no-override calls.
  const requestedProvider = (process.env.JANUSLY_LLM_PROVIDER ?? "openai").toLowerCase();
  const cfg = resolveLlmConfig(process.env);
  const provider = cfg?.provider ?? (requestedProvider === "anthropic" ? "anthropic" : "openai");
  const model =
    cfg?.defaultModels[provider] ??
    (provider === "anthropic" ? process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5" : OPENAI_MODEL);
  return {
    enabled: Boolean(cfg?.apiKeys[provider]),
    provider,
    model,
    timeoutMs: OPENAI_TIMEOUT_MS,
    maxRetries: OPENAI_MAX_RETRIES,
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

const SENSITIVE_AUDIT_KEYS = /^(secret|password|token|api[_-]?key|authorization|cookie|x-api-key|client[_-]?secret|private[_-]?key)$/i;

function redactAuditMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuditMetadata);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SENSITIVE_AUDIT_KEYS.test(key) ? "[redacted]" : redactAuditMetadata(item),
      ]),
    );
  }
  return value;
}

async function audit(orgId: string, userId: string, action: string, targetType?: string, targetId?: string, metadata: unknown = {}) {
  try {
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      orgId,
      userId,
      action,
      targetType,
      targetId,
      metadata: redactAuditMetadata(metadata),
    });
  } catch (error) {
    console.warn("audit write failed", error);
  }
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
  { method: "GET", match: "/billing/usage",
    handler: async ({ res, auth }) => sendJson(res, await getUsageSummary(auth.orgId)) },

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
      const workflowId = parsedWorkflow.id ?? crypto.randomUUID();
      const workflowName = parsedWorkflow.name ?? workflowId;
      const versionId = crypto.randomUUID();

      // Atomic so we never end up with a workflow row missing its first version
      // or a version row pointing at a non-existent workflow.
      const { nextVersion } = await db.transaction(async (tx) => {
        const existingVersions = await tx.select().from(workflowVersions)
          .where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.orgId, auth.orgId)))
          .orderBy(desc(workflowVersions.version));
        const nextVersion = (existingVersions[0]?.version ?? 0) + 1;

        const existingWorkflow = await tx.select().from(workflows)
          .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, auth.orgId)));
        if (existingWorkflow[0]) {
          if (existingWorkflow[0].name !== workflowName) {
            await tx.update(workflows).set({ name: workflowName })
              .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, auth.orgId)));
          }
        } else {
          await tx.insert(workflows).values({ id: workflowId, orgId: auth.orgId, name: workflowName, createdBy: auth.userId });
        }

        await tx.insert(workflowVersions).values({
          id: versionId,
          orgId: auth.orgId,
          workflowId,
          version: nextVersion,
          dagJson: { ...parsedWorkflow, id: workflowId, name: workflowName },
          createdBy: auth.userId,
        });

        return { nextVersion };
      });

      await audit(auth.orgId, auth.userId, "workflow.saved", "workflow", workflowId, { version: nextVersion });
      return sendJson(res, { workflowId, versionId, version: nextVersion });
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

  // AI helpers
  { method: "GET", match: "/ai/health",
    handler: async ({ res }) => sendJson(res, aiStatus()) },
  { method: "POST", match: "/ai/generate-workflow",
    handler: async ({ req, res, auth }) => {
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: 60_000, max: AI_RATE_LIMIT_PER_MIN });
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const promptText = typeof body.prompt === "string" ? body.prompt : "";
      const modelOverride = typeof body.model === "string" ? body.model : undefined;
      if (promptText.length > AI_PROMPT_MAX_CHARS) {
        return sendJson(res, { error: `prompt exceeds ${AI_PROMPT_MAX_CHARS} characters` }, 413);
      }
      const llm = getLlmClient();
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
        const result = await llm.generateObject<Workflow>({
          schema: WorkflowSchema,
          schemaName: "JanuslyWorkflow",
          schemaDescription: "Workflow DAG for /ai/generate-workflow.",
          system: GENERATE_WORKFLOW_SYSTEM_PROMPT,
          prompt: promptText,
          modelHint: modelOverride,
          context: { orgId: auth.orgId, userId: auth.userId },
        });
        const workflow = sanitizeAiWorkflow(result.object);
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
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: 60_000, max: AI_RATE_LIMIT_PER_MIN });
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const { workflow } = body;
      const modelOverride = typeof body.model === "string" ? body.model : undefined;
      const llm = getLlmClient();
      if (!llm) {
        return sendJson(res, {
          mode: "fallback",
          explanation: fallbackExplainWorkflow(workflow),
        });
      }
      try {
        const result = await llm.generateText({
          prompt: `You are a workflow assistant. Explain this DAG clearly with bullet points covering purpose, flow, and any noteworthy nodes:\n${JSON.stringify(workflow, null, 2)}`,
          modelHint: modelOverride,
          context: { orgId: auth.orgId, userId: auth.userId },
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
  { method: "POST", match: "/ai/explain-run",
    handler: async ({ req, res, auth }) => {
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: 60_000, max: AI_RATE_LIMIT_PER_MIN });
      const { runId, question } = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      if (typeof runId !== "string") return sendJson(res, { error: "runId is required" }, 400);
      const questionText = typeof question === "string" ? question : undefined;
      if (questionText && questionText.length > AI_PROMPT_MAX_CHARS) {
        return sendJson(res, { error: `question exceeds ${AI_PROMPT_MAX_CHARS} characters` }, 413);
      }

      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendJson(res, { error: "Run not found" }, 404);

      const events = await db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.createdAt));
      const result = await explainRun({
        llm: getLlmClient(),
        run: run[0],
        events,
        question: questionText,
        context: { orgId: auth.orgId, userId: auth.userId, runId },
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
  { method: "GET", match: (url) => url.startsWith("/runs") && !url.startsWith("/run?"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const limitParam = Number(url.searchParams.get("limit"));
      const limitValue = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 100;
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

      // Track whether this run is for a workflow we've persisted (saved) or
      // an ad-hoc one constructed in the request body. Ad-hoc starts are
      // legitimate (AI Studio "Run" before Save) but operators may want to
      // forbid them in production via JANUSLY_REQUIRE_SAVED_WORKFLOW=true.
      const requireSaved = process.env.JANUSLY_REQUIRE_SAVED_WORKFLOW === "true";
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

  // DLQ
  { method: "GET", match: (url) => url.startsWith("/dlq"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const id = url.searchParams.get("id");
      const status = url.searchParams.get("status");

      if (id) {
        const item = await getDeadLetter(auth.orgId, id);
        if (!item) return sendJson(res, { error: "Not found" }, 404);
        return sendJson(res, item);
      }

      return sendJson(res, await listDeadLetters(auth.orgId, status));
    } },
  { method: "POST", match: "/dlq/resolve", role: "editor",
    handler: async ({ req, res, auth }) => {
      const { id } = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      if (typeof id !== "string") return sendJson(res, { error: "id is required" }, 400);

      await markDeadLetterResolved(auth.orgId, id);
      await audit(auth.orgId, auth.userId, "dlq.resolved", "dlq", id);

      return sendJson(res, { ok: true });
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

// Register the usage_events writer once at boot. Every LLM call
// through `getLlmClient().generateText(...)` fires it fire-and-forget.
setUsageRecorder(recordUsage);

server.listen(PORT, () => console.log(`API running on port ${PORT}`));
