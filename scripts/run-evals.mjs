/**
 * AI workflow generation evals harness — POSTs each prompt in
 * `evals/generate-workflow.jsonl` to `/ai/generate-workflow` on a running
 * Janusly API and asserts the response shape.
 *
 * Lifecycle:
 *   1. Read fixture (one JSON object per non-empty, non-comment line).
 *   2. POST each `{ prompt }` sequentially with dev headers
 *      (`x-org-id: default`, `x-user-id: dev-user`).
 *   3. For each response, evaluate:
 *      - If `requiresMode: "ai"` is set on the case AND the response returned
 *        `mode: "fallback"` without `aiError` → SKIP (no OpenAI key
 *        configured; not a regression).
 *      - Otherwise, assert minNodes/maxNodes, requiredTypes/forbiddenTypes,
 *        and (when fallback fires) fallbackTemplate id.
 *   4. Print a one-line per case (✓ / ✗ / ⊘), then a summary, exit 0 if
 *      no failures and 1 otherwise. Skipped cases don't gate the exit.
 *
 * Used by:
 * - root `package.json` `evals` script (`pnpm evals`).
 *
 * Invariants:
 * - Sequential calls; the default AI rate limit (30/min per org) leaves
 *   plenty of budget for 10 requests but parallel calls would also share
 *   the bucket with `pnpm dev` traffic.
 * - Assumes the API is running. The harness doesn't manage Compose or
 *   the API lifecycle; failure to reach the endpoint surfaces as a clear
 *   per-case error and the run still exits 1.
 * - Three "fallback-keyed" cases (`http-summary`, `transform-tool`,
 *   `approval-gate`) lock the deterministic fallback templates by id.
 *   Renaming a template id without updating this fixture is the bug we
 *   want to surface.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const apiUrl = process.env.JANUSLY_EVALS_API_URL ?? "http://127.0.0.1:3001";
const fixturePath = `${rootDir}/evals/generate-workflow.jsonl`;

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

async function runOne(c) {
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
      id: c.id,
      ok: false,
      reason: `network error: ${err instanceof Error ? err.message : String(err)} (is \`pnpm dev\` running on ${apiUrl}?)`,
    };
  }

  if (!res.ok) {
    return { id: c.id, ok: false, reason: `HTTP ${res.status}` };
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    return {
      id: c.id,
      ok: false,
      reason: `response body is not JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Skip cases that need live AI only when the API fell back because no
  // OPENAI_API_KEY is configured. If `aiError` is present, the live AI path was
  // attempted and degraded; that is exactly the regression this harness should
  // surface.
  if (c.expect?.requiresMode === "ai" && body.mode === "fallback" && !body.aiError) {
    return {
      id: c.id,
      ok: true,
      skipped: true,
      mode: body.mode,
      reason: "requires AI mode (set OPENAI_API_KEY)",
    };
  }

  const issues = [];

  if (c.expect?.requiresMode === "ai" && body.mode !== "ai") {
    const detail = body.aiError ? ` (${body.aiError})` : "";
    issues.push(`expected mode "ai", got "${body.mode ?? "missing"}"${detail}`);
  }

  if (!Array.isArray(body.nodes)) {
    issues.push("response.nodes is not an array");
  } else {
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
    // `anyOfTypes` lets a case accept any one of several reasonable LLM
    // outputs — e.g. a "multi-agent debate" prompt is satisfied by either a
    // single `multi_agent` node or several individual `agent` nodes; both
    // are valid decompositions and we don't want to flake on the choice.
    const anyOf = c.expect?.anyOfTypes;
    if (Array.isArray(anyOf) && anyOf.length > 0 && !anyOf.some((t) => types.includes(t))) {
      issues.push(`expected at least one of ${JSON.stringify(anyOf)} (saw ${JSON.stringify(types)})`);
    }
  }

  if (body.mode === "fallback" && c.expect?.fallbackTemplate && body.id !== c.expect.fallbackTemplate) {
    issues.push(`fallback expected template "${c.expect.fallbackTemplate}", got "${body.id}"`);
  }

  return {
    id: c.id,
    ok: issues.length === 0,
    mode: body.mode,
    nodeCount: Array.isArray(body.nodes) ? body.nodes.length : null,
    issues,
  };
}

const cases = loadCases();
const results = [];
for (const c of cases) {
  results.push(await runOne(c));
}

let passed = 0;
let skipped = 0;
let failed = 0;
for (const r of results) {
  let tag;
  let detail;
  if (r.skipped) {
    tag = "⊘";
    detail = `${r.mode ?? "?"} · ${r.reason}`;
    skipped++;
  } else if (r.ok) {
    tag = "✓";
    detail = `${r.mode ?? "?"} · ${r.nodeCount ?? "?"} nodes`;
    passed++;
  } else {
    tag = "✗";
    detail = r.issues?.length ? r.issues.join("; ") : (r.reason ?? "failed");
    failed++;
  }
  console.log(`${tag} ${r.id}: ${detail}`);
}

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped (of ${results.length})`);
process.exit(failed === 0 ? 0 : 1);
