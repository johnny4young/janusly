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
