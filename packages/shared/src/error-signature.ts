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
  /\bsk-[A-Za-z0-9]{20,}\b/g, // OpenAI / Anthropic / similar prefix
  /\bghp_[A-Za-z0-9]{20,}\b/g, // GitHub personal access token
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bBearer\s+[A-Za-z0-9_\-.]{16,}\b/gi, // Authorization header value
  /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g, // JWT (3-segment base64url)
];

/**
 * Replace every known secret-shape substring with `"[redacted]"`. Pure
 * helper, exported so the cluster aggregator can call it on category
 * outputs that pass through user-supplied substrings (e.g. tool name).
 */
export function scrubSecretShapes(input: string): string {
  let output = input;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    output = output.replace(pattern, "[redacted]");
  }
  return output;
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
const HTTP_STATUS_PATTERN = /\bHTTP\s+(\d{3})\b/i;
const NETWORK_FAILURE_PATTERN = /\b(?:timeout|timed\s+out|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN)\b/i;
const PARSE_ERROR_PATTERN = /\b(?:invalid\s+JSON|JSON\.parse|unexpected\s+token|parse\s+error)\b/i;
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
