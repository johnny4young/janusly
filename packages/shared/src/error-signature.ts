/**
 * Pure normalizer that extracts a stable, human-readable cluster label
 * (the "signature") from a raw error object surfaced by a failed node.
 * Used by the failure-clustering surface so the operator sees `"Missing
 * secret: GITHUB_TOKEN"` and `"HTTP 401 on http node"` rolled-up across
 * all runs that hit the same problem, instead of one DLQ row per
 * occurrence.
 *
 * Rules apply first-match-wins in the priority order documented below.
 * The fallback path takes the raw `error.message`, scrubs known
 * secret-shape substrings, and truncates to 80 chars so an unrecognised
 * error still produces a useful (though long-tail) signature.
 *
 * Hard safety property: **no secret value ever appears in the returned
 * signature**. The persistence chokepoint (`safe-persist.ts`) already
 * key-redacts the JSON we read from, but free-form error MESSAGES can
 * still carry token-shaped substrings (e.g. an upstream's response that
 * echoed the request's `Authorization: Bearer …` header back). The
 * `SECRET_VALUE_PATTERNS` scrub at the end of this module is the last
 * line of defence against that.
 *
 * Lives in `@janusly/shared` (zero runtime deps) so it can be imported
 * from both the engine (the failure-clustering surface) and the web
 * bundle (the recovery dialog's same-failure check). The engine
 * re-exports for back-compat with consumers importing
 * `@janusly/engine/src/error-signature`.
 *
 * Used by:
 *   - `packages/engine/src/cluster-failures.ts` (the aggregator).
 *   - `packages/data/src/failureClusterRepo.ts` exposes the samples.
 *   - `apps/api/src/index.ts:GET /dlq/clusters` ties them together.
 *   - `apps/api/src/index.ts:GET /workflows/health/delta` runs the
 *     same-failure check against the caller-supplied prior signature.
 *   - `apps/web/src/components/RecoveryDialog.tsx` derives the prior
 *     signature from the source DLQ before calling the delta route.
 *
 * Pure — no I/O, no network, no DB access. Easy to unit-test.
 */

/** Closed taxonomy of error categories. Adding a new branch means adding a rule below. */
export type ErrorCategory =
  | "secret_missing"
  | "http_error"
  | "network_timeout"
  | "ai_provider"
  | "parse_error"
  | "tool_input"
  | "unknown";

/** Best-guess team to route the cluster to. Heuristic, not authoritative. */
export type SuggestedOwner = "ops" | "workflow_author" | "platform";

/** Result returned by `normalizeErrorSignature`. */
export type SignatureResult = {
  /** Stable label safe to render in the UI. Never contains raw secret values. */
  signature: string;
  category: ErrorCategory;
  /** Best-guess owner pool for the cluster. */
  suggestedOwner: SuggestedOwner;
};

export type ErrorContext = {
  /** Failing node's type (e.g. `"http"`, `"ai"`, `"tool"`, `"agent"`). Surfaces in the signature. */
  nodeType?: string;
  /** Optional node id — currently unused by the normalizer but kept for future rules. */
  nodeId?: string;
  /** Resolved tool name when `nodeType === "tool"` — used by the `tool_input` rule. */
  toolName?: string;
};

/** Maximum length for fallback-signature messages. 80 chars keeps cluster rows tidy. */
export const FALLBACK_SIGNATURE_MAX_LENGTH = 80;

/**
 * Defense-in-depth secret-shape patterns. Applied to every produced
 * signature (every category, every fallback). The persistence chokepoint
 * already key-redacts the stored JSON before the normalizer reads it,
 * but error MESSAGES are free-form strings outside any key-redaction
 * pass — these patterns catch known token shapes that would otherwise
 * leak into a cluster label.
 *
 * Add a new pattern here when a new token shape appears in the wild;
 * never widen an existing pattern without thinking about false positives.
 */
export const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /(^|[^A-Za-z0-9])(sk-[A-Za-z0-9]{20,})(?=$|[^A-Za-z0-9])/g, // OpenAI / Anthropic / similar prefix
  /(^|[^A-Za-z0-9])(ghp_[A-Za-z0-9]{20,})(?=$|[^A-Za-z0-9])/g, // GitHub personal access token
  /(^|[^A-Za-z0-9])(xox[baprs]-[A-Za-z0-9-]{10,})(?=$|[^A-Za-z0-9])/g, // Slack tokens
  /(^|[^A-Za-z0-9])(AKIA[0-9A-Z]{16})(?=$|[^A-Za-z0-9])/g, // AWS access key id
  /(^|[^A-Za-z0-9])(Bearer\s+[A-Za-z0-9_\-.]{16,})(?=$|[^A-Za-z0-9])/gi, // Authorization header value
  /(^|[^A-Za-z0-9])(eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,})(?=$|[^A-Za-z0-9])/g, // JWT (3-segment base64url)
];

/**
 * Replace every known secret-shape substring with `"[redacted]"`. Pure
 * helper, exported so the cluster aggregator can call it on category
 * outputs that pass through user-supplied substrings (e.g. tool name).
 */
export function scrubSecretShapes(input: string): string {
  let output = input;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    output = output.replace(pattern, (_match, prefix: string) => `${prefix}[redacted]`);
  }
  return output;
}

/** Cap for `sanitizeMcpToolDescription`. Trades a small loss of descriptive context for a bounded prompt-injection blast radius per tool. */
export const MAX_MCP_DESCRIPTION_CHARS = 300;

/** Cap for prompt-facing MCP aliases / tool names. These are labels, not execution identifiers. */
export const MAX_MCP_PROMPT_LABEL_CHARS = 120;

/** Closed regex matching ASCII control characters (newlines, tabs, NUL, etc.) — the cheapest prompt-injection vector when the description gets pasted into a system prompt. */
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/g;

/**
 * Closed regex matching the Unicode-categorical block we strip before the
 * ASCII control-char pass. Covers four classes of invisible / direction-
 * altering characters that a malicious MCP server can use to steer an LLM
 * without being visually detectable in operator-facing UIs:
 *
 *  - `U+200B–U+200F`: zero-width space / non-joiner / joiner / LTR + RTL marks.
 *  - `U+202A–U+202E`: left-to-right + right-to-left embedding / override.
 *  - `U+2060–U+2069`: word joiner + invisible separators + invisible operators.
 *  - `U+2066–U+2069`: directional isolate codes.
 *  - `U+FEFF`: BOM / zero-width no-break space.
 *
 * Cyrillic / Greek visual look-alikes (е, а, о, etc.) are NOT in this set —
 * they have legitimate use in non-Latin descriptions and stripping them
 * would break correctness for those operators. The operator opt-in
 * (`mcp_tool_descriptors.expose_to_ai`) + the LLM suspicion-framing escape
 * clause cover the residual homoglyph risk.
 */
const UNICODE_INJECTION_PATTERN = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

/** Closed regex for anything that is unsafe inside the `- alias.tool:` prompt label. */
const MCP_PROMPT_LABEL_UNSAFE_PATTERN = /[^A-Za-z0-9_.-]+/g;

/**
 * NFKC-normalise the input and strip the Unicode-injection block. This
 * runs as the FIRST pass on every MCP description / label before the
 * control-char strip + secret scrub + length cap. NFKC composes look-
 * alike sequences (fullwidth → halfwidth, decomposed → composed) into
 * canonical form so a description that visually reads "Ignore previous"
 * but is encoded with combining marks won't slip past a downstream
 * heuristic that compares against literal English keywords.
 *
 * The function is pure + idempotent + safe on ASCII (no-op) and on
 * legitimate non-Latin Unicode (only the injection-block chars are
 * dropped — accented letters, CJK, Cyrillic body text all pass).
 */
function applyUnicodeHardening(input: string): string {
  return input.normalize("NFKC").replace(UNICODE_INJECTION_PATTERN, "");
}

/**
 * Sanitise an MCP tool description before it gets injected into the
 * AI Studio's system prompt. Defense in depth:
 *
 *   1. Strip ASCII control characters (newlines, tabs, NUL bytes).
 *      Newlines are the easiest way for a malicious server description
 *      to break out of the surrounding list-item framing.
 *   2. Run `scrubSecretShapes` so a description that includes a token
 *      shape (sk-*, ghp_*, Bearer …, JWT, AWS key, Slack token) lands
 *      as `[redacted]` in the prompt.
 *   3. Length-cap at 300 chars with an ellipsis. A single description
 *      can't inflate the system prompt unbounded; the per-org call to
 *      `listExposedMcpToolsForAi` then caps the total prose at 20 KB.
 *
 * Returns `"(no description)"` for null / empty input so the prompt
 * line stays structurally consistent even when an MCP server omits
 * the description.
 */
export function sanitizeMcpToolDescription(description: string | null | undefined): string {
  if (typeof description !== "string" || description.length === 0) return "(no description)";
  // NFKC normalise + drop zero-width / RTL-override / format / BOM chars
  // BEFORE the existing ASCII control-char strip. The Unicode pass closes
  // the gap where a hostile description can sneak invisible characters
  // (e.g. zero-width space inside "SYSTEM OVERRIDE") past the ASCII-only
  // filter and steer downstream LLM tokenisation.
  const unicoded = applyUnicodeHardening(description);
  const stripped = unicoded.replace(CONTROL_CHAR_PATTERN, " ");
  const scrubbed = scrubSecretShapes(stripped);
  if (scrubbed.length <= MAX_MCP_DESCRIPTION_CHARS) return scrubbed;
  return scrubbed.slice(0, MAX_MCP_DESCRIPTION_CHARS - 1) + "…";
}

/**
 * Sanitise a prompt-facing MCP connection alias or tool name. MCP tool
 * names are discovered from third-party servers, so they are treated as
 * untrusted prompt data just like descriptions. This helper deliberately
 * returns a label for AI awareness, not the canonical runtime tool name.
 */
export function sanitizeMcpPromptLabel(label: string | null | undefined, fallback = "unnamed"): string {
  if (typeof label !== "string" || label.length === 0) return fallback;
  // Same Unicode hardening as the description sanitiser — NFKC + drop
  // the injection block — runs first so a label like `"pages.update\u200BSYSTEM"`
  // becomes `"pages.updateSYSTEM"` before the label-unsafe regex turns it
  // into a single safe token.
  const unicoded = applyUnicodeHardening(label);
  const stripped = scrubSecretShapes(unicoded.replace(CONTROL_CHAR_PATTERN, " "));
  const safe = stripped
    .trim()
    .replace(/\s+/g, "_")
    .replace(MCP_PROMPT_LABEL_UNSAFE_PATTERN, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (safe.length === 0) return fallback;
  if (safe.length <= MAX_MCP_PROMPT_LABEL_CHARS) return safe;
  return safe.slice(0, MAX_MCP_PROMPT_LABEL_CHARS);
}

/** Normalize one error into a `{ signature, category, suggestedOwner }` triple. */
export function normalizeErrorSignature(error: unknown, context: ErrorContext = {}): SignatureResult {
  const nodeType = context.nodeType ?? "node";
  const message = readErrorMessage(error);
  const errorObj = isPlainObject(error) ? (error as Record<string, unknown>) : null;

  // 1. Secret missing — by error code, then by message regex.
  const secretFromCode = errorObj && errorObj.code === "E_SECRET_MISSING" && typeof errorObj.secret === "string"
    ? errorObj.secret
    : null;
  const secretFromMessage = matchSecretMissing(message);
  const secretName = secretFromCode ?? secretFromMessage;
  if (secretName) {
    return {
      signature: `Missing secret: ${scrubSecretShapes(sanitiseIdentifier(secretName))}`,
      category: "secret_missing",
      suggestedOwner: "ops",
    };
  }

  // 2. HTTP error — explicit statusCode wins; fall back to message regex.
  const statusFromField = errorObj && typeof errorObj.statusCode === "number" && Number.isFinite(errorObj.statusCode)
    ? errorObj.statusCode
    : null;
  const statusFromMessage = matchHttpStatus(message);
  const status = statusFromField ?? statusFromMessage;
  if (typeof status === "number" && status >= 400 && status < 600) {
    return {
      signature: `HTTP ${status} on ${nodeType} node`,
      category: "http_error",
      suggestedOwner: "workflow_author",
    };
  }

  // 3. Network timeout / connection failures.
  if (NETWORK_FAILURE_PATTERN.test(message)) {
    return {
      signature: `Network timeout on ${nodeType} node`,
      category: "network_timeout",
      suggestedOwner: "workflow_author",
    };
  }

  // 3b. Generic (non-AI) rate limit — platform/integration limiter or upstream
  //     429. Runs before the AI rule so a tool/http rate-limit doesn't
  //     mis-cluster as an AI-provider issue; only claims it with NO AI context.
  const aiContext = nodeType === "ai" || nodeType === "agent" || nodeType === "multi_agent" ||
    (errorObj != null && (typeof errorObj.provider === "string" || typeof errorObj.aiError === "string"));
  if (!aiContext && RATE_LIMIT_PATTERN.test(message)) {
    return {
      signature: `Rate limited on ${nodeType} node`,
      category: "http_error",
      suggestedOwner: "workflow_author",
    };
  }

  // 3c. HTTP-layer guard failures (body cap / redirect cap / SSRF block / protocol).
  if (HTTP_GUARD_PATTERN.test(message)) {
    return {
      signature: `HTTP guard failed on ${nodeType} node`,
      category: "http_error",
      suggestedOwner: "workflow_author",
    };
  }

  // 4. AI provider — explicit aiError or message hint.
  const aiReason = matchAiProviderReason(error, message);
  if (aiReason) {
    const provider = inferAiProvider(error, context);
    return {
      signature: `${provider} ${aiReason}`,
      category: "ai_provider",
      suggestedOwner: "platform",
    };
  }

  // 5. Parse / JSON error.
  if (PARSE_ERROR_PATTERN.test(message)) {
    return {
      signature: `Parse error in ${nodeType} node`,
      category: "parse_error",
      suggestedOwner: "workflow_author",
    };
  }

  // 6. Tool-shape errors.
  const toolInputMatch = matchToolError(message);
  if (toolInputMatch) {
    const labeledTool = context.toolName ?? toolInputMatch.tool;
    const cleanTool = labeledTool ? scrubSecretShapes(sanitiseIdentifier(labeledTool)) : "tool";
    const verb = toolInputMatch.kind === "not_found" ? "Tool not found" : "Invalid tool input";
    return {
      signature: `${verb}: ${cleanTool}`,
      category: "tool_input",
      suggestedOwner: "workflow_author",
    };
  }

  // 7. Fallback — scrub + truncate the raw message.
  return {
    signature: truncate(scrubSecretShapes(message), FALLBACK_SIGNATURE_MAX_LENGTH),
    category: "unknown",
    suggestedOwner: "workflow_author",
  };
}

/* ----------------------------- Pattern matchers ---------------------------- */

const SECRET_NOT_FOUND_PATTERN = /secret\s+['"]?([\w\-_.]+)['"]?\s+not\s+found/i;
const ENV_MISSING_PATTERN = /Missing\s+(?:env(?:ironment)?\s+)?variable[: ]+([\w\-_.]+)/i;
// The generic integration/MCP chokepoint error ("credential secret missing
// for <name>" — the env-var NAME is never echoed; <name> is the operator's
// credential name) and the plain "Missing secret: <name>" phrasing.
const CREDENTIAL_MISSING_PATTERN = /credential\s+secret\s+missing\s+for\s+['"]?([\w\-_.]+)/i;
const MISSING_SECRET_PATTERN = /Missing\s+secret[: ]+['"]?([\w\-_.]+)/i;
const HTTP_STATUS_PATTERN = /\bHTTP\s+(\d{3})\b/i;
const NETWORK_FAILURE_PATTERN = /\b(?:timeout|timed\s+out|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ECONNABORTED|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ENETDOWN|EPIPE|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET))\b|getaddrinfo|did\s+not\s+resolve\s+to\s+any\s+address|fetch\s+failed/i;
const PARSE_ERROR_PATTERN = /\b(?:invalid\s+JSON|is\s+not\s+valid\s+JSON|JSON\.parse|unexpected\s+token|unexpected\s+end\s+of\s+JSON|parse\s+error|in\s+JSON\s+at\s+position|expected\s+property\s+name)\b/i;
// http-policy.ts chokepoint guard failures (body-cap abort, redirect cap, SSRF
// private block, unsupported protocol) — all reached the HTTP layer → http_error.
const HTTP_GUARD_PATTERN = /\b(?:exceeds?\s+maxResponseBytes|redirect\s+limit\s+exceeded|target\s+is\s+private\s+and\s+blocked|resolves?\s+to\s+a\s+private\s+address|Unsupported\s+HTTP\s+target\s+protocol|response\s+(?:body\s+)?too\s+large)\b/i;
// Platform/integration limiter ("Rate limit exceeded for <bucket>. Retry in Ns.")
// and bare upstream 429 wording.
const RATE_LIMIT_PATTERN = /\b(?:rate[_\s-]?limit(?:ed|s)?\s+(?:exceeded|reached|hit)|429\s+too\s+many\s+requests|too\s+many\s+requests)\b/i;
const TOOL_INVALID_PATTERN = /(?:tool\s+input\s+(?:did\s+not\s+match|invalid)|invalid\s+tool\s+input)(?:\s+for\s+['"]?([\w\-_.]+)['"]?|[: ]+['"]?([\w\-_.]+)['"]?)?/i;
const TOOL_NOT_FOUND_PATTERN = /tool\s+['"]?([\w\-_.]+)['"]?\s+not\s+found/i;

const AI_PROVIDER_REASONS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bcontext[_\s]?length(?:_exceeded)?\b|\bcontext\s+too\s+long\b/i, reason: "context too long" },
  { pattern: /\binsufficient_quota\b|\bquota\s+exceeded\b/i, reason: "quota exceeded" },
  { pattern: /\brate[_\s]?limit(?:ed|s)?\b/i, reason: "rate limit" },
  { pattern: /\bmodel\s+not\s+found\b|\bunknown\s+model\b/i, reason: "model not found" },
];

function matchSecretMissing(message: string): string | null {
  const direct = message.match(SECRET_NOT_FOUND_PATTERN);
  if (direct?.[1]) return direct[1];
  const env = message.match(ENV_MISSING_PATTERN);
  if (env?.[1]) return env[1];
  const cred = message.match(CREDENTIAL_MISSING_PATTERN);
  if (cred?.[1]) return cred[1];
  const missing = message.match(MISSING_SECRET_PATTERN);
  if (missing?.[1]) return missing[1];
  return null;
}

function matchHttpStatus(message: string): number | null {
  const match = message.match(HTTP_STATUS_PATTERN);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

function matchAiProviderReason(error: unknown, message: string): string | null {
  // 1. Explicit `aiError` field on the error envelope (the AI fallback contract
  //    sets this when a provider call degrades).
  const errorObj = isPlainObject(error) ? (error as Record<string, unknown>) : null;
  const aiErrorField = errorObj && typeof errorObj.aiError === "string" ? errorObj.aiError : null;
  const haystack = aiErrorField ? `${aiErrorField} ${message}` : message;
  for (const candidate of AI_PROVIDER_REASONS) {
    if (candidate.pattern.test(haystack)) return candidate.reason;
  }
  return null;
}

function inferAiProvider(error: unknown, context: ErrorContext): string {
  const errorObj = isPlainObject(error) ? (error as Record<string, unknown>) : null;
  const provider = errorObj && typeof errorObj.provider === "string" ? errorObj.provider.toLowerCase() : null;
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Anthropic";
  if (context.nodeType === "ai" || context.nodeType === "agent" || context.nodeType === "multi_agent") {
    return "AI";
  }
  return "AI";
}

function matchToolError(message: string): { kind: "invalid" | "not_found"; tool: string | null } | null {
  const notFound = message.match(TOOL_NOT_FOUND_PATTERN);
  if (notFound) return { kind: "not_found", tool: notFound[1] ?? null };
  const invalid = message.match(TOOL_INVALID_PATTERN);
  if (invalid) {
    const tool = invalid[1] ?? invalid[2] ?? null;
    return { kind: "invalid", tool };
  }
  return null;
}

/* ------------------------------- Utilities -------------------------------- */

function readErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (isPlainObject(error)) {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
  }
  return "Unknown error";
}

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strip non-identifier characters from a captured group before embedding
 * it in a signature. Defends against `secret 'GITHUB_TOKEN; DROP TABLE'
 * not found` style malicious echoes.
 */
function sanitiseIdentifier(input: string): string {
  return input.replace(/[^\w\-.]/g, "").slice(0, 64);
}

function truncate(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  return `${input.slice(0, maxLength - 1).trimEnd()}…`;
}
