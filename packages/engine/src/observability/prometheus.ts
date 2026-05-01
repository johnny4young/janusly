/**
 * Prometheus metrics endpoint bootstrap. Side-effect-only — registers a
 * `MeterProvider` carrying the shared `janusResource` and exposes
 * a `/metrics` HTTP endpoint that Prometheus scrapes.
 *
 * Used by `core/runtime.ts` indirectly: `metrics.ts` reads
 * `metrics.getMeter("janusly")` which resolves to this provider.
 *
 * Invariants:
 * - `OTEL_METRICS_PORT` env defaults to 9464 (the OpenTelemetry-recommended
 *   port). Production deploys override per-process so multiple workers
 *   on one host don't collide.
 */

import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { janusResource } from "./resource";

const port = Number(process.env.OTEL_METRICS_PORT || 9464);

const exporter = new PrometheusExporter({
  port,
  endpoint: "/metrics",
}, () => {
  console.log(`[otel] Prometheus metrics available at http://localhost:${port}/metrics`);
});

const meterProvider = new MeterProvider({
  resource: janusResource,
  readers: [exporter],
});

// Set as global provider
import("@opentelemetry/api").then(({ metrics }) => {
  metrics.setGlobalMeterProvider(meterProvider);
});
