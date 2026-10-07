package authoring

import (
	"context"
	"errors"
	"testing"
)

func TestExperienceReaderRejectsCallerFactsAndCancelledRequestsBeforeIO(t *testing.T) {
	r, _ := decisionFixture(t)
	catalog := NewBuilder(nil, nil).Build(t.Context(), r.OrganizationID)
	r.CatalogVersion = catalog.Version
	registry := &ExperienceRegistry{}
	if _, err := registry.Decide(t.Context(), r, catalog); !errors.Is(err, ErrExperienceBriefInvalid) {
		t.Fatalf("caller candidates accepted: %v", err)
	}
	r.Candidates = nil
	r.Truncated = true
	if _, err := registry.Decide(t.Context(), r, catalog); !errors.Is(err, ErrExperienceBriefInvalid) {
		t.Fatalf("caller truncation accepted: %v", err)
	}
	r.Truncated = false
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := registry.Decide(ctx, r, catalog); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
	if _, err := registry.Decide(t.Context(), r, catalog); !errors.Is(err, ErrExperienceDisabled) {
		t.Fatalf("default off admitted IO: %v", err)
	}
	receipt := DecisionReceipt{Provider: DecisionRulesProvider, Mode: DecisionReuse, Reason: DecisionExactMatch, Source: &ExperienceReference{CandidateID: "exp", WorkflowID: "workflow", VersionID: "version", Version: 1}}
	for _, draftID := range []string{"", " padded", "workflow"} {
		if _, err := registry.Resolve(t.Context(), r, receipt, catalog, draftID); !errors.Is(err, ErrExperienceSourceIncompatible) {
			t.Fatalf("unusable draft identity %q reached IO: %v", draftID, err)
		}
	}
}
