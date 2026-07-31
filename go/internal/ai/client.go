// Provider-neutral LLM chokepoint — the single gate every AI surface in
// the pilot speaks through, ported from the reference's LlmClient. The
// supported completion posture is Anthropic-only (claude-haiku-4-5) via
// the official anthropic-sdk-go, but the INTERFACE never names a vendor:
// call sites see GenerateText(input) -> (result, *AIError).
//
// The sacred fallback contract lives at this boundary: the SDK call is
// wrapped totally — any transport error, HTTP status, malformed reply, or
// panic becomes a CLASSIFIED *AIError (never a raw SDK error, never a
// panic to the caller), and every caller degrades to
// {mode:"fallback", aiError} from it. Nothing outside internal/ai may
// import the SDK — an import-boundary test enforces the rule.
package ai

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// DefaultModel is the supported operating posture's model.
const DefaultModel = "claude-haiku-4-5-20251001"

// AIError is the classified failure every caller maps to
// {mode:"fallback", aiError}. Class is a stable small vocabulary the
// failure matrix pins.
type AIError struct {
	// Class: "no_client" | "auth" | "rate_limit" | "overloaded" |
	// "timeout" | "network" | "invalid_request" | "unknown".
	Class   string
	Message string
}

func (e *AIError) Error() string { return e.Class + ": " + e.Message }

// GenerateTextInput mirrors the reference's LlmGenerateTextInput.
type GenerateTextInput struct {
	System string
	Prompt string
	// ResponseFormat is the provider-agnostic JSON hint. Anthropic has no
	// native JSON mode (the reference's registry entry is a no-op there
	// too); free_json extraction happens above this layer.
	ResponseFormat string
	// ModelHint overrides the resolved model for one call: a bare model id
	// keeps the configured provider; "<provider>/<model>" names both.
	ModelHint string
	// CacheSystemPrompt marks the system prompt as an ephemeral cache
	// breakpoint (T-102 consumes it; plumbed now so the input is stable).
	CacheSystemPrompt bool
	// MaxOutputUnits caps output tokens for this call; 0 = the resolved
	// default.
	MaxOutputUnits int
	// Context carries usage-telemetry attribution (T-101 consumes it).
	Context CallContext
}

// CallContext is the per-call telemetry attribution.
type CallContext struct {
	OrgID      string
	UserID     string
	RunID      string
	NodeID     string
	WorkflowID string
}

// GenerateTextResult mirrors the reference's LlmGenerateTextResult.
type GenerateTextResult struct {
	Text         string
	FinishReason string
	Usage        Usage
	Provider     string
	Model        string
	// ProviderSimulated is true only for an explicitly declared
	// provider-compatible simulator (never billed).
	ProviderSimulated bool
	LatencyMs         int64
	// CostUsd is nil when no price entry exists for the model.
	CostUsd *float64
}

// Usage is the token accounting passthrough.
type Usage struct {
	InputTokens              int
	OutputTokens             int
	TotalTokens              int
	CachedInputTokens        int
	CacheCreationInputTokens int
}

// Client is the chokepoint interface call sites depend on.
type Client interface {
	// GenerateText returns (result, nil) on success or (nil, *AIError) on
	// any failure — never a raw SDK error, never a panic.
	GenerateText(ctx context.Context, input GenerateTextInput) (*GenerateTextResult, *AIError)
	// Configured reports whether a provider key is present; unconfigured
	// clients fail every call with class "no_client".
	Configured() bool
}

// Config is the resolved client configuration (T-100 layers the org
// catalog on top of these process defaults).
type Config struct {
	APIKey  string
	Model   string
	BaseURL string
	// TimeoutMs bounds one SDK call end to end.
	TimeoutMs int
	// MaxRetries is the SDK-level retry count.
	MaxRetries int
	// MaxOutputTokens is the default per-call output cap.
	MaxOutputTokens int
	// ProviderSimulated marks an explicitly declared simulator endpoint;
	// its usage persists but never bills.
	ProviderSimulated bool
}

// anthropicClient is the production implementation.
type anthropicClient struct {
	cfg    Config
	client anthropic.Client
}

// New builds the chokepoint client from a resolved config. An empty API
// key yields a client whose every call fails classified as "no_client" —
// the caller's fallback path, not an error at construction.
func New(cfg Config) Client {
	if cfg.Model == "" {
		cfg.Model = DefaultModel
	}
	if cfg.TimeoutMs <= 0 {
		cfg.TimeoutMs = 30_000
	}
	if cfg.MaxRetries < 0 {
		cfg.MaxRetries = 0
	}
	if cfg.MaxOutputTokens <= 0 {
		cfg.MaxOutputTokens = 4096
	}
	options := []option.RequestOption{
		option.WithAPIKey(cfg.APIKey),
		option.WithMaxRetries(cfg.MaxRetries),
		option.WithRequestTimeout(time.Duration(cfg.TimeoutMs) * time.Millisecond),
	}
	if cfg.BaseURL != "" {
		options = append(options, option.WithBaseURL(cfg.BaseURL))
	}
	return &anthropicClient{cfg: cfg, client: anthropic.NewClient(options...)}
}

func (c *anthropicClient) Configured() bool { return c.cfg.APIKey != "" }

// GenerateText is the totally-wrapped SDK call. The deferred recover is
// the last line of the contract: even an SDK bug cannot panic a caller.
func (c *anthropicClient) GenerateText(ctx context.Context, input GenerateTextInput) (result *GenerateTextResult, aiErr *AIError) {
	defer func() {
		if recovered := recover(); recovered != nil {
			result, aiErr = nil, &AIError{Class: "unknown", Message: fmt.Sprintf("sdk panic: %v", recovered)}
		}
	}()
	if !c.Configured() {
		return nil, &AIError{Class: "no_client", Message: "no LLM provider API key configured"}
	}
	model := c.cfg.Model
	if hint := strings.TrimSpace(input.ModelHint); hint != "" {
		// "<provider>/<model>" names both; the pilot's only provider is
		// anthropic, so any other prefix is an invalid request.
		if provider, bare, ok := strings.Cut(hint, "/"); ok {
			if provider != "anthropic" {
				return nil, &AIError{Class: "invalid_request",
					Message: fmt.Sprintf("provider %q is not configured", provider)}
			}
			model = bare
		} else {
			model = hint
		}
	}
	maxOutput := c.cfg.MaxOutputTokens
	if input.MaxOutputUnits > 0 {
		maxOutput = input.MaxOutputUnits
	}

	params := anthropic.MessageNewParams{
		Model:     anthropic.Model(model),
		MaxTokens: int64(maxOutput),
		Messages: []anthropic.MessageParam{
			anthropic.NewUserMessage(anthropic.NewTextBlock(input.Prompt)),
		},
	}
	if input.System != "" {
		block := anthropic.TextBlockParam{Text: input.System}
		if input.CacheSystemPrompt {
			block.CacheControl = anthropic.NewCacheControlEphemeralParam()
		}
		params.System = []anthropic.TextBlockParam{block}
	}

	startedAt := time.Now()
	message, err := c.client.Messages.New(ctx, params)
	latency := time.Since(startedAt).Milliseconds()
	if err != nil {
		classified := classify(err)
		fireUsage(ctx, input.Context, usageRecord{
			provider: "anthropic", model: model, latencyMs: latency,
			simulated: c.cfg.ProviderSimulated, mode: "fallback", aiError: classified.Error(),
		})
		return nil, classified
	}
	if message == nil {
		return nil, &AIError{Class: "unknown", Message: "provider returned an empty response"}
	}

	text := ""
	for _, block := range message.Content {
		if block.Type == "text" {
			text += block.Text
		}
	}
	out := &GenerateTextResult{
		Text:              text,
		FinishReason:      string(message.StopReason),
		Provider:          "anthropic",
		Model:             model,
		ProviderSimulated: c.cfg.ProviderSimulated,
		LatencyMs:         latency,
		Usage: Usage{
			InputTokens:              int(message.Usage.InputTokens),
			OutputTokens:             int(message.Usage.OutputTokens),
			TotalTokens:              int(message.Usage.InputTokens + message.Usage.OutputTokens),
			CachedInputTokens:        int(message.Usage.CacheReadInputTokens),
			CacheCreationInputTokens: int(message.Usage.CacheCreationInputTokens),
		},
	}
	// Cost: the price table (env override wins); an explicitly simulated
	// provider always records ZERO cost, an unknown model records null.
	if c.cfg.ProviderSimulated {
		zero := 0.0
		out.CostUsd = &zero
	} else {
		out.CostUsd = ComputeCostUsd(GetModelPrice(model), out.Usage)
	}
	fireUsage(ctx, input.Context, usageRecord{
		provider: "anthropic", model: model, latencyMs: latency,
		simulated: c.cfg.ProviderSimulated, mode: "ai",
		usage: &out.Usage, costUsd: out.CostUsd,
	})
	return out, nil
}

// classify maps any SDK failure into the stable AIError vocabulary the
// failure matrix pins.
func classify(err error) *AIError {
	var apiErr *anthropic.Error
	if errors.As(err, &apiErr) {
		switch apiErr.StatusCode {
		case http.StatusUnauthorized, http.StatusForbidden:
			return &AIError{Class: "auth", Message: compact(apiErr.Error())}
		case http.StatusTooManyRequests:
			return &AIError{Class: "rate_limit", Message: compact(apiErr.Error())}
		case 529:
			return &AIError{Class: "overloaded", Message: compact(apiErr.Error())}
		case http.StatusBadRequest, http.StatusNotFound, http.StatusUnprocessableEntity:
			return &AIError{Class: "invalid_request", Message: compact(apiErr.Error())}
		default:
			if apiErr.StatusCode >= 500 {
				return &AIError{Class: "overloaded", Message: compact(apiErr.Error())}
			}
			return &AIError{Class: "unknown", Message: compact(apiErr.Error())}
		}
	}
	if errors.Is(err, context.DeadlineExceeded) || strings.Contains(err.Error(), "deadline exceeded") ||
		strings.Contains(err.Error(), "timeout") {
		return &AIError{Class: "timeout", Message: compact(err.Error())}
	}
	if errors.Is(err, context.Canceled) {
		return &AIError{Class: "timeout", Message: "call canceled"}
	}
	return &AIError{Class: "network", Message: compact(err.Error())}
}

// compact bounds an error message so a provider body can never bloat a
// persisted fallback envelope.
func compact(message string) string {
	message = strings.TrimSpace(message)
	if len(message) > 500 {
		return message[:500]
	}
	return message
}
