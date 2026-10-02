package authoring

import (
	"context"
	"slices"
)

// RulesProvider only classifies a caller-owned, bounded projection. A proposal
// is still untrusted until the independent receipt validator accepts it.
type RulesProvider struct{}

func (RulesProvider) Kind() DecisionProviderKind { return DecisionRulesProvider }

func (RulesProvider) Propose(ctx context.Context, request DecisionRequest) (DecisionProposal, error) {
	if err := ctx.Err(); err != nil {
		return DecisionProposal{}, err
	}
	if err := validateDecisionRequest(request); err != nil {
		return DecisionProposal{}, err
	}
	mode, reason, selected := requiredDecision(request)
	proposal := DecisionProposal{Mode: mode, Reason: reason, ContextRevision: request.ContextRevision, CatalogVersion: request.CatalogVersion}
	if selected != nil {
		proposal.CandidateID = selected.ID
		proposal.VersionID = selected.VersionID
		proposal.Edits = slices.Clone(request.Edits)
	}
	if err := ctx.Err(); err != nil {
		return DecisionProposal{}, err
	}
	return proposal, nil
}
