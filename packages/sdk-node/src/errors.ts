/**
 * Typed error class hierarchy for the Janusly SDK.
 *
 * Inspired by OpenAI / Anthropic Node SDKs: consumers can `instanceof` the
 * subclasses instead of switching on `statusCode`. The base
 * `JanuslyApiError` carries the structured envelope (`code` + `params`)
 * from `apps/api/src/error-codes.ts` so translation helpers downstream can
 * resolve catalog keys.
 *
 * Status → subclass mapping:
 *   401, 403           → JanuslyAuthError
 *   400, 422           → JanuslyValidationError
 *   429                → JanuslyRateLimitError (carries retryAfterSeconds)
 *   500-599            → JanuslyServerError
 *   anything else      → JanuslyApiError (base)
 *
 * `JanuslyWebhookSignatureError` is a sibling — distinct from API errors
 * because webhook verification doesn't go through `fetch`.
 */

/** Server error envelope shape. Source: `apps/api/src/error-codes.ts`. */
export type JanuslyApiErrorEnvelope = {
  error?: string | {
    message?: string;
    code?: string;
    params?: Record<string, unknown>;
  };
  code?: string;
  params?: Record<string, unknown>;
};

type ExtractedApiErrorEnvelope = {
  error?: string;
  code?: string;
  params?: Record<string, unknown>;
};

/** Base class for every HTTP error the SDK surfaces. */
export class JanuslyApiError extends Error {
  override readonly name: string = "JanuslyApiError";
  readonly statusCode: number;
  readonly code?: string;
  readonly params?: Record<string, unknown>;

  constructor(message: string, opts: { statusCode: number; code?: string; params?: Record<string, unknown> }) {
    super(message);
    this.statusCode = opts.statusCode;
    if (opts.code !== undefined) this.code = opts.code;
    if (opts.params !== undefined) this.params = opts.params;
  }

  /**
   * Factory: parses an HTTP `Response` + its (already-read) body into the
   * right typed subclass. Body is `unknown` because the caller has already
   * unwrapped it to JSON (or fallen back to text); we accept whatever they
   * pass and extract envelope fields defensively.
   *
   * Retry-After is read from the response headers for 429s only — it can
   * arrive as either a seconds-integer or an HTTP-date per RFC 9110.
   */
  static fromResponse(res: Response, body: unknown): JanuslyApiError {
    const envelope = extractEnvelope(body);
    const message = envelope.error ?? `HTTP ${res.status} ${res.statusText || ""}`.trim();
    const opts = {
      statusCode: res.status,
      code: envelope.code,
      params: envelope.params,
    };
    if (res.status === 401 || res.status === 403) {
      return new JanuslyAuthError(message, opts);
    }
    if (res.status === 400 || res.status === 422) {
      return new JanuslyValidationError(message, opts);
    }
    if (res.status === 429) {
      const retryAfterSeconds = parseRetryAfterSeconds(res.headers.get("retry-after"));
      return new JanuslyRateLimitError(message, { ...opts, retryAfterSeconds });
    }
    if (res.status >= 500 && res.status < 600) {
      return new JanuslyServerError(message, opts);
    }
    return new JanuslyApiError(message, opts);
  }
}

/** Thrown on 401 / 403 (missing or rejected auth header). */
export class JanuslyAuthError extends JanuslyApiError {
  override readonly name = "JanuslyAuthError";
}

/** Thrown on 400 / 422 (request body shape rejected by the server). */
export class JanuslyValidationError extends JanuslyApiError {
  override readonly name = "JanuslyValidationError";
}

/**
 * Thrown on 429 (rate-limit gate fired). The optional `retryAfterSeconds`
 * field is parsed from the `Retry-After` response header. Callers using the
 * opt-in retry layer get this respected automatically; callers handling
 * 429s by hand should `await sleep(err.retryAfterSeconds! * 1000)` before
 * retrying.
 */
export class JanuslyRateLimitError extends JanuslyApiError {
  override readonly name = "JanuslyRateLimitError";
  readonly retryAfterSeconds?: number;
  constructor(
    message: string,
    opts: { statusCode: number; code?: string; params?: Record<string, unknown>; retryAfterSeconds?: number },
  ) {
    super(message, opts);
    if (opts.retryAfterSeconds !== undefined) this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

/** Thrown on 5xx (server-side failure, retryable by default). */
export class JanuslyServerError extends JanuslyApiError {
  override readonly name = "JanuslyServerError";
}

/** Thrown when a successful `/v1` response does not match the stable envelope. */
export class JanuslyProtocolError extends JanuslyApiError {
  override readonly name = "JanuslyProtocolError";
}

/**
 * Thrown by `client.webhooks.verifySignature` when the inbound signature
 * fails. The `reason` field distinguishes tamper from skew from malformed
 * header so logging can branch.
 */
export class JanuslyWebhookSignatureError extends Error {
  override readonly name = "JanuslyWebhookSignatureError";
  readonly reason: "malformed_header" | "timestamp_skew" | "signature_mismatch";
  constructor(message: string, reason: "malformed_header" | "timestamp_skew" | "signature_mismatch") {
    super(message);
    this.reason = reason;
  }
}

/**
 * Thrown by `pollUntilTerminal` when the wall-clock timeout elapses
 * before the run reaches a terminal status. Carries a stable `code` so
 * consumers can distinguish it from real API errors.
 */
export class JanuslyTimeoutError extends JanuslyApiError {
  override readonly name = "JanuslyTimeoutError";
  constructor(message: string) {
    super(message, { statusCode: 0, code: "polling_timeout" });
  }
}

function extractEnvelope(body: unknown): ExtractedApiErrorEnvelope {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const obj = body as Record<string, unknown>;
  const out: ExtractedApiErrorEnvelope = {};
  if (typeof obj.error === "string") out.error = obj.error;
  if (obj.error && typeof obj.error === "object" && !Array.isArray(obj.error)) {
    const nested = obj.error as Record<string, unknown>;
    if (typeof nested.message === "string") out.error = nested.message;
    if (typeof nested.code === "string") out.code = nested.code;
    if (nested.params && typeof nested.params === "object" && !Array.isArray(nested.params)) {
      out.params = nested.params as Record<string, unknown>;
    }
  }
  if (typeof obj.code === "string") out.code = obj.code;
  if (obj.params && typeof obj.params === "object" && !Array.isArray(obj.params)) {
    out.params = obj.params as Record<string, unknown>;
  }
  return out;
}

/**
 * Parse the `Retry-After` header. Per RFC 9110 it can be either a
 * decimal seconds count OR an HTTP-date. Returns undefined when neither
 * shape parses.
 */
export function parseRetryAfterSeconds(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  // Seconds-integer form.
  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }
  // HTTP-date form.
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return undefined;
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return 0;
  return Math.ceil(diffMs / 1000);
}
