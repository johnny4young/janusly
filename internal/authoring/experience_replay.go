package authoring

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"time"
)

const maxReplayHistoryEntries = 2048

// ExperienceHistoryEntry is a frozen offline snapshot, not current-time Recall.
// DeletedAt permits historical availability without erasing a later tombstone.
// Readable/Compatible must be supplied for the case's catalog and as-of instant;
// the replay does not infer historical permissions from present mutable state.
type ExperienceHistoryEntry struct {
	Candidate ExperienceCandidate `json:"candidate"`
	DeletedAt *time.Time          `json:"deletedAt,omitempty"`
}

// ExperienceConsentSnapshot freezes explicit tenant consent at an instant.
// Current org configuration is never treated as historical consent evidence.
type ExperienceConsentSnapshot struct {
	OrganizationID string    `json:"organizationId"`
	EffectiveAt    time.Time `json:"effectiveAt"`
	Enabled        bool      `json:"enabled"`
}

// ProjectExperienceReplay applies all frozen eligibility predicates before
// stable top-K. It is bounded, provider-free and does not read a database. A
// missing or ambiguous historical consent snapshot cannot authorize reuse.
func ProjectExperienceReplay(ctx context.Context, request DecisionRequest, history []ExperienceHistoryEntry, consent []ExperienceConsentSnapshot) (DecisionRequest, error) {
	if err := ctx.Err(); err != nil {
		return DecisionRequest{}, err
	}
	if len(request.Candidates) > 0 || request.Truncated || validateDecisionRequest(request) != nil || len(history) > maxReplayHistoryEntries || len(consent) > maxReplayHistoryEntries {
		return DecisionRequest{}, errDecisionRequest
	}
	raw, err := json.Marshal(struct {
		History []ExperienceHistoryEntry
		Consent []ExperienceConsentSnapshot
	}{history, consent})
	if err != nil || len(raw) > 4*1024*1024 {
		return DecisionRequest{}, errDecisionRequest
	}
	result := cloneDecisionRequest(request)
	result.Consent = false
	var latest time.Time
	seenConsent := map[string]bool{}
	for _, event := range consent {
		if err := ctx.Err(); err != nil {
			return DecisionRequest{}, err
		}
		key := event.OrganizationID + "\x00" + event.EffectiveAt.UTC().Format(time.RFC3339Nano)
		if !validDecisionID(event.OrganizationID) || event.EffectiveAt.IsZero() || seenConsent[key] {
			return DecisionRequest{}, errDecisionRequest
		}
		seenConsent[key] = true
		if event.OrganizationID == request.OrganizationID && !event.EffectiveAt.After(request.AsOf) && (latest.IsZero() || event.EffectiveAt.After(latest)) {
			latest = event.EffectiveAt
			result.Consent = event.Enabled
		}
	}
	key, _ := CanonicalExperienceKey(request.Brief)
	seen := map[string]bool{}
	eligible := []ExperienceCandidate{}
	for _, entry := range history {
		if err := ctx.Err(); err != nil {
			return DecisionRequest{}, err
		}
		check := cloneDecisionRequest(request)
		check.Candidates = []ExperienceCandidate{entry.Candidate}
		if validateDecisionRequest(check) != nil || seen[entry.Candidate.ID] || entry.Candidate.Deleted || (entry.DeletedAt != nil && entry.DeletedAt.IsZero()) {
			return DecisionRequest{}, errDecisionRequest
		}
		seen[entry.Candidate.ID] = true
		candidate := check.Candidates[0]
		candidate.Deleted = entry.DeletedAt != nil && !entry.DeletedAt.After(request.AsOf)
		if candidate.BriefKey == key && eligibleExperience(result, candidate) {
			eligible = append(eligible, candidate)
		}
	}
	slices.SortFunc(eligible, func(a, b ExperienceCandidate) int {
		if order := b.RegisteredAt.Compare(a.RegisteredAt); order != 0 {
			return order
		}
		return strings.Compare(b.ID, a.ID)
	})
	result.Truncated = len(eligible) > MaxExperienceCandidates
	result.Candidates = slices.Clone(eligible[:min(len(eligible), MaxExperienceCandidates)])
	if validateDecisionRequest(result) != nil {
		return DecisionRequest{}, errDecisionRequest
	}
	if err := ctx.Err(); err != nil {
		return DecisionRequest{}, err
	}
	return result, nil
}
