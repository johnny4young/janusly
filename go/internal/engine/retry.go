// Retry-policy evaluation, ported from the reference's pure evaluator
// (core/retry-policy.ts): a serialized error maps to label strings (HTTP
// status, status family, name/code, synthetic timeout/network), the node's
// declared policy decides whether to retry, and the delay supports
// exponential backoff, a hard cap, and full jitter in [delay/2, delay].
package engine

import (
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// ExecError is the structured executor error — the Go shape of the
// reference's SerializedError. Executors that know their failure's identity
// (HTTP status, timeout code) return one; plain errors carry message only.
type ExecError struct {
	Message    string
	Name       string
	Code       string
	StatusCode int
	// WriteSide marks an error raised AFTER external effects may have
	// happened (reference runtime.ts: error.writeSide) — the retry ladder
	// must not whole-node retry it; operator-gated replay is safer than
	// duplicate external effects.
	WriteSide bool
}

func (e *ExecError) Error() string { return e.Message }

// serializeError projects any error into the persisted error_json shape.
func serializeError(err error) map[string]any {
	var exec *ExecError
	if errors.As(err, &exec) {
		out := map[string]any{"message": exec.Message, "name": "Error"}
		if exec.Name != "" {
			out["name"] = exec.Name
		}
		if exec.Code != "" {
			out["code"] = exec.Code
		}
		if exec.StatusCode != 0 {
			out["statusCode"] = exec.StatusCode
		}
		if exec.WriteSide {
			out["writeSide"] = true
		}
		return out
	}
	// The reference wire always carries a name (every JS Error has one);
	// Go-side plain errors serialize as the base class.
	return map[string]any{"message": err.Error(), "name": "Error"}
}

// RetryPolicy mirrors the reference's node-config retry shape.
type RetryPolicy struct {
	MaxAttempts int
	DelayMs     float64
	MaxDelayMs  *float64
	Backoff     string
	Jitter      bool
	RetryOn     []string
	IgnoreOn    []string
}

// parseRetryPolicy reads node.config.retry; nil means no policy (no retry).
func parseRetryPolicy(config map[string]any) *RetryPolicy {
	raw, ok := config["retry"].(map[string]any)
	if !ok {
		return nil
	}
	policy := &RetryPolicy{DelayMs: 1000}
	if v, ok := raw["maxAttempts"].(float64); ok {
		policy.MaxAttempts = int(v)
	}
	if v, ok := raw["delayMs"].(float64); ok {
		policy.DelayMs = v
	}
	if v, ok := raw["maxDelayMs"].(float64); ok {
		policy.MaxDelayMs = &v
	}
	if v, ok := raw["backoff"].(string); ok {
		policy.Backoff = v
	}
	if v, ok := raw["jitter"].(bool); ok {
		policy.Jitter = v
	}
	policy.RetryOn = stringList(raw["retryOn"])
	policy.IgnoreOn = stringList(raw["ignoreOn"])
	return policy
}

func stringList(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	var out []string
	for _, item := range items {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

var httpStatusPattern = regexp.MustCompile(`^(\d)xx$`)

// classifyError converts a serialized error into pattern-matching labels:
// name, code, exact status, status family, and the synthetic timeout /
// network flags derived from message wording and well-known codes.
func classifyError(serr map[string]any) []string {
	seen := map[string]bool{}
	var labels []string
	add := func(label string) {
		if label != "" && !seen[label] {
			seen[label] = true
			labels = append(labels, label)
		}
	}
	name, _ := serr["name"].(string)
	code, _ := serr["code"].(string)
	add(name)
	add(code)
	if status, ok := serr["statusCode"].(int); ok && status != 0 {
		add(strconv.Itoa(status))
		add(strconv.Itoa(status/100) + "xx")
	}
	message, _ := serr["message"].(string)
	lower := strings.ToLower(message)
	if strings.Contains(lower, "timeout") || strings.Contains(lower, "timed out") ||
		code == "ETIMEDOUT" || code == "NODE_TIMEOUT" {
		add("timeout")
	}
	if strings.Contains(lower, "network") || code == "ECONNRESET" || code == "ENOTFOUND" {
		add("network")
	}
	return labels
}

func matchesPattern(label, pattern string) bool {
	if label == pattern {
		return true
	}
	match := httpStatusPattern.FindStringSubmatch(pattern)
	if match == nil {
		return false
	}
	return strings.HasPrefix(label, match[1]) && len(label) == 3
}

// shouldRetry honours ignoreOn first, then retryOn (empty retryOn = retry
// everything not ignored); no policy means no retry.
func shouldRetry(serr map[string]any, policy *RetryPolicy) bool {
	if policy == nil {
		return false
	}
	labels := classifyError(serr)
	matchesAny := func(patterns []string) bool {
		for _, pattern := range patterns {
			for _, label := range labels {
				if matchesPattern(label, pattern) {
					return true
				}
			}
		}
		return false
	}
	if matchesAny(policy.IgnoreOn) {
		return false
	}
	if len(policy.RetryOn) == 0 {
		return true
	}
	return matchesAny(policy.RetryOn)
}

// computeRetryDelay returns the next delay in milliseconds; rand supplies
// the jitter sample so tests stay deterministic.
func computeRetryDelay(attempt int, policy *RetryPolicy, rand func() float64) float64 {
	if policy == nil {
		return 0
	}
	raw := policy.DelayMs
	if policy.Backoff == "exponential" {
		raw = policy.DelayMs * math.Pow(2, float64(attempt-1))
	}
	capped := raw
	if policy.MaxDelayMs != nil {
		capped = math.Min(raw, *policy.MaxDelayMs)
	}
	if !policy.Jitter {
		return capped
	}
	min := math.Floor(capped * 0.5)
	return math.Floor(min + rand()*(capped-min))
}
