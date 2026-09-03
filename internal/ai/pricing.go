// Server-side cost computation, implements the contract's pricing
// modules: the static MODEL_PRICES snapshot overlaid by the server-only
// JANUSLY_LLM_PRICE_<MODEL> env override. Known models accept the compatible
// <input>,<output> form and retain their catalogued cache multipliers. Unknown
// models require all four billable rates:
// <input>,<output>,<cache-write-5m>,<cache-read>. An unknown or incomplete
// price yields nil; the real-provider chokepoint rejects it before egress so
// budget accounting cannot silently miss paid usage. Simulated calls always
// cost zero regardless of price.
package ai

import (
	"maps"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// ModelPrice is USD per one million tokens.
type ModelPrice struct {
	InputUsdPer1M        float64
	OutputUsdPer1M       float64
	CacheWrite5mUsdPer1M float64
	CacheReadUsdPer1M    float64
}

// ModelPricingSnapshotDate is the date the static Anthropic price catalog was
// checked against the vendor's published pricing. Runtime env overrides remain
// available for changes between source updates.
const ModelPricingSnapshotDate = "2026-09-03"

// modelPrices is the completion runtime's single pricing source. Keys are
// lowercase; cmd/pricing generates the browser copy from this map.
var modelPrices = map[string]ModelPrice{
	"claude-haiku-4-5-20251001":  anthropicModelPrice("claude-haiku-4-5-20251001", 1.0, 5.0),
	"claude-haiku-4-5":           anthropicModelPrice("claude-haiku-4-5", 1.0, 5.0),
	"claude-sonnet-4-5-20250929": anthropicModelPrice("claude-sonnet-4-5-20250929", 3.0, 15.0),
	"claude-sonnet-4-5":          anthropicModelPrice("claude-sonnet-4-5", 3.0, 15.0),
	"claude-sonnet-4-6":          anthropicModelPrice("claude-sonnet-4-6", 3.0, 15.0),
	// Sonnet 5's introductory $2/$10 rate ended on 2026-08-31. Keep the
	// catalog on the standard rate that became effective 2026-09-01; an old
	// promotional price here would systematically under-report real spend.
	"claude-sonnet-5":          anthropicModelPrice("claude-sonnet-5", 3.0, 15.0),
	"claude-opus-4-5-20251101": anthropicModelPrice("claude-opus-4-5-20251101", 5.0, 25.0),
	"claude-opus-4-5":          anthropicModelPrice("claude-opus-4-5", 5.0, 25.0),
	"claude-opus-4-6":          anthropicModelPrice("claude-opus-4-6", 5.0, 25.0),
	"claude-opus-4-7":          anthropicModelPrice("claude-opus-4-7", 5.0, 25.0),
	"claude-opus-4-8":          anthropicModelPrice("claude-opus-4-8", 5.0, 25.0),
	"claude-opus-5":            anthropicModelPrice("claude-opus-5", 5.0, 25.0),
	"claude-fable-5":           anthropicModelPrice("claude-fable-5", 10.0, 50.0),
	"claude-fable-5-1":         anthropicModelPrice("claude-fable-5-1", 10.0, 50.0),
}

func anthropicModelPrice(model string, input, output float64) ModelPrice {
	return ModelPrice{
		InputUsdPer1M: input, OutputUsdPer1M: output,
		// Janusly sends ephemeral cache controls without a custom TTL, which
		// selects Anthropic's five-minute write tier.
		CacheWrite5mUsdPer1M: input * 1.25,
		CacheReadUsdPer1M:    input * cacheReadMultiplier(model),
	}
}

func cacheReadMultiplier(model string) float64 {
	normalized := strings.ToLower(strings.TrimSpace(model))
	for _, family := range []string{"claude-fable-5-1", "claude-mythos-5-1"} {
		if normalized == family || strings.HasPrefix(normalized, family+"-") {
			return 0.025
		}
	}
	return 0.1
}

var priceOverrideKeyPattern = regexp.MustCompile(`[^A-Z0-9]+`)

// StaticModelPrices returns a defensive copy for deterministic build-time
// consumers such as the browser-table generator.
func StaticModelPrices() map[string]ModelPrice {
	return maps.Clone(modelPrices)
}

// GetModelPrice resolves the price for a model id: the env override wins,
// the static table follows, unknown models return nil.
func GetModelPrice(model string) *ModelPrice {
	trimmed := strings.TrimSpace(model)
	if len(trimmed) > MaxModelIDBytes {
		return nil
	}
	normalizedModel, valid := NormalizeModelID(strings.ToLower(trimmed))
	if !valid {
		return nil
	}
	overrideKey := "JANUSLY_LLM_PRICE_" + priceOverrideKeyPattern.ReplaceAllString(strings.ToUpper(normalizedModel), "_")
	staticPrice, knownModel := modelPrices[normalizedModel]
	if raw := os.Getenv(overrideKey); raw != "" {
		if price, ok := parseModelPriceOverride(raw, staticPrice, knownModel); ok {
			return &price
		}
	}
	if knownModel {
		copied := staticPrice
		return &copied
	}
	return nil
}

func parseModelPriceOverride(raw string, staticPrice ModelPrice, knownModel bool) (ModelPrice, bool) {
	parts := strings.Split(raw, ",")
	if len(parts) != 2 && len(parts) != 4 {
		return ModelPrice{}, false
	}
	rates := make([]float64, len(parts))
	for index, part := range parts {
		rate, err := strconv.ParseFloat(strings.TrimSpace(part), 64)
		if err != nil || rate <= 0 || math.IsNaN(rate) || math.IsInf(rate, 0) {
			return ModelPrice{}, false
		}
		rates[index] = rate
	}
	if len(rates) == 4 {
		return ModelPrice{
			InputUsdPer1M: rates[0], OutputUsdPer1M: rates[1],
			CacheWrite5mUsdPer1M: rates[2], CacheReadUsdPer1M: rates[3],
		}, true
	}
	if !knownModel || staticPrice.InputUsdPer1M <= 0 {
		// An unknown model may have different cache tiers or multipliers. Do not
		// guess them from its name: incomplete paid pricing must fail closed.
		return ModelPrice{}, false
	}
	return ModelPrice{
		InputUsdPer1M: rates[0], OutputUsdPer1M: rates[1],
		CacheWrite5mUsdPer1M: rates[0] * staticPrice.CacheWrite5mUsdPer1M / staticPrice.InputUsdPer1M,
		CacheReadUsdPer1M:    rates[0] * staticPrice.CacheReadUsdPer1M / staticPrice.InputUsdPer1M,
	}, true
}

// ComputeCostUsd multiplies every measured billable token class by its exact
// rate; nil price = nil cost (unknown stays unknown). InputTokens is the
// provider's uncached input count, while cache creation and read counts are
// reported separately.
func ComputeCostUsd(price *ModelPrice, usage Usage) *float64 {
	if price == nil {
		return nil
	}
	rates := [...]float64{
		price.InputUsdPer1M, price.OutputUsdPer1M,
		price.CacheWrite5mUsdPer1M, price.CacheReadUsdPer1M,
	}
	for _, rate := range rates {
		if rate < 0 || math.IsNaN(rate) || math.IsInf(rate, 0) {
			return nil
		}
	}
	if usage.InputTokens < 0 || usage.OutputTokens < 0 || usage.CachedInputTokens < 0 ||
		usage.CacheCreationInputTokens < 0 {
		return nil
	}
	cost := (float64(usage.InputTokens)*price.InputUsdPer1M +
		float64(usage.CacheCreationInputTokens)*price.CacheWrite5mUsdPer1M +
		float64(usage.CachedInputTokens)*price.CacheReadUsdPer1M +
		float64(usage.OutputTokens)*price.OutputUsdPer1M) / 1_000_000
	if math.IsNaN(cost) || math.IsInf(cost, 0) || cost < 0 {
		return nil
	}
	return &cost
}
