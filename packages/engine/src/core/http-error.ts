/**
 * Typed error for a non-OK HTTP response from an `http` node or the
 * `http.request` tool.
 *
 * Why a class instead of `new Error(\`HTTP failed: ${status}\`)`: the retry
 * vocabulary is built on `classifyError`, which reads `error.statusCode` to
 * emit the `"429"` / `"5xx"` labels. A plain Error carries the status only
 * inside its message, so every `retryOn: ["5xx"]` policy — the one the AI
 * patch surface and the readiness rule both recommend — silently never
 * matched for the most common node type in the product.
 *
 * Used by `node-executors/transport.ts` (http node, both the buffered and
 * streaming branches). `classifyError` (`core/retry-policy.ts`) and the
 * transient fast path (`core/transient-tier.ts`) consume `statusCode` off it.
 */

/** A non-OK HTTP response surfaced as a retryable-classifiable error. */
export class HttpResponseError extends Error {
  code = "E_HTTP_STATUS";

  constructor(readonly statusCode: number) {
    super(`HTTP failed: ${statusCode}`);
    this.name = "HttpResponseError";
  }
}
