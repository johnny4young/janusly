//go:build integration

package aiconfig

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/ai"
)

func aiInput(prompt string) ai.GenerateTextInput { return ai.GenerateTextInput{Prompt: prompt} }

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("JANUSLY_GO_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_GO_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// Catalog-governed AI config: org overrides land in the resolved
// settings, no API key means every call falls back cleanly (the $0
// posture), and a tenant on a foreign provider gets no client at all.
func TestResolveTenantAIConfig(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	org := fmt.Sprintf("org-aicfg-%d", time.Now().UnixNano())
	t.Setenv("ANTHROPIC_API_KEY", "")

	// Defaults straight from the catalog.
	client, settings := Resolve(ctx, pool, org)
	if settings.Provider != "anthropic" || settings.Model != "claude-haiku-4-5-20251001" ||
		settings.PromptMaxChars != 4000 || settings.RateLimitPerMin != 30 {
		t.Fatalf("catalog defaults: %+v", settings)
	}
	if client.Configured() {
		t.Fatal("no key must read unconfigured")
	}
	if _, aiErr := client.GenerateText(ctx, aiInput("hola")); aiErr == nil || aiErr.Class != "no_client" {
		t.Fatalf("no-key call must fall back no_client: %+v", aiErr)
	}

	// Org overrides are effective.
	seed := func(key, valueJSON, valueType string) {
		if _, err := pool.Exec(ctx, `INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
			VALUES ($1, $2, $3, $4, 'ai', 'test', $5)`, org+"-"+key, org, key, valueJSON, valueType); err != nil {
			t.Fatalf("seed %s: %v", key, err)
		}
	}
	seed("ai.anthropic.model", `"claude-haiku-4-5-custom"`, "string")
	seed("ai.promptMaxChars", "120", "number")
	seed("ai.rateLimitPerMin", "7", "number")
	_, settings = Resolve(ctx, pool, org)
	if settings.Model != "claude-haiku-4-5-custom" || settings.PromptMaxChars != 120 || settings.RateLimitPerMin != 7 {
		t.Fatalf("org overrides must win: %+v", settings)
	}

	// A tenant configured onto a foreign provider: unconfigured client
	// even when the Anthropic key IS present — fallback, never silent
	// rerouting.
	t.Setenv("ANTHROPIC_API_KEY", "sk-ant-test")
	seed("ai.provider", `"openai"`, "string")
	client, _ = Resolve(ctx, pool, org)
	if client.Configured() {
		t.Fatal("foreign provider must not silently route to anthropic")
	}
}

// The documented truncation posture: over the tenant cap the prompt is
// bounded (rune-safe), never rejected.
func TestTruncatePrompt(t *testing.T) {
	prompt, truncated := TruncatePrompt("corto", 100)
	if truncated || prompt != "corto" {
		t.Fatalf("under cap must pass: %q %v", prompt, truncated)
	}
	long := strings.Repeat("é", 100) // 200 bytes of two-byte runes
	prompt, truncated = TruncatePrompt(long, 101)
	if !truncated || len(prompt) != 100 || !strings.HasSuffix(prompt, "é") {
		t.Fatalf("truncation must cut on a rune boundary: len=%d", len(prompt))
	}
}
