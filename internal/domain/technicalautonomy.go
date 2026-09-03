// Pure, fail-closed Level 4 technical-recovery assessment. The repair class
// is derived from the exact before/after workflow pair; caller-provided labels
// are never authority. The resulting seven-factor projection explains whether
// policy would permit autonomous apply, but performs no mutation itself.
package domain

import (
	"bytes"
	"encoding/json"
	"math"
	"reflect"
	"slices"
	"strings"
)

const (
	TechnicalFailureTerminal = "terminal_node_failure"
	TechnicalFailureStalled  = "stalled_node"
)

var TechnicalAutonomyFactorIDs = []string{
	"policy",
	"repair_scope",
	"validation_evidence",
	"prior_recoveries",
	"blast_radius",
	"rollback",
	"effect_receipts",
}

// TechnicalRecoveryWorkflow is a schema-checked workflow plus the normalized
// workflow-level fields used by the contract structural diff. UI coordinates
// are validated but deliberately excluded from repair classification.
type TechnicalRecoveryWorkflow struct {
	*Workflow
	workflowScope map[string]any
}

// TechnicalAutonomyFactor is one ordered, server-authoritative gate.
type TechnicalAutonomyFactor struct {
	ID       string `json:"id"`
	Passed   bool   `json:"passed"`
	Reason   string `json:"reason"`
	Actual   any    `json:"actual"`
	Required any    `json:"required"`
}

// TechnicalRecoveryAutonomyAssessment mirrors the contract wire contract.
type TechnicalRecoveryAutonomyAssessment struct {
	Eligible                bool                      `json:"eligible"`
	Failure                 string                    `json:"failure"`
	RepairClass             *string                   `json:"repairClass"`
	Policy                  RecoveryAutonomyProfile   `json:"policy"`
	ValidationEvidenceLevel string                    `json:"validationEvidenceLevel"`
	MinimumEvidenceLevel    *string                   `json:"minimumEvidenceLevel"`
	PriorVerifiedRecoveries int                       `json:"priorVerifiedRecoveries"`
	AffectedExecutions      int                       `json:"affectedExecutions"`
	Factors                 []TechnicalAutonomyFactor `json:"factors"`
}

// TechnicalRecoveryAutonomyInput is the persisted fact set evaluated by the
// pure policy layer.
type TechnicalRecoveryAutonomyInput struct {
	Contract                *RecoveryContract
	Failure                 string
	RepairClass             string
	ValidationEvidenceLevel string
	PriorVerifiedRecoveries int
	AffectedExecutions      int
	RollbackReady           bool
}

// ParseTechnicalRecoveryWorkflow applies the workflow wire schema needed by
// the autonomy classifier. Parse supplies normalization/defaults; the small
// supplemental checks cover optional JSON fields that Go pointers otherwise
// cannot distinguish from explicit null.
func ParseTechnicalRecoveryWorkflow(raw []byte) (*TechnicalRecoveryWorkflow, bool) {
	wf, issues := Parse(raw)
	if len(issues) != 0 || wf == nil {
		return nil, false
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(raw, &document); err != nil || document == nil {
		return nil, false
	}
	if !validTechnicalOptionalFields(document, wf) || !validTechnicalNodesAndEdges(document, wf) {
		return nil, false
	}

	metadata, ok := normalizedTechnicalMetadata(document["metadata"])
	if _, present := document["metadata"]; present && !ok {
		return nil, false
	}
	if !validTechnicalUI(document["ui"], wf) {
		return nil, false
	}

	nodeIDs := make(map[string]bool, len(wf.Nodes))
	for _, node := range wf.Nodes {
		nodeIDs[node.ID] = true
	}
	if wf.Recovery != nil && wf.Recovery.Contract != nil {
		for _, effect := range wf.Recovery.Contract.Effects {
			if !nodeIDs[effect.NodeID] {
				return nil, false
			}
		}
	}

	scope := map[string]any{"dslVersion": wf.DSLVersion}
	copyPresent := func(name string, value any) {
		if _, present := document[name]; present {
			scope[name] = canonicalTechnicalValue(value)
		}
	}
	copyPresent("id", wf.ID)
	copyPresent("name", wf.Name)
	if _, present := document["metadata"]; present {
		scope["metadata"] = metadata
	}
	copyPresent("templatePolicy", wf.TemplatePolicy)
	// Preserve every declared nested field for the authority check. The
	// reference schema strips unknown keys, so retaining one can only fail
	// closed; it cannot turn a broader patch into an allowlisted repair.
	for _, name := range []string{"inputs", "outputs", "recovery"} {
		if encoded, present := document[name]; present {
			scope[name] = canonicalTechnicalRaw(encoded)
		}
	}
	return &TechnicalRecoveryWorkflow{Workflow: wf, workflowScope: scope}, true
}

func validTechnicalOptionalFields(document map[string]json.RawMessage, wf *Workflow) bool {
	for _, name := range []string{"dslVersion", "id", "name", "inputs", "outputs", "templatePolicy", "recovery"} {
		if raw, present := document[name]; present && isJSONNull(raw) {
			return false
		}
	}
	return wf.DSLVersion == dslVersion
}

func validTechnicalNodesAndEdges(document map[string]json.RawMessage, wf *Workflow) bool {
	var nodes []map[string]json.RawMessage
	if err := json.Unmarshal(document["nodes"], &nodes); err != nil || len(nodes) != len(wf.Nodes) {
		return false
	}
	for index, rawNode := range nodes {
		if !platformNodeTypes[wf.Nodes[index].Type] {
			return false
		}
		if label, present := rawNode["label"]; present && isJSONNull(label) {
			return false
		}
		if config, present := rawNode["config"]; present && (isJSONNull(config) || !isJSONObject(config)) {
			return false
		}
	}

	var edges []map[string]json.RawMessage
	if err := json.Unmarshal(document["edges"], &edges); err != nil || len(edges) != len(wf.Edges) {
		return false
	}
	for _, rawEdge := range edges {
		for _, name := range []string{"id", "condition"} {
			if value, present := rawEdge[name]; present && isJSONNull(value) {
				return false
			}
		}
	}
	return true
}

func normalizedTechnicalMetadata(raw json.RawMessage) (map[string]any, bool) {
	if len(raw) == 0 {
		return nil, true
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		return nil, false
	}
	result := map[string]any{"tags": []string{}}
	if encoded, present := object["description"]; present {
		var description string
		if isJSONNull(encoded) || json.Unmarshal(encoded, &description) != nil {
			return nil, false
		}
		result["description"] = strings.TrimSpace(description)
	}
	if encoded, present := object["tags"]; present {
		var tags []string
		if isJSONNull(encoded) || json.Unmarshal(encoded, &tags) != nil {
			return nil, false
		}
		for index := range tags {
			tags[index] = strings.TrimSpace(tags[index])
			if tags[index] == "" {
				return nil, false
			}
		}
		result["tags"] = tags
	}
	return result, true
}

func validTechnicalUI(raw json.RawMessage, wf *Workflow) bool {
	if len(raw) == 0 {
		return true
	}
	var ui map[string]json.RawMessage
	if err := json.Unmarshal(raw, &ui); err != nil || ui == nil {
		return false
	}
	encoded, present := ui["positions"]
	if !present {
		return true
	}
	var positions map[string]map[string]json.RawMessage
	if isJSONNull(encoded) || json.Unmarshal(encoded, &positions) != nil || positions == nil {
		return false
	}
	nodeIDs := make(map[string]bool, len(wf.Nodes))
	for _, node := range wf.Nodes {
		nodeIDs[node.ID] = true
	}
	for rawID, position := range positions {
		id := strings.TrimSpace(rawID)
		if id == "" || !nodeIDs[id] || position == nil {
			return false
		}
		for _, axis := range []string{"x", "y"} {
			var coordinate float64
			value, ok := position[axis]
			if !ok || json.Unmarshal(value, &coordinate) != nil || math.IsInf(coordinate, 0) || math.IsNaN(coordinate) {
				return false
			}
		}
	}
	return true
}

func isJSONNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

func isJSONObject(raw json.RawMessage) bool {
	var object map[string]any
	return json.Unmarshal(raw, &object) == nil && object != nil
}

func canonicalTechnicalValue(value any) any {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	var normalized any
	if json.Unmarshal(raw, &normalized) != nil {
		return nil
	}
	return normalized
}

func canonicalTechnicalRaw(raw json.RawMessage) any {
	var normalized any
	if json.Unmarshal(raw, &normalized) != nil {
		return nil
	}
	return normalized
}

// ClassifyTechnicalRecoveryRepair recognizes only the bounded shapes the
// supervised path can prove: retry-only changes, other failing-node config
// changes, or one exact approval insertion before the failing node.
func ClassifyTechnicalRecoveryRepair(original, candidate *TechnicalRecoveryWorkflow, failingNodeID string) string {
	if original == nil || candidate == nil || !reflect.DeepEqual(original.workflowScope, candidate.workflowScope) {
		return ""
	}
	originalNodes := technicalNodeMap(original.Nodes)
	candidateNodes := technicalNodeMap(candidate.Nodes)
	added, removed, changed := technicalNodeChanges(originalNodes, candidateNodes)
	edgesEqual := equalTechnicalEdgeSets(original.Edges, candidate.Edges)
	hasGraphChange := len(added) > 0 || len(removed) > 0 || !edgesEqual
	if hasGraphChange {
		if exactTechnicalApprovalInsertion(original, candidate, failingNodeID, added, removed, changed) {
			return "structural_patch"
		}
		return ""
	}
	if len(changed) != 1 || changed[0] != failingNodeID {
		return ""
	}
	before := originalNodes[failingNodeID]
	after := candidateNodes[failingNodeID]
	if before.Type != after.Type || before.Label != after.Label || reflect.DeepEqual(before.Config, after.Config) {
		return ""
	}
	if equalConfigWithoutRetry(before.Config, after.Config) {
		return "retry"
	}
	return "config_patch"
}

func technicalNodeMap(nodes []Node) map[string]Node {
	result := make(map[string]Node, len(nodes))
	for _, node := range nodes {
		result[node.ID] = node
	}
	return result
}

func technicalNodeChanges(before, after map[string]Node) (added, removed []string, changed []string) {
	for id, node := range after {
		previous, present := before[id]
		if !present {
			added = append(added, id)
		} else if !reflect.DeepEqual(previous, node) {
			changed = append(changed, id)
		}
	}
	for id := range before {
		if _, present := after[id]; !present {
			removed = append(removed, id)
		}
	}
	slices.Sort(added)
	slices.Sort(removed)
	slices.Sort(changed)
	return added, removed, changed
}

func equalConfigWithoutRetry(before, after map[string]any) bool {
	leftSize := len(before)
	if _, present := before["retry"]; present {
		leftSize--
	}
	rightSize := len(after)
	if _, present := after["retry"]; present {
		rightSize--
	}
	if leftSize != rightSize {
		return false
	}
	for key, value := range before {
		if key == "retry" {
			continue
		}
		other, present := after[key]
		if !present || !reflect.DeepEqual(value, other) {
			return false
		}
	}
	return true
}

func exactTechnicalApprovalInsertion(original, candidate *TechnicalRecoveryWorkflow, failingNodeID string, added, removed, changed []string) bool {
	if len(added) != 1 || len(removed) != 0 || len(changed) != 0 {
		return false
	}
	originalNodes := technicalNodeMap(original.Nodes)
	if _, present := originalNodes[failingNodeID]; !present {
		return false
	}
	approval := technicalNodeMap(candidate.Nodes)[added[0]]
	message, hasMessage := approval.Config["message"].(string)
	if approval.Type != "approval" || len(approval.Config) != 1 || !hasMessage || strings.TrimSpace(message) == "" {
		return false
	}
	expected := make([]Edge, 0, len(original.Edges)+1)
	for _, edge := range original.Edges {
		if edge.To == failingNodeID {
			edge.To = approval.ID
		}
		expected = append(expected, edge)
	}
	expected = append(expected, Edge{From: approval.ID, To: failingNodeID})
	return equalTechnicalEdgeSets(expected, candidate.Edges)
}

func equalTechnicalEdgeSets(left, right []Edge) bool {
	if len(left) != len(right) {
		return false
	}
	type edgeKey struct {
		ID        string
		From      string
		To        string
		Condition string
		OnError   bool
	}
	counts := make(map[edgeKey]int, len(left))
	for _, edge := range left {
		counts[edgeKey(edge)]++
	}
	for _, edge := range right {
		key := edgeKey(edge)
		if counts[key] == 0 {
			return false
		}
		counts[key]--
	}
	return true
}

func technicalFactor(id string, passed bool, blockedReason string, actual, required any) TechnicalAutonomyFactor {
	reason := blockedReason
	if passed {
		reason = "ready"
	}
	return TechnicalAutonomyFactor{ID: id, Passed: passed, Reason: reason, Actual: actual, Required: required}
}

func technicalEvidenceRank(level string) int {
	switch level {
	case "static":
		return 0
	case "writes_skipped":
		return 1
	case "provider_simulated":
		return 2
	case "live_canary":
		return 3
	default:
		return -1
	}
}

// EvaluateTechnicalRecoveryAutonomy applies the exact seven ordered gates.
func EvaluateTechnicalRecoveryAutonomy(input TechnicalRecoveryAutonomyInput) TechnicalRecoveryAutonomyAssessment {
	input.ValidationEvidenceLevel = ParseValidationEvidenceLevel(input.ValidationEvidenceLevel)
	policy := ResolveRecoveryAutonomyProfile(input.Contract, RecoveryFailureClass{Kind: "technical", Failure: input.Failure})
	narrow := (*RecoveryNarrowAutonomy)(nil)
	var minimum *string
	if input.Contract != nil {
		narrow = input.Contract.NarrowAutonomy
		minimum = new(input.Contract.Validation.MinimumEvidenceLevel)
	}

	policyReady := policy.Level != nil && *policy.Level == 4 && input.Contract != nil && input.Contract.Approval.ProductionMutation == "autonomous_level_4"
	repairReady := input.RepairClass != "" && input.Contract != nil && narrow != nil &&
		slices.Contains(input.Contract.Repairs.Allowed, input.RepairClass) && slices.Contains(narrow.AllowedRepairClasses, input.RepairClass)
	evidenceReady := minimum != nil && technicalEvidenceRank(input.ValidationEvidenceLevel) >= technicalEvidenceRank(*minimum) &&
		SupportsAutonomousRecovery(input.ValidationEvidenceLevel)
	priorReady := narrow != nil && input.PriorVerifiedRecoveries >= narrow.MinimumPriorVerifiedRecoveries
	blastRadiusReady := narrow != nil && input.AffectedExecutions >= 1 && input.AffectedExecutions <= narrow.MaxAffectedExecutions
	rollbackReady := narrow != nil && narrow.RollbackRequired && input.RollbackReady
	effectReceiptsReady := input.Contract != nil && slices.Contains(input.Contract.Evidence.Required, "effect_receipt")
	if effectReceiptsReady {
		for _, effect := range input.Contract.Effects {
			if effect.Idempotency == "unavailable" || effect.Receipt == "manual" {
				effectReceiptsReady = false
				break
			}
		}
	}

	policyReason := "mutation_policy_requires_approval"
	if policy.Level == nil {
		policyReason = "policy_unavailable"
	} else if *policy.Level < 4 {
		policyReason = "autonomy_level_below_4"
	}
	repairReason := "repair_unclassified"
	if input.RepairClass != "" {
		repairReason = "repair_not_allowlisted"
	}
	var repairClass *string
	var repairActual any
	if input.RepairClass != "" {
		repairClass = new(input.RepairClass)
		repairActual = input.RepairClass
	}
	var repairRequired any
	var priorRequired any
	var blastRequired any
	var rollbackRequired any
	if narrow != nil {
		repairRequired = strings.Join(narrow.AllowedRepairClasses, ", ")
		priorRequired = narrow.MinimumPriorVerifiedRecoveries
		blastRequired = narrow.MaxAffectedExecutions
		rollbackRequired = narrow.RollbackRequired
	}
	var policyActual any
	if policy.Level != nil {
		policyActual = *policy.Level
	}
	var minimumActual any
	if minimum != nil {
		minimumActual = *minimum
	}
	factors := []TechnicalAutonomyFactor{
		technicalFactor("policy", policyReady, policyReason, policyActual, 4),
		technicalFactor("repair_scope", repairReady, repairReason, repairActual, repairRequired),
		technicalFactor("validation_evidence", evidenceReady, "validation_evidence_insufficient", input.ValidationEvidenceLevel, minimumActual),
		technicalFactor("prior_recoveries", priorReady, "prior_recoveries_insufficient", input.PriorVerifiedRecoveries, priorRequired),
		technicalFactor("blast_radius", blastRadiusReady, "blast_radius_exceeded", input.AffectedExecutions, blastRequired),
		technicalFactor("rollback", rollbackReady, "rollback_unavailable", input.RollbackReady, rollbackRequired),
		technicalFactor("effect_receipts", effectReceiptsReady, "effect_receipts_unsafe", effectReceiptsReady, true),
	}
	eligible := true
	for _, item := range factors {
		eligible = eligible && item.Passed
	}
	return TechnicalRecoveryAutonomyAssessment{
		Eligible: eligible, Failure: input.Failure, RepairClass: repairClass, Policy: policy,
		ValidationEvidenceLevel: input.ValidationEvidenceLevel, MinimumEvidenceLevel: minimum,
		PriorVerifiedRecoveries: input.PriorVerifiedRecoveries, AffectedExecutions: input.AffectedExecutions,
		Factors: factors,
	}
}
