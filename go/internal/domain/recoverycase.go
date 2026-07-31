// Pure Recovery Case lifecycle and receipt contracts, ported from the
// reference's recovery-case.ts. `dead_letters` remains the technical DLQ
// incident substrate; durable semantic incidents use `recovery_cases`.
// This module is persistence-free: the closed state ladder, the terminal
// set, and receipt validation live here so the store can apply them
// INSIDE the same CAS transaction that writes the receipt.
package domain

// RecoveryCaseStates is the closed lifecycle vocabulary, in order.
var RecoveryCaseStates = []string{
	"detected", "contained", "diagnosed", "candidates_ready",
	"validating", "awaiting_approval", "publishing", "monitoring",
	"verified_recovered", "recurred", "accepted_loss", "abandoned",
}

// RecoveryCaseTerminalStates never transition again.
var RecoveryCaseTerminalStates = map[string]bool{
	"verified_recovered": true, "recurred": true,
	"accepted_loss": true, "abandoned": true,
}

// legalRecoveryCaseTransitions ports the reference map verbatim.
var legalRecoveryCaseTransitions = map[string][]string{
	"detected":           {"contained", "accepted_loss", "abandoned"},
	"contained":          {"diagnosed", "accepted_loss", "abandoned"},
	"diagnosed":          {"candidates_ready", "accepted_loss", "abandoned"},
	"candidates_ready":   {"validating", "accepted_loss", "abandoned"},
	"validating":         {"candidates_ready", "awaiting_approval", "accepted_loss", "abandoned"},
	"awaiting_approval":  {"candidates_ready", "publishing", "accepted_loss", "abandoned"},
	"publishing":         {"monitoring", "abandoned"},
	"monitoring":         {"verified_recovered", "recurred", "accepted_loss", "abandoned"},
	"verified_recovered": {},
	"recurred":           {},
	"accepted_loss":      {},
	"abandoned":          {},
}

// ListLegalRecoveryCaseTransitions returns the closed successor list.
func ListLegalRecoveryCaseTransitions(state string) []string {
	return legalRecoveryCaseTransitions[state]
}

// IsLegalRecoveryCaseTransition reports whether from → to is in the map.
func IsLegalRecoveryCaseTransition(from, to string) bool {
	for _, next := range legalRecoveryCaseTransitions[from] {
		if next == to {
			return true
		}
	}
	return false
}

// IsRecoveryCaseState reports vocabulary membership.
func IsRecoveryCaseState(state string) bool {
	_, known := legalRecoveryCaseTransitions[state]
	return known
}

// RecoveryCaseEvidenceKinds is the closed evidence-reference vocabulary.
var RecoveryCaseEvidenceKinds = map[string]bool{
	"run": true, "run_node": true, "run_event": true,
	"semantic_detector": true, "dead_letter": true, "validation": true,
	"publication": true, "effect": true, "audit": true,
	"operator_decision": true,
}

// RecoveryCaseEvidenceRef is one receipt evidence entry.
type RecoveryCaseEvidenceRef struct {
	Kind   string `json:"kind"`
	ID     string `json:"id"`
	Sha256 string `json:"sha256,omitempty"`
}

// RecoveryCaseTransitionReceipt is the shape every case transition
// persists — validated BEFORE the store writes it.
type RecoveryCaseTransitionReceipt struct {
	CaseID    string                    `json:"caseId"`
	From      string                    `json:"from"`
	To        string                    `json:"to"`
	ActorKind string                    `json:"actorKind"`
	ActorID   string                    `json:"actorId,omitempty"`
	Evidence  []RecoveryCaseEvidenceRef `json:"evidence"`
	Reason    string                    `json:"reason,omitempty"`
}

// ValidateRecoveryCaseTransitionReceipt ports the reference schema: legal
// from → to, closed actor kinds (user/agent require an id), 1..100
// evidence entries with closed kinds + bounded ids + optional sha256,
// reason capped at 1000.
func ValidateRecoveryCaseTransitionReceipt(receipt RecoveryCaseTransitionReceipt) []string {
	var problems []string
	if !IsRecoveryCaseState(receipt.From) || !IsRecoveryCaseState(receipt.To) {
		problems = append(problems, "unknown recovery case state")
	} else if !IsLegalRecoveryCaseTransition(receipt.From, receipt.To) {
		problems = append(problems, "Illegal recovery case transition: "+receipt.From+" -> "+receipt.To)
	}
	switch receipt.ActorKind {
	case "system":
	case "user", "agent":
		if receipt.ActorID == "" {
			problems = append(problems, "User and agent transition actors require an id")
		}
	default:
		problems = append(problems, "unknown transition actor kind")
	}
	if len(receipt.Evidence) < 1 || len(receipt.Evidence) > 100 {
		problems = append(problems, "transition receipts require 1..100 evidence references")
	}
	for _, entry := range receipt.Evidence {
		if !RecoveryCaseEvidenceKinds[entry.Kind] {
			problems = append(problems, "unknown evidence kind: "+entry.Kind)
		}
		if entry.ID == "" || len(entry.ID) > 500 {
			problems = append(problems, "evidence id must be 1..500 chars")
		}
		if entry.Sha256 != "" && !isHex64(entry.Sha256) {
			problems = append(problems, "evidence sha256 must be 64 lowercase hex chars")
		}
	}
	if len(receipt.Reason) > 1000 {
		problems = append(problems, "reason must be at most 1000 chars")
	}
	if receipt.CaseID == "" || len(receipt.CaseID) > 200 {
		problems = append(problems, "caseId must be 1..200 chars")
	}
	return problems
}

func isHex64(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, r := range value {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return true
}
