package packs

import (
	"encoding/json"
	"testing"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/recovery"
)

// The boot validation IS the contract — every embedded pack
// parsed, workflow-valid, unique; the accessors behave.
func TestCatalogBootInvariants(t *testing.T) {
	all := List()
	if len(all) == 0 {
		t.Fatal("the embedded catalog must not be empty")
	}
	seen := map[string]bool{}
	for _, pack := range all {
		if pack.ID == "" || pack.Name == "" || pack.NodeCount == 0 {
			t.Fatalf("pack invariants: %+v", pack)
		}
		if seen[pack.ID] {
			t.Fatalf("duplicate pack id %s", pack.ID)
		}
		seen[pack.ID] = true
		if len(pack.SamplePayloads) == 0 {
			t.Fatalf("pack %s has no sample payloads", pack.ID)
		}
		if got := Get(pack.ID); got == nil || got.ID != pack.ID {
			t.Fatalf("Get(%s) must return the pack", pack.ID)
		}
	}
	if Get("no-such-pack") != nil {
		t.Fatal("unknown id must return nil")
	}
}

func TestFailedPaymentPackIsQualifiedFlagship(t *testing.T) {
	pack := Get("failed-payment-recovery")
	if pack == nil {
		t.Fatal("flagship pack missing")
	}
	if !pack.IntentContract || pack.RecoveryContractVersion != "2" || pack.QualificationFixtureCount != 2 {
		t.Fatalf("flagship assurance projection: %+v", pack)
	}
	wf, issues := domain.Parse(pack.WorkflowJSON)
	if wf == nil || len(issues) > 0 {
		t.Fatalf("parse flagship: %+v", issues)
	}
	validation := domain.ValidateWithSemanticFixtures(
		wf, grammar.DomainValidator, recovery.FixtureOutcomesForValidation,
	)
	if !validation.Valid {
		raw, _ := json.Marshal(validation.Issues)
		t.Fatalf("flagship fixtures must qualify at startup: %s", raw)
	}
	contract := wf.Recovery.Contract
	if contract.AutonomyLevel != 2 || contract.Approval.ProductionMutation != "required" {
		t.Fatalf("flagship must stay human-governed: %+v", contract)
	}
	if len(contract.Effects) != 3 || contract.Effects[1].Kind != "financial_mutation" {
		t.Fatalf("flagship effects must be explicit: %+v", contract.Effects)
	}
}
