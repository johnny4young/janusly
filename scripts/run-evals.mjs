/**
 * AI workflow generation evals harness — POSTs each prompt in
 * `evals/generate-workflow.jsonl` to `/ai/generate-workflow` on a running
 * Janusly API and gates the run against a committed baseline.
 *
 * Gate model:
 *   - Deterministic (non-`requiresMode:"ai"`) cases — and any transport /
 *     HTTP / non-JSON error — are HARD per-case failures (a red here is a
 *     real bug: a renamed fallback template id, an unreachable API, etc.).
 *   - `requiresMode:"ai"` cases contribute to two suite-level RATES rather
 *     than red the run individually: the ai-mode rate (did it return
 *     `mode:"ai"`) and the shape-pass rate (did the workflow meet its
 *     node-shape expectations). Free-JSON generation has real per-prompt
 *     variance, so a single flake should not red the suite — only a drop in
 *     the aggregate rate past `evals/baseline.json`'s tolerance band does.
 *   - A `requiresMode:"ai"` case that fell back with no `aiError` (no
 *     provider key reachable) is SKIPPED — excluded from the rate
 *     denominators — so a no-key run exercises only the deterministic cases
 *     and stays green at zero provider cost.
 *
 * Flags:
 *   --update-baseline   Recompute the AI rates from this run and write them
 *                       to `evals/baseline.json` (preserving `tolerance` /
 *                       `note`). Refuses when no AI case ran.
 *
 * Used by:
 * - root `package.json` `evals` (`pnpm evals`) and `evals:baseline`
 *   (`pnpm evals --update-baseline`); `evals:local` boots the stack first.
 *
 * Invariants:
 * - Sequential calls; the default AI rate limit leaves plenty of budget.
 * - Assumes the API is running; failure to reach it surfaces as a clear
 *   per-case transport error and the run exits 1.
 * - Three "fallback-keyed" cases (`http-summary`, `transform-tool`,
 *   `approval-gate`) lock the deterministic fallback templates by id.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { gateRun, summarizeAi } from "./evals-baseline.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const apiUrl = process.env.JANUSLY_EVALS_API_URL ?? "http://127.0.0.1:3001";
const fixturePath = `${rootDir}/evals/generate-workflow.jsonl`;
const baselinePath = `${rootDir}/evals/baseline.json`;
const updateBaseline = process.argv.includes("--update-baseline");

function loadCases() {
  const raw = readFileSync(fixturePath, "utf8");
  return raw
    .split("\n")
    .map((line, idx) => ({ line: line.trim(), idx: idx + 1 }))
    .filter(({ line }) => line.length > 0 && !line.startsWith("//"))
    .map(({ line, idx }) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`evals/generate-workflow.jsonl line ${idx} is not valid JSON: ${msg}`);
      }
    });
}

function loadBaseline() {
  try {
    return JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch {
    return null;
  }
}

// Collect the node-shape violations for a response. Shared by deterministic
// (hard-asserted) and AI (rate-contributing) cases.
function shapeIssues(c, body) {
  const issues = [];
  if (!Array.isArray(body.nodes)) {
    issues.push("response.nodes is not an array");
    return issues;
  }
  const types = body.nodes.map((n) => n?.type);
  if (typeof c.expect?.minNodes === "number" && body.nodes.length < c.expect.minNodes) {
    issues.push(`expected >= ${c.expect.minNodes} nodes, got ${body.nodes.length}`);
  }
  if (typeof c.expect?.maxNodes === "number" && body.nodes.length > c.expect.maxNodes) {
    issues.push(`expected <= ${c.expect.maxNodes} nodes, got ${body.nodes.length}`);
  }
  for (const t of c.expect?.requiredTypes ?? []) {
    if (!types.includes(t)) issues.push(`required type "${t}" missing (saw ${JSON.stringify(types)})`);
  }
  for (const t of c.expect?.forbiddenTypes ?? []) {
    if (types.includes(t)) issues.push(`forbidden type "${t}" present`);
  }
  // `anyOfTypes` accepts any one of several reasonable decompositions (e.g. a
  // single `multi_agent` node OR several `agent` nodes) without flaking.
  const anyOf = c.expect?.anyOfTypes;
  if (Array.isArray(anyOf) && anyOf.length > 0 && !anyOf.some((t) => types.includes(t))) {
    issues.push(`expected at least one of ${JSON.stringify(anyOf)} (saw ${JSON.stringify(types)})`);
  }
  return issues;
}

async function runOne(c) {
  const requiresAi = c.expect?.requiresMode === "ai";
  const base = { id: c.id, requiresAi, skipped: false, transportError: false, aiMode: false, shapePass: false };

  let res;
  try {
    res = await fetch(`${apiUrl}/ai/generate-workflow`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-org-id": "default",
        "x-user-id": "dev-user",
      },
      body: JSON.stringify({ prompt: c.prompt }),
    });
  } catch (err) {
    return {
      ...base,
      transportError: true,
      issues: [`network error: ${err instanceof Error ? err.message : String(err)} (is the API running on ${apiUrl}?)`],
    };
  }

  if (!res.ok) {
    return { ...base, transportError: true, issues: [`HTTP ${res.status}`] };
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    return { ...base, transportError: true, issues: [`response body is not JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }

  const mode = body.mode;
  const nodeCount = Array.isArray(body.nodes) ? body.nodes.length : null;

  // An AI case that fell back WITHOUT an aiError means no provider key is
  // reachable — skip it (not a regression). A fallback WITH an aiError is a
  // real degradation and lowers the ai-mode rate.
  if (requiresAi && mode === "fallback" && !body.aiError) {
    return { ...base, skipped: true, mode, nodeCount, issues: [], reason: "requires AI mode (configure a provider API key)" };
  }

  const issues = [];
  const shape = shapeIssues(c, body);
  issues.push(...shape);

  if (body.mode === "fallback" && c.expect?.fallbackTemplate && body.id !== c.expect.fallbackTemplate) {
    issues.push(`fallback expected template "${c.expect.fallbackTemplate}", got "${body.id}"`);
  }

  const aiMode = mode === "ai";
  if (requiresAi && !aiMode) {
    issues.push(`expected mode "ai", got "${mode ?? "missing"}"${body.aiError ? ` (${body.aiError})` : ""}`);
  }

  return {
    ...base,
    mode,
    nodeCount,
    aiMode,
    // Shape pass only counts the node-shape expectations (the deterministic
    // quality proxy that stands in for an LLM judge); the mode mismatch is
    // tracked separately by `aiMode`.
    shapePass: shape.length === 0,
    issues,
  };
}

const cases = loadCases();
const results = [];
for (const c of cases) {
  results.push(await runOne(c));
}

// Per-case display + hard-failure tally.
let hardFailures = 0;
for (const r of results) {
  let tag;
  let detail;
  if (r.skipped) {
    tag = "⊘";
    detail = `${r.mode ?? "?"} · ${r.reason ?? "skipped"}`;
  } else if (r.transportError) {
    tag = "✗";
    detail = r.issues?.join("; ") ?? "transport error";
    hardFailures++;
  } else if (r.requiresAi) {
    const ok = r.aiMode && r.shapePass;
    tag = ok ? "✓" : "✗";
    detail = ok ? `${r.mode} · ${r.nodeCount ?? "?"} nodes` : r.issues.join("; ");
    // AI-case reds contribute to the rate gate, not the hard tally.
  } else {
    const ok = r.issues.length === 0;
    tag = ok ? "✓" : "✗";
    detail = ok ? `${r.mode ?? "?"} · ${r.nodeCount ?? "?"} nodes` : r.issues.join("; ");
    if (!ok) hardFailures++;
  }
  console.log(`${tag} ${r.id}: ${detail}`);
}

const observed = summarizeAi(results);

// `--update-baseline` snapshots this run's AI rates as the new floors;
// otherwise run the suite summary + gate. Both paths set `process.exitCode`
// and let the process drain naturally — `process.exit()` can truncate buffered
// stdout when the harness runs under a pipe (e.g. via run-evals-local.mjs's
// inherited stdio). There are no open handles after the fetch loop, so the
// process exits on its own once the event loop empties.
if (updateBaseline) {
  if (observed.aiCaseCount === 0) {
    console.error("\n[evals] no AI cases ran — cannot update baseline (run with a provider key reachable).");
    process.exitCode = 1;
  } else {
    const prev = loadBaseline() ?? {};
    const next = {
      aiModeRate: Number(observed.aiModeRate.toFixed(4)),
      shapePassRate: Number(observed.shapePassRate.toFixed(4)),
      tolerance: prev.tolerance ?? 0.1,
      note: prev.note ?? "Baseline floors for the AI generation golden suite.",
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`\n[evals] baseline updated → ai-mode ${next.aiModeRate}, shape-pass ${next.shapePassRate} (over ${observed.aiCaseCount} AI cases)`);
    process.exitCode = 0;
  }
} else {
  const baseline = loadBaseline();
  const passed = results.filter((r) => !r.skipped && !r.transportError && (r.requiresAi ? r.aiMode && r.shapePass : r.issues.length === 0)).length;
  const skipped = results.filter((r) => r.skipped).length;
  console.log(`\n${passed} passed, ${results.length - passed - skipped} not-passing, ${skipped} skipped (of ${results.length})`);

  if (observed.aiCaseCount === 0) {
    console.log("ai rate gate: skipped (no AI cases ran — no provider key reachable, or the API was unreachable)");
  } else if (!baseline) {
    console.log(`ai-mode rate: ${observed.aiModeRate.toFixed(2)} · shape-pass rate: ${observed.shapePassRate.toFixed(2)} (no baseline — rate gate skipped; create one with \`pnpm evals:baseline\`)`);
  } else {
    const tol = baseline.tolerance ?? 0;
    console.log(`ai-mode rate:   ${observed.aiModeRate.toFixed(2)} (baseline ${Number(baseline.aiModeRate).toFixed(2)} ±${tol.toFixed(2)})`);
    console.log(`shape-pass rate:${observed.shapePassRate.toFixed(2)} (baseline ${Number(baseline.shapePassRate).toFixed(2)} ±${tol.toFixed(2)})`);
  }

  const decision = baseline
    ? gateRun({ hardFailures, observed, baseline })
    : { failed: hardFailures > 0, reasons: hardFailures > 0 ? [`${hardFailures} hard failure(s)`] : [] };

  if (decision.failed) {
    console.error(`\nFAIL: ${decision.reasons.join("; ")}`);
  }
  process.exitCode = decision.failed ? 1 : 0;
}
