package domain

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// recoveryWireValidator preserves the strict-object and required-property
// semantics of web/src/lib/recovery-contract.ts before encoding/json can erase
// the difference between omitted, null, and zero-valued fields. Typed semantic
// validation still owns vocabularies, bounds, and cross-field policy.
type recoveryWireValidator struct {
	problems []workflowFieldProblem
}

func validateWorkflowRecoveryWire(raw json.RawMessage) []workflowFieldProblem {
	validator := &recoveryWireValidator{}
	recovery := validator.object(raw, "", nil, []string{"circuitBreaker", "contract"})
	if recovery == nil {
		return validator.problems
	}
	if encoded, ok := nonNullRecoveryField(recovery, "contract"); ok {
		validator.contract(encoded)
	}
	return validator.problems
}

func (v *recoveryWireValidator) contract(raw json.RawMessage) {
	contract := v.object(raw, ".contract",
		[]string{"version", "failure", "evidence", "effects", "repairs", "validation", "approval", "autonomyLevel", "verification", "recurrence"},
		[]string{"narrowAutonomy"})
	if contract == nil {
		return
	}

	var version string
	_ = json.Unmarshal(contract["version"], &version)
	if encoded, ok := nonNullRecoveryField(contract, "failure"); ok {
		v.failure(encoded, version)
	}
	if encoded, ok := nonNullRecoveryField(contract, "evidence"); ok {
		evidence := v.object(encoded, ".contract.evidence", []string{"required"}, nil)
		v.requireArray(evidence, "required", ".contract.evidence.required")
	}
	if encoded, ok := nonNullRecoveryField(contract, "effects"); ok {
		for index, effect := range v.array(encoded, ".contract.effects") {
			v.object(effect, fmt.Sprintf(".contract.effects.%d", index),
				[]string{"nodeId", "kind", "idempotency", "receipt"}, nil)
		}
	}
	if encoded, ok := nonNullRecoveryField(contract, "repairs"); ok {
		repairs := v.object(encoded, ".contract.repairs", []string{"allowed"}, nil)
		v.requireArray(repairs, "allowed", ".contract.repairs.allowed")
	}
	if encoded, ok := nonNullRecoveryField(contract, "validation"); ok {
		v.object(encoded, ".contract.validation", []string{"minimumEvidenceLevel"}, nil)
	}
	if encoded, ok := nonNullRecoveryField(contract, "approval"); ok {
		v.object(encoded, ".contract.approval", []string{"productionMutation", "permission"}, nil)
	}
	if encoded, ok := nonNullRecoveryField(contract, "narrowAutonomy"); ok {
		narrow := v.object(encoded, ".contract.narrowAutonomy",
			[]string{"allowedRepairClasses", "minimumPriorVerifiedRecoveries", "maxAffectedExecutions", "rollbackRequired"}, nil)
		v.requireArray(narrow, "allowedRepairClasses", ".contract.narrowAutonomy.allowedRepairClasses")
	}
	if encoded, ok := nonNullRecoveryField(contract, "verification"); ok {
		v.object(encoded, ".contract.verification", []string{"kind"}, nil)
	}
	if encoded, ok := nonNullRecoveryField(contract, "recurrence"); ok {
		v.object(encoded, ".contract.recurrence", []string{"windowDays"}, nil)
	}
}

func (v *recoveryWireValidator) failure(raw json.RawMessage, version string) {
	failure := v.object(raw, ".contract.failure", []string{"technical", "semantic"}, nil)
	if encoded, ok := nonNullRecoveryField(failure, "technical"); ok {
		technical := v.object(encoded, ".contract.failure.technical",
			[]string{"terminalNodeFailure", "stalledNode"}, []string{"autonomy"})
		if autonomyRaw, ok := nonNullRecoveryField(technical, "autonomy"); ok {
			v.object(autonomyRaw, ".contract.failure.technical.autonomy", nil,
				[]string{"terminalNodeFailure", "stalledNode"})
		}
	}
	if encoded, ok := nonNullRecoveryField(failure, "semantic"); ok {
		v.semantic(encoded, version)
	}
}

func (v *recoveryWireValidator) semantic(raw json.RawMessage, version string) {
	if version == "1" {
		v.object(raw, ".contract.failure.semantic", []string{"mode"}, nil)
		return
	}
	semantic := v.object(raw, ".contract.failure.semantic",
		[]string{"mode", "detectors", "evaluationFixtures"}, nil)
	if encoded, ok := nonNullRecoveryField(semantic, "detectors"); ok {
		for index, detector := range v.array(encoded, ".contract.failure.semantic.detectors") {
			v.detector(detector, index)
		}
	}
	if encoded, ok := nonNullRecoveryField(semantic, "evaluationFixtures"); ok {
		for index, fixture := range v.array(encoded, ".contract.failure.semantic.evaluationFixtures") {
			path := fmt.Sprintf(".contract.failure.semantic.evaluationFixtures.%d", index)
			object := v.object(fixture, path,
				[]string{"id", "sourceNodeId", "output", "expected"}, []string{"context"})
			if context, ok := nonNullRecoveryField(object, "context"); ok {
				var record map[string]json.RawMessage
				if json.Unmarshal(context, &record) != nil || record == nil {
					v.problem(path+".context", "expected an object")
				}
			}
		}
	}
}

func (v *recoveryWireValidator) detector(raw json.RawMessage, index int) {
	path := fmt.Sprintf(".contract.failure.semantic.detectors.%d", index)
	var probe map[string]json.RawMessage
	_ = json.Unmarshal(raw, &probe)
	var kind string
	_ = json.Unmarshal(probe["kind"], &kind)
	required := []string{"id", "sourceNodeId", "kind", "action", "message"}
	optional := []string{"autonomyLevel"}
	switch kind {
	case "expression":
		required = append(required, "passWhen")
	case "schema":
		required = append(required, "schema")
	default:
		// The typed validator will reject the discriminator. Accept both union
		// keys here so that wire validation does not manufacture a misleading
		// unknown-field error for an already-invalid discriminator.
		optional = append(optional, "passWhen", "schema")
	}
	object := v.object(raw, path, required, optional)
	if kind == "schema" {
		if schema, ok := nonNullRecoveryField(object, "schema"); ok && !validInputSchemaWire(schema) {
			v.problem(path+".schema", fmt.Sprintf("expected a supported recursive schema with at most %d nodes", InputSchemaNodeMax))
		}
	}
}

func (v *recoveryWireValidator) object(raw json.RawMessage, path string, required, optional []string) map[string]json.RawMessage {
	var object map[string]json.RawMessage
	if len(raw) == 0 || isJSONNull(raw) || json.Unmarshal(raw, &object) != nil || object == nil {
		v.problem(path, "expected an object")
		return nil
	}
	allowed := make(map[string]bool, len(required)+len(optional))
	for _, key := range required {
		allowed[key] = true
	}
	for _, key := range optional {
		allowed[key] = true
	}
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if !allowed[key] {
			v.problem(recoveryWirePath(path, key), "unknown field")
		}
	}
	for _, key := range required {
		encoded, present := object[key]
		if !present || isJSONNull(encoded) {
			v.problem(recoveryWirePath(path, key), "expected a non-null value")
		}
	}
	for _, key := range optional {
		if encoded, present := object[key]; present && isJSONNull(encoded) {
			v.problem(recoveryWirePath(path, key), "expected a non-null value")
		}
	}
	return object
}

func (v *recoveryWireValidator) array(raw json.RawMessage, path string) []json.RawMessage {
	var values []json.RawMessage
	if len(raw) == 0 || isJSONNull(raw) || json.Unmarshal(raw, &values) != nil || values == nil {
		v.problem(path, "expected an array")
		return nil
	}
	return values
}

func (v *recoveryWireValidator) requireArray(object map[string]json.RawMessage, key, path string) {
	if encoded, ok := nonNullRecoveryField(object, key); ok {
		v.array(encoded, path)
	}
}

func (v *recoveryWireValidator) problem(path, message string) {
	v.problems = append(v.problems, workflowFieldProblem{path: path, message: message})
}

func nonNullRecoveryField(object map[string]json.RawMessage, key string) (json.RawMessage, bool) {
	if object == nil {
		return nil, false
	}
	encoded, present := object[key]
	return encoded, present && !isJSONNull(encoded)
}

func recoveryWirePath(parent, key string) string {
	return strings.TrimSuffix(parent, ".") + "." + key
}

// normalizeRecoveryContract mirrors the source schema's deliberate .trim()
// transforms so the immutable Go snapshot cannot preserve values that the
// browser contract would normalize before persistence.
func normalizeRecoveryContract(contract *RecoveryContract) {
	if contract == nil {
		return
	}
	for index := range contract.Effects {
		contract.Effects[index].NodeID = strings.TrimSpace(contract.Effects[index].NodeID)
	}
	for index := range contract.Failure.Semantic.Detectors {
		detector := &contract.Failure.Semantic.Detectors[index]
		detector.ID = strings.TrimSpace(detector.ID)
		detector.SourceNodeID = strings.TrimSpace(detector.SourceNodeID)
		detector.PassWhen = strings.TrimSpace(detector.PassWhen)
		detector.Message = strings.TrimSpace(detector.Message)
	}
	for index := range contract.Failure.Semantic.EvaluationFixtures {
		fixture := &contract.Failure.Semantic.EvaluationFixtures[index]
		fixture.ID = strings.TrimSpace(fixture.ID)
		fixture.SourceNodeID = strings.TrimSpace(fixture.SourceNodeID)
	}
}
