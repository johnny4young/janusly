package authoring

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/johnny4young/janusly/internal/aiguidance"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/memorypolicy"
	"github.com/johnny4young/janusly/internal/orgconfig"
	"github.com/johnny4young/janusly/internal/store"
	"github.com/johnny4young/janusly/internal/workflowvalidation"
)

var (
	ErrExperienceDisabled           = errors.New("authoring experience consent unavailable")
	ErrExperienceBriefInvalid       = errors.New("invalid authoring experience registration")
	ErrExperienceSourceUnavailable  = errors.New("authoring experience source unavailable")
	ErrExperienceSourceIncompatible = errors.New("authoring experience source incompatible")
)

// ExperienceRegistration is supplied by a scoped, authorized caller. Catalog
// is a current server-built projection, never a body field or memory record.
type ExperienceRegistration struct {
	ID, OrganizationID, ActorID, WorkflowID, VersionID string
	Brief                                              IntentBrief
	Catalog                                            Catalog
}

// ExperienceRecord deliberately excludes the matching brief, key and source
// graph. Registration is eligibility, never evidence of a successful effect.
type ExperienceRecord struct {
	ID              string    `json:"id"`
	WorkflowID      string    `json:"workflowId"`
	VersionID       string    `json:"versionId"`
	Version         int32     `json:"version"`
	PolicyVersion   string    `json:"policyVersion"`
	RegisteredAt    time.Time `json:"registeredAt"`
	RetainUntil     time.Time `json:"retainUntil"`
	OutcomeEvidence string    `json:"outcomeEvidence"`
}

type ExperienceList struct {
	Entries   []ExperienceRecord `json:"entries"`
	Truncated bool               `json:"truncated"`
}

// ExperienceRegistry owns explicit, immutable registrations, not generation
// or execution. It does not call an embedding/completion provider or save a DAG.
type ExperienceRegistry struct {
	Pool    *pgxpool.Pool
	Enabled bool
	Now     func() time.Time
}

func (r *ExperienceRegistry) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

func validExperienceID(value string) bool {
	return value != "" && len(value) <= 128 && utf8.ValidString(value) && strings.TrimSpace(value) == value &&
		!strings.ContainsFunc(value, func(r rune) bool { return unicode.IsControl(r) || unicode.Is(unicode.Cf, r) })
}

func validateExperienceRegistration(input ExperienceRegistration) (string, []byte, error) {
	for _, id := range []string{input.ID, input.OrganizationID, input.ActorID, input.WorkflowID, input.VersionID} {
		if !validExperienceID(id) {
			return "", nil, ErrExperienceBriefInvalid
		}
	}
	key, err := CanonicalExperienceKey(input.Brief)
	if err != nil || input.Brief.Version != "1" {
		return "", nil, ErrExperienceBriefInvalid
	}
	compiled, err := CompileBrief(CompileBriefRequest{Brief: input.Brief})
	if err != nil || !compiled.Complete {
		return "", nil, ErrExperienceBriefInvalid
	}
	normalizedKey, err := CanonicalExperienceKey(compiled.Brief)
	if err != nil || key != normalizedKey {
		return "", nil, ErrExperienceBriefInvalid
	}
	values := []string{input.Brief.Version, input.Brief.Objective, input.Brief.Trigger, input.Brief.ExpectedOutcome, input.Brief.FailurePolicy, input.Brief.Language}
	for _, list := range [][]string{input.Brief.Inputs, input.Brief.ExternalEffects, input.Brief.Approvals, input.Brief.Examples} {
		values = append(values, list...)
	}
	if slices.ContainsFunc(values, aiguidance.ContainsGuidanceSecret) {
		return "", nil, ErrExperienceBriefInvalid
	}
	// Reject secret-shaped or lossy input instead of redacting constraints into
	// the same key as another intent. The stored brief is already safe and exact.
	raw, err := json.Marshal(input.Brief)
	if err != nil {
		return "", nil, ErrExperienceBriefInvalid
	}
	return key, raw, nil
}

func experienceConsentDays(values map[string]json.RawMessage) (int, error) {
	normalized := map[string]any{}
	for _, key := range []string{"ai.authoringExperienceEnabled", "memory.enabled", "memory.allowedKinds"} {
		var value any
		if json.Unmarshal(values[key], &value) != nil {
			return 0, ErrExperienceDisabled
		}
		v, err := orgconfig.Normalize(orgconfig.Get(key), value)
		if err != nil {
			return 0, ErrExperienceDisabled
		}
		normalized[key] = v
	}
	if normalized["ai.authoringExperienceEnabled"] != true || normalized["memory.enabled"] != true {
		return 0, ErrExperienceDisabled
	}
	kinds, _ := normalized["memory.allowedKinds"].(string)
	if !slices.ContainsFunc(strings.Split(kinds, ","), func(kind string) bool { return strings.TrimSpace(kind) == "workflow_vector" }) {
		return 0, ErrExperienceDisabled
	}
	days, _ := memorypolicy.DefaultRetentionDays("workflow_vector")
	if raw, exists := values["memory.retentionDaysByKind"]; exists {
		var value any
		if json.Unmarshal(raw, &value) != nil {
			return 0, ErrExperienceDisabled
		}
		normalized, err := orgconfig.Normalize(orgconfig.Get("memory.retentionDaysByKind"), value)
		if err != nil {
			return 0, ErrExperienceDisabled
		}
		text, _ := normalized.(string)
		if text != "" {
			var overrides map[string]int
			if json.Unmarshal([]byte(text), &overrides) != nil {
				return 0, ErrExperienceDisabled
			}
			if override, ok := overrides["workflow_vector"]; ok {
				days = override
			}
		}
	}
	return days, nil
}

func rollbackExperienceTx(ctx context.Context, tx pgx.Tx) {
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_ = tx.Rollback(cleanup)
}

func (r *ExperienceRegistry) consentTx(ctx context.Context, orgID string) (pgx.Tx, *store.Queries, int, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, 0, err
	}
	if !r.Enabled || os.Getenv("JANUSLY_MEMORY_ENABLED") != "true" {
		return nil, nil, 0, ErrExperienceDisabled
	}
	if !validExperienceID(orgID) || r.Pool == nil {
		return nil, nil, 0, ErrExperienceBriefInvalid
	}
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return nil, nil, 0, err
	}
	q := store.New(tx)
	rows, err := q.LockAuthoringExperienceConsent(ctx, orgID)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, nil, 0, err
	}
	values := make(map[string]json.RawMessage, len(rows))
	for _, row := range rows {
		values[row.Key] = row.ValueJson
	}
	days, err := experienceConsentDays(values)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, nil, 0, err
	}
	return tx, q, days, nil
}

// Register locks consent before the immutable source and insertion. Config
// revocation cannot miss a newly admitted row; duplicate explicit requests
// retain the original identity and deadline, never extend consent silently.
func (r *ExperienceRegistry) Register(ctx context.Context, input ExperienceRegistration) (ExperienceRecord, error) {
	key, raw, err := validateExperienceRegistration(input)
	if err != nil {
		return ExperienceRecord{}, err
	}
	tx, q, days, err := r.consentTx(ctx, input.OrganizationID)
	if err != nil {
		return ExperienceRecord{}, err
	}
	defer rollbackExperienceTx(ctx, tx)
	now := r.now()
	source, err := q.GetAuthoringExperienceVersion(ctx, store.GetAuthoringExperienceVersionParams{OrgID: input.OrganizationID, WorkflowID: input.WorkflowID, ID: input.VersionID, AsOf: now})
	if errors.Is(err, pgx.ErrNoRows) {
		return ExperienceRecord{}, ErrExperienceSourceUnavailable
	}
	if err != nil {
		return ExperienceRecord{}, err
	}
	workflow, issues := domain.Parse(source.DagJson)
	if workflow == nil || len(issues) > 0 || source.Version < 1 || workflow.ID != input.WorkflowID || !workflowvalidation.Validate(workflow).Valid || !BindProposal(input.Catalog, input.Brief, workflow).Complete {
		return ExperienceRecord{}, ErrExperienceSourceIncompatible
	}
	if err := q.DeleteExpiredAuthoringExperienceSource(ctx, store.DeleteExpiredAuthoringExperienceSourceParams{OrgID: input.OrganizationID, WorkflowID: input.WorkflowID, WorkflowVersionID: input.VersionID, BriefKey: key, AsOf: now}); err != nil {
		return ExperienceRecord{}, err
	}
	row, err := q.InsertAuthoringExperience(ctx, store.InsertAuthoringExperienceParams{ID: input.ID, OrgID: input.OrganizationID, WorkflowID: input.WorkflowID, WorkflowVersionID: input.VersionID, BriefKey: key, BriefJson: raw, PolicyVersion: AuthoringExperiencePolicyVersion, RegisteredAt: now, RetainUntil: now.AddDate(0, 0, days), CreatedBy: input.ActorID})
	if errors.Is(err, pgx.ErrNoRows) {
		return ExperienceRecord{}, ErrExperienceBriefInvalid
	}
	if err != nil {
		return ExperienceRecord{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ExperienceRecord{}, err
	}
	return ExperienceRecord{ID: row.ID, WorkflowID: row.WorkflowID, VersionID: row.WorkflowVersionID, Version: source.Version, PolicyVersion: row.PolicyVersion, RegisteredAt: row.RegisteredAt, RetainUntil: row.RetainUntil, OutcomeEvidence: "unknown"}, nil
}

// List exposes only bounded provenance for a requested same-tenant workflow.
// All availability predicates precede the stable top-K and sentinel.
func (r *ExperienceRegistry) List(ctx context.Context, orgID, workflowID string) (ExperienceList, error) {
	if !validExperienceID(workflowID) {
		return ExperienceList{}, ErrExperienceBriefInvalid
	}
	tx, q, _, err := r.consentTx(ctx, orgID)
	if err != nil {
		return ExperienceList{}, err
	}
	defer rollbackExperienceTx(ctx, tx)
	rows, err := q.ListAuthoringExperiences(ctx, store.ListAuthoringExperiencesParams{OrgID: orgID, WorkflowID: workflowID, AsOf: r.now(), RowLimit: MaxExperienceCandidates + 1})
	if err != nil {
		return ExperienceList{}, err
	}
	result := ExperienceList{Entries: []ExperienceRecord{}, Truncated: len(rows) > MaxExperienceCandidates}
	for _, row := range rows[:min(len(rows), MaxExperienceCandidates)] {
		result.Entries = append(result.Entries, ExperienceRecord{ID: row.ID, WorkflowID: row.WorkflowID, VersionID: row.WorkflowVersionID, Version: row.Version, PolicyVersion: row.PolicyVersion, RegisteredAt: row.RegisteredAt, RetainUntil: row.RetainUntil, OutcomeEvidence: "unknown"})
	}
	if err := tx.Commit(ctx); err != nil {
		return ExperienceList{}, err
	}
	return result, nil
}

// Revoke remains available after process or tenant consent is disabled so an
// authorized operator can always withdraw a same-tenant registration.
func (r *ExperienceRegistry) Revoke(ctx context.Context, orgID, id string) (bool, error) {
	if !validExperienceID(orgID) || !validExperienceID(id) || r.Pool == nil {
		return false, ErrExperienceBriefInvalid
	}
	count, err := store.New(r.Pool).RevokeAuthoringExperience(ctx, store.RevokeAuthoringExperienceParams{OrgID: orgID, ID: id, AsOf: r.now()})
	return count > 0, err
}
