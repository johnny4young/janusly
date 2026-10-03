package authoring

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestExperienceContractExactByteBoundaries(t *testing.T) {
	r, p := decisionFixture(t)
	r.Brief.Objective = strings.Repeat("x", 4800)
	r.Brief.ExpectedOutcome = ""
	raw, _ := json.Marshal(r)
	r.Brief.ExpectedOutcome = strings.Repeat("y", MaxDecisionRequestBytes-len(raw))
	raw, _ = json.Marshal(r)
	if len(raw) != MaxDecisionRequestBytes || validateDecisionRequest(r) != nil {
		t.Fatalf("exact request boundary rejected: %d", len(raw))
	}
	r.Brief.ExpectedOutcome += "z"
	if validateDecisionRequest(r) == nil {
		t.Fatal("one-byte request overflow accepted")
	}
	raw, _ = json.Marshal(p)
	padded := append(raw, []byte(strings.Repeat(" ", MaxDecisionResultBytes-len(raw)))...)
	if _, err := DecodeDecisionProposal(padded); err != nil {
		t.Fatalf("exact result boundary rejected: %v", err)
	}
	if _, err := DecodeDecisionProposal(append(padded, ' ')); err == nil {
		t.Fatal("one-byte result overflow accepted")
	}
}

func FuzzDecisionProposalContract(f *testing.F) {
	f.Add([]byte(`{"mode":"GENERATE","reason":"no_exact_match","contextRevision":"r","catalogVersion":"c"}`))
	f.Add([]byte(`{"mode":"REUSE","reason":"exact_match","contextRevision":"r","catalogVersion":"c","candidateId":"e","versionId":"v"}`))
	for _, seed := range []string{"null", "[]", `{"mode":1}`, `{"mode":"REUSE"`, "界", strings.Repeat(" ", MaxDecisionResultBytes+1)} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, raw []byte) {
		before := string(raw)
		p, err := DecodeDecisionProposal(raw)
		if string(raw) != before {
			t.Fatal("decoder mutated input")
		}
		if err != nil {
			return
		}
		if len(raw) > MaxDecisionResultBytes || !validProposalShape(p) {
			t.Fatal("invalid proposal escaped decoder")
		}
		encoded, err := json.Marshal(p)
		if err != nil {
			t.Fatal(err)
		}
		roundtrip, err := DecodeDecisionProposal(encoded)
		if err != nil || !reflect.DeepEqual(roundtrip, p) {
			t.Fatalf("unstable proposal: %+v %v", roundtrip, err)
		}
	})
}

func FuzzDecisionEligibilityProjection(f *testing.F) {
	// Byte bits mutate eligibility independently; rotating candidates must never
	// choose a different source or turn an ineligible source into accepted reuse.
	for _, seed := range []uint16{0, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2047} {
		f.Add(seed, uint8(0), "Local text")
	}
	f.Fuzz(func(t *testing.T, bits uint16, rotation uint8, outcome string) {
		r, p := decisionFixture(t)
		c := &r.Candidates[0]
		if bits&1 != 0 {
			c.OrganizationID = "other"
		}
		if bits&2 != 0 {
			c.Readable = false
		}
		if bits&4 != 0 {
			c.Compatible = false
		}
		if bits&8 != 0 {
			c.Deleted = true
		}
		if bits&16 != 0 {
			c.RegisteredAt = r.AsOf.Add(1)
		}
		if bits&32 != 0 {
			c.VersionCreatedAt = r.AsOf.Add(1)
		}
		if bits&64 != 0 {
			c.RetainUntil = r.AsOf
		}
		if bits&128 != 0 {
			stamp := r.AsOf
			c.RevokedAt = &stamp
		}
		if bits&256 != 0 {
			r.Consent = false
		}
		if bits&512 != 0 {
			r.Truncated = true
		}
		if bits&1024 != 0 {
			r.Complete = false
		}
		r.Brief.ExpectedOutcome = outcome
		// Always insert distinct, nonmatching same-tenant records, without relying
		// on a provider's order or heuristic rank for admission.
		for i := range 4 {
			other := r.Candidates[0]
			other.ID = string(rune('a' + i))
			other.BriefKey = strings.Repeat("a", 64)
			r.Candidates = append(r.Candidates, other)
		}
		shift := int(rotation) % len(r.Candidates)
		r.Candidates = append(r.Candidates[shift:], r.Candidates[:shift]...)
		before, _ := json.Marshal(r)
		receipt, err := ValidateDecision(r, p)

		prediction, predictionErr := (RulesProvider{}).Propose(t.Context(), r)
		if validateDecisionRequest(r) == nil {
			if predictionErr != nil {
				t.Fatalf("rules rejected valid projection: %v", predictionErr)
			}
			accepted, policyErr := ProposeDecision(t.Context(), RulesProvider{}, r)
			if policyErr != nil || accepted.Mode != prediction.Mode {
				t.Fatalf("rules/policy disagreement: %v", policyErr)
			}
			if accepted.Source != nil && (bits&2047 != 0 || outcome != "Local text") {
				t.Fatalf("rules admitted ineligible source: bits=%d", bits)
			}
		} else if predictionErr == nil {
			t.Fatal("rules accepted invalid projection")
		}
		after, _ := json.Marshal(r)
		if string(before) != string(after) {
			t.Fatal("policy mutated input")
		}
		safe := bits&2047 == 0 && outcome == "Local text"
		if err == nil && (!safe || receipt.Source == nil || receipt.Source.VersionID != "ver-a") {
			t.Fatalf("eligibility veto lost: bits=%d %+v", bits, receipt)
		}
		if safe && (err != nil || receipt.Source == nil) {
			t.Fatalf("permutation changed exact admission: %v", err)
		}
	})
}
