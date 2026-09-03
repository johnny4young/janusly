// Tenant-resolved AI configuration — the runtime's analogue of the
// contract's ai-runtime tenant client construction. internal/ai stays
// DB-agnostic (like the source contract); THIS package reads the org-config
// catalog's tenant row → env → default chain and builds
// the chokepoint client plus the per-surface settings every AI route and
// executor shares. The API key comes from env ONLY — the catalog never
// stores secrets — and a missing key simply yields an unconfigured
// client whose calls all classify no_client: the $0 fallback path.
package aiconfig

import (
	"context"
	"net/url"
	"os"
	"strings"
	"unicode/utf8"

	"github.com/johnny4young/janusly/internal/ai"
	"github.com/johnny4young/janusly/internal/orgconfig"
)

// Settings carries the catalog knobs callers enforce OUTSIDE the client.
type Settings struct {
	Provider          string
	Model             string
	ProviderSimulated bool
	PromptMaxChars    int
	RateLimitPerMin   int
}

const completionProvider = "anthropic"
const localSimulatorAPIKey = "janusly-local-simulator"

// Resolve builds the tenant's chokepoint client + settings from the
// catalog. db is any store.DBTX (pool or tx).
func Resolve(ctx context.Context, db orgconfig.Querier, orgID string) (ai.Client, Settings) {
	return resolve(ctx, db, orgID, nil)
}

// ResolveForEvaluation builds the same tenant client with SDK retries
// disabled. Experiment admission counts provider attempts before execution;
// hidden transport retries would violate that cost envelope.
func ResolveForEvaluation(ctx context.Context, db orgconfig.Querier, orgID string) (ai.Client, Settings) {
	zero := 0
	return resolve(ctx, db, orgID, &zero)
}

func resolve(ctx context.Context, db orgconfig.Querier, orgID string, maxRetriesOverride *int) (ai.Client, Settings) {
	values := orgconfig.LoadValues(ctx, db, orgID,
		"ai.anthropic.model", "ai.promptMaxChars", "ai.rateLimitPerMin",
		"ai.timeoutMs", "ai.maxRetries", "ai.maxOutputUnits",
	)
	model, _ := values["ai.anthropic.model"].(string)
	number := func(key string) int {
		value, _ := values[key].(float64)
		return int(value)
	}
	settings := Settings{
		Provider:        completionProvider,
		Model:           model,
		PromptMaxChars:  number("ai.promptMaxChars"),
		RateLimitPerMin: number("ai.rateLimitPerMin"),
	}

	cfg := ai.Config{
		Model:           model,
		TimeoutMs:       number("ai.timeoutMs"),
		MaxRetries:      number("ai.maxRetries"),
		MaxOutputTokens: number("ai.maxOutputUnits"),
	}
	if maxRetriesOverride != nil {
		cfg.MaxRetries = *maxRetriesOverride
	}
	// Completion is an Anthropic capability, not a fake one-option tenant
	// selector. An absent key leaves the client unconfigured and every caller
	// follows the deterministic fallback contract.
	cfg.APIKey = os.Getenv("ANTHROPIC_API_KEY")
	applySimulatorConfig(&cfg)
	settings.ProviderSimulated = cfg.ProviderSimulated
	return ai.New(cfg), settings
}

func applySimulatorConfig(cfg *ai.Config) {
	if cfg == nil {
		return
	}
	if baseURL, requested, valid := simulatorEndpoint(); requested {
		// A partially configured simulator must never fall through to the real
		// Anthropic default endpoint while still carrying a live key. A valid
		// simulator also receives a fixed non-secret credential, never the
		// operator's Anthropic credential.
		if !valid {
			cfg.APIKey = ""
		} else {
			cfg.APIKey, cfg.BaseURL, cfg.ProviderSimulated = localSimulatorAPIKey, baseURL, true
		}
	}
}

// TruncatePrompt bounds a prompt to the tenant's ai.promptMaxChars —
// over the cap it TRUNCATES (documented posture), never errors. Returns
// the bounded prompt and whether truncation happened.
func TruncatePrompt(prompt string, maxChars int) (string, bool) {
	if maxChars <= 0 || utf8.RuneCountInString(prompt) <= maxChars {
		return prompt, false
	}
	return string([]rune(prompt)[:maxChars]), true
}

// simulatorEndpoint honours the contract's DOUBLE explicit gate: only
// JANUSLY_LOCAL_STACK=true AND JANUSLY_LOCAL_INTEGRATION_SIMULATOR=true
// enable a simulated provider endpoint, and only when anthropic is in
// the simulated list. It distinguishes an invalid requested simulator from an
// inert configuration so a missing/bad base URL can fail closed instead of
// reverting to the real paid endpoint. Simulated usage persists but never bills.
func simulatorEndpoint() (baseURL string, requested bool, valid bool) {
	if os.Getenv("JANUSLY_LOCAL_STACK") != "true" ||
		os.Getenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR") != "true" {
		return "", false, false
	}
	simulated := strings.SplitSeq(os.Getenv("JANUSLY_LLM_SIMULATED_PROVIDERS"), ",")
	for name := range simulated {
		if strings.TrimSpace(name) == "anthropic" {
			baseURL = strings.TrimSpace(os.Getenv("JANUSLY_LLM_SIMULATOR_BASE_URL"))
			parsed, err := url.Parse(baseURL)
			if err != nil || parsed == nil || parsed.User != nil || parsed.Host == "" ||
				(parsed.Scheme != "http" && parsed.Scheme != "https") {
				return "", true, false
			}
			host := strings.ToLower(parsed.Hostname())
			if host == "anthropic.com" || strings.HasSuffix(host, ".anthropic.com") {
				return "", true, false
			}
			return baseURL, true, true
		}
	}
	return "", false, false
}
