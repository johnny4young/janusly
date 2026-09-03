package ai

import (
	"math"
	"testing"
)

func TestStaticModelPricesPinsSupportedAnthropicCatalog(t *testing.T) {
	prices := StaticModelPrices()
	if len(prices) != 14 {
		t.Fatalf("static model price count = %d, want 14", len(prices))
	}
	tests := map[string]ModelPrice{
		"claude-sonnet-5":            {InputUsdPer1M: 3, OutputUsdPer1M: 15, CacheWrite5mUsdPer1M: 3.75, CacheReadUsdPer1M: 0.3},
		"claude-opus-5":              {InputUsdPer1M: 5, OutputUsdPer1M: 25, CacheWrite5mUsdPer1M: 6.25, CacheReadUsdPer1M: 0.5},
		"claude-opus-4-5-20251101":   {InputUsdPer1M: 5, OutputUsdPer1M: 25, CacheWrite5mUsdPer1M: 6.25, CacheReadUsdPer1M: 0.5},
		"claude-sonnet-4-5-20250929": {InputUsdPer1M: 3, OutputUsdPer1M: 15, CacheWrite5mUsdPer1M: 3.75, CacheReadUsdPer1M: 0.3},
		"claude-fable-5-1":           {InputUsdPer1M: 10, OutputUsdPer1M: 50, CacheWrite5mUsdPer1M: 12.5, CacheReadUsdPer1M: 0.25},
	}
	for model, want := range tests {
		got := prices[model]
		if got.InputUsdPer1M != want.InputUsdPer1M || got.OutputUsdPer1M != want.OutputUsdPer1M ||
			math.Abs(got.CacheWrite5mUsdPer1M-want.CacheWrite5mUsdPer1M) > 1e-12 ||
			math.Abs(got.CacheReadUsdPer1M-want.CacheReadUsdPer1M) > 1e-12 {
			t.Errorf("%s price = %+v, want %+v", model, got, want)
		}
	}
	if _, exists := prices["gpt-4o-mini"]; exists {
		t.Fatal("completion pricing must not advertise an unsupported provider")
	}
	if _, exists := prices["claude-opus-4"]; exists {
		t.Fatal("retired Claude Opus 4 must not be admitted for paid egress")
	}

	delete(prices, "claude-sonnet-5")
	if GetModelPrice("claude-sonnet-5") == nil {
		t.Fatal("StaticModelPrices must return a defensive copy")
	}
}

func TestGetModelPriceNormalizesAndRejectsNonFiniteOverride(t *testing.T) {
	if got := GetModelPrice(" CLAUDE-SONNET-5 "); got == nil || got.InputUsdPer1M != 3 || got.OutputUsdPer1M != 15 {
		t.Fatalf("normalized static lookup = %+v", got)
	}

	key := "JANUSLY_LLM_PRICE_CLAUDE_SONNET_5"
	t.Setenv(key, "7.5,12.25")
	if got := GetModelPrice("claude-sonnet-5"); got == nil || got.InputUsdPer1M != 7.5 || got.OutputUsdPer1M != 12.25 ||
		math.Abs(got.CacheWrite5mUsdPer1M-9.375) > 1e-12 || math.Abs(got.CacheReadUsdPer1M-0.75) > 1e-12 {
		t.Fatalf("finite override = %+v", got)
	}

	for _, invalid := range []string{"NaN,1", "1,+Inf", "-1,2", "0,2", "2,0", "0,0", "1", "x,2"} {
		t.Run(invalid, func(t *testing.T) {
			t.Setenv(key, invalid)
			got := GetModelPrice("claude-sonnet-5")
			if got == nil || math.IsNaN(got.InputUsdPer1M) || math.IsInf(got.OutputUsdPer1M, 0) ||
				got.InputUsdPer1M != 3 || got.OutputUsdPer1M != 15 {
				t.Fatalf("invalid override %q must fall back to static price, got %+v", invalid, got)
			}
		})
	}

	t.Setenv(key, "7.5,12.25,8.125,0.0625")
	if got := GetModelPrice("claude-sonnet-5"); got == nil || *got != (ModelPrice{
		InputUsdPer1M: 7.5, OutputUsdPer1M: 12.25,
		CacheWrite5mUsdPer1M: 8.125, CacheReadUsdPer1M: 0.0625,
	}) {
		t.Fatalf("explicit four-rate override = %+v", got)
	}
}

func TestUnknownModelRequiresEveryBillableRate(t *testing.T) {
	const key = "JANUSLY_LLM_PRICE_CLAUDE_NEW_MODEL"
	t.Setenv(key, "2,10")
	if got := GetModelPrice("claude-new-model"); got != nil {
		t.Fatalf("unknown model must not infer cache rates: %+v", got)
	}

	t.Setenv(key, "2,10,2.6,0.17")
	want := ModelPrice{
		InputUsdPer1M: 2, OutputUsdPer1M: 10,
		CacheWrite5mUsdPer1M: 2.6, CacheReadUsdPer1M: 0.17,
	}
	if got := GetModelPrice("claude-new-model"); got == nil || *got != want {
		t.Fatalf("complete unknown-model override = %+v, want %+v", got, want)
	}

	for _, invalid := range []string{"2,10,2.6", "2,10,2.6,0", "2,10,2.6,0.17,9"} {
		t.Run(invalid, func(t *testing.T) {
			t.Setenv(key, invalid)
			if got := GetModelPrice("claude-new-model"); got != nil {
				t.Fatalf("invalid complete override %q must fail closed, got %+v", invalid, got)
			}
		})
	}
}

func TestPriceOverrideKeyCannotCollideAcrossModelPunctuation(t *testing.T) {
	t.Setenv("JANUSLY_LLM_PRICE_CLAUDE_NEW_MODEL", "2,10,2.6,0.17")
	for _, model := range []string{"claude.new.model", "claude_new_model", "claude--new-model"} {
		if got := GetModelPrice(model); got != nil {
			t.Fatalf("invalid id %q collided with hyphenated model price: %+v", model, got)
		}
	}
}

func TestComputeCostUsdIncludesEveryPromptCacheTokenClass(t *testing.T) {
	price := GetModelPrice("claude-sonnet-5")
	cost := ComputeCostUsd(price, Usage{
		InputTokens: 100, OutputTokens: 50,
		CacheCreationInputTokens: 200, CachedInputTokens: 300,
	})
	// 100×$3 + 200×$3.75 + 300×$0.30 + 50×$15, per million.
	if cost == nil || math.Abs(*cost-0.00189) > 1e-12 {
		t.Fatalf("cache-aware cost = %v, want 0.00189", cost)
	}

	fable := ComputeCostUsd(GetModelPrice("claude-fable-5-1"), Usage{CachedInputTokens: 1000})
	if fable == nil || math.Abs(*fable-0.00025) > 1e-12 {
		t.Fatalf("Fable 5.1 cache read cost = %v, want 0.00025", fable)
	}
	if ComputeCostUsd(nil, Usage{InputTokens: 1}) != nil {
		t.Fatal("unknown price must remain unknown")
	}
	if ComputeCostUsd(price, Usage{InputTokens: -1}) != nil {
		t.Fatal("negative usage must not create negative recorded spend")
	}
	nonFinite := *price
	nonFinite.InputUsdPer1M = math.Inf(1)
	if ComputeCostUsd(&nonFinite, Usage{InputTokens: 1}) != nil {
		t.Fatal("non-finite price must not create non-finite recorded spend")
	}
}
