// Webhook trigger ingestion. Pilot-shaped route — POST /v1/webhooks/{workflowId}
// (the reference selects the workflow org-wide by endpoint key at
// POST /triggers/webhook/ingest; the pilot scopes the selector to one
// workflow and keeps the rest of the contract: normalized payload
// validation, the trigger_events replay anchor persisted BEFORE the run,
// (org, dedupe_key) idempotency so a relay retry converges to one run, the
// buffer-on-pause posture (202: the event is accepted, its run deferred),
// and the start-claim CAS inside the run-start transaction).
package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/audit"
	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/engine"
	"github.com/johnny4young/janusly/go/internal/executors"
	"github.com/johnny4young/janusly/go/internal/grammar"
	"github.com/johnny4young/janusly/go/internal/ratelimit"
	"github.com/johnny4young/janusly/go/internal/recovery"
	"github.com/johnny4young/janusly/go/internal/store"
)

// webhookIngestMaxBytes mirrors the reference's trigger-ingest JSON cap.
const webhookIngestMaxBytes = 1 << 20

type webhookIngestBody struct {
	EndpointKey string         `json:"endpointKey"`
	EventID     string         `json:"eventId"`
	EventType   string         `json:"eventType"`
	Payload     map[string]any `json:"payload"`
	ReceivedAt  string         `json:"receivedAt"`
}

func (s *V1Server) ingestWebhook(w http.ResponseWriter, r *http.Request, rc v1Request) {
	writeVersioned(w, rc.id, s.webhookIngestCore(r, rc, r.PathValue("workflowId")))
}

func (s *V1Server) webhookIngestCore(r *http.Request, rc v1Request, workflowID string) opResult {
	ctx := r.Context()
	q := store.New(s.pool)

	var body webhookIngestBody
	if err := json.NewDecoder(http.MaxBytesReader(nil, r.Body, webhookIngestMaxBytes)).Decode(&body); err != nil {
		return opError(http.StatusBadRequest, "trigger_invalid_payload", "Invalid webhook payload", nil)
	}
	endpointKey := strings.TrimSpace(body.EndpointKey)
	eventID := strings.TrimSpace(body.EventID)
	eventType := strings.TrimSpace(body.EventType)
	receivedAt := strings.TrimSpace(body.ReceivedAt)
	switch {
	case endpointKey == "" || len(endpointKey) > 128:
		return opError(http.StatusBadRequest, "trigger_invalid_payload", "endpointKey must be 1..128 characters", nil)
	case eventID == "" || len(eventID) > 256:
		return opError(http.StatusBadRequest, "trigger_invalid_payload", "eventId must be 1..256 characters", nil)
	case len(eventType) > 128:
		return opError(http.StatusBadRequest, "trigger_invalid_payload", "eventType must be at most 128 characters", nil)
	case len(receivedAt) > 64:
		return opError(http.StatusBadRequest, "trigger_invalid_payload", "receivedAt must be at most 64 characters", nil)
	}
	if receivedAt == "" {
		receivedAt = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	}
	if body.Payload == nil {
		body.Payload = map[string]any{}
	}

	// Unknown, cross-org, and tombstoned workflows are indistinguishable
	// from "no matching trigger" — a webhook caller learns nothing about
	// what exists outside its scope.
	noMatch := opError(http.StatusNotFound, "trigger_no_matching_node",
		"No webhook_received trigger matches this endpoint key", nil)
	ownerState, err := q.GetWorkflowIngestState(ctx, workflowID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return noMatch
		}
		return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
	}
	if ownerState.OrgID != rc.orgID || ownerState.DeletedAt != nil {
		return noMatch
	}
	version, err := q.GetLatestWorkflowVersion(ctx, store.GetLatestWorkflowVersionParams{
		WorkflowID: workflowID, OrgID: rc.orgID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return noMatch
		}
		return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
	}

	wf, _ := domain.Parse(version.DagJson)
	if wf == nil {
		return opError(http.StatusUnprocessableEntity, "trigger_invalid_payload",
			"Resolved workflow failed schema validation", nil)
	}
	nodeID, result := matchWebhookNode(wf, endpointKey, noMatch)
	if nodeID == "" {
		return result
	}

	// ACCEPT-time rollout assignment: the durable event id is the
	// assignment key, so the deployment choice is deterministic and
	// captured on the event BEFORE the run exists (buffered events keep it
	// for backfill). The trigger node must exist in the ASSIGNED version's
	// snapshot — mutable deployment state never redirects an event to a
	// version that cannot serve it.
	triggerEventID := uuid.NewString()
	effectiveVersionID := version.ID
	var rolloutAssignment *engine.RolloutAssignment
	if assignment, err := s.engine.ResolveWorkflowRolloutAssignment(ctx, rc.orgID, workflowID, triggerEventID); err == nil && assignment != nil {
		exactNodeID, exactResult := matchWebhookNode(assignment.Workflow, endpointKey, opError(
			http.StatusConflict, "trigger_no_matching_node",
			"Assigned workflow version no longer contains the trigger node", nil))
		if exactNodeID == "" || exactNodeID != nodeID {
			return exactResult
		}
		wf = assignment.Workflow
		effectiveVersionID = assignment.VersionID
		rolloutAssignment = assignment
	} else if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
	}

	// Persist the replay anchor BEFORE the run, idempotent on the dedupe key.
	eventPayload := map[string]any{
		"endpointKey": endpointKey,
		"eventId":     eventID,
		"payload":     body.Payload,
		"receivedAt":  receivedAt,
	}
	if eventType != "" {
		eventPayload["eventType"] = eventType
	}
	dedupeKey := "webhook:" + strings.ToLower(endpointKey) + ":" + eventID
	payloadJSON, err := json.Marshal(map[string]any{"event": eventPayload})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
	}
	rolloutID, rolloutVariant := pgtype.Text{}, pgtype.Text{}
	if rolloutAssignment != nil {
		rolloutID = pgtype.Text{String: rolloutAssignment.Rollout.ID, Valid: true}
		rolloutVariant = pgtype.Text{String: rolloutAssignment.Variant, Valid: true}
	}
	created, err := q.InsertTriggerEvent(ctx, store.InsertTriggerEventParams{
		ID: triggerEventID, OrgID: rc.orgID, TriggerType: "webhook_received",
		WorkflowID:        pgtype.Text{String: workflowID, Valid: true},
		WorkflowVersionID: effectiveVersionID, NodeID: nodeID,
		DedupeKey:              pgtype.Text{String: dedupeKey, Valid: true},
		PayloadJson:            payloadJSON,
		WorkflowRolloutID:      rolloutID,
		WorkflowRolloutVariant: rolloutVariant,
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
	}
	if created == 0 {
		existing, err := q.FindTriggerEventByDedupe(ctx, store.FindTriggerEventByDedupeParams{
			OrgID: rc.orgID, DedupeKey: pgtype.Text{String: dedupeKey, Valid: true},
		})
		if err != nil {
			return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
		}
		if existing.Status != "received" {
			// Same dedupe key already processed: the relay sees success for
			// its retry without a second run.
			return opOK(map[string]any{
				"ok": true, "duplicate": true,
				"triggerEventId": existing.ID, "runId": textOrNull(existing.RunID),
			})
		}
		// Crash-window convergence: the row exists but its run never
		// started — this delivery adopts the persisted event and finishes
		// the job with the payload that was actually recorded.
		triggerEventID = existing.ID
		var persisted struct {
			Event map[string]any `json:"event"`
		}
		if err := json.Unmarshal(existing.PayloadJson, &persisted); err == nil && persisted.Event != nil {
			eventPayload = persisted.Event
		}
	}

	if created != 0 {
		audit.Write(ctx, s.pool, rc.authContext, "trigger.event.received", audit.Options{
			TargetType: "trigger_event", TargetID: triggerEventID,
			Metadata: map[string]any{
				"triggerType": "webhook_received", "workflowId": workflowID,
				"nodeId": nodeID, "replay": false,
			},
		})
	}

	// Per-trigger storm guard (Node's step order: received → guard →
	// buffer). Over-limit records the event as skipped and answers 429
	// with the reference's exact body.
	var nodeConfig map[string]any
	for _, node := range wf.Nodes {
		if node.ID == nodeID {
			nodeConfig = node.Config
			break
		}
	}
	ratePerMin := executors.ResolveTriggerRateLimitPerMin(nodeConfig["rateLimitPerMin"])
	if limitErr := s.limiter.Enforce(ctx, rc.orgID, ratelimit.Options{
		Name:   "trigger." + effectiveVersionID + "." + nodeID,
		Max:    ratePerMin,
		Window: time.Minute,
	}); limitErr != nil {
		if _, err := q.MarkTriggerEventOutcome(ctx, store.MarkTriggerEventOutcomeParams{
			OrgID: rc.orgID, ID: triggerEventID, Status: "skipped",
			SkippedReason: pgtype.Text{String: "rate_limited", Valid: true},
		}); err != nil {
			return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
		}
		audit.Write(ctx, s.pool, rc.authContext, "trigger.event.skipped", audit.Options{
			TargetType: "trigger_event", TargetID: triggerEventID,
			Metadata: map[string]any{
				"triggerType": "webhook_received", "reason": "rate_limited", "ratePerMin": ratePerMin,
			},
		})
		return opResult{status: http.StatusTooManyRequests, data: map[string]any{
			"ok": false, "skipped": true, "reason": "rate_limited", "triggerEventId": triggerEventID,
		}}
	}

	// Buffer-on-pause: an inbound event is data the upstream system already
	// committed and will not re-send — a paused workflow parks it as
	// `buffered` (202: accepted, run deferred) instead of dropping it.
	if ownerState.Status != "" && ownerState.Status != "active" {
		if _, err := q.MarkTriggerEventOutcome(ctx, store.MarkTriggerEventOutcomeParams{
			OrgID: rc.orgID, ID: triggerEventID, Status: "buffered",
			SkippedReason: pgtype.Text{String: ownerState.Status, Valid: true},
		}); err != nil {
			return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
		}
		audit.Write(ctx, s.pool, rc.authContext, "trigger.event.buffered", audit.Options{
			TargetType: "trigger_event", TargetID: triggerEventID,
			Metadata: map[string]any{
				"triggerType": "webhook_received", "reason": ownerState.Status,
				"workflowId": workflowID, "nodeId": nodeID,
			},
		})
		return opResult{status: http.StatusAccepted, data: map[string]any{
			"ok": true, "buffered": true, "reason": ownerState.Status, "triggerEventId": triggerEventID,
		}}
	}

	if valid := domain.ValidateWithSemanticFixtures(wf, grammar.DomainValidator, recovery.FixtureOutcomesForValidation); !valid.Valid {
		_, _ = q.MarkTriggerEventOutcome(ctx, store.MarkTriggerEventOutcomeParams{
			OrgID: rc.orgID, ID: triggerEventID, Status: "failed",
			SkippedReason: pgtype.Text{String: "workflow_parse_failed", Valid: true},
		})
		return opError(http.StatusUnprocessableEntity, "trigger_invalid_payload",
			"Resolved workflow failed schema validation", nil)
	}

	ingestStart := engine.StartInput{
		OrgID: rc.orgID, Workflow: wf, WorkflowVersionID: effectiveVersionID,
		CreatedBy: rc.userID, TriggerEventID: triggerEventID,
		Input: map[string]any{
			"triggeredBy": "webhook_received", "triggerEventId": triggerEventID,
			"event": eventPayload,
		},
	}
	if rolloutAssignment != nil {
		ingestStart.WorkflowRolloutID = rolloutAssignment.Rollout.ID
		ingestStart.WorkflowRolloutVariant = rolloutAssignment.Variant
	}
	runID, err := s.engine.StartRun(ctx, ingestStart)
	if err != nil {
		var conflict *engine.TriggerEventStartConflictError
		if errors.As(err, &conflict) {
			claimed, err := q.GetTriggerEvent(ctx, store.GetTriggerEventParams{OrgID: rc.orgID, ID: triggerEventID})
			if err != nil {
				return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
			}
			return opOK(map[string]any{
				"ok": true, "duplicate": true,
				"triggerEventId": claimed.ID, "runId": textOrNull(claimed.RunID),
			})
		}
		// The event row stays `received` so the relay's retry converges.
		return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
	}
	audit.Write(ctx, s.pool, rc.authContext, "trigger.event.started", audit.Options{
		TargetType: "trigger_event", TargetID: triggerEventID,
		Metadata: map[string]any{
			"triggerType": "webhook_received", "runId": runID,
			"workflowId": workflowID, "nodeId": nodeID,
		},
	})
	return opOK(map[string]any{"ok": true, "triggerEventId": triggerEventID, "runId": runID})
}

// matchWebhookNode finds the unique webhook_received node whose configured
// endpoint key matches (case-insensitive, trimmed). Zero matches → the
// caller's no-match result; more than one → ambiguous.
func matchWebhookNode(wf *domain.Workflow, endpointKey string, noMatch opResult) (string, opResult) {
	var matched []string
	for _, node := range wf.Nodes {
		if node.Type != "webhook_received" {
			continue
		}
		key, err := executors.ResolveWebhookEndpointKey(node.Config)
		if err != nil || key == "" {
			continue
		}
		if strings.EqualFold(key, endpointKey) {
			matched = append(matched, node.ID)
		}
	}
	switch len(matched) {
	case 0:
		return "", noMatch
	case 1:
		return matched[0], opResult{}
	default:
		return "", opError(http.StatusConflict, "trigger_selector_ambiguous",
			"Multiple active workflows use this webhook endpoint key", nil)
	}
}

// runsRedriveCore adapts the web's POST /runs/redrive {runId, nodeId} to
// the pilot's revive-in-place redrive: resolve the node's open dead letter
// and claim it. The reference spawns a replay continuation run; the pilot
// revives the SAME run, so the returned runId equals the input and the web
// simply reopens it.
func (s *V1Server) runsRedriveCore(r *http.Request, rc v1Request) opResult {
	var body struct {
		RunID  string `json:"runId"`
		NodeID string `json:"nodeId"`
	}
	if err := decodeBody(r, &body); err != nil || body.RunID == "" || body.NodeID == "" {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body",
			map[string]any{"field": "runId"})
	}
	deadLetterID, err := store.New(s.pool).FindOpenDeadLetterForNode(r.Context(),
		store.FindOpenDeadLetterForNodeParams{OrgID: rc.orgID, RunID: body.RunID, NodeID: body.NodeID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusNotFound, "dlq_not_found", "Not found", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	if err := s.engine.RedriveDeadLetter(r.Context(), rc.orgID, deadLetterID); err != nil {
		switch {
		case errors.Is(err, engine.ErrDeadLetterNotFound):
			return opError(http.StatusNotFound, "dlq_not_found", "Not found", nil)
		case errors.Is(err, engine.ErrRedriveConflict):
			return opError(http.StatusConflict, "dlq_replay_conflict", "Dead letter replay already claimed", nil)
		default:
			return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
		}
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "run.redrive", audit.Options{
		TargetType: "run", TargetID: body.RunID,
		Metadata: map[string]any{"sourceRunId": body.RunID, "nodeId": body.NodeID},
	})
	return opOK(map[string]any{"ok": true, "runId": body.RunID})
}
