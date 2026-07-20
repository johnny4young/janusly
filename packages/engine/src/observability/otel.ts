/**
 * Process-global OpenTelemetry tracer bootstrap.
 *
 * Imported for its registration side effect by `tracer.ts`. The provider is
 * also exported so the worker can flush batched OTLP spans during graceful
 * shutdown instead of dropping the last queue of telemetry.
 *
 * Invariants:
 * - The shared `janusResource` owns the canonical service attributes.
 * - Console export is the local default.
 * - `OTEL_EXPORTER=otlp` uses OTLP/HTTP plus `BatchSpanProcessor`.
 */

import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { janusResource } from "./resource";
import { createTraceSpanProcessor, resolveTraceExporterConfig } from "./trace-exporter";

const config = resolveTraceExporterConfig();
const provider = new NodeTracerProvider({
  resource: janusResource,
  spanProcessors: [createTraceSpanProcessor(config)],
});

provider.register();
console.log(`[otel] ${config.kind === "otlp" ? "OTLP/HTTP batch" : "Console"} exporter enabled`);

/** Flush and stop the registered provider during process shutdown. */
export async function shutdownTracing(): Promise<void> {
  await provider.shutdown();
}
