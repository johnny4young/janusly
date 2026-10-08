package authoring

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"testing"
)

func TestRulesProviderPredictsFrozenLabelsWithoutSeeingThem(t *testing.T) {
	raw, err := os.ReadFile("testdata/experience-mechanics.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []DecisionMechanicsCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.ID, func(t *testing.T) {
			before, _ := json.Marshal(c.Request)
			got, err := (RulesProvider{}).Propose(t.Context(), c.Request)
			if err != nil || !reflect.DeepEqual(got, c.Expected) {
				t.Fatalf("prediction: %+v want %+v error %v", got, c.Expected, err)
			}
			receipt, err := ProposeDecision(t.Context(), RulesProvider{}, c.Request)
			if err != nil || receipt.Provider != DecisionRulesProvider {
				t.Fatalf("policy: %+v %v", receipt, err)
			}
			after, _ := json.Marshal(c.Request)
			if string(before) != string(after) {
				t.Fatal("provider mutated caller projection")
			}
		})
	}
}

func TestRulesProviderCancellationAndOutputOwnership(t *testing.T) {
	request, _ := decisionFixture(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := (RulesProvider{}).Propose(ctx, request); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled: %v", err)
	}
	request.Edits = []DescriptiveEdit{{Field: "workflow_name", Value: "Informe local"}}
	got, err := (RulesProvider{}).Propose(t.Context(), request)
	if err != nil || got.Mode != DecisionAdapt {
		t.Fatalf("adapt: %+v %v", got, err)
	}
	got.Edits[0].Value = "poisoned"
	if request.Edits[0].Value != "Informe local" {
		t.Fatal("output aliases input")
	}
	request.Candidates = append(request.Candidates, request.Candidates[0])
	if _, err := (RulesProvider{}).Propose(t.Context(), request); err == nil {
		t.Fatal("duplicate candidate accepted")
	}
}
