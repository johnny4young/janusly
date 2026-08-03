package health

import (
	"math"
	"testing"
)

func TestHealthWeightsSumToOne(t *testing.T) {
	total := 0.0
	for _, weight := range Weights {
		total += weight
	}
	if math.Abs(total-1.0) > 1e-9 {
		t.Fatalf("weights must sum to 1.0: %f", total)
	}
}

func TestComputeNeutralAndPenalties(t *testing.T) {
	// A never-run workflow is untested, not unhealthy: neutral categories.
	score := Compute(WorkflowFacts{}, nil, Signals{VersionCount: 1}, nil)
	if score.Breakdown["reliability"].Score != NeutralDefault ||
		score.Breakdown["latency"].Score != NeutralDefault ||
		score.Breakdown["cost"].Score != NeutralDefault ||
		score.Breakdown["aiRisk"].Score != 100 || score.Breakdown["safety"].Score != 100 {
		t.Fatalf("neutral posture: %+v", score.Breakdown)
	}

	// A failing, DLQ-heavy window drags reliability down deterministically.
	p95 := 70_000.0
	bad := Compute(WorkflowFacts{AiNodeCount: 2}, []ReadinessIssue{
		{Code: "raw_secret_in_config", Severity: "fail"},
		{Code: "http_missing_bounds", Severity: "warn"},
	}, Signals{
		TotalRuns: 10, SuccessCount: 4, FailureCount: 6,
		RetryCount: 20, DlqOpenCount: 8, P95LatencyMs: &p95,
		TotalCostUsd: 20, TotalTokens: 500_000, VersionCount: 1,
	}, nil)
	// reliability: 40 - min(40,30) - min(40,20) = 40-30-20 → clamp 0.
	if bad.Breakdown["reliability"].Score != 0 {
		t.Fatalf("reliability: %+v", bad.Breakdown["reliability"])
	}
	// safety: 100 - 20 - 5 = 75; latency band ceiling → 30.
	if bad.Breakdown["safety"].Score != 75 || bad.Breakdown["latency"].Score != 30 {
		t.Fatalf("safety/latency: %+v", bad.Breakdown)
	}
	if bad.Status != "unhealthy" {
		t.Fatalf("status: %s (%d)", bad.Status, bad.Score)
	}
}

func TestEvaluateSlo(t *testing.T) {
	rate := 95.0
	p95Target := 10_000.0
	slo := &Slo{SuccessRatePercent: &rate, P95DurationMs: &p95Target}

	// Below the sample floor nothing breaches.
	if breaches := EvaluateSlo(slo, Signals{TotalRuns: 3, SuccessCount: 0}); breaches.AnyBreach {
		t.Fatalf("sample floor: %+v", breaches)
	}
	// Breaching both metrics.
	slowP95 := 20_000.0
	breaches := EvaluateSlo(slo, Signals{TotalRuns: 10, SuccessCount: 8, P95LatencyMs: &slowP95})
	if !breaches.SuccessRate || !breaches.P95 || !breaches.AnyBreach {
		t.Fatalf("breaches: %+v", breaches)
	}
	// Null thresholds never breach.
	if breaches := EvaluateSlo(&Slo{}, Signals{TotalRuns: 10}); breaches.AnyBreach {
		t.Fatalf("null thresholds: %+v", breaches)
	}
}
