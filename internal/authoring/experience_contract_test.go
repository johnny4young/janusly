package authoring

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

type fixtureDecisionProvider struct {
	proposal DecisionProposal
	mutate   func(*DecisionRequest)
	calls    int
}

func (p *fixtureDecisionProvider) Kind() DecisionProviderKind { return DecisionFixtureProvider }

func (p *fixtureDecisionProvider) Propose(ctx context.Context, r DecisionRequest) (DecisionProposal, error) {
	p.calls++
	if p.mutate != nil {
		p.mutate(&r)
	}
	return p.proposal, ctx.Err()
}
func decisionFixture(t *testing.T) (DecisionRequest, DecisionProposal) {
	t.Helper()
	brief := IntentBrief{Version: "1", Objective: "Prepare local text", Trigger: "manual", Inputs: []string{"text.uppercase"}, ExpectedOutcome: "Local text", ExternalEffects: []string{}, Approvals: []string{}, FailurePolicy: "stop_and_open_recovery_case", Examples: []string{}, Language: "en"}
	key, err := CanonicalExperienceKey(brief)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	req := DecisionRequest{OrganizationID: "org-a", ContextRevision: "rev-a", CatalogVersion: "cat-a", Brief: brief, Complete: true, Consent: true, AsOf: now, Candidates: []ExperienceCandidate{{ID: "exp-a", OrganizationID: "org-a", WorkflowID: "wf-a", VersionID: "ver-a", Version: 1, BriefKey: key, PolicyVersion: AuthoringExperiencePolicyVersion, RegisteredAt: now.Add(-time.Hour), VersionCreatedAt: now.Add(-2 * time.Hour), RetainUntil: now.Add(time.Hour), Readable: true, Compatible: true}}}
	proposal := DecisionProposal{Mode: DecisionReuse, Reason: DecisionExactMatch, ContextRevision: req.ContextRevision, CatalogVersion: req.CatalogVersion, CandidateID: "exp-a", VersionID: "ver-a"}
	return req, proposal
}
func TestExperienceContractRejectsUntrustedProposals(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*DecisionRequest, *DecisionProposal)
	}{
		{"invented candidate", func(r *DecisionRequest, p *DecisionProposal) { p.CandidateID = "other" }},
		{"invented version", func(r *DecisionRequest, p *DecisionProposal) { p.VersionID = "latest" }},
		{"stale context", func(r *DecisionRequest, p *DecisionProposal) { p.ContextRevision = "old" }},
		{"stale catalog", func(r *DecisionRequest, p *DecisionProposal) { p.CatalogVersion = "old" }},
		{"wrong mode", func(r *DecisionRequest, p *DecisionProposal) { p.Mode = "execute" }},
		{"wrong reason", func(r *DecisionRequest, p *DecisionProposal) { p.Reason = "approved" }},
		{"cross tenant", func(r *DecisionRequest, p *DecisionProposal) { r.Candidates[0].OrganizationID = "org-b" }},
		{"expired", func(r *DecisionRequest, p *DecisionProposal) { r.Candidates[0].RetainUntil = r.AsOf }},
		{"future registration", func(r *DecisionRequest, p *DecisionProposal) { r.Candidates[0].RegisteredAt = r.AsOf.Add(time.Second) }},
		{"future source", func(r *DecisionRequest, p *DecisionProposal) {
			r.Candidates[0].VersionCreatedAt = r.AsOf.Add(time.Second)
		}},
		{"revoked", func(r *DecisionRequest, p *DecisionProposal) { stamp := r.AsOf; r.Candidates[0].RevokedAt = &stamp }},
		{"deleted", func(r *DecisionRequest, p *DecisionProposal) { r.Candidates[0].Deleted = true }},
		{"unreadable", func(r *DecisionRequest, p *DecisionProposal) { r.Candidates[0].Readable = false }},
		{"incompatible", func(r *DecisionRequest, p *DecisionProposal) { r.Candidates[0].Compatible = false }},
		{"unconsented", func(r *DecisionRequest, p *DecisionProposal) { r.Consent = false }},
		{"incomplete", func(r *DecisionRequest, p *DecisionProposal) { r.Complete = false }},
		{"blank objective", func(r *DecisionRequest, p *DecisionProposal) {
			// Keep the key exact so only the incomplete-intent veto can reject it.
			r.Brief.Objective = "   "
			r.Candidates[0].BriefKey, _ = CanonicalExperienceKey(r.Brief)
		}},
		{"policy drift", func(r *DecisionRequest, p *DecisionProposal) { r.Candidates[0].PolicyVersion = "unknown" }},
		{"brief drift", func(r *DecisionRequest, p *DecisionProposal) {
			r.Brief.Approvals = []string{"human_approval_before_external_effect"}
		}},
		{"duplicate ids", func(r *DecisionRequest, p *DecisionProposal) { r.Candidates = append(r.Candidates, r.Candidates[0]) }},
		{"ambiguous source", func(r *DecisionRequest, p *DecisionProposal) {
			c := r.Candidates[0]
			c.ID = "exp-b"
			c.VersionID = "ver-b"
			r.Candidates = append(r.Candidates, c)
		}},
		{"truncated exact set", func(r *DecisionRequest, p *DecisionProposal) { r.Truncated = true }},
		{"canonical recipe", func(r *DecisionRequest, p *DecisionProposal) { r.CanonicalRecipe = true }},
		{"unrequested change", func(r *DecisionRequest, p *DecisionProposal) {
			p.Edits = []DescriptiveEdit{{Field: "workflow_name", Value: "Rename"}}
		}},
		{"non-canonical key", func(r *DecisionRequest, p *DecisionProposal) {
			r.Candidates[0].BriefKey = strings.ToUpper(r.Candidates[0].BriefKey)
		}},
		{"multiline name edit", func(r *DecisionRequest, p *DecisionProposal) {
			r.Edits = []DescriptiveEdit{{Field: "workflow_name", Value: "Rename\nInjected"}}
			p.Mode = DecisionAdapt
			p.Reason = DecisionDescriptiveAdapt
			p.Edits = r.Edits
		}},
		{"unsupported edit", func(r *DecisionRequest, p *DecisionProposal) {
			r.Edits = []DescriptiveEdit{{Field: "config", Value: "new"}}
			p.Mode = DecisionAdapt
			p.Reason = DecisionDescriptiveAdapt
			p.Edits = r.Edits
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r, p := decisionFixture(t)
			tc.mutate(&r, &p)
			got, err := ValidateDecision(r, p)
			if err == nil || got.Source != nil {
				t.Fatalf("untrusted proposal reached reference resolution: %+v, %v", got, err)
			}
		})
	}
}
func TestExperienceContractOwnsInputAndCancellation(t *testing.T) {
	r, p := decisionFixture(t)
	before, _ := json.Marshal(r)
	provider := &fixtureDecisionProvider{proposal: p, mutate: func(r *DecisionRequest) {
		r.Brief.Inputs[0] = "poison"
		r.Candidates[0].VersionID = "poison"
		r.Candidates[0].OrganizationID = "org-b"
	}}
	got, err := ProposeDecision(t.Context(), provider, r)
	if err != nil || got.Source == nil || got.Source.VersionID != "ver-a" {
		t.Fatalf("input mutation changed policy: %+v %v", got, err)
	}
	after, _ := json.Marshal(r)
	if string(before) != string(after) {
		t.Fatal("provider mutated caller input")
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	provider.calls = 0
	if _, err := ProposeDecision(cancelled, provider, r); !errors.Is(err, context.Canceled) || provider.calls != 0 {
		t.Fatalf("cancelled request admitted: %v calls=%d", err, provider.calls)
	}
	provider = &fixtureDecisionProvider{proposal: p, mutate: func(r *DecisionRequest) { cancel() }}
	active, cancel := context.WithCancel(t.Context())
	defer cancel()
	if _, err := ProposeDecision(active, provider, r); !errors.Is(err, context.Canceled) {
		t.Fatalf("late cancelled response admitted: %v", err)
	}
}
func TestExperienceContractExactKeysPreserveEveryConstraint(t *testing.T) {
	r, _ := decisionFixture(t)
	base, err := CanonicalExperienceKey(r.Brief)
	if err != nil {
		t.Fatal(err)
	}
	changes := []func(*IntentBrief){
		func(b *IntentBrief) { b.Version = "2" }, func(b *IntentBrief) { b.Objective += " other" }, func(b *IntentBrief) { b.Trigger = "schedule" }, func(b *IntentBrief) { b.Inputs[0] = "Text.uppercase" }, func(b *IntentBrief) { b.ExpectedOutcome += " other" }, func(b *IntentBrief) { b.ExternalEffects = []string{"slack.post"} }, func(b *IntentBrief) { b.Approvals = []string{"human"} }, func(b *IntentBrief) { b.FailurePolicy = "continue" }, func(b *IntentBrief) { b.Examples = []string{"example"} }, func(b *IntentBrief) { b.Language = "es" },
	}
	for i, change := range changes {
		b := cloneDecisionRequest(r).Brief
		change(&b)
		key, err := CanonicalExperienceKey(b)
		if err != nil || key == base {
			t.Fatalf("constraint %d collapsed: %s %v", i, key, err)
		}
	}
	b := r.Brief
	b.Inputs = []string{"A", "B"}
	k1, _ := CanonicalExperienceKey(b)
	b.Inputs = []string{"B", "A"}
	k2, _ := CanonicalExperienceKey(b)
	if k1 == k2 {
		t.Fatal("ordered machine identifiers collapsed")
	}
}
func TestExperienceContractByteLimitsAndStrictDecode(t *testing.T) {
	r, p := decisionFixture(t)
	for _, tc := range []struct {
		name    string
		invalid func(*DecisionRequest)
	}{
		{"unicode overflow", func(r *DecisionRequest) { r.Brief.Objective = strings.Repeat("界", MaxDecisionRequestBytes) }},
		{"catalog cap", func(r *DecisionRequest) {
			for len(r.Candidates) <= MaxExperienceCandidates {
				c := r.Candidates[0]
				c.ID += strings.Repeat("x", len(r.Candidates))
				r.Candidates = append(r.Candidates, c)
			}
		}},
		{"missing version evidence", func(r *DecisionRequest) { r.Candidates[0].VersionCreatedAt = time.Time{} }},
		{"invalid UTF8", func(r *DecisionRequest) { r.Brief.Objective = string([]byte{0xff}) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bad := cloneDecisionRequest(r)
			tc.invalid(&bad)
			if _, err := ValidateDecision(bad, p); err == nil {
				t.Fatal("invalid projection accepted")
			}
		})
	}
	raw, _ := json.Marshal(p)
	got, err := DecodeDecisionProposal(raw)
	if err != nil || !reflect.DeepEqual(got, p) {
		t.Fatalf("valid JSON: %+v %v", got, err)
	}
	for _, bad := range []string{string(raw[:len(raw)-1]), string(raw) + " {}", `null`, `[]`, `{"mode":3}`, `{"mode":"REUSE","confidence":1}`, strings.Repeat(" ", MaxDecisionResultBytes) + string(raw)} {
		if _, err := DecodeDecisionProposal([]byte(bad)); err == nil {
			t.Fatalf("invalid result accepted: %q", bad[:min(len(bad), 80)])
		}
	}
}
