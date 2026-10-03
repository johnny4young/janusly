package authoring

import (
	"context"
	"encoding/json"
	"reflect"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/workflowvalidation"
)

// ExperienceArtifact is privately re-read by an authorized, scoped source
// reader. These facts and bytes are never accepted from a provider proposal.
// Offline replay supplies a frozen source instead; neither grants read authority.
type ExperienceArtifact struct {
	Candidate ExperienceCandidate `json:"candidate"`
	Document  json.RawMessage     `json:"document"`
}

// CopyExperienceProposal creates an unsaved canonical draft from an exact
// source, without changing source bytes or repairing authority. The reader must
// fence current consent/deletion before calling this pure validation boundary.
func CopyExperienceProposal(ctx context.Context, request DecisionRequest, receipt DecisionReceipt, source ExperienceArtifact, draftID string, catalog Catalog) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !validExperienceID(draftID) || receipt.Source == nil || draftID == receipt.Source.WorkflowID || catalog.Version != request.CatalogVersion || catalog.SchemaVersion != CatalogSchemaVersion || (receipt.Provider != DecisionRulesProvider && receipt.Provider != DecisionFixtureProvider) {
		return nil, ErrExperienceSourceIncompatible
	}
	proposal := DecisionProposal{Mode: receipt.Mode, Reason: receipt.Reason, ContextRevision: receipt.ContextRevision, CatalogVersion: receipt.CatalogVersion, CandidateID: receipt.Source.CandidateID, VersionID: receipt.Source.VersionID, Edits: receipt.Edits}
	validated, err := ValidateDecision(request, proposal)
	if err != nil {
		return nil, ErrExperienceSourceIncompatible
	}
	validated.Provider = receipt.Provider
	if !reflect.DeepEqual(validated, receipt) {
		return nil, ErrExperienceSourceIncompatible
	}
	key, _ := CanonicalExperienceKey(request.Brief)
	c := source.Candidate
	if c.ID != receipt.Source.CandidateID || c.WorkflowID != receipt.Source.WorkflowID || c.VersionID != receipt.Source.VersionID || c.Version != receipt.Source.Version || c.BriefKey != key || !eligibleExperience(request, c) {
		return nil, ErrExperienceSourceUnavailable
	}
	if len(source.Document) > 2*1024*1024 {
		return nil, ErrExperienceSourceIncompatible
	}
	workflow, issues := domain.Parse(source.Document)
	if workflow == nil || len(issues) > 0 || workflow.ID != c.WorkflowID || !workflowvalidation.Validate(workflow).Valid || !BindProposal(catalog, request.Brief, workflow).Complete {
		return nil, ErrExperienceSourceIncompatible
	}
	workflow.ID = draftID
	for _, edit := range receipt.Edits {
		workflow.Name = edit.Value
	}
	if !workflowvalidation.Validate(workflow).Valid || !BindProposal(catalog, request.Brief, workflow).Complete {
		return nil, ErrExperienceSourceIncompatible
	}
	draft, err := domain.CanonicalWorkflowDocument(workflow)
	if err != nil {
		return nil, ErrExperienceSourceIncompatible
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return draft, nil
}
