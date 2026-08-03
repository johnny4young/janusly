package executors

import (
	"context"
	"strings"
	"testing"
)

func TestWebhookReceivedConfigValidation(t *testing.T) {
	cases := []struct {
		name    string
		config  map[string]any
		wantErr string
	}{
		{"missing key", map[string]any{}, "endpointKey is required"},
		{"whitespace key", map[string]any{"endpointKey": "  "}, "endpointKey is required"},
		{"illegal chars", map[string]any{"endpointKey": "orders/v1"}, "letters, numbers, dot, dash, or underscore"},
		{"too long", map[string]any{"endpointKey": strings.Repeat("a", 129)}, "at most 128"},
		{"bad rate limit", map[string]any{"endpointKey": "ok", "rateLimitPerMin": 0.5}, "rateLimitPerMin"},
		{"rate limit too high", map[string]any{"endpointKey": "ok", "rateLimitPerMin": float64(10001)}, "rateLimitPerMin"},
		{"valid", map[string]any{"endpointKey": "orders.v1_final-2", "rateLimitPerMin": float64(60)}, ""},
	}
	for _, tc := range cases {
		_, err := executeWebhookReceived(context.Background(), Input{Config: tc.config, Context: map[string]any{}})
		if tc.wantErr == "" {
			if err != nil {
				t.Fatalf("%s: unexpected error %v", tc.name, err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
			t.Fatalf("%s: got %v, want %q", tc.name, err, tc.wantErr)
		}
	}
}

func TestWebhookReceivedPassesEventThrough(t *testing.T) {
	out, err := executeWebhookReceived(context.Background(), Input{
		Config: map[string]any{"endpointKey": "orders"},
		Context: map[string]any{"input": map[string]any{
			"event": map[string]any{"eventId": "e1", "payload": map[string]any{"n": float64(2)}},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	result := out.(map[string]any)
	event := result["event"].(map[string]any)
	if result["triggeredBy"] != "webhook_received" || event["eventId"] != "e1" {
		t.Fatalf("passthrough shape: %+v", result)
	}
	if _, ok := result["triggeredAt"].(string); !ok {
		t.Fatalf("triggeredAt missing: %+v", result)
	}
}

func TestScheduleUsesCanonicalConfigAndOutput(t *testing.T) {
	out, err := executeSchedule(context.Background(), Input{Config: map[string]any{
		"cronExpression": " 0 9 1 * * ", "enabled": false,
	}})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	result := out.(map[string]any)
	if result["cronExpression"] != "0 9 1 * *" {
		t.Fatalf("cron output: %+v", result)
	}
	if _, ok := result["triggeredAt"].(string); !ok {
		t.Fatalf("triggeredAt missing: %+v", result)
	}
	if _, legacy := result["triggeredBy"]; legacy {
		t.Fatalf("schedule output must not use the event-trigger envelope: %+v", result)
	}
}
