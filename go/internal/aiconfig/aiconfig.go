// Tenant-resolved AI configuration — the pilot's analogue of the
// reference's ai-runtime tenant client construction. internal/ai stays
// DB-agnostic (like packages/ai); THIS package reads the org-config
// catalog (T-086's layer chain: tenant row → env → default) and builds
// the chokepoint client plus the per-surface settings every AI route and
// executor shares. The API key comes from env ONLY — the catalog never
// stores secrets — and a missing key simply yields an unconfigured
// client whose calls all classify no_client: the $0 fallback path.
package aiconfig

import (
	"context"
	"os"
	"strings"

	"github.com/johnny4young/janusly/go/internal/ai"
	"github.com/johnny4young/janusly/go/internal/orgconfig"
)

// Settings carries the catalog knobs callers enforce OUTSIDE the client.
type Settings struct {
	Provider        string
	Model           string
	PromptMaxChars  int
	RateLimitPerMin int
}

// Resolve builds the tenant's chokepoint client + settings from the
// catalog. db is any store.DBTX (pool or tx).
func Resolve(ctx context.Context, db orgconfig.Querier, orgID string) (ai.Client, Settings) {
	provider, _ := orgconfig.LoadValue(ctx, db, orgID, "ai.provider").(string)
	model, _ := orgconfig.LoadValue(ctx, db, orgID, "ai.anthropic.model").(string)
	settings := Settings{
		Provider:        provider,
		Model:           model,
		PromptMaxChars:  int(orgconfig.LoadNumber(ctx, db, orgID, "ai.promptMaxChars")),
		RateLimitPerMin: int(orgconfig.LoadNumber(ctx, db, orgID, "ai.rateLimitPerMin")),
	}

	cfg := ai.Config{
		Model:           model,
		TimeoutMs:       int(orgconfig.LoadNumber(ctx, db, orgID, "ai.timeoutMs")),
		MaxRetries:      int(orgconfig.LoadNumber(ctx, db, orgID, "ai.maxRetries")),
		MaxOutputTokens: int(orgconfig.LoadNumber(ctx, db, orgID, "ai.maxOutputUnits")),
	}
	// The pilot's supported completion posture is Anthropic-only (the
	// reference's operating posture too). A tenant configured onto another
	// provider gets an unconfigured client — every call degrades to the
	// fallback contract instead of silently routing to Anthropic.
	if provider == "anthropic" {
		cfg.APIKey = os.Getenv("ANTHROPIC_API_KEY")
	}
	cfg.BaseURL, cfg.ProviderSimulated = simulatorBaseURL()
	return ai.New(cfg), settings
}

// TruncatePrompt bounds a prompt to the tenant's ai.promptMaxChars —
// over the cap it TRUNCATES (documented posture), never errors. Returns
// the bounded prompt and whether truncation happened.
func TruncatePrompt(prompt string, maxChars int) (string, bool) {
	if maxChars <= 0 || len(prompt) <= maxChars {
		return prompt, false
	}
	cut := maxChars
	for cut > 0 && (prompt[cut]&0xC0) == 0x80 { // don't split a rune
		cut--
	}
	return prompt[:cut], true
}

// simulatorBaseURL honours the reference's DOUBLE explicit gate: only
// JANUSLY_LOCAL_STACK=true AND JANUSLY_LOCAL_INTEGRATION_SIMULATOR=true
// enable a simulated provider endpoint, and only when anthropic is in
// the simulated list. Simulated usage persists but never bills.
func simulatorBaseURL() (string, bool) {
	if os.Getenv("JANUSLY_LOCAL_STACK") != "true" ||
		os.Getenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR") != "true" {
		return "", false
	}
	simulated := strings.Split(os.Getenv("JANUSLY_LLM_SIMULATED_PROVIDERS"), ",")
	for _, name := range simulated {
		if strings.TrimSpace(name) == "anthropic" {
			return os.Getenv("JANUSLY_LLM_SIMULATOR_BASE_URL"), true
		}
	}
	return "", false
}
