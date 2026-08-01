//go:build integration

package engine

import (
	"fmt"
	"regexp"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/johnny4young/janusly/go/internal/store"
)

// T-504: every root run is stamped with a correlation trace id at start,
// a subworkflow child INHERITS the parent's id (the whole chain stays
// copyable as one trace), and node executions emit OTel spans when a
// provider is registered — a no-op otherwise.

var uuidShape = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func TestRunTraceCorrelation(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	q := store.New(pool)
	suffix := fmt.Sprint(time.Now().UnixNano())

	childID := "wf-trace-child-" + suffix
	childDoc := `{"id":"` + childID + `","name":"child","dslVersion":"1.0",
		"nodes":[{"id":"work","type":"transform","config":{"mapping":{"v":"ok"}}}],
		"edges":[],"outputs":{"result":"{{context.work.output.v}}"}}`
	saveWorkflowVersion(t, ctx, q, org, childID, childDoc)

	parentDoc := `{"id":"wf-trace-parent-` + suffix + `","name":"parent","dslVersion":"1.0",
		"nodes":[{"id":"call","type":"subworkflow","config":{"workflowId":"` + childID + `","input":{}}}],
		"edges":[]}`
	parentRunID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, parentDoc)})
	if err != nil {
		t.Fatalf("start parent: %v", err)
	}
	runDispatcherToTerminal(t, eng, pool, parentRunID, "succeeded")

	var parentTrace string
	if err := pool.QueryRow(ctx, `SELECT trace_id FROM runs WHERE id = $1`, parentRunID).Scan(&parentTrace); err != nil {
		t.Fatalf("parent trace: %v", err)
	}
	if !uuidShape.MatchString(parentTrace) {
		t.Fatalf("root run must stamp a uuid trace id, got %q", parentTrace)
	}
	var childTrace string
	if err := pool.QueryRow(ctx,
		`SELECT trace_id FROM runs WHERE parent_run_id = $1 AND parent_link_kind = 'subworkflow'`,
		parentRunID).Scan(&childTrace); err != nil {
		t.Fatalf("child trace: %v", err)
	}
	if childTrace != parentTrace {
		t.Fatalf("subworkflow child must inherit the parent's trace id: parent=%s child=%s",
			parentTrace, childTrace)
	}
}

func TestNodeExecutionEmitsSpans(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)

	recorder := tracetest.NewSpanRecorder()
	previous := otel.GetTracerProvider()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		otel.SetTracerProvider(previous)
		_ = provider.Shutdown(ctx)
	})

	doc := `{"id":"wf-span-` + fmt.Sprint(time.Now().UnixNano()) + `","name":"span","dslVersion":"1.0",
		"nodes":[{"id":"only","type":"noop","config":{}}],"edges":[]}`
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, doc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	runDispatcherToTerminal(t, eng, pool, runID, "succeeded")

	sawStart, sawNode := false, false
	for _, span := range recorder.Ended() {
		attrs := map[string]string{}
		for _, attr := range span.Attributes() {
			attrs[string(attr.Key)] = attr.Value.Emit()
		}
		if span.Name() == "run.start" && attrs["janusly.run_id"] == runID {
			sawStart = true
		}
		if span.Name() == "node.execute" && attrs["janusly.run_id"] == runID && attrs["janusly.node_id"] == "only" {
			sawNode = true
		}
	}
	if !sawStart || !sawNode {
		t.Fatalf("expected run.start + node.execute spans for %s: start=%v node=%v (%d spans)",
			runID, sawStart, sawNode, len(recorder.Ended()))
	}
}
