package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/johnny4young/janusly/internal/aidiagnosis"
	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/store"
)

// RecoveryDiagnosisFacts is the bounded provider-free fact set shared by the
// deterministic builder and optional AI enrichment. Stable source IDs remain
// engine-only and are never serialized by AIEvidence.
type RecoveryDiagnosisFacts struct {
	Language                  string
	Message                   string
	Details                   []string
	RunID                     string
	SourceNodeID              string
	DetectorID                string
	DetectorKind              string
	Action                    string
	HasWorkflow               bool
	WorkflowSnapshotAvailable bool
	RecoveryContractAvailable bool
	AutonomyLevel             *int
	SimilarCases              aidiagnosis.SimilarCases
}

// AIEvidence projects only the closed, scrubbed shape the provider may see.
// Run, node, detector and workflow identifiers are intentionally omitted.
func (facts RecoveryDiagnosisFacts) AIEvidence() aidiagnosis.Evidence {
	return aidiagnosis.NormalizeEvidence(aidiagnosis.Evidence{
		Language: facts.Language, Message: facts.Message, Details: facts.Details,
		DetectorKind: facts.DetectorKind, Action: facts.Action,
		WorkflowSnapshotAvailable: facts.WorkflowSnapshotAvailable,
		RecoveryContractAvailable: facts.RecoveryContractAvailable,
		AutonomyLevel:             facts.AutonomyLevel, SimilarCases: facts.SimilarCases,
	})
}

// RecoveryDiagnosisHypothesis persists bounded operational explanations plus
// deterministic source references. AI may author the prose fields only; it
// never supplies references or recommended candidate kinds.
type RecoveryDiagnosisHypothesis struct {
	ID                  string                           `json:"id"`
	Cause               string                           `json:"cause"`
	Confidence          float64                          `json:"confidence"`
	Evidence            []string                         `json:"evidence"`
	CounterEvidence     []string                         `json:"counterEvidence"`
	EvidenceRefs        []domain.RecoveryCaseEvidenceRef `json:"evidenceRefs"`
	CounterEvidenceRefs []domain.RecoveryCaseEvidenceRef `json:"counterEvidenceRefs"`
}

// RecoveryDiagnosisPayload is the complete append-only diagnosis artifact.
type RecoveryDiagnosisPayload struct {
	Mode                      string                        `json:"mode"`
	Summary                   string                        `json:"summary"`
	Hypotheses                []RecoveryDiagnosisHypothesis `json:"hypotheses"`
	RecommendedCandidateKinds []string                      `json:"recommendedCandidateKinds"`
}

type DiagnoseRecoveryCaseInput struct {
	Auth             *auth.Context
	CaseID           string
	ExpectedRevision int64
	Language         string
	Enrichment       *aidiagnosis.Enrichment
}

type DiagnoseRecoveryCaseResult struct {
	Case      store.RecoveryCase
	Diagnosis store.RecoveryCaseArtifact
	Mode      string
}

// LoadRecoveryDiagnosisFacts validates tenant, revision and lifecycle before
// a caller considers spending on optional AI. DiagnoseRecoveryCase repeats
// this read immediately before its CAS write, so a race can never persist an
// enrichment against a changed case.
func (e *Engine) LoadRecoveryDiagnosisFacts(
	ctx context.Context,
	orgID, caseID string,
	expectedRevision int64,
	language string,
) (RecoveryDiagnosisFacts, error) {
	_, facts, err := e.loadRecoveryDiagnosisFacts(ctx, orgID, caseID, expectedRevision, language)
	return facts, err
}

func (e *Engine) loadRecoveryDiagnosisFacts(
	ctx context.Context,
	orgID, caseID string,
	expectedRevision int64,
	language string,
) (store.RecoveryCase, RecoveryDiagnosisFacts, error) {
	if orgID == "" || caseID == "" || expectedRevision < 1 {
		return store.RecoveryCase{}, RecoveryDiagnosisFacts{}, ErrRecoverySemanticInputInvalid
	}
	q := store.New(e.pool)
	caseRow, err := q.GetRecoveryCase(ctx, store.GetRecoveryCaseParams{OrgID: orgID, ID: caseID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return store.RecoveryCase{}, RecoveryDiagnosisFacts{}, ErrRecoveryCaseNotFound
		}
		return store.RecoveryCase{}, RecoveryDiagnosisFacts{}, err
	}
	if caseRow.Source != semanticRecoveryCaseSource || caseRow.Revision != expectedRevision ||
		(caseRow.State != "detected" && caseRow.State != "contained") {
		return store.RecoveryCase{}, RecoveryDiagnosisFacts{}, ErrRecoveryCaseConflict
	}
	facts := RecoveryDiagnosisFacts{
		Language: language, Message: caseRow.Message, Details: recoveryDiagnosisDetails(caseRow.DetailsJson),
		RunID: caseRow.RunID, SourceNodeID: caseRow.SourceNodeID, DetectorID: caseRow.DetectorID,
		DetectorKind: caseRow.DetectorKind, Action: caseRow.Action,
		HasWorkflow: caseRow.WorkflowID.Valid && strings.TrimSpace(caseRow.WorkflowID.String) != "",
	}
	if run, runErr := q.GetRun(ctx, store.GetRunParams{ID: caseRow.RunID, OrgID: orgID}); runErr == nil {
		facts.WorkflowSnapshotAvailable = true
		if workflow, _, parseErr := workflowFromRunInput(run.InputJson); parseErr == nil && workflow.Recovery != nil && workflow.Recovery.Contract != nil {
			facts.RecoveryContractAvailable = true
			profile := domain.ResolveRecoveryAutonomyProfile(workflow.Recovery.Contract, domain.RecoveryFailureClass{
				Kind: "semantic", DetectorID: caseRow.DetectorID,
			})
			facts.AutonomyLevel = profile.Level
		}
	}
	// Comparable evidence is deliberately aggregate-only and optional. A
	// query failure cannot block deterministic diagnosis or recovery.
	var workflowID any
	if facts.HasWorkflow {
		workflowID = caseRow.WorkflowID.String
	}
	_ = e.pool.QueryRow(ctx, `SELECT
		count(*)::int,
		count(*) FILTER (WHERE state = 'verified_recovered')::int,
		count(*) FILTER (WHERE state = 'recurred')::int,
		count(*) FILTER (WHERE state = 'accepted_loss')::int
		FROM recovery_cases
		WHERE org_id = $1 AND source = 'semantic_violation'
		  AND detector_id = $2 AND id <> $3
		  AND (($4::text IS NULL AND workflow_id IS NULL) OR workflow_id = $4::text)`,
		orgID, caseRow.DetectorID, caseRow.ID, workflowID,
	).Scan(&facts.SimilarCases.Total, &facts.SimilarCases.Recovered,
		&facts.SimilarCases.Recurred, &facts.SimilarCases.AcceptedLoss)
	return caseRow, facts, nil
}

// BuildRecoveryDiagnosis is pure and provider-free. An invalid internally
// constructed enrichment is ignored rather than compromising the fallback.
func BuildRecoveryDiagnosis(
	facts RecoveryDiagnosisFacts,
	enrichment *aidiagnosis.Enrichment,
) RecoveryDiagnosisPayload {
	evidence := facts.AIEvidence()
	references := []domain.RecoveryCaseEvidenceRef{
		{Kind: "run", ID: facts.RunID},
		{Kind: "run_node", ID: facts.RunID + ":" + facts.SourceNodeID},
		{Kind: "semantic_detector", ID: facts.DetectorID},
	}
	recommendedKinds := []string{"accept_loss"}
	if facts.HasWorkflow {
		recommendedKinds = []string{"repair_workflow", "adjust_detector", "accept_loss"}
	}
	if enrichment != nil {
		if normalized, err := aidiagnosis.NormalizeEnrichment(*enrichment); err == nil {
			hypotheses := make([]RecoveryDiagnosisHypothesis, 0, len(normalized.Hypotheses))
			for _, hypothesis := range normalized.Hypotheses {
				hypotheses = append(hypotheses, RecoveryDiagnosisHypothesis{
					ID: hypothesis.ID, Cause: hypothesis.Cause, Confidence: hypothesis.Confidence,
					Evidence: hypothesis.Evidence, CounterEvidence: hypothesis.CounterEvidence,
					EvidenceRefs: references, CounterEvidenceRefs: []domain.RecoveryCaseEvidenceRef{},
				})
			}
			return RecoveryDiagnosisPayload{
				Mode: "ai_enriched", Summary: normalized.Summary, Hypotheses: hypotheses,
				RecommendedCandidateKinds: recommendedKinds,
			}
		}
	}
	cause := "The source node output did not satisfy its deterministic semantic detector."
	detectorStatement := fmt.Sprintf("The %s detector requested %s handling for the source outcome.", evidence.DetectorKind, evidence.Action)
	noCounterEvidence := "No bounded contradictory execution evidence was recorded for this detector finding."
	if evidence.Language == "es" {
		cause = "La salida del nodo de origen no satisfizo su detector semántico determinista."
		detectorStatement = fmt.Sprintf("El detector %s solicitó tratamiento %s para el resultado de origen.", evidence.DetectorKind, evidence.Action)
		noCounterEvidence = "No se registró evidencia de ejecución acotada que contradiga este hallazgo del detector."
	}
	supporting := make([]string, 0, aidiagnosis.MaxStatements)
	if evidence.Message != "" {
		supporting = append(supporting, evidence.Message)
	}
	for _, detail := range evidence.Details {
		if len(supporting) >= aidiagnosis.MaxStatements-1 {
			break
		}
		supporting = append(supporting, detail)
	}
	supporting = append(supporting, detectorStatement)
	counter := []string{noCounterEvidence}
	if !evidence.WorkflowSnapshotAvailable {
		if evidence.Language == "es" {
			counter = []string{"El snapshot inmutable del flujo ya no está disponible; esto limita la confirmación del contexto contractual exacto."}
		} else {
			counter = []string{"The immutable workflow snapshot is no longer available, limiting confirmation of the exact contract context."}
		}
	} else if evidence.SimilarCases.Total == 0 {
		if evidence.Language == "es" {
			counter = []string{"No hay casos comparables retenidos que confirmen un patrón recurrente."}
		} else {
			counter = []string{"No retained comparable cases confirm a recurring pattern."}
		}
	}
	confidence := 0.65
	if evidence.WorkflowSnapshotAvailable {
		confidence = 0.75
	}
	if evidence.RecoveryContractAvailable {
		confidence = 0.85
	}
	return RecoveryDiagnosisPayload{
		Mode: "deterministic_fallback", Summary: evidence.Message,
		Hypotheses: []RecoveryDiagnosisHypothesis{{
			ID: "business_outcome_contract_violation", Cause: cause, Confidence: confidence,
			Evidence: supporting, CounterEvidence: counter,
			EvidenceRefs: references, CounterEvidenceRefs: []domain.RecoveryCaseEvidenceRef{},
		}},
		RecommendedCandidateKinds: recommendedKinds,
	}
}

// DiagnoseRecoveryCase always persists a deterministic diagnosis. Optional AI
// enrichment may replace only bounded prose; failure or absence of a provider
// cannot prevent the artifact or governed transition.
func (e *Engine) DiagnoseRecoveryCase(
	ctx context.Context,
	input DiagnoseRecoveryCaseInput,
) (DiagnoseRecoveryCaseResult, error) {
	if input.Auth == nil || input.Auth.OrgID == "" || input.Auth.UserID == "" || input.CaseID == "" || input.ExpectedRevision < 1 {
		return DiagnoseRecoveryCaseResult{}, ErrRecoverySemanticInputInvalid
	}
	caseRow, facts, err := e.loadRecoveryDiagnosisFacts(
		ctx, input.Auth.OrgID, input.CaseID, input.ExpectedRevision, input.Language,
	)
	if err != nil {
		return DiagnoseRecoveryCaseResult{}, err
	}
	diagnosis := BuildRecoveryDiagnosis(facts, input.Enrichment)
	reason := "Deterministic evidence diagnosis recorded"
	if diagnosis.Mode == "ai_enriched" {
		reason = "AI-enriched diagnosis recorded from bounded evidence"
	}
	steps := []RecoveryTransitionStep{}
	if caseRow.State == "detected" && caseRow.Action == "observe" {
		// Observe is deliberately non-blocking. Moving it through `contained`
		// would manufacture a containment claim after downstream work was allowed
		// to continue, so its governed lifecycle enters diagnosis directly.
		steps = append(steps, RecoveryTransitionStep{
			From: "detected", To: "diagnosed", Reason: reason,
		})
	} else {
		if caseRow.State == "detected" {
			steps = append(steps, RecoveryTransitionStep{
				From: "detected", To: "contained",
				Reason: "Contained before diagnosis to prevent unverified downstream effects",
			})
		}
		steps = append(steps, RecoveryTransitionStep{From: "contained", To: "diagnosed", Reason: reason})
	}
	advanced, err := e.AdvanceRecoveryCase(ctx, AdvanceRecoveryCaseInput{
		Auth: input.Auth, CaseID: input.CaseID, ExpectedRevision: input.ExpectedRevision,
		Artifacts: []RecoveryArtifactInput{{Kind: "diagnosis", Payload: diagnosis}}, Steps: steps,
		AuditAction: audit.Action("recovery.case.diagnosed"),
	})
	if err != nil {
		return DiagnoseRecoveryCaseResult{}, err
	}
	return DiagnoseRecoveryCaseResult{
		Case: advanced.Case, Diagnosis: advanced.Artifacts[0], Mode: diagnosis.Mode,
	}, nil
}

func recoveryDiagnosisDetails(raw json.RawMessage) []string {
	var value any
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil {
		return []string{}
	}
	out := make([]string, 0, aidiagnosis.MaxDetails)
	var walk func(string, any)
	walk = func(path string, current any) {
		if len(out) >= aidiagnosis.MaxDetails {
			return
		}
		switch typed := current.(type) {
		case string:
			if strings.TrimSpace(typed) != "" {
				if path != "" {
					out = append(out, path+": "+typed)
				} else {
					out = append(out, typed)
				}
			}
		case []any:
			for _, item := range typed {
				walk(path, item)
			}
		case map[string]any:
			keys := make([]string, 0, len(typed))
			for key := range typed {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			for _, key := range keys {
				next := key
				if path != "" {
					next = path + "." + key
				}
				walk(next, typed[key])
			}
		case float64, bool:
			out = append(out, strings.TrimPrefix(path+": "+fmt.Sprint(typed), ": "))
		}
	}
	walk("", value)
	return out
}
