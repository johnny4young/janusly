// Provider-neutral LLM chokepoint — the single gate every AI surface in
// the runtime speaks through, implements the contract's LlmClient. The
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
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"

	"github.com/johnny4young/janusly/internal/aiguidance"
)

// DefaultModel is the supported operating posture's model.
const DefaultModel = "claude-haiku-4-5-20251001"

// MaxModelIDBytes bounds operator/env model selectors before they can become
// provider request metadata, pricing lookup keys, telemetry dimensions, or
// reflected error text.
const MaxModelIDBytes = 128

// usage_events.quantity is int32. Provider usage outside this non-negative
// envelope is impossible for Janusly's bounded requests and must never wrap a
// billing record or create a negative cost.
const maxUsageTokensPerCall int64 = 1<<31 - 1

// providerResponseMaxBytes bounds the decoded HTTP body before the SDK may
// unmarshal it. Per-surface text limits still apply after parsing; this outer
// guard prevents a buggy or hostile compatible endpoint from allocating an
// arbitrarily large JSON envelope first.
const providerResponseMaxBytes int64 = 1 << 20

var errProviderResponseTooLarge = errors.New("provider response exceeded 1 MiB")

// Native Anthropic model ids use lowercase alphanumerics separated by
// hyphens. Keeping this grammar injective under the documented
// JANUSLY_LLM_PRICE_<MODEL> env-key projection prevents dots/underscores from
// colliding with a differently priced model.
var anthropicModelIDPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

// NormalizeModelID validates the Claude API model-id grammar Janusly accepts.
// Provider-qualified request hints are split by the client before this runs.
func NormalizeModelID(value string) (string, bool) {
	value = strings.TrimSpace(value)
	return value, value != "" && len(value) <= MaxModelIDBytes && anthropicModelIDPattern.MatchString(value)
}

// AIError is the classified failure every caller maps to
// {mode:"fallback", aiError}. Class is a stable small vocabulary the
// failure matrix pins.
type AIError struct {
	// Class: "no_client" | "auth" | "rate_limit" | "overloaded" |
	// "timeout" | "network" | "invalid_request" | "budget_blocked" |
	// "invalid_output" | "unknown".
	Class   string
	Message string
	// BeforeEgress is true only when Janusly rejected the logical call before
	// handing it to the configured provider (for example, a durable rate or
	// budget gate). Provider-originated errors deliberately leave this false so
	// callers can preserve deterministic fallback semantics and account for the
	// attempted model call accurately.
	BeforeEgress bool
}

func (e *AIError) Error() string { return e.Class + ": " + e.Message }

// GenerateTextInput mirrors the contract's LlmGenerateTextInput.
type GenerateTextInput struct {
	System string
	Prompt string
	// ResponseFormat is the provider-agnostic JSON hint. Anthropic has no
	// native JSON mode (the contract's registry entry is a no-op there
	// too); free_json extraction happens above this layer.
	ResponseFormat string
	// ModelHint overrides the resolved model for one call: a bare model id
	// keeps the configured provider; "<provider>/<model>" names both.
	ModelHint string
	// CacheSystemPrompt marks the system prompt as an ephemeral cache
	// breakpoint; the field is plumbed here so the input remains stable.
	CacheSystemPrompt bool
	// MaxOutputUnits caps output tokens for this call; 0 = the resolved
	// default.
	MaxOutputUnits int
	// Context carries usage-telemetry attribution into the recorder.
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

// GenerateTextResult mirrors the contract's LlmGenerateTextResult.
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
	// CostUsd is always finite on a successful result: explicitly zero for a
	// simulator, otherwise computed from the price admitted before egress.
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

// Config is the resolved client configuration; the organization catalog
// layers tenant values on top of these process defaults.
type Config struct {
	APIKey  string
	Model   string
	BaseURL string
	// HTTPClient optionally supplies an owned transport. Janusly clones the
	// client and wraps its transport with the provider-response byte guard;
	// bounded qualifications retain the original so they can close idle HTTP/2
	// connections before goleak evaluates the process.
	HTTPClient *http.Client
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
		option.WithHTTPClient(boundedProviderHTTPClient(cfg.HTTPClient)),
	}
	if cfg.BaseURL != "" {
		options = append(options, option.WithBaseURL(cfg.BaseURL))
	}
	return &anthropicClient{cfg: cfg, client: anthropic.NewClient(options...)}
}

type providerResponseLimitTransport struct {
	base http.RoundTripper
}

func (t providerResponseLimitTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := t.base.RoundTrip(request)
	if err != nil {
		return nil, err
	}
	if response.ContentLength > providerResponseMaxBytes {
		_ = response.Body.Close()
		return nil, errProviderResponseTooLarge
	}
	response.Body = &providerResponseLimitBody{body: response.Body, remaining: providerResponseMaxBytes}
	return response, nil
}

type providerResponseLimitBody struct {
	body      io.ReadCloser
	remaining int64
}

func (b *providerResponseLimitBody) Read(buffer []byte) (int, error) {
	if len(buffer) == 0 {
		return 0, nil
	}
	if b.remaining == 0 {
		var probe [1]byte
		read, err := b.body.Read(probe[:])
		if read > 0 {
			return 0, errProviderResponseTooLarge
		}
		return 0, err
	}
	if int64(len(buffer)) > b.remaining {
		buffer = buffer[:b.remaining]
	}
	read, err := b.body.Read(buffer)
	b.remaining -= int64(read)
	return read, err
}

func (b *providerResponseLimitBody) Close() error { return b.body.Close() }

func boundedProviderHTTPClient(source *http.Client) *http.Client {
	if source == nil {
		source = http.DefaultClient
	}
	clone := *source
	base := clone.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	clone.Transport = providerResponseLimitTransport{base: base}
	return &clone
}

func (c *anthropicClient) Configured() bool { return c.cfg.APIKey != "" }

// GenerateText is the totally-wrapped SDK call. The deferred recover is
// the last line of the contract: even an SDK bug cannot panic a caller.
func (c *anthropicClient) GenerateText(ctx context.Context, input GenerateTextInput) (result *GenerateTextResult, aiErr *AIError) {
	var (
		model         string
		startedAt     time.Time
		attempted     bool
		usageRecorded bool
	)
	defer func() {
		if recovered := recover(); recovered != nil {
			classified := &AIError{Class: "unknown", Message: compact(fmt.Sprintf("sdk panic: %v", recovered))}
			if attempted && !usageRecorded {
				latency := int64(0)
				if !startedAt.IsZero() {
					latency = time.Since(startedAt).Milliseconds()
				}
				usageRecorded = true
				fireUsage(ctx, input.Context, usageRecord{
					provider: "anthropic", model: model, latencyMs: latency,
					simulated: c.cfg.ProviderSimulated, mode: "fallback", aiError: classified.Error(),
				})
			}
			result, aiErr = nil, classified
		}
	}()
	if !c.Configured() {
		return nil, &AIError{Class: "no_client", Message: "no LLM provider API key configured"}
	}
	var valid bool
	model, valid = NormalizeModelID(c.cfg.Model)
	if !valid {
		return nil, &AIError{Class: "invalid_request", Message: "configured Anthropic model id is invalid"}
	}
	if hint := strings.TrimSpace(input.ModelHint); hint != "" {
		if len(hint) > MaxModelIDBytes+len("anthropic/") {
			return nil, &AIError{Class: "invalid_request", Message: "selected Anthropic model id is invalid"}
		}
		// "<provider>/<model>" names both; the runtime's only provider is
		// anthropic, so any other prefix is an invalid request.
		if provider, bare, ok := strings.Cut(hint, "/"); ok {
			if provider != "anthropic" {
				return nil, &AIError{Class: "invalid_request", Message: "selected completion provider is not supported"}
			}
			model, valid = NormalizeModelID(bare)
		} else {
			model, valid = NormalizeModelID(hint)
		}
		if !valid {
			return nil, &AIError{Class: "invalid_request", Message: "selected Anthropic model id is invalid"}
		}
	}
	price := GetModelPrice(model)
	if !c.cfg.ProviderSimulated && price == nil {
		classified := &AIError{
			Class:   "invalid_request",
			Message: "selected Anthropic model has no complete configured price; add its static price or a complete JANUSLY_LLM_PRICE_<MODEL> override",
		}
		usageRecorded = true
		fireUsage(ctx, input.Context, usageRecord{
			provider: "anthropic", model: model, simulated: false,
			mode: "fallback", aiError: classified.Error(),
		})
		return nil, classified
	}
	maxOutput := c.cfg.MaxOutputTokens
	if input.MaxOutputUnits > 0 && input.MaxOutputUnits < maxOutput {
		// A call site may narrow the tenant's output ceiling (for example the
		// 16-token experiment judge), but it may never expand it. Treating the
		// per-call hint as an override let an internal surface silently bypass
		// ai.maxOutputUnits and its spend/response-size guard.
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

	startedAt = time.Now()
	attempted = true
	message, err := c.client.Messages.New(ctx, params)
	latency := time.Since(startedAt).Milliseconds()
	if err != nil {
		classified := classify(err)
		usageRecorded = true
		fireUsage(ctx, input.Context, usageRecord{
			provider: "anthropic", model: model, latencyMs: latency,
			simulated: c.cfg.ProviderSimulated, mode: "fallback", aiError: classified.Error(),
		})
		return nil, classified
	}
	if message == nil {
		classified := &AIError{Class: "unknown", Message: "provider returned an empty response"}
		usageRecorded = true
		fireUsage(ctx, input.Context, usageRecord{
			provider: "anthropic", model: model, latencyMs: latency,
			simulated: c.cfg.ProviderSimulated, mode: "fallback", aiError: classified.Error(),
		})
		return nil, classified
	}
	providerUsage, usageValid := validatedProviderUsage(
		message.Usage.InputTokens,
		message.Usage.OutputTokens,
		message.Usage.CacheReadInputTokens,
		message.Usage.CacheCreationInputTokens,
	)
	if !usageValid {
		classified := &AIError{Class: "unknown", Message: "provider returned invalid usage accounting"}
		usageRecorded = true
		fireUsage(ctx, input.Context, usageRecord{
			provider: "anthropic", model: model, latencyMs: latency,
			simulated: c.cfg.ProviderSimulated, mode: "fallback", aiError: classified.Error(),
		})
		return nil, classified
	}

	var text strings.Builder
	for _, block := range message.Content {
		if block.Type == "text" {
			text.WriteString(block.Text)
		}
	}
	out := &GenerateTextResult{
		Text:              text.String(),
		FinishReason:      string(message.StopReason),
		Provider:          "anthropic",
		Model:             model,
		ProviderSimulated: c.cfg.ProviderSimulated,
		LatencyMs:         latency,
		Usage:             providerUsage,
	}
	// Cost: the price admitted before the request (env override wins). An
	// explicitly simulated provider always records ZERO cost; a real provider
	// is never called without a price.
	if c.cfg.ProviderSimulated {
		zero := 0.0
		out.CostUsd = &zero
	} else {
		out.CostUsd = ComputeCostUsd(price, out.Usage)
	}
	usageRecorded = true
	fireUsage(ctx, input.Context, usageRecord{
		provider: "anthropic", model: model, latencyMs: latency,
		simulated: c.cfg.ProviderSimulated, mode: "ai",
		usage: &out.Usage, costUsd: out.CostUsd,
	})
	return out, nil
}

func validatedProviderUsage(input, output, cached, created int64) (Usage, bool) {
	values := [...]int64{input, output, cached, created}
	var total int64
	for _, value := range values {
		if value < 0 || value > maxUsageTokensPerCall {
			return Usage{}, false
		}
		total += value
	}
	if total > maxUsageTokensPerCall {
		return Usage{}, false
	}
	// Anthropic reports ordinary, cache-creation, and cache-read input tokens
	// as disjoint counters. Their documented total is the sum of all four
	// classes including output.
	return Usage{
		InputTokens: int(input), OutputTokens: int(output), TotalTokens: int(total),
		CachedInputTokens: int(cached), CacheCreationInputTokens: int(created),
	}, true
}

// classify maps any SDK failure into the stable AIError vocabulary the
// failure matrix pins.
func classify(err error) *AIError {
	if errors.Is(err, errProviderResponseTooLarge) {
		return &AIError{Class: "unknown", Message: errProviderResponseTooLarge.Error()}
	}
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
	message = strings.TrimSpace(aiguidance.ScrubGuidanceSecrets(message))
	runes := []rune(message)
	if len(runes) > 500 {
		return string(runes[:500])
	}
	return message
}
