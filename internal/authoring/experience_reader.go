package authoring

import (
	"context"
	"reflect"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/store"
	"github.com/johnny4young/janusly/internal/workflowvalidation"
)

// The source-work horizon is separate from eligible top-K. Incomplete scans
// disclose truncation and cannot select an arbitrary first source.
const maxExperienceSourceScan = MaxExperienceCandidates + 1

// ExperienceSelection is private authoring state, not an HTTP response or
// permission grant. Brief/matching facts must never be copied into telemetry.
type ExperienceSelection struct {
	Request DecisionRequest
	Receipt DecisionReceipt
}

// Decide reads only current, consented, same-tenant exact registrations. The
// caller supplies centralized read/AI authority and a current server-built
// catalog. No graph, consent bit or as-of instant comes from a model/body.
func (r *ExperienceRegistry) Decide(ctx context.Context, input DecisionRequest, catalog Catalog) (ExperienceSelection, error) {
	selection, _, err := r.selectExperience(ctx, input, catalog, nil, "")
	return selection, err
}

// Resolve re-reads current consent and all matching candidates rather than
// trusting an earlier receipt. New ambiguity, revocation, deletion, expiry or
// incompatibility invalidates the selected source; it never starts generation.
func (r *ExperienceRegistry) Resolve(ctx context.Context, input DecisionRequest, receipt DecisionReceipt, catalog Catalog, draftID string) ([]byte, error) {
	_, draft, err := r.selectExperience(ctx, input, catalog, &receipt, draftID)
	return draft, err
}

func (r *ExperienceRegistry) selectExperience(ctx context.Context, input DecisionRequest, catalog Catalog, previous *DecisionReceipt, draftID string) (ExperienceSelection, []byte, error) {
	if err := ctx.Err(); err != nil {
		return ExperienceSelection{}, nil, err
	}
	if len(input.Candidates) != 0 || input.Truncated || catalog.SchemaVersion != CatalogSchemaVersion || catalog.Version != input.CatalogVersion {
		return ExperienceSelection{}, nil, ErrExperienceBriefInvalid
	}
	projection := cloneDecisionRequest(input)
	projection.AsOf = r.now()
	projection.Consent = false
	if validateDecisionRequest(projection) != nil {
		return ExperienceSelection{}, nil, ErrExperienceBriefInvalid
	}
	if previous != nil && (previous.Source == nil || previous.Provider != DecisionRulesProvider || (previous.Mode != DecisionReuse && previous.Mode != DecisionAdapt)) {
		return ExperienceSelection{}, nil, ErrExperienceSourceUnavailable
	}
	stage, cancel := context.WithTimeout(ctx, DecisionStageTimeout)
	defer cancel()
	tx, q, _, err := r.consentTx(stage, input.OrganizationID, previous != nil)
	if err != nil {
		if stage.Err() != nil {
			return ExperienceSelection{}, nil, stage.Err()
		}
		return ExperienceSelection{}, nil, err
	}
	defer rollbackExperienceTx(stage, tx)
	projection.Consent = true
	sources := []ExperienceArtifact{}
	if projection.Complete && !projection.CanonicalRecipe && supportedDescriptiveEdits(projection.Edits) {
		key, _ := CanonicalExperienceKey(projection.Brief)
		rows, err := q.FindAuthoringExperienceCandidates(stage, store.FindAuthoringExperienceCandidatesParams{OrgID: projection.OrganizationID, BriefKey: key, AsOf: projection.AsOf, Historical: false})
		if err != nil {
			if stage.Err() != nil {
				return ExperienceSelection{}, nil, stage.Err()
			}
			return ExperienceSelection{}, nil, err
		}
		projection.Truncated = len(rows) > maxExperienceSourceScan
		for _, row := range rows[:min(len(rows), maxExperienceSourceScan)] {
			if err := stage.Err(); err != nil {
				return ExperienceSelection{}, nil, err
			}
			workflow, issues := domain.Parse(row.DagJson)
			if row.VersionCreatedAt == nil || workflow == nil || len(issues) > 0 || row.Version < 1 || workflow.ID != row.WorkflowID || !workflowvalidation.Validate(workflow).Valid || !BindProposal(catalog, projection.Brief, workflow).Complete {
				continue
			}
			candidate := ExperienceCandidate{ID: row.ID, OrganizationID: row.OrgID, WorkflowID: row.WorkflowID, VersionID: row.WorkflowVersionID, Version: int(row.Version), BriefKey: row.BriefKey, PolicyVersion: row.PolicyVersion, RegisteredAt: row.RegisteredAt, VersionCreatedAt: *row.VersionCreatedAt, RetainUntil: row.RetainUntil, RevokedAt: row.RevokedAt, Readable: true, Compatible: true}
			projection.Candidates = append(projection.Candidates, candidate)
			sources = append(sources, ExperienceArtifact{Candidate: candidate, Document: row.DagJson})
		}
		projection.Truncated = projection.Truncated || len(projection.Candidates) > MaxExperienceCandidates
		projection.Candidates = projection.Candidates[:min(len(projection.Candidates), MaxExperienceCandidates)]
	}
	// All graph compatibility checks precede eligible top-K. Recompute retention
	// after parsing/binding too, while row and consent locks still fence mutation.
	receipt, err := ProposeDecision(stage, RulesProvider{}, projection)
	if err != nil {
		return ExperienceSelection{}, nil, err
	}
	if receipt.Source != nil {
		check := cloneDecisionRequest(projection)
		check.AsOf = r.now()
		final, err := ProposeDecision(stage, RulesProvider{}, check)
		if err != nil {
			return ExperienceSelection{}, nil, err
		}
		if !reflect.DeepEqual(final, receipt) {
			return ExperienceSelection{}, nil, ErrExperienceSourceUnavailable
		}
	}
	var draft []byte
	if previous != nil {
		if !reflect.DeepEqual(*previous, receipt) {
			return ExperienceSelection{}, nil, ErrExperienceSourceUnavailable
		}
		var source *ExperienceArtifact
		for i := range sources {
			if sources[i].Candidate.ID == receipt.Source.CandidateID {
				source = &sources[i]
				break
			}
		}
		if source == nil {
			return ExperienceSelection{}, nil, ErrExperienceSourceUnavailable
		}
		draft, err = CopyExperienceProposal(stage, projection, receipt, *source, draftID, catalog)
		if err != nil {
			return ExperienceSelection{}, nil, err
		}
		check := cloneDecisionRequest(projection)
		check.AsOf = r.now()
		final, err := ProposeDecision(stage, RulesProvider{}, check)
		if err != nil {
			return ExperienceSelection{}, nil, err
		}
		if !reflect.DeepEqual(final, receipt) {
			return ExperienceSelection{}, nil, ErrExperienceSourceUnavailable
		}
	}
	if err := stage.Err(); err != nil {
		return ExperienceSelection{}, nil, err
	}
	if err := tx.Commit(stage); err != nil {
		if stage.Err() != nil {
			return ExperienceSelection{}, nil, stage.Err()
		}
		return ExperienceSelection{}, nil, err
	}
	if err := ctx.Err(); err != nil {
		return ExperienceSelection{}, nil, err
	}
	return ExperienceSelection{Request: projection, Receipt: receipt}, draft, nil
}
