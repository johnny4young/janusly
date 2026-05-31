/*
 * model-eval-compare.ts — isolated A/B/C/D model comparison for /ai/generate-workflow.
 *
 * Runs the REAL generation pipeline (Pass1 -> promoteNoopPlaceholders -> sanitizeAiWorkflow
 * -> validateWorkflow) against the repo's own complex eval prompts, across 4 configs:
 *   A haiku        — constrained structured output via LlmClient (legacy path)
 *   B sonnet       — constrained structured output via LlmClient
 *   C haiku-think  — Anthropic Messages API direct (fetch), extended thinking ON, FREE-JSON
 *                    (thinking is incompatible with forced structured output on Anthropic)
 *   D haiku-free   — Anthropic Messages API direct (fetch), no thinking, FREE-JSON
 *                    (isolates the "no constrained decoding" penalty from the thinking benefit)
 *
 * A blind Sonnet judge scores each final workflow. No ship code is modified.
 * Run: pnpm --filter @janusly/api exec tsx ../../scripts/model-eval-compare.ts
 * Env: SMOKE=1 -> 1 prompt, only constrained-haiku + free-haiku (validates both code paths cheaply)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createLlmClient, resolveLlmConfig, promoteNoopPlaceholders, type LlmClient } from "@janusly/ai";
import { AiGenerationWorkflowSchema } from "../apps/api/src/ai-schemas";
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
const ANTHROPIC_VERSION = "2023-06-01";
if (!ANTHROPIC_KEY) {
  console.error("ANTHROPIC_API_KEY missing after .env load");
  process.exit(1);
}

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-6";
const PRICE: Record<string, { in: number; out: number }> = {
  [HAIKU]: { in: 1.0, out: 5.0 },
  [SONNET]: { in: 3.0, out: 15.0 },
};
function costUsd(model: string, inTok: number, outTok: number): number {
  const p = PRICE[model] ?? { in: 0, out: 0 };
  return (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
}

type Config = {
  key: string;
  label: string;
  model: string;
  mode: "constrained" | "freejson";
  thinking: boolean;
};
const ALL_CONFIGS: Config[] = [
  { key: "haiku", label: "Haiku 4.5 (constrained)", model: HAIKU, mode: "constrained", thinking: false },
  { key: "sonnet", label: "Sonnet 4.6 (constrained)", model: SONNET, mode: "constrained", thinking: false },
  { key: "haiku-think", label: "Haiku 4.5 +thinking (free-JSON)", model: HAIKU, mode: "freejson", thinking: true },
  { key: "haiku-free", label: "Haiku 4.5 (free-JSON, no think)", model: HAIKU, mode: "freejson", thinking: false },
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

const SMOKE = Boolean(process.env.SMOKE);
const SAMPLES = Math.max(1, Number(process.env.SAMPLES ?? 1));
const ONLY = (process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const CONFIGS = (SMOKE ? ALL_CONFIGS.filter((c) => c.key === "haiku" || c.key === "haiku-free") : ALL_CONFIGS).filter(
  (c) => ONLY.length === 0 || ONLY.includes(c.key),
);
const PROMPTS = SMOKE ? ALL_PROMPTS.slice(0, 1) : ALL_PROMPTS;

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
  model: string,
  system: string,
  prompt: string,
): Promise<{ object: unknown; inTok: number; outTok: number; latencyMs: number; parseOk: boolean }> {
  const r = await llm.generateObject({
    schema: AiGenerationWorkflowSchema,
    schemaName: "JanuslyWorkflow",
    schemaDescription: "Workflow DAG for /ai/generate-workflow.",
    system,
    prompt,
    modelHint: `anthropic/${model}`,
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
        ? await pass1Constrained(baseLlm, cfg.model, system, p.text)
        : await pass1FreeJson(cfg.model, system, p.text, cfg.thinking);
    base.latencyMs = pass1.latencyMs;
    base.inTok += pass1.inTok;
    base.outTok += pass1.outTok;

    // schema-validate pass1 (constrained: enforced; free-JSON: real gate)
    const parsed = AiGenerationWorkflowSchema.safeParse(pass1.object);
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
      modelHint: `anthropic/${cfg.model}`,
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
