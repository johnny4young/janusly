package httpapi

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/johnny4young/janusly/internal/domain"
)

func TestVerifyPagerDutySignatureRequiresResolvedSecret(t *testing.T) {
	t.Parallel()
	const body = `{"event":{"id":"evt-1"}}`
	sign := func(secret string) string {
		mac := hmac.New(sha256.New, []byte(secret))
		_, _ = mac.Write([]byte(body))
		return "v1=" + hex.EncodeToString(mac.Sum(nil))
	}
	if !verifyPagerDutySignature(body, sign("configured-secret"), "configured-secret") {
		t.Fatal("valid signature with a resolved secret was rejected")
	}
	if verifyPagerDutySignature(body, sign(""), "") {
		t.Fatal("an unresolved credential must not turn the empty string into a signing key")
	}
}

func TestParsePagerDutyWebhookBodyPreservesFractionalTimeAndValidUTF8(t *testing.T) {
	t.Parallel()
	title := strings.Repeat("a", 1_999) + "é-tail"
	body := `{"event":{"id":"evt-1","event_type":"incident.triggered","occurred_at":"2026-01-10T03:00:00.123456789-05:00","data":{"type":"incident","id":"PINC1","title":"` + title + `"}}}`
	event := parsePagerDutyWebhookBody(body)
	if event == nil || event.incidentTitle == nil {
		t.Fatalf("valid event rejected: %+v", event)
	}
	if event.occurredAt != "2026-01-10T08:00:00.123456789Z" {
		t.Fatalf("fractional occurrence precision lost: %q", event.occurredAt)
	}
	if len(*event.incidentTitle) > 2_000 || !utf8.ValidString(*event.incidentTitle) || !strings.HasSuffix(*event.incidentTitle, "a") {
		t.Fatalf("title was not bounded on a UTF-8 boundary: bytes=%d valid=%v suffix=%q", len(*event.incidentTitle), utf8.ValidString(*event.incidentTitle), (*event.incidentTitle)[len(*event.incidentTitle)-1:])
	}
}

func TestParsePagerDutyRoutingEventIDIsBoundedAndSemanticFree(t *testing.T) {
	t.Parallel()
	if got := parsePagerDutyRoutingEventID(`{"event":{"id":"evt-accepted","event_type":7,"data":"untrusted"}}`); got != "evt-accepted" {
		t.Fatalf("routing ID should not depend on untrusted semantics: %q", got)
	}
	for _, body := range []string{
		`{"event":{}}`,
		`{"event":{"id":7}}`,
		`{"event":{"id":"` + strings.Repeat("x", 301) + `"}}`,
		`not-json`,
	} {
		if got := parsePagerDutyRoutingEventID(body); got != "" {
			t.Fatalf("invalid routing ID escaped the bound: %q", got)
		}
	}
}

func TestPagerDutyTriggerEventIDIsStableAndTenantScoped(t *testing.T) {
	t.Parallel()
	first := pagerDutyTriggerEventID("org-1", "workflow-1", "trigger-1", "event-1")
	if first != pagerDutyTriggerEventID("org-1", "workflow-1", "trigger-1", "event-1") {
		t.Fatal("the same provider delivery must keep one rollout assignment key")
	}
	if first == pagerDutyTriggerEventID("org-2", "workflow-1", "trigger-1", "event-1") ||
		first == pagerDutyTriggerEventID("org-1", "workflow-1", "trigger-1", "event-2") {
		t.Fatal("event identity must be scoped by tenant and provider delivery")
	}
	if !strings.HasPrefix(first, "pagerduty_") || len(first) != len("pagerduty_")+sha256.Size*2 {
		t.Fatalf("unexpected bounded event id %q", first)
	}
}

func TestMatchPagerDutyTriggerNodeRequiresVerifiedCredentialIdentity(t *testing.T) {
	t.Parallel()
	wf := &domain.Workflow{Nodes: []domain.Node{{
		ID: "on_pagerduty", Type: "pagerduty_incident",
		Config: map[string]any{"webhookCredential": "current-secret", "rateLimitPerMin": 120.0},
	}}}
	noMatch := opError(409, "trigger_no_matching_node", "mismatch", nil)
	if nodeID, result := matchPagerDutyTriggerNode(wf, "on_pagerduty", "current-secret", noMatch); nodeID != "on_pagerduty" || result.status != 0 {
		t.Fatalf("matching credential was rejected: node=%q result=%+v", nodeID, result)
	}
	if nodeID, result := matchPagerDutyTriggerNode(wf, "on_pagerduty", "retired-secret", noMatch); nodeID != "" || result.status != 409 {
		t.Fatalf("a rollout version inherited authority from another credential: node=%q result=%+v", nodeID, result)
	}
}
