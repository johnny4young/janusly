package engine

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/go/internal/grammar"
)

// Cases port core/retry-policy.ts semantics; the delay math and jitter use
// injected randomness — no real clocks or sleeps anywhere.

func policyFromConfig(t *testing.T, config map[string]any) *RetryPolicy {
	t.Helper()
	policy := parseRetryPolicy(config)
	if policy == nil {
		t.Fatal("expected a policy")
	}
	return policy
}

func TestClassifyErrorLabels(t *testing.T) {
	cases := []struct {
		name string
		serr map[string]any
		want []string
	}{
		{"name and code", map[string]any{"message": "x", "name": "TypeError", "code": "E_X"},
			[]string{"TypeError", "E_X"}},
		{"status plus family", map[string]any{"message": "x", "statusCode": 503},
			[]string{"503", "5xx"}},
		{"timeout wording", map[string]any{"message": "request timed out"},
			[]string{"timeout"}},
		{"timeout code", map[string]any{"message": "x", "code": "ETIMEDOUT"},
			[]string{"ETIMEDOUT", "timeout"}},
		{"network code", map[string]any{"message": "x", "code": "ECONNRESET"},
			[]string{"ECONNRESET", "network"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifyError(tc.serr); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

func TestShouldRetryHonoursIgnoreThenRetryPatterns(t *testing.T) {
	serr := map[string]any{"message": "upstream failed", "statusCode": 503}
	if shouldRetry(serr, nil) {
		t.Fatal("no policy must mean no retry")
	}
	all := policyFromConfig(t, map[string]any{"retry": map[string]any{"maxAttempts": float64(3)}})
	if !shouldRetry(serr, all) {
		t.Fatal("empty retryOn retries everything not ignored")
	}
	ignored := policyFromConfig(t, map[string]any{"retry": map[string]any{
		"maxAttempts": float64(3), "ignoreOn": []any{"5xx"},
	}})
	if shouldRetry(serr, ignored) {
		t.Fatal("ignoreOn must win")
	}
	scoped := policyFromConfig(t, map[string]any{"retry": map[string]any{
		"maxAttempts": float64(3), "retryOn": []any{"timeout", "5xx"},
	}})
	if !shouldRetry(serr, scoped) {
		t.Fatal("5xx pattern must match 503")
	}
	if shouldRetry(map[string]any{"message": "bad input", "statusCode": 400}, scoped) {
		t.Fatal("4xx must not match a 5xx/timeout policy")
	}
}

func TestStatusFamilyPatternMatchesOnlyThreeDigitLabels(t *testing.T) {
	// matchesPattern: `5xx` matches 500–599 labels, never "50" or "5000".
	if !matchesPattern("503", "5xx") || matchesPattern("50", "5xx") || matchesPattern("5000", "5xx") {
		t.Fatal("family pattern must require exactly three digits")
	}
	if !matchesPattern("ETIMEDOUT", "ETIMEDOUT") || matchesPattern("ETIMEDOUT", "4xx") {
		t.Fatal("exact labels must match themselves only")
	}
}

func TestComputeRetryDelayLadder(t *testing.T) {
	fixedRand := func() float64 { return 0 }
	if got := computeRetryDelay(2, nil, fixedRand); got != 0 {
		t.Fatalf("no policy must mean zero delay, got %v", got)
	}
	fixed := policyFromConfig(t, map[string]any{"retry": map[string]any{"delayMs": float64(500)}})
	if got := computeRetryDelay(4, fixed, fixedRand); got != 500 {
		t.Fatalf("fixed backoff ignores attempt, got %v", got)
	}
	expo := policyFromConfig(t, map[string]any{"retry": map[string]any{
		"delayMs": float64(1000), "backoff": "exponential",
	}})
	for attempt, want := range map[int]float64{1: 1000, 2: 2000, 3: 4000, 4: 8000} {
		if got := computeRetryDelay(attempt, expo, fixedRand); got != want {
			t.Fatalf("attempt %d: got %v want %v", attempt, got, want)
		}
	}
	capped := policyFromConfig(t, map[string]any{"retry": map[string]any{
		"delayMs": float64(1000), "backoff": "exponential", "maxDelayMs": float64(3000),
	}})
	if got := computeRetryDelay(4, capped, fixedRand); got != 3000 {
		t.Fatalf("cap must bound the ladder, got %v", got)
	}
}

func TestComputeRetryDelayFullJitterRange(t *testing.T) {
	// The reference samples uniformly in [delay/2, delay] — pin both ends
	// with injected randomness.
	jittered := policyFromConfig(t, map[string]any{"retry": map[string]any{
		"delayMs": float64(1000), "jitter": true,
	}})
	if got := computeRetryDelay(1, jittered, func() float64 { return 0 }); got != 500 {
		t.Fatalf("rand=0 must land on delay/2, got %v", got)
	}
	if got := computeRetryDelay(1, jittered, func() float64 { return 0.999 }); got < 990 || got > 1000 {
		t.Fatalf("rand→1 must approach the full delay, got %v", got)
	}
}

func TestSerializeErrorShapes(t *testing.T) {
	plain := serializeError(errors.New("boom"))
	if !reflect.DeepEqual(plain, map[string]any{"message": "boom", "name": "Error"}) {
		t.Fatalf("plain error shape: %v", plain)
	}
	structured := serializeError(&ExecError{
		Message: "upstream 503", Name: "HttpError", Code: "E_UPSTREAM", StatusCode: 503,
	})
	want := map[string]any{
		"message": "upstream 503", "name": "HttpError", "code": "E_UPSTREAM", "statusCode": 503,
	}
	if !reflect.DeepEqual(structured, want) {
		t.Fatalf("structured error shape: %v", structured)
	}
	templateError := serializeError(grammar.NewUnresolvedTemplatePathError([]string{"context.missing"}))
	templateWant := map[string]any{
		"message": "Node config contains 1 unresolved template path",
		"name":    "UnresolvedTemplatePathError",
		"code":    "UNRESOLVED_TEMPLATE_PATH",
	}
	if !reflect.DeepEqual(templateError, templateWant) {
		t.Fatalf("rich domain error shape: %v", templateError)
	}
}

func TestSafePersistRedactsSensitiveKeysAndBounds(t *testing.T) {
	// The jsonb chokepoint: key redaction always, size bounding only when a
	// cap is set (dead letters pass 0 = exact JSON for replay).
	value := map[string]any{
		"apiKey": "sk-live-12345", "nested": map[string]any{"client_secret": "shh", "ok": "visible"},
	}
	persisted := string(safePersist(value, defaultPersistMaxBytes()))
	if !strings.Contains(persisted, `"apiKey":"[redacted]"`) || !strings.Contains(persisted, `"client_secret":"[redacted]"`) ||
		!strings.Contains(persisted, `"ok":"visible"`) {
		t.Fatalf("key redaction broken: %s", persisted)
	}
	uncapped := safePersist(map[string]any{"blob": longString(500_000), "password": "x"}, 0)
	if strings.Contains(string(uncapped), "__truncated") || !strings.Contains(string(uncapped), `"password":"[redacted]"`) {
		t.Fatal("maxBytes 0 must never truncate but still redact keys")
	}
}

func longString(n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = 'a'
	}
	return string(b)
}
