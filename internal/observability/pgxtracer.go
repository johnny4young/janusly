package observability

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// pgxTracer opens one client span per statement, named after the sqlc query
// (every generated statement starts with `-- name: X :kind`), so a slow
// request trace shows which query it waited on. With no provider registered
// the global tracer is a no-op and the cost is a context value.
type pgxTracer struct{}

// NewPgxTracer returns the pool-level query tracer.
func NewPgxTracer() pgx.QueryTracer { return pgxTracer{} }

type pgxSpanKey struct{}

// QueryName extracts the sqlc name from a statement, or "sql" for ad-hoc SQL.
func QueryName(sql string) string {
	if rest, ok := strings.CutPrefix(sql, "-- name: "); ok {
		name, _, _ := strings.Cut(rest, " ")
		if name != "" {
			return name
		}
	}
	return "sql"
}

func (pgxTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	ctx, span := Tracer().Start(ctx, "db."+QueryName(data.SQL), trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(attribute.String("db.system", "postgresql")))
	return context.WithValue(ctx, pgxSpanKey{}, span)
}

func (pgxTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	span, ok := ctx.Value(pgxSpanKey{}).(trace.Span)
	if !ok {
		return
	}
	if data.Err != nil {
		span.SetStatus(codes.Error, data.Err.Error())
	}
	span.End()
}
