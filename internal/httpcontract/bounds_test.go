package httpcontract

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

func TestWholeNumberRejectsUnsafeConversions(t *testing.T) {
	for _, raw := range []any{-1, 1.5, math.NaN(), math.Inf(1), uint64(MaxResponseBytes + 1), "100"} {
		if _, ok := WholeNumber(raw, 0, MaxResponseBytes); ok {
			t.Fatalf("unsafe value %T(%v) was accepted", raw, raw)
		}
	}
	for _, raw := range []any{float64(7), float32(7), 7, int64(7), uint64(7), json.Number("7")} {
		if value, ok := WholeNumber(raw, 0, 10); !ok || value != 7 {
			t.Fatalf("valid value %T(%v) resolved to %d, %v", raw, raw, value, ok)
		}
	}
}

func TestResolveNodeConfigRejectsAmbiguousURLsAndHeaders(t *testing.T) {
	valid, err := ResolveNodeConfig(map[string]any{
		"url":     "https://example.com/path?x=1",
		"headers": map[string]any{"Authorization": "Bearer {{secret.API_TOKEN}}"},
	}, true)
	if err != nil || valid.URL == "" || valid.Headers["Authorization"] == "" {
		t.Fatalf("valid templated authorization header: config=%+v err=%v", valid, err)
	}
	if _, err := ResolveNodeConfig(map[string]any{
		"url": "https://{{context.input.host}}/v1/items/{{context.input.id}}",
	}, true); err != nil {
		t.Fatalf("embedded authoring URL should defer exact parsing: %v", err)
	}

	for name, config := range map[string]map[string]any{
		"surrounding whitespace": {"url": " https://example.com"},
		"unsupported scheme":     {"url": "ftp://example.com/file"},
		"userinfo":               {"url": "https://user:pass@example.com/file"},
		"fragment":               {"url": "https://example.com/file#secret"},
		"invalid header value":   {"url": "https://example.com", "headers": map[string]any{"X-Trace": "ok\r\ninjected"}},
		"transport header":       {"url": "https://example.com", "headers": map[string]any{"Content-Length": "12"}},
		"duplicate header":       {"url": "https://example.com", "headers": map[string]any{"X-Trace": "one", "x-trace": "two"}},
		"oversized header":       {"url": "https://example.com", "headers": map[string]any{"X-Large": strings.Repeat("x", MaxHeaderValueBytes+1)}},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := ResolveNodeConfig(config, false); err == nil {
				t.Fatalf("ambiguous config was accepted: %+v", config)
			}
		})
	}
}

func TestNormalizeFallsBackPerMalformedField(t *testing.T) {
	got := Normalize(&Bounds{
		TimeoutMs: math.Inf(1), MaxResponseBytes: MaxResponseBytes + 1,
		MaxRedirects: 0, StreamPreviewBytes: 2048,
	})
	if got.TimeoutMs != DefaultTimeoutMS || got.MaxResponseBytes != DefaultMaxResponseBytes ||
		got.MaxRedirects != 0 || got.StreamPreviewBytes != 2048 {
		t.Fatalf("normalized bounds: %+v", got)
	}
}
