// Process-global OpenTelemetry trace bootstrap + the span helper the
// engine wraps node executions with (reference the source contract
// observability/{otel,tracer,resource,trace-exporter}.ts).
//
// Invariants ported:
//   - Resource carries service.name="janusly" (the runtime's own service
//     identity — dashboards distinguish it from the contract's
//     "janusly"), service.namespace="janusly", service.instance.id
//     (OTEL_SERVICE_INSTANCE_ID → HOSTNAME → os.Hostname()).
//   - Console export is the local default; OTEL_EXPORTER=otlp uses
//     OTLP/HTTP with the batch processor and the standard
//     OTEL_EXPORTER_OTLP_* endpoint variables. OTEL_EXPORTER=none keeps
//     the no-op global (tests and quiet tooling).
//   - InitTracing is called ONLY by cmd/api main; library code reaches the
//     tracer through the global API, so untraced processes pay nothing.
package observability

import (
	"context"
	"fmt"
	"os"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/exporters/stdout/stdouttrace"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
)

// TracerName is the instrumentation-scope name every runtime span uses.
const TracerName = "janusly"

// serviceResource mirrors the contract's resource.ts attribute set.
func serviceResource() *resource.Resource {
	instance := os.Getenv("OTEL_SERVICE_INSTANCE_ID")
	if instance == "" {
		instance = os.Getenv("HOSTNAME")
	}
	if instance == "" {
		instance, _ = os.Hostname()
	}
	return resource.NewWithAttributes(semconv.SchemaURL,
		semconv.ServiceName(TracerName),
		semconv.ServiceNamespace("janusly"),
		semconv.ServiceInstanceID(instance),
	)
}

// InitTracing registers the global tracer provider per OTEL_EXPORTER and
// returns the shutdown that flushes batched spans. "none" leaves the
// no-op global registered and returns a nil-safe shutdown.
func InitTracing(ctx context.Context) (func(context.Context) error, error) {
	kind := os.Getenv("OTEL_EXPORTER")
	if kind == "none" {
		return func(context.Context) error { return nil }, nil
	}
	var exporter sdktrace.SpanExporter
	var err error
	switch kind {
	case "", "console":
		exporter, err = stdouttrace.New()
	case "otlp":
		exporter, err = otlptracehttp.New(ctx)
	default:
		return nil, fmt.Errorf("unsupported OTEL_EXPORTER %q (console|otlp|none)", kind)
	}
	if err != nil {
		return nil, fmt.Errorf("otel exporter: %w", err)
	}
	provider := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(serviceResource()),
	)
	otel.SetTracerProvider(provider)
	return provider.Shutdown, nil
}

// Tracer returns the singleton runtime tracer from the global provider —
// a no-op unless InitTracing (or a test recorder) registered one.
func Tracer() trace.Tracer { return otel.Tracer(TracerName) }

// WithSpan runs fn inside a fresh span, mirroring the contract tracer.ts
// helper: attributes up front, error recorded + status set, always ended.
func WithSpan(ctx context.Context, name string, attrs []attribute.KeyValue, fn func(context.Context) error) error {
	ctx, span := Tracer().Start(ctx, name, trace.WithAttributes(attrs...))
	defer span.End()
	if err := fn(ctx); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return err
	}
	span.SetStatus(codes.Ok, "")
	return nil
}
