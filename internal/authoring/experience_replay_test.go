package authoring

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestReplayChronologyBeforeStableTopK(t *testing.T) {
	r, _ := decisionFixture(t)
	original := r.Candidates[0]
	r.Candidates = nil
	history := []ExperienceHistoryEntry{{Candidate: original}}
	for i := range 30 {
		c := original
		c.ID = fmt.Sprintf("future-%02d", i)
		c.RegisteredAt = r.AsOf.Add(time.Minute)
		history = append(history, ExperienceHistoryEntry{Candidate: c})
	}
	futureRevocation := r.AsOf.Add(time.Minute)
	history[0].Candidate.RevokedAt = &futureRevocation
	history[0].DeletedAt = &futureRevocation
	consent := []ExperienceConsentSnapshot{{OrganizationID: r.OrganizationID, EffectiveAt: r.AsOf.Add(-time.Hour), Enabled: true}, {OrganizationID: r.OrganizationID, EffectiveAt: r.AsOf.Add(time.Minute), Enabled: false}}
	got, err := ProjectExperienceReplay(t.Context(), r, history, consent)
	if err != nil || got.Truncated || !got.Consent || len(got.Candidates) != 1 || got.Candidates[0].ID != original.ID {
		t.Fatalf("future facts changed past top-K: %+v %v", got, err)
	}
	receipt, err := ProposeDecision(t.Context(), RulesProvider{}, got)
	if err != nil || receipt.Mode != DecisionReuse {
		t.Fatalf("historical reuse: %+v %v", receipt, err)
	}
	// Exact revocation/deletion boundaries are exclusive, unlike availability.
	r.AsOf = futureRevocation
	got, err = ProjectExperienceReplay(t.Context(), r, history[:1], consent)
	if err != nil || got.Consent || len(got.Candidates) != 0 {
		t.Fatalf("boundary: %+v %v", got, err)
	}
	if original.RevokedAt != nil || original.Deleted {
		t.Fatal("projection changed frozen history")
	}
}

func TestReplayOrderingScopeAndTruncation(t *testing.T) {
	r, _ := decisionFixture(t)
	c := r.Candidates[0]
	r.Candidates = nil
	var history []ExperienceHistoryEntry
	for _, id := range []string{"a", "f", "b", "e", "d", "c"} {
		copy := c
		copy.ID = id
		history = append(history, ExperienceHistoryEntry{Candidate: copy})
	}
	foreign := c
	foreign.ID = "z"
	foreign.OrganizationID = "other"
	history = append(history, ExperienceHistoryEntry{Candidate: foreign})
	events := []ExperienceConsentSnapshot{{OrganizationID: r.OrganizationID, EffectiveAt: r.AsOf, Enabled: true}}
	got, err := ProjectExperienceReplay(t.Context(), r, history, events)
	if err != nil || !got.Truncated || len(got.Candidates) != 5 {
		t.Fatalf("sentinel: %+v %v", got, err)
	}
	ids := []string{}
	for _, candidate := range got.Candidates {
		ids = append(ids, candidate.ID)
	}
	if !reflect.DeepEqual(ids, []string{"f", "e", "d", "c", "b"}) {
		t.Fatalf("unstable/foreign ordering: %v", ids)
	}
	receipt, err := ProposeDecision(t.Context(), RulesProvider{}, got)
	if err != nil || receipt.Reason != DecisionCandidatesTruncated {
		t.Fatalf("silent first-row selection: %+v %v", receipt, err)
	}
}

func TestReplayRejectsAmbiguousSnapshotsAndCancellation(t *testing.T) {
	r, _ := decisionFixture(t)
	history := []ExperienceHistoryEntry{{Candidate: r.Candidates[0]}}
	r.Candidates = nil
	event := ExperienceConsentSnapshot{OrganizationID: r.OrganizationID, EffectiveAt: r.AsOf, Enabled: true}
	if _, err := ProjectExperienceReplay(t.Context(), r, history, []ExperienceConsentSnapshot{event, event}); err == nil {
		t.Fatal("ambiguous consent accepted")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := ProjectExperienceReplay(ctx, r, history, []ExperienceConsentSnapshot{event}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
}

func TestReplayNeverDropsConstraintsToFitProjection(t *testing.T) {
	r, _ := decisionFixture(t)
	candidate := r.Candidates[0]
	r.Candidates = nil
	r.Brief.Objective = strings.Repeat("x", 4800)
	r.Brief.ExpectedOutcome = ""
	raw, _ := json.Marshal(r)
	r.Brief.ExpectedOutcome = strings.Repeat("y", MaxDecisionRequestBytes-len(raw)-1)
	if validateDecisionRequest(r) != nil {
		t.Fatal("fixture request should fit before candidate selection")
	}
	key, err := CanonicalExperienceKey(r.Brief)
	if err != nil {
		t.Fatal(err)
	}
	candidate.BriefKey = key
	consent := []ExperienceConsentSnapshot{{OrganizationID: r.OrganizationID, EffectiveAt: r.AsOf, Enabled: true}}
	if _, err := ProjectExperienceReplay(t.Context(), r, []ExperienceHistoryEntry{{Candidate: candidate}}, consent); err == nil {
		t.Fatal("oversized projection silently dropped authoritative constraints")
	}
}

func TestReplayIgnoresCallerConsentAndRejectsUnboundedHistory(t *testing.T) {
	r, _ := decisionFixture(t)
	history := []ExperienceHistoryEntry{{Candidate: r.Candidates[0]}}
	r.Candidates = nil
	r.Consent = true
	result, err := ProjectExperienceReplay(t.Context(), r, history, nil)
	if err != nil || result.Consent {
		t.Fatalf("caller consent substituted for historical snapshot: consent=%v err=%v", result.Consent, err)
	}
	receipt, err := ProposeDecision(t.Context(), RulesProvider{}, result)
	if err != nil || receipt.Reason != DecisionConsentUnavailable {
		t.Fatalf("missing snapshot grants admission: %+v %v", receipt, err)
	}
	if _, err := ProjectExperienceReplay(t.Context(), r, make([]ExperienceHistoryEntry, maxReplayHistoryEntries+1), nil); err == nil {
		t.Fatal("unbounded history accepted")
	}
}
