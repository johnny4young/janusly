// Package memorypolicy owns the closed memory-kind and retention vocabulary.
// It is deliberately dependency-free so both org-config validation and the
// memory runtime can consume one policy without an import cycle.
package memorypolicy

import "slices"

var kinds = []string{
	"recovery_rationale",
	"run_summary",
	"runbook_fragment",
	"patch_rationale",
	"generated_workflow",
	"workflow_vector",
	"agent_episode",
}

var defaultRetentionDays = map[string]int{
	"recovery_rationale": 180,
	"run_summary":        90,
	"runbook_fragment":   365,
	"patch_rationale":    365,
	"generated_workflow": 365,
	"workflow_vector":    180,
	"agent_episode":      180,
}

var maximumRetentionDays = map[string]int{
	"recovery_rationale": 730,
	"run_summary":        365,
	"runbook_fragment":   36_500,
	"patch_rationale":    730,
	"generated_workflow": 730,
	"workflow_vector":    730,
	"agent_episode":      730,
}

// Kinds returns a defensive copy in stable policy order.
func Kinds() []string { return slices.Clone(kinds) }

func IsKind(kind string) bool {
	return slices.Contains(kinds, kind)
}

func DefaultRetentionDays(kind string) (int, bool) {
	days, ok := defaultRetentionDays[kind]
	return days, ok
}

func MaximumRetentionDays(kind string) (int, bool) {
	days, ok := maximumRetentionDays[kind]
	return days, ok
}
