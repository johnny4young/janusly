//go:build realprovider

package httpapi

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/ai"
	"github.com/johnny4young/janusly/internal/domain"
)

// boundedProductClient is a hard billing circuit breaker around the normal AI
// client. The generation ladder may request a directed repair, but a third SDK
// call is refused locally before it can reach Anthropic.
type boundedProductClient struct {
	delegate ai.Client
	maxCalls int

	mu         sync.Mutex
	calls      int
	tokens     int
	costUsd    float64
	lastModel  string
	lastVendor string
}

func (c *boundedProductClient) Configured() bool { return c.delegate.Configured() }

func (c *boundedProductClient) GenerateText(ctx context.Context, input ai.GenerateTextInput) (*ai.GenerateTextResult, *ai.AIError) {
	c.mu.Lock()
	if c.calls >= c.maxCalls {
		c.mu.Unlock()
		return nil, &ai.AIError{Class: "invalid_request", Message: "real-provider qualification call cap reached"}
	}
	c.calls++
	c.mu.Unlock()

	result, aiErr := c.delegate.GenerateText(ctx, input)
	if result != nil {
		c.mu.Lock()
		c.tokens += result.Usage.TotalTokens
		if result.CostUsd != nil {
			c.costUsd += *result.CostUsd
		}
		c.lastModel = result.Model
		c.lastVendor = result.Provider
		c.mu.Unlock()
	}
	return result, aiErr
}

func (c *boundedProductClient) accounting() (calls, tokens int, cost float64, model, provider string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls, c.tokens, c.costUsd, c.lastModel, c.lastVendor
}

// TestBoundedRealAnthropicProvider exercises the actual Janusly generation
// prompt, parse/repair ladder, assurance compiler and domain/readiness gates.
// It is intentionally absent from ordinary CI and requires explicit consent.
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

	client := &boundedProductClient{
		delegate: ai.New(ai.Config{
			APIKey: key, Model: ai.DefaultModel, TimeoutMs: 45_000,
			MaxRetries: 0, MaxOutputTokens: 1_200,
		}),
		maxCalls: 2,
	}
	prompt := "Create a resilient Janusly workflow. Start with a noop node, fetch https://api.github.com using a GET http node with three attempts, then use an AI node to summarize the response for an operator. Project the summary as the workflow output. Do not invent semantic qualification criteria."
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	raw, meta, aiErr := (&V1Server{}).generateFreeJson(ctx, client, prompt, "", v1Request{}, 1)
	if aiErr != nil {
		t.Fatalf("real product generation failed: class=%s message=%s", aiErr.Class, aiErr.Message)
	}
	wf, issues := domain.Parse(raw)
	if wf == nil || len(issues) > 0 {
		t.Fatalf("real product result did not parse: %+v", issues)
	}
	if len(wf.Outputs) == 0 {
		t.Fatal("real product result omitted the executable Intent Contract")
	}
	if wf.Recovery == nil || wf.Recovery.Contract == nil || wf.Recovery.Contract.Version != "1" {
		t.Fatalf("real product result omitted conservative technical recovery: %+v", wf.Recovery)
	}
	if wf.Recovery.Contract.AutonomyLevel > 1 || wf.Recovery.Contract.Failure.Semantic.Mode != "disabled" {
		t.Fatalf("real product result invented recovery authority: %+v", wf.Recovery.Contract)
	}
	hasHTTP, hasAI, hasBoundedRetry := false, false, false
	for _, node := range wf.Nodes {
		switch node.Type {
		case "http":
			hasHTTP = true
			if node.Config["url"] == "https://api.github.com" {
				if retry, ok := node.Config["retry"].(map[string]any); ok {
					attempts, _ := retry["maxAttempts"].(float64)
					hasBoundedRetry = attempts == 3
				}
			}
		case "ai":
			hasAI = true
		}
	}
	if !hasHTTP || !hasAI || !hasBoundedRetry {
		t.Fatalf("real product result lost requested structure: http=%v ai=%v retry=%v workflow=%s",
			hasHTTP, hasAI, hasBoundedRetry, raw)
	}
	readiness := domain.CheckWorkflowReadiness(wf, domain.ReadinessOptions{})
	for _, issue := range readiness.Issues {
		if issue.Severity == "fail" {
			t.Fatalf("real product result has readiness blocker %s: %s", issue.Code, issue.Message)
		}
	}

	calls, tokens, cost, model, provider := client.accounting()
	if calls < 1 || calls > 2 || tokens <= 0 || cost <= 0 || cost > maxUSD {
		t.Fatalf("real provider accounting outside envelope: calls=%d tokens=%d cost=%.8f cap=%.2f",
			calls, tokens, cost, maxUSD)
	}
	if provider != "anthropic" || model != ai.DefaultModel || meta.provider != provider || meta.model != model {
		t.Fatalf("real provider identity: provider=%q model=%q meta=%+v", provider, model, meta)
	}
	t.Logf("real_provider calls=%d model=%s tokens=%d cost_usd=%s",
		calls, model, tokens, fmt.Sprintf("%.8f", cost))
}
