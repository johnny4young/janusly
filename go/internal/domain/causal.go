// Causal-reasoning replay (T-520; reference packages/domain/src/
// causalReasoning.ts + decisionEngine.ts scoring): given a recorded
// decision (chosen candidate + alternatives), recompute scores under the
// current preferences so the UI can show "why this won" without
// re-running the original LLM call. Pure logic, no I/O, no LLM — always
// available.
package domain

import (
	"fmt"
	"sort"
)

// DecisionCandidate mirrors the reference candidate profile.
type DecisionCandidate struct {
	NodeID       string
	AvgCost      float64
	AvgLatencyMs float64
	SuccessRate  float64
}

// DecisionPreferences weight the scoring axes; zero-value = the
// reference defaults (40/40/20).
type DecisionPreferences struct {
	WeightCost    *float64
	WeightLatency *float64
	WeightQuality *float64
}

// RankedDecisionCandidate is one scored row (lower score = better).
type RankedDecisionCandidate struct {
	NodeID    string            `json:"nodeId"`
	Score     float64           `json:"score"`
	Breakdown DecisionBreakdown `json:"breakdown"`
}

// DecisionBreakdown carries the per-axis raw values.
type DecisionBreakdown struct {
	Cost    float64 `json:"cost"`
	Latency float64 `json:"latency"`
	Quality float64 `json:"quality"`
	Penalty float64 `json:"penalty"`
}

// DecisionAlternative is a non-chosen row with deltas vs the chosen one.
type DecisionAlternative struct {
	NodeID       string            `json:"nodeId"`
	ScoreDelta   float64           `json:"scoreDelta"`
	CostDelta    float64           `json:"costDelta"`
	LatencyDelta float64           `json:"latencyDelta"`
	QualityDelta float64           `json:"qualityDelta"`
	Breakdown    DecisionBreakdown `json:"breakdown"`
}

// DecisionReplayInput mirrors the reference input shape.
type DecisionReplayInput struct {
	ChosenNodeID string
	Candidates   []DecisionCandidate
	Preferences  *DecisionPreferences
	Strategy     string // "auto" | "cheapest" | "fastest" | "balanced"
}

// DecisionReplayResult is the wire shape of GET /causal.
type DecisionReplayResult struct {
	Chosen       *RankedDecisionCandidate  `json:"chosen"`
	Best         *RankedDecisionCandidate  `json:"best"`
	Ranking      []RankedDecisionCandidate `json:"ranking"`
	Alternatives []DecisionAlternative     `json:"alternatives"`
	Explanation  string                    `json:"explanation"`
}

func normalizedDecisionWeights(preferences *DecisionPreferences) (cost, latency, quality float64) {
	cost, latency, quality = 40, 40, 20
	if preferences != nil {
		if preferences.WeightCost != nil {
			cost = *preferences.WeightCost
		}
		if preferences.WeightLatency != nil {
			latency = *preferences.WeightLatency
		}
		if preferences.WeightQuality != nil {
			quality = *preferences.WeightQuality
		}
	}
	total := cost + latency + quality
	if total == 0 {
		total = 1
	}
	return cost / total, latency / total, quality / total
}

// ScoreDecisionCandidate applies the reference formula: weighted cost +
// weighted latency + weighted (1 - quality) penalty; lower is better.
func ScoreDecisionCandidate(candidate DecisionCandidate, preferences *DecisionPreferences) RankedDecisionCandidate {
	weightCost, weightLatency, weightQuality := normalizedDecisionWeights(preferences)
	penalty := 1 - candidate.SuccessRate
	return RankedDecisionCandidate{
		NodeID: candidate.NodeID,
		Score:  weightCost*candidate.AvgCost + weightLatency*candidate.AvgLatencyMs + weightQuality*penalty,
		Breakdown: DecisionBreakdown{
			Cost: candidate.AvgCost, Latency: candidate.AvgLatencyMs,
			Quality: candidate.SuccessRate, Penalty: penalty,
		},
	}
}

// ReplayDecision recomputes the ranking and explains the recorded choice.
func ReplayDecision(input DecisionReplayInput) DecisionReplayResult {
	ranking := make([]RankedDecisionCandidate, 0, len(input.Candidates))
	for _, candidate := range input.Candidates {
		ranking = append(ranking, ScoreDecisionCandidate(candidate, input.Preferences))
	}
	switch input.Strategy {
	case "cheapest":
		sort.SliceStable(ranking, func(a, b int) bool { return ranking[a].Breakdown.Cost < ranking[b].Breakdown.Cost })
	case "fastest":
		sort.SliceStable(ranking, func(a, b int) bool { return ranking[a].Breakdown.Latency < ranking[b].Breakdown.Latency })
	default:
		sort.SliceStable(ranking, func(a, b int) bool { return ranking[a].Score < ranking[b].Score })
	}

	var chosen, best *RankedDecisionCandidate
	if len(ranking) > 0 {
		best = &ranking[0]
		chosen = best
		for i := range ranking {
			if ranking[i].NodeID == input.ChosenNodeID {
				chosen = &ranking[i]
				break
			}
		}
	}
	alternatives := make([]DecisionAlternative, 0, len(ranking))
	for _, item := range ranking {
		if chosen != nil && item.NodeID == chosen.NodeID {
			continue
		}
		alternatives = append(alternatives, DecisionAlternative{
			NodeID:       item.NodeID,
			ScoreDelta:   item.Score - chosen.Score,
			CostDelta:    item.Breakdown.Cost - chosen.Breakdown.Cost,
			LatencyDelta: item.Breakdown.Latency - chosen.Breakdown.Latency,
			QualityDelta: item.Breakdown.Quality - chosen.Breakdown.Quality,
			Breakdown:    item.Breakdown,
		})
	}
	explanation := "No candidate could be replayed."
	if chosen != nil {
		explanation = fmt.Sprintf("Chosen %s because it ranked with score=%v. Best replay candidate is %s.",
			chosen.NodeID, chosen.Score, best.NodeID)
	}
	return DecisionReplayResult{
		Chosen: chosen, Best: best, Ranking: ranking,
		Alternatives: alternatives, Explanation: explanation,
	}
}
