package domain

import (
	"fmt"
	"strings"
)

const (
	// RetryMaxAttempts is the durable execution ceiling for one node. It
	// includes the first attempt, so 1 explicitly disables retries.
	RetryMaxAttempts = 10
	// RetryMaxDelayMS bounds both an authored cap and the delay ultimately
	// scheduled by the engine, even when maxDelayMs is omitted.
	RetryMaxDelayMS = 3_600_000
	// RetryMaxInitialDelayMS prevents a single authored base delay from
	// bypassing the global one-hour scheduling ceiling.
	RetryMaxInitialDelayMS = 600_000
	RetryMaxMatchers       = 20
	RetryMaxMatcherChars   = 64
	RetryDefaultDelayMS    = 1_000
)

// RetryPolicy is the validated, runtime-safe projection of config.retry.
// Configurations are rejected rather than partially interpreted: persisted
// legacy rows with malformed policies therefore fail closed to no retry.
type RetryPolicy struct {
	MaxAttempts int
	DelayMs     float64
	MaxDelayMs  *float64
	Backoff     string
	Jitter      bool
	RetryOn     []string
	IgnoreOn    []string
}

var retryPolicyKeys = map[string]bool{
	"maxAttempts": true,
	"delayMs":     true,
	"maxDelayMs":  true,
	"backoff":     true,
	"jitter":      true,
	"retryOn":     true,
	"ignoreOn":    true,
}

// ResolveRetryPolicy validates the closed config.retry grammar and returns
// the exact policy consumed by the engine. maxAttempts is required whenever
// retry is present so an editor cannot display resilience that executes zero
// retries. Numeric values must be finite whole milliseconds.
func ResolveRetryPolicy(value any) (*RetryPolicy, error) {
	raw, ok := value.(map[string]any)
	if !ok || raw == nil {
		return nil, fmt.Errorf("config.retry must be an object")
	}
	if len(raw) == 0 {
		return nil, fmt.Errorf("config.retry.maxAttempts is required")
	}
	for key := range raw {
		if !retryPolicyKeys[key] {
			return nil, fmt.Errorf("config.retry contains unsupported field %q", key)
		}
	}

	attempts, present := raw["maxAttempts"]
	if !present || !boundedWholeNumber(attempts, 1, RetryMaxAttempts) {
		return nil, fmt.Errorf("config.retry.maxAttempts must be an integer between 1 and %d", RetryMaxAttempts)
	}
	policy := &RetryPolicy{
		MaxAttempts: int(mustFiniteNumber(attempts)),
		DelayMs:     RetryDefaultDelayMS,
	}
	if delay, present := raw["delayMs"]; present {
		if !boundedWholeNumber(delay, 1, RetryMaxInitialDelayMS) {
			return nil, fmt.Errorf("config.retry.delayMs must be an integer between 1 and %d", RetryMaxInitialDelayMS)
		}
		policy.DelayMs = mustFiniteNumber(delay)
	}
	if maximum, present := raw["maxDelayMs"]; present {
		if !boundedWholeNumber(maximum, 1, RetryMaxDelayMS) {
			return nil, fmt.Errorf("config.retry.maxDelayMs must be an integer between 1 and %d", RetryMaxDelayMS)
		}
		resolved := mustFiniteNumber(maximum)
		policy.MaxDelayMs = &resolved
	}
	if backoff, present := raw["backoff"]; present {
		value, ok := backoff.(string)
		if !ok || (value != "fixed" && value != "exponential") {
			return nil, fmt.Errorf("config.retry.backoff must be fixed or exponential")
		}
		policy.Backoff = value
	}
	if jitter, present := raw["jitter"]; present {
		value, ok := jitter.(bool)
		if !ok {
			return nil, fmt.Errorf("config.retry.jitter must be a boolean")
		}
		policy.Jitter = value
	}
	var err error
	if policy.RetryOn, err = resolveRetryMatchers("retryOn", raw["retryOn"]); err != nil {
		return nil, err
	}
	if policy.IgnoreOn, err = resolveRetryMatchers("ignoreOn", raw["ignoreOn"]); err != nil {
		return nil, err
	}
	return policy, nil
}

func resolveRetryMatchers(field string, value any) ([]string, error) {
	if value == nil {
		return nil, nil
	}
	var items []string
	switch typed := value.(type) {
	case []string:
		items = append(items, typed...)
	case []any:
		items = make([]string, 0, len(typed))
		for _, raw := range typed {
			item, ok := raw.(string)
			if !ok {
				return nil, fmt.Errorf("config.retry.%s must contain only strings", field)
			}
			items = append(items, item)
		}
	default:
		return nil, fmt.Errorf("config.retry.%s must be an array", field)
	}
	if len(items) > RetryMaxMatchers {
		return nil, fmt.Errorf("config.retry.%s must contain at most %d entries", field, RetryMaxMatchers)
	}
	seen := make(map[string]bool, len(items))
	for _, item := range items {
		if item == "" || item != strings.TrimSpace(item) || len([]rune(item)) > RetryMaxMatcherChars {
			return nil, fmt.Errorf("config.retry.%s entries must be 1..%d trimmed characters", field, RetryMaxMatcherChars)
		}
		if seen[item] {
			return nil, fmt.Errorf("config.retry.%s entries must be unique", field)
		}
		seen[item] = true
	}
	return items, nil
}

func mustFiniteNumber(value any) float64 {
	number, _ := validationFiniteNumber(value)
	return number
}
