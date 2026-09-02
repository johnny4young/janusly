// Package runstart owns the transport-neutral admission path for an external
// run start. HTTP and MCP must use this service so rollout choice, readiness,
// pause state, exact-version binding, and tenant saved-only policy cannot
// drift between operator surfaces.
package runstart

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/config"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/orgconfig"
	"github.com/johnny4young/janusly/internal/recovery"
	"github.com/johnny4young/janusly/internal/store"
	"github.com/johnny4young/janusly/internal/workflowreadiness"
)

const (
	CodeValidationFailed   = "workflows_validation_failed"
	CodeNotProductionReady = "runs_not_production_ready"
	CodeCircuitPaused      = "workflow_circuit_breaker_paused"
	CodeUpstreamDegraded   = "upstream_degraded"
	CodeVersionMismatch    = "workflow_version_mismatch"
	CodeAdhocDisabled      = "runs_adhoc_disabled"
)

// Rejection is an expected policy outcome. It is safe for transports to map to
// their own error envelopes; unexpected storage/runtime failures remain plain
// errors and must not be exposed.
type Rejection struct {
	Code           string
	Message        string
	Issues         []domain.Issue
	WorkflowStatus string
}

func (r *Rejection) Error() string { return r.Message }

// Service carries the shared run-start dependencies.
type Service struct {
	Engine *engine.Engine
	Pool   *pgxpool.Pool
	NewID  func() string
}

// Request is the already-parsed caller intent. The service validates the
// executable document again after any rollout replacement before committing.
type Request struct {
	OrgID, CreatedBy   string
	Workflow           *domain.Workflow
	RequestedVersionID string
	Input              any
	IdempotencyKey     string
}

// Result records the exact executable authority committed for the run.
type Result struct {
	RunID             string
	Workflow          *domain.Workflow
	Binding           engine.WorkflowVersionBinding
	RolloutAssignment *engine.RolloutAssignment
	Replayed          bool
}

// Start applies every external-start policy and then atomically creates the
// run skeleton. An existing org-scoped idempotency claim returns before
// mutable business policies are re-evaluated; the transport's authentication
// and permission gate has already run, and the retry performs no new write.
// For that replay shape only RunID and Replayed are authoritative. Start
// deliberately does not write an audit row: the calling transport owns
// actor/source provenance and audits the returned authority.
func (s Service) Start(ctx context.Context, request Request) (Result, error) {
	if s.Engine == nil || s.Pool == nil || request.Workflow == nil || request.OrgID == "" {
		return Result{}, fmt.Errorf("start run: invalid service input")
	}
	if request.IdempotencyKey != "" {
		original, err := store.New(s.Pool).GetStartIdempotencyRun(ctx, store.GetStartIdempotencyRunParams{
			OrgID: request.OrgID, IdempotencyKey: request.IdempotencyKey,
		})
		switch {
		case err == nil:
			return Result{RunID: original, Replayed: true}, nil
		case errors.Is(err, pgx.ErrNoRows):
			// The engine's transactional claim remains the concurrency authority
			// when two first attempts race after this read.
		default:
			return Result{}, fmt.Errorf("read run idempotency claim: %w", err)
		}
	}
	newID := s.NewID
	if newID == nil {
		newID = uuid.NewString
	}
	wf := request.Workflow

	var rolloutAssignment *engine.RolloutAssignment
	if wf.ID != "" {
		assignment, err := s.Engine.ResolveWorkflowRolloutAssignment(ctx, request.OrgID, wf.ID, newID())
		if err != nil {
			return Result{}, fmt.Errorf("resolve workflow rollout assignment: %w", err)
		}
		if assignment != nil {
			rolloutAssignment = assignment
			wf = assignment.Workflow
		}
	}

	validation := domain.ValidateWithSemanticFixtures(wf, grammar.DomainValidator, recovery.FixtureOutcomesForValidation)
	if !validation.Valid {
		return Result{}, &Rejection{
			Code: CodeValidationFailed, Message: "Validation failed", Issues: validation.Issues,
		}
	}
	if config.IsProduction(nil) {
		readiness, err := workflowreadiness.Evaluate(ctx, s.Pool, request.OrgID, wf)
		if err != nil {
			return Result{}, fmt.Errorf("evaluate workflow readiness: %w", err)
		}
		if readiness.Status == "fail" {
			return Result{}, &Rejection{
				Code: CodeNotProductionReady, Message: "Workflow not production-ready",
			}
		}
	}

	if wf.ID != "" {
		status, err := store.New(s.Pool).GetWorkflowBreakerStatus(ctx, store.GetWorkflowBreakerStatusParams{
			OrgID: request.OrgID, ID: wf.ID,
		})
		switch {
		case err == nil && status != "active":
			code := CodeUpstreamDegraded
			if status == "paused_circuit_breaker" {
				code = CodeCircuitPaused
			}
			return Result{}, &Rejection{
				Code: code, Message: "Workflow is paused — resume it before starting new runs",
				WorkflowStatus: status,
			}
		case err == nil:
		case errors.Is(err, pgx.ErrNoRows):
			// A document may carry a new caller-selected id and still be an honest
			// ad-hoc run. Version binding below decides that status.
		default:
			return Result{}, fmt.Errorf("read workflow start status: %w", err)
		}
	}

	binding := engine.WorkflowVersionBinding{}
	if rolloutAssignment != nil {
		binding = engine.WorkflowVersionBinding{VersionID: rolloutAssignment.VersionID, Bound: true}
	} else {
		var err error
		binding, err = s.Engine.ResolveWorkflowVersionBinding(
			ctx, request.OrgID, wf, request.RequestedVersionID,
		)
		if errors.Is(err, engine.ErrWorkflowVersionBindingMismatch) {
			return Result{}, &Rejection{
				Code:    CodeVersionMismatch,
				Message: "The requested workflow version does not match the submitted workflow",
			}
		}
		if err != nil {
			return Result{}, fmt.Errorf("resolve workflow version binding: %w", err)
		}
	}
	if !binding.Bound && orgconfig.LoadBool(ctx, s.Pool, request.OrgID, "runs.requireSavedWorkflow") {
		return Result{}, &Rejection{
			Code:    CodeAdhocDisabled,
			Message: "Ad-hoc workflows are disabled. Save the workflow first.",
		}
	}

	startInput := engine.StartInput{
		OrgID: request.OrgID, Workflow: wf, Input: request.Input,
		CreatedBy: request.CreatedBy, IdempotencyKey: request.IdempotencyKey,
		WorkflowVersionID: binding.VersionID,
	}
	if rolloutAssignment != nil {
		startInput.WorkflowRolloutID = rolloutAssignment.Rollout.ID
		startInput.WorkflowRolloutVariant = rolloutAssignment.Variant
	}
	runID, err := s.Engine.StartRun(ctx, startInput)
	if err != nil {
		var replay *engine.ErrStartIdempotencyReplay
		if errors.As(err, &replay) {
			return Result{
				RunID: replay.RunID, Workflow: wf, Binding: binding,
				RolloutAssignment: rolloutAssignment, Replayed: true,
			}, nil
		}
		return Result{}, err
	}
	return Result{
		RunID: runID, Workflow: wf, Binding: binding,
		RolloutAssignment: rolloutAssignment,
	}, nil
}
