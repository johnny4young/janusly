import { trace, context } from "@opentelemetry/api";

export const tracer = trace.getTracer("janusly");

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
