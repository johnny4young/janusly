// Package observability owns API-process OpenTelemetry bootstrap and runtime
// span helpers. Unset/none exports nothing; console and OTLP/HTTP are opt-in.
// Instance identity uses OTEL_SERVICE_INSTANCE_ID, HOSTNAME, then os.Hostname.
// Only cmd/api initializes export; untraced library consumers keep a no-op tracer.
package observability

import (
	"context"
	"errors"
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

// serviceResource gives every exported span the runtime service identity.
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
	// Unset means no export: the global tracer stays a no-op and the spans
	// the request and statement paths open cost nothing. The console
	// exporter must be asked for by name — it serializes every span to
	// stdout, which under a container log driver is a write on the hot
	// path for each request and each SQL statement.
	if kind == "" || kind == "none" {
		return func(context.Context) error { return nil }, nil
	}
	var exporter sdktrace.SpanExporter
	var err error
	switch kind {
	case "console":
		exporter, err = stdouttrace.New()
	case "otlp":
		exporter, err = otlptracehttp.New(ctx)
	default:
		return nil, errors.New("invalid configuration: OTEL_EXPORTER must be console, otlp or none")
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
