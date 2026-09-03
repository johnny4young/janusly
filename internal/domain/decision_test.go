package domain

import (
	"reflect"
	"testing"
)

func TestNormalizeDecisionCandidatesAcceptsCanonicalAndLegacyIDs(t *testing.T) {
	got := NormalizeDecisionCandidates([]any{
		map[string]any{"nodeId": " canonical ", "id": "ignored", "avgCost": 0.1, "avgLatencyMs": 25, "successRate": 0.9},
		map[string]any{"id": " legacy ", "avgCost": 2},
		map[string]any{"nodeId": " "},
		"invalid",
	})
	want := []DecisionCandidate{
		{NodeID: "canonical", AvgCost: 0.1, AvgLatencyMs: 25, SuccessRate: 0.9},
		{NodeID: "legacy", AvgCost: 2},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("normalized candidates = %#v, want %#v", got, want)
	}
}

func TestDecideMatchesStrategyConstraintBudgetAndReinforcementOrder(t *testing.T) {
	candidates := []DecisionCandidate{
		{NodeID: "fast", AvgCost: 0.01, AvgLatencyMs: 20, SuccessRate: 0.98},
		{NodeID: "safe", AvgCost: 0.03, AvgLatencyMs: 80, SuccessRate: 0.99},
	}

	t.Run("balanced defaults", func(t *testing.T) {
		got := Decide(DecisionInput{Candidates: candidates, Strategy: "balanced"})
		if got.ChosenNodeID != "fast" || got.Reason != "Selected fast using balanced strategy: cost=0.01, latency=20, quality=0.98" {
			t.Fatalf("decision = %+v", got)
		}
		if got.Confidence != 0.5 || len(got.Ranking) != 2 {
			t.Fatalf("confidence/ranking = %+v", got)
		}
	})

	t.Run("constraints", func(t *testing.T) {
		got := Decide(DecisionInput{
			Candidates:  candidates,
			Preferences: &DecisionPreferences{MinSuccessRate: new(99.0), MaxLatencyMs: new(100.0)},
		})
		if got.ChosenNodeID != "safe" || len(got.Ranking) != 1 {
			t.Fatalf("constrained decision = %+v", got)
		}
	})

	t.Run("all constraints failing fall back", func(t *testing.T) {
		got := Decide(DecisionInput{
			Candidates:  candidates,
			Preferences: &DecisionPreferences{MinSuccessRate: new(1.1), MaxLatencyMs: new(1.0)},
		})
		if got.ChosenNodeID != "fast" || len(got.Ranking) != 2 {
			t.Fatalf("fallback decision = %+v", got)
		}
	})

	t.Run("budget keeps the ordered safe subset", func(t *testing.T) {
		got := Decide(DecisionInput{
			Candidates: candidates, Strategy: "fastest",
			Budget: &DecisionBudget{LimitUSD: new(0.02)},
		})
		if got.ChosenNodeID != "fast" || len(got.Ranking) != 1 {
			t.Fatalf("budget decision = %+v", got)
		}
	})

	t.Run("budget with no safe candidate falls back", func(t *testing.T) {
		got := Decide(DecisionInput{
			Candidates: candidates,
			Budget:     &DecisionBudget{LimitUSD: new(0.001)},
		})
		if got.ChosenNodeID != "fast" || len(got.Ranking) != 2 {
			t.Fatalf("budget fallback = %+v", got)
		}
	})

	t.Run("reinforcement starts at three pulls", func(t *testing.T) {
		equal := []DecisionCandidate{
			{NodeID: "historical", SuccessRate: 0.5},
			{NodeID: "baseline", SuccessRate: 0.6},
		}
		withoutBias := Decide(DecisionInput{
			Candidates: equal,
			RLStats:    map[string]RoutingStat{"historical": {Pulls: 2, MeanReward: 1}},
		})
		if withoutBias.ChosenNodeID != "baseline" {
			t.Fatalf("two pulls must not bias: %+v", withoutBias)
		}
		withBias := Decide(DecisionInput{
			Candidates: equal,
			RLStats:    map[string]RoutingStat{"historical": {Pulls: 3, MeanReward: 1}},
		})
		if withBias.ChosenNodeID != "historical" {
			t.Fatalf("three pulls must bias: %+v", withBias)
		}
	})
}

func TestDecideHandlesEmptyCandidates(t *testing.T) {
	got := Decide(DecisionInput{})
	if got.ChosenNodeID != "" || got.Reason != "No eligible candidate found" || got.Confidence != 0 || len(got.Ranking) != 0 {
		t.Fatalf("empty decision = %+v", got)
	}
}
