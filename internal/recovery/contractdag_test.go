package recovery

import (
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/grammar"
)

func dagWorkflow(contract *domain.RecoveryContract, nodes []domain.Node, edges []domain.Edge) *domain.Workflow {
	return &domain.Workflow{
		ID: "wf", Name: "W", DSLVersion: "1.0",
		Recovery: &domain.WorkflowRecovery{Contract: contract},
		Nodes:    nodes, Edges: edges,
	}
}

func dagContract(action string, sourceNode string, effects []domain.RecoveryEffect) *domain.RecoveryContract {
	contract := &domain.RecoveryContract{Version: "2"}
	contract.Failure.Technical.TerminalNodeFailure = true
	contract.Failure.Semantic.Mode = "deterministic"
	contract.Failure.Semantic.Detectors = []domain.RecoverySemanticDetector{{
		ID: "det-1", SourceNodeID: sourceNode, Kind: "expression",
		PassWhen: "context." + sourceNode + ".output.ok === true",
		Action:   action, Message: "not ok",
	}}
	contract.Failure.Semantic.EvaluationFixtures = []domain.RecoverySemanticFixture{
		{ID: "fx-pass", SourceNodeID: sourceNode, Output: map[string]any{"ok": true}, Expected: "pass"},
		{ID: "fx-violation", SourceNodeID: sourceNode, Output: map[string]any{"ok": false}, Expected: "violation"},
	}
	contract.Evidence.Required = []string{"failure_snapshot", "audit_trail", "terminal_outcome"}
	contract.Effects = effects
	contract.Repairs.Allowed = []string{"retry"}
	contract.Validation.MinimumEvidenceLevel = "static"
	contract.Approval.ProductionMutation = "required"
	contract.Approval.Permission = "recovery.write"
	contract.AutonomyLevel = 2
	contract.Verification.Kind = "generation_bound_terminal_success"
	contract.Recurrence.WindowDays = 7
	return contract
}

func issueCodes(result domain.ValidationResult) string {
	var codes []string
	for _, issue := range result.Issues {
		codes = append(codes, issue.Code)
	}
	return strings.Join(codes, ",")
}

func validate(wf *domain.Workflow) domain.ValidationResult {
	return domain.ValidateWithSemanticFixtures(wf, grammar.DomainValidator, FixtureOutcomesForValidation)
}

// The contract-vs-DAG fail-closed save rules: dominance, undeclared
// write-side effects, deferred/router sources, fixture qualification.
func TestSemanticContractDAGRules(t *testing.T) {
	httpEffect := domain.RecoveryEffect{NodeID: "notify", Kind: "external_write",
		Idempotency: "required", Receipt: "runtime"}

	// 1. A quarantine source that dominates the declared+actual effect: valid.
	guarded := validate(dagWorkflow(
		dagContract("quarantine", "calc", []domain.RecoveryEffect{httpEffect}),
		[]domain.Node{
			{ID: "calc", Type: "transform", Config: map[string]any{"mapping": map[string]any{"ok": "true"}}},
			{ID: "notify", Type: "http", Config: map[string]any{"url": "https://example.com", "method": "POST"}},
		},
		[]domain.Edge{{From: "calc", To: "notify"}},
	))
	if !guarded.Valid {
		t.Fatalf("dominating quarantine must validate: %s", issueCodes(guarded))
	}

	// 2. A bypass path (root → notify directly) breaks dominance.
	bypass := validate(dagWorkflow(
		dagContract("quarantine", "calc", []domain.RecoveryEffect{httpEffect}),
		[]domain.Node{
			{ID: "seed", Type: "noop", Config: map[string]any{}},
			{ID: "calc", Type: "transform", Config: map[string]any{"mapping": map[string]any{"ok": "true"}}},
			{ID: "notify", Type: "http", Config: map[string]any{"url": "https://example.com", "method": "POST"}},
		},
		[]domain.Edge{{From: "seed", To: "calc"}, {From: "calc", To: "notify"}, {From: "seed", To: "notify"}},
	))
	if !strings.Contains(issueCodes(bypass), "semantic_detector_does_not_guard_effect") {
		t.Fatalf("bypass must break dominance: %s", issueCodes(bypass))
	}

	// 3. An ACTUAL write-side node missing from contract.effects.
	undeclared := validate(dagWorkflow(
		dagContract("quarantine", "calc", nil),
		[]domain.Node{
			{ID: "calc", Type: "transform", Config: map[string]any{"mapping": map[string]any{"ok": "true"}}},
			{ID: "notify", Type: "http", Config: map[string]any{"url": "https://example.com", "method": "POST"}},
		},
		[]domain.Edge{{From: "calc", To: "notify"}},
	))
	if !strings.Contains(issueCodes(undeclared), "semantic_effect_not_declared") {
		t.Fatalf("undeclared write-side effect must fail: %s", issueCodes(undeclared))
	}

	// 4. Deferred-completion source refuses (approval completes outside
	// the inline interception point); router refuses quarantine.
	deferred := validate(dagWorkflow(
		dagContract("observe", "gate", nil),
		[]domain.Node{{ID: "gate", Type: "approval", Config: map[string]any{}}},
		[]domain.Edge{},
	))
	if !strings.Contains(issueCodes(deferred), "semantic_detector_deferred_source") {
		t.Fatalf("deferred source must refuse: %s", issueCodes(deferred))
	}

	// 5. Unknown source + fixture without detector.
	unknown := validate(dagWorkflow(
		dagContract("observe", "fantasma", nil),
		[]domain.Node{{ID: "calc", Type: "noop", Config: map[string]any{}}},
		[]domain.Edge{},
	))
	codes := issueCodes(unknown)
	if !strings.Contains(codes, "semantic_detector_unknown_source") ||
		!strings.Contains(codes, "semantic_fixture_unknown_source") {
		t.Fatalf("unknown source rules: %s", codes)
	}

	// 6. Fixture qualification through the REAL evaluator: a fixture whose
	// expectation contradicts the detector fails; a detector without a
	// violation fixture fails.
	mismatch := dagContract("observe", "calc", nil)
	mismatch.Failure.Semantic.EvaluationFixtures[0].Output = map[string]any{"ok": false} // expected pass, evaluates violation
	badFixtures := validate(dagWorkflow(mismatch,
		[]domain.Node{{ID: "calc", Type: "transform", Config: map[string]any{"mapping": map[string]any{"ok": "true"}}}},
		[]domain.Edge{},
	))
	codes = issueCodes(badFixtures)
	if !strings.Contains(codes, "semantic_fixture_mismatch") ||
		!strings.Contains(codes, "semantic_detector_missing_pass_fixture") {
		t.Fatalf("fixture qualification: %s", codes)
	}

	// 7. A malformed detector expression is a save-time issue AND fails
	// its fixtures — never a silent pass.
	broken := dagContract("observe", "calc", nil)
	broken.Failure.Semantic.Detectors[0].PassWhen = "context.calc.output.ok &&& nope"
	brokenResult := validate(dagWorkflow(broken,
		[]domain.Node{{ID: "calc", Type: "transform", Config: map[string]any{"mapping": map[string]any{"ok": "true"}}}},
		[]domain.Edge{},
	))
	codes = issueCodes(brokenResult)
	if !strings.Contains(codes, "semantic_detector_invalid_expression") {
		t.Fatalf("malformed expression must surface at save: %s", codes)
	}
}
