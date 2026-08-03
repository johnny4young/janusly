package domain

import "testing"

func autonomyContract(workflowLevel int, detectorLevel *int) *RecoveryContract {
	contract := &RecoveryContract{Version: "2"}
	contract.Failure.Technical.TerminalNodeFailure = true
	contract.Failure.Technical.StalledNode = true
	contract.Failure.Semantic.Mode = "deterministic"
	contract.Failure.Semantic.Detectors = []RecoverySemanticDetector{{
		ID: "approved-answer", SourceNodeID: "answer", Kind: "expression",
		PassWhen: "context.answer.output.approved === true",
		Action:   "quarantine", Message: "Answer must be approved",
		AutonomyLevel: detectorLevel,
	}}
	contract.Failure.Semantic.EvaluationFixtures = []RecoverySemanticFixture{
		{ID: "approved", SourceNodeID: "answer", Output: map[string]any{"approved": true}, Expected: "pass"},
		{ID: "unapproved", SourceNodeID: "answer", Output: map[string]any{"approved": false}, Expected: "violation"},
	}
	contract.Evidence.Required = []string{"failure_snapshot", "audit_trail", "terminal_outcome"}
	contract.Repairs.Allowed = []string{"config_patch"}
	contract.Validation.MinimumEvidenceLevel = "static"
	contract.Approval.ProductionMutation = "required"
	contract.Approval.Permission = "recovery.write"
	contract.AutonomyLevel = workflowLevel
	contract.Verification.Kind = "generation_bound_terminal_success"
	contract.Recurrence.WindowDays = 7
	return contract
}

// Ports recovery-autonomy.test.ts: workflow default, lower override as
// the effective ceiling, fail-closed on missing policy, and the
// strictest-detector combination for same-source cohorts.
func TestResolveRecoveryAutonomyProfile(t *testing.T) {
	// Anchor the ladder to the contract validator first (the test
	// contracts must be VALID contracts).
	if problems := ValidateRecoveryContract(autonomyContract(3, nil)); len(problems) != 0 {
		t.Fatalf("fixture contract must validate: %v", problems)
	}

	inherit := ResolveRecoveryAutonomyProfile(autonomyContract(3, nil),
		RecoveryFailureClass{Kind: "semantic", DetectorID: "approved-answer"})
	if inherit.Level == nil || *inherit.Level != 3 || inherit.Source != "workflow_default" {
		t.Fatalf("workflow default: %+v", inherit)
	}
	c := inherit.Capabilities
	if !c.Observe || !c.Recommend || !c.Validate || !c.ApplyWithApproval || c.AutonomousApply {
		t.Fatalf("level 3 capabilities: %+v", c)
	}

	one := 1
	override := ResolveRecoveryAutonomyProfile(autonomyContract(3, &one),
		RecoveryFailureClass{Kind: "semantic", DetectorID: "approved-answer"})
	if override.Level == nil || *override.Level != 1 || override.Source != "failure_override" ||
		len(override.DetectorIDs) != 1 || override.DetectorIDs[0] != "approved-answer" {
		t.Fatalf("lower override: %+v", override)
	}
	wantEnabled := []bool{true, true, false, false, false}
	for i, factor := range override.Factors {
		if factor.Enabled != wantEnabled[i] {
			t.Fatalf("factor ladder at %d: %+v", i, override.Factors)
		}
	}

	missing := ResolveRecoveryAutonomyProfile(autonomyContract(3, nil),
		RecoveryFailureClass{Kind: "semantic", DetectorID: "missing"})
	if missing.Level != nil || missing.Source != "unavailable" ||
		missing.UnavailableReason == nil || *missing.UnavailableReason != "failure_policy_missing" ||
		missing.Capabilities.ApplyWithApproval || missing.Capabilities.AutonomousApply {
		t.Fatalf("fail closed: %+v", missing)
	}

	// Technical classes: override wins when present, default otherwise.
	techContract := autonomyContract(3, nil)
	techContract.Failure.Technical.Autonomy = map[string]int{"stalledNode": 0}
	stalled := ResolveRecoveryAutonomyProfile(techContract,
		RecoveryFailureClass{Kind: "technical", Failure: "stalled_node"})
	if stalled.Level == nil || *stalled.Level != 0 || stalled.Source != "failure_override" {
		t.Fatalf("technical override: %+v", stalled)
	}
	terminal := ResolveRecoveryAutonomyProfile(techContract,
		RecoveryFailureClass{Kind: "technical", Failure: "terminal_node_failure"})
	if terminal.Level == nil || *terminal.Level != 3 || terminal.Source != "workflow_default" {
		t.Fatalf("technical default: %+v", terminal)
	}

	// No contract at all → unavailable, contract_missing.
	none := ResolveRecoveryAutonomyProfile(nil,
		RecoveryFailureClass{Kind: "semantic", DetectorID: "d"})
	if none.Level != nil || none.UnavailableReason == nil || *none.UnavailableReason != "contract_missing" {
		t.Fatalf("missing contract: %+v", none)
	}

	// A V1 contract has no semantic policy → fail closed for semantics,
	// but technical classes still resolve.
	v1 := autonomyContract(2, nil)
	v1.Version = "1"
	v1.Failure.Semantic = RecoverySemanticFailure{Mode: "disabled"}
	semanticV1 := ResolveRecoveryAutonomyProfile(v1,
		RecoveryFailureClass{Kind: "semantic", DetectorID: "approved-answer"})
	if semanticV1.Level != nil || semanticV1.UnavailableReason == nil || *semanticV1.UnavailableReason != "failure_policy_missing" {
		t.Fatalf("v1 semantic must fail closed: %+v", semanticV1)
	}
	technicalV1 := ResolveRecoveryAutonomyProfile(v1,
		RecoveryFailureClass{Kind: "technical", Failure: "terminal_node_failure"})
	if technicalV1.Level == nil || *technicalV1.Level != 2 {
		t.Fatalf("v1 technical must resolve: %+v", technicalV1)
	}
}

// The strictest same-source detector governs; an unavailable member fails
// the aggregate closed; detector ids merge deduplicated.
func TestCombineRecoveryAutonomyProfiles(t *testing.T) {
	one := 1
	combined := CombineRecoveryAutonomyProfiles([]RecoveryAutonomyProfile{
		ResolveRecoveryAutonomyProfile(autonomyContract(3, nil),
			RecoveryFailureClass{Kind: "semantic", DetectorID: "approved-answer"}),
		ResolveRecoveryAutonomyProfile(autonomyContract(3, &one),
			RecoveryFailureClass{Kind: "semantic", DetectorID: "approved-answer"}),
	})
	if combined.Level == nil || *combined.Level != 1 || combined.Source != "strictest_failure" ||
		combined.Capabilities.ApplyWithApproval {
		t.Fatalf("strictest must govern: %+v", combined)
	}
	if len(combined.DetectorIDs) != 1 || combined.DetectorIDs[0] != "approved-answer" {
		t.Fatalf("detector ids must dedupe: %+v", combined.DetectorIDs)
	}

	// Any unavailable member → the whole aggregate fails closed.
	poisoned := CombineRecoveryAutonomyProfiles([]RecoveryAutonomyProfile{
		ResolveRecoveryAutonomyProfile(autonomyContract(3, nil),
			RecoveryFailureClass{Kind: "semantic", DetectorID: "approved-answer"}),
		ResolveRecoveryAutonomyProfile(autonomyContract(3, nil),
			RecoveryFailureClass{Kind: "semantic", DetectorID: "missing"}),
	})
	if poisoned.Level != nil || poisoned.Source != "unavailable" {
		t.Fatalf("unavailable member must poison the aggregate: %+v", poisoned)
	}

	// Empty input fails closed; single input keeps its own source.
	if empty := CombineRecoveryAutonomyProfiles(nil); empty.Level != nil {
		t.Fatalf("empty must fail closed: %+v", empty)
	}
	single := CombineRecoveryAutonomyProfiles([]RecoveryAutonomyProfile{
		ResolveRecoveryAutonomyProfile(autonomyContract(3, nil),
			RecoveryFailureClass{Kind: "semantic", DetectorID: "approved-answer"}),
	})
	if single.Source != "workflow_default" {
		t.Fatalf("single profile keeps its source: %+v", single)
	}
}
