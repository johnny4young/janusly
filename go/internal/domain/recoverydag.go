// Contract-vs-DAG semantic rules, ported from the reference's
// workflow-validation.ts: fail-closed SAVE constraints, not best-effort
// runtime warnings. A quarantine detector must DOMINATE every declared or
// actual write-side effect (no root path may reach the effect without
// passing the source), deferred-completion sources are rejected because
// their completion persists outside the inline interception point, and
// router sources are rejected for quarantine because branch skips may
// already be persisted before replacement.
package domain

// deferredCompletionNodeTypes complete outside the inline semantic
// interception point (reference set, verbatim).
var deferredCompletionNodeTypes = map[string]bool{
	"approval": true, "human_form": true, "subworkflow": true,
	"wait_until": true, "webhook": true,
}

// SemanticFixtureOutcome is the neutral fixture-replay result the caller
// injects (the runtime evaluator lives outside domain to keep this
// package grammar-free — same seam pattern as ExpressionValidator).
type SemanticFixtureOutcome struct {
	ID                   string
	SourceNodeID         string
	Expected             string
	Actual               string
	Passed               bool
	ViolationDetectorIDs []string
}

// SemanticFixtureEvaluator replays a contract's bounded fixtures with the
// exact runtime evaluator. Nil skips the replay rules (pure-domain
// callers); every product surface injects the real one.
type SemanticFixtureEvaluator func(contract *RecoveryContract) []SemanticFixtureOutcome

// validateSemanticContractDAG appends the contract-vs-DAG issues.
func validateSemanticContractDAG(wf *Workflow, validExpression ExpressionValidator, replayFixtures SemanticFixtureEvaluator, push func(Issue)) {
	if wf.Recovery == nil || wf.Recovery.Contract == nil || wf.Recovery.Contract.Version != "2" {
		return
	}
	contract := wf.Recovery.Contract
	semantic := contract.Failure.Semantic

	nodeByID := map[string]Node{}
	nodeIds := map[string]bool{}
	for _, node := range wf.Nodes {
		nodeByID[node.ID] = node
		nodeIds[node.ID] = true
	}
	detectorSources := map[string]bool{}
	for _, detector := range semantic.Detectors {
		detectorSources[detector.SourceNodeID] = true
	}

	declaredEffects := map[string]bool{}
	for _, effect := range contract.Effects {
		declaredEffects[effect.NodeID] = true
	}
	var actualEffects []string
	for _, node := range wf.Nodes {
		if isSensitiveAction(node, ReadinessOptions{}) {
			actualEffects = append(actualEffects, node.ID)
			if !declaredEffects[node.ID] {
				push(Issue{Code: "semantic_effect_not_declared", NodeID: node.ID,
					Message: "Write-side node \"" + node.ID + "\" must be declared in recovery.contract.effects before semantic quarantine can make a pre-effect guarantee"})
			}
		}
	}
	guardedEffects := map[string]bool{}
	for id := range declaredEffects {
		guardedEffects[id] = true
	}
	for _, id := range actualEffects {
		guardedEffects[id] = true
	}

	for _, detector := range semantic.Detectors {
		sourceNode, known := nodeByID[detector.SourceNodeID]
		switch {
		case !known:
			push(Issue{Code: "semantic_detector_unknown_source", NodeID: detector.SourceNodeID,
				Message: "Semantic detector \"" + detector.ID + "\" references an unknown source node: " + detector.SourceNodeID})
		case deferredCompletionNodeTypes[sourceNode.Type]:
			push(Issue{Code: "semantic_detector_deferred_source", NodeID: detector.SourceNodeID,
				Message: "Semantic detector \"" + detector.ID + "\" cannot target deferred-completion node \"" + detector.SourceNodeID + "\""})
		case detector.Action == "quarantine" && (sourceNode.Type == "router" || sourceNode.Type == "router_llm"):
			push(Issue{Code: "semantic_quarantine_router_source", NodeID: detector.SourceNodeID,
				Message: "Quarantine detector \"" + detector.ID + "\" cannot target a router because routing choices are persisted before operator replacement"})
		}
		if detector.Kind == "expression" && validExpression != nil {
			if valid, message := validExpression(detector.PassWhen); !valid {
				if message == "" {
					message = "Semantic detector \"" + detector.ID + "\" has an invalid expression"
				}
				push(Issue{Code: "semantic_detector_invalid_expression", NodeID: detector.SourceNodeID, Message: message})
			}
		}
		if detector.Action != "quarantine" {
			continue
		}
		for effectNodeID := range guardedEffects {
			if detector.SourceNodeID == effectNodeID ||
				canReachNodeWithout(wf, effectNodeID, detector.SourceNodeID) {
				push(Issue{Code: "semantic_detector_does_not_guard_effect", NodeID: effectNodeID,
					Message: "Quarantine detector \"" + detector.ID + "\" must run on every path before recovery effect node \"" + effectNodeID + "\""})
			}
		}
	}

	for _, fixture := range semantic.EvaluationFixtures {
		if !nodeIds[fixture.SourceNodeID] {
			push(Issue{Code: "semantic_fixture_unknown_source", NodeID: fixture.SourceNodeID,
				Message: "Semantic evaluation fixture \"" + fixture.ID + "\" references an unknown source node: " + fixture.SourceNodeID})
		} else if !detectorSources[fixture.SourceNodeID] {
			push(Issue{Code: "semantic_fixture_without_detector", NodeID: fixture.SourceNodeID,
				Message: "Semantic evaluation fixture \"" + fixture.ID + "\" has no detector on source node \"" + fixture.SourceNodeID + "\""})
		}
	}

	if replayFixtures == nil {
		return
	}
	outcomes := replayFixtures(contract)
	for _, outcome := range outcomes {
		if !outcome.Passed {
			push(Issue{Code: "semantic_fixture_mismatch", NodeID: outcome.SourceNodeID,
				Message: "Semantic evaluation fixture \"" + outcome.ID + "\" expected " + outcome.Expected + " but evaluated as " + outcome.Actual})
		}
	}
	for _, detector := range semantic.Detectors {
		hasPass := false
		hasViolation := false
		for _, outcome := range outcomes {
			if outcome.SourceNodeID != detector.SourceNodeID {
				continue
			}
			if outcome.Expected == "pass" && outcome.Actual == "pass" {
				hasPass = true
			}
			if outcome.Expected == "violation" {
				for _, id := range outcome.ViolationDetectorIDs {
					if id == detector.ID {
						hasViolation = true
					}
				}
			}
		}
		if !hasPass {
			push(Issue{Code: "semantic_detector_missing_pass_fixture", NodeID: detector.SourceNodeID,
				Message: "Semantic detector \"" + detector.ID + "\" requires a passing evaluation fixture for source node \"" + detector.SourceNodeID + "\""})
		}
		if !hasViolation {
			push(Issue{Code: "semantic_detector_missing_violation_fixture", NodeID: detector.SourceNodeID,
				Message: "Semantic detector \"" + detector.ID + "\" requires a violation fixture that exercises that detector"})
		}
	}
}

// canReachNodeWithout reports whether targetID is still reachable from an
// original workflow root after removing excludedNodeID. If it is, the
// excluded node does not dominate the target and cannot truthfully
// promise pre-effect quarantine.
func canReachNodeWithout(wf *Workflow, targetID, excludedNodeID string) bool {
	incoming := map[string]bool{}
	for _, edge := range wf.Edges {
		incoming[edge.To] = true
	}
	outgoing := map[string][]string{}
	for _, edge := range wf.Edges {
		if edge.From == excludedNodeID || edge.To == excludedNodeID {
			continue
		}
		outgoing[edge.From] = append(outgoing[edge.From], edge.To)
	}
	var queue []string
	for _, node := range wf.Nodes {
		if !incoming[node.ID] && node.ID != excludedNodeID {
			queue = append(queue, node.ID)
		}
	}
	visited := map[string]bool{}
	for len(queue) > 0 {
		nodeID := queue[0]
		queue = queue[1:]
		if visited[nodeID] {
			continue
		}
		if nodeID == targetID {
			return true
		}
		visited[nodeID] = true
		queue = append(queue, outgoing[nodeID]...)
	}
	return false
}
