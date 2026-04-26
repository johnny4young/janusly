import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SimpleSpanProcessor, ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";
import { JaegerExporter } from "@opentelemetry/exporter-jaeger";

const provider = new NodeTracerProvider();

const useJaeger = process.env.OTEL_EXPORTER === "jaeger";

if (useJaeger) {
  const exporter = new JaegerExporter({
    endpoint: process.env.OTEL_EXPORTER_JAEGER_ENDPOINT || "http://localhost:14268/api/traces",
  });
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  console.log("[otel] Jaeger exporter enabled");
} else {
  provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
  console.log("[otel] Console exporter enabled");
}

provider.register();
