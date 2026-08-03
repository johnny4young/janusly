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

	"github.com/johnny4young/janusly/internal/domain"
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

var emailAliasKeyPattern = regexp.MustCompile(`^[a-zA-Z0-9._+-]+$`)

func executeEmailReceived(_ context.Context, in Input) (any, error) {
	if err := ValidateEmailReceivedConfig(in.Config); err != nil {
		return nil, err
	}
	return map[string]any{
		"triggeredBy": "email_received",
		"triggeredAt": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		"event":       readTriggerEvent(in.Context),
	}, nil
}

// ValidateEmailReceivedConfig mirrors the shared config schema: aliasKey
// is the per-org inbound local-part; dkimRequired defaults to true (the
// ingestion seam enforces it); fromDomains is a bounded allow-list.
func ValidateEmailReceivedConfig(config map[string]any) error {
	raw, _ := config["aliasKey"].(string)
	aliasKey := strings.TrimSpace(raw)
	if aliasKey == "" || len(aliasKey) > 128 || !emailAliasKeyPattern.MatchString(aliasKey) {
		return fmt.Errorf("email_received.aliasKey must be a valid email local-part")
	}
	if raw, present := config["dkimRequired"]; present {
		if _, ok := raw.(bool); !ok {
			return fmt.Errorf("email_received.dkimRequired must be a boolean")
		}
	}
	if raw, present := config["fromDomains"]; present {
		domains, ok := raw.([]any)
		if !ok || len(domains) > 50 {
			return fmt.Errorf("email_received.fromDomains must list at most 50 domains")
		}
		for _, rawDomain := range domains {
			domain, ok := rawDomain.(string)
			if !ok || strings.TrimSpace(domain) == "" {
				return fmt.Errorf("email_received.fromDomains entries must be non-empty strings")
			}
		}
	}
	if raw, present := config["rateLimitPerMin"]; present {
		value, ok := raw.(float64)
		if !ok || value != float64(int64(value)) || value < 1 || value > triggerRateLimitMaxPerMin {
			return fmt.Errorf("email_received.rateLimitPerMin must be an integer between 1 and %d", triggerRateLimitMaxPerMin)
		}
	}
	return nil
}

func executePagerDutyIncident(_ context.Context, in Input) (any, error) {
	if err := ValidatePagerDutyIncidentConfig(in.Config); err != nil {
		return nil, err
	}
	return map[string]any{
		"triggeredBy": "pagerduty_incident",
		"triggeredAt": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		"event":       readTriggerEvent(in.Context),
	}, nil
}

// ValidatePagerDutyIncidentConfig mirrors the shared config schema: the
// signing value stays in Secret Store under `webhookCredential` (kind
// pagerduty_webhook_secret); the callback URL derives from workflow+node
// ids. The ingestion route shares this so save-time, ingest-time, and
// run-time agree.
func ValidatePagerDutyIncidentConfig(config map[string]any) error {
	raw, _ := config["webhookCredential"].(string)
	credential := strings.TrimSpace(raw)
	if credential == "" || len(credential) > 200 {
		return fmt.Errorf("pagerduty_incident.webhookCredential is required")
	}
	if raw, present := config["rateLimitPerMin"]; present {
		value, ok := raw.(float64)
		if !ok || value != float64(int64(value)) || value < 1 || value > triggerRateLimitMaxPerMin {
			return fmt.Errorf("pagerduty_incident.rateLimitPerMin must be an integer between 1 and %d", triggerRateLimitMaxPerMin)
		}
	}
	return nil
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

func executeFileDropped(_ context.Context, in Input) (any, error) {
	if err := ValidateFileDroppedConfig(in.Config); err != nil {
		return nil, err
	}
	return map[string]any{
		"triggeredBy": "file_dropped",
		"triggeredAt": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		"event":       readTriggerEvent(in.Context),
	}, nil
}

// ValidateFileDroppedConfig mirrors the shared config schema: bucket +
// optional prefix scope the notifications; extensions is a bounded
// dot-less allow-list.
func ValidateFileDroppedConfig(config map[string]any) error {
	bucket, _ := config["bucket"].(string)
	if strings.TrimSpace(bucket) == "" || len(bucket) > 256 {
		return fmt.Errorf("file_dropped.bucket is required")
	}
	if raw, present := config["prefix"]; present {
		if prefix, ok := raw.(string); !ok || len(prefix) > 1024 {
			return fmt.Errorf("file_dropped.prefix must be a string of at most 1024 characters")
		}
	}
	if raw, present := config["extensions"]; present {
		extensions, ok := raw.([]any)
		if !ok || len(extensions) > 50 {
			return fmt.Errorf("file_dropped.extensions must list at most 50 entries")
		}
		for _, rawExtension := range extensions {
			extension, ok := rawExtension.(string)
			if !ok || strings.TrimSpace(extension) == "" || len(extension) > 32 {
				return fmt.Errorf("file_dropped.extensions entries must be short non-empty strings")
			}
		}
	}
	return validateTriggerRateLimit("file_dropped", config)
}

func executeMcpServerEvent(_ context.Context, in Input) (any, error) {
	if err := ValidateMcpServerEventConfig(in.Config); err != nil {
		return nil, err
	}
	return map[string]any{
		"triggeredBy": "mcp_server_event",
		"triggeredAt": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		"event":       readTriggerEvent(in.Context),
	}, nil
}

// ValidateMcpServerEventConfig mirrors the shared config schema:
// connectionAlias references a registered mcp_connections row and
// resourceUri is the subscribed MCP resource; eventTypes optionally
// filters notification method names.
func ValidateMcpServerEventConfig(config map[string]any) error {
	alias, _ := config["connectionAlias"].(string)
	if strings.TrimSpace(alias) == "" || len(alias) > 128 {
		return fmt.Errorf("mcp_server_event.connectionAlias is required")
	}
	resourceURI, _ := config["resourceUri"].(string)
	if strings.TrimSpace(resourceURI) == "" || len(resourceURI) > 2048 {
		return fmt.Errorf("mcp_server_event.resourceUri is required")
	}
	if raw, present := config["eventTypes"]; present {
		eventTypes, ok := raw.([]any)
		if !ok || len(eventTypes) > 20 {
			return fmt.Errorf("mcp_server_event.eventTypes must list at most 20 entries")
		}
		for _, rawType := range eventTypes {
			eventType, ok := rawType.(string)
			if !ok || strings.TrimSpace(eventType) == "" || len(eventType) > 128 {
				return fmt.Errorf("mcp_server_event.eventTypes entries must be non-empty strings")
			}
		}
	}
	return validateTriggerRateLimit("mcp_server_event", config)
}

func executeSchedule(_ context.Context, in Input) (any, error) {
	config, err := domain.ResolveScheduleConfig(in.Config)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"triggeredAt":    time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		"cronExpression": config.CronExpression,
	}, nil
}

// validateTriggerRateLimit is the shared optional rateLimitPerMin check.
func validateTriggerRateLimit(nodeType string, config map[string]any) error {
	if raw, present := config["rateLimitPerMin"]; present {
		value, ok := raw.(float64)
		if !ok || value != float64(int64(value)) || value < 1 || value > triggerRateLimitMaxPerMin {
			return fmt.Errorf("%s.rateLimitPerMin must be an integer between 1 and %d", nodeType, triggerRateLimitMaxPerMin)
		}
	}
	return nil
}

// Storm-guard clamp, ported from the reference's shared trigger-types:
// the effective per-trigger rate limit from a node config's optional
// rateLimitPerMin — default 60, clamped to [1, 10000].
const (
	TriggerDefaultRateLimitPerMin = 60
	TriggerRateLimitMaxPerMin     = 10_000
)

// ResolveTriggerRateLimitPerMin clamps a config value into the documented
// range, falling back to the default when unset or invalid.
func ResolveTriggerRateLimitPerMin(rateLimitPerMin any) int {
	value, ok := rateLimitPerMin.(float64)
	if !ok {
		return TriggerDefaultRateLimitPerMin
	}
	floored := int(value)
	if floored < 1 {
		return 1
	}
	if floored > TriggerRateLimitMaxPerMin {
		return TriggerRateLimitMaxPerMin
	}
	return floored
}
