// Deterministic pre-deployment qualification for semantic outcome
// contracts (reference recovery-qualification.ts): the baseline workflow
// owns the regression dataset; a candidate replays that immutable
// fixture snapshot AND its own declared fixtures through the exact
// runtime evaluator. No workflow node executes, no provider is called,
// no external effect can occur — and no LLM judge grants mutation
// authority. A V1→V2 transition runs in bootstrap mode (no baseline
// dataset yet); once the baseline is V2, every later candidate must keep
// the baseline fixture expectations and detector coverage intact.
package recovery

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"maps"
	"slices"
	"strings"

	"github.com/johnny4young/janusly/internal/domain"
)

// RecoveryQualificationDatasetVersion pins the immutable dataset scheme.
const RecoveryQualificationDatasetVersion = "1"

// RecoveryQualificationFailureLimit bounds the durable failure list.
const RecoveryQualificationFailureLimit = 20

// QualificationFailure is one bounded actionable failure identity.
type QualificationFailure struct {
	Dataset      string                     `json:"dataset"`
	FixtureID    string                     `json:"fixtureId"`
	SourceNodeID string                     `json:"sourceNodeId"`
	Expected     string                     `json:"expected"`
	Actual       string                     `json:"actual"`
	Reason       string                     `json:"reason"`
	Violations   []SemanticOutcomeViolation `json:"violations,omitempty"`
}

// QualificationSummary is the full evaluation result; the receipt form
// drops per-failure violation internals (compact, stable evidence).
type QualificationSummary struct {
	DatasetVersion            string                 `json:"datasetVersion"`
	DatasetDigest             string                 `json:"datasetDigest"`
	Mode                      string                 `json:"mode"`
	Status                    string                 `json:"status"`
	BaselineCaseCount         int                    `json:"baselineCaseCount"`
	CandidateCaseCount        int                    `json:"candidateCaseCount"`
	CandidateAssertionCount   int                    `json:"candidateAssertionCount"`
	PassedCandidateAssertions int                    `json:"passedCandidateAssertions"`
	FailedCandidateAssertions int                    `json:"failedCandidateAssertions"`
	RegressionCount           int                    `json:"regressionCount"`
	CoverageFailureCount      int                    `json:"coverageFailureCount"`
	BaselineDatasetValid      bool                   `json:"baselineDatasetValid"`
	Failures                  []QualificationFailure `json:"failures"`
	FailuresTruncated         bool                   `json:"failuresTruncated"`
}

// ToReceiptSummary strips violation internals for the durable receipt.
func ToReceiptSummary(summary QualificationSummary) QualificationSummary {
	receipt := summary
	receipt.Failures = make([]QualificationFailure, 0, len(summary.Failures))
	for _, failure := range summary.Failures {
		failure.Violations = nil
		receipt.Failures = append(receipt.Failures, failure)
	}
	return receipt
}

func qualificationContract(wf *domain.Workflow) *domain.RecoveryContract {
	if wf.Recovery == nil || wf.Recovery.Contract == nil || wf.Recovery.Contract.Version != "2" {
		return nil
	}
	return wf.Recovery.Contract
}

// stableRender renders any value with sorted object keys (the shared
// stableJson construction, applied to the generic JSON projection).
func stableRender(value any) string {
	switch typed := value.(type) {
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			parts = append(parts, stableRender(item))
		}
		return "[" + strings.Join(parts, ",") + "]"
	case map[string]any:
		keys := slices.Sorted(maps.Keys(typed))
		parts := make([]string, 0, len(keys))
		for _, key := range keys {
			keyJSON, _ := json.Marshal(key)
			parts = append(parts, string(keyJSON)+":"+stableRender(typed[key]))
		}
		return "{" + strings.Join(parts, ",") + "}"
	default:
		raw, err := json.Marshal(value)
		if err != nil {
			return "null"
		}
		return string(raw)
	}
}

func datasetDigest(baseline, candidate []domain.RecoverySemanticFixture) string {
	generic := func(fixtures []domain.RecoverySemanticFixture) any {
		raw, _ := json.Marshal(fixtures)
		var out any = []any{}
		_ = json.Unmarshal(raw, &out)
		return out
	}
	rendered := stableRender(map[string]any{
		"version":  RecoveryQualificationDatasetVersion,
		"baseline": generic(baseline), "candidate": generic(candidate),
	})
	digest := sha256.Sum256([]byte(rendered))
	return hex.EncodeToString(digest[:])
}

func evaluateQualificationFixture(contract *domain.RecoveryContract, fixture domain.RecoverySemanticFixture) (string, bool, []SemanticOutcomeViolation) {
	covered := false
	for _, detector := range contract.Failure.Semantic.Detectors {
		if detector.SourceNodeID == fixture.SourceNodeID {
			covered = true
			break
		}
	}
	if !covered {
		return "uncovered", false, nil
	}
	evaluation := EvaluateSemanticOutcome(struct {
		Contract     *domain.RecoveryContract
		SourceNodeID string
		Output       any
		Context      map[string]any
	}{Contract: contract, SourceNodeID: fixture.SourceNodeID, Output: fixture.Output, Context: fixture.Context})
	actual := "pass"
	if len(evaluation.Violations) > 0 {
		actual = "violation"
	}
	return actual, actual == fixture.Expected, evaluation.Violations
}

// QualifyRecoveryCandidate compares one immutable baseline/candidate pair.
func QualifyRecoveryCandidate(baseline, candidate *domain.Workflow) QualificationSummary {
	baselineContract := qualificationContract(baseline)
	candidateContract := qualificationContract(candidate)
	var baselineFixtures, candidateFixtures []domain.RecoverySemanticFixture
	if baselineContract != nil {
		baselineFixtures = baselineContract.Failure.Semantic.EvaluationFixtures
	}
	if candidateContract != nil {
		candidateFixtures = candidateContract.Failure.Semantic.EvaluationFixtures
	}
	digest := datasetDigest(baselineFixtures, candidateFixtures)

	if baselineContract == nil && candidateContract == nil {
		return QualificationSummary{
			DatasetVersion: RecoveryQualificationDatasetVersion, DatasetDigest: digest,
			Mode: "not_required", Status: "not_required",
			BaselineDatasetValid: true, Failures: []QualificationFailure{},
		}
	}
	mode := "bootstrap"
	if baselineContract != nil {
		mode = "compare"
	}
	var failures []QualificationFailure
	totalFailures, regressionCount, coverageFailureCount := 0, 0, 0
	addFailure := func(failure QualificationFailure) {
		totalFailures++
		if len(failures) < RecoveryQualificationFailureLimit {
			failures = append(failures, failure)
		}
	}

	baselineDatasetValid := true
	if baselineContract != nil {
		for _, result := range EvaluateSemanticOutcomeFixtures(baselineContract) {
			if result.Passed {
				continue
			}
			baselineDatasetValid = false
			addFailure(QualificationFailure{
				Dataset: "baseline", FixtureID: result.ID, SourceNodeID: result.SourceNodeID,
				Expected: result.Expected, Actual: result.Actual,
				Reason: "baseline_dataset_invalid", Violations: result.Violations,
			})
		}
	}

	if candidateContract == nil {
		addFailure(QualificationFailure{
			Dataset: "candidate", FixtureID: "candidate-contract",
			Expected: "pass", Actual: "uncovered", Reason: "candidate_contract_missing",
		})
		return QualificationSummary{
			DatasetVersion: RecoveryQualificationDatasetVersion, DatasetDigest: digest,
			Mode: mode, Status: "failed",
			BaselineCaseCount:         len(baselineFixtures),
			CandidateAssertionCount:   len(baselineFixtures),
			FailedCandidateAssertions: len(baselineFixtures),
			RegressionCount:           len(baselineFixtures),
			CoverageFailureCount:      len(baselineFixtures),
			BaselineDatasetValid:      baselineDatasetValid,
			Failures:                  failures, FailuresTruncated: totalFailures > len(failures),
		}
	}

	passedCandidateAssertions := 0
	evaluateDataset := func(dataset string, fixtures []domain.RecoverySemanticFixture) {
		for _, fixture := range fixtures {
			actual, passed, violations := evaluateQualificationFixture(candidateContract, fixture)
			if passed {
				passedCandidateAssertions++
				continue
			}
			reason := "expected_mismatch"
			if actual == "uncovered" {
				reason = "detector_uncovered"
				coverageFailureCount++
			}
			if dataset == "baseline" {
				regressionCount++
			}
			addFailure(QualificationFailure{
				Dataset: dataset, FixtureID: fixture.ID, SourceNodeID: fixture.SourceNodeID,
				Expected: fixture.Expected, Actual: actual, Reason: reason, Violations: violations,
			})
		}
	}
	evaluateDataset("baseline", baselineFixtures)
	evaluateDataset("candidate", candidateFixtures)
	candidateAssertionCount := len(baselineFixtures) + len(candidateFixtures)
	failedCandidateAssertions := candidateAssertionCount - passedCandidateAssertions
	status := "failed"
	if baselineDatasetValid && failedCandidateAssertions == 0 {
		status = "passed"
	}
	if failures == nil {
		failures = []QualificationFailure{}
	}
	return QualificationSummary{
		DatasetVersion: RecoveryQualificationDatasetVersion, DatasetDigest: digest,
		Mode: mode, Status: status,
		BaselineCaseCount: len(baselineFixtures), CandidateCaseCount: len(candidateFixtures),
		CandidateAssertionCount:   candidateAssertionCount,
		PassedCandidateAssertions: passedCandidateAssertions,
		FailedCandidateAssertions: failedCandidateAssertions,
		RegressionCount:           regressionCount, CoverageFailureCount: coverageFailureCount,
		BaselineDatasetValid: baselineDatasetValid,
		Failures:             failures, FailuresTruncated: totalFailures > len(failures),
	}
}
