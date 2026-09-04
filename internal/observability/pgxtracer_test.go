package observability

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestQueryNameReadsTheSqlcHeader(t *testing.T) {
	if got := QueryName("-- name: GetRunHeader :one\nSELECT 1"); got != "GetRunHeader" {
		t.Fatalf("got %q", got)
	}
	if got := QueryName("SELECT 1"); got != "sql" {
		t.Fatalf("ad-hoc SQL must not name a span by its text, got %q", got)
	}
}

func TestPgxTracerRecordsOneClientSpanPerStatement(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() { otel.SetTracerProvider(previous) })

	tracer := NewPgxTracer()
	ctx := tracer.TraceQueryStart(context.Background(), nil, pgx.TraceQueryStartData{SQL: "-- name: GetRunHeader :one\nSELECT 1"})
	tracer.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{Err: errors.New("boom")})
	spans := exporter.GetSpans()
	if len(spans) != 1 || spans[0].Name != "db.GetRunHeader" {
		t.Fatalf("want one span named after the query, got %+v", spans)
	}
	if spans[0].Status.Code != codes.Error {
		t.Fatalf("a failed statement must mark the span, got %v", spans[0].Status)
	}
}
