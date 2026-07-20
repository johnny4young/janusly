/**
 * Explicit Prometheus metrics endpoint lifecycle.
 *
 * Used by `apps/api/src/index.ts` and `worker.ts` after their mandatory
 * migration checks. Each process supplies a distinct local default port;
 * production can override either with `OTEL_METRICS_PORT`.
 *
 * Invariants:
 * - Startup is explicit so an unmigrated process does not leave a metrics
 *   listener alive after its fail-fast boot check.
 * - One provider per process; repeated starts are idempotent.
 * - Graceful process shutdown drains the exporter through `shutdown()`.
 */

import { metrics } from "@opentelemetry/api";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { janusResource } from "./resource";

export const API_METRICS_DEFAULT_PORT = 9464;
export const WORKER_METRICS_DEFAULT_PORT = 9465;
export const METRICS_DEFAULT_HOST = "127.0.0.1";

let meterProvider: MeterProvider | null = null;
let startPromise: Promise<void> | null = null;

/** Resolve a valid TCP port, falling back when configuration is malformed. */
export function resolveMetricsPort(raw: string | undefined, fallback: number): number {
  const parsed = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 65_535
    ? parsed
    : fallback;
}

/** Default to loopback; remote scraping requires an explicit host override. */
export function resolveMetricsHost(raw: string | undefined): string {
  const host = raw?.trim();
  return host ? host : METRICS_DEFAULT_HOST;
}

/** Start this process's Prometheus endpoint once. */
export function startPrometheusMetrics(options: {
  defaultPort: number;
  processName: "api" | "worker";
}): Promise<void> {
  if (meterProvider) return Promise.resolve();
  if (startPromise) return startPromise;

  const configuredPort = process.env.OTEL_METRICS_PORT;
  const port = resolveMetricsPort(configuredPort, options.defaultPort);
  const host = resolveMetricsHost(process.env.OTEL_METRICS_HOST);
  if (configuredPort && Number(configuredPort) !== port) {
    console.warn(`[otel] invalid OTEL_METRICS_PORT; using ${port}`);
  }

  const attempt = (async () => {
    const exporter = new PrometheusExporter({
      host,
      port,
      endpoint: "/metrics",
      preventServerStart: true,
    });
    const provider = new MeterProvider({
      resource: janusResource,
      readers: [exporter],
    });
    try {
      await exporter.startServer();
    } catch (error) {
      await provider.shutdown();
      throw new Error(
        `[otel] ${options.processName} Prometheus endpoint failed to bind ${host}:${port}`,
        { cause: error },
      );
    }
    if (!metrics.setGlobalMeterProvider(provider)) {
      await provider.shutdown();
      throw new Error("OpenTelemetry MeterProvider is already registered");
    }
    meterProvider = provider;
    const displayHost = host.includes(":") ? `[${host}]` : host;
    console.log(
      `[otel] ${options.processName} Prometheus metrics available at http://${displayHost}:${port}/metrics`,
    );
  })();
  startPromise = attempt;
  return attempt.catch((error) => {
    if (startPromise === attempt) startPromise = null;
    throw error;
  });
}

/** Stop the process-local exporter. Safe to call when startup never ran. */
export async function shutdownPrometheusMetrics(): Promise<void> {
  const provider = meterProvider;
  meterProvider = null;
  startPromise = null;
  if (provider) await provider.shutdown();
}
