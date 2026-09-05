// Operator resolution of semantic recovery cases: the approved replacement
// (or accepted loss) is applied under the run's immutable recovery contract.
package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/recovery"
	"github.com/johnny4young/janusly/internal/signature"
	"github.com/johnny4young/janusly/internal/store"
)

// ResolveSemanticOutcomeResult is the committed semantic resolution receipt.
type ResolveSemanticOutcomeResult struct {
	RunID           string
	SourceNodeID    string
	Decision        string
	Resumed         bool
	ResolvedCaseIDs []string
}

// semanticResolutionTarget is everything the resolver locked and verified
// before touching state: the case row and its open siblings, the run and
// node rows under lock, the approved candidate and its validation
// artifact, and the recovery contract the replacement is judged against.
type semanticResolutionTarget struct {
	snapshot           store.RecoveryCase
	lockedRun          store.LockRunForSemanticResolutionRow
	lockedNodes        []store.LockRunNodesForSemanticResolutionRow
	openCases          []store.RecoveryCase
	target             store.RecoveryCase
	candidate          SemanticRecoveryCandidatePayload
	candidateArtifact  store.RecoveryCaseArtifact
	validationArtifact store.RecoveryCaseArtifact
	contract           *domain.RecoveryContract
	actorKind          string
	now                time.Time
}

// ResolveSemanticOutcomeCase applies an approved semantic recovery decision
// in one transaction: lock and verify the case, evaluate a replacement
// against the run's immutable recovery contract, persist the resolution
// artifacts and transitions, settle the run, and audit the actor.
func (e *Engine) ResolveSemanticOutcomeCase(
	ctx context.Context, input ResolveSemanticOutcomeInput,
) (ResolveSemanticOutcomeResult, error) {
	if input.Auth == nil || input.Auth.OrgID == "" || input.Auth.UserID == "" {
		return ResolveSemanticOutcomeResult{}, fmt.Errorf("%w: authenticated actor required", ErrRecoverySemanticInputInvalid)
	}
	if input.CaseID == "" || utf8.RuneCountInString(input.CaseID) > 256 ||
		input.ExpectedRevision < 1 || input.CandidateArtifactID == "" ||
		input.ValidationArtifactID == "" {
		return ResolveSemanticOutcomeResult{}, ErrRecoverySemanticInputInvalid
	}
	orgID := input.Auth.OrgID
	snapshot, err := store.New(e.pool).GetRecoveryCase(ctx, store.GetRecoveryCaseParams{
		OrgID: orgID, ID: input.CaseID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ResolveSemanticOutcomeResult{}, ErrRecoveryCaseNotFound
		}
		return ResolveSemanticOutcomeResult{}, fmt.Errorf("read semantic recovery case: %w", err)
	}

	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return ResolveSemanticOutcomeResult{}, fmt.Errorf("begin semantic recovery: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	wrapped := e.wrapTx(tx)
	q := store.New(wrapped)

	target, err := e.lockSemanticResolutionTarget(ctx, q, input, snapshot)
	if err != nil {
		return ResolveSemanticOutcomeResult{}, err
	}
	decision := target.candidate.Decision
	var replacementState json.RawMessage
	if decision == "replace" {
		replacementState, err = e.evaluateSemanticReplacement(target)
		if err != nil {
			return ResolveSemanticOutcomeResult{}, err
		}
	}
	result, err := e.applySemanticResolution(ctx, q, wrapped, input, target, replacementState)
	if err != nil {
		return ResolveSemanticOutcomeResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ResolveSemanticOutcomeResult{}, fmt.Errorf("commit semantic recovery: %w", err)
	}

	// Publishing is deliberately post-commit. A lost signal is harmless:
	// stream subscribers poll the durable event table every second.
	if err := store.New(e.pool).NotifyRunEvents(ctx, snapshot.RunID); err != nil {
		slog.Warn("semantic recovery event notification deferred",
			"run_id", snapshot.RunID, "error", err)
	}
	return result, nil
}

// lockSemanticResolutionTarget takes the row locks the resolution needs and
// verifies every precondition against them: the case is still open at the
// expected revision, the candidate and validation artifacts belong to it
// and agree with each other, the decision is well-formed, an unconsumed
// approval grant covers exactly this pair, the case and run are in a
// resolvable state, and the run carries a version-2 recovery contract.
// Every mismatch is a conflict: the operator is looking at stale state.
func (e *Engine) lockSemanticResolutionTarget(
	ctx context.Context, q *store.Queries, input ResolveSemanticOutcomeInput, snapshot store.RecoveryCase,
) (semanticResolutionTarget, error) {
	orgID := input.Auth.OrgID
	lockedNodes, err := q.LockRunNodesForSemanticResolution(ctx, store.LockRunNodesForSemanticResolutionParams{
		RunID: snapshot.RunID, OrgID: orgID,
	})
	if err != nil {
		return semanticResolutionTarget{}, fmt.Errorf("lock semantic recovery nodes: %w", err)
	}
	lockedRun, err := q.LockRunForSemanticResolution(ctx, store.LockRunForSemanticResolutionParams{
		ID: snapshot.RunID, OrgID: orgID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return semanticResolutionTarget{}, ErrRecoveryCaseConflict
		}
		return semanticResolutionTarget{}, fmt.Errorf("lock semantic recovery run: %w", err)
	}
	openCases, err := q.LockOpenSemanticRecoveryCases(ctx, store.LockOpenSemanticRecoveryCasesParams{
		OrgID: orgID, RunID: snapshot.RunID, SourceNodeID: snapshot.SourceNodeID,
	})
	if err != nil {
		return semanticResolutionTarget{}, fmt.Errorf("lock semantic recovery cases: %w", err)
	}
	targetIndex := slices.IndexFunc(openCases, func(item store.RecoveryCase) bool {
		return item.ID == input.CaseID
	})
	if targetIndex < 0 {
		return semanticResolutionTarget{}, ErrRecoveryCaseConflict
	}
	target := openCases[targetIndex]
	if target.Revision != input.ExpectedRevision {
		return semanticResolutionTarget{}, ErrRecoveryCaseConflict
	}
	candidateArtifact, err := q.GetRecoveryCaseArtifact(ctx, store.GetRecoveryCaseArtifactParams{
		OrgID: orgID, CaseID: input.CaseID, ID: input.CandidateArtifactID,
	})
	if err != nil || candidateArtifact.Kind != "candidate" {
		return semanticResolutionTarget{}, ErrRecoveryCaseConflict
	}
	validationArtifact, err := q.GetRecoveryCaseArtifact(ctx, store.GetRecoveryCaseArtifactParams{
		OrgID: orgID, CaseID: input.CaseID, ID: input.ValidationArtifactID,
	})
	if err != nil || validationArtifact.Kind != "validation" {
		return semanticResolutionTarget{}, ErrRecoveryCaseConflict
	}
	candidate, candidateErr := ParseSemanticRecoveryCandidatePayload(candidateArtifact.PayloadJson)
	validation, validationErr := ParseSemanticRecoveryValidationPayload(validationArtifact.PayloadJson)
	if candidateErr != nil || validationErr != nil ||
		!validation.Passed || validation.CandidateArtifactID != candidateArtifact.ID ||
		validation.CandidateSha256 != candidateArtifact.PayloadSha256 ||
		!currentRecoveryValidation(validation.CaseRevision, target.Revision) {
		return semanticResolutionTarget{}, ErrRecoveryCaseConflict
	}
	candidate.Reason = strings.TrimSpace(candidate.Reason)
	if candidate.Decision != "replace" && candidate.Decision != "accept_loss" {
		return semanticResolutionTarget{}, ErrRecoverySemanticInputInvalid
	}
	if candidate.Reason == "" || utf8.RuneCountInString(candidate.Reason) > 1_000 {
		return semanticResolutionTarget{}, ErrRecoverySemanticInputInvalid
	}
	now := e.now().UTC().Truncate(time.Millisecond)
	grant, err := q.FindActiveRecoveryApprovalGrant(ctx, store.FindActiveRecoveryApprovalGrantParams{
		OrgID: orgID, CaseID: input.CaseID,
		CandidateArtifactID:  input.CandidateArtifactID,
		ValidationArtifactID: input.ValidationArtifactID,
		CaseRevision:         input.ExpectedRevision, NowAt: now,
	})
	if err != nil {
		return semanticResolutionTarget{}, ErrRecoveryCaseConflict
	}
	consumed, err := q.ConsumeRecoveryApprovalGrant(ctx, store.ConsumeRecoveryApprovalGrantParams{
		ConsumedAt: &now, ConsumedBy: pgtype.Text{String: input.Auth.UserID, Valid: true},
		ID: grant.ID, OrgID: orgID, CaseID: input.CaseID, CaseRevision: input.ExpectedRevision,
	})
	if err != nil || consumed != 1 {
		return semanticResolutionTarget{}, ErrRecoveryCaseConflict
	}
	resolvesQuarantine := target.Source == semanticRecoveryCaseSource &&
		target.Action == "quarantine" && target.State == "awaiting_approval" &&
		lockedRun.Status == "waiting"
	acknowledgesObservation := target.Source == semanticRecoveryCaseSource &&
		target.Action == "observe" && target.State == "awaiting_approval" &&
		candidate.Decision == "accept_loss"
	if !resolvesQuarantine && !acknowledgesObservation {
		return semanticResolutionTarget{}, ErrRecoveryCaseConflict
	}
	if lockedRun.ReplayMode.Valid && lockedRun.ReplayMode.String != "" {
		return semanticResolutionTarget{}, ErrRecoveryCaseConflict
	}
	wf, _, err := workflowFromRunInput(lockedRun.InputJson)
	if err != nil || wf.Recovery == nil || wf.Recovery.Contract == nil || wf.Recovery.Contract.Version != "2" {
		return semanticResolutionTarget{}, ErrRecoveryCaseConflict
	}
	return semanticResolutionTarget{
		snapshot: snapshot, lockedRun: lockedRun, lockedNodes: lockedNodes,
		openCases: openCases, target: target, candidate: candidate,
		candidateArtifact: candidateArtifact, validationArtifact: validationArtifact,
		contract: wf.Recovery.Contract, actorKind: recoveryActorKind(input.Auth), now: now,
	}, nil
}

// casesToResolve is the set a decision closes. A replacement is evaluated
// against the complete immutable recovery contract, so it can close every
// sibling detector for the same source node. An accepted loss is
// case-specific and must never implicitly acknowledge a different
// (especially quarantining) detector.
func (t semanticResolutionTarget) casesToResolve() []store.RecoveryCase {
	if t.candidate.Decision == "replace" {
		return t.openCases
	}
	return []store.RecoveryCase{t.target}
}

// evaluateSemanticReplacement checks that the combined autonomy profile of
// every open detector grants apply-with-approval, then scrubs the proposed
// output and re-runs the deterministic detectors against it. It returns the
// state_json the source node will carry once the replacement is applied.
func (e *Engine) evaluateSemanticReplacement(target semanticResolutionTarget) (json.RawMessage, error) {
	profiles := make([]domain.RecoveryAutonomyProfile, 0, len(target.openCases))
	for _, item := range target.openCases {
		profiles = append(profiles, domain.ResolveRecoveryAutonomyProfile(target.contract, domain.RecoveryFailureClass{
			Kind: "semantic", DetectorID: item.DetectorID,
		}))
	}
	autonomy := domain.CombineRecoveryAutonomyProfiles(profiles)
	if !autonomy.Capabilities.ApplyWithApproval {
		return nil, &RecoveryPolicyBlockedError{Profile: autonomy}
	}

	persistedOutput, state, reason := prepareSemanticReplacement(target.candidate.Output)
	if reason != "" {
		return nil, &RecoverySemanticOutputError{Reason: reason}
	}
	contextRows := make([]store.ListRunNodesByRunRow, 0, len(target.lockedNodes))
	for _, row := range target.lockedNodes {
		contextRows = append(contextRows, store.ListRunNodesByRunRow(row))
	}
	evaluation := recovery.EvaluateSemanticOutcome(struct {
		Contract     *domain.RecoveryContract
		SourceNodeID string
		Output       any
		Context      map[string]any
	}{
		Contract: target.contract, SourceNodeID: target.target.SourceNodeID,
		Output: persistedOutput, Context: runContextFromRows(contextRows),
	})
	if evaluation.Evaluated == 0 || len(evaluation.Violations) > 0 {
		reason := "No deterministic detector evaluated the replacement output"
		if len(evaluation.Violations) > 0 {
			reason = "Replacement output failed deterministic validation"
		}
		return nil, &RecoverySemanticOutputError{
			Reason: reason, Violations: evaluation.Violations,
		}
	}
	return state, nil
}

// applySemanticResolution persists the decision inside the caller's
// transaction: the replaced output and its impact record, the resolution
// artifacts and case transitions (revoking any other grants), the run's
// outcome status — resuming it when no quarantine remains — the timeline
// event, the readiness scan for a resumed run, and the audit entry.
func (e *Engine) applySemanticResolution(
	ctx context.Context, q *store.Queries, wrapped store.DBTX,
	input ResolveSemanticOutcomeInput, target semanticResolutionTarget, replacementState json.RawMessage,
) (ResolveSemanticOutcomeResult, error) {
	orgID := input.Auth.OrgID
	snapshot := target.snapshot
	decision := target.candidate.Decision
	casesToResolve := target.casesToResolve()
	resolvedAt := target.now
	caseIDs := make([]string, 0, len(casesToResolve))
	for _, item := range casesToResolve {
		caseIDs = append(caseIDs, item.ID)
	}
	finalState := "accepted_loss"
	if decision == "replace" {
		finalState = "monitoring"
	}

	if decision == "replace" {
		changed, err := q.ReplaceSemanticRunNodeOutput(ctx, store.ReplaceSemanticRunNodeOutputParams{
			StateJson: replacementState, RunID: snapshot.RunID,
			NodeID: snapshot.SourceNodeID, OrgID: orgID,
		})
		if err != nil {
			return ResolveSemanticOutcomeResult{}, fmt.Errorf("replace semantic recovery output: %w", err)
		}
		if changed != 1 {
			return ResolveSemanticOutcomeResult{}, ErrRecoveryCaseConflict
		}
		if err := e.recordRecoveryImpact(ctx, q, ClaimedNode{
			RunID: snapshot.RunID, NodeID: snapshot.SourceNodeID,
		}, resolvedAt); err != nil {
			return ResolveSemanticOutcomeResult{}, fmt.Errorf("record semantic recovery impact: %w", err)
		}
	}

	eventID := e.newID()
	reason := signature.ScrubSecretShapes(target.candidate.Reason)
	artifactPairs := make(map[string]semanticResolutionArtifactPair, len(casesToResolve))
	for index, item := range casesToResolve {
		pair, err := e.insertSemanticResolutionArtifacts(ctx, q, item, target.actorKind, input.Auth.UserID,
			decision, finalState, eventID, target.candidateArtifact, target.validationArtifact,
			resolvedAt.Add(time.Duration(index)*time.Millisecond))
		if err != nil {
			return ResolveSemanticOutcomeResult{}, err
		}
		artifactPairs[item.ID] = pair
		if _, err := q.RevokeRecoveryApprovalGrants(ctx, store.RevokeRecoveryApprovalGrantsParams{
			RevokedAt: &resolvedAt, OrgID: orgID, CaseID: item.ID,
		}); err != nil {
			return ResolveSemanticOutcomeResult{}, fmt.Errorf("revoke resolved recovery approvals: %w", err)
		}
	}
	for index, item := range casesToResolve {
		if err := e.advanceSemanticResolutionCase(ctx, q, item, target.actorKind, input.Auth.UserID,
			decision, reason, eventID, resolvedAt.Add(time.Duration(index*16)*time.Millisecond),
			target.candidateArtifact, target.validationArtifact, artifactPairs[item.ID]); err != nil {
			return ResolveSemanticOutcomeResult{}, err
		}
	}

	remaining, err := q.CountBlockingSemanticRecoveryCases(ctx, store.CountBlockingSemanticRecoveryCasesParams{
		OrgID: orgID, RunID: snapshot.RunID,
	})
	if err != nil {
		return ResolveSemanticOutcomeResult{}, fmt.Errorf("count remaining semantic cases: %w", err)
	}
	resumed := target.lockedRun.Status == "waiting" && remaining.OpenQuarantines == 0
	outcomeStatus := "semantic_quarantined"
	if remaining.OpenQuarantines == 0 {
		switch {
		case remaining.TotalOpen > 0:
			outcomeStatus = "semantic_violation"
		case decision == "replace":
			outcomeStatus = "semantic_recovering"
		default:
			outcomeStatus = "semantic_accepted_loss"
		}
	}
	changed, err := q.UpdateRunSemanticResolution(ctx, store.UpdateRunSemanticResolutionParams{
		Resume: resumed, OutcomeStatus: pgtype.Text{String: outcomeStatus, Valid: true},
		ID: snapshot.RunID, OrgID: orgID, ExpectedStatus: target.lockedRun.Status,
	})
	if err != nil {
		return ResolveSemanticOutcomeResult{}, fmt.Errorf("update semantic recovery run: %w", err)
	}
	if changed != 1 {
		return ResolveSemanticOutcomeResult{}, ErrRecoveryCaseConflict
	}

	events := &runEventBuffer{}
	events.add(eventID, snapshot.RunID, snapshot.SourceNodeID,
		"recovery.semantic_resolved", safePersist(map[string]any{
			"caseIds": caseIDs, "sourceNodeId": snapshot.SourceNodeID,
			"decision": decision, "resumed": resumed,
			"candidateArtifactId":  target.candidateArtifact.ID,
			"validationArtifactId": target.validationArtifact.ID,
		}, defaultPersistMaxBytes()), resolvedAt)
	if resumed {
		// Go's durable queue is PostgreSQL itself: the ordinary readiness scan
		// queues every now-ready successor in this same transaction. QueueRunNode
		// stamps the publication-repair generation, while LISTEN/NOTIFY remains
		// only a latency optimization delivered by PostgreSQL after commit.
		if _, err := e.scheduleDownstream(ctx, q, events, ClaimedNode{RunID: snapshot.RunID}, resolvedAt); err != nil {
			return ResolveSemanticOutcomeResult{}, fmt.Errorf("resume semantic recovery downstream: %w", err)
		}
	}

	if err := audit.WriteInTx(ctx, wrapped, input.Auth, audit.Action("recovery.semantic_resolved"), audit.Options{
		TargetType: "recovery_case", TargetID: input.CaseID,
		Metadata: map[string]any{
			"runId": snapshot.RunID, "sourceNodeId": snapshot.SourceNodeID,
			"decision": decision, "resumed": resumed,
			"candidateArtifactId":  target.candidateArtifact.ID,
			"validationArtifactId": target.validationArtifact.ID,
			"resolvedCaseIds":      caseIDs,
		},
	}); err != nil {
		return ResolveSemanticOutcomeResult{}, fmt.Errorf("audit semantic recovery: %w", err)
	}
	if err := events.flush(ctx, q); err != nil {
		return ResolveSemanticOutcomeResult{}, err
	}
	return ResolveSemanticOutcomeResult{
		RunID: snapshot.RunID, SourceNodeID: snapshot.SourceNodeID,
		Decision: decision, Resumed: resumed, ResolvedCaseIDs: caseIDs,
	}, nil
}

func prepareSemanticReplacement(output any) (any, json.RawMessage, string) {
	scrubbed := scrubSemanticReplacementValue(grammar.NormalizeJSON(output))
	state := safePersist(map[string]any{"output": scrubbed}, stateJSONMaxBytes)
	var persisted map[string]any
	if err := json.Unmarshal(state, &persisted); err != nil {
		return nil, nil, "Replacement output could not be persisted safely"
	}
	if truncated, _ := persisted["__truncated"].(bool); truncated {
		return nil, nil, "Replacement output exceeds the durable node-state limit"
	}
	value, present := persisted["output"]
	if !present {
		return nil, nil, "Replacement output could not be persisted safely"
	}
	return value, state, ""
}

func scrubSemanticReplacementValue(value any) any {
	switch typed := value.(type) {
	case string:
		return signature.ScrubSecretShapes(typed)
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = scrubSemanticReplacementValue(item)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = scrubSemanticReplacementValue(item)
		}
		return out
	default:
		return typed
	}
}

var semanticRecoveryReplacementPaths = map[string][]string{
	"detected":          {"contained", "diagnosed", "candidates_ready", "validating", "awaiting_approval", "publishing", "monitoring"},
	"contained":         {"diagnosed", "candidates_ready", "validating", "awaiting_approval", "publishing", "monitoring"},
	"diagnosed":         {"candidates_ready", "validating", "awaiting_approval", "publishing", "monitoring"},
	"candidates_ready":  {"validating", "awaiting_approval", "publishing", "monitoring"},
	"validating":        {"awaiting_approval", "publishing", "monitoring"},
	"awaiting_approval": {"publishing", "monitoring"},
	"publishing":        {"monitoring"},
}

type semanticResolutionArtifactPair struct {
	publication  store.RecoveryCaseArtifact
	verification store.RecoveryCaseArtifact
}

func (e *Engine) insertSemanticResolutionArtifacts(
	ctx context.Context, q *store.Queries, item store.RecoveryCase,
	actorKind, actorID, decision, finalState, eventID string,
	candidate, validation store.RecoveryCaseArtifact, occurredAt time.Time,
) (semanticResolutionArtifactPair, error) {
	insert := func(kind string, payload any, createdAt time.Time) (store.RecoveryCaseArtifact, error) {
		raw, hash, err := boundedRecoveryArtifact(payload)
		if err != nil {
			return store.RecoveryCaseArtifact{}, err
		}
		row, err := q.InsertRecoveryCaseArtifact(ctx, store.InsertRecoveryCaseArtifactParams{
			ID: StableSemanticID("rca", item.ID, kind, hash), OrgID: item.OrgID,
			CaseID: item.ID, Kind: kind, PayloadJson: raw, PayloadSha256: hash,
			ActorKind: actorKind, ActorID: pgtype.Text{String: actorID, Valid: true},
			CreatedAt: createdAt,
		})
		if err != nil {
			return store.RecoveryCaseArtifact{}, fmt.Errorf("insert semantic %s artifact: %w", kind, err)
		}
		return row, nil
	}
	publication, err := insert("publication", map[string]any{
		"eventId": eventID, "caseId": item.ID, "caseRevision": item.Revision,
		"runId": item.RunID, "sourceNodeId": item.SourceNodeID, "decision": decision,
		"authorityCaseId":     candidate.CaseID,
		"candidateArtifactId": candidate.ID, "candidateSha256": candidate.PayloadSha256,
		"validationArtifactId": validation.ID, "validationSha256": validation.PayloadSha256,
	}, occurredAt)
	if err != nil {
		return semanticResolutionArtifactPair{}, err
	}
	var verification store.RecoveryCaseArtifact
	if finalState == "accepted_loss" {
		verification, err = insert("verification", map[string]any{
			"eventId": eventID, "caseId": item.ID, "runId": item.RunID,
			"sourceNodeId": item.SourceNodeID, "detectorId": item.DetectorID,
			"decision": decision, "resultState": finalState,
			"deterministicValidationPassed": false,
			"humanLossAcknowledged":         true,
			"candidateArtifactId":           candidate.ID,
			"validationArtifactId":          validation.ID,
			"verifiedAt":                    occurredAt.UTC().Format(time.RFC3339Nano),
		}, occurredAt.Add(time.Millisecond))
		if err != nil {
			return semanticResolutionArtifactPair{}, err
		}
	}
	return semanticResolutionArtifactPair{publication: publication, verification: verification}, nil
}

func (e *Engine) advanceSemanticResolutionCase(
	ctx context.Context, q *store.Queries, item store.RecoveryCase,
	actorKind, actorID, decision, reason, eventID string, occurredAt time.Time,
	candidate, validation store.RecoveryCaseArtifact, artifacts semanticResolutionArtifactPair,
) error {
	targets := []string{"accepted_loss"}
	if decision == "replace" {
		targets = append([]string(nil), semanticRecoveryReplacementPaths[item.State]...)
		if len(targets) == 0 {
			return ErrRecoveryCaseConflict
		}
	}
	from := item.State
	revision := item.Revision
	for index, to := range targets {
		stepAt := occurredAt.Add(time.Duration(index) * time.Millisecond)
		receiptReason := reason
		if decision == "replace" && index == len(targets)-1 {
			receiptReason = "Replacement output passed every deterministic detector; terminal verification is monitoring"
		}
		receipt := domain.RecoveryCaseTransitionReceipt{
			CaseID: item.ID, From: from, To: to,
			ActorKind: actorKind, ActorID: actorID, Reason: receiptReason,
			Evidence: []domain.RecoveryCaseEvidenceRef{
				{Kind: "operator_decision", ID: eventID},
				{Kind: "run_node", ID: item.RunID + ":" + item.SourceNodeID},
				{Kind: "publication", ID: artifacts.publication.ID, Sha256: artifacts.publication.PayloadSha256},
			},
		}
		// Only the authority case owns the approved candidate and validation
		// artifacts. Sibling detectors closed by the same whole-contract
		// replacement cite their own publication artifact instead of pretending
		// those cross-case artifact ids are locally retrievable.
		if candidate.CaseID == item.ID && validation.CaseID == item.ID {
			receipt.Evidence = append(receipt.Evidence,
				domain.RecoveryCaseEvidenceRef{Kind: "case_artifact", ID: candidate.ID, Sha256: candidate.PayloadSha256},
				domain.RecoveryCaseEvidenceRef{Kind: "validation", ID: validation.ID, Sha256: validation.PayloadSha256},
			)
		}
		if decision == "replace" {
			receipt.Evidence = append(receipt.Evidence,
				domain.RecoveryCaseEvidenceRef{Kind: "semantic_detector", ID: item.DetectorID})
		}
		if to == "verified_recovered" || to == "accepted_loss" {
			receipt.Evidence = append(receipt.Evidence, domain.RecoveryCaseEvidenceRef{
				Kind: "effect", ID: artifacts.verification.ID, Sha256: artifacts.verification.PayloadSha256,
			})
		}
		if problems := domain.ValidateRecoveryCaseTransitionReceipt(receipt); len(problems) > 0 {
			return fmt.Errorf("validate semantic recovery receipt: %s", strings.Join(problems, "; "))
		}
		moved, err := q.AdvanceRecoveryCaseStateAtRevision(ctx, store.AdvanceRecoveryCaseStateAtRevisionParams{
			ToState: to, OccurredAt: stepAt, Terminal: domain.RecoveryCaseTerminalStates[to],
			OrgID: item.OrgID, ID: item.ID, FromState: from, ExpectedRevision: revision,
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrRecoveryCaseConflict
			}
			return fmt.Errorf("advance semantic recovery case: %w", err)
		}
		evidence, err := json.Marshal(receipt.Evidence)
		if err != nil {
			return fmt.Errorf("marshal semantic recovery evidence: %w", err)
		}
		inserted, err := q.InsertRecoveryCaseTransition(ctx, store.InsertRecoveryCaseTransitionParams{
			ID: StableSemanticID("sct", item.ID, from, to, fmt.Sprint(revision)), OrgID: item.OrgID, CaseID: item.ID,
			FromState: from, ToState: to, ActorKind: actorKind,
			ActorID: pgtype.Text{String: actorID, Valid: true}, EvidenceJson: evidence,
			Reason:     pgtype.Text{String: receiptReason, Valid: receiptReason != ""},
			OccurredAt: stepAt,
		})
		if err != nil {
			return fmt.Errorf("insert semantic recovery receipt: %w", err)
		}
		if inserted != 1 {
			return ErrRecoveryCaseConflict
		}
		from = to
		revision = moved.Revision
	}
	return nil
}

type semanticPublicationBinding struct {
	CaseID               string `json:"caseId"`
	AuthorityCaseID      string `json:"authorityCaseId"`
	CaseRevision         int64  `json:"caseRevision"`
	RunID                string `json:"runId"`
	Decision             string `json:"decision"`
	CandidateArtifactID  string `json:"candidateArtifactId"`
	CandidateSha256      string `json:"candidateSha256"`
	ValidationArtifactID string `json:"validationArtifactId"`
	ValidationSha256     string `json:"validationSha256"`
}
