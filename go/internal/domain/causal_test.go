package domain

import "testing"

// T-520: the deterministic decision replay — reference scoring formula
// (weighted cost + latency + quality penalty, 40/40/20 defaults, lower
// wins), strategy sorts, deltas vs the chosen row, and the exact
// explanation strings.

func TestReplayDecisionAutoRanking(t *testing.T) {
	result := ReplayDecision(DecisionReplayInput{
		ChosenNodeID: "slow-but-good",
		Strategy:     "auto",
		Candidates: []DecisionCandidate{
			{NodeID: "cheap-fast", AvgCost: 0.1, AvgLatencyMs: 0.2, SuccessRate: 0.5},
			{NodeID: "slow-but-good", AvgCost: 0.4, AvgLatencyMs: 0.9, SuccessRate: 0.99},
		},
	})
	// cheap-fast: .4*.1 + .4*.2 + .2*.5 = 0.22 ; slow-but-good: .4*.4+.4*.9+.2*.01 = 0.522
	if result.Best.NodeID != "cheap-fast" || result.Chosen.NodeID != "slow-but-good" {
		t.Fatalf("ranking: best=%+v chosen=%+v", result.Best, result.Chosen)
	}
	if diff := result.Best.Score - 0.22; diff > 1e-9 || diff < -1e-9 {
		t.Fatalf("reference formula drifted: %v", result.Best.Score)
	}
	if len(result.Alternatives) != 1 || result.Alternatives[0].NodeID != "cheap-fast" {
		t.Fatalf("alternatives: %+v", result.Alternatives)
	}
	if result.Alternatives[0].ScoreDelta >= 0 {
		t.Fatalf("the better alternative must carry a negative score delta: %+v", result.Alternatives[0])
	}
	if result.Explanation == "" || result.Explanation[:7] != "Chosen " {
		t.Fatalf("explanation shape: %q", result.Explanation)
	}
}

func TestReplayDecisionStrategiesAndEmpty(t *testing.T) {
	candidates := []DecisionCandidate{
		{NodeID: "pricey-fast", AvgCost: 9, AvgLatencyMs: 1, SuccessRate: 1},
		{NodeID: "cheap-slow", AvgCost: 1, AvgLatencyMs: 9, SuccessRate: 1},
	}
	if got := ReplayDecision(DecisionReplayInput{Strategy: "cheapest", Candidates: candidates}); got.Best.NodeID != "cheap-slow" {
		t.Fatalf("cheapest: %+v", got.Best)
	}
	if got := ReplayDecision(DecisionReplayInput{Strategy: "fastest", Candidates: candidates}); got.Best.NodeID != "pricey-fast" {
		t.Fatalf("fastest: %+v", got.Best)
	}
	empty := ReplayDecision(DecisionReplayInput{Strategy: "auto"})
	if empty.Chosen != nil || empty.Explanation != "No candidate could be replayed." {
		t.Fatalf("empty replay: %+v", empty)
	}
}
