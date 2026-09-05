// Versioned, operator-owned recovery policy attached to a workflow
// snapshot — the pure port of the contract's recovery-contract.ts. The
// contract is declarative (failure/effect/repair boundaries later stages
// must honor); persistence and I/O stay out. The HARD rule inherited
// verbatim: V1 keeps semantic detection DISABLED for historical
// snapshots, and no failure-specific autonomy level may exceed the
// workflow's ceiling.
package domain

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
)

// RecoveryAutonomyLevels is the closed 0..4 ladder.
const (
	RecoveryAutonomyMin = 0
	RecoveryAutonomyMax = 4
)

// ValidationEvidenceLevels is the closed evidence-level vocabulary.
var ValidationEvidenceLevels = map[string]bool{
	"static": true, "writes_skipped": true,
	"provider_simulated": true, "live_canary": true,
}

// SupportsAutonomousRecovery: only evidence that exercised the
// external-effect boundary may act alone.
func SupportsAutonomousRecovery(level string) bool {
	return level == "provider_simulated" || level == "live_canary"
}

// ParseValidationEvidenceLevel degrades unknown values to "static".
func ParseValidationEvidenceLevel(value string) string {
	if ValidationEvidenceLevels[value] {
		return value
	}
	return "static"
}

// Closed vocabularies, ported verbatim.
var (
	RecoveryEvidenceKinds = map[string]bool{
		"failure_snapshot": true, "run_timeline": true, "audit_trail": true,
		"validation_receipt": true, "effect_receipt": true, "terminal_outcome": true,
	}
	RecoveryEffectKinds = map[string]bool{
		"external_write": true, "financial_mutation": true,
		"notification": true, "human_action": true,
	}
	RecoveryEffectIdempotency = map[string]bool{
		"required": true, "provider_guaranteed": true, "unavailable": true,
	}
	RecoveryEffectReceipts = map[string]bool{
		"runtime": true, "provider": true, "manual": true,
	}
	RecoveryRepairClasses = map[string]bool{
		"retry": true, "config_patch": true, "structural_patch": true,
		"rollback": true, "credential_rotation": true, "upstream_wait": true,
	}
	requiredBaseEvidence = []string{"failure_snapshot", "audit_trail", "terminal_outcome"}
)

// RecoveryEffect is one declared external effect.
type RecoveryEffect struct {
	NodeID      string `json:"nodeId"`
	Kind        string `json:"kind"`
	Idempotency string `json:"idempotency"`
	Receipt     string `json:"receipt"`
}

// RecoveryTechnicalFailure is the technical failure-class block.
type RecoveryTechnicalFailure struct {
	TerminalNodeFailure bool           `json:"terminalNodeFailure"`
	StalledNode         bool           `json:"stalledNode"`
	Autonomy            map[string]int `json:"autonomy,omitempty"`
}

// RecoverySemanticDetector is one V2 deterministic detector.
type RecoverySemanticDetector struct {
	ID            string       `json:"id"`
	SourceNodeID  string       `json:"sourceNodeId"`
	Kind          string       `json:"kind"` // "expression" | "schema"
	PassWhen      string       `json:"passWhen,omitempty"`
	Schema        *InputSchema `json:"schema,omitempty"`
	Action        string       `json:"action"` // "observe" | "quarantine"
	Message       string       `json:"message"`
	AutonomyLevel *int         `json:"autonomyLevel,omitempty"`
}

// RecoverySemanticFixture is one bounded evaluation fixture.
type RecoverySemanticFixture struct {
	ID           string         `json:"id"`
	SourceNodeID string         `json:"sourceNodeId"`
	Output       any            `json:"output"`
	Context      map[string]any `json:"context,omitempty"`
	Expected     string         `json:"expected"` // "pass" | "violation"
}

// RecoverySemanticFailure is the semantic block (V1 disabled / V2
// deterministic).
type RecoverySemanticFailure struct {
	Mode               string                     `json:"mode"`
	Detectors          []RecoverySemanticDetector `json:"detectors,omitempty"`
	EvaluationFixtures []RecoverySemanticFixture  `json:"evaluationFixtures,omitempty"`
}

// RecoveryNarrowAutonomy bounds Level 4 auto-apply.
type RecoveryNarrowAutonomy struct {
	AllowedRepairClasses           []string `json:"allowedRepairClasses"`
	MinimumPriorVerifiedRecoveries int      `json:"minimumPriorVerifiedRecoveries"`
	MaxAffectedExecutions          int      `json:"maxAffectedExecutions"`
	RollbackRequired               bool     `json:"rollbackRequired"`
}

// RecoveryContract is the versioned policy (discriminated on Version).
type RecoveryContract struct {
	Version string `json:"version"`
	Failure struct {
		Technical RecoveryTechnicalFailure `json:"technical"`
		Semantic  RecoverySemanticFailure  `json:"semantic"`
	} `json:"failure"`
	Evidence struct {
		Required []string `json:"required"`
	} `json:"evidence"`
	Effects []RecoveryEffect `json:"effects"`
	Repairs struct {
		Allowed []string `json:"allowed"`
	} `json:"repairs"`
	Validation struct {
		MinimumEvidenceLevel string `json:"minimumEvidenceLevel"`
	} `json:"validation"`
	Approval struct {
		ProductionMutation string `json:"productionMutation"`
		Permission         string `json:"permission"`
	} `json:"approval"`
	AutonomyLevel  int                     `json:"autonomyLevel"`
	NarrowAutonomy *RecoveryNarrowAutonomy `json:"narrowAutonomy,omitempty"`
	Verification   struct {
		Kind string `json:"kind"`
	} `json:"verification"`
	Recurrence struct {
		WindowDays int `json:"windowDays"`
	} `json:"recurrence"`
}

// WorkflowRecovery is the optional workflow-level recovery settings
// persisted in the DAG snapshot.
type WorkflowRecovery struct {
	CircuitBreaker json.RawMessage   `json:"circuitBreaker,omitempty"`
	Contract       *RecoveryContract `json:"contract,omitempty"`
}

// Circuit breaker bounds (reference constants).
const (
	RecoveryCircuitBreakerMin = 2
	RecoveryCircuitBreakerMax = 100
)

// ParseCircuitBreakerThreshold normalizes the union false | 2..100 |
// {consecutiveFailures}: returns (threshold, enabled, problem).
func ParseCircuitBreakerThreshold(raw json.RawMessage) (int, bool, string) {
	if len(raw) == 0 {
		return 0, false, ""
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return 0, false, "circuitBreaker: null is not a valid threshold"
	}
	var boolValue bool
	if err := json.Unmarshal(raw, &boolValue); err == nil {
		if boolValue {
			return 0, false, "circuitBreaker: true is not a valid threshold"
		}
		return 0, false, ""
	}
	var numberValue float64
	if err := json.Unmarshal(raw, &numberValue); err == nil {
		return validateBreakerNumber(numberValue)
	}
	var objectValue map[string]json.RawMessage
	if err := json.Unmarshal(raw, &objectValue); err == nil && objectValue != nil && len(objectValue) == 1 {
		consecutiveFailures, present := objectValue["consecutiveFailures"]
		if !present || isJSONNull(consecutiveFailures) {
			return 0, false, "circuitBreaker.consecutiveFailures: must be false or an integer 2..100"
		}
		if err := json.Unmarshal(consecutiveFailures, &boolValue); err == nil {
			if boolValue {
				return 0, false, "circuitBreaker.consecutiveFailures: true is not a valid threshold"
			}
			return 0, false, ""
		}
		if err := json.Unmarshal(consecutiveFailures, &numberValue); err == nil {
			return validateBreakerNumber(numberValue)
		}
	}
	return 0, false, "circuitBreaker: must be false, an integer 2..100, or {consecutiveFailures}"
}

func validateBreakerNumber(value float64) (int, bool, string) {
	if value != float64(int(value)) || int(value) < RecoveryCircuitBreakerMin || int(value) > RecoveryCircuitBreakerMax {
		return 0, false, fmt.Sprintf("circuitBreaker: threshold must be an integer %d..%d",
			RecoveryCircuitBreakerMin, RecoveryCircuitBreakerMax)
	}
	return int(value), true, ""
}

func isAutonomyLevel(level int) bool {
	return level >= RecoveryAutonomyMin && level <= RecoveryAutonomyMax
}

// ValidateRecoveryContract ports the contract's V1/V2 schemas + the
// shared refinement rules. Returns path-prefixed problems (empty = valid).
// ValidateRecoveryContract returns every contract problem as a stable
// message, section by section: failure policy, evidence, effects, repairs,
// validation level, approval, the autonomy ceiling and the verification and
// recurrence envelopes. nil is valid; an unknown version stops early.
func ValidateRecoveryContract(contract *RecoveryContract) []string {
	var problems []string
	push := func(format string, args ...any) {
		problems = append(problems, fmt.Sprintf(format, args...))
	}
	if contract == nil {
		return nil
	}
	if contract.Version != "1" && contract.Version != "2" {
		return []string{"version: recovery contract version must be \"1\" or \"2\""}
	}
	validateRecoveryFailure(contract, push)
	requiredSet := validateRecoveryEvidence(contract, push)
	validateRecoveryEffects(contract, push)
	allowedRepairs := validateRecoveryRepairs(contract, push)
	validateRecoveryValidationLevel(contract, requiredSet, push)
	validateRecoveryApproval(contract, push)
	validateRecoveryAutonomy(contract, allowedRepairs, push)
	validateRecoveryEnvelopes(contract, push)
	return problems
}

func validateRecoveryFailure(contract *RecoveryContract, push func(format string, args ...any)) {
	// Failure block: technical invariants + the versioned semantic mode.
	if !contract.Failure.Technical.TerminalNodeFailure {
		push("failure.technical.terminalNodeFailure: must be true")
	}
	failureClasses := make([]string, 0, len(contract.Failure.Technical.Autonomy))
	for failureClass := range contract.Failure.Technical.Autonomy {
		failureClasses = append(failureClasses, failureClass)
	}
	sort.Strings(failureClasses)
	for _, failureClass := range failureClasses {
		level := contract.Failure.Technical.Autonomy[failureClass]
		if failureClass != "terminalNodeFailure" && failureClass != "stalledNode" {
			push("failure.technical.autonomy.%s: unknown failure class", failureClass)
			continue
		}
		if !isAutonomyLevel(level) {
			push("failure.technical.autonomy.%s: level must be 0..4", failureClass)
		} else if level > contract.AutonomyLevel {
			push("failure.technical.autonomy.%s: A failure-specific autonomy level cannot exceed the workflow recovery level", failureClass)
		}
	}
	switch contract.Version {
	case "1":
		// The HARD rule: semantic detection stays disabled on historical
		// snapshots — V1 can never activate it.
		if contract.Failure.Semantic.Mode != "disabled" {
			push("failure.semantic.mode: contract v1 requires semantic mode \"disabled\"")
		}
		if len(contract.Failure.Semantic.Detectors) > 0 || len(contract.Failure.Semantic.EvaluationFixtures) > 0 {
			push("failure.semantic: contract v1 cannot declare detectors or fixtures")
		}
	case "2":
		if contract.Failure.Semantic.Mode != "deterministic" {
			push("failure.semantic.mode: contract v2 requires semantic mode \"deterministic\"")
		}
		for _, problem := range validateSemanticV2(&contract.Failure.Semantic, contract.AutonomyLevel) {
			push("%s", problem)
		}
	}
}

// validateRecoveryEvidence returns the retained evidence kinds so later
// sections can check their implications.
func validateRecoveryEvidence(contract *RecoveryContract, push func(format string, args ...any)) map[string]bool {
	// Evidence: unique, non-empty, base kinds retained.
	if len(contract.Evidence.Required) < 1 || len(contract.Evidence.Required) > len(RecoveryEvidenceKinds) {
		push("evidence.required: must declare 1..%d evidence kinds", len(RecoveryEvidenceKinds))
	}
	if hasDuplicateStrings(contract.Evidence.Required) {
		push("evidence.required: Recovery evidence kinds must be unique")
	}
	requiredSet := map[string]bool{}
	for _, kind := range contract.Evidence.Required {
		if !RecoveryEvidenceKinds[kind] {
			push("evidence.required: unknown evidence kind %q", kind)
		}
		requiredSet[kind] = true
	}
	for _, base := range requiredBaseEvidence {
		if !requiredSet[base] {
			push("evidence.required: Recovery contract must retain %s", base)
		}
	}
	return requiredSet
}

func validateRecoveryEffects(contract *RecoveryContract, push func(format string, args ...any)) {
	// Effects: bounded, one per node, closed vocabularies.
	if len(contract.Effects) > 100 {
		push("effects: at most 100 declared effects")
	}
	var effectNodeIds []string
	for i, effect := range contract.Effects {
		effectNodeIds = append(effectNodeIds, effect.NodeID)
		if effect.NodeID == "" || len(effect.NodeID) > 200 {
			push("effects.%d.nodeId: must be 1..200 chars", i)
		}
		if !RecoveryEffectKinds[effect.Kind] {
			push("effects.%d.kind: unknown effect kind %q", i, effect.Kind)
		}
		if !RecoveryEffectIdempotency[effect.Idempotency] {
			push("effects.%d.idempotency: unknown idempotency %q", i, effect.Idempotency)
		}
		if !RecoveryEffectReceipts[effect.Receipt] {
			push("effects.%d.receipt: unknown receipt %q", i, effect.Receipt)
		}
	}
	if hasDuplicateStrings(effectNodeIds) {
		push("effects: A workflow node may define only one recovery effect")
	}
}

// validateRecoveryRepairs returns the allowed repair classes so the
// narrow-autonomy bounds can be checked against them.
func validateRecoveryRepairs(contract *RecoveryContract, push func(format string, args ...any)) map[string]bool {
	// Repairs: unique closed classes.
	if len(contract.Repairs.Allowed) < 1 {
		push("repairs.allowed: must declare at least one repair class")
	}
	if hasDuplicateStrings(contract.Repairs.Allowed) {
		push("repairs.allowed: Recovery repair classes must be unique")
	}
	allowedRepairs := map[string]bool{}
	for _, repair := range contract.Repairs.Allowed {
		if !RecoveryRepairClasses[repair] {
			push("repairs.allowed: unknown repair class %q", repair)
		}
		allowedRepairs[repair] = true
	}
	return allowedRepairs
}

func validateRecoveryValidationLevel(contract *RecoveryContract, requiredSet map[string]bool, push func(format string, args ...any)) {
	// Validation level + its evidence implications.
	level := contract.Validation.MinimumEvidenceLevel
	if !ValidationEvidenceLevels[level] {
		push("validation.minimumEvidenceLevel: unknown evidence level %q", level)
	}
	if level != "static" && !requiredSet["validation_receipt"] {
		push("evidence.required: Validation evidence above static requires validation_receipt retention")
	}
	if SupportsAutonomousRecovery(level) && !requiredSet["effect_receipt"] {
		push("evidence.required: Provider-simulated or live-canary validation requires effect_receipt retention")
	}
}

func validateRecoveryApproval(contract *RecoveryContract, push func(format string, args ...any)) {
	// Approval envelope.
	if contract.Approval.Permission != "recovery.write" {
		push("approval.permission: must be recovery.write")
	}
	if contract.Approval.ProductionMutation != "required" && contract.Approval.ProductionMutation != "autonomous_level_4" {
		push("approval.productionMutation: must be required or autonomous_level_4")
	}
}

func validateRecoveryAutonomy(contract *RecoveryContract, allowedRepairs map[string]bool, push func(format string, args ...any)) {
	level := contract.Validation.MinimumEvidenceLevel
	// Autonomy ceiling + the Level 4 vs below split.
	if !isAutonomyLevel(contract.AutonomyLevel) {
		push("autonomyLevel: must be 0..4")
	}
	if contract.AutonomyLevel == 4 {
		if !SupportsAutonomousRecovery(level) {
			push("validation.minimumEvidenceLevel: Level 4 autonomy requires provider_simulated or live_canary evidence")
		}
		if contract.Approval.ProductionMutation != "autonomous_level_4" {
			push("approval.productionMutation: Level 4 autonomy requires an explicit autonomous_level_4 mutation policy")
		}
		if contract.NarrowAutonomy == nil {
			push("narrowAutonomy: Level 4 autonomy requires prior-evidence, blast-radius, and rollback bounds")
		} else {
			narrow := contract.NarrowAutonomy
			if hasDuplicateStrings(narrow.AllowedRepairClasses) {
				push("narrowAutonomy.allowedRepairClasses: Narrow-autonomy repair classes must be unique")
			}
			if len(narrow.AllowedRepairClasses) < 1 {
				push("narrowAutonomy.allowedRepairClasses: must declare at least one repair class")
			}
			for i, repair := range narrow.AllowedRepairClasses {
				if !allowedRepairs[repair] {
					push("narrowAutonomy.allowedRepairClasses.%d: Narrow-autonomy repair classes must be allowed by the recovery contract", i)
				}
			}
			if narrow.MinimumPriorVerifiedRecoveries < 1 || narrow.MinimumPriorVerifiedRecoveries > 1000 {
				push("narrowAutonomy.minimumPriorVerifiedRecoveries: must be 1..1000")
			}
			if narrow.MaxAffectedExecutions < 1 || narrow.MaxAffectedExecutions > 100 {
				push("narrowAutonomy.maxAffectedExecutions: must be 1..100")
			}
			if !narrow.RollbackRequired {
				push("narrowAutonomy.rollbackRequired: must be true")
			}
		}
		for i, effect := range contract.Effects {
			if effect.Idempotency == "unavailable" {
				push("effects.%d.idempotency: Level 4 autonomy cannot include an effect without idempotency", i)
			}
			if effect.Receipt == "manual" {
				push("effects.%d.receipt: Level 4 autonomy cannot depend on a manual effect receipt", i)
			}
		}
	} else {
		if contract.Approval.ProductionMutation != "required" {
			push("approval.productionMutation: Autonomous production mutation is valid only at autonomy level 4")
		}
		if contract.NarrowAutonomy != nil {
			push("narrowAutonomy: Narrow-autonomy bounds are valid only at autonomy level 4")
		}
	}
}

func validateRecoveryEnvelopes(contract *RecoveryContract, push func(format string, args ...any)) {
	// Verification + recurrence envelopes.
	if contract.Verification.Kind != "generation_bound_terminal_success" {
		push("verification.kind: must be generation_bound_terminal_success")
	}
	if contract.Recurrence.WindowDays < 1 || contract.Recurrence.WindowDays > 30 {
		push("recurrence.windowDays: must be 1..30")
	}
}

// validateSemanticV2 checks the V2 detectors + bounded fixtures.
func validateSemanticV2(semantic *RecoverySemanticFailure, ceiling int) []string {
	var problems []string
	push := func(format string, args ...any) {
		problems = append(problems, fmt.Sprintf(format, args...))
	}
	if len(semantic.Detectors) < 1 || len(semantic.Detectors) > 50 {
		push("failure.semantic.detectors: must declare 1..50 detectors")
	}
	var detectorIds []string
	for i, detector := range semantic.Detectors {
		detectorIds = append(detectorIds, detector.ID)
		if detector.ID == "" || len(detector.ID) > 200 {
			push("failure.semantic.detectors.%d.id: must be 1..200 chars", i)
		}
		if detector.SourceNodeID == "" || len(detector.SourceNodeID) > 200 {
			push("failure.semantic.detectors.%d.sourceNodeId: must be 1..200 chars", i)
		}
		switch detector.Kind {
		case "expression":
			if detector.PassWhen == "" || len(detector.PassWhen) > 2000 {
				push("failure.semantic.detectors.%d.passWhen: must be 1..2000 chars", i)
			}
		case "schema":
			if detector.Schema == nil {
				push("failure.semantic.detectors.%d.schema: schema detectors require a schema", i)
			} else if !validInputSchemaShape(detector.Schema) {
				push("failure.semantic.detectors.%d.schema: must be a supported recursive schema with at most %d nodes", i, InputSchemaNodeMax)
			}
		default:
			push("failure.semantic.detectors.%d.kind: must be expression or schema", i)
		}
		if detector.Action != "observe" && detector.Action != "quarantine" {
			push("failure.semantic.detectors.%d.action: must be observe or quarantine", i)
		}
		if detector.Message == "" || len(detector.Message) > 500 {
			push("failure.semantic.detectors.%d.message: must be 1..500 chars", i)
		}
		if detector.AutonomyLevel != nil {
			if !isAutonomyLevel(*detector.AutonomyLevel) {
				push("failure.semantic.detectors.%d.autonomyLevel: must be 0..4", i)
			} else if *detector.AutonomyLevel > ceiling {
				push("failure.semantic.detectors.%d.autonomyLevel: A failure-specific autonomy level cannot exceed the workflow recovery level", i)
			}
		}
	}
	if hasDuplicateStrings(detectorIds) {
		push("failure.semantic.detectors: Semantic detector ids must be unique")
	}
	if len(semantic.EvaluationFixtures) < 2 || len(semantic.EvaluationFixtures) > 50 {
		push("failure.semantic.evaluationFixtures: must declare 2..50 fixtures")
	}
	var fixtureIds []string
	for i, fixture := range semantic.EvaluationFixtures {
		fixtureIds = append(fixtureIds, fixture.ID)
		if fixture.ID == "" || len(fixture.ID) > 200 {
			push("failure.semantic.evaluationFixtures.%d.id: must be 1..200 chars", i)
		}
		if fixture.SourceNodeID == "" || len(fixture.SourceNodeID) > 200 {
			push("failure.semantic.evaluationFixtures.%d.sourceNodeId: must be 1..200 chars", i)
		}
		if fixture.Expected != "pass" && fixture.Expected != "violation" {
			push("failure.semantic.evaluationFixtures.%d.expected: must be pass or violation", i)
		}
	}
	if hasDuplicateStrings(fixtureIds) {
		push("failure.semantic.evaluationFixtures: Semantic evaluation fixture ids must be unique")
	}
	return problems
}

func hasDuplicateStrings(values []string) bool {
	seen := map[string]bool{}
	for _, value := range values {
		if seen[value] {
			return true
		}
		seen[value] = true
	}
	return false
}
