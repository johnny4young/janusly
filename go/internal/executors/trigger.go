// Trigger passthrough executors. Like the reference's trigger family
// (packages/engine/src/triggers.ts), the executor never performs I/O: the
// API ingestion seam accepts the inbound payload, persists the
// trigger_events replay anchor, and spawns the run with the normalized
// event as the run input. The executor just re-validates the authored
// config as a last line of defense and succeeds with
// {triggeredBy, triggeredAt, event} so downstream templates can read
// the inbound data (e.g. {{context.inbox.output.event.payload.total}}).
//
// A manual run start against a trigger-rooted workflow still executes,
// with an empty event — manual start is a separate trigger surface.
package executors

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"
)

var webhookEndpointKeyPattern = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)

const triggerRateLimitMaxPerMin = 10_000

func executeWebhookReceived(_ context.Context, in Input) (any, error) {
	if err := validateWebhookReceivedConfig(in.Config); err != nil {
		return nil, err
	}
	return map[string]any{
		"triggeredBy": "webhook_received",
		"triggeredAt": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		"event":       readTriggerEvent(in.Context),
	}, nil
}

// validateWebhookReceivedConfig mirrors the shared config schema: a
// malformed config that slipped past save-time validation (an operator
// hand-editing advanced JSON) fails the node rather than silently
// succeeding with a half-formed trigger.
func validateWebhookReceivedConfig(config map[string]any) error {
	key, err := ResolveWebhookEndpointKey(config)
	if err != nil {
		return err
	}
	if key == "" {
		return fmt.Errorf("webhook_received.endpointKey is required")
	}
	if raw, present := config["rateLimitPerMin"]; present {
		value, ok := raw.(float64)
		if !ok || value != float64(int64(value)) || value < 1 || value > triggerRateLimitMaxPerMin {
			return fmt.Errorf("webhook_received.rateLimitPerMin must be an integer between 1 and %d", triggerRateLimitMaxPerMin)
		}
	}
	return nil
}

// ResolveWebhookEndpointKey extracts and validates the trimmed endpoint key
// from a webhook_received node config. An absent/empty key returns "", nil
// (the caller decides whether that's fatal); a malformed key errors. The
// ingestion route shares this so save-time, ingest-time, and run-time agree
// on what a key is.
func ResolveWebhookEndpointKey(config map[string]any) (string, error) {
	raw, _ := config["endpointKey"].(string)
	key := strings.TrimSpace(raw)
	if key == "" {
		return "", nil
	}
	if len(key) > 128 {
		return "", fmt.Errorf("webhook_received.endpointKey must be at most 128 characters")
	}
	if !webhookEndpointKeyPattern.MatchString(key) {
		return "", fmt.Errorf("webhook_received.endpointKey must use letters, numbers, dot, dash, or underscore")
	}
	return key, nil
}

// readTriggerEvent pulls the normalized inbound event out of the run input
// (persisted under context.input.event by the ingestion seam). Manual
// starts have no such block — fall back to an empty object.
func readTriggerEvent(runContext map[string]any) map[string]any {
	if input, ok := runContext["input"].(map[string]any); ok {
		if event, ok := input["event"].(map[string]any); ok {
			return event
		}
	}
	return map[string]any{}
}
