package domain

import (
	"math"
	"testing"
)

func TestResolveTriggerRateLimitUsesDefaultForInvalidLegacyValues(t *testing.T) {
	for name, value := range map[string]any{
		"absent":     nil,
		"string":     "100",
		"zero":       float64(0),
		"negative":   float64(-1),
		"fractional": float64(1.5),
		"too high":   float64(TriggerRateLimitMaxPerMin + 1),
		"nan":        math.NaN(),
		"infinity":   math.Inf(1),
	} {
		t.Run(name, func(t *testing.T) {
			if got := ResolveTriggerRateLimitPerMin(value); got != TriggerDefaultRateLimitPerMin {
				t.Fatalf("got %d, want safe default %d", got, TriggerDefaultRateLimitPerMin)
			}
		})
	}
}

func TestResolveTriggerRateLimitPreservesValidBoundaries(t *testing.T) {
	for _, value := range []any{float64(1), 60, int64(TriggerRateLimitMaxPerMin)} {
		want, _ := validationFiniteNumber(value)
		if got := ResolveTriggerRateLimitPerMin(value); got != int(want) {
			t.Fatalf("ResolveTriggerRateLimitPerMin(%v) = %d, want %d", value, got, int(want))
		}
	}
}

func TestTriggerSelectorsRejectNonCanonicalValues(t *testing.T) {
	tests := []struct {
		name     string
		nodeType string
		config   map[string]any
	}{
		{name: "webhook key whitespace", nodeType: "webhook_received", config: map[string]any{"endpointKey": " events "}},
		{name: "email alias whitespace", nodeType: "email_received", config: map[string]any{"aliasKey": " alerts "}},
		{name: "email domain whitespace", nodeType: "email_received", config: map[string]any{"aliasKey": "alerts", "fromDomains": []any{" example.com"}}},
		{name: "email duplicate domain", nodeType: "email_received", config: map[string]any{"aliasKey": "alerts", "fromDomains": []any{"Example.com", "example.com"}}},
		{name: "pagerduty credential whitespace", nodeType: "pagerduty_incident", config: map[string]any{"webhookCredential": " webhook "}},
		{name: "file bucket whitespace", nodeType: "file_dropped", config: map[string]any{"bucket": " inbound "}},
		{name: "file extension dot", nodeType: "file_dropped", config: map[string]any{"bucket": "inbound", "extensions": []any{".csv"}}},
		{name: "file duplicate extension", nodeType: "file_dropped", config: map[string]any{"bucket": "inbound", "extensions": []any{"CSV", "csv"}}},
		{name: "mcp alias whitespace", nodeType: "mcp_server_event", config: map[string]any{"connectionAlias": " crm ", "resourceUri": "mcp://crm/accounts"}},
		{name: "mcp resource whitespace", nodeType: "mcp_server_event", config: map[string]any{"connectionAlias": "crm", "resourceUri": " mcp://crm/accounts"}},
		{name: "mcp event whitespace", nodeType: "mcp_server_event", config: map[string]any{"connectionAlias": "crm", "resourceUri": "mcp://crm/accounts", "eventTypes": []any{" updated "}}},
		{name: "mcp duplicate event", nodeType: "mcp_server_event", config: map[string]any{"connectionAlias": "crm", "resourceUri": "mcp://crm/accounts", "eventTypes": []any{"updated", "updated"}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := ValidateTriggerConfig(test.nodeType, test.config); err == nil {
				t.Fatal("non-canonical trigger selector was accepted")
			}
		})
	}
}

func TestTriggerValidationAcceptsIntegerRateLimitFromInternalCallers(t *testing.T) {
	for _, config := range []map[string]any{
		{"endpointKey": "events", "rateLimitPerMin": 25},
		{"endpointKey": "events", "rateLimitPerMin": int32(25)},
		{"endpointKey": "events", "rateLimitPerMin": uint64(25)},
	} {
		if err := ValidateWebhookReceivedConfig(config); err != nil {
			t.Fatalf("integer rate limit rejected: %+v: %v", config, err)
		}
	}
}
