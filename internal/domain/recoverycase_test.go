package domain

import (
	"strings"
	"testing"
)

// Ports recovery-case.test.ts: the canonical path is legal step by step,
// terminal states are truly terminal, and skips are refused.
func TestRecoveryCaseLadder(t *testing.T) {
	path := []string{
		"detected", "contained", "diagnosed", "candidates_ready",
		"validating", "awaiting_approval", "publishing", "monitoring",
		"verified_recovered",
	}
	for i := 0; i < len(path)-1; i++ {
		if !IsLegalRecoveryCaseTransition(path[i], path[i+1]) {
			t.Fatalf("canonical step must be legal: %s -> %s", path[i], path[i+1])
		}
	}
	if got := ListLegalRecoveryCaseTransitions("verified_recovered"); len(got) != 0 {
		t.Fatalf("terminal must have no successors: %v", got)
	}
	for _, terminal := range []string{"recurred", "accepted_loss", "abandoned"} {
		if got := ListLegalRecoveryCaseTransitions(terminal); len(got) != 0 {
			t.Fatalf("%s must be terminal: %v", terminal, got)
		}
	}
	if IsLegalRecoveryCaseTransition("detected", "publishing") {
		t.Fatal("skipping the ladder must be illegal")
	}
	// Every open state can bail to accepted_loss or abandoned — except
	// publishing, which only abandons (the contract's exact map).
	if IsLegalRecoveryCaseTransition("publishing", "accepted_loss") {
		t.Fatal("publishing cannot accept loss in the contract map")
	}
	if !IsLegalRecoveryCaseTransition("publishing", "abandoned") {
		t.Fatal("publishing must be abandonable")
	}
}

// Ports the receipt-shape cases: legal evidenced receipts pass; illegal
// transition, empty evidence, and agent-without-id fail.
func TestRecoveryCaseTransitionReceiptValidation(t *testing.T) {
	valid := RecoveryCaseTransitionReceipt{
		CaseID: "case-1", From: "awaiting_approval", To: "publishing",
		ActorKind: "user", ActorID: "operator-1",
		Evidence: []RecoveryCaseEvidenceRef{{Kind: "operator_decision", ID: "audit-1"}},
	}
	if problems := ValidateRecoveryCaseTransitionReceipt(valid); len(problems) != 0 {
		t.Fatalf("valid receipt: %v", problems)
	}

	illegal := valid
	illegal.To = "verified_recovered"
	if problems := ValidateRecoveryCaseTransitionReceipt(illegal); len(problems) == 0 {
		t.Fatal("illegal transition must fail")
	}

	empty := valid
	empty.Evidence = nil
	if problems := ValidateRecoveryCaseTransitionReceipt(empty); len(problems) == 0 {
		t.Fatal("empty evidence must fail")
	}

	agent := valid
	agent.ActorKind = "agent"
	agent.ActorID = ""
	if problems := ValidateRecoveryCaseTransitionReceipt(agent); len(problems) == 0 {
		t.Fatal("agent without id must fail")
	}

	badSha := valid
	badSha.Evidence = []RecoveryCaseEvidenceRef{{Kind: "run", ID: "r1", Sha256: "XYZ"}}
	if problems := ValidateRecoveryCaseTransitionReceipt(badSha); len(problems) == 0 {
		t.Fatal("malformed sha256 must fail")
	}

	longReason := valid
	longReason.Reason = strings.Repeat("r", 1001)
	if problems := ValidateRecoveryCaseTransitionReceipt(longReason); len(problems) == 0 {
		t.Fatal("over-long reason must fail")
	}
}
