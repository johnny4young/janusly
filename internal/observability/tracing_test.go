package observability

import (
	"context"
	"errors"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestInitTracingNoneIsNoop(t *testing.T) {
	t.Setenv("OTEL_EXPORTER", "none")
	shutdown, err := InitTracing(context.Background())
	if err != nil || shutdown == nil {
		t.Fatalf("none must yield a nil-safe shutdown: %v", err)
	}
	if err := shutdown(context.Background()); err != nil {
		t.Fatalf("noop shutdown: %v", err)
	}
}

func TestInitTracingRejectsUnknownExporter(t *testing.T) {
	t.Setenv("OTEL_EXPORTER", "jaeger")
	if _, err := InitTracing(context.Background()); err == nil {
		t.Fatal("unknown exporter must error")
	}
}

func TestWithSpanRecordsAttributesAndErrors(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	previous := otel.GetTracerProvider()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		otel.SetTracerProvider(previous)
		_ = provider.Shutdown(context.Background())
	})

	boom := errors.New("boom")
	err := WithSpan(context.Background(), "unit.test",
		[]attribute.KeyValue{attribute.String("k", "v")},
		func(context.Context) error { return boom })
	if !errors.Is(err, boom) {
		t.Fatalf("WithSpan must return the callback error: %v", err)
	}
	spans := recorder.Ended()
	if len(spans) != 1 || spans[0].Name() != "unit.test" {
		t.Fatalf("expected one ended span: %+v", spans)
	}
	if spans[0].Status().Code != codes.Error {
		t.Fatalf("error status must be recorded: %+v", spans[0].Status())
	}
	found := false
	for _, attr := range spans[0].Attributes() {
		if attr.Key == "k" && attr.Value.AsString() == "v" {
			found = true
		}
	}
	if !found {
		t.Fatalf("attribute must ride the span: %+v", spans[0].Attributes())
	}
}
