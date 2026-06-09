/**
 * Internal HTTP wrapper for the Janusly SDK. Every resource method routes
 * through `sendApiRequest` — this is the single place that touches `fetch`,
 * injects auth headers, applies the opt-in retry layer, composes
 * AbortSignals, and unwraps error envelopes into typed errors.
 */

import {
  JanuslyApiError,
  JanuslyRateLimitError,
  type JanuslyApiErrorEnvelope,
} from "./errors.ts";
import type {
  JanuslyAuthMode,
  JanuslyClientConfig,
  JanuslyLogger,
  JanuslyRequestOptions,
  JanuslyRetryConfig,
} from "./types.ts";

/** Default per-call timeout. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Default actor id sent as `x-user-id` in service-token mode. */
export const DEFAULT_SDK_USER_ID = "sdk-user";
/** Default User-Agent prefix the SDK identifies as. */
export const DEFAULT_USER_AGENT = "janusly-sdk-node/0.0.1";

const DEFAULT_RETRY_ON: ReadonlyArray<number> = [429, 502, 503, 504];

/**
 * Header names the SDK manages itself — a caller-supplied per-call header
 * that collides with any of these is rejected (see `buildHeaders`). All
 * lowercased for case-insensitive comparison. `authorization` / `x-org-id`
 * / `x-user-id` carry auth + tenant identity (overriding them is an
 * auth/tenant-confusion vector); `content-type` / `accept` / `user-agent`
 * are set by the transport (e.g. the SDK JSON-encodes the body and sets
 * `content-type: application/json`, so a caller override would silently
 * break the request). Mirrors the Python SDK's `_RESERVED_HEADERS`.
 */
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "accept",
  "user-agent",
  "x-org-id",
  "x-user-id",
  "content-type",
]);

export type SendRequestInput = {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string;
  body?: Record<string, unknown>;
  asAttachment?: boolean;
};

export type AttachmentResponse = {
  body: string;
  filename: string;
  contentType: string;
};

export async function sendApiRequest(
  config: JanuslyClientConfig,
  input: SendRequestInput,
  options?: JanuslyRequestOptions,
): Promise<unknown> {
  const logger: JanuslyLogger = config.logger ?? {};
  const retry = config.retry;
  // Compose headers ONCE, before the retry loop. The reserved-header guard
  // in `buildHeaders` is deterministic — composing inside the thunk would
  // both re-run identical work each attempt AND retry the guard's throw.
  const headers = buildHeaders(config, input, options);
  return withRetries(
    () => performSingleRequest(config, input, options, logger, headers),
    retry,
    logger,
    options?.signal,
  );
}

async function performSingleRequest(
  config: JanuslyClientConfig,
  input: SendRequestInput,
  options: JanuslyRequestOptions | undefined,
  logger: JanuslyLogger,
  headers: Record<string, string>,
): Promise<unknown> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const path = normalizePath(input.path);
  const url = `${baseUrl}${path}`;

  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signals: AbortSignal[] = [timeoutController.signal];
  if (options?.signal) signals.push(options.signal);
  const composedSignal = AbortSignal.any(signals);

  const init: RequestInit = { method: input.method, headers, signal: composedSignal };
  if (input.body !== undefined && input.method !== "GET") {
    init.body = JSON.stringify(input.body);
  }

  const fetchImpl = config.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!res.ok) {
    const body = await readBodyAsJson(res, logger);
    throw JanuslyApiError.fromResponse(res, body);
  }

  if (input.asAttachment) {
    const body = await res.text();
    return {
      body,
      filename: extractAttachmentFilename(res.headers.get("content-disposition")),
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    } satisfies AttachmentResponse;
  }

  if (res.status === 204) return undefined;
  return readBodyAsJson(res, logger);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function normalizePath(path: string): string {
  if (path.length === 0) return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * Compose the headers for one request: the SDK-managed set (accept,
 * x-org-id, user-agent, conditionally content-type, plus auth) followed
 * by any caller-supplied per-call headers. Throws `TypeError` when a
 * caller header collides with a {@link RESERVED_HEADERS} name. The throw
 * is deterministic, so callers MUST compose headers once before the retry
 * loop (see `sendApiRequest`) — it must never be retried.
 */
function buildHeaders(
  config: JanuslyClientConfig,
  input: SendRequestInput,
  options: JanuslyRequestOptions | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    "accept": "application/json",
    "x-org-id": config.orgId,
    "user-agent": config.userAgent
      ? `${DEFAULT_USER_AGENT} ${config.userAgent}`
      : DEFAULT_USER_AGENT,
  };

  if (input.body !== undefined && input.method !== "GET") {
    headers["content-type"] = "application/json";
  }

  applyAuthHeaders(headers, config.auth);

  if (options?.headers) {
    for (const [key, value] of Object.entries(options.headers)) {
      const lower = key.toLowerCase();
      // Reject — don't silently drop — a collision with an SDK-managed
      // header so a caller learns immediately rather than shipping a
      // silently-broken request. Deterministic, so `buildHeaders` is
      // composed once BEFORE the retry loop and this never retries.
      if (RESERVED_HEADERS.has(lower)) {
        throw new TypeError(`custom header "${key}" collides with a reserved header`);
      }
      headers[lower] = value;
    }
  }
  return headers;
}

function applyAuthHeaders(headers: Record<string, string>, auth: JanuslyAuthMode): void {
  if (auth.kind === "service-token") {
    headers["authorization"] = `Bearer ${auth.token}`;
    headers["x-user-id"] = auth.userId ?? DEFAULT_SDK_USER_ID;
    return;
  }
  if (auth.kind === "bearer") {
    headers["authorization"] = `Bearer ${auth.token}`;
    return;
  }
  const _exhaustive: never = auth;
  void _exhaustive;
}

async function readBodyAsJson(res: Response, logger: JanuslyLogger): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    const text = await res.text();
    logger.warn?.("janusly-sdk: non-JSON response", { contentType, preview: text.slice(0, 200) });
    return { error: text } satisfies JanuslyApiErrorEnvelope;
  }
  try {
    return await res.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : "json parse failed";
    logger.warn?.("janusly-sdk: JSON parse failed", { message });
    return { error: message } satisfies JanuslyApiErrorEnvelope;
  }
}

export function extractAttachmentFilename(disposition: string | null): string {
  if (!disposition) return "download.bin";
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const asciiMatch = /filename="([^"]+)"/.exec(disposition);
  return asciiMatch?.[1] ?? "download.bin";
}

async function withRetries<T>(
  fn: () => Promise<T>,
  retry: JanuslyRetryConfig | undefined,
  logger: JanuslyLogger,
  signal: AbortSignal | undefined,
): Promise<T> {
  const maxAttempts = retry?.maxAttempts ?? 0;
  const backoffMs = retry?.backoffMs ?? 200;
  const retryOn = retry?.retryOn ?? DEFAULT_RETRY_ON;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      // User-driven cancellation must never be retried — that would
      // both ignore the caller's intent AND introduce a backoff-sum
      // latency before the abort finally surfaces. AbortError names
      // are stable across Node / DOM specs.
      if (signal?.aborted) break;
      if (err instanceof Error && err.name === "AbortError") break;
      if (err instanceof JanuslyApiError && !retryOn.includes(err.statusCode)) break;
      const delayMs = err instanceof JanuslyRateLimitError && err.retryAfterSeconds !== undefined
        ? Math.max(0, err.retryAfterSeconds) * 1000
        : backoffMs * Math.pow(2, attempt);
      logger.warn?.("janusly-sdk: retry", {
        attempt: attempt + 1,
        delayMs,
        statusCode: err instanceof JanuslyApiError ? err.statusCode : undefined,
      });
      try {
        await sleep(delayMs, signal);
      } catch {
        // Abort during retry-sleep — rethrow the ORIGINAL error so the
        // caller sees the upstream failure (not a synthetic AbortError
        // from the sleep wrapper). Abort latency is still bounded by
        // the sleep promise rejecting fast.
        break;
      }
    }
  }
  throw lastErr;
}

/**
 * Promise-wrapped `setTimeout` that resolves after `ms` OR rejects with
 * an AbortError if the supplied signal fires. Removes the abort listener
 * on the resolve path to avoid leaking listeners across many retries.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let onAbort: (() => void) | null = null;
    const handle = setTimeout(() => {
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(handle);
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    onAbort = () => {
      clearTimeout(handle);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
