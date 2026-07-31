// Pure recovery-autonomy policy projection, ported from the reference's
// recovery-autonomy.ts. A workflow contract owns the MAXIMUM autonomy
// level; failure-specific overrides may only lower that ceiling, never
// raise it (the contract validator enforces the ceiling). This module
// turns the declaration into one explainable capability ladder shared by
// API, engine, MCP, and web projections — it grants NO mutation authority
// itself, and an unavailable policy fails CLOSED.
package domain

// RecoveryAutonomyCapabilities is the ordered Level 0-4 capability ladder.
var RecoveryAutonomyCapabilities = []string{
	"observe", "recommend", "validate", "apply_with_approval", "autonomous_apply",
}

// RecoveryAutonomyCapabilityLevel maps each capability to its floor.
var RecoveryAutonomyCapabilityLevel = map[string]int{
	"observe": 0, "recommend": 1, "validate": 2,
	"apply_with_approval": 3, "autonomous_apply": 4,
}

// RecoveryAutonomyFactor is one explainable ladder row.
type RecoveryAutonomyFactor struct {
	Capability    string `json:"capability"`
	RequiredLevel int    `json:"requiredLevel"`
	Enabled       bool   `json:"enabled"`
}

// RecoveryAutonomyCapabilities is the resolved capability set.
type RecoveryAutonomyCapabilitySet struct {
	Observe           bool `json:"observe"`
	Recommend         bool `json:"recommend"`
	Validate          bool `json:"validate"`
	ApplyWithApproval bool `json:"applyWithApproval"`
	AutonomousApply   bool `json:"autonomousApply"`
}

// RecoveryAutonomyProfile is the shared resolved projection. Level is nil
// when the policy is unavailable (fail-closed: every capability false).
type RecoveryAutonomyProfile struct {
	Level             *int                          `json:"level"`
	Source            string                        `json:"source"`
	DetectorIDs       []string                      `json:"detectorIds"`
	UnavailableReason string                        `json:"unavailableReason,omitempty"`
	Capabilities      RecoveryAutonomyCapabilitySet `json:"capabilities"`
	Factors           []RecoveryAutonomyFactor      `json:"factors"`
}

// RecoveryFailureClass names one failure the profile resolves for.
// Kind "technical" uses Failure ("terminal_node_failure" |
// "stalled_node"); kind "semantic" uses DetectorID.
type RecoveryFailureClass struct {
	Kind       string
	Failure    string
	DetectorID string
}

func autonomyProfile(level *int, source string, detectorIds []string, unavailableReason string) RecoveryAutonomyProfile {
	enabled := func(floor int) bool { return level != nil && *level >= floor }
	factors := make([]RecoveryAutonomyFactor, 0, len(RecoveryAutonomyCapabilities))
	for _, capability := range RecoveryAutonomyCapabilities {
		floor := RecoveryAutonomyCapabilityLevel[capability]
		factors = append(factors, RecoveryAutonomyFactor{
			Capability: capability, RequiredLevel: floor, Enabled: enabled(floor),
		})
	}
	ids := make([]string, len(detectorIds))
	copy(ids, detectorIds)
	return RecoveryAutonomyProfile{
		Level: level, Source: source, DetectorIDs: ids,
		UnavailableReason: unavailableReason,
		Capabilities: RecoveryAutonomyCapabilitySet{
			Observe: enabled(0), Recommend: enabled(1), Validate: enabled(2),
			ApplyWithApproval: enabled(3), AutonomousApply: enabled(4),
		},
		Factors: factors,
	}
}

func levelPtr(level int) *int { return &level }

// ResolveRecoveryAutonomyProfile projects one failure class through the
// contract: failure override wins when present (it can only be lower —
// the validator enforced the ceiling), the workflow default otherwise,
// and a missing contract/policy fails closed as "unavailable".
func ResolveRecoveryAutonomyProfile(contract *RecoveryContract, failureClass RecoveryFailureClass) RecoveryAutonomyProfile {
	semanticIds := []string{}
	if failureClass.Kind == "semantic" {
		semanticIds = []string{failureClass.DetectorID}
	}
	if contract == nil {
		return autonomyProfile(nil, "unavailable", semanticIds, "contract_missing")
	}

	if failureClass.Kind == "technical" {
		key := "terminalNodeFailure"
		if failureClass.Failure == "stalled_node" {
			key = "stalledNode"
		}
		if override, present := contract.Failure.Technical.Autonomy[key]; present {
			return autonomyProfile(levelPtr(override), "failure_override", nil, "")
		}
		return autonomyProfile(levelPtr(contract.AutonomyLevel), "workflow_default", nil, "")
	}

	if contract.Version != "2" {
		return autonomyProfile(nil, "unavailable", semanticIds, "failure_policy_missing")
	}
	for _, detector := range contract.Failure.Semantic.Detectors {
		if detector.ID != failureClass.DetectorID {
			continue
		}
		if detector.AutonomyLevel != nil {
			return autonomyProfile(levelPtr(*detector.AutonomyLevel), "failure_override", []string{detector.ID}, "")
		}
		return autonomyProfile(levelPtr(contract.AutonomyLevel), "workflow_default", []string{detector.ID}, "")
	}
	return autonomyProfile(nil, "unavailable", semanticIds, "failure_policy_missing")
}

// CombineRecoveryAutonomyProfiles merges same-source cohorts: one
// replacement can close several detectors atomically, so the STRICTEST
// detector governs the whole decision, and any unavailable policy fails
// the aggregate closed rather than disappearing from it.
func CombineRecoveryAutonomyProfiles(profiles []RecoveryAutonomyProfile) RecoveryAutonomyProfile {
	if len(profiles) == 0 {
		return autonomyProfile(nil, "unavailable", nil, "failure_policy_missing")
	}
	var detectorIds []string
	seen := map[string]bool{}
	for _, item := range profiles {
		for _, id := range item.DetectorIDs {
			if !seen[id] {
				seen[id] = true
				detectorIds = append(detectorIds, id)
			}
		}
	}
	for _, item := range profiles {
		if item.Level == nil {
			reason := item.UnavailableReason
			if reason == "" {
				reason = "failure_policy_missing"
			}
			return autonomyProfile(nil, "unavailable", detectorIds, reason)
		}
	}
	minimum := *profiles[0].Level
	for _, item := range profiles[1:] {
		if *item.Level < minimum {
			minimum = *item.Level
		}
	}
	source := "strictest_failure"
	if len(profiles) == 1 {
		source = profiles[0].Source
	}
	return autonomyProfile(levelPtr(minimum), source, detectorIds, "")
}
