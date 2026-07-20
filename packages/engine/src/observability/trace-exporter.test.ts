import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { janusResource } from "./resource";
import { createTraceSpanProcessor, resolveTraceExporterConfig } from "./trace-exporter";

describe("resolveTraceExporterConfig", () => {
  it("keeps console as the local default", () => {
    expect(resolveTraceExporterConfig({})).toEqual({ kind: "console" });
  });

  it("uses the standard OTLP HTTP endpoint and batches production export", () => {
    const config = resolveTraceExporterConfig({ OTEL_EXPORTER: "otlp" });
    expect(config).toEqual({ kind: "otlp", endpoint: "http://localhost:4318/v1/traces" });
    expect(createTraceSpanProcessor(config)).toBeInstanceOf(BatchSpanProcessor);
  });

  it("prefers the traces endpoint and appends the trace path to a base endpoint", () => {
    expect(resolveTraceExporterConfig({
      OTEL_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com/otel?tenant=default",
    })).toEqual({ kind: "otlp", endpoint: "https://collector.example.com/otel/v1/traces?tenant=default" });

    expect(resolveTraceExporterConfig({
      OTEL_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://ignored.example.com",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://traces.example.com/custom",
    })).toEqual({ kind: "otlp", endpoint: "https://traces.example.com/custom" });
  });

  it("fails fast on legacy, unknown, and unsafe endpoint configuration", () => {
    expect(() => resolveTraceExporterConfig({ OTEL_EXPORTER: "jaeger" })).toThrow(/use OTEL_EXPORTER=otlp/);
    expect(() => resolveTraceExporterConfig({ OTEL_EXPORTER: "zipkin" })).toThrow(/unsupported OTEL_EXPORTER/);
    expect(() => resolveTraceExporterConfig({
      OTEL_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "file:///tmp/traces",
    })).toThrow(/must use http or https/);
  });
});

describe("OTLP HTTP collector smoke", () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    servers.length = 0;
  });

  it("exports a real OTLP request carrying Janusly resource attributes", async () => {
    let resolveRequest!: (request: { path: string; contentType: string; body: Buffer }) => void;
    const received = new Promise<{ path: string; contentType: string; body: Buffer }>((resolve) => {
      resolveRequest = resolve;
    });
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        resolveRequest({
          path: request.url ?? "",
          contentType: String(request.headers["content-type"] ?? ""),
          body: Buffer.concat(chunks),
        });
        response.writeHead(200).end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const exporter = new OTLPTraceExporter({ url: `http://127.0.0.1:${port}/v1/traces` });
    const provider = new NodeTracerProvider({
      resource: janusResource,
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });
    provider.getTracer("janusly-collector-smoke").startSpan("collector.smoke").end();
    await provider.forceFlush();

    const request = await received;
    expect(request.path).toBe("/v1/traces");
    expect(request.contentType).toContain("application/json");
    const payload = JSON.parse(request.body.toString("utf8")) as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> };
        scopeSpans: Array<{ spans: Array<{ name: string }> }>;
      }>;
    };
    const resourceSpan = payload.resourceSpans[0];
    const attributes = Object.fromEntries(
      resourceSpan.resource.attributes.map((attribute) => [attribute.key, attribute.value.stringValue]),
    );
    expect(attributes["service.name"]).toBe("janusly");
    expect(attributes["service.namespace"]).toBe("janusly");
    expect(attributes["service.instance.id"]).toBeTruthy();
    expect(resourceSpan.scopeSpans.flatMap((scope) => scope.spans).map((span) => span.name)).toContain("collector.smoke");
    await provider.shutdown();
  });
});
