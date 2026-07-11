/**
 * OTel tracer + `withSpan` convenience wrapper. The provider is registered by
 * the explicit `./otel` side-effect import below before this singleton tracer
 * is requested from the global API.
 *
 * Used by `worker.ts` around each claimed workflow-node execution.
 *
 * Invariants:
 * - The tracer name is `"janusly"` (matches `service.name` from
 *   `./resource.ts`). External dashboards filter on this name; don't
 *   rename without coordinating with the dashboard owner.
 */

import "./otel";
import { trace, context, SpanStatusCode, type Attributes } from "@opentelemetry/api";

/** Singleton tracer for engine spans. */
export const tracer = trace.getTracer("janusly");

/**
 * Run `fn` inside a fresh span named `name`. Sets `attrs` on the span
 * (when provided), records exceptions via `recordException`, sets OK/ERROR
 * status appropriately, and always calls `span.end()` in `finally`.
 */
export function withSpan<T>(name: string, fn: () => Promise<T>, attrs?: Attributes): Promise<T> {
  const span = tracer.startSpan(name);

  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value !== undefined) span.setAttribute(key, value);
    }
  }

  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err: unknown) {
      const exception = err instanceof Error ? err : new Error(String(err));
      span.recordException(exception);
      span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
      throw err;
    } finally {
      span.end();
    }
  });
}
