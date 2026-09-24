package orgconfig

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/httpcontract"
)

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

	// Non-finite, fractional, and above-platform values fall through instead
	// of overflowing an int/duration or weakening the process-wide ceiling.
	for _, tenant := range []map[string]float64{
		{"http.timeoutMs": math.Inf(1)},
		{"http.maxResponseBytes": float64(httpcontract.MaxResponseBytes + 1)},
		{"http.maxRedirects": float64(httpcontract.MaxRedirects + 1)},
		{"http.maxRedirects": 1.5},
	} {
		got := resolveHTTPBounds(tenant, none)
		if got.TimeoutMs != httpcontract.DefaultTimeoutMS ||
			got.MaxResponseBytes != httpcontract.DefaultMaxResponseBytes ||
			got.MaxRedirects != httpcontract.DefaultMaxRedirects {
			t.Fatalf("invalid tenant bounds did not fall back: tenant=%+v got=%+v", tenant, got)
		}
	}
}

// A test adapter keeps the original malformed-number and precedence regressions
// while exercising the actual stored-JSON boundary used by the engine.
func resolveHTTPBounds(tenant map[string]float64, lookupEnv func(string) (string, bool)) httpcontract.Bounds {
	rows := map[string]json.RawMessage{}
	for key, value := range tenant {
		raw, err := json.Marshal(value)
		if err != nil {
			raw = json.RawMessage(`null`)
		}
		rows[key] = raw
	}
	return ResolveHTTPBounds(rows, lookupEnv)
}

func TestHTTPEnvironmentAndCatalogAgree(t *testing.T) {
	count := 0
	for _, def := range Definitions {
		if def.Category != "http" {
			continue
		}
		count++
		t.Run(def.Key, func(t *testing.T) {
			if !def.RejectFractional || def.Fractional || len(def.EnvKeys) != 1 || def.Min == nil || def.Max == nil {
				t.Fatal("HTTP must have a strict bounded numeric definition")
			}
			key := def.EnvKeys[0]
			for _, tc := range []struct {
				name, raw string
				want      float64
			}{
				{"minimum", fmt.Sprint(*def.Min), *def.Min},
				{"maximum", fmt.Sprint(*def.Max), *def.Max},
				{"trimmed", fmt.Sprintf(" %v ", def.Default), def.Default.(float64)},
				{"integral decimal", fmt.Sprintf("%.1f", def.Default), def.Default.(float64)},
			} {
				t.Run(tc.name, func(t *testing.T) {
					lookup := env(map[string]string{key: tc.raw})
					if problems := ValidateHTTPEnvironment(func(k string) string { v, _ := lookup(k); return v }); len(problems) != 0 {
						t.Fatalf("boot: %v", problems)
					}
					got, source := ResolveValue(def.Key, nil, lookup)
					if got != tc.want || source != "env" {
						t.Fatalf("catalog: %v %s", got, source)
					}
					bounds := ResolveHTTPBounds(nil, lookup)
					projected := httpBoundValue(bounds, def.Key)
					if projected != got {
						t.Fatalf("engine projection=%v catalog=%v", projected, got)
					}
				})
			}
			for _, tc := range []struct{ name, raw string }{
				{"below", fmt.Sprint(*def.Min - 1)}, {"above", fmt.Sprint(*def.Max + 1)},
				{"fraction", fmt.Sprint(*def.Min + 0.5)}, {"nan", "NaN"}, {"infinite", "+Inf"},
				{"overflow", "1e999"}, {"secret", "PRIVATE-SECRET-DO-NOT-LOG"},
			} {
				t.Run(tc.name, func(t *testing.T) {
					lookup := env(map[string]string{key: tc.raw})
					problems := ValidateHTTPEnvironment(func(k string) string { v, _ := lookup(k); return v })
					if len(problems) != 1 || !strings.Contains(problems[0], key) || strings.Contains(problems[0], "SECRET") {
						t.Fatalf("boot rejection: %v", problems)
					}
					value, source := ResolveValue(def.Key, nil, lookup)
					if source != "default" || value != def.Default {
						t.Fatalf("invalid embedded env did not fall back: %v %s", value, source)
					}
				})
			}
			if _, err := Normalize(&def, *def.Min+0.5); err == nil {
				t.Fatal("fractional tenant write rounded")
			}
			rows := map[string]json.RawMessage{def.Key: json.RawMessage(fmt.Sprint(*def.Min + 0.5))}
			value, source := ResolveValue(def.Key, rows, env(map[string]string{key: fmt.Sprint(*def.Max)}))
			if source != "env" || value != *def.Max {
				t.Fatalf("legacy fractional row did not fall through: %v %s", value, source)
			}
		})
	}
	if count != 4 {
		t.Fatalf("HTTP bounds coverage=%d", count)
	}
}

func httpBoundValue(bounds httpcontract.Bounds, key string) float64 {
	switch key {
	case "http.timeoutMs":
		return bounds.TimeoutMs
	case "http.maxResponseBytes":
		return float64(bounds.MaxResponseBytes)
	case "http.maxRedirects":
		return float64(bounds.MaxRedirects)
	case "http.streamPreviewBytes":
		return float64(bounds.StreamPreviewBytes)
	default:
		panic("unknown HTTP key")
	}
}

func TestHTTPResolutionDoesNotFreezeTenantUpdates(t *testing.T) {
	rows := map[string]json.RawMessage{"http.timeoutMs": json.RawMessage(`25`)}
	lookup := env(map[string]string{"JANUSLY_HTTP_TIMEOUT_MS": "100"})
	if ResolveHTTPBounds(rows, lookup).TimeoutMs != 25 {
		t.Fatal("first tenant snapshot ignored")
	}
	rows["http.timeoutMs"] = json.RawMessage(`75`)
	if ResolveHTTPBounds(rows, lookup).TimeoutMs != 75 {
		t.Fatal("later tenant snapshot frozen")
	}
	delete(rows, "http.timeoutMs")
	if ResolveHTTPBounds(rows, lookup).TimeoutMs != 100 {
		t.Fatal("removed tenant override did not expose env")
	}
	if ResolveHTTPBounds(nil, noEnv).TimeoutMs != httpcontract.DefaultTimeoutMS {
		t.Fatal("other tenant inherited override")
	}
}
