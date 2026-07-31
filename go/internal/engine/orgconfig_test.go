package engine

import "testing"

func env(pairs map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		value, ok := pairs[key]
		return value, ok
	}
}

func TestHTTPBoundPrecedenceChain(t *testing.T) {
	none := env(nil)

	// Catalog defaults with nothing set.
	got := resolveHTTPBounds(nil, none)
	if got.TimeoutMs != 30_000 || got.MaxResponseBytes != 1_000_000 || got.MaxRedirects != 5 {
		t.Fatalf("defaults: %+v", got)
	}

	// Env overrides the default; tenant row overrides the env.
	withEnv := env(map[string]string{"JANUSLY_HTTP_TIMEOUT_MS": "10000"})
	if got := resolveHTTPBounds(nil, withEnv); got.TimeoutMs != 10_000 {
		t.Fatalf("env layer: %+v", got)
	}
	tenant := map[string]float64{"http.timeoutMs": 5_000}
	if got := resolveHTTPBounds(tenant, withEnv); got.TimeoutMs != 5_000 {
		t.Fatalf("tenant layer: %+v", got)
	}

	// Below-minimum values fall through to the next layer, never half-apply.
	if got := resolveHTTPBounds(map[string]float64{"http.timeoutMs": 0}, withEnv); got.TimeoutMs != 10_000 {
		t.Fatalf("invalid tenant falls to env: %+v", got)
	}
	if got := resolveHTTPBounds(nil, env(map[string]string{"JANUSLY_HTTP_TIMEOUT_MS": "bogus"})); got.TimeoutMs != 30_000 {
		t.Fatalf("invalid env falls to default: %+v", got)
	}

	// maxRedirects: 0 is a VALID tenant value (min 0 — redirects can be off).
	if got := resolveHTTPBounds(map[string]float64{"http.maxRedirects": 0}, none); got.MaxRedirects != 0 {
		t.Fatalf("zero redirects must be honored: %+v", got)
	}
}
