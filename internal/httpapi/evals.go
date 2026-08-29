// Eval datasets + experiment harness routes (reference
// eval-datasets-routes.ts + experiments-routes.ts). Datasets snapshot the
// OPTED-IN regression bed: a recovery_feedback row is pulled only when
// `accepted AND eval_consent` — no consent, not eligible, full stop.
// Secret shapes scrub at write time AND again at read/export time
// (defense in depth). Experiments compare two flattened arms over a
// dataset and persist a recommendation-only summary — no production
// mutation ever rides a run.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/ai"
	"github.com/johnny4young/janusly/internal/aibudget"
	"github.com/johnny4young/janusly/internal/aiconfig"
	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/experiment"
	"github.com/johnny4young/janusly/internal/prompts"
	"github.com/johnny4young/janusly/internal/ratelimit"
	"github.com/johnny4young/janusly/internal/signature"
	"github.com/johnny4young/janusly/internal/store"
)

// experimentGuardedClient applies governance to every logical model call,
// including LLM-judge calls hidden inside the scorer. The evaluation client
// beneath it has SDK retries disabled, preserving the admitted call ceiling.
type experimentGuardedClient struct {
	inner    ai.Client
	generate func(context.Context, ai.GenerateTextInput) (*ai.GenerateTextResult, *ai.AIError)
}

func (c experimentGuardedClient) Configured() bool {
	return c.inner != nil && c.inner.Configured()
}

func (c experimentGuardedClient) GenerateText(ctx context.Context, input ai.GenerateTextInput) (*ai.GenerateTextResult, *ai.AIError) {
	return c.generate(ctx, input)
}

func parseExperimentPromptRef(ref string) (string, int) {
	name := strings.TrimSpace(ref)
	version := 0
	if at := strings.LastIndexByte(name, '@'); at > 0 && at < len(name)-1 {
		if parsed, err := strconv.Atoi(name[at+1:]); err == nil && parsed > 0 {
			name, version = name[:at], parsed
		}
	}
	return name, version
}

func evalDatasetView(row store.EvalDataset) map[string]any {
	return map[string]any{
		"id": row.ID, "name": row.Name, "description": row.Description,
		"workflowId": textOrNull(row.WorkflowID), "exampleCount": row.ExampleCount,
		"retentionDays": int4OrNull(row.RetentionDays),
		"createdBy":     textOrNull(row.CreatedBy), "createdAt": isoMillis(row.CreatedAt),
	}
}

// evalExampleView re-scrubs at read time — defense in depth over the
// write-time scrub.
func evalExampleView(row store.EvalExample) map[string]any {
	return map[string]any{
		"id": row.ID, "workflowId": textOrNull(row.WorkflowID),
		"deadLetterId":          textOrNull(row.DeadLetterID),
		"failureSignature":      row.FailureSignature,
		"inputContext":          signature.ScrubSecretShapes(row.InputContext),
		"expectedApproachLabel": row.ExpectedApproachLabel,
		"accepted":              row.Accepted, "suggestionMode": row.SuggestionMode,
	}
}

func (s *V1Server) mountEvalRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /eval/datasets", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		rows, err := store.New(s.pool).ListEvalDatasets(r.Context(), rc.orgID)
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		views := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			views = append(views, evalDatasetView(row))
		}
		writeUnversioned(w, opOK(map[string]any{"datasets": views}))
	}))

	mux.HandleFunc("POST /eval/datasets", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		var body struct {
			Name          string `json:"name"`
			Description   string `json:"description"`
			WorkflowID    string `json:"workflowId"`
			RetentionDays int    `json:"retentionDays"`
		}
		if err := decodeBody(r, &body); err != nil || strings.TrimSpace(body.Name) == "" ||
			len(body.Name) > 120 || len(body.Description) > 2000 ||
			body.RetentionDays < 0 || body.RetentionDays > 3650 {
			writeUnversioned(w, opError(http.StatusBadRequest, "eval_dataset_name_required", "Invalid eval dataset body", nil))
			return
		}
		body.Name = strings.TrimSpace(body.Name)
		q := store.New(s.pool)
		if _, err := q.FindEvalDatasetByName(r.Context(), store.FindEvalDatasetByNameParams{
			OrgID: rc.orgID, Name: body.Name,
		}); err == nil {
			writeUnversioned(w, opError(http.StatusConflict, "eval_dataset_name_exists",
				"An eval dataset with that name already exists", nil))
			return
		}
		// The opt-in gate: accepted AND eval_consent, nothing else.
		eligible, err := q.QueryEligibleFeedbackForEval(r.Context(), store.QueryEligibleFeedbackForEvalParams{
			OrgID:      rc.orgID,
			WorkflowID: pgtype.Text{String: body.WorkflowID, Valid: body.WorkflowID != ""},
		})
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		datasetID := s.newID()
		tx, err := s.pool.Begin(r.Context())
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		defer func() { _ = tx.Rollback(r.Context()) }()
		txq := store.New(tx)
		if err := txq.InsertEvalDataset(r.Context(), store.InsertEvalDatasetParams{
			ID: datasetID, OrgID: rc.orgID, Name: body.Name,
			Description:   body.Description,
			WorkflowID:    pgtype.Text{String: body.WorkflowID, Valid: body.WorkflowID != ""},
			ExampleCount:  int32(len(eligible)),
			RetentionDays: pgtype.Int4{Int32: int32(body.RetentionDays), Valid: body.RetentionDays > 0},
			CreatedBy:     pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		}); err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		for _, row := range eligible {
			// The failure signature derives from the dead letter's error;
			// the operator comment is the captured input context — scrubbed
			// at write time.
			failureSignature := ""
			if len(row.ErrorJson) > 0 {
				failureSignature = signature.NormalizeJSON(row.ErrorJson, signature.Context{}).Signature
			}
			comment := ""
			if row.Comment.Valid {
				comment = signature.ScrubSecretShapes(row.Comment.String)
				if len(comment) > 4000 {
					comment = comment[:4000]
				}
			}
			if err := txq.InsertEvalExample(r.Context(), store.InsertEvalExampleParams{
				ID: s.newID(), OrgID: rc.orgID, DatasetID: datasetID,
				SourceFeedbackID: row.FeedbackID,
				WorkflowID:       pgtype.Text{String: row.WorkflowID, Valid: row.WorkflowID != ""},
				DeadLetterID:     pgtype.Text{String: row.DeadLetterID, Valid: row.DeadLetterID != ""},
				FailureSignature: failureSignature, InputContext: comment,
				ExpectedApproachLabel: row.ApproachLabel, Accepted: true,
				SuggestionMode: row.SuggestionMode,
			}); err != nil {
				writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
				return
			}
		}
		if err := tx.Commit(r.Context()); err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		dataset, _ := q.GetEvalDataset(r.Context(), store.GetEvalDatasetParams{OrgID: rc.orgID, ID: datasetID})
		audit.Write(r.Context(), s.pool, rc.authContext, "eval.dataset.created", audit.Options{
			TargetType: "eval-dataset", TargetID: datasetID,
			Metadata: map[string]any{"name": body.Name, "workflowId": body.WorkflowID, "exampleCount": len(eligible)},
		})
		writeUnversioned(w, opResult{status: http.StatusCreated, data: map[string]any{"dataset": evalDatasetView(dataset)}})
	}))

	mux.HandleFunc("GET /eval/datasets/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		q := store.New(s.pool)
		dataset, err := q.GetEvalDataset(r.Context(), store.GetEvalDatasetParams{OrgID: rc.orgID, ID: r.PathValue("id")})
		if err != nil {
			writeUnversioned(w, opError(http.StatusNotFound, "eval_dataset_not_found", "Eval dataset not found", nil))
			return
		}
		rows, _ := q.ListEvalExamples(r.Context(), store.ListEvalExamplesParams{OrgID: rc.orgID, DatasetID: dataset.ID})
		examples := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			examples = append(examples, evalExampleView(row))
		}
		writeUnversioned(w, opOK(map[string]any{"dataset": evalDatasetView(dataset), "examples": examples}))
	}))

	mux.HandleFunc("GET /eval/datasets/{id}/export", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		format := strings.ToLower(r.URL.Query().Get("format"))
		if format == "" {
			format = "jsonl"
		}
		if format != "jsonl" && format != "json" {
			writeUnversioned(w, opError(http.StatusBadRequest, "eval_dataset_unknown_format",
				"Unknown format. Use \"jsonl\" or \"json\".", nil))
			return
		}
		q := store.New(s.pool)
		dataset, err := q.GetEvalDataset(r.Context(), store.GetEvalDatasetParams{OrgID: rc.orgID, ID: r.PathValue("id")})
		if err != nil {
			writeUnversioned(w, opError(http.StatusNotFound, "eval_dataset_not_found", "Eval dataset not found", nil))
			return
		}
		rows, _ := q.ListEvalExamples(r.Context(), store.ListEvalExamplesParams{OrgID: rc.orgID, DatasetID: dataset.ID})
		examples := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			examples = append(examples, evalExampleView(row))
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "eval.dataset.exported", audit.Options{
			TargetType: "eval-dataset", TargetID: dataset.ID,
			Metadata: map[string]any{"name": dataset.Name, "format": format, "exampleCount": len(examples)},
		})
		filename := fmt.Sprintf("evals-%s-examples-%d.%s", dataset.Name, len(examples), format)
		if format == "json" {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
			_ = json.NewEncoder(w).Encode(map[string]any{"dataset": evalDatasetView(dataset), "examples": examples})
			return
		}
		w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
		encoder := json.NewEncoder(w)
		for _, example := range examples {
			_ = encoder.Encode(example)
		}
	}))

	mux.HandleFunc("DELETE /eval/datasets/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		q := store.New(s.pool)
		id := r.PathValue("id")
		_ = q.DeleteEvalExamplesForDataset(r.Context(), store.DeleteEvalExamplesForDatasetParams{
			OrgID: rc.orgID, DatasetID: id,
		})
		deleted, err := q.DeleteEvalDataset(r.Context(), store.DeleteEvalDatasetParams{OrgID: rc.orgID, ID: id})
		if err != nil || deleted == 0 {
			writeUnversioned(w, opError(http.StatusNotFound, "eval_dataset_not_found", "Eval dataset not found", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "eval.dataset.deleted", audit.Options{
			TargetType: "eval-dataset", TargetID: id,
		})
		writeUnversioned(w, opOK(map[string]any{"ok": true}))
	}))

	/* experiments */
	mux.HandleFunc("GET /experiments", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		rows, err := store.New(s.pool).ListExperiments(r.Context(), rc.orgID)
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		views := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			views = append(views, experimentView(row))
		}
		writeUnversioned(w, opOK(map[string]any{
			"experiments": views,
			"limits": map[string]any{
				"maxProviderCalls":  experiment.MaxProviderCallsPerRun,
				"maxArmOutputUnits": experiment.MaxArmOutputUnits,
			},
		}))
	}))

	mux.HandleFunc("GET /experiments/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		row, err := store.New(s.pool).GetExperiment(r.Context(), store.GetExperimentParams{
			OrgID: rc.orgID, ID: r.PathValue("id"),
		})
		if err != nil {
			writeUnversioned(w, opError(http.StatusNotFound, "experiment_not_found", "Experiment not found", nil))
			return
		}
		writeUnversioned(w, opOK(map[string]any{"experiment": experimentView(row)}))
	}))

	mux.HandleFunc("POST /experiments/run", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		var body struct {
			Name          string `json:"name"`
			Kind          string `json:"kind"`
			ControlRef    string `json:"controlRef"`
			CandidateRef  string `json:"candidateRef"`
			EvalDatasetID string `json:"evalDatasetId"`
			ScorerKind    string `json:"scorerKind"`
		}
		if err := decodeBody(r, &body); err != nil || strings.TrimSpace(body.Name) == "" ||
			len(body.Name) > 120 || body.EvalDatasetID == "" ||
			body.ControlRef == "" || body.CandidateRef == "" ||
			len(body.ControlRef) > 256 || len(body.CandidateRef) > 256 ||
			(body.Kind != "model" && body.Kind != "prompt") {
			writeUnversioned(w, opError(http.StatusBadRequest, "experiment_invalid_body",
				"name, kind (model|prompt), controlRef, candidateRef, and evalDatasetId are required", nil))
			return
		}
		if body.ScorerKind == "" {
			body.ScorerKind = "string_equality"
		}
		if !experiment.ScorerKinds[body.ScorerKind] {
			writeUnversioned(w, opError(http.StatusBadRequest, "experiment_invalid_body", "unknown scorerKind", nil))
			return
		}
		ctx := r.Context()
		q := store.New(s.pool)
		dataset, err := q.GetEvalDataset(ctx, store.GetEvalDatasetParams{OrgID: rc.orgID, ID: body.EvalDatasetID})
		if err != nil {
			writeUnversioned(w, opError(http.StatusNotFound, "eval_dataset_not_found", "Eval dataset not found", nil))
			return
		}
		rows, _ := q.ListEvalExamples(ctx, store.ListEvalExamplesParams{OrgID: rc.orgID, DatasetID: dataset.ID})
		if len(rows) == 0 {
			writeUnversioned(w, opError(http.StatusUnprocessableEntity, "experiment_dataset_empty",
				"The evaluation dataset has no examples", nil))
			return
		}
		providerCallEstimate := experiment.EstimateProviderCalls(len(rows), body.ScorerKind)
		if providerCallEstimate > experiment.MaxProviderCallsPerRun {
			writeUnversioned(w, opError(http.StatusUnprocessableEntity, "experiment_call_limit_exceeded",
				"The experiment plan exceeds the provider call limit", map[string]any{
					"providerCallEstimate": providerCallEstimate,
					"maxProviderCalls":     experiment.MaxProviderCallsPerRun,
				}))
			return
		}
		examples := make([]experiment.Example, 0, len(rows))
		for _, row := range rows {
			examples = append(examples, experiment.Example{
				Input:    signature.ScrubSecretShapes(row.InputContext),
				Expected: row.ExpectedApproachLabel,
			})
		}
		client, settings := aiconfig.ResolveForEvaluation(ctx, s.pool, rc.orgID)

		// kind=model: refs are model hints. kind=prompt: refs resolve through
		// the tenant's PromptOps registry, including an optional name@version.
		// Literal refs are deliberately not sent to the provider as fake prompts.
		controlArm, candidateArm := experiment.Arm{}, experiment.Arm{}
		if body.Kind == "model" {
			controlArm.ModelHint, candidateArm.ModelHint = body.ControlRef, body.CandidateRef
		} else {
			controlName, controlVersion := parseExperimentPromptRef(body.ControlRef)
			candidateName, candidateVersion := parseExperimentPromptRef(body.CandidateRef)
			controlPrompt, controlErr := prompts.ResolveTemplate(ctx, s.pool, rc.orgID, controlName, controlVersion, nil)
			candidatePrompt, candidateErr := prompts.ResolveTemplate(ctx, s.pool, rc.orgID, candidateName, candidateVersion, nil)
			if controlErr != nil || candidateErr != nil {
				writeUnversioned(w, opError(http.StatusUnprocessableEntity, "experiment_prompt_ref_invalid",
					"Control and candidate must reference resolvable PromptOps prompts", nil))
				return
			}
			if settings.PromptMaxChars > 0 &&
				(len(controlPrompt) > settings.PromptMaxChars || len(candidatePrompt) > settings.PromptMaxChars) {
				writeUnversioned(w, opError(http.StatusRequestEntityTooLarge, "experiment_prompt_too_long",
					"Resolved experiment prompt exceeds the tenant AI prompt limit",
					map[string]any{"maxChars": settings.PromptMaxChars}))
				return
			}
			controlArm.SystemPrompt, candidateArm.SystemPrompt = controlPrompt, candidatePrompt
		}

		gate := aibudget.Gate(ctx, s.pool, rc.orgID, rc.userID, "experiment.run.call")
		if !gate.Allowed {
			writeUnversioned(w, opResult{status: http.StatusPaymentRequired, data: map[string]any{
				"error": "budget_exceeded", "code": "budget_exceeded",
				"params": map[string]any{
					"monthlyUsdSpent": gate.MonthlyUsdSpent, "monthlyUsdLimit": gate.MonthlyUsdLimit,
					"policy": gate.Policy, "warningPercent": gate.WarningPercent,
				},
				"budget": gate,
			}})
			return
		}

		experimentID := s.newID()
		if err := q.InsertExperiment(ctx, store.InsertExperimentParams{
			ID: experimentID, OrgID: rc.orgID, Name: strings.TrimSpace(body.Name),
			Kind: body.Kind, ControlRef: body.ControlRef, CandidateRef: body.CandidateRef,
			EvalDatasetID: dataset.ID, ScorerKind: body.ScorerKind,
			CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		}); err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(ctx, s.pool, rc.authContext, "experiment.run.started", audit.Options{
			TargetType: "experiment", TargetID: experimentID,
			Metadata: map[string]any{
				"kind": body.Kind, "scorerKind": body.ScorerKind, "exampleCount": len(examples),
				"providerCallEstimate": providerCallEstimate,
				"maxProviderCalls":     experiment.MaxProviderCallsPerRun,
			},
		})

		guardedClient := experimentGuardedClient{
			inner: client,
			generate: func(callCtx context.Context, input ai.GenerateTextInput) (*ai.GenerateTextResult, *ai.AIError) {
				if limitErr := s.limiter.Enforce(callCtx, rc.orgID, ratelimit.Options{
					Name: "ai", Max: settings.RateLimitPerMin, Window: time.Minute,
				}); limitErr != nil {
					return nil, &ai.AIError{Class: "rate_limit", Message: limitErr.Error()}
				}
				return aibudget.GuardedGenerateText(callCtx, s.pool, client, rc.userID,
					"experiment.run.call", input)
			},
		}
		summary := experiment.Run(ctx, guardedClient, body.ScorerKind, controlArm, candidateArm, examples,
			ai.CallContext{OrgID: rc.orgID, UserID: rc.userID}, nil)
		summaryJSON, _ := json.Marshal(summary)
		if _, err := q.CompleteExperiment(ctx, store.CompleteExperimentParams{
			OrgID: rc.orgID, ID: experimentID, Status: "completed", SummaryJson: summaryJSON,
		}); err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(ctx, s.pool, rc.authContext, "experiment.run.completed", audit.Options{
			TargetType: "experiment", TargetID: experimentID,
			Metadata: map[string]any{
				"recommendation": summary.Recommendation, "scoreDelta": summary.ScoreDelta,
				"exampleCount": summary.ExampleCount,
			},
		})
		if summary.Recommendation == "promote_candidate" {
			audit.Write(ctx, s.pool, rc.authContext, "experiment.run.promotion_suggested", audit.Options{
				TargetType: "experiment", TargetID: experimentID,
				Metadata: map[string]any{"scoreDelta": summary.ScoreDelta},
			})
		}
		completed, err := q.GetExperiment(ctx, store.GetExperimentParams{OrgID: rc.orgID, ID: experimentID})
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		writeUnversioned(w, opOK(map[string]any{
			"experimentId": experimentID,
			"experiment":   experimentView(completed),
			"summary":      summary,
			"plan": map[string]any{
				"providerCallEstimate": providerCallEstimate,
				"maxProviderCalls":     experiment.MaxProviderCallsPerRun,
				"maxArmOutputUnits":    experiment.MaxArmOutputUnits,
			},
		}))
	}))
}

func experimentView(row store.Experiment) map[string]any {
	var summary any
	_ = json.Unmarshal(row.SummaryJson, &summary)
	return map[string]any{
		"id": row.ID, "name": row.Name, "kind": row.Kind,
		"controlRef": row.ControlRef, "candidateRef": row.CandidateRef,
		"evalDatasetId": row.EvalDatasetID, "scorerKind": row.ScorerKind,
		"status": row.Status, "summary": summary,
		"createdBy": textOrNull(row.CreatedBy), "createdAt": isoMillis(row.CreatedAt),
		"completedAt": timeOrNull(row.CompletedAt),
	}
}

var _ = errors.Is
var _ = pgx.ErrNoRows
