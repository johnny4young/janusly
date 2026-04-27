import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { MeterProvider } from "@opentelemetry/sdk-metrics";

const port = Number(process.env.OTEL_METRICS_PORT || 9464);

const exporter = new PrometheusExporter({
  port,
  endpoint: "/metrics",
}, () => {
  console.log(`[otel] Prometheus metrics available at http://localhost:${port}/metrics`);
});

const meterProvider = new MeterProvider({
  readers: [exporter],
});

// Set as global provider
import("@opentelemetry/api").then(({ metrics }) => {
  metrics.setGlobalMeterProvider(meterProvider);
});
