package authoring

import (
	"context"

	"github.com/johnny4young/janusly/internal/store"
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

// ExperienceReader is explicitly composed at the API boundary. It resolves
// current scoped registrations; it is not a completion provider or a writer.
type ExperienceReader interface {
	Decide(context.Context, DecisionRequest, Catalog) (ExperienceSelection, error)
	Resolve(context.Context, DecisionRequest, DecisionReceipt, Catalog, string) ([]byte, error)
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
	// A draft identity CopyExperienceProposal will reject never takes the
	// exclusive consent locks or reads source graphs.
	if previous != nil && (!validExperienceID(draftID) || draftID == previous.Source.WorkflowID) {
		return ExperienceSelection{}, nil, ErrExperienceSourceIncompatible
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
		rows, err := q.FindAuthoringExperienceCandidates(stage, store.FindAuthoringExperienceCandidatesParams{OrgID: projection.OrganizationID, BriefKey: key, AsOf: projection.AsOf, Historical: false, RowLimit: maxExperienceSourceScan + 1})
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
			if row.VersionCreatedAt == nil || row.Version < 1 || compatibleExperienceSource(catalog, projection.Brief, row.WorkflowID, row.DagJson) == nil {
				continue
			}
			candidate := ExperienceCandidate{ID: row.ID, OrganizationID: row.OrgID, WorkflowID: row.WorkflowID, VersionID: row.WorkflowVersionID, Version: int(row.Version), BriefKey: row.BriefKey, PolicyVersion: row.PolicyVersion, RegisteredAt: row.RegisteredAt, VersionCreatedAt: *row.VersionCreatedAt, RetainUntil: row.RetainUntil, RevokedAt: row.RevokedAt, Readable: true, Compatible: true}
			projection.Candidates = append(projection.Candidates, candidate)
			// Only resolution copies a source; a decision keeps no graph bytes.
			if previous != nil {
				sources = append(sources, ExperienceArtifact{Candidate: candidate, Document: row.DagJson})
			}
		}
		projection.Truncated = projection.Truncated || len(projection.Candidates) > MaxExperienceCandidates
		projection.Candidates = projection.Candidates[:min(len(projection.Candidates), MaxExperienceCandidates)]
		// A brief that fits the request bound alone can overflow it once exact
		// candidates are disclosed. Completeness is then unprovable: require
		// review instead of failing the whole decision with an opaque error.
		if validateDecisionRequest(projection) != nil {
			projection.Candidates, sources = nil, nil
			projection.Truncated = true
		}
	}
	// All graph compatibility checks precede eligible top-K. Recompute retention
	// after parsing/binding too, while row and consent locks still fence mutation.
	receipt, err := ProposeDecision(stage, RulesProvider{}, projection)
	if err != nil {
		return ExperienceSelection{}, nil, err
	}
	// recheck recomputes the decision at a later instant so retention expiry
	// during parsing, binding or copying cannot admit a stale source.
	recheck := func() error {
		check := cloneDecisionRequest(projection)
		check.AsOf = r.now()
		final, err := ProposeDecision(stage, RulesProvider{}, check)
		if err != nil {
			return err
		}
		if !sameDecisionReceipt(final, receipt) {
			return ErrExperienceSourceUnavailable
		}
		return nil
	}
	if previous == nil && receipt.Source != nil {
		if err := recheck(); err != nil {
			return ExperienceSelection{}, nil, err
		}
	}
	var draft []byte
	if previous != nil {
		if !sameDecisionReceipt(*previous, receipt) {
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
		if err := recheck(); err != nil {
			return ExperienceSelection{}, nil, err
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
