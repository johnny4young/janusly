// Pure Recovery Item (ownership) lifecycle, implements the contract's
// recovery-item.ts: the technical DLQ incident's status ladder, the
// CAS pre-state table (concurrent operator clicks can't double-apply —
// the loser's status is outside the allowed pre-states and 409s), the
// closed resolution-reason set, and the bounded comment contract.
package domain

// RecoveryItemStatuses is the closed lifecycle vocabulary.
var RecoveryItemStatuses = map[string]bool{
	"open": true, "acknowledged": true, "in_progress": true,
	"waiting_external": true, "resolved": true, "reopened": true,
}

// RecoveryItemAllowedPreStates maps each action to the statuses it may
// transition FROM (the CAS predicate), verbatim from the contract.
var RecoveryItemAllowedPreStates = map[string][]string{
	"acknowledge":      {"open", "reopened"},
	"in_progress":      {"acknowledged", "waiting_external"},
	"waiting_external": {"acknowledged", "in_progress"},
	"resolve":          {"open", "acknowledged", "in_progress", "waiting_external", "reopened"},
	"reopen":           {"resolved"},
}

// RecoveryItemActionTarget maps each action to its resulting status.
var RecoveryItemActionTarget = map[string]string{
	"acknowledge": "acknowledged", "in_progress": "in_progress",
	"waiting_external": "waiting_external", "resolve": "resolved", "reopen": "reopened",
}

// RecoveryItemResolutionReasons is the closed set; sandbox_replay_succeeded
// is written ONLY by the generation-matched terminal-impact path.
var RecoveryItemResolutionReasons = map[string]bool{
	"fixed_by_patch": true, "rolled_back": true, "upstream_fixed": true,
	"accepted_loss": true, "not_a_bug": true, "sandbox_replay_succeeded": true,
}

// RecoveryItemSeverities is the closed severity set (p1 most urgent).
var RecoveryItemSeverities = map[string]bool{"p1": true, "p2": true, "p3": true, "p4": true}

// EscalateRecoveryItemSeverity raises one step toward p1.
func EscalateRecoveryItemSeverity(severity string) string {
	switch severity {
	case "p4":
		return "p3"
	case "p3":
		return "p2"
	default:
		return "p1"
	}
}

// Comment bounds (reference constants).
const (
	RecoveryItemCommentBodyMax = 4_000
	MaxCommentsPerItem         = 200
)

// RecoveryHandoffDestinations is the closed handoff destination set.
var RecoveryHandoffDestinations = map[string]bool{
	"slack": true, "linear": true, "github": true, "webhook": true,
}
