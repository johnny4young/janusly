package domain

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	webhookEndpointKeyPattern = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)
	emailAliasKeyPattern      = regexp.MustCompile(`^[a-zA-Z0-9._+-]+$`)
)

const (
	TriggerDefaultRateLimitPerMin = 60
	TriggerRateLimitMaxPerMin     = 10_000
)

// ValidateTriggerConfig is the single shape grammar shared by workflow
// validation, inbound trigger lookup and the trigger executors.
func ValidateTriggerConfig(nodeType string, config map[string]any) error {
	switch nodeType {
	case "webhook_received":
		return ValidateWebhookReceivedConfig(config)
	case "email_received":
		return ValidateEmailReceivedConfig(config)
	case "file_dropped":
		return ValidateFileDroppedConfig(config)
	case "mcp_server_event":
		return ValidateMcpServerEventConfig(config)
	case "pagerduty_incident":
		return ValidatePagerDutyIncidentConfig(config)
	default:
		return fmt.Errorf("unsupported trigger node type %q", nodeType)
	}
}

func ValidateWebhookReceivedConfig(config map[string]any) error {
	key, err := ResolveWebhookEndpointKey(config)
	if err != nil {
		return err
	}
	if key == "" {
		return fmt.Errorf("webhook_received.endpointKey is required")
	}
	return validateTriggerRateLimit("webhook_received", config)
}

// ResolveWebhookEndpointKey extracts the canonical endpoint key. An absent
// key is left to the caller to classify as required versus optional.
func ResolveWebhookEndpointKey(config map[string]any) (string, error) {
	value, present := config["endpointKey"]
	if !present {
		return "", nil
	}
	raw, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("webhook_received.endpointKey must be a string")
	}
	key := strings.TrimSpace(raw)
	if key == "" {
		return "", nil
	}
	if key != raw {
		return "", fmt.Errorf("webhook_received.endpointKey must not have leading or trailing whitespace")
	}
	if len(key) > 128 {
		return "", fmt.Errorf("webhook_received.endpointKey must be at most 128 characters")
	}
	if !webhookEndpointKeyPattern.MatchString(key) {
		return "", fmt.Errorf("webhook_received.endpointKey must use letters, numbers, dot, dash, or underscore")
	}
	return key, nil
}

func ValidateEmailReceivedConfig(config map[string]any) error {
	raw, _ := config["aliasKey"].(string)
	aliasKey := strings.TrimSpace(raw)
	if aliasKey == "" || len(aliasKey) > 128 || !emailAliasKeyPattern.MatchString(aliasKey) {
		return fmt.Errorf("email_received.aliasKey must be a valid email local-part")
	}
	if aliasKey != raw {
		return fmt.Errorf("email_received.aliasKey must not have leading or trailing whitespace")
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
		seen := map[string]bool{}
		for _, rawDomain := range domains {
			domain, ok := rawDomain.(string)
			trimmed := strings.TrimSpace(domain)
			if !ok || trimmed == "" {
				return fmt.Errorf("email_received.fromDomains entries must be non-empty strings")
			}
			if domain != trimmed {
				return fmt.Errorf("email_received.fromDomains entries must not have leading or trailing whitespace")
			}
			key := strings.ToLower(domain)
			if seen[key] {
				return fmt.Errorf("email_received.fromDomains entries must be unique")
			}
			seen[key] = true
		}
	}
	return validateTriggerRateLimit("email_received", config)
}

func ValidatePagerDutyIncidentConfig(config map[string]any) error {
	raw, _ := config["webhookCredential"].(string)
	credential := strings.TrimSpace(raw)
	if credential == "" || len(credential) > 200 {
		return fmt.Errorf("pagerduty_incident.webhookCredential is required")
	}
	if credential != raw {
		return fmt.Errorf("pagerduty_incident.webhookCredential must not have leading or trailing whitespace")
	}
	return validateTriggerRateLimit("pagerduty_incident", config)
}

func ValidateFileDroppedConfig(config map[string]any) error {
	bucket, _ := config["bucket"].(string)
	if strings.TrimSpace(bucket) == "" || len(bucket) > 256 {
		return fmt.Errorf("file_dropped.bucket is required")
	}
	if bucket != strings.TrimSpace(bucket) {
		return fmt.Errorf("file_dropped.bucket must not have leading or trailing whitespace")
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
		seen := map[string]bool{}
		for _, rawExtension := range extensions {
			extension, ok := rawExtension.(string)
			trimmed := strings.TrimSpace(extension)
			if !ok || trimmed == "" || len(extension) > 32 {
				return fmt.Errorf("file_dropped.extensions entries must be short non-empty strings")
			}
			if extension != trimmed || strings.HasPrefix(extension, ".") {
				return fmt.Errorf("file_dropped.extensions entries must be canonical suffixes without whitespace or a leading dot")
			}
			key := strings.ToLower(extension)
			if seen[key] {
				return fmt.Errorf("file_dropped.extensions entries must be unique")
			}
			seen[key] = true
		}
	}
	return validateTriggerRateLimit("file_dropped", config)
}

func ValidateMcpServerEventConfig(config map[string]any) error {
	alias, _ := config["connectionAlias"].(string)
	if strings.TrimSpace(alias) == "" || len(alias) > 128 {
		return fmt.Errorf("mcp_server_event.connectionAlias is required")
	}
	if alias != strings.TrimSpace(alias) {
		return fmt.Errorf("mcp_server_event.connectionAlias must not have leading or trailing whitespace")
	}
	resourceURI, _ := config["resourceUri"].(string)
	if strings.TrimSpace(resourceURI) == "" || len(resourceURI) > 2048 {
		return fmt.Errorf("mcp_server_event.resourceUri is required")
	}
	if resourceURI != strings.TrimSpace(resourceURI) {
		return fmt.Errorf("mcp_server_event.resourceUri must not have leading or trailing whitespace")
	}
	if raw, present := config["eventTypes"]; present {
		eventTypes, ok := raw.([]any)
		if !ok || len(eventTypes) > 20 {
			return fmt.Errorf("mcp_server_event.eventTypes must list at most 20 entries")
		}
		seen := map[string]bool{}
		for _, rawType := range eventTypes {
			eventType, ok := rawType.(string)
			trimmed := strings.TrimSpace(eventType)
			if !ok || trimmed == "" || len(eventType) > 128 {
				return fmt.Errorf("mcp_server_event.eventTypes entries must be non-empty strings")
			}
			if eventType != trimmed {
				return fmt.Errorf("mcp_server_event.eventTypes entries must not have leading or trailing whitespace")
			}
			if seen[eventType] {
				return fmt.Errorf("mcp_server_event.eventTypes entries must be unique")
			}
			seen[eventType] = true
		}
	}
	return validateTriggerRateLimit("mcp_server_event", config)
}

func validateTriggerRateLimit(nodeType string, config map[string]any) error {
	if raw, present := config["rateLimitPerMin"]; present {
		if !boundedWholeNumber(raw, 1, TriggerRateLimitMaxPerMin) {
			return fmt.Errorf("%s.rateLimitPerMin must be an integer between 1 and %d", nodeType, TriggerRateLimitMaxPerMin)
		}
	}
	return nil
}

// ResolveTriggerRateLimitPerMin returns the bounded storm-guard value. Invalid
// persisted legacy input uses the default; save-time validation rejects it for
// new versions.
func ResolveTriggerRateLimitPerMin(rateLimitPerMin any) int {
	if !boundedWholeNumber(rateLimitPerMin, 1, TriggerRateLimitMaxPerMin) {
		return TriggerDefaultRateLimitPerMin
	}
	value, _ := validationFiniteNumber(rateLimitPerMin)
	return int(value)
}
