package usage

import (
	"context"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

// Every recorded AI call feeds the process-level cost and token counters,
// labeled by provider and model; a recorder failure records nothing.
func TestFireFeedsTheAICostAndTokenCounters(t *testing.T) {
	previous := recorder
	t.Cleanup(func() { SetRecorder(previous) })
	SetRecorder(func(context.Context, Record) error { return nil })

	cost, in, out := 0.25, 120, 30
	costBefore := testutil.ToFloat64(metricAICost.WithLabelValues("anthropic", "test-model"))
	inBefore := testutil.ToFloat64(metricAITokens.WithLabelValues("anthropic", "test-model", "input"))
	Fire(context.Background(), Record{OrgID: "org", Provider: "anthropic", Model: "test-model", CostUsd: &cost, InputTokens: &in, OutputTokens: &out})
	if got := testutil.ToFloat64(metricAICost.WithLabelValues("anthropic", "test-model")); got != costBefore+0.25 {
		t.Fatalf("cost counter: got %v, want %v", got, costBefore+0.25)
	}
	if got := testutil.ToFloat64(metricAITokens.WithLabelValues("anthropic", "test-model", "input")); got != inBefore+120 {
		t.Fatalf("input token counter: got %v, want %v", got, inBefore+120)
	}
	if got := testutil.ToFloat64(metricAITokens.WithLabelValues("anthropic", "test-model", "output")); got < 30 {
		t.Fatalf("output token counter: got %v", got)
	}
}
