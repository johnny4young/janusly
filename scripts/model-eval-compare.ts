/*
 * model-eval-compare.ts — isolated cross-provider model comparison for /ai/generate-workflow.
 *
 * Runs the REAL generation pipeline (Pass1 -> promoteNoopPlaceholders -> sanitizeAiWorkflow
 * -> validateWorkflow) against the repo's own complex eval prompts, across 6 configs:
 *   A haiku           — constrained structured output via LlmClient (legacy path)
 *   B sonnet          — constrained structured output via LlmClient
 *   C haiku-think     — Anthropic Messages API direct (fetch), extended thinking ON, FREE-JSON
 *                       (thinking is incompatible with forced structured output on Anthropic)
 *   D haiku-free      — Anthropic Messages API direct (fetch), no thinking, FREE-JSON
 *                       (isolates the "no constrained decoding" penalty from the thinking benefit)
 *   E gpt4o-mini-free — OpenAI free-JSON through the PRODUCTION LlmClient.generateText path
 *                       (responseFormat:"json" -> applyJsonMode wrap), i.e. the exact wire path
 *                       a tenant with ai.provider=openai would exercise
 *   F gpt41-mini-free — same path, one model tier up
 *
 * A blind Sonnet judge scores each final workflow (same judge for every provider, so the
 * quality numbers are comparable across providers). No ship code is modified.
 * Run: pnpm --filter @janusly/api exec tsx ../../scripts/model-eval-compare.ts
 * Env: SMOKE=1 -> 1 prompt, constrained-haiku + free-haiku + gpt4o-mini-free (validates all
 *      three code paths cheaply); SAMPLES=N; ONLY=key[,key...] (with ONLY set, SMOKE only
 *      trims the prompt list — ONLY picks the configs);
 *      PROMPT_SET=base|complex|all (base = the original 10 prompts, complex = 6 harder
 *      multi-stage business cases, all = 16).
 *      ANTHROPIC_API_KEY is always required (judge); OPENAI_API_KEY only when an OpenAI
 *      config is in the selected set.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createLlmClient, resolveLlmConfig, promoteNoopPlaceholders, type LlmClient } from "@janusly/ai";
import { AiGenerationWorkflowSchema, AiGenerationWorkflowSchemaFreeJson } from "../apps/api/src/ai-schemas";
import { GENERATE_WORKFLOW_SYSTEM_PROMPT, composeGenerationSystemPrompt } from "../apps/api/src/ai-prompts";
import { sanitizeAiWorkflow } from "../apps/api/src/ai-runtime";

// ---- .env loader (dotenv isn't resolvable under this filter) ----
function loadEnv(path: string): void {
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}
loadEnv(new URL("../.env", import.meta.url).pathname);

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const ANTHROPIC_VERSION = "2023-06-01";
if (!ANTHROPIC_KEY) {
  // Always required: the blind judge runs on Anthropic even for OpenAI configs.
  console.error("ANTHROPIC_API_KEY missing after .env load");
  process.exit(1);
}

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-6";
const GPT4O_MINI = "gpt-4o-mini";
const GPT41_MINI = "gpt-4.1-mini";
const GPT4O = "gpt-4o";
const GPT41 = "gpt-4.1";
const GPT54_MINI = "gpt-5.4-mini";
const GPT54_NANO = "gpt-5.4-nano";
// Per-1M-token USD rates; keep in sync with packages/shared/src/llm-pricing.ts.
// gpt-5.4-* are reasoning models — reasoning tokens bill as output tokens, so
// the measured $/run can exceed what the nominal rate suggests.
const PRICE: Record<string, { in: number; out: number }> = {
  [HAIKU]: { in: 1.0, out: 5.0 },
  [SONNET]: { in: 3.0, out: 15.0 },
  [GPT4O_MINI]: { in: 0.15, out: 0.6 },
  [GPT41_MINI]: { in: 0.4, out: 1.6 },
  [GPT4O]: { in: 2.5, out: 10.0 },
  [GPT41]: { in: 2.0, out: 8.0 },
  [GPT54_MINI]: { in: 0.75, out: 4.5 },
  [GPT54_NANO]: { in: 0.2, out: 1.25 },
};
function costUsd(model: string, inTok: number, outTok: number): number {
  const p = PRICE[model] ?? { in: 0, out: 0 };
  return (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
}

type Config = {
  key: string;
  label: string;
  /** Registry key in packages/ai PROVIDERS; drives the modelHint prefix + key guard. */
  provider: "anthropic" | "openai";
  model: string;
  mode: "constrained" | "freejson";
  thinking: boolean;
};
const ALL_CONFIGS: Config[] = [
  { key: "haiku", label: "Haiku 4.5 (constrained)", provider: "anthropic", model: HAIKU, mode: "constrained", thinking: false },
  { key: "sonnet", label: "Sonnet 4.6 (constrained)", provider: "anthropic", model: SONNET, mode: "constrained", thinking: false },
  { key: "haiku-think", label: "Haiku 4.5 +thinking (free-JSON)", provider: "anthropic", model: HAIKU, mode: "freejson", thinking: true },
  { key: "haiku-free", label: "Haiku 4.5 (free-JSON, no think)", provider: "anthropic", model: HAIKU, mode: "freejson", thinking: false },
  { key: "gpt4o-mini-free", label: "GPT-4o-mini (free-JSON, prod path)", provider: "openai", model: GPT4O_MINI, mode: "freejson", thinking: false },
  { key: "gpt41-mini-free", label: "GPT-4.1-mini (free-JSON, prod path)", provider: "openai", model: GPT41_MINI, mode: "freejson", thinking: false },
  { key: "sonnet-free", label: "Sonnet 4.6 (free-JSON, no think)", provider: "anthropic", model: SONNET, mode: "freejson", thinking: false },
  { key: "gpt4o-free", label: "GPT-4o (free-JSON, prod path)", provider: "openai", model: GPT4O, mode: "freejson", thinking: false },
  { key: "gpt41-free", label: "GPT-4.1 (free-JSON, prod path)", provider: "openai", model: GPT41, mode: "freejson", thinking: false },
  { key: "gpt54-mini-free", label: "GPT-5.4-mini (free-JSON, prod path)", provider: "openai", model: GPT54_MINI, mode: "freejson", thinking: false },
  { key: "gpt54-nano-free", label: "GPT-5.4-nano (free-JSON, prod path)", provider: "openai", model: GPT54_NANO, mode: "freejson", thinking: false },
];

type EvalPrompt = { id: string; text: string };
const ALL_PROMPTS: EvalPrompt[] = [
  { id: "customer-escalation", text: "Take a customer complaint, classify its severity with AI, and route to a Slack ping for low, a GitHub issue plus Slack for medium, or a human reviewer plus a GitHub issue and an urgent Slack alert for high" },
  { id: "lead-enrichment", text: "Receive a marketing-form lead, score and enrich it with AI, and route qualified leads to Slack plus a welcome email, unqualified leads to a nurture email" },
  { id: "refund-triage", text: "Receive a refund request, summarize the claim with AI, pause for human approval, then call the billing system over a signed webhook and email the customer the confirmation" },
  { id: "ai-support-draft", text: "A customer support ticket comes in; have AI draft a reply, let a human agent edit and approve the draft, then send the final reply by email" },
  { id: "churn-digest", text: "Every Monday at 9am, fetch at-risk users from an analytics endpoint, rank them with AI, and post a digest to a customer-success Slack channel" },
  { id: "monthly-report-pdf", text: "On the first of each month at 9am, fetch our monthly metrics from an analytics endpoint, have AI summarize the top movers, generate a PDF, and email it to the operations team" },
  { id: "multi-agent-decision", text: "Receive a webhook with a proposal, run three agents that debate it — optimist, skeptic, and arbiter — and email the final recommendation" },
  { id: "webhook-then-followup", text: "Wait for an external webhook, then call our internal API to record the event" },
  { id: "bulk-classify-loop", text: "Receive a webhook with a batch of customers, loop over them to normalize each to a summary line, have AI classify the entire batch by upgrade likelihood, and email the digest to the customer-success team" },
  { id: "failed-workflow-recovery", text: "Receive a webhook with a customer and amount, call our internal billing API to charge them, then email the customer the confirmation. We want this workflow to be safely recoverable when the billing API is misconfigured." },
];

// Harder, production-shaped business cases: multi-stage orchestration mixing
// fork/join, conditional approval, human_form, loop, schedule, wait, and
// multi-agent — the node families where cheaper models historically lose
// judge points. Selected via PROMPT_SET=complex|all (default: base set only,
// so prior sweep numbers stay comparable).
const COMPLEX_PROMPTS: EvalPrompt[] = [
  { id: "order-dispute-resolution", text: "When a payment dispute webhook arrives, fetch the order history from our commerce API, have AI classify liability, then in parallel compute the refund amount and run an AI fraud screen; once both finish, require finance approval for amounts over $200, call the billing system over a signed webhook, email the customer the outcome, and post a summary to the finance Slack channel" },
  { id: "employee-onboarding", text: "When HR submits a new-hire intake form, create accounts in our identity, payroll, and project-tracker systems in parallel; after all three succeed, have AI draft a personalized 30-60-90 onboarding plan, email it to the hiring manager, post a welcome message to Slack, and schedule a 30-day check-in" },
  { id: "invoice-reconciliation", text: "Every weeknight at 2am, fetch unpaid invoices from our ERP, loop over each one matching it against bank payments via API, have AI classify any discrepancies by root cause, route mismatches over $1,000 to a human reviewer, auto-resolve the small ones via the ERP API, and email a reconciliation digest to the controller" },
  { id: "vendor-risk-review", text: "Given a vendor name and website, have an agent gather public information about the company, summarize security and financial risk with AI, then route by risk tier: high risk opens a GitHub issue and requires a human decision, medium risk emails procurement, low risk just records the assessment" },
  { id: "churn-rescue", text: "When a subscription cancellation webhook fires, fetch the customer's usage history, have AI pick a personalized retention offer, require manager approval when the discount exceeds 20%, email the offer, wait three days, and if a follow-up webhook hasn't confirmed acceptance send a final offer and notify customer success in Slack" },
  { id: "incident-postmortem", text: "After an incident-resolved webhook from our paging system, fetch the incident timeline from the status API, run three agents — an investigator, a writer, and a reviewer — to produce a postmortem, generate it as a PDF, create a GitHub issue with the action items, and schedule a 7-day follow-up review" },
];

const SMOKE = Boolean(process.env.SMOKE);
const SAMPLES = Math.max(1, Number(process.env.SAMPLES ?? 1));
const ONLY = (process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const SMOKE_KEYS = new Set(["haiku", "haiku-free", "gpt4o-mini-free"]);
// With an explicit ONLY, SMOKE just trims the prompt list — the caller picked
// the configs; intersecting with SMOKE_KEYS would silently produce zero cells.
const CONFIGS =
  ONLY.length > 0
    ? ALL_CONFIGS.filter((c) => ONLY.includes(c.key))
    : SMOKE
      ? ALL_CONFIGS.filter((c) => SMOKE_KEYS.has(c.key))
      : ALL_CONFIGS;
// PROMPT_SET: base (default, the original 10) | complex (the 6 hard cases) | all (16).
// PROMPT_ONLY: comma-separated prompt ids — narrows further (e.g. to resume a
// partially-killed sweep or iterate on one case).
const PROMPT_SET = (process.env.PROMPT_SET ?? "base").toLowerCase();
const PROMPT_ONLY = (process.env.PROMPT_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const ACTIVE_PROMPTS = (
  PROMPT_SET === "complex" ? COMPLEX_PROMPTS : PROMPT_SET === "all" ? [...ALL_PROMPTS, ...COMPLEX_PROMPTS] : ALL_PROMPTS
).filter((p) => PROMPT_ONLY.length === 0 || PROMPT_ONLY.includes(p.id));
const PROMPTS = SMOKE ? ACTIVE_PROMPTS.slice(0, 1) : ACTIVE_PROMPTS;
// Set-scoped guard: an Anthropic-only selection must not demand the OpenAI key.
if (CONFIGS.some((c) => c.provider === "openai") && !OPENAI_KEY) {
  console.error(
    `OPENAI_API_KEY missing after .env load (required by selected configs: ${CONFIGS.filter((c) => c.provider === "openai")
      .map((c) => c.key)
      .join(",")})`,
  );
  process.exit(1);
}

function extractJsonObject(text: string): string {
  let t = text.trim();
  // strip markdown fences
  t = t.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) return t.slice(first, last + 1);
  return t;
}

type CellResult = {
  promptId: string;
  config: string;
  aiMode: boolean; // pass1 schema-valid AND sanitize didn't throw
  pass1ParseOk: boolean; // free-JSON parsed + schema-validated (constrained: always true)
  sanitizeOk: boolean;
  nodes: number;
  edges: number;
  noopRemaining: number;
  promotionAttempts: number;
  promotionsSucceeded: number;
  latencyMs: number;
  inTok: number;
  outTok: number;
  costUsd: number;
  judgeOverall: number | null;
  judgeIntent: number | null;
  judgeStructure: number | null;
  judgeCompleteness: number | null;
  verdict: string;
  error: string | null;
};

async function pass1Constrained(
  llm: LlmClient,
  cfg: Config,
  system: string,
  prompt: string,
): Promise<{ object: unknown; inTok: number; outTok: number; latencyMs: number; parseOk: boolean }> {
  const r = await llm.generateObject({
    schema: AiGenerationWorkflowSchema,
    schemaName: "JanuslyWorkflow",
    schemaDescription: "Workflow DAG for /ai/generate-workflow.",
    system,
    prompt,
    modelHint: `${cfg.provider}/${cfg.model}`,
    context: { orgId: "eval", userId: "eval" },
  });
  return {
    object: r.object,
    inTok: r.usage?.inputTokens ?? 0,
    outTok: r.usage?.outputTokens ?? 0,
    latencyMs: r.latencyMs ?? 0,
    parseOk: true,
  };
}

// Free-JSON through the PRODUCTION LlmClient path — the same
// generateText({ responseFormat: "json" }) + provider applyJsonMode wiring
// /ai/generate-workflow uses, so a failure here is a real finding about the
// shipped path, not a harness artifact. Used for non-Anthropic providers;
// the Anthropic free-JSON path stays on the direct Messages API fetch because
// it also exercises extended thinking, which the SDK path doesn't expose here.
async function pass1FreeJsonClient(
  llm: LlmClient,
  cfg: Config,
  system: string,
  prompt: string,
): Promise<{ object: unknown; inTok: number; outTok: number; latencyMs: number; parseOk: boolean }> {
  const r = await llm.generateText({
    system,
    prompt: `${prompt}\n\nReturn ONLY the JSON workflow object — no prose, no markdown fences.`,
    responseFormat: "json",
    modelHint: `${cfg.provider}/${cfg.model}`,
    context: { orgId: "eval", userId: "eval" },
  });
  let object: unknown = null;
  let parseOk = false;
  try {
    object = JSON.parse(extractJsonObject(r.text));
    parseOk = true;
  } catch {
    parseOk = false;
  }
  return {
    object,
    inTok: r.usage?.inputTokens ?? 0,
    outTok: r.usage?.outputTokens ?? 0,
    latencyMs: r.latencyMs ?? 0,
    parseOk,
  };
}

async function pass1FreeJson(
  model: string,
  system: string,
  prompt: string,
  thinking: boolean,
): Promise<{ object: unknown; inTok: number; outTok: number; latencyMs: number; parseOk: boolean }> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: thinking ? 14000 : 4096,
    system,
    messages: [
      {
        role: "user",
        content: `${prompt}\n\nReturn ONLY the JSON workflow object — no prose, no markdown fences.`,
      },
    ],
  };
  if (thinking) body.thinking = { type: "enabled", budget_tokens: 6000 };
  const t0 = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });
  const latencyMs = Date.now() - t0;
  const json = (await res.json()) as Record<string, any>;
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${JSON.stringify(json).slice(0, 240)}`);
  const inTok = json.usage?.input_tokens ?? 0;
  const outTok = json.usage?.output_tokens ?? 0;
  const text = (json.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
  let object: unknown = null;
  let parseOk = false;
  try {
    object = JSON.parse(extractJsonObject(text));
    parseOk = true;
  } catch {
    parseOk = false;
  }
  return { object, inTok, outTok, latencyMs, parseOk };
}

function clamp(n: unknown, lo: number, hi: number): number | null {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

// Raw-fetch Sonnet judge (lenient JSON parse — avoids the SDK structured-output strict throw).
async function judgeRaw(
  prompt: string,
  wf: any,
): Promise<{ overall: number | null; intent: number | null; structure: number | null; completeness: number | null; verdict: string } | null> {
  const sys =
    "You are a strict senior workflow engineer grading an auto-generated workflow DAG against a user request. " +
    "Score honestly and harshly. Leftover 'noop' placeholder stubs where real steps belong MUST lower completeness. " +
    "Reward correct node types, sensible connected edges, and full coverage of every requested step. " +
    'Respond with ONLY a JSON object, no prose: {"intentCoverage":0-10,"structureSense":0-10,"completeness":0-10,"overall":0-100,"verdict":"<=200 chars"}.';
  const user = JSON.stringify({ userRequest: prompt, generatedWorkflow: { nodes: wf.nodes, edges: wf.edges } });
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": ANTHROPIC_VERSION },
      body: JSON.stringify({ model: SONNET, max_tokens: 1024, system: sys, messages: [{ role: "user", content: user }] }),
    });
    const json = (await res.json()) as Record<string, any>;
    if (!res.ok) return null;
    const text = (json.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const obj = JSON.parse(extractJsonObject(text)) as Record<string, unknown>;
    return {
      overall: clamp(obj.overall, 0, 100),
      intent: clamp(obj.intentCoverage, 0, 10),
      structure: clamp(obj.structureSense, 0, 10),
      completeness: clamp(obj.completeness, 0, 10),
      verdict: typeof obj.verdict === "string" ? obj.verdict.slice(0, 200) : "",
    };
  } catch {
    return null;
  }
}

async function runCell(
  baseLlm: LlmClient,
  system: string,
  p: EvalPrompt,
  cfg: Config,
): Promise<CellResult> {
  const base: CellResult = {
    promptId: p.id,
    config: cfg.key,
    aiMode: false,
    pass1ParseOk: false,
    sanitizeOk: false,
    nodes: 0,
    edges: 0,
    noopRemaining: 0,
    promotionAttempts: 0,
    promotionsSucceeded: 0,
    latencyMs: 0,
    inTok: 0,
    outTok: 0,
    costUsd: 0,
    judgeOverall: null,
    judgeIntent: null,
    judgeStructure: null,
    judgeCompleteness: null,
    verdict: "",
    error: null,
  };
  try {
    const pass1 =
      cfg.mode === "constrained"
        ? await pass1Constrained(baseLlm, cfg, system, p.text)
        : cfg.provider === "anthropic"
          ? await pass1FreeJson(cfg.model, system, p.text, cfg.thinking)
          : await pass1FreeJsonClient(baseLlm, cfg, system, p.text);
    base.latencyMs = pass1.latencyMs;
    base.inTok += pass1.inTok;
    base.outTok += pass1.outTok;

    // schema-validate pass1, mode-for-mode with production: constrained mode
    // validates the 11-branch constrained schema (provider-enforced anyway);
    // free-JSON validates the wider free-JSON schema — the same gate
    // /ai/generate-workflow applies, whose system prompt teaches the extra
    // shapes (parallel_fork / join) free-JSON may emit directly.
    const schema = cfg.mode === "constrained" ? AiGenerationWorkflowSchema : AiGenerationWorkflowSchemaFreeJson;
    const parsed = schema.safeParse(pass1.object);
    base.pass1ParseOk = pass1.parseOk && parsed.success;
    if (!base.pass1ParseOk) {
      base.error = parsed.success ? "freejson_parse_failed" : `schema:${parsed.error?.issues?.[0]?.message ?? "invalid"}`;
      base.costUsd = costUsd(cfg.model, base.inTok, base.outTok);
      return base;
    }

    // Pass 2: promote noop placeholders (constrained typed calls via LlmClient, same model)
    const promotion = await promoteNoopPlaceholders({
      llm: baseLlm,
      workflow: parsed.data as any,
      originalPrompt: p.text,
      context: { orgId: "eval", userId: "eval" },
      modelHint: `${cfg.provider}/${cfg.model}`,
    });
    base.promotionAttempts = promotion.promotionAttempts;
    base.promotionsSucceeded = promotion.promotionsSucceeded;

    // Sanitize + strict draft gate (validateWorkflow runs inside sanitizeAiWorkflow)
    let finalWf: any = promotion.workflow;
    try {
      finalWf = sanitizeAiWorkflow(promotion.workflow);
      base.sanitizeOk = true;
    } catch (e) {
      base.sanitizeOk = false;
      base.error = `sanitize:${(e as Error).message.slice(0, 120)}`;
    }
    base.aiMode = base.pass1ParseOk && base.sanitizeOk;

    const wf = base.sanitizeOk ? finalWf : promotion.workflow;
    base.nodes = wf.nodes?.length ?? 0;
    base.edges = wf.edges?.length ?? 0;
    base.noopRemaining = (wf.nodes ?? []).filter((n: any) => n.type === "noop").length;
    base.costUsd = costUsd(cfg.model, base.inTok, base.outTok);

    // Blind Sonnet judge — only grade workflows that actually reached ai-mode.
    if (base.aiMode) {
      const grade = await judgeRaw(p.text, wf);
      if (grade) {
        base.judgeOverall = grade.overall;
        base.judgeIntent = grade.intent;
        base.judgeStructure = grade.structure;
        base.judgeCompleteness = grade.completeness;
        base.verdict = grade.verdict;
      } else {
        base.verdict = "judge_unavailable";
      }
    }
    return base;
  } catch (e) {
    base.error = (e as Error).message.slice(0, 200);
    base.costUsd = costUsd(cfg.model, base.inTok, base.outTok);
    return base;
  }
}

function avg(nums: Array<number | null>): number {
  const vals = nums.filter((n): n is number => n !== null);
  if (vals.length === 0) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${Math.round((100 * n) / d)}%`;
}
function r2(n: number): string {
  return n.toFixed(2);
}

async function main(): Promise<void> {
  const cfg = resolveLlmConfig(process.env);
  if (!cfg) {
    console.error("resolveLlmConfig returned null (no API key?)");
    process.exit(1);
  }
  const baseLlm = createLlmClient(cfg);
  const system = composeGenerationSystemPrompt(GENERATE_WORKFLOW_SYSTEM_PROMPT, []);

  console.error(
    `[run] SMOKE=${SMOKE} samples=${SAMPLES} configs=${CONFIGS.map((c) => c.key).join(",")} prompts=${PROMPTS.length}`,
  );
  const results: CellResult[] = [];
  for (const p of PROMPTS) {
    for (const c of CONFIGS) {
      for (let s = 0; s < SAMPLES; s++) {
        process.stderr.write(`  ${p.id} / ${c.key} #${s + 1} ... `);
        const r = await runCell(baseLlm, system, p, c);
        results.push(r);
        console.error(
          `ai=${r.aiMode} valid=${r.sanitizeOk} nodes=${r.nodes} noop=${r.noopRemaining} judge=${r.judgeOverall ?? "-"} ${r.error ? "ERR:" + r.error : ""}`,
        );
      }
    }
  }

  // ---- aggregate table ----
  const lines: string[] = [];
  lines.push(`# Model A/B comparison — /ai/generate-workflow\n`);
  lines.push(`Prompts: ${PROMPTS.length} × ${SAMPLES} samples = ${PROMPTS.length * SAMPLES} runs/config · judge = Sonnet 4.6 (blind)\n`);
  lines.push(`Quality/node metrics are averaged over SUCCESSFUL (ai-mode) runs only; $/run is per single generation.\n`);
  lines.push(`## Aggregate per config\n`);
  lines.push(`| Config | ai-mode | pass1-valid | strict-valid | judge avg | judge range | intent | struct | complete | avg nodes | avg noop | avg latency | $/run |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const c of CONFIGS) {
    const rs = results.filter((r) => r.config === c.key);
    const ok = rs.filter((r) => r.aiMode);
    const n = rs.length;
    const p1 = rs.filter((r) => r.pass1ParseOk).length;
    const strict = rs.filter((r) => r.sanitizeOk).length;
    const judges = ok.map((r) => r.judgeOverall).filter((x): x is number => x !== null);
    const jmin = judges.length ? Math.min(...judges) : 0;
    const jmax = judges.length ? Math.max(...judges) : 0;
    const totalCost = rs.reduce((a, r) => a + r.costUsd, 0);
    lines.push(
      `| ${c.label} | ${pct(ok.length, n)} | ${pct(p1, n)} | ${pct(strict, n)} | ${r2(avg(ok.map((r) => r.judgeOverall)))} | ${jmin}-${jmax} | ${r2(avg(ok.map((r) => r.judgeIntent)))} | ${r2(avg(ok.map((r) => r.judgeStructure)))} | ${r2(avg(ok.map((r) => r.judgeCompleteness)))} | ${r2(avg(ok.map((r) => r.nodes)))} | ${r2(avg(ok.map((r) => r.noopRemaining)))} | ${Math.round(avg(rs.map((r) => r.latencyMs)))}ms | $${(totalCost / n).toFixed(4)} |`,
    );
  }

  // ---- per-prompt: ai-mode success count / samples · mean judge ----
  lines.push(`\n## Per-prompt — ai-mode (ok/samples) · mean judge\n`);
  const header = ["Prompt", ...CONFIGS.map((c) => c.key)].join(" | ");
  lines.push(`| ${header} |`);
  lines.push(`|${"---|".repeat(CONFIGS.length + 1)}`);
  for (const p of PROMPTS) {
    const cells = CONFIGS.map((c) => {
      const rs = results.filter((x) => x.promptId === p.id && x.config === c.key);
      const ok = rs.filter((r) => r.aiMode);
      const jm = ok.length ? Math.round(avg(ok.map((r) => r.judgeOverall))) : null;
      return `${ok.length}/${rs.length}${jm !== null ? ` · ${jm}` : ""}`;
    });
    lines.push(`| ${p.id} | ${cells.join(" | ")} |`);
  }

  const md = lines.join("\n");
  console.log("\n" + md + "\n");
  const outBase = new URL("./model-eval-results", import.meta.url).pathname;
  writeFileSync(`${outBase}.md`, md);
  writeFileSync(`${outBase}.json`, JSON.stringify(results, null, 2));
  console.error(`[done] wrote ${outBase}.md and .json`);
}

void main();
