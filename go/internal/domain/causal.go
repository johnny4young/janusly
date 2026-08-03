// Causal-reasoning replay (T-520; reference packages/domain/src/
// causalReasoning.ts + decisionEngine.ts scoring): given a recorded
// decision (chosen candidate + alternatives), recompute scores under the
// current preferences so the UI can show "why this won" without
// re-running the original LLM call. Pure logic, no I/O, no LLM — always
// available.
package domain

import (
	"fmt"
	"math"
	"reflect"
	"sort"
	"strings"
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
	WeightCost     *float64
	WeightLatency  *float64
	WeightQuality  *float64
	MinSuccessRate *float64
	MaxLatencyMs   *float64
}

// DecisionBudget optionally removes candidates whose declared average cost
// exceeds the run's routing budget. When every candidate exceeds the limit,
// the unfiltered ranking remains available instead of producing no route.
type DecisionBudget struct {
	LimitUSD *float64
}

// RoutingStat is the bounded reinforcement input used by Decide. The engine
// loads it tenant-scoped from routing_stats; candidates need at least three
// observations before the small historical bias applies.
type RoutingStat struct {
	Pulls      int32
	MeanReward float64
}

// DecisionInput is the deterministic router contract shared by router and
// router_llm nodes. The latter name is retained for workflow compatibility;
// neither type calls an LLM in the supported runtime.
type DecisionInput struct {
	Candidates  []DecisionCandidate
	Preferences *DecisionPreferences
	Budget      *DecisionBudget
	RLStats     map[string]RoutingStat
	Strategy    string // "auto" | "cheapest" | "fastest" | "balanced"
}

// DecisionOutput is persisted under the router node's output and emitted as
// the decision.made event payload.
type DecisionOutput struct {
	ChosenNodeID string                    `json:"chosenNodeId,omitempty"`
	Reason       string                    `json:"reason"`
	Confidence   float64                   `json:"confidence"`
	Ranking      []RankedDecisionCandidate `json:"ranking"`
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

// NormalizeDecisionCandidates accepts the canonical {nodeId} shape and the
// legacy {id} alias emitted by older generated workflows. Invalid entries are
// dropped at runtime as defence in depth; validation rejects them on save.
func NormalizeDecisionCandidates(raw any) []DecisionCandidate {
	entries, ok := arrayValues(raw)
	if !ok {
		return nil
	}
	out := make([]DecisionCandidate, 0, len(entries))
	for _, entry := range entries {
		object, ok := entry.(map[string]any)
		if !ok || object == nil {
			continue
		}
		nodeID := trimmedString(object["nodeId"])
		if nodeID == "" {
			nodeID = trimmedString(object["id"])
		}
		if nodeID == "" {
			continue
		}
		candidate := DecisionCandidate{NodeID: nodeID}
		if value, ok := finiteNumber(object["avgCost"]); ok {
			candidate.AvgCost = value
		}
		if value, ok := finiteNumber(object["avgLatencyMs"]); ok {
			candidate.AvgLatencyMs = value
		}
		if value, ok := finiteNumber(object["successRate"]); ok {
			candidate.SuccessRate = value
		}
		out = append(out, candidate)
	}
	return out
}

// DecisionPreferencesFromValue projects the loose runtime context into the
// same optional numeric preferences consumed by the reference engine.
func DecisionPreferencesFromValue(value any) *DecisionPreferences {
	object, ok := value.(map[string]any)
	if !ok || object == nil {
		return nil
	}
	return &DecisionPreferences{
		WeightCost:     numberPointer(object["weightCost"]),
		WeightLatency:  numberPointer(object["weightLatency"]),
		WeightQuality:  numberPointer(object["weightQuality"]),
		MinSuccessRate: numberPointer(object["minSuccessRate"]),
		MaxLatencyMs:   numberPointer(object["maxLatencyMs"]),
	}
}

// DecisionBudgetFromValue projects an optional run-context budget.
func DecisionBudgetFromValue(value any) *DecisionBudget {
	object, ok := value.(map[string]any)
	if !ok || object == nil {
		return nil
	}
	return &DecisionBudget{LimitUSD: numberPointer(object["limitUsd"])}
}

// NormalizeDecisionStrategy keeps the runtime's closed strategy enum. An
// unknown authored value degrades to the reference's auto scoring posture.
func NormalizeDecisionStrategy(value any) string {
	strategy, _ := value.(string)
	switch strategy {
	case "auto", "cheapest", "fastest", "balanced":
		return strategy
	default:
		return ""
	}
}

// Decide applies constraints, score weighting, the bounded reinforcement
// bias, explicit strategy ordering, and the optional budget in the same order
// as the Node compatibility oracle.
func Decide(input DecisionInput) DecisionOutput {
	constrained := make([]DecisionCandidate, 0, len(input.Candidates))
	for _, candidate := range input.Candidates {
		if input.Preferences != nil && input.Preferences.MinSuccessRate != nil {
			threshold := *input.Preferences.MinSuccessRate
			if threshold > 1 {
				threshold /= 100
			}
			if candidate.SuccessRate < threshold {
				continue
			}
		}
		if input.Preferences != nil && input.Preferences.MaxLatencyMs != nil &&
			candidate.AvgLatencyMs > *input.Preferences.MaxLatencyMs {
			continue
		}
		constrained = append(constrained, candidate)
	}
	pool := constrained
	if len(pool) == 0 {
		pool = input.Candidates
	}

	ranking := make([]RankedDecisionCandidate, 0, len(pool))
	for _, candidate := range pool {
		ranked := ScoreDecisionCandidate(candidate, input.Preferences)
		if stat, ok := input.RLStats[candidate.NodeID]; ok && stat.Pulls >= 3 {
			ranked.Score -= stat.MeanReward * 0.1
		}
		ranking = append(ranking, ranked)
	}
	// applyRlAdjustments sorts by the adjusted score before the explicit
	// strategy. Stable later sorts preserve that order for equal cost/latency.
	sort.SliceStable(ranking, func(a, b int) bool { return ranking[a].Score < ranking[b].Score })
	strategy := NormalizeDecisionStrategy(input.Strategy)
	switch strategy {
	case "cheapest":
		sort.SliceStable(ranking, func(a, b int) bool { return ranking[a].Breakdown.Cost < ranking[b].Breakdown.Cost })
	case "fastest":
		sort.SliceStable(ranking, func(a, b int) bool { return ranking[a].Breakdown.Latency < ranking[b].Breakdown.Latency })
	default:
		sort.SliceStable(ranking, func(a, b int) bool { return ranking[a].Score < ranking[b].Score })
	}

	if input.Budget != nil && input.Budget.LimitUSD != nil {
		budgetSafe := make([]RankedDecisionCandidate, 0, len(ranking))
		for _, candidate := range ranking {
			if candidate.Breakdown.Cost <= *input.Budget.LimitUSD {
				budgetSafe = append(budgetSafe, candidate)
			}
		}
		if len(budgetSafe) > 0 {
			ranking = budgetSafe
		}
	}

	if len(ranking) == 0 {
		return DecisionOutput{
			Reason: "No eligible candidate found", Confidence: 0,
			Ranking: []RankedDecisionCandidate{},
		}
	}
	best := ranking[0]
	strategyLabel := strategy
	if strategyLabel == "" {
		strategyLabel = "auto"
	}
	return DecisionOutput{
		ChosenNodeID: best.NodeID,
		Reason: fmt.Sprintf("Selected %s using %s strategy: cost=%v, latency=%v, quality=%v",
			best.NodeID, strategyLabel, best.Breakdown.Cost, best.Breakdown.Latency, best.Breakdown.Quality),
		Confidence: math.Max(0.5, math.Min(1, 1-best.Score)),
		Ranking:    ranking,
	}
}

func arrayValues(value any) ([]any, bool) {
	if value == nil {
		return nil, false
	}
	raw := reflect.ValueOf(value)
	if raw.Kind() != reflect.Slice && raw.Kind() != reflect.Array {
		return nil, false
	}
	out := make([]any, raw.Len())
	for index := 0; index < raw.Len(); index++ {
		out[index] = raw.Index(index).Interface()
	}
	return out, true
}

func trimmedString(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func numberPointer(value any) *float64 {
	number, ok := finiteNumber(value)
	if !ok {
		return nil
	}
	return &number
}

func finiteNumber(value any) (float64, bool) {
	var number float64
	switch typed := value.(type) {
	case float64:
		number = typed
	case float32:
		number = float64(typed)
	case int:
		number = float64(typed)
	case int32:
		number = float64(typed)
	case int64:
		number = float64(typed)
	case uint:
		number = float64(typed)
	case uint32:
		number = float64(typed)
	case uint64:
		number = float64(typed)
	default:
		return 0, false
	}
	return number, !math.IsNaN(number) && !math.IsInf(number, 0)
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
