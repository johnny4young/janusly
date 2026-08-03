package ai

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The caching + output-cap WIRE contract: CacheSystemPrompt marks the
// system block as an ephemeral cache breakpoint on the request itself
// (and its absence leaves the request unmarked), and a per-call
// MaxOutputUnits overrides the resolved max_tokens.
func TestCacheControlAndMaxTokensOnTheWire(t *testing.T) {
	var captured map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		captured = nil // Unmarshal into a non-nil map MERGES keys across calls
		_ = json.Unmarshal(raw, &captured)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(successBody))
	}))
	t.Cleanup(server.Close)
	client := New(Config{APIKey: "k", BaseURL: server.URL, MaxOutputTokens: 4096})

	// Cached call with a per-call output cap.
	if _, aiErr := client.GenerateText(context.Background(), GenerateTextInput{
		System: "prefijo estable", Prompt: "hola",
		CacheSystemPrompt: true, MaxOutputUnits: 777,
	}); aiErr != nil {
		t.Fatalf("call: %v", aiErr)
	}
	if captured["max_tokens"] != float64(777) {
		t.Fatalf("per-call cap must reach max_tokens: %v", captured["max_tokens"])
	}
	system := captured["system"].([]any)[0].(map[string]any)
	control, ok := system["cache_control"].(map[string]any)
	if !ok || control["type"] != "ephemeral" {
		t.Fatalf("system block must carry the ephemeral breakpoint: %+v", system)
	}
	if system["text"] != "prefijo estable" {
		t.Fatalf("system text: %+v", system)
	}

	// Without the opt-in the request is byte-for-byte unmarked and the
	// resolved default cap applies.
	if _, aiErr := client.GenerateText(context.Background(), GenerateTextInput{
		System: "prefijo estable", Prompt: "hola",
	}); aiErr != nil {
		t.Fatalf("uncached call: %v", aiErr)
	}
	if captured["max_tokens"] != float64(4096) {
		t.Fatalf("default cap: %v", captured["max_tokens"])
	}
	system = captured["system"].([]any)[0].(map[string]any)
	if _, marked := system["cache_control"]; marked {
		t.Fatalf("opt-out must leave the request unmarked: %+v", system)
	}

	// A system-less cached call is a no-op, never an error.
	if _, aiErr := client.GenerateText(context.Background(), GenerateTextInput{
		Prompt: "hola", CacheSystemPrompt: true,
	}); aiErr != nil {
		t.Fatalf("system-less cached call must pass: %v", aiErr)
	}
	if _, present := captured["system"]; present {
		t.Fatalf("no system prompt must mean no system block: %+v", captured)
	}
}
