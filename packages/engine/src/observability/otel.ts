/**
 * OpenTelemetry tracer bootstrap. Side-effect-only module — importing
 * registers the `NodeTracerProvider` globally so any `metrics.getMeter` /
 * `trace.getTracer` call throughout the runtime picks up the same provider.
 *
 * Used by `tracer.ts` (which `import "./otel"`s for the side effect) and
 * indirectly by anything that calls `trace.getTracer("janusly")`.
 *
 * Invariants:
 * - The shared `janusResource` carries `service.name="janusly"`,
 *   `service.namespace="janusly"`, and `service.instance.id`. Don't
 *   reconstruct the resource here — reuse `./resource.ts`.
 * - `OTEL_EXPORTER=jaeger` toggles the production-style exporter; default
 *   is the console exporter for local development.
 */

import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SimpleSpanProcessor, ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";
import { JaegerExporter } from "@opentelemetry/exporter-jaeger";
import { janusResource } from "./resource";

const useJaeger = process.env.OTEL_EXPORTER === "jaeger";
const spanProcessor = useJaeger
  ? new SimpleSpanProcessor(new JaegerExporter({
      endpoint: process.env.OTEL_EXPORTER_JAEGER_ENDPOINT || "http://localhost:14268/api/traces",
    }))
  : new SimpleSpanProcessor(new ConsoleSpanExporter());

if (useJaeger) {
  console.log("[otel] Jaeger exporter enabled");
} else {
  console.log("[otel] Console exporter enabled");
}

const provider = new NodeTracerProvider({
  resource: janusResource,
  spanProcessors: [spanProcessor],
});

provider.register();
