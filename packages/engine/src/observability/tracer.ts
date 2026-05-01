/**
 * OTel tracer + `withSpan` convenience wrapper. The provider is registered
 * by `./otel.ts` (which this file picks up via the global `trace` API).
 *
 * Used by `core/runtime.ts` and the executor harness for per-node spans.
 *
 * Invariants:
 * - The tracer name is `"janusly"` (matches `service.name` from
 *   `./resource.ts`). External dashboards filter on this name; don't
 *   rename without coordinating with the dashboard owner.
 */

import { trace, context } from "@opentelemetry/api";

/** Singleton tracer for engine spans. */
export const tracer = trace.getTracer("janusly");

/**
 * Run `fn` inside a fresh span named `name`. Sets `attrs` on the span
 * (when provided), records exceptions via `recordException`, sets OK/ERROR
 * status appropriately, and always calls `span.end()` in `finally`.
 */
export function withSpan<T>(name: string, fn: () => Promise<T>, attrs?: Record<string, any>): Promise<T> {
  const span = tracer.startSpan(name);

  if (attrs) {
    Object.entries(attrs).forEach(([k, v]) => span.setAttribute(k, v));
  }

  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn();
      span.setStatus({ code: 1 }); // OK
      return result;
    } catch (err: any) {
      span.recordException(err);
      span.setStatus({ code: 2, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
}
