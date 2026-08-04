package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func baseContract(version string) *RecoveryContract {
	contract := &RecoveryContract{Version: version}
	contract.Failure.Technical.TerminalNodeFailure = true
	contract.Evidence.Required = []string{"failure_snapshot", "audit_trail", "terminal_outcome"}
	contract.Repairs.Allowed = []string{"retry", "config_patch"}
	contract.Validation.MinimumEvidenceLevel = "static"
	contract.Approval.ProductionMutation = "required"
	contract.Approval.Permission = "recovery.write"
	contract.AutonomyLevel = 2
	contract.Verification.Kind = "generation_bound_terminal_success"
	contract.Recurrence.WindowDays = 7
	if version == "1" {
		contract.Failure.Semantic.Mode = "disabled"
	} else {
		contract.Failure.Semantic.Mode = "deterministic"
		contract.Failure.Semantic.Detectors = []RecoverySemanticDetector{{
			ID: "det-1", SourceNodeID: "calc", Kind: "expression",
			PassWhen: "context.calc.output.total <= 100", Action: "quarantine",
			Message: "total exceeds cap",
		}}
		contract.Failure.Semantic.EvaluationFixtures = []RecoverySemanticFixture{
			{ID: "fx-pass", SourceNodeID: "calc", Output: map[string]any{"total": float64(50)}, Expected: "pass"},
			{ID: "fx-violation", SourceNodeID: "calc", Output: map[string]any{"total": float64(500)}, Expected: "violation"},
		}
	}
	return contract
}

func hasProblem(problems []string, fragment string) bool {
	for _, problem := range problems {
		if strings.Contains(problem, fragment) {
			return true
		}
	}
	return false
}

// The versioned rules implements recovery-contract.ts.
func TestRecoveryContractValidation(t *testing.T) {
	if problems := ValidateRecoveryContract(baseContract("1")); len(problems) != 0 {
		t.Fatalf("valid v1: %v", problems)
	}
	if problems := ValidateRecoveryContract(baseContract("2")); len(problems) != 0 {
		t.Fatalf("valid v2: %v", problems)
	}

	// THE HARD RULE: a v1 snapshot can never activate semantic detection.
	v1Semantic := baseContract("1")
	v1Semantic.Failure.Semantic.Mode = "deterministic"
	v1Semantic.Failure.Semantic.Detectors = baseContract("2").Failure.Semantic.Detectors
	problems := ValidateRecoveryContract(v1Semantic)
	if !hasProblem(problems, `contract v1 requires semantic mode "disabled"`) ||
		!hasProblem(problems, "cannot declare detectors") {
		t.Fatalf("v1 must never activate semantics: %v", problems)
	}

	// Failure-specific autonomy above the workflow ceiling.
	overCeiling := baseContract("1")
	overCeiling.Failure.Technical.Autonomy = map[string]int{"terminalNodeFailure": 3}
	if !hasProblem(ValidateRecoveryContract(overCeiling), "cannot exceed the workflow recovery level") {
		t.Fatal("failure autonomy above ceiling must fail")
	}
	detectorOver := baseContract("2")
	three := 3
	detectorOver.Failure.Semantic.Detectors[0].AutonomyLevel = &three
	if !hasProblem(ValidateRecoveryContract(detectorOver), "cannot exceed the workflow recovery level") {
		t.Fatal("detector autonomy above ceiling must fail")
	}

	// Base evidence must be retained; duplicates refuse.
	missingBase := baseContract("1")
	missingBase.Evidence.Required = []string{"failure_snapshot", "audit_trail"}
	if !hasProblem(ValidateRecoveryContract(missingBase), "must retain terminal_outcome") {
		t.Fatal("missing base evidence must fail")
	}
	dupEffects := baseContract("1")
	dupEffects.Effects = []RecoveryEffect{
		{NodeID: "n", Kind: "external_write", Idempotency: "required", Receipt: "runtime"},
		{NodeID: "n", Kind: "notification", Idempotency: "required", Receipt: "runtime"},
	}
	if !hasProblem(ValidateRecoveryContract(dupEffects), "only one recovery effect") {
		t.Fatal("duplicate effect nodes must fail")
	}

	// Validation-level implications.
	needsReceipt := baseContract("1")
	needsReceipt.Validation.MinimumEvidenceLevel = "writes_skipped"
	if !hasProblem(ValidateRecoveryContract(needsReceipt), "requires validation_receipt") {
		t.Fatal("above-static evidence must demand validation_receipt")
	}

	// Level 4: the full bundle of requirements.
	level4 := baseContract("2")
	level4.AutonomyLevel = 4
	problems = ValidateRecoveryContract(level4)
	for _, fragment := range []string{
		"provider_simulated or live_canary evidence",
		"autonomous_level_4 mutation policy",
		"prior-evidence, blast-radius, and rollback bounds",
	} {
		if !hasProblem(problems, fragment) {
			t.Fatalf("bare level 4 must demand %q: %v", fragment, problems)
		}
	}
	level4.Validation.MinimumEvidenceLevel = "provider_simulated"
	level4.Evidence.Required = append(level4.Evidence.Required, "validation_receipt", "effect_receipt")
	level4.Approval.ProductionMutation = "autonomous_level_4"
	level4.NarrowAutonomy = &RecoveryNarrowAutonomy{
		AllowedRepairClasses: []string{"retry"}, MinimumPriorVerifiedRecoveries: 3,
		MaxAffectedExecutions: 10, RollbackRequired: true,
	}
	if problems := ValidateRecoveryContract(level4); len(problems) != 0 {
		t.Fatalf("complete level 4 must validate: %v", problems)
	}
	level4.Effects = []RecoveryEffect{{NodeID: "pay", Kind: "financial_mutation", Idempotency: "unavailable", Receipt: "manual"}}
	problems = ValidateRecoveryContract(level4)
	if !hasProblem(problems, "without idempotency") || !hasProblem(problems, "manual effect receipt") {
		t.Fatalf("level 4 effect constraints: %v", problems)
	}

	// Below level 4: autonomous mutation + narrow bounds are invalid.
	below := baseContract("1")
	below.Approval.ProductionMutation = "autonomous_level_4"
	below.NarrowAutonomy = &RecoveryNarrowAutonomy{AllowedRepairClasses: []string{"retry"},
		MinimumPriorVerifiedRecoveries: 1, MaxAffectedExecutions: 1, RollbackRequired: true}
	problems = ValidateRecoveryContract(below)
	if !hasProblem(problems, "valid only at autonomy level 4") {
		t.Fatalf("below-4 constraints: %v", problems)
	}

	// V2 uniqueness + fixture bounds.
	dupDetectors := baseContract("2")
	dupDetectors.Failure.Semantic.Detectors = append(dupDetectors.Failure.Semantic.Detectors,
		dupDetectors.Failure.Semantic.Detectors[0])
	if !hasProblem(ValidateRecoveryContract(dupDetectors), "detector ids must be unique") {
		t.Fatal("duplicate detector ids must fail")
	}
	oneFixture := baseContract("2")
	oneFixture.Failure.Semantic.EvaluationFixtures = oneFixture.Failure.Semantic.EvaluationFixtures[:1]
	if !hasProblem(ValidateRecoveryContract(oneFixture), "2..50 fixtures") {
		t.Fatal("fixture floor must fail")
	}
}

// Circuit-breaker union parsing (false | 2..100 | {consecutiveFailures}).
func TestParseCircuitBreakerThreshold(t *testing.T) {
	cases := []struct {
		raw       string
		threshold int
		enabled   bool
		problem   bool
	}{
		{"", 0, false, false},
		{"false", 0, false, false},
		{"true", 0, false, true},
		{"5", 5, true, false},
		{"1", 0, false, true},
		{"101", 0, false, true},
		{"2.5", 0, false, true},
		{`{"consecutiveFailures": 7}`, 7, true, false},
		{`{"consecutiveFailures": false}`, 0, false, false},
		{`"cinco"`, 0, false, true},
	}
	for _, tc := range cases {
		threshold, enabled, problem := ParseCircuitBreakerThreshold(json.RawMessage(tc.raw))
		if threshold != tc.threshold || enabled != tc.enabled || (problem != "") != tc.problem {
			t.Fatalf("%q → (%d,%v,%q)", tc.raw, threshold, enabled, problem)
		}
	}
}

// The contract validates at Parse: an invalid contract yields
// invalid_contract issues with the recovery.contract path (Node consistency).
func TestWorkflowParseValidatesRecoveryContract(t *testing.T) {
	doc := `{"id":"wf","name":"W","dslVersion":"1.0",
		"recovery":{"contract":{"version":"1",
			"failure":{"technical":{"terminalNodeFailure":true,"stalledNode":false},"semantic":{"mode":"deterministic"}},
			"evidence":{"required":["failure_snapshot","audit_trail","terminal_outcome"]},
			"effects":[],"repairs":{"allowed":["retry"]},
			"validation":{"minimumEvidenceLevel":"static"},
			"approval":{"productionMutation":"required","permission":"recovery.write"},
			"autonomyLevel":1,
			"verification":{"kind":"generation_bound_terminal_success"},
			"recurrence":{"windowDays":7}}},
		"nodes":[{"id":"n","type":"noop","config":{}}],"edges":[]}`
	wf, issues := Parse([]byte(doc))
	if wf != nil || len(issues) == 0 {
		t.Fatalf("invalid contract must fail parse: %v", issues)
	}
	found := false
	for _, issue := range issues {
		if issue.Code == CodeInvalidContract && strings.Contains(issue.Message, "recovery.contract") {
			found = true
		}
	}
	if !found {
		t.Fatalf("invalid_contract with recovery path expected: %v", issues)
	}

	valid := strings.Replace(doc, `"semantic":{"mode":"deterministic"}`, `"semantic":{"mode":"disabled"}`, 1)
	wf, issues = Parse([]byte(valid))
	if wf == nil || len(issues) != 0 {
		t.Fatalf("valid contract must parse: %v", issues)
	}
	if wf.Recovery == nil || wf.Recovery.Contract == nil || wf.Recovery.Contract.Version != "1" {
		t.Fatal("recovery block must survive the parse")
	}
}
