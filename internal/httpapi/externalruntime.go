// Signed lifecycle ingestion and read-only shadow projections for
// workflows owned by EXTERNAL runtimes (reference
// apps/api/src/routes/external-runtime-routes.ts + externalRuntimeRepo.ts
// + external-runtime.ts). Observation-only by contract: the CloudEvents
// union carries no retry/resume/cancel/replay command, so shadow state can
// never be mistaken for mutation authority, and external cases earn no
// verified-recovery credit.
//
// The public callback resolves only an opaque connection id, verifies the
// exact raw-body `t=,v1=` HMAC (±300s) with a dedicated Secret Store
// credential (kind external_runtime_signing_secret), validates the STRICT
// runtime-neutral contract, and atomically records: one idempotent signed
// receipt per (connection, source, eventId), then a monotonic projection
// per subject — lower/equal sequences are retained as `stale`, never
// applied. All projected strings/snapshots pass the secret scrubber and
// the bounded persist chokepoint; identity fields that LOOK like secrets
// are rejected outright (they'd be corrupted by scrubbing).
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/secretstore"
	"github.com/johnny4young/janusly/internal/signature"
	"github.com/johnny4young/janusly/internal/store"
	"github.com/johnny4young/janusly/internal/webhooksig"
)

const (
	externalRuntimeBodyMaxBytes     = 128_000
	externalRuntimePayloadMaxBytes  = 64_000
	externalRuntimeToleranceSeconds = 300
	externalRuntimeNameMax          = 120
	externalRuntimeKeyMax           = 120
	externalRuntimeCredentialMax    = 200
)

var (
	externalRuntimeKeyPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)
	externalHexSigPattern     = regexp.MustCompile(`^[0-9a-f]{64}$`)
	externalStatuses          = map[string]bool{
		"queued": true, "running": true, "waiting": true, "succeeded": true,
		"failed": true, "cancelled": true, "unknown": true,
	}
	externalEvidenceKinds = map[string]bool{"url": true, "trace": true, "log": true, "artifact": true}
)

/* ------------------------------ signature ----------------------------- */

// verifyExternalRuntimeSignature ports external-runtime-signature.ts:
// `t=<unix-seconds>,v1=<hex>` over `${timestamp}.${rawBody}`, constant
// time, bounded clock skew.
func verifyExternalRuntimeSignature(signatureHeader, rawBody, secret string, nowSeconds int64) bool {
	timestampRaw, candidates := webhooksig.ParseHeader(signatureHeader, "t", "v1")
	for _, candidate := range candidates {
		if !externalHexSigPattern.MatchString(candidate) {
			return false
		}
	}
	_, reason := webhooksig.Verify(timestampRaw, candidates, rawBody, secret, nowSeconds, webhooksig.Posture{
		Compose:          func(t, body string) string { return t + "." + body },
		ToleranceSeconds: externalRuntimeToleranceSeconds,
	})
	return reason == ""
}

/* ------------------------- strict event contract ----------------------- */

type externalEvidencePointer struct {
	Kind    string `json:"kind"`
	Label   string `json:"label"`
	Locator string `json:"locator"`
}

type externalObservationData struct {
	Sequence           *float64                  `json:"sequence"`
	Snapshot           any                       `json:"snapshot"`
	Evidence           []externalEvidencePointer `json:"evidence"`
	ExternalWorkflowID string                    `json:"externalWorkflowId"`
	ExternalRunID      string                    `json:"externalRunId"`
	ExternalStepID     string                    `json:"externalStepId"`
	Name               string                    `json:"name"`
	Version            string                    `json:"version"`
	Status             string                    `json:"status"`
	Attempt            *float64                  `json:"attempt"`
	StartedAt          string                    `json:"startedAt"`
	CompletedAt        string                    `json:"completedAt"`
}

type externalRuntimeEvent struct {
	Specversion     string                  `json:"specversion"`
	ID              string                  `json:"id"`
	Source          string                  `json:"source"`
	Subject         string                  `json:"subject"`
	Time            string                  `json:"time"`
	Datacontenttype string                  `json:"datacontenttype"`
	Type            string                  `json:"type"`
	Data            externalObservationData `json:"data"`

	eventTime time.Time
	sequence  int64
	attempt   int
}

// allowedExternalDataFields is the STRICT per-type field set (the
// reference schemas are z.strict()); an unknown or out-of-type field
// rejects the event.
var allowedExternalDataFields = map[string]map[string]bool{
	"io.janusly.external.workflow.observed": {
		"sequence": true, "snapshot": true, "evidence": true,
		"externalWorkflowId": true, "name": true, "version": true,
	},
	"io.janusly.external.run.observed": {
		"sequence": true, "snapshot": true, "evidence": true,
		"externalWorkflowId": true, "externalRunId": true, "status": true,
		"startedAt": true, "completedAt": true,
	},
	"io.janusly.external.step.observed": {
		"sequence": true, "snapshot": true, "evidence": true,
		"externalWorkflowId": true, "externalRunId": true, "externalStepId": true,
		"name": true, "status": true, "attempt": true,
		"startedAt": true, "completedAt": true,
	},
}

var allowedExternalEnvelopeFields = map[string]bool{
	"specversion": true, "id": true, "source": true, "subject": true,
	"time": true, "datacontenttype": true, "type": true, "data": true,
}

func externalIDValid(value string, max int) bool {
	trimmed := strings.TrimSpace(value)
	return trimmed != "" && trimmed == value && len(value) <= max
}

func parseExternalTimestamp(value string) (time.Time, bool) {
	parsed, err := time.Parse(time.RFC3339, value)
	return parsed, err == nil
}

// parseExternalRuntimeEvent validates the strict CloudEvents contract;
// nil means "invalid external runtime event".
func parseExternalRuntimeEvent(rawBody []byte) *externalRuntimeEvent {
	var rawEnvelope map[string]json.RawMessage
	if err := json.Unmarshal(rawBody, &rawEnvelope); err != nil {
		return nil
	}
	for field := range rawEnvelope {
		if !allowedExternalEnvelopeFields[field] {
			return nil
		}
	}
	var event externalRuntimeEvent
	if err := json.Unmarshal(rawBody, &event); err != nil {
		return nil
	}
	allowedData, knownType := allowedExternalDataFields[event.Type]
	if !knownType {
		return nil
	}
	var rawData map[string]json.RawMessage
	if dataRaw, ok := rawEnvelope["data"]; !ok || json.Unmarshal(dataRaw, &rawData) != nil {
		return nil
	}
	for field := range rawData {
		if !allowedData[field] {
			return nil
		}
	}

	eventTime, timeOK := parseExternalTimestamp(event.Time)
	if event.Specversion != "1.0" || !timeOK ||
		!externalIDValid(event.ID, 256) || !externalIDValid(event.Source, 512) ||
		(event.Subject != "" && !externalIDValid(event.Subject, 512)) ||
		(event.Datacontenttype != "" && event.Datacontenttype != "application/json") {
		return nil
	}
	data := &event.Data
	if data.Sequence == nil || *data.Sequence != math.Trunc(*data.Sequence) ||
		*data.Sequence < 0 || *data.Sequence > 9_007_199_254_740_991 {
		return nil
	}
	event.sequence = int64(*data.Sequence)
	if len(data.Evidence) > 20 {
		return nil
	}
	for _, pointer := range data.Evidence {
		if !externalEvidenceKinds[pointer.Kind] || !externalIDValid(pointer.Label, 200) ||
			!externalIDValid(pointer.Locator, 2048) {
			return nil
		}
	}
	if !externalIDValid(data.ExternalWorkflowID, 256) {
		return nil
	}
	for _, timestamp := range []string{data.StartedAt, data.CompletedAt} {
		if timestamp != "" {
			if _, ok := parseExternalTimestamp(timestamp); !ok {
				return nil
			}
		}
	}
	switch event.Type {
	case "io.janusly.external.workflow.observed":
		if !externalIDValid(data.Name, 200) || (data.Version != "" && !externalIDValid(data.Version, 200)) {
			return nil
		}
	case "io.janusly.external.run.observed":
		if !externalIDValid(data.ExternalRunID, 256) || !externalStatuses[data.Status] {
			return nil
		}
	case "io.janusly.external.step.observed":
		if !externalIDValid(data.ExternalRunID, 256) || !externalIDValid(data.ExternalStepID, 256) ||
			!externalIDValid(data.Name, 200) || !externalStatuses[data.Status] {
			return nil
		}
	}
	event.attempt = 1
	if data.Attempt != nil {
		if *data.Attempt != math.Trunc(*data.Attempt) || *data.Attempt < 1 || *data.Attempt > 10_000 {
			return nil
		}
		event.attempt = int(*data.Attempt)
	}
	event.eventTime = eventTime
	return &event
}

// externalIdentitySensitive rejects events whose IDENTITY fields look like
// secret material — scrubbing would corrupt them, so they must not enter
// the projection at all.
func externalIdentitySensitive(event *externalRuntimeEvent) bool {
	for _, value := range []string{
		event.ID, event.Source, event.Data.ExternalWorkflowID,
		event.Data.ExternalRunID, event.Data.ExternalStepID,
	} {
		if value != "" && signature.ScrubSecretShapes(value) != value {
			return true
		}
	}
	return false
}

/* ------------------------ scrubbed safe payloads ----------------------- */

func scrubExternalValue(value any) any {
	switch typed := value.(type) {
	case string:
		return signature.ScrubSecretShapes(typed)
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, scrubExternalValue(item))
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = scrubExternalValue(item)
		}
		return out
	default:
		return value
	}
}

func safeExternalPayload(value any) []byte {
	return grammar.SafePersistPayload(scrubExternalValue(value),
		grammar.PersistOptions{MaxBytes: externalRuntimePayloadMaxBytes})
}

func safeExternalEvidence(evidence []externalEvidencePointer) []byte {
	items := make([]any, 0, len(evidence))
	for _, pointer := range evidence {
		items = append(items, map[string]any{
			"kind": pointer.Kind, "label": pointer.Label, "locator": pointer.Locator,
		})
	}
	return safeExternalPayload(items)
}

/* ------------------------- atomic event recording ---------------------- */

type externalRecordResult struct {
	kind       string // connection_not_found | duplicate | applied | stale
	eventID    string
	receivedAt time.Time
	priorState string // duplicate: the original receipt's projection state
}

func (s *V1Server) recordExternalRuntimeEvent(
	ctx context.Context, orgID, connectionID string, event *externalRuntimeEvent, rawEvent any,
) (externalRecordResult, error) {
	now := time.Now().UTC()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return externalRecordResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	txq := store.New(tx)

	if _, err := txq.GetActiveExternalRuntimeConnection(ctx, store.GetActiveExternalRuntimeConnectionParams{
		ID: connectionID, OrgID: orgID,
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return externalRecordResult{kind: "connection_not_found"}, nil
		}
		return externalRecordResult{}, err
	}

	subject := pgtype.Text{}
	if event.Subject != "" {
		subject = pgtype.Text{String: signature.ScrubSecretShapes(event.Subject), Valid: true}
	}
	created, err := txq.InsertExternalRuntimeEventReceipt(ctx, store.InsertExternalRuntimeEventReceiptParams{
		ID: uuid.NewString(), OrgID: orgID, ConnectionID: connectionID,
		EventID: event.ID, Source: event.Source, EventType: event.Type,
		Subject: subject, EventTime: event.eventTime, Sequence: event.sequence,
		PayloadJson: safeExternalPayload(rawEvent), ReceivedAt: now,
	})
	if err != nil {
		return externalRecordResult{}, err
	}
	if created == 0 {
		existing, err := txq.GetExternalRuntimeEventReceipt(ctx, store.GetExternalRuntimeEventReceiptParams{
			ConnectionID: connectionID, Source: event.Source, EventID: event.ID,
		})
		if err != nil {
			return externalRecordResult{}, err
		}
		return externalRecordResult{
			kind: "duplicate", eventID: existing.EventID,
			receivedAt: existing.ReceivedAt, priorState: existing.ProjectionState,
		}, tx.Commit(ctx)
	}

	projectionState, err := s.projectExternalEvent(ctx, txq, orgID, connectionID, event, now)
	if err != nil {
		return externalRecordResult{}, err
	}
	receipt, err := txq.GetExternalRuntimeEventReceipt(ctx, store.GetExternalRuntimeEventReceiptParams{
		ConnectionID: connectionID, Source: event.Source, EventID: event.ID,
	})
	if err != nil {
		return externalRecordResult{}, err
	}
	if err := txq.SetExternalRuntimeEventProjectionState(ctx, store.SetExternalRuntimeEventProjectionStateParams{
		ID: receipt.ID, ProjectionState: projectionState,
	}); err != nil {
		return externalRecordResult{}, err
	}
	return externalRecordResult{kind: projectionState, eventID: event.ID, receivedAt: now}, tx.Commit(ctx)
}

func optionalExternalTime(value string) *time.Time {
	if value == "" {
		return nil
	}
	parsed, ok := parseExternalTimestamp(value)
	if !ok {
		return nil
	}
	return &parsed
}

func (s *V1Server) projectExternalEvent(
	ctx context.Context, txq *store.Queries, orgID, connectionID string,
	event *externalRuntimeEvent, now time.Time,
) (string, error) {
	data := &event.Data
	snapshotJSON := safeExternalPayload(data.Snapshot)
	evidenceJSON := safeExternalEvidence(data.Evidence)
	eventTime := event.eventTime

	switch event.Type {
	case "io.janusly.external.workflow.observed":
		version := pgtype.Text{}
		if data.Version != "" {
			version = pgtype.Text{String: signature.ScrubSecretShapes(data.Version), Valid: true}
		}
		applied, err := txq.UpsertExternalWorkflowObservation(ctx, store.UpsertExternalWorkflowObservationParams{
			ID: uuid.NewString(), OrgID: orgID, ConnectionID: connectionID,
			ExternalWorkflowID: data.ExternalWorkflowID,
			Name:               signature.ScrubSecretShapes(data.Name), Version: version,
			SnapshotJson: snapshotJSON, EvidenceJson: evidenceJSON,
			LastSequence:   event.sequence,
			LastEventID:    pgtype.Text{String: event.ID, Valid: true},
			LastObservedAt: &eventTime,
		})
		if err != nil {
			return "", err
		}
		if applied > 0 {
			return "applied", nil
		}
		return "stale", nil

	case "io.janusly.external.run.observed":
		if err := txq.UpsertExternalWorkflowPlaceholder(ctx, store.UpsertExternalWorkflowPlaceholderParams{
			ID: uuid.NewString(), OrgID: orgID, ConnectionID: connectionID,
			ExternalWorkflowID: data.ExternalWorkflowID,
		}); err != nil {
			return "", err
		}
		applied, err := txq.UpsertExternalRunObservation(ctx, store.UpsertExternalRunObservationParams{
			ID: uuid.NewString(), OrgID: orgID, ConnectionID: connectionID,
			ExternalWorkflowID: data.ExternalWorkflowID, ExternalRunID: data.ExternalRunID,
			Status:    data.Status,
			StartedAt: optionalExternalTime(data.StartedAt), CompletedAt: optionalExternalTime(data.CompletedAt),
			SnapshotJson: snapshotJSON, EvidenceJson: evidenceJSON,
			LastSequence:   event.sequence,
			LastEventID:    pgtype.Text{String: event.ID, Valid: true},
			LastObservedAt: &eventTime,
		})
		if err != nil {
			return "", err
		}
		if applied == 0 {
			return "stale", nil
		}
		return "applied", s.projectExternalRecoveryCase(ctx, txq, orgID, connectionID, event, now)

	default: // io.janusly.external.step.observed
		if err := txq.UpsertExternalWorkflowPlaceholder(ctx, store.UpsertExternalWorkflowPlaceholderParams{
			ID: uuid.NewString(), OrgID: orgID, ConnectionID: connectionID,
			ExternalWorkflowID: data.ExternalWorkflowID,
		}); err != nil {
			return "", err
		}
		if err := txq.UpsertExternalRunPlaceholder(ctx, store.UpsertExternalRunPlaceholderParams{
			ID: uuid.NewString(), OrgID: orgID, ConnectionID: connectionID,
			ExternalWorkflowID: data.ExternalWorkflowID, ExternalRunID: data.ExternalRunID,
		}); err != nil {
			return "", err
		}
		applied, err := txq.UpsertExternalStepObservation(ctx, store.UpsertExternalStepObservationParams{
			ID: uuid.NewString(), OrgID: orgID, ConnectionID: connectionID,
			ExternalWorkflowID: data.ExternalWorkflowID, ExternalRunID: data.ExternalRunID,
			ExternalStepID: data.ExternalStepID,
			Name:           signature.ScrubSecretShapes(data.Name), Status: data.Status,
			Attempt:   int32(event.attempt),
			StartedAt: optionalExternalTime(data.StartedAt), CompletedAt: optionalExternalTime(data.CompletedAt),
			SnapshotJson: snapshotJSON, EvidenceJson: evidenceJSON,
			LastSequence:   event.sequence,
			LastEventID:    pgtype.Text{String: event.ID, Valid: true},
			LastObservedAt: &eventTime,
		})
		if err != nil {
			return "", err
		}
		if applied == 0 {
			return "stale", nil
		}
		return "applied", s.projectExternalRecoveryCase(ctx, txq, orgID, connectionID, event, now)
	}
}

// projectExternalRecoveryCase mirrors the reference: a failed observation
// (re)opens the subject's case as `detected`; a succeeded observation with
// a HIGHER sequence flips it to `observed_recovered`. Never a Janusly
// verified recovery — external cases carry no credit.
func (s *V1Server) projectExternalRecoveryCase(
	ctx context.Context, txq *store.Queries, orgID, connectionID string,
	event *externalRuntimeEvent, now time.Time,
) error {
	_ = now
	data := &event.Data
	subjectKind, subjectKey := "run", "run:"+data.ExternalRunID
	stepID := pgtype.Text{}
	if event.Type == "io.janusly.external.step.observed" {
		subjectKind = "step"
		subjectKey = "step:" + data.ExternalRunID + ":" + data.ExternalStepID
		stepID = pgtype.Text{String: data.ExternalStepID, Valid: true}
	}
	eventTime := event.eventTime
	switch data.Status {
	case "failed":
		return txq.UpsertExternalRecoveryCaseDetected(ctx, store.UpsertExternalRecoveryCaseDetectedParams{
			ID: uuid.NewString(), OrgID: orgID, ConnectionID: connectionID,
			SubjectKey: subjectKey, SubjectKind: subjectKind,
			ExternalWorkflowID: data.ExternalWorkflowID,
			ExternalRunID:      data.ExternalRunID, ExternalStepID: stepID,
			FailureSnapshotJson: safeExternalPayload(data.Snapshot),
			EvidenceJson:        safeExternalEvidence(data.Evidence),
			FirstDetectedAt:     eventTime,
			LastSequence:        event.sequence,
			LastEventID:         event.ID,
		})
	case "succeeded":
		return txq.MarkExternalRecoveryCaseRecovered(ctx, store.MarkExternalRecoveryCaseRecoveredParams{
			OrgID: orgID, ConnectionID: connectionID, SubjectKey: subjectKey,
			LastSequence:   event.sequence,
			EvidenceJson:   safeExternalEvidence(data.Evidence),
			LastObservedAt: eventTime,
			LastEventID:    event.ID,
		})
	default:
		return nil
	}
}

/* ------------------------------- routes -------------------------------- */

func externalRuntimeConnectionView(row store.ExternalRuntimeConnection) map[string]any {
	return map[string]any{
		"id": row.ID, "name": row.Name, "runtimeKey": row.RuntimeKey,
		"signingCredentialName": row.SigningCredentialName, "enabled": row.Enabled,
		"callbackUrl": "/webhooks/external-runtimes/" + row.ID,
		"createdAt":   row.CreatedAt, "updatedAt": row.UpdatedAt,
	}
}

func externalWorkflowView(row store.ExternalWorkflow) map[string]any {
	return map[string]any{
		"id": row.ID, "orgId": row.OrgID, "connectionId": row.ConnectionID,
		"externalWorkflowId": row.ExternalWorkflowID, "name": row.Name,
		"version": textOrNull(row.Version), "snapshotJson": normalizedRaw(row.SnapshotJson),
		"evidenceJson": normalizedRaw(row.EvidenceJson), "lastSequence": row.LastSequence,
		"lastEventId": textOrNull(row.LastEventID), "lastObservedAt": timeOrNull(row.LastObservedAt),
		"createdAt": row.CreatedAt, "updatedAt": row.UpdatedAt,
	}
}

func externalRunView(row store.ExternalRun) map[string]any {
	return map[string]any{
		"id": row.ID, "orgId": row.OrgID, "connectionId": row.ConnectionID,
		"externalWorkflowId": row.ExternalWorkflowID, "externalRunId": row.ExternalRunID,
		"status": row.Status, "startedAt": timeOrNull(row.StartedAt),
		"completedAt": timeOrNull(row.CompletedAt), "snapshotJson": normalizedRaw(row.SnapshotJson),
		"evidenceJson": normalizedRaw(row.EvidenceJson), "lastSequence": row.LastSequence,
		"lastEventId": textOrNull(row.LastEventID), "lastObservedAt": timeOrNull(row.LastObservedAt),
		"createdAt": row.CreatedAt, "updatedAt": row.UpdatedAt,
	}
}

func externalRunStepView(row store.ExternalRunStep) map[string]any {
	return map[string]any{
		"id": row.ID, "orgId": row.OrgID, "connectionId": row.ConnectionID,
		"externalWorkflowId": row.ExternalWorkflowID, "externalRunId": row.ExternalRunID,
		"externalStepId": row.ExternalStepID, "name": row.Name, "status": row.Status,
		"attempt": row.Attempt, "startedAt": timeOrNull(row.StartedAt),
		"completedAt": timeOrNull(row.CompletedAt), "snapshotJson": normalizedRaw(row.SnapshotJson),
		"evidenceJson": normalizedRaw(row.EvidenceJson), "lastSequence": row.LastSequence,
		"lastEventId": textOrNull(row.LastEventID), "lastObservedAt": timeOrNull(row.LastObservedAt),
		"createdAt": row.CreatedAt, "updatedAt": row.UpdatedAt,
	}
}

func externalRecoveryCaseView(row store.ExternalRecoveryCase) map[string]any {
	return map[string]any{
		"id": row.ID, "orgId": row.OrgID, "connectionId": row.ConnectionID,
		"subjectKey": row.SubjectKey, "subjectKind": row.SubjectKind,
		"externalWorkflowId": row.ExternalWorkflowID, "externalRunId": row.ExternalRunID,
		"externalStepId": textOrNull(row.ExternalStepID), "state": row.State,
		"failureSnapshotJson": normalizedRaw(row.FailureSnapshotJson),
		"evidenceJson":        normalizedRaw(row.EvidenceJson), "firstDetectedAt": row.FirstDetectedAt,
		"lastObservedAt": row.LastObservedAt, "observedRecoveredAt": timeOrNull(row.ObservedRecoveredAt),
		"lastSequence": row.LastSequence, "lastEventId": row.LastEventID,
		"createdAt": row.CreatedAt, "updatedAt": row.UpdatedAt,
	}
}

func mapRows[T any](rows []T, view func(T) map[string]any) []map[string]any {
	out := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		out = append(out, view(row))
	}
	return out
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

type externalConnectionBody struct {
	Name                  string `json:"name"`
	RuntimeKey            string `json:"runtimeKey"`
	SigningCredentialName string `json:"signingCredentialName"`
	Enabled               *bool  `json:"enabled"`
}

func (s *V1Server) parseExternalConnectionBody(r *http.Request, rc v1Request) (store.UpdateExternalRuntimeConnectionParams, bool, *opResult) {
	fail := func(status int, code, message string) *opResult {
		res := opError(status, code, message, nil)
		return &res
	}
	var body externalConnectionBody
	if err := decodeBody(r, &body); err != nil {
		return store.UpdateExternalRuntimeConnectionParams{}, false, fail(http.StatusBadRequest,
			"external_runtime_invalid_request", "invalid external runtime connection")
	}
	name := strings.TrimSpace(body.Name)
	runtimeKey := strings.TrimSpace(body.RuntimeKey)
	credentialName := strings.TrimSpace(body.SigningCredentialName)
	if name == "" || len(name) > externalRuntimeNameMax ||
		runtimeKey == "" || len(runtimeKey) > externalRuntimeKeyMax || !externalRuntimeKeyPattern.MatchString(runtimeKey) ||
		credentialName == "" || len(credentialName) > externalRuntimeCredentialMax {
		return store.UpdateExternalRuntimeConnectionParams{}, false, fail(http.StatusBadRequest,
			"external_runtime_invalid_request", "invalid external runtime connection")
	}
	q := store.New(s.pool)
	credential, err := q.GetCredentialByName(r.Context(), store.GetCredentialByNameParams{
		OrgID: rc.orgID, Kind: "external_runtime_signing_secret", Name: credentialName,
	})
	if err != nil || !secretstore.HasCredentialSecretRef(r.Context(), q, rc.orgID, credential.SecretRef) {
		return store.UpdateExternalRuntimeConnectionParams{}, false, fail(http.StatusUnprocessableEntity,
			"external_runtime_invalid_request", "external runtime signing credential not found")
	}
	enabled := true
	if body.Enabled != nil {
		enabled = *body.Enabled
	}
	return store.UpdateExternalRuntimeConnectionParams{
		Name: name, RuntimeKey: runtimeKey, SigningCredentialName: credentialName, Enabled: enabled,
	}, enabled, nil
}

func (s *V1Server) externalRuntimeCallbackHandler(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := store.New(s.pool)
	connection, err := q.GetExternalRuntimeConnectionForCallback(ctx, r.PathValue("id"))
	if err != nil || !connection.Enabled {
		writeUnversioned(w, opError(http.StatusNotFound, "external_runtime_not_found", "external runtime connection not found", nil))
		return
	}
	secret := ""
	if credential, err := q.GetCredentialByName(ctx, store.GetCredentialByNameParams{
		OrgID: connection.OrgID, Kind: "external_runtime_signing_secret", Name: connection.SigningCredentialName,
	}); err == nil {
		secret = secretstore.ResolveCredentialSecretRef(ctx, q, connection.OrgID, credential.SecretRef)
	}
	rawBody, ok := readRawBody(w, r, externalRuntimeBodyMaxBytes)
	if !ok {
		return
	}
	if !verifyExternalRuntimeSignature(r.Header.Get("x-janusly-signature"), string(rawBody), secret, time.Now().Unix()) {
		writeUnversioned(w, opError(http.StatusUnauthorized, "external_runtime_invalid_signature", "invalid external runtime signature", nil))
		return
	}
	event := parseExternalRuntimeEvent(rawBody)
	if event == nil {
		writeUnversioned(w, opError(http.StatusBadRequest, "external_runtime_invalid_request", "invalid external runtime event", nil))
		return
	}
	if externalIdentitySensitive(event) {
		writeUnversioned(w, opError(http.StatusBadRequest, "external_runtime_invalid_request",
			"external runtime identity contains sensitive material", nil))
		return
	}
	var rawEvent any
	_ = json.Unmarshal(rawBody, &rawEvent)
	result, err := s.recordExternalRuntimeEvent(ctx, connection.OrgID, connection.ID, event, rawEvent)
	if err != nil {
		writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	if result.kind == "connection_not_found" {
		writeUnversioned(w, opError(http.StatusNotFound, "external_runtime_not_found", "external runtime connection not found", nil))
		return
	}
	projectionState := result.kind
	if result.kind == "duplicate" {
		projectionState = result.priorState
	}
	writeUnversioned(w, opResult{status: http.StatusAccepted, data: map[string]any{
		"accepted": true, "duplicate": result.kind == "duplicate",
		"projectionState": projectionState, "eventId": result.eventID,
		"receivedAt": result.receivedAt.Format(time.RFC3339),
	}})
}

func (s *V1Server) mountExternalRuntimeRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /webhooks/external-runtimes/{id}", s.externalRuntimeCallbackHandler)

	mux.HandleFunc("GET /integrations/external-runtimes", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		ctx := r.Context()
		q := store.New(s.pool)
		connections, err := q.ListExternalRuntimeConnections(ctx, rc.orgID)
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		workflows, _ := q.ListExternalWorkflows(ctx, rc.orgID)
		runs, _ := q.ListExternalRuns(ctx, rc.orgID)
		steps, _ := q.ListExternalRunSteps(ctx, rc.orgID)
		cases, _ := q.ListExternalRecoveryCases(ctx, rc.orgID)
		connectionViews := make([]map[string]any, 0, len(connections))
		for _, row := range connections {
			connectionViews = append(connectionViews, externalRuntimeConnectionView(row))
		}
		writeUnversioned(w, opOK(map[string]any{
			"observerOnly": true,
			"connections":  connectionViews,
			"workflows":    mapRows(workflows, externalWorkflowView),
			"runs":         mapRows(runs, externalRunView),
			"steps":        mapRows(steps, externalRunStepView),
			"cases":        mapRows(cases, externalRecoveryCaseView),
		}))
	}))

	mux.HandleFunc("POST /integrations/external-runtimes", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		params, enabled, bad := s.parseExternalConnectionBody(r, rc)
		if bad != nil {
			writeUnversioned(w, *bad)
			return
		}
		_ = enabled
		connection, err := store.New(s.pool).InsertExternalRuntimeConnection(r.Context(), store.InsertExternalRuntimeConnectionParams{
			ID: uuid.NewString(), OrgID: rc.orgID,
			Name: params.Name, RuntimeKey: params.RuntimeKey,
			SigningCredentialName: params.SigningCredentialName, Enabled: params.Enabled,
			CreatedBy: rc.userID,
		})
		if err != nil {
			if isUniqueViolation(err) {
				writeUnversioned(w, opError(http.StatusConflict, "external_runtime_conflict",
					"connection name or runtime key already exists", nil))
				return
			}
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "external_runtime.connection.created", audit.Options{
			TargetType: "external-runtime-connection", TargetID: connection.ID,
			Metadata: map[string]any{"runtimeKey": connection.RuntimeKey, "enabled": connection.Enabled},
		})
		writeUnversioned(w, opResult{status: http.StatusCreated,
			data: map[string]any{"connection": externalRuntimeConnectionView(connection)}})
	}))

	mux.HandleFunc("POST /integrations/external-runtimes/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		q := store.New(s.pool)
		existing, err := q.GetExternalRuntimeConnection(r.Context(), store.GetExternalRuntimeConnectionParams{
			OrgID: rc.orgID, ID: r.PathValue("id"),
		})
		if err != nil {
			writeUnversioned(w, opError(http.StatusNotFound, "external_runtime_not_found", "external runtime connection not found", nil))
			return
		}
		params, _, bad := s.parseExternalConnectionBody(r, rc)
		if bad != nil {
			writeUnversioned(w, *bad)
			return
		}
		params.OrgID, params.ID = rc.orgID, existing.ID
		connection, err := q.UpdateExternalRuntimeConnection(r.Context(), params)
		if err != nil {
			if isUniqueViolation(err) {
				writeUnversioned(w, opError(http.StatusConflict, "external_runtime_conflict",
					"connection name or runtime key already exists", nil))
				return
			}
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "external_runtime.connection.updated", audit.Options{
			TargetType: "external-runtime-connection", TargetID: connection.ID,
			Metadata: map[string]any{
				"before": map[string]any{"runtimeKey": existing.RuntimeKey, "enabled": existing.Enabled},
				"after":  map[string]any{"runtimeKey": connection.RuntimeKey, "enabled": connection.Enabled},
			},
		})
		writeUnversioned(w, opOK(map[string]any{"connection": externalRuntimeConnectionView(connection)}))
	}))

	mux.HandleFunc("DELETE /integrations/external-runtimes/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		deleted, err := store.New(s.pool).DeleteExternalRuntimeConnection(r.Context(), store.DeleteExternalRuntimeConnectionParams{
			OrgID: rc.orgID, ID: r.PathValue("id"),
		})
		if err != nil {
			writeUnversioned(w, opError(http.StatusNotFound, "external_runtime_not_found", "external runtime connection not found", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "external_runtime.connection.deleted", audit.Options{
			TargetType: "external-runtime-connection", TargetID: deleted.ID,
			Metadata: map[string]any{"runtimeKey": deleted.RuntimeKey},
		})
		writeUnversioned(w, opOK(map[string]any{"ok": true}))
	}))
}
