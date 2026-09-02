// Provider-signed PagerDuty V3 trigger ingestion (reference
// the API contract + pagerduty-webhooks.ts).
//
// The callback path selects one saved workflow + node. It is NOT
// authority: the exact raw body must verify against the node's
// tenant-scoped Secret Store credential (kind pagerduty_webhook_secret)
// before the shared durable trigger pipeline (webhooks.go
// ingestTriggerEventCore) can persist an event or start a run. Only the
// bounded, non-secret incident projection is persisted — raw webhook
// bodies never land in trigger_events.
package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/executors"
	"github.com/johnny4young/janusly/internal/secretstore"
	"github.com/johnny4young/janusly/internal/store"
	"github.com/johnny4young/janusly/internal/webhooksig"
)

const pagerDutyWebhookBodyMaxBytes = 2 * 1024 * 1024

// verifyPagerDutySignature checks PagerDuty's official V3 contract: one or
// more comma-separated `v1=<hex HMAC-SHA256(raw-body)>` values, each
// compared constant-time. The raw body is verified before JSON parsing.
func verifyPagerDutySignature(rawBody, signatureHeader, secret string) bool {
	if rawBody == "" || signatureHeader == "" {
		return false
	}
	// No timestamp in the V3 posture; every v1= candidate is tried
	// (secret rotation sends several).
	_, candidates := webhooksig.ParseHeader(signatureHeader, "", "v1")
	_, reason := webhooksig.Verify("", candidates, rawBody, secret, 0, webhooksig.Posture{
		Compose: func(_, body string) string { return body },
	})
	return reason == ""
}

// pagerDutyWebhookEvent is the bounded projection extracted from a V3 body.
type pagerDutyWebhookEvent struct {
	eventID       string
	eventType     string
	incidentID    string
	incidentTitle *string
	serviceID     *string
	urgency       *string
	occurredAt    string // canonical RFC3339Nano
}

// parsePagerDutyWebhookBody parses only the durable, non-secret incident
// projection; nil when the body is not a usable V3 incident event.
func parsePagerDutyWebhookBody(rawBody string) *pagerDutyWebhookEvent {
	var parsed struct {
		Event struct {
			ID         string         `json:"id"`
			EventType  string         `json:"event_type"`
			OccurredAt string         `json:"occurred_at"`
			Data       map[string]any `json:"data"`
		} `json:"event"`
	}
	if err := json.Unmarshal([]byte(rawBody), &parsed); err != nil {
		return nil
	}
	event := parsed.Event
	if event.ID == "" || len(event.ID) > 300 || event.EventType == "" || len(event.EventType) > 120 || event.Data == nil {
		return nil
	}
	// The incident record is `data` itself when data.type == "incident",
	// or the nested `data.incident` otherwise.
	incident := event.Data
	if dataType, _ := event.Data["type"].(string); dataType != "incident" {
		nested, _ := event.Data["incident"].(map[string]any)
		incident = nested
	}
	readString := func(record map[string]any, key string, max int, truncate bool) *string {
		if record == nil {
			return nil
		}
		value, ok := record[key].(string)
		if !ok || value == "" {
			return nil
		}
		if len(value) > max {
			if !truncate {
				return nil
			}
			value = truncatePagerDutyWebhookText(value, max)
		}
		return &value
	}
	incidentID := readString(incident, "id", 300, false)
	if incidentID == nil {
		incidentID = readString(event.Data, "id", 300, false)
	}
	if incidentID == nil {
		return nil
	}
	serviceID := (*string)(nil)
	if service, ok := incident["service"].(map[string]any); ok {
		serviceID = readString(service, "id", 300, false)
	}
	if serviceID == nil {
		if service, ok := event.Data["service"].(map[string]any); ok {
			serviceID = readString(service, "id", 300, false)
		}
	}
	title := readString(incident, "title", 2_000, true)
	if title == nil {
		title = readString(event.Data, "title", 2_000, true)
	}
	urgency := readString(incident, "urgency", 100, false)
	if urgency == nil {
		urgency = readString(event.Data, "urgency", 100, false)
	}
	parsedOccurredAt, occurredAtErr := time.Parse(time.RFC3339, event.OccurredAt)
	if occurredAtErr != nil {
		return nil
	}
	occurredAt := parsedOccurredAt.UTC().Format(time.RFC3339Nano)
	return &pagerDutyWebhookEvent{
		eventID: event.ID, eventType: event.EventType, incidentID: *incidentID,
		incidentTitle: title, serviceID: serviceID, urgency: urgency, occurredAt: occurredAt,
	}
}

// parsePagerDutyRoutingEventID extracts only the bounded provider delivery ID.
// Before signature verification this value is untrusted and may only select an
// organization/workflow/node-scoped dedupe row; it never reaches persistence,
// policy evaluation, audit metadata, or a run input.
func parsePagerDutyRoutingEventID(rawBody string) string {
	var parsed struct {
		Event struct {
			ID string `json:"id"`
		} `json:"event"`
	}
	if err := json.Unmarshal([]byte(rawBody), &parsed); err != nil ||
		parsed.Event.ID == "" || len(parsed.Event.ID) > 300 {
		return ""
	}
	return parsed.Event.ID
}

func truncatePagerDutyWebhookText(value string, maxBytes int) string {
	if len(value) <= maxBytes {
		return value
	}
	cut := maxBytes
	for cut > 0 && !utf8.RuneStart(value[cut]) {
		cut--
	}
	return value[:cut]
}

// pagerDutyTriggerEventID gives retries of the same provider delivery the
// same rollout-assignment key before the dedupe row is read. The opaque hash
// also avoids promoting the provider event ID into Janusly's public ID space.
func pagerDutyTriggerEventID(orgID, workflowID, nodeID, providerEventID string) string {
	digest := sha256.Sum256([]byte(strings.Join(
		[]string{orgID, workflowID, nodeID, providerEventID}, "\x00",
	)))
	return "pagerduty_" + hex.EncodeToString(digest[:])
}

// matchPagerDutyTriggerNode binds public-webhook authentication to the exact
// tenant-scoped logical credential name that was verified. Secret material may
// rotate behind that binding, but a save or rollout cannot transfer authority
// to another credential merely by retaining the same node ID and type.
func matchPagerDutyTriggerNode(
	wf *domain.Workflow,
	nodeID string,
	verifiedCredential string,
	noMatch opResult,
) (string, opResult) {
	verifiedCredential = strings.TrimSpace(verifiedCredential)
	if wf == nil || verifiedCredential == "" {
		return "", noMatch
	}
	configuredCredential, ok := pagerDutyWebhookCredentialForNode(wf, nodeID)
	if ok && configuredCredential == verifiedCredential {
		return nodeID, opResult{}
	}
	return "", noMatch
}

func pagerDutyWebhookCredentialForNode(wf *domain.Workflow, nodeID string) (string, bool) {
	if wf == nil {
		return "", false
	}
	for _, node := range wf.Nodes {
		if node.ID != nodeID || node.Type != "pagerduty_incident" ||
			executors.ValidatePagerDutyIncidentConfig(node.Config) != nil {
			continue
		}
		credential, _ := node.Config["webhookCredential"].(string)
		credential = strings.TrimSpace(credential)
		return credential, credential != ""
	}
	return "", false
}

func resolvePagerDutyWebhookSecret(
	ctx context.Context,
	q *store.Queries,
	orgID string,
	credentialName string,
	now time.Time,
) (string, error) {
	credential, err := q.GetCredentialByName(ctx, store.GetCredentialByNameParams{
		OrgID: orgID, Kind: "pagerduty_webhook_secret", Name: strings.TrimSpace(credentialName),
	})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && credential.ExpiresAt != nil && !credential.ExpiresAt.After(now)) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read PagerDuty webhook credential: %w", err)
	}
	secret, err := secretstore.ResolveCredentialSecretRefWithError(ctx, q, orgID, credential.SecretRef)
	if err != nil {
		return "", fmt.Errorf("resolve PagerDuty webhook credential: %w", err)
	}
	return secret, nil
}

func verifyPagerDutyCredential(
	ctx context.Context,
	q *store.Queries,
	orgID string,
	credentialName string,
	now time.Time,
	rawBody string,
	signatureHeader string,
) (bool, error) {
	secret, err := resolvePagerDutyWebhookSecret(ctx, q, orgID, credentialName, now)
	if err != nil {
		return false, err
	}
	return verifyPagerDutySignature(rawBody, signatureHeader, secret), nil
}

// capturedPagerDutyCredential returns the immutable logical credential binding
// (tenant, kind, and name) attached to a previously accepted provider delivery.
// Secret material is intentionally not frozen: rotation revokes the old secret,
// and a retry must authenticate with the binding's current live secret. The
// pre-signature event ID is routing material only; every lookup remains
// tenant/workflow/node scoped and the core later revalidates the same binding
// and persisted snapshot.
func capturedPagerDutyCredential(
	ctx context.Context,
	q *store.Queries,
	orgID string,
	workflowID string,
	nodeID string,
	providerEventID string,
) (string, bool, opResult) {
	if providerEventID == "" {
		return "", false, opResult{}
	}
	existing, err := q.FindTriggerEventByDedupe(ctx, store.FindTriggerEventByDedupeParams{
		OrgID: orgID,
		DedupeKey: pgtype.Text{
			String: "pagerduty:" + workflowID + ":" + nodeID + ":" + providerEventID,
			Valid:  true,
		},
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, opResult{}
	}
	if err != nil {
		return "", false, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	if existing.OrgID != orgID || !existing.WorkflowID.Valid || existing.WorkflowID.String != workflowID ||
		existing.TriggerType != "pagerduty_incident" || existing.NodeID != nodeID {
		return "", false, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	version, err := q.GetWorkflowVersionAnyWorkflow(ctx, store.GetWorkflowVersionAnyWorkflowParams{
		ID: existing.WorkflowVersionID, OrgID: orgID,
	})
	if err != nil || version.WorkflowID != workflowID {
		return "", false, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	wf, _ := domain.Parse(version.DagJson)
	credential, ok := pagerDutyWebhookCredentialForNode(wf, nodeID)
	if !ok {
		return "", false, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	return credential, true, opResult{}
}

// pagerDutyCallbackHandler is the public (signature-authorized) route:
// POST /webhooks/pagerduty/{workflowId}/{nodeId}.
func (s *V1Server) pagerDutyCallbackHandler(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := store.New(s.pool)
	workflowID, nodeID := r.PathValue("workflowId"), r.PathValue("nodeId")
	notFound := opError(http.StatusNotFound, "pagerduty_trigger_not_found", "PagerDuty trigger not found", nil)

	// Resolve the target workflow + trigger node. Unknown and tombstoned
	// answer the same opaque 404.
	ownerState, err := q.GetWorkflowIngestState(ctx, workflowID)
	if errors.Is(err, pgx.ErrNoRows) || ownerState.DeletedAt != nil {
		writeUnversioned(w, notFound)
		return
	}
	if err != nil {
		writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	rawBodyBytes, ok := readRawBody(w, r, pagerDutyWebhookBodyMaxBytes)
	if !ok {
		return
	}
	rawBody := string(rawBodyBytes)
	signatureHeader := r.Header.Get("x-pagerduty-signature")
	now := time.Now().UTC()

	// Try current configuration first for the normal first-delivery path.
	// Missing or invalid latest configuration remains distinguishable only as
	// the existing opaque not-found/unconfigured responses.
	currentCredential := ""
	currentConfigured := false
	currentInvalid := false
	currentResolutionFailed := false
	version, err := q.GetLatestWorkflowVersion(ctx, store.GetLatestWorkflowVersionParams{
		WorkflowID: workflowID, OrgID: ownerState.OrgID,
	})
	if err == nil {
		wf, _ := domain.Parse(version.DagJson)
		if wf == nil {
			currentResolutionFailed = true
		} else {
			for _, node := range wf.Nodes {
				if node.ID == nodeID && node.Type == "pagerduty_incident" {
					currentConfigured = true
					if executors.ValidatePagerDutyIncidentConfig(node.Config) != nil {
						currentInvalid = true
						break
					}
					currentCredential, _ = node.Config["webhookCredential"].(string)
					currentCredential = strings.TrimSpace(currentCredential)
					break
				}
			}
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		currentResolutionFailed = true
	}
	currentVerified := false
	if currentCredential != "" {
		currentVerified, err = verifyPagerDutyCredential(
			ctx, q, ownerState.OrgID, currentCredential, now, rawBody, signatureHeader,
		)
		if err != nil {
			currentResolutionFailed = true
		}
	}

	// An already accepted event owns its logical credential binding. A save or
	// rollout cannot transfer that event to a differently named credential.
	// Rotation within the same binding revokes the old secret, so verification
	// below deliberately resolves its current live secret. The untrusted ID
	// selects only the scoped dedupe row.
	capturedCredential, accepted, capturedResult := capturedPagerDutyCredential(
		ctx, q, ownerState.OrgID, workflowID, nodeID, parsePagerDutyRoutingEventID(rawBody),
	)
	if capturedResult.status != 0 {
		writeUnversioned(w, capturedResult)
		return
	}
	verifiedCredential := currentCredential
	if accepted {
		verifiedCredential = capturedCredential
		verified, verifyErr := verifyPagerDutyCredential(
			ctx, q, ownerState.OrgID, capturedCredential, now, rawBody, signatureHeader,
		)
		if verifyErr != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		if !verified {
			writeUnversioned(w, opError(http.StatusForbidden, "pagerduty_invalid_signature", "invalid PagerDuty signature", nil))
			return
		}
	} else if currentResolutionFailed {
		writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	} else if !currentVerified {
		switch {
		case currentInvalid:
			writeUnversioned(w, opError(http.StatusUnprocessableEntity, "pagerduty_invalid_request",
				"PagerDuty trigger is not configured", nil))
		case !currentConfigured:
			writeUnversioned(w, notFound)
		default:
			writeUnversioned(w, opError(http.StatusForbidden, "pagerduty_invalid_signature", "invalid PagerDuty signature", nil))
		}
		return
	}
	if verifiedCredential == "" {
		writeUnversioned(w, opError(http.StatusForbidden, "pagerduty_invalid_signature", "invalid PagerDuty signature", nil))
		return
	}

	// Only now is the body trusted enough for semantic parsing and durable
	// projection. The raw body itself is never persisted.
	event := parsePagerDutyWebhookBody(rawBody)
	if event == nil {
		writeUnversioned(w, opError(http.StatusBadRequest, "pagerduty_invalid_request", "invalid PagerDuty webhook payload", nil))
		return
	}
	receivedAt := now.Format(time.RFC3339Nano)
	asAny := func(value *string) any {
		if value == nil {
			return nil
		}
		return *value
	}
	eventPayload := map[string]any{
		"eventId": event.eventID, "eventType": event.eventType,
		"incidentId": event.incidentID, "incidentTitle": asAny(event.incidentTitle),
		"serviceId": asAny(event.serviceID), "urgency": asAny(event.urgency),
		"occurredAt": event.occurredAt, "receivedAt": receivedAt,
	}

	// The signature — not a session — is the authority; audits carry the
	// system actor like the contract's system:pagerduty.
	result := s.ingestTriggerEventCore(ctx, triggerIngestRequest{
		orgID:        ownerState.OrgID,
		authContext:  &auth.Context{OrgID: ownerState.OrgID, UserID: "system:pagerduty"},
		createdBy:    "system:pagerduty",
		workflowID:   workflowID,
		triggerType:  "pagerduty_incident",
		eventPayload: eventPayload,
		eventID:      pagerDutyTriggerEventID(ownerState.OrgID, workflowID, nodeID, event.eventID),
		dedupeKey:    "pagerduty:" + workflowID + ":" + nodeID + ":" + event.eventID,
		noMatch:      notFound,
		matchNode: func(candidate *domain.Workflow, noMatch opResult) (string, opResult) {
			return matchPagerDutyTriggerNode(candidate, nodeID, verifiedCredential, noMatch)
		},
	})
	writeUnversioned(w, result)
}
