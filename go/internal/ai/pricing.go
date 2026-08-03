// Server-side cost computation, ported from the reference's pricing
// modules: the static MODEL_PRICES snapshot overlaid by the server-only
// JANUSLY_LLM_PRICE_<MODEL>=<input>,<output> env override. An unknown
// model yields a nil price and callers record costUsd as null — never a
// misleading zero. Simulated calls always cost zero regardless of price.
package ai

import (
	"os"
	"regexp"
	"strconv"
	"strings"
)

// ModelPrice is USD per one million tokens.
type ModelPrice struct {
	InputUsdPer1M  float64
	OutputUsdPer1M float64
}

// modelPrices mirrors the reference snapshot (2026-04). Keys lowercase.
var modelPrices = map[string]ModelPrice{
	// OpenAI (kept for table parity even though the pilot is Anthropic-only)
	"gpt-4o-mini":  {0.15, 0.6},
	"gpt-4o":       {2.5, 10.0},
	"gpt-4.1":      {2.0, 8.0},
	"gpt-4.1-mini": {0.4, 1.6},
	// Anthropic
	"claude-haiku-4-5-20251001": {1.0, 5.0},
	"claude-haiku-4-5":          {1.0, 5.0},
	"claude-sonnet-4-5":         {3.0, 15.0},
	"claude-opus-4":             {15.0, 75.0},
}

var priceOverrideKeyPattern = regexp.MustCompile(`[^A-Z0-9]+`)

// GetModelPrice resolves the price for a model id: the env override wins,
// the static table follows, unknown models return nil.
func GetModelPrice(model string) *ModelPrice {
	overrideKey := "JANUSLY_LLM_PRICE_" + priceOverrideKeyPattern.ReplaceAllString(strings.ToUpper(model), "_")
	if raw := os.Getenv(overrideKey); raw != "" {
		if input, output, ok := strings.Cut(raw, ","); ok {
			in, errIn := strconv.ParseFloat(strings.TrimSpace(input), 64)
			out, errOut := strconv.ParseFloat(strings.TrimSpace(output), 64)
			if errIn == nil && errOut == nil && in >= 0 && out >= 0 {
				return &ModelPrice{InputUsdPer1M: in, OutputUsdPer1M: out}
			}
		}
	}
	if price, ok := modelPrices[strings.ToLower(model)]; ok {
		copied := price
		return &copied
	}
	return nil
}

// ComputeCostUsd multiplies measured usage by a price; nil price = nil
// cost (unknown stays unknown).
func ComputeCostUsd(price *ModelPrice, usage Usage) *float64 {
	if price == nil {
		return nil
	}
	cost := (float64(usage.InputTokens)*price.InputUsdPer1M +
		float64(usage.OutputTokens)*price.OutputUsdPer1M) / 1_000_000
	return &cost
}
