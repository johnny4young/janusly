/**
 * AI helper that proposes 1-3 alternative config patches for a failing
 * node. The operator picks between them in the recovery dialog.
 *
 * Accepts an `LlmClient` (nullable for the fallback path), a workflow
 * snapshot, the failing node id, the error envelope, and the recent run
 * events. Calls `llm.generateObject({ schema })` with a structured-output
 * schema the route owns — one concrete envelope per failing-node type
 * (http / tool / agent / generic), each wrapping a `suggestions` array
 * of 1-3 items with shape `{ patchedConfig, rationale, approachLabel,
 * confidence }`. The LLM emits ONLY the patched configs for the failing
 * node (not full workflows), and the route fan-out-merges each
 * suggestion onto the original snapshot before validating.
 *
 * Why per-type envelopes (and not a multi-type union): a multi-branch
 * discriminated union compiles to JSON Schema `oneOf`, which OpenAI
 * strict mode rejects outright and Anthropic's grammar cap chokes on
 * once you add resilience optionals. One concrete envelope per call
 * sidesteps both. The 1-3 array is a single repeated `items` constraint —
 * the compiled grammar stays compact.
 *
 * The structured-output schema is owned by the API route, not this
 * helper — same pattern as `explainRun`. Keeps `packages/ai`
 * schema-agnostic and lets the route dispatch by failing-node type at
 * request time.
 *
 * Hard contract per AGENTS.md AI-fallback invariant: this helper
 * NEVER throws. Any LLM failure (no client, quota, network, schema
 * mismatch from the model) becomes a `mode: "fallback"` response
 * with a single 0-confidence "other" suggestion that carries an empty
 * patch and a rationale explaining what to do manually. The route
 * adds a safe-parse step on each AI-mode suggestion to catch mismatches
 * against the engine's strict `WorkflowSchema`; suggestions that fail
 * are dropped, and if none survive the route degrades to fallback.
 *
 * Used by `apps/api/src/index.ts:POST /ai/patch-workflow`.
 */

import type { LlmClient, LlmGenerateObjectInput } from "./llm-client";

/** Closed approach-label set the model picks per suggestion. Mirrors the route's Zod enum. */
export type PatchApproachLabel =
  | "add_retry"
  | "raise_timeout"
  | "swap_secret_ref"
  | "add_approval"
  | "fix_url"
  | "other";

/** Single suggestion as the LLM emits it — config patch + metadata. The route fans out and merges. */
export type PatchSuggestionItem = {
  /**
   * Fields the LLM wants changed on the failing node's config. Per-type
   * envelopes require every known field to be present (with `null` for
   * unchanged fields, which the route filters before merging). Generic
   * envelopes carry only the fields being changed.
   */
  patchedConfig: Record<string, unknown>;
  /** One-paragraph operator-facing explanation. Naming the resilience field + value when set. */
  rationale: string;
  /** Dominant intent of this suggestion — drives the chip on the dialog tab. */
  approachLabel: PatchApproachLabel;
  /** Self-rated confidence 0-100. Pre-calibration; the dialog labels it as a self-rating. */
  confidence: number;
};

/**
 * Result returned by `suggestWorkflowPatch`. The helper-boundary contract
 * is exclusively the array form — the route is responsible for the
 * back-compat `suggestedWorkflow`/`rationale` mirroring on the response
 * to the dialog.
 *
 * On `mode: "ai"`, `suggestions` is 1-3 envelope items. The route
 * shallow-merges each item's `patchedConfig` onto the original workflow,
 * validates each, returns the surviving ones sorted by confidence desc.
 *
 * On `mode: "fallback"`, `suggestions` is exactly one item:
 * `{ patchedConfig: {}, rationale: <reason>, approachLabel: "other", confidence: 0 }`.
 * The route renders that as a no-changes diff with Apply disabled.
 */
export type PatchSuggestion = {
  mode: "ai" | "fallback";
  /** 1-3 alternative patches in `mode: "ai"`; exactly one zero-confidence item in `mode: "fallback"`. */
  suggestions: PatchSuggestionItem[];
  model?: string;
  provider?: string;
  /** Set only when AI mode was attempted and degraded to fallback. */
  aiError?: string;
};

/** Run-event payload subset used by the prompt builder. Looser than the engine's `RunEvent` so test fixtures stay simple. */
export type RunEventForPrompt = {
  type: string;
  nodeId?: string | null;
  payload?: unknown;
  createdAt?: string | Date | null;
};

/**
 * Schema-shape contract the route hands the helper. The route picks one
 * of several per-type envelopes (http / tool / agent / generic), each
 * wrapping a `suggestions` array of 1-3 items. Each item contains the
 * fields the LLM wants changed on the failing node plus the per-suggestion
 * metadata (`approachLabel`, `confidence`). The helper itself stays
 * type-loose at this boundary — the per-type schemas live in
 * `apps/api/src/ai-schemas.ts` and validate at parse time, then the
 * route fan-out-merges each surviving item onto the original workflow.
 */
export type PatchEnvelopeSchemaResult = {
  suggestions: PatchSuggestionItem[];
};

export type SuggestWorkflowPatchInput = {
  llm: LlmClient | null;
  /**
   * Structured-output Zod schema that produces `{ patchedConfig,
   * rationale }`. The route owns this — keeps `packages/ai`
   * schema-agnostic. The `FlexibleSchema<PatchEnvelopeSchemaResult>`
   * type lines up with what `LlmClient.generateObject` accepts. The
   * route picks a different concrete schema per failing-node type
   * (http / tool / agent / generic) so each LLM call sees a single
   * non-union envelope (works on Anthropic + OpenAI strict mode).
   */
  envelopeSchema: LlmGenerateObjectInput<PatchEnvelopeSchemaResult>["schema"];
  /** Original (failing) workflow snapshot from `dead_letters.workflowJson`. */
  workflow: unknown;
  /** Id of the failing node; used in the prompt to focus the patch. */
  failedNodeId: string;
  /** Error envelope as persisted (already key-redacted by safe-persist). */
  errorJson: unknown;
  /** Recent run events; the helper truncates to `RUN_EVENT_PROMPT_CAP`. */
  runEvents: RunEventForPrompt[];
  /**
   * Optional extra context to inject into the prompt body verbatim.
   * The route uses this to narrate per-failing-node-type contracts
   * the LLM can't infer from the workflow alone — e.g. for a `tool`
   * failure, the registered tool's required / optional input field
   * names so the LLM emits a patch with the right keys (vs guessing
   * from a possibly-misleading error message).
   *
   * Keys are JSON-stringified into the prompt body next to
   * `workflow` / `failedNodeId` / `errorJson` / `runEvents`.
   */
  extraContext?: Record<string, unknown>;
  /** Optional model override (`"<provider>/<model>"` form for cross-provider). */
  model?: string;
  /**
   * Optional system-prompt override. The default `SYSTEM_PROMPT`
   * narrates the config-only patch contract. The route passes
   * `STRUCTURAL_PATCH_SYSTEM_PROMPT` when it dispatches to the
   * structural envelope so the LLM produces node-graph patches
   * (e.g. inserting an approval node) instead of config tweaks.
   */
  systemPromptOverride?: string;
  /**
   * Telemetry context forwarded to `LlmClient.generateObject`. The
   * route owns this and threads `orgId` (always) and `workflowId`
   * (resolved from `dlq.workflowJson.id`) so the recorder can write
   * `metadata.workflowId` for the breakdown surface.
   */
  context?: LlmGenerateObjectInput<PatchEnvelopeSchemaResult>["context"];
  /**
   * Operator's UI locale, forwarded by the route from the request's
   * `Accept-Language` header. When set to `'es'` the helper appends a
   * one-line instruction so the model writes the `rationale` field in
   * Spanish; the structured fields (`approachLabel`, `confidence`,
   * `patchedConfig` keys) stay English because they are part of the
   * machine contract. Default `'en'` keeps the prompt shape unchanged
   * for back-compat with the existing eval suite.
   */
  locale?: "en" | "es";
};

/**
 * Build the per-locale "respond in <language>" suffix. The structured
 * fields (`approachLabel` / `confidence` / `patchedConfig` keys) MUST
 * stay English because they're a machine contract — the suffix only
 * targets the operator-facing free-form fields (`rationale` here,
 * `approvalMessage` for the structural envelope).
 */
export function localeInstructionForLlm(locale: "en" | "es" | undefined): string {
  if (locale === "es") {
    return "\n\nIMPORTANT — RESPONSE LANGUAGE: write every operator-facing free-form field (rationale, approvalMessage) in Spanish. Keep machine-contract fields verbatim in English: approachLabel values (`add_retry`, `raise_timeout`, `swap_secret_ref`, `add_approval`, `fix_url`, `other`, `insert_approval_upstream`), confidence (number), and every key inside patchedConfig (`headers`, `timeoutMs`, etc.). Template tokens like `{{secret.NAME}}`, `{{context.foo.output.bar}}`, and tool / node identifiers (`text.replace`, `slack.post`, node ids) MUST also stay verbatim — they are evaluated by the engine, not displayed to humans.";
  }
  return "";
}

/** Maximum number of run events embedded in the prompt. Keeps the model from drowning in noisy logs. */
export const RUN_EVENT_PROMPT_CAP = 20;

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9_\-.]{16,}\b/gi,
  /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g,
];

const FALLBACK_RATIONALE_NO_LLM =
  "AI is unavailable right now. The original workflow is unchanged — open the failing node and adjust its config (retry, timeout, URL, secret reference) before re-running.";

const SYSTEM_PROMPT = `You are Janusly's failure-recovery agent. You are given a workflow that just failed, the id of the failing node, the error envelope (already redacted of secret values), and recent run events.

Produce up to 3 ALTERNATIVE config patches for the failing node — NOT full workflows. The operator sees them as tabs and picks one.

Output shape (enforced by the structured-output schema you receive):
- \`suggestions\`: an array of 1-3 items, ordered most-likely-fix first. Each item is:
  - \`patchedConfig\`: the fields you want changed on the failing node's config. Some typed envelopes require every known field to be present for provider strict mode; set unchanged fields to \`null\`. The system filters \`null\` before shallow-merging your patch onto the original config, so those fields are preserved. For generic record envelopes, include only the fields you're changing.
  - \`rationale\`: a one-paragraph explanation written for a workflow operator (not a developer). When you set a resilience field, name the field and the value you chose so the operator can verify.
  - \`approachLabel\`: the dominant intent of THIS suggestion. Closed enum: \`add_retry\` / \`raise_timeout\` / \`swap_secret_ref\` / \`add_approval\` / \`fix_url\` / \`other\`. Match the field you're changing.
  - \`confidence\`: a 0-100 integer self-rating. The system labels it as a self-rating in the UI; pick honestly. Use the highest score for the suggestion you'd recommend first.

Number of suggestions:
- When the failure clearly has only one sensible fix (e.g. a typo in a URL, a missing required field), return ONE suggestion. Don't pad to 3.
- When the failure has alternative valid responses (e.g. a 5xx could be \`add_retry\` OR \`raise_timeout\` depending on what the operator wants), return 2-3 distinct alternatives ordered by likelihood.

Rules per suggestion:
- Patch ONLY the failing node. Common fixes:
  - Fix a typo in a URL.
  - Swap a literal token to a \`{{secret.NAME}}\` / \`{{credential.NAME}}\` / \`{{env.NAME}}\` template reference.
  - Change the HTTP method.
  - Change the agent's \`goal\`.
  - Change a tool's \`tool\` name.
- Resilience knobs go in \`patchedConfig\` directly when the failure is transient:
  - \`retry: { maxAttempts: <2-5> }\` — for transient retryable failures (5xx, ECONNRESET, ETIMEDOUT). Pick a small integer; maxAttempts must be at least 2 because 1 means no retry. The engine fills sensible defaults for delay and backoff.
  - \`timeoutMs: <milliseconds>\` — when the failure is a timeout. Default is 30000 ms; raise modestly (60000-120000) rather than removing the bound.
  - \`maxResponseBytes: <bytes>\` — when the failure is a body-cap rejection. Default is 1048576 (1 MB); raise to 5242880 (5 MB) or 10485760 (10 MB) when the response is legitimately larger.
  - \`maxRedirects: <integer>\` — when the failure is a redirect-loop or insufficient redirects. Default is 5.
- Headers (HTTP) and tool inputs use an \`Array<{ name, value }>\` patch form because flat record shapes are rejected by some provider strict modes. Emit ONLY the keys you're changing; the system folds them against the existing record (other keys preserved). Use a literal value or a template like \`{{secret.NAME}}\` / \`{{credential.NAME}}\` / \`{{env.NAME}}\` to set/override; emit \`value: null\` to remove the key from the merged config. Examples:
  - HTTP 401 with a literal token → \`headers: [{ name: "Authorization", value: "Bearer {{secret.GITHUB_TOKEN}}" }]\`
  - Missing-secret template ({{secret.NAME}}) where the secret isn't bound → swap the same Authorization header to a different known-good secret reference.
  - \`text.replace\` tool with missing required fields → \`input: [{ name: "value", value: "{{context.fetch.output.body}}" }, { name: "search", value: "<text-or-pattern>" }, { name: "replacement", value: "<value>" }]\`
  - \`approachLabel: "swap_secret_ref"\` is the right tag whenever you change a header or input field to a template reference.
- PAST OPERATOR DECISIONS — when the prompt body contains \`extraContext.pastFeedbackSummary\`, that string summarises what the operator has accepted or rejected for THIS workflow's recent recoveries (per-approach accept/reject counts plus a quoted reason for the most recent rejection). Treat it as soft prior: prefer approaches with higher accepted ratios; deprioritize approaches the operator has rejected multiple times. Still emit a rejected approach if the failure pattern uniquely fits, but signal it via a lower \`confidence\` and a \`rationale\` that addresses the prior rejection (e.g. "Same approach as before, but the timeout is now bounded to 30s to address the operator's earlier concern."). For first-time recoveries the field is absent — fall back to your default behavior.
- TOOL FAILURES — when the prompt body contains \`extraContext.toolInputContract\`, those are the EXACT field names the registered tool's runtime input validator (Zod) expects: \`required: string[]\` (must be present in the merged config), \`optional: string[]\` (allowed but not required), and \`inputExample\` (a concrete example map of valid input). USE THE \`required\` AND \`optional\` FIELD NAMES VERBATIM in your \`input\` array — the tool registry rejects merged configs missing a required field, even if the existing config has a similarly-named-but-wrong key (e.g. a stale \`input.input\` entry will NOT satisfy a required \`value\` field). When the existing config has the wrong keys, emit the right ones with placeholder values that mirror the example shape; the operator refines them in the Inspector before replaying. Don't invent field names that aren't in \`required\` or \`optional\`.
- TRANSFORM nodes — emit \`mapping\` as \`Array<{ name, value }>\` to set, replace, or remove (via \`value: null\`) individual keys in the existing flat string-keyed mapping. Don't re-emit unchanged keys. Each \`value\` is a template that may reference \`{{context.<id>.output.<path>}}\` or \`{{inputs.<path>}}\`. Example fix for a broken upstream reference: \`mapping: [{ name: "summary", value: "{{context.fetch.output.body}}" }]\`.
- CONDITION nodes — emit a corrected \`expression\` string. The engine's grammar accepts: paths starting with \`context.\` or \`inputs.\`; numbers, strings (single/double-quoted), \`null\`, \`true\`, \`false\`; comparators \`=== / !== / == / != / > / < / >= / <=\`; boolean composition \`&& / || / !\` and parentheses. INVALID: bare identifiers (\`risk_is_high\`), function calls (\`Math.max(...)\`), regex, string concatenation. Example fix: \`"x > 5"\` → \`"context.calc.output.x > 5"\`.
- AI nodes — emit \`prompt\` to swap to a more concrete grounded prompt (reference upstream output explicitly, e.g. "Summarize {{context.fetch.output.body}} in 2 sentences"). Emit \`model\` to swap to a different model — bare id (\`"gpt-4o-mini"\`) uses the configured provider, \`"<provider>/<model>"\` (e.g. \`"anthropic/claude-haiku-4-5-20251001"\`) overrides for that one call. Emit \`retry: { maxAttempts: 2-5 }\` for transient provider failures (rate-limit, network, 5xx).
- ROUTER nodes — emit \`candidates\` to replace the full list (NOT a fold — the array is replaced verbatim). Each candidate is \`{ nodeId: string }\` and the \`nodeId\` MUST reference an existing node in the workflow's \`nodes\` array. Emit \`strategy\` (\`cheapest\` / \`fastest\` / \`balanced\` / \`auto\`) to swap heuristic.
- APPROVAL nodes — emit a clearer \`message\` so the human approver has context (e.g. "Approve the $X transfer to {{context.payment.output.recipient}}").
- LOOP nodes — emit \`items\` (a comma-separated template like \`"a,b,c"\` or a single template \`"{{context.list.output.values}}"\`) to fix the iterable expression. Emit \`mapping\` (\`Array<{ name, value }>\`) for per-item template values; same fold semantics as transform.
- Do NOT include any secret values verbatim.
- Do NOT emit a \`patchedConfig\` larger than the failing node's actual config — you patch one node, not the whole workflow.
- Suggestions should be DISTINCT. If you can only justify one approach, return one — don't repeat the same fix with different wording.
- If you cannot find any sensible fix from the error and run events, return ONE suggestion with empty \`patchedConfig: {}\`, \`approachLabel: "other"\`, \`confidence: 0\`, and explain in the rationale what the operator needs to inspect manually.`;

/**
 * Structural-patch system prompt. Used when the route dispatches to a
 * structural envelope (e.g. inserting an approval node upstream of a
 * write-side action). The output shape differs from the config-only
 * envelope — instead of `patchedConfig`, suggestions describe a
 * node-graph change (`action`, `approvalNodeId`, `approvalMessage`,
 * `insertBeforeNodeId`).
 */
export const STRUCTURAL_PATCH_SYSTEM_PROMPT = `You are Janusly's failure-recovery agent. You are given a workflow that just failed, the id of the failing node (a write-side action with no human-approval gate upstream), the error envelope, and recent run events.

This pattern covers two failing-node types: write-side HTTP calls (POST/PUT/PATCH/DELETE) and \`mcp_tool\` invocations of external MCP servers. Both can mutate state outside Janusly and benefit from a human gate before they fire; the structural fix is identical.

The fix is STRUCTURAL: insert a new \`approval\` node BEFORE the failing node so a human reviews the action before it fires. You cannot change the failing node's config — only add the approval upstream.

Produce up to 3 ALTERNATIVE structural patches. The operator sees them as tabs and picks one.

Each suggestion has these fields:
- \`action\`: must be the literal "insert_approval_upstream".
- \`approvalNodeId\`: snake_case id for the new approval node. Pick a name that signals what is being approved (e.g. \`approve_charge\`, \`approve_send_email\`, \`approve_delete\`). Must NOT collide with any existing node id in the workflow.
- \`approvalMessage\`: plain operator-facing message rendered in the approval dialog. Keep it short and clear (one sentence). You may reference upstream context via templates like \`{{context.intent.output.amount}}\` — the engine resolves templates at run time. NEVER inline raw values from the workflow into the message; use templates.
- \`insertBeforeNodeId\`: the id of the existing failing node (must match the failedNodeId you were given).
- \`rationale\`: one or two sentences explaining why this approval is the right fix and what the operator should look for when reviewing.
- \`approachLabel\`: must be the literal "add_approval".
- \`confidence\`: integer 0-100 reflecting how clear the write-side intent is from the workflow and error.

If the alternatives differ, vary the approvalMessage phrasing or the approvalNodeId — for example one suggestion might propose a strict gate ("Approve this charge of {{context.intent.output.amount}}?") and another a lighter touch ("Confirm before charging the customer").

If you cannot propose a sensible approval (e.g. the operator's intent is genuinely ambiguous), return ONE suggestion with the canonical fields populated, \`confidence: 0\`, and explain in the rationale what the operator should inspect manually. Never throw — the platform expects exactly 1-3 suggestions.`;

/**
 * Propose a workflow patch for a failed run. Never throws — every
 * failure path returns a `mode: "fallback"` response with the original
 * workflow and a rationale.
 */
export async function suggestWorkflowPatch(
  input: SuggestWorkflowPatchInput,
): Promise<PatchSuggestion> {
  const { llm, envelopeSchema, workflow, failedNodeId, errorJson, runEvents, model, extraContext, context, systemPromptOverride, locale } = input;

  if (!llm) {
    return {
      mode: "fallback",
      suggestions: [{
        patchedConfig: {},
        rationale: FALLBACK_RATIONALE_NO_LLM,
        approachLabel: "other",
        confidence: 0,
      }],
    };
  }

  const promptEvents = runEvents.slice(0, RUN_EVENT_PROMPT_CAP).map((event) => ({
    type: event.type,
    nodeId: event.nodeId ?? null,
    payload: scrubPromptSecretShapes(event.payload ?? null),
    createdAt: event.createdAt instanceof Date ? event.createdAt.toISOString() : event.createdAt ?? null,
  }));

  const promptBody = JSON.stringify({
    workflow: scrubPromptSecretShapes(workflow),
    failedNodeId,
    errorJson: scrubPromptSecretShapes(errorJson),
    runEvents: promptEvents,
    // The route narrates per-type contracts the LLM can't infer from
    // the workflow alone (e.g. registered tool input field names).
    // Scrubbed for parity with the rest of the body.
    ...(extraContext ? { extraContext: scrubPromptSecretShapes(extraContext) } : {}),
  });

  try {
    const result = await llm.generateObject<PatchEnvelopeSchemaResult>({
      // The caller's Zod schema goes through unchanged — the LLM client
      // forwards it to the provider's structured-output enforcement.
      // The route picks one concrete envelope per failing-node type so
      // the compiled JSON Schema has no `oneOf` keyword (works on
      // OpenAI strict mode AND fits Anthropic's grammar cap). The
      // 1-3 array form is one repeated `items` constraint, not three
      // branches — the compiled grammar stays compact.
      schema: envelopeSchema,
      schemaName: "JanuslyWorkflowPatch",
      schemaDescription: "1-3 alternative config patches for the failing node, ordered most-likely-fix first.",
      // Append the locale instruction to the active system prompt
      // (whether it's the default config-patch one or the structural
      // override). The suffix is empty for `en`, so the eval suite's
      // existing assertions stay stable.
      system: (systemPromptOverride ?? SYSTEM_PROMPT) + localeInstructionForLlm(locale),
      prompt: promptBody,
      modelHint: model,
      context,
    });
    // The route is responsible for merging each `patchedConfig` into a
    // full workflow, validating, and degrading to fallback when no
    // suggestions survive. The helper returns the LLM-emitted array
    // verbatim so the route keeps schema-validation responsibilities
    // in one place.
    return {
      mode: "ai",
      suggestions: result.object.suggestions,
      model: result.model,
      provider: result.provider,
    };
  } catch (error) {
    return {
      mode: "fallback",
      suggestions: [{
        patchedConfig: {},
        rationale: `${FALLBACK_RATIONALE_NO_LLM} (Reason: ${error instanceof Error ? error.message : String(error)})`,
        approachLabel: "other",
        confidence: 0,
      }],
      aiError: error instanceof Error ? error.message : String(error),
    };
  }
}

function scrubPromptSecretShapes(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return scrubString(value);
  if (!value || typeof value !== "object") return value;

  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (value instanceof Date) {
    seen.delete(value);
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    const scrubbed = value.map((item) => scrubPromptSecretShapes(item, seen));
    seen.delete(value);
    return scrubbed;
  }

  const scrubbed = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      scrubPromptSecretShapes(item, seen),
    ]),
  );
  seen.delete(value);
  return scrubbed;
}

function scrubString(value: string): string {
  let output = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    output = output.replace(pattern, "[redacted]");
  }
  return output;
}
