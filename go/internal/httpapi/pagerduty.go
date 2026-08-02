// Provider-signed PagerDuty V3 trigger ingestion (reference
// apps/api/src/routes/pagerduty-routes.ts + pagerduty-webhooks.ts).
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
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/johnny4young/janusly/go/internal/auth"
	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/executors"
	"github.com/johnny4young/janusly/go/internal/secretstore"
	"github.com/johnny4young/janusly/go/internal/store"
	"github.com/johnny4young/janusly/go/internal/webhooksig"
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
	occurredAt    string // RFC3339 or "" when absent/invalid
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
	readString := func(record map[string]any, key string, max int) *string {
		if record == nil {
			return nil
		}
		value, ok := record[key].(string)
		if !ok || value == "" {
			return nil
		}
		if len(value) > max {
			value = value[:max]
		}
		return &value
	}
	incidentID := readString(incident, "id", 300)
	if incidentID == nil {
		incidentID = readString(event.Data, "id", 300)
	}
	if incidentID == nil {
		return nil
	}
	serviceID := (*string)(nil)
	if service, ok := incident["service"].(map[string]any); ok {
		serviceID = readString(service, "id", 300)
	}
	if serviceID == nil {
		if service, ok := event.Data["service"].(map[string]any); ok {
			serviceID = readString(service, "id", 300)
		}
	}
	title := readString(incident, "title", 2_000)
	if title == nil {
		title = readString(event.Data, "title", 2_000)
	}
	urgency := readString(incident, "urgency", 100)
	if urgency == nil {
		urgency = readString(event.Data, "urgency", 100)
	}
	occurredAt := ""
	if event.OccurredAt != "" {
		if parsedAt, err := time.Parse(time.RFC3339, event.OccurredAt); err == nil {
			occurredAt = parsedAt.UTC().Format(time.RFC3339)
		}
	}
	return &pagerDutyWebhookEvent{
		eventID: event.ID, eventType: event.EventType, incidentID: *incidentID,
		incidentTitle: title, serviceID: serviceID, urgency: urgency, occurredAt: occurredAt,
	}
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
	if err != nil || ownerState.DeletedAt != nil {
		writeLegacy(w, notFound)
		return
	}
	version, err := q.GetLatestWorkflowVersion(ctx, store.GetLatestWorkflowVersionParams{
		WorkflowID: workflowID, OrgID: ownerState.OrgID,
	})
	if err != nil {
		writeLegacy(w, notFound)
		return
	}
	wf, _ := domain.Parse(version.DagJson)
	var nodeConfig map[string]any
	if wf != nil {
		for _, node := range wf.Nodes {
			if node.ID == nodeID && node.Type == "pagerduty_incident" {
				nodeConfig = node.Config
				break
			}
		}
	}
	if nodeConfig == nil {
		writeLegacy(w, notFound)
		return
	}
	if err := executors.ValidatePagerDutyIncidentConfig(nodeConfig); err != nil {
		writeLegacy(w, opError(http.StatusUnprocessableEntity, "pagerduty_invalid_request",
			"PagerDuty trigger is not configured", nil))
		return
	}
	webhookCredential, _ := nodeConfig["webhookCredential"].(string)

	// The signing value stays in Secret Store; an unresolvable credential
	// simply fails verification (never leaks WHY).
	signingSecret := ""
	if credential, err := q.GetCredentialByName(ctx, store.GetCredentialByNameParams{
		OrgID: ownerState.OrgID, Kind: "pagerduty_webhook_secret", Name: strings.TrimSpace(webhookCredential),
	}); err == nil {
		signingSecret = secretstore.ResolveCredentialSecretRef(ctx, q, ownerState.OrgID, credential.SecretRef)
	}
	rawBody, _ := io.ReadAll(io.LimitReader(r.Body, pagerDutyWebhookBodyMaxBytes))
	if !verifyPagerDutySignature(string(rawBody), r.Header.Get("x-pagerduty-signature"), signingSecret) {
		writeLegacy(w, opError(http.StatusForbidden, "pagerduty_invalid_signature", "invalid PagerDuty signature", nil))
		return
	}

	event := parsePagerDutyWebhookBody(string(rawBody))
	if event == nil {
		writeLegacy(w, opError(http.StatusBadRequest, "pagerduty_invalid_request", "invalid PagerDuty webhook payload", nil))
		return
	}
	receivedAt := time.Now().UTC().Format(time.RFC3339)
	occurredAt := event.occurredAt
	if occurredAt == "" {
		occurredAt = receivedAt
	}
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
		"occurredAt": occurredAt, "receivedAt": receivedAt,
	}

	// The signature — not a session — is the authority; audits carry the
	// system actor like the reference's system:pagerduty.
	result := s.ingestTriggerEventCore(ctx, triggerIngestRequest{
		orgID:        ownerState.OrgID,
		authContext:  &auth.Context{OrgID: ownerState.OrgID, UserID: "system:pagerduty"},
		createdBy:    "system:pagerduty",
		workflowID:   workflowID,
		triggerType:  "pagerduty_incident",
		eventPayload: eventPayload,
		dedupeKey:    "pagerduty:" + workflowID + ":" + nodeID + ":" + event.eventID,
		noMatch:      notFound,
		matchNode: func(candidate *domain.Workflow, noMatch opResult) (string, opResult) {
			for _, node := range candidate.Nodes {
				if node.ID == nodeID && node.Type == "pagerduty_incident" {
					return node.ID, opResult{}
				}
			}
			return "", noMatch
		},
	})
	writeLegacy(w, result)
}
