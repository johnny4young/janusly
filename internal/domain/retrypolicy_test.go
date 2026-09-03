package domain

import (
	"math"
	"strings"
	"testing"
)

func TestResolveRetryPolicyAcceptsBoundedContract(t *testing.T) {
	policy, err := ResolveRetryPolicy(map[string]any{
		"maxAttempts": float64(10),
		"delayMs":     float64(600_000),
		"maxDelayMs":  float64(3_600_000),
		"backoff":     "exponential",
		"jitter":      true,
		"retryOn":     []any{"timeout", "5xx"},
		"ignoreOn":    []string{"404"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if policy.MaxAttempts != 10 || policy.DelayMs != 600_000 || policy.MaxDelayMs == nil ||
		*policy.MaxDelayMs != 3_600_000 || policy.Backoff != "exponential" || !policy.Jitter ||
		len(policy.RetryOn) != 2 || len(policy.IgnoreOn) != 1 {
		t.Fatalf("unexpected policy: %+v", policy)
	}

	minimal, err := ResolveRetryPolicy(map[string]any{"maxAttempts": 1})
	if err != nil || minimal.MaxAttempts != 1 || minimal.DelayMs != RetryDefaultDelayMS {
		t.Fatalf("minimal policy: policy=%+v err=%v", minimal, err)
	}
}

func TestResolveRetryPolicyRejectsUnsafeOrAmbiguousConfig(t *testing.T) {
	cases := []struct {
		name string
		raw  any
		want string
	}{
		{"not object", "three", "must be an object"},
		{"empty", map[string]any{}, "maxAttempts is required"},
		{"missing attempts", map[string]any{"delayMs": 5}, "maxAttempts"},
		{"fractional attempts", map[string]any{"maxAttempts": 2.5}, "maxAttempts"},
		{"too many attempts", map[string]any{"maxAttempts": 11}, "maxAttempts"},
		{"not finite delay", map[string]any{"maxAttempts": 2, "delayMs": math.Inf(1)}, "delayMs"},
		{"zero delay", map[string]any{"maxAttempts": 2, "delayMs": 0}, "delayMs"},
		{"oversize delay", map[string]any{"maxAttempts": 2, "delayMs": 600_001}, "delayMs"},
		{"oversize cap", map[string]any{"maxAttempts": 2, "maxDelayMs": 3_600_001}, "maxDelayMs"},
		{"unknown backoff", map[string]any{"maxAttempts": 2, "backoff": "quadratic"}, "backoff"},
		{"non boolean jitter", map[string]any{"maxAttempts": 2, "jitter": "yes"}, "jitter"},
		{"unknown field", map[string]any{"maxAttempts": 2, "forever": true}, "unsupported field"},
		{"matcher scalar", map[string]any{"maxAttempts": 2, "retryOn": "5xx"}, "must be an array"},
		{"matcher wrong type", map[string]any{"maxAttempts": 2, "retryOn": []any{503}}, "only strings"},
		{"matcher whitespace", map[string]any{"maxAttempts": 2, "retryOn": []any{" 5xx"}}, "trimmed"},
		{"matcher duplicate", map[string]any{"maxAttempts": 2, "retryOn": []any{"5xx", "5xx"}}, "unique"},
		{"matcher too long", map[string]any{"maxAttempts": 2, "retryOn": []any{strings.Repeat("x", 65)}}, "1..64"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ResolveRetryPolicy(tc.raw); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("ResolveRetryPolicy(%v) error = %v, want %q", tc.raw, err, tc.want)
			}
		})
	}

	tooMany := make([]any, RetryMaxMatchers+1)
	for index := range tooMany {
		tooMany[index] = strings.Repeat("x", index+1)
	}
	if _, err := ResolveRetryPolicy(map[string]any{"maxAttempts": 2, "ignoreOn": tooMany}); err == nil || !strings.Contains(err.Error(), "at most 20") {
		t.Fatalf("oversized matcher list error = %v", err)
	}
}

func TestWorkflowValidationRejectsInvalidRetryAtSaveBoundary(t *testing.T) {
	result := Validate(parseOK(t, `{"nodes":[
		{"id":"unbounded","type":"noop","config":{"retry":{"maxAttempts":999999999}}},
		{"id":"ambiguous","type":"noop","config":{"retry":{"delayMs":100}}}
	],"edges":[]}`), nil)
	first := requireIssue(t, result, CodeRetryInvalidConfig, "between 1 and 10")
	if first.NodeID != "unbounded" {
		t.Fatalf("unbounded retry issue lost attribution: %+v", first)
	}
	second := 0
	for _, issue := range result.Issues {
		if issue.Code == CodeRetryInvalidConfig && issue.NodeID == "ambiguous" {
			second++
		}
	}
	if second != 1 {
		t.Fatalf("missing ambiguous retry issue: %+v", result.Issues)
	}
}
