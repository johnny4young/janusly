/**
 * Trace-export configuration and SpanProcessor construction.
 *
 * Keeps environment parsing pure and testable while `otel.ts` owns the single
 * process-global provider registration. Console is the local default; OTLP/HTTP
 * is the explicit production path and always batches ended spans.
 */

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

const DEFAULT_OTLP_TRACES_ENDPOINT = "http://localhost:4318/v1/traces";

export type TraceExporterConfig =
  | { kind: "console" }
  | { kind: "otlp"; endpoint: string };

function parseHttpUrl(value: string, variable: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`[otel] ${variable} must be a valid HTTP(S) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`[otel] ${variable} must use http or https`);
  }
  return url.toString();
}

function tracesEndpointFromBase(value: string): string {
  const url = new URL(parseHttpUrl(value, "OTEL_EXPORTER_OTLP_ENDPOINT"));
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/traces`;
  return url.toString();
}

/** Resolve the closed exporter mode and its effective OTLP traces endpoint. */
export function resolveTraceExporterConfig(
  env: NodeJS.ProcessEnv = process.env,
): TraceExporterConfig {
  const exporter = env.OTEL_EXPORTER?.trim().toLowerCase() || "console";
  if (exporter === "console") return { kind: "console" };

  if (exporter === "jaeger") {
    throw new Error(
      "[otel] OTEL_EXPORTER=jaeger is no longer supported; use OTEL_EXPORTER=otlp and set OTEL_EXPORTER_OTLP_TRACES_ENDPOINT to the Collector HTTP /v1/traces endpoint",
    );
  }
  if (exporter !== "otlp") {
    throw new Error(`[otel] unsupported OTEL_EXPORTER=${exporter}; expected console or otlp`);
  }

  const endpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    ? parseHttpUrl(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
    : env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? tracesEndpointFromBase(env.OTEL_EXPORTER_OTLP_ENDPOINT)
      : DEFAULT_OTLP_TRACES_ENDPOINT;
  return { kind: "otlp", endpoint };
}

/** Construct the processor: simple console locally, batched OTLP in production. */
export function createTraceSpanProcessor(config: TraceExporterConfig): SpanProcessor {
  if (config.kind === "console") {
    return new SimpleSpanProcessor(new ConsoleSpanExporter());
  }
  return new BatchSpanProcessor(new OTLPTraceExporter({ url: config.endpoint }));
}
