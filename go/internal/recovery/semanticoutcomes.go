// Deterministic semantic-outcome evaluation, ported from the reference's
// semantic-outcomes.ts. Pure: operator-authored expression detectors run
// through the SAME grammar the edge conditions use, schema detectors run
// through the shared JSON-value schema subset — no persistence, no
// provider calls, no authorization. The same evaluator serves save-time
// fixture qualification, tests, and the worker hot path. Only a V2
// contract ("deterministic" mode) ever evaluates: a V1 snapshot yields
// zero detectors by construction.
package recovery

import (
	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/grammar"
)

// SemanticOutcomeViolation is one failed detector.
type SemanticOutcomeViolation struct {
	DetectorID   string   `json:"detectorId"`
	SourceNodeID string   `json:"sourceNodeId"`
	Kind         string   `json:"kind"`
	Action       string   `json:"action"`
	Message      string   `json:"message"`
	Details      []string `json:"details,omitempty"`
}

// SemanticOutcomeEvaluation is one source node's verdict.
type SemanticOutcomeEvaluation struct {
	SourceNodeID string
	Evaluated    int
	Violations   []SemanticOutcomeViolation
	Quarantined  bool
}

// SemanticOutcomeFixtureResult replays one bounded contract fixture.
type SemanticOutcomeFixtureResult struct {
	ID           string
	SourceNodeID string
	Expected     string
	Actual       string
	Passed       bool
	Violations   []SemanticOutcomeViolation
}

func semanticContract(contract *domain.RecoveryContract) *domain.RecoverySemanticFailure {
	if contract == nil || contract.Version != "2" {
		return nil
	}
	return &contract.Failure.Semantic
}

// EvaluateSemanticOutcome runs every detector attached to one
// just-completed source node. The supplied context may be the
// pre-completion runtime snapshot; the evaluator overlays the exact
// completed output so expression detectors see the same
// `context.<node>.output` shape downstream edges will consume.
func EvaluateSemanticOutcome(input struct {
	Contract     *domain.RecoveryContract
	SourceNodeID string
	Output       any
	Context      map[string]any
}) SemanticOutcomeEvaluation {
	semantic := semanticContract(input.Contract)
	var detectors []domain.RecoverySemanticDetector
	if semantic != nil {
		for _, detector := range semantic.Detectors {
			if detector.SourceNodeID == input.SourceNodeID {
				detectors = append(detectors, detector)
			}
		}
	}
	existing := map[string]any{}
	if prior, ok := input.Context[input.SourceNodeID].(map[string]any); ok {
		for key, value := range prior {
			existing[key] = value
		}
	}
	context := map[string]any{}
	for key, value := range input.Context {
		context[key] = value
	}
	existing["status"] = "succeeded"
	existing["output"] = input.Output
	context[input.SourceNodeID] = existing

	var violations []SemanticOutcomeViolation
	for _, detector := range detectors {
		switch detector.Kind {
		case "expression":
			passed := false
			var details []string
			result, err := grammar.EvaluateExpression(detector.PassWhen, grammar.Scope{
				Context: context, Inputs: map[string]any{},
			})
			if err != nil {
				details = []string{err.Error()}
			} else {
				passed = result
			}
			if !passed {
				violations = append(violations, SemanticOutcomeViolation{
					DetectorID: detector.ID, SourceNodeID: detector.SourceNodeID,
					Kind: detector.Kind, Action: detector.Action,
					Message: detector.Message, Details: details,
				})
			}
		case "schema":
			problems := domain.ValidateInputValue(detector.Schema, input.Output, "$")
			if len(problems) > 0 {
				if len(problems) > 50 {
					problems = problems[:50]
				}
				violations = append(violations, SemanticOutcomeViolation{
					DetectorID: detector.ID, SourceNodeID: detector.SourceNodeID,
					Kind: detector.Kind, Action: detector.Action,
					Message: detector.Message, Details: problems,
				})
			}
		}
	}
	quarantined := false
	for _, violation := range violations {
		if violation.Action == "quarantine" {
			quarantined = true
		}
	}
	return SemanticOutcomeEvaluation{
		SourceNodeID: input.SourceNodeID,
		Evaluated:    len(detectors),
		Violations:   violations,
		Quarantined:  quarantined,
	}
}

// EvaluateSemanticOutcomeFixtures replays all bounded contract fixtures
// with the exact runtime evaluator.
func EvaluateSemanticOutcomeFixtures(contract *domain.RecoveryContract) []SemanticOutcomeFixtureResult {
	semantic := semanticContract(contract)
	if semantic == nil {
		return nil
	}
	results := make([]SemanticOutcomeFixtureResult, 0, len(semantic.EvaluationFixtures))
	for _, fixture := range semantic.EvaluationFixtures {
		evaluation := EvaluateSemanticOutcome(struct {
			Contract     *domain.RecoveryContract
			SourceNodeID string
			Output       any
			Context      map[string]any
		}{
			Contract: contract, SourceNodeID: fixture.SourceNodeID,
			Output: fixture.Output, Context: fixture.Context,
		})
		actual := "pass"
		if len(evaluation.Violations) > 0 {
			actual = "violation"
		}
		results = append(results, SemanticOutcomeFixtureResult{
			ID: fixture.ID, SourceNodeID: fixture.SourceNodeID,
			Expected: fixture.Expected, Actual: actual,
			Passed:     actual == fixture.Expected,
			Violations: evaluation.Violations,
		})
	}
	return results
}

// FixtureOutcomesForValidation adapts the runtime fixture replay to the
// domain validator's neutral outcome seam.
func FixtureOutcomesForValidation(contract *domain.RecoveryContract) []domain.SemanticFixtureOutcome {
	results := EvaluateSemanticOutcomeFixtures(contract)
	outcomes := make([]domain.SemanticFixtureOutcome, 0, len(results))
	for _, result := range results {
		ids := make([]string, 0, len(result.Violations))
		for _, violation := range result.Violations {
			ids = append(ids, violation.DetectorID)
		}
		outcomes = append(outcomes, domain.SemanticFixtureOutcome{
			ID: result.ID, SourceNodeID: result.SourceNodeID,
			Expected: result.Expected, Actual: result.Actual,
			Passed: result.Passed, ViolationDetectorIDs: ids,
		})
	}
	return outcomes
}
