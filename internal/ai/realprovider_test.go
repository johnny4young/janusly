//go:build realprovider

package ai

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Explicit-cost real-provider qualification. The build tag, consent flag,
// exact call count, tiny output cap, no retries, and aggregate USD assertion
// make accidental provider spend impossible in ordinary test/CI lanes.
func TestBoundedRealAnthropicProvider(t *testing.T) {
	if os.Getenv("JANUSLY_REAL_PROVIDER_CONSENT") != "1" {
		t.Fatal("real provider test requires JANUSLY_REAL_PROVIDER_CONSENT=1")
	}
	key := strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY"))
	if key == "" {
		t.Fatal("ANTHROPIC_API_KEY is required for the explicit realprovider profile")
	}
	maxUSD := 1.0
	if raw := os.Getenv("JANUSLY_REAL_PROVIDER_MAX_USD"); raw != "" {
		parsed, err := strconv.ParseFloat(raw, 64)
		if err != nil || parsed <= 0 || parsed > 1 {
			t.Fatalf("JANUSLY_REAL_PROVIDER_MAX_USD must be in (0,1], got %q", raw)
		}
		maxUSD = parsed
	}

	client := New(Config{
		APIKey: key, Model: DefaultModel, TimeoutMs: 45_000,
		MaxRetries: 0, MaxOutputTokens: 32,
	})
	cases := []struct {
		prompt string
		want   string
	}{
		{prompt: "Reply with only JANUSLY_PROVIDER_OK.", want: "JANUSLY_PROVIDER_OK"},
		{prompt: "Reply with only JANUSLY_FALLBACK_READY.", want: "JANUSLY_FALLBACK_READY"},
	}
	totalCost := 0.0
	totalTokens := 0
	for index, testCase := range cases {
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		result, aiErr := client.GenerateText(ctx, GenerateTextInput{
			System: "Follow the requested exact short reply. Do not add punctuation.",
			Prompt: testCase.prompt, MaxOutputUnits: 32,
		})
		cancel()
		if aiErr != nil {
			t.Fatalf("real provider call %d failed: class=%s message=%s", index+1, aiErr.Class, aiErr.Message)
		}
		if result == nil || result.Provider != "anthropic" || result.ProviderSimulated || result.Model != DefaultModel {
			t.Fatalf("real provider call %d returned invalid result: %+v", index+1, result)
		}
		if got := strings.TrimSpace(result.Text); got != testCase.want {
			t.Fatalf("real provider call %d response = %q, want %q", index+1, got, testCase.want)
		}
		if result.Usage.InputTokens <= 0 || result.Usage.OutputTokens <= 0 || result.Usage.TotalTokens <= 0 {
			t.Fatalf("real provider call %d lacks measured token usage: %+v", index+1, result.Usage)
		}
		if result.CostUsd == nil || *result.CostUsd <= 0 {
			t.Fatalf("real provider call %d lacks priced usage: %+v", index+1, result)
		}
		totalCost += *result.CostUsd
		totalTokens += result.Usage.TotalTokens
	}
	if totalCost > maxUSD {
		t.Fatalf("real provider spend %.8f exceeded cap %.2f", totalCost, maxUSD)
	}
	t.Logf("real_provider calls=%d model=%s tokens=%d cost_usd=%s",
		len(cases), DefaultModel, totalTokens, fmt.Sprintf("%.8f", totalCost))
}
