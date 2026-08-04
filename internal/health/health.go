// Workflow health score (reference the source contract
// + workflow-slo.ts): a single 0–100 rollup across six categories with a
// per-category breakdown, plus the declared-SLO breach evaluation. Pure
// aggregator — no I/O; the API route supplies pre-collected signals and
// the readiness result.
//
// The weights sum to 1.0 (pinned by test); categories with no signal
// land on the NEUTRAL default rather than a penalty — a never-run
// workflow is untested, not unhealthy. SLO breach booleans never change
// the numeric score; alerting consumes them independently.
package health

import (
	"fmt"
	"math"
)

const (
	NeutralDefault = 80
	HealthyFloor   = 80
	WarnFloor      = 60

	reliabilityDlqPenaltyPerRow = 5
	reliabilityDlqPenaltyCap    = 30
	reliabilityRetryFactor      = 20
	reliabilityRetryCap         = 20
	safetyFailPenalty           = 20
	safetyWarnPenalty           = 5
	costBandLowUsd              = 0.01
	costBandHighUsd             = 1.0
	latencyBandLowMs            = 5_000
	latencyBandHighMs           = 60_000
	bandLowScore                = 100
	bandHighScore               = 30
	maintainOutputsBonus        = 50
	maintainNoOutputsBase       = 30
	maintainVersionBonus        = 30
	maintainNoVersionsBase      = 10
	maintainApprovalBonus       = 20
	maintainNoApprovalBase      = 10
	aiRiskNodePenalty           = 5
	aiRiskTokenPenaltyPer100K   = 1
	aiRiskRawSecretPenalty      = 30

	// MinRunsForDelta gates the recovery before/after comparison.
	MinRunsForDelta = 5
	// SloMinSampleSize mirrors the shared evaluator's neutral rule.
	SloMinSampleSize = 5
)

// Weights sum to 1.0 — pinned by TestHealthWeightsSumToOne.
var Weights = map[string]float64{
	"reliability": 0.30, "safety": 0.25, "latency": 0.15,
	"cost": 0.10, "maintainability": 0.10, "aiRisk": 0.10,
}

// Signals are the run-time inputs collected from persistence.
type Signals struct {
	TotalRuns    int
	SuccessCount int
	FailureCount int
	RetryCount   int
	DlqOpenCount int
	// P95LatencyMs nil when fewer than 5 terminal runs.
	P95LatencyMs *float64
	TotalCostUsd float64
	TotalTokens  float64
	VersionCount int
}

// ReadinessIssue is the static-gate finding shape ({code, severity}).
type ReadinessIssue struct {
	Code     string
	Severity string // "fail" | "warn"
}

// WorkflowFacts are the static DAG facts the scorer needs.
type WorkflowFacts struct {
	AiNodeCount     int
	HasApprovalNode bool
}

// Entry is one category's sub-score + rationale.
type Entry struct {
	Score         int            `json:"score"`
	Rationale     string         `json:"rationale"`
	RationaleCode string         `json:"rationaleCode"`
	RationaleMeta map[string]any `json:"rationaleMeta,omitempty"`
}

// Score is the full rollup.
type Score struct {
	Score     int              `json:"score"`
	Status    string           `json:"status"`
	Breakdown map[string]Entry `json:"breakdown"`
	Signals   map[string]any   `json:"signals"`
	Slo       *SloBlock        `json:"slo"`
}

// Slo is the operator-declared contract (null thresholds = undeclared).
type Slo struct {
	SuccessRatePercent *float64 `json:"successRatePercent"`
	P95DurationMs      *float64 `json:"p95DurationMs"`
}

// SloBreaches carries per-metric booleans + the rollup.
type SloBreaches struct {
	SuccessRate bool `json:"successRate"`
	P95         bool `json:"p95"`
	AnyBreach   bool `json:"anyBreach"`
}

// SloBlock rides the score response.
type SloBlock struct {
	Slo      Slo         `json:"slo"`
	Breaches SloBreaches `json:"breaches"`
}

// EvaluateSlo ports the shared evaluator: below the sample floor nothing
// breaches; a null threshold never breaches.
func EvaluateSlo(slo *Slo, signals Signals) SloBreaches {
	if slo == nil {
		return SloBreaches{}
	}
	hasSamples := signals.TotalRuns >= SloMinSampleSize
	breaches := SloBreaches{}
	if slo.SuccessRatePercent != nil && hasSamples {
		rate := float64(signals.SuccessCount) / math.Max(float64(signals.TotalRuns), 1) * 100
		breaches.SuccessRate = rate < *slo.SuccessRatePercent
	}
	if slo.P95DurationMs != nil && hasSamples && signals.P95LatencyMs != nil {
		breaches.P95 = *signals.P95LatencyMs > *slo.P95DurationMs
	}
	breaches.AnyBreach = breaches.SuccessRate || breaches.P95
	return breaches
}

// Compute rolls the six categories into the weighted score.
func Compute(facts WorkflowFacts, issues []ReadinessIssue, signals Signals, slo *Slo) Score {
	breakdown := map[string]Entry{
		"reliability":     computeReliability(signals),
		"safety":          computeSafety(issues),
		"latency":         computeLatency(signals),
		"cost":            computeCost(signals),
		"maintainability": computeMaintainability(facts, issues, signals),
		"aiRisk":          computeAiRisk(facts, issues, signals),
	}
	overall := 0.0
	for category, weight := range Weights {
		overall += float64(breakdown[category].Score) * weight
	}
	score := int(math.Round(overall))
	status := "unhealthy"
	switch {
	case score >= HealthyFloor:
		status = "healthy"
	case score >= WarnFloor:
		status = "warn"
	}
	var sloBlock *SloBlock
	if slo != nil {
		sloBlock = &SloBlock{Slo: *slo, Breaches: EvaluateSlo(slo, signals)}
	}
	return Score{
		Score: score, Status: status, Breakdown: breakdown,
		Signals: signalsView(signals), Slo: sloBlock,
	}
}

func signalsView(signals Signals) map[string]any {
	var p95 any
	if signals.P95LatencyMs != nil {
		p95 = *signals.P95LatencyMs
	}
	return map[string]any{
		"totalRuns": signals.TotalRuns, "successCount": signals.SuccessCount,
		"failureCount": signals.FailureCount, "retryCount": signals.RetryCount,
		"dlqOpenCount": signals.DlqOpenCount, "p95LatencyMs": p95,
		"totalCostUsd": signals.TotalCostUsd, "totalTokens": signals.TotalTokens,
		"versionCount": signals.VersionCount,
	}
}

func computeReliability(signals Signals) Entry {
	if signals.TotalRuns == 0 {
		return Entry{Score: NeutralDefault,
			Rationale:     "No runs yet — neutral score until execution data accrues.",
			RationaleCode: "reliability.no_runs"}
	}
	successScore := float64(signals.SuccessCount) / float64(signals.TotalRuns) * 100
	dlqPenalty := math.Min(float64(signals.DlqOpenCount*reliabilityDlqPenaltyPerRow), reliabilityDlqPenaltyCap)
	retryPenalty := math.Min(float64(signals.RetryCount)/float64(signals.TotalRuns)*reliabilityRetryFactor, reliabilityRetryCap)
	score := int(math.Max(0, math.Round(successScore-dlqPenalty-retryPenalty)))
	return Entry{Score: score,
		Rationale: fmt.Sprintf("%d/%d runs succeeded; %d open dead letters; %d retry events.",
			signals.SuccessCount, signals.TotalRuns, signals.DlqOpenCount, signals.RetryCount),
		RationaleCode: "reliability.summary",
		RationaleMeta: map[string]any{
			"successCount": signals.SuccessCount, "totalRuns": signals.TotalRuns,
			"dlqOpenCount": signals.DlqOpenCount, "retryCount": signals.RetryCount,
		}}
}

func computeSafety(issues []ReadinessIssue) Entry {
	failCount, warnCount := 0, 0
	for _, issue := range issues {
		switch issue.Severity {
		case "fail":
			failCount++
		case "warn":
			warnCount++
		}
	}
	if failCount == 0 && warnCount == 0 {
		return Entry{Score: 100,
			Rationale:     "Readiness checks pass — no production-posture issues.",
			RationaleCode: "safety.clean"}
	}
	score := max(0, 100-failCount*safetyFailPenalty-warnCount*safetyWarnPenalty)
	return Entry{Score: score,
		Rationale: fmt.Sprintf("%d blocking + %d warning readiness findings (retries, bounds, secrets, approvals, outputs).",
			failCount, warnCount),
		RationaleCode: "safety.summary",
		RationaleMeta: map[string]any{"failCount": failCount, "warnCount": warnCount}}
}

func computeLatency(signals Signals) Entry {
	if signals.P95LatencyMs == nil {
		return Entry{Score: NeutralDefault,
			Rationale:     "Insufficient runs to compute p95 latency — neutral score.",
			RationaleCode: "latency.insufficient"}
	}
	score := bandScore(*signals.P95LatencyMs, latencyBandLowMs, latencyBandHighMs)
	return Entry{Score: score,
		Rationale: fmt.Sprintf("p95 run duration %.1fs across %d runs.",
			*signals.P95LatencyMs/1000, signals.TotalRuns),
		RationaleCode: "latency.summary",
		RationaleMeta: map[string]any{
			"seconds": fmt.Sprintf("%.1f", *signals.P95LatencyMs/1000), "totalRuns": signals.TotalRuns,
		}}
}

func computeCost(signals Signals) Entry {
	if signals.TotalRuns == 0 || signals.TotalCostUsd == 0 {
		return Entry{Score: NeutralDefault,
			Rationale:     "No usage cost recorded yet — neutral score.",
			RationaleCode: "cost.none"}
	}
	costPerRun := signals.TotalCostUsd / float64(signals.TotalRuns)
	score := bandScore(costPerRun, costBandLowUsd, costBandHighUsd)
	return Entry{Score: score,
		Rationale: fmt.Sprintf("$%.4f per run (%.2f total across %d runs).",
			costPerRun, signals.TotalCostUsd, signals.TotalRuns),
		RationaleCode: "cost.summary",
		RationaleMeta: map[string]any{
			"costPerRun":   fmt.Sprintf("%.4f", costPerRun),
			"totalCostUsd": fmt.Sprintf("%.2f", signals.TotalCostUsd), "totalRuns": signals.TotalRuns,
		}}
}

func computeMaintainability(facts WorkflowFacts, issues []ReadinessIssue, signals Signals) Entry {
	hasOutputs := true
	for _, issue := range issues {
		if issue.Code == "workflow_missing_outputs" {
			hasOutputs = false
			break
		}
	}
	hasMultipleVersions := signals.VersionCount >= 2
	score := min(100,
		pick(hasOutputs, maintainOutputsBonus, maintainNoOutputsBase)+
			pick(hasMultipleVersions, maintainVersionBonus, maintainNoVersionsBase)+
			pick(facts.HasApprovalNode, maintainApprovalBonus, maintainNoApprovalBase))
	rationale := pickString(hasOutputs, "outputs declared", "no outputs") + "; " +
		pickString(hasMultipleVersions, fmt.Sprintf("%d versions", signals.VersionCount), "single version (no rollback target)") + "; " +
		pickString(facts.HasApprovalNode, "approval node present", "no human gate") + "."
	return Entry{Score: score, Rationale: rationale, RationaleCode: "maintainability.summary",
		RationaleMeta: map[string]any{
			"hasOutputs": hasOutputs, "hasMultipleVersions": hasMultipleVersions,
			"versionCount": signals.VersionCount, "hasApprovalNode": facts.HasApprovalNode,
		}}
}

func computeAiRisk(facts WorkflowFacts, issues []ReadinessIssue, signals Signals) Entry {
	if facts.AiNodeCount == 0 {
		return Entry{Score: 100,
			Rationale:     "No AI / agent nodes — no AI risk surface.",
			RationaleCode: "ai_risk.no_ai"}
	}
	rawSecretCount := 0
	for _, issue := range issues {
		if issue.Code == "raw_secret_in_config" {
			rawSecretCount++
		}
	}
	score := int(math.Max(0, math.Round(
		100-float64(facts.AiNodeCount*aiRiskNodePenalty)-
			signals.TotalTokens/100_000*aiRiskTokenPenaltyPer100K-
			float64(rawSecretCount*aiRiskRawSecretPenalty))))
	return Entry{Score: score,
		Rationale: fmt.Sprintf("%d AI/agent nodes; %.0f tokens consumed; %d hardcoded-secret findings.",
			facts.AiNodeCount, signals.TotalTokens, rawSecretCount),
		RationaleCode: "ai_risk.summary",
		RationaleMeta: map[string]any{
			"aiNodeCount": facts.AiNodeCount, "totalTokens": signals.TotalTokens,
			"rawSecretCount": rawSecretCount,
		}}
}

// bandScore: linear interpolation clamped at the band edges.
func bandScore(value, lowInput, highInput float64) int {
	if value <= lowInput {
		return bandLowScore
	}
	if value >= highInput {
		return bandHighScore
	}
	t := (value - lowInput) / (highInput - lowInput)
	return int(math.Round(bandLowScore + t*(bandHighScore-bandLowScore)))
}

func pick(condition bool, yes, no int) int {
	if condition {
		return yes
	}
	return no
}

func pickString(condition bool, yes, no string) string {
	if condition {
		return yes
	}
	return no
}
