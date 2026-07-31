package recovery

import (
	"testing"

	"github.com/johnny4young/janusly/go/internal/domain"
)

func v2Contract() *domain.RecoveryContract {
	contract := &domain.RecoveryContract{Version: "2"}
	contract.Failure.Semantic.Mode = "deterministic"
	contract.Failure.Semantic.Detectors = []domain.RecoverySemanticDetector{
		{
			ID: "det-total", SourceNodeID: "calc", Kind: "expression",
			PassWhen: "context.calc.output.total <= 100",
			Action:   "quarantine", Message: "total exceeds cap",
		},
		{
			ID: "det-shape", SourceNodeID: "calc", Kind: "schema",
			Schema: &domain.InputSchema{Type: "object",
				Properties: map[string]*domain.InputSchema{"total": {Type: "number"}},
				Required:   []string{"total"}},
			Action: "observe", Message: "output shape drifted",
		},
	}
	contract.Failure.Semantic.EvaluationFixtures = []domain.RecoverySemanticFixture{
		{ID: "fx-pass", SourceNodeID: "calc", Output: map[string]any{"total": float64(50)}, Expected: "pass"},
		{ID: "fx-violation", SourceNodeID: "calc", Output: map[string]any{"total": float64(500)}, Expected: "violation"},
	}
	return contract
}

func evaluate(contract *domain.RecoveryContract, node string, output any, context map[string]any) SemanticOutcomeEvaluation {
	return EvaluateSemanticOutcome(struct {
		Contract     *domain.RecoveryContract
		SourceNodeID string
		Output       any
		Context      map[string]any
	}{Contract: contract, SourceNodeID: node, Output: output, Context: context})
}

// The deterministic evaluator: expression + schema detectors over the
// overlaid completed output; quarantine dominates observe for the verdict;
// an expression ERROR counts as a violation with details (fail-safe).
func TestEvaluateSemanticOutcome(t *testing.T) {
	contract := v2Contract()

	pass := evaluate(contract, "calc", map[string]any{"total": float64(50)}, nil)
	if pass.Evaluated != 2 || len(pass.Violations) != 0 || pass.Quarantined {
		t.Fatalf("passing output: %+v", pass)
	}

	// Expression violation (quarantine) + schema pass.
	over := evaluate(contract, "calc", map[string]any{"total": float64(500)}, nil)
	if len(over.Violations) != 1 || !over.Quarantined || over.Violations[0].DetectorID != "det-total" {
		t.Fatalf("expression violation: %+v", over)
	}

	// Schema violation alone (observe) must NOT quarantine.
	shape := evaluate(contract, "calc", map[string]any{"total": "mucho"}, nil)
	quarantineSeen := false
	observeSeen := false
	for _, violation := range shape.Violations {
		if violation.DetectorID == "det-shape" && violation.Action == "observe" {
			observeSeen = true
		}
		if violation.Action == "quarantine" {
			quarantineSeen = true
		}
	}
	if !observeSeen {
		t.Fatalf("schema detector must fire: %+v", shape.Violations)
	}
	// Same-source verdict: with BOTH firing (string breaks the expression
	// comparison too), quarantine dominates — the strictest action governs.
	if quarantineSeen && !shape.Quarantined {
		t.Fatalf("quarantine must dominate: %+v", shape)
	}

	// A broken expression is a violation WITH details, never a silent pass.
	broken := v2Contract()
	broken.Failure.Semantic.Detectors = broken.Failure.Semantic.Detectors[:1]
	broken.Failure.Semantic.Detectors[0].PassWhen = "context.calc.output.total &&& nonsense"
	verdict := evaluate(broken, "calc", map[string]any{"total": float64(10)}, nil)
	if len(verdict.Violations) != 1 || len(verdict.Violations[0].Details) == 0 {
		t.Fatalf("broken expression must violate with details: %+v", verdict)
	}

	// A V1 contract NEVER evaluates: zero detectors by construction.
	v1 := &domain.RecoveryContract{Version: "1"}
	v1.Failure.Semantic.Mode = "disabled"
	if got := evaluate(v1, "calc", map[string]any{"total": float64(999)}, nil); got.Evaluated != 0 || len(got.Violations) != 0 {
		t.Fatalf("v1 must never evaluate: %+v", got)
	}

	// Detectors on OTHER nodes stay out of this node's verdict.
	other := evaluate(contract, "otro", map[string]any{"total": float64(999)}, nil)
	if other.Evaluated != 0 {
		t.Fatalf("foreign-node detectors must not run: %+v", other)
	}

	// Cross-node context flows into expressions.
	cross := v2Contract()
	cross.Failure.Semantic.Detectors = []domain.RecoverySemanticDetector{{
		ID: "det-cross", SourceNodeID: "calc", Kind: "expression",
		PassWhen: "context.calc.output.total <= context.limits.output.cap",
		Action:   "quarantine", Message: "over the configured cap",
	}}
	verdictCross := evaluate(cross, "calc", map[string]any{"total": float64(80)},
		map[string]any{"limits": map[string]any{"output": map[string]any{"cap": float64(100)}}})
	if len(verdictCross.Violations) != 0 {
		t.Fatalf("cross-node pass: %+v", verdictCross.Violations)
	}
}

// Fixture replay uses the exact runtime evaluator, verdicts included.
func TestEvaluateSemanticOutcomeFixtures(t *testing.T) {
	results := EvaluateSemanticOutcomeFixtures(v2Contract())
	if len(results) != 2 {
		t.Fatalf("two fixtures: %+v", results)
	}
	for _, result := range results {
		if !result.Passed {
			t.Fatalf("fixture %s must match its expectation: %+v", result.ID, result)
		}
	}
	// V1 → no fixtures ever.
	v1 := &domain.RecoveryContract{Version: "1"}
	if got := EvaluateSemanticOutcomeFixtures(v1); len(got) != 0 {
		t.Fatalf("v1 fixtures must be empty: %+v", got)
	}
}
