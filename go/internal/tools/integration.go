// Integration-tool chokepoint (reference integration-tooling/shared.ts +
// webhook.ts): ONE shared credential, rate-limit, and usage seam for
// every provider tool. Invariants:
//   - fetchHttpTarget-only egress (the deps.Post closure wraps the
//     executor primitive) — no vendor SDK ever dials on its own.
//   - Envelopes NEVER throw: every failure mode answers {ok:false, error}
//     with latencyMs; errors never reference env-var names or secret refs
//     (the gate's messages are deliberately generic).
//   - Telemetry (usage recorder) never breaks the tool — fired on every
//     path, dropped silently on failure.
//   - writeSide stays the static bit the sandbox gate reads.
//
// The registry carries the CATALOG definitions (name/fields/writeSide);
// execution is intercepted by the tool executor with runtime deps — the
// same seam pattern the vector tools use.
package tools

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// IntegrationDeps are the engine-built runtime seams.
type IntegrationDeps struct {
	// Gate runs credential lookup (org-scoped, by kind+name), secret
	// resolution, and the org+credential rate limit. Returns the secret
	// or a generic error message.
	Gate func(ctx context.Context, tool, credentialKind, credentialName string, rateLimitPerMin int) (string, string)
	// Record fires one usage row; must never break the tool.
	Record func(tool, credentialName string, ok bool, statusCode int, errMessage string, latencyMs int)
	// Post performs the guarded outbound POST (FetchHTTPTarget wrapper).
	Post func(ctx context.Context, url string, headers map[string]string, body []byte) (statusCode int, responseBody string, errMessage string)
	// Fetch is the method-explicit guarded outbound call (the PagerDuty
	// tools need GET/PUT); same FetchHTTPTarget chokepoint as Post.
	Fetch func(ctx context.Context, method, url string, headers map[string]string, body []byte) (statusCode int, responseBody string, errMessage string)
	// RateLimitPerMin resolves the per-tool tenant bound (org config →
	// env → default), keyed by the tool's family name.
	RateLimitPerMin func(family string, fallback int) int
	// Now is the clock seam (deterministic signature tests).
	Now func() time.Time
	// RateLimit enforces one org-scoped bucket WITHOUT a credential
	// (email.send has no stored credential); returns "" or the message.
	RateLimit func(ctx context.Context, bucket string, perMin int) string
	// Email resolves the tenant mailer posture (provider + default from).
	Email func() EmailSettings
	// PdfKey assembles the tenant-scoped object key for pdf.generate.
	PdfKey PdfKeyBuilder
}

const webhookSignatureHeader = "x-janusly-signature"

var crlfPattern = regexp.MustCompile(`[\r\n]`)

// SignWebhookPayload returns the Stripe-style `t=<unix>,v1=<hex>` HMAC
// over `${t}.${body}` — the exact bytes POSTed are the bytes signed.
func SignWebhookPayload(secret, body string, unixSeconds int64) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = fmt.Fprintf(mac, "%d.%s", unixSeconds, body)
	return fmt.Sprintf("t=%d,v1=%s", unixSeconds, hex.EncodeToString(mac.Sum(nil)))
}

// integrationToolNames marks the registry entries the executor must
// intercept with runtime deps.
var integrationToolNames = map[string]bool{
	"webhook.send":                   true,
	"email.send":                     true,
	"pdf.generate":                   true,
	"pagerduty.incident.get":         true,
	"pagerduty.incident.acknowledge": true,
	"pagerduty.incident.snooze":      true,
}

// IsIntegrationTool reports whether the executor should route this call
// through ExecuteIntegrationTool.
func IsIntegrationTool(name string) bool { return integrationToolNames[name] }

func integrationTools() []Definition {
	unavailable := func(_ context.Context, _ map[string]any) (map[string]any, error) {
		// Reached only outside a run context (e.g. direct registry use in
		// unit tests) — the envelope contract still holds: never throw.
		return map[string]any{"ok": false, "error": "integration tools require run context", "latencyMs": 0}, nil
	}
	return []Definition{{
		Name:        "webhook.send",
		Description: "POST a signed JSON payload to an external URL with an HMAC-SHA256 signature header.",
		Required:    []string{"credential", "url", "payload"},
		Optional:    []string{"signatureHeader", "headers"},
		Fields: []Field{
			{Name: "credential", Type: "string", Required: true},
			{Name: "url", Type: "string", Required: true},
			{Name: "payload", Type: "object", Required: true},
			{Name: "signatureHeader", Type: "string"},
			{Name: "headers", Type: "object"},
		},
		InputExample: map[string]any{
			"credential": "partner-webhook",
			"url":        "https://partner.example.com/hooks/incident",
			"payload":    map[string]any{"event": "incident", "severity": "high"},
		},
		WriteSide: true,
		Execute:   unavailable,
	}}
}

func envelopeError(message string, latencyMs int) map[string]any {
	return map[string]any{"ok": false, "error": message, "latencyMs": latencyMs}
}

// ExecuteIntegrationTool dispatches one integration call through the
// chokepoint. NEVER returns an error — the envelope carries every
// failure mode.
func ExecuteIntegrationTool(ctx context.Context, name string, input map[string]any, deps *IntegrationDeps) map[string]any {
	start := time.Now()
	if deps == nil || deps.Gate == nil || (deps.Post == nil && deps.Fetch == nil) {
		return envelopeError("integration tools require run context", 0)
	}
	now := time.Now
	if deps.Now != nil {
		now = deps.Now
	}
	latency := func() int { return int(time.Since(start).Milliseconds()) }
	record := func(credentialName string, ok bool, statusCode int, errMessage string) {
		if deps.Record != nil {
			deps.Record(name, credentialName, ok, statusCode, errMessage, latency())
		}
	}
	switch name {
	case "email.send":
		return executeEmailSend(ctx, input, deps)
	case "pdf.generate":
		return executePdfGenerate(ctx, input, deps)
	case "pagerduty.incident.get", "pagerduty.incident.acknowledge", "pagerduty.incident.snooze":
		return executePagerDutyAPICall(ctx, name, input, deps)
	case "webhook.send":
		credential, _ := input["credential"].(string)
		rawURL, _ := input["url"].(string)
		payload, hasPayload := input["payload"].(map[string]any)
		if credential == "" || rawURL == "" || !hasPayload {
			return envelopeError("webhook.send requires credential, url, and payload", latency())
		}
		// Custom headers: capped at 10, ≤200 chars, CR/LF rejected
		// (header-splitting defense); reserved names cannot be overridden.
		extraHeaders := map[string]string{}
		if rawHeaders, ok := input["headers"].(map[string]any); ok {
			if len(rawHeaders) > 10 {
				return envelopeError("max 10 custom headers", latency())
			}
			for key, value := range rawHeaders {
				text, ok := value.(string)
				if !ok || text == "" || len(text) > 200 || len(key) > 60 || crlfPattern.MatchString(text) {
					return envelopeError("invalid custom header", latency())
				}
				extraHeaders[strings.ToLower(key)] = text
			}
		}
		rateLimit := 120
		if deps.RateLimitPerMin != nil {
			rateLimit = deps.RateLimitPerMin("webhook", 120)
		}
		secret, gateError := deps.Gate(ctx, name, "webhook_secret", credential, rateLimit)
		if gateError != "" {
			record(credential, false, 0, gateError)
			return envelopeError(gateError, latency())
		}
		serialized, err := json.Marshal(payload)
		if err != nil {
			record(credential, false, 0, "payload serialization failed")
			return envelopeError("payload serialization failed", latency())
		}
		headerName := webhookSignatureHeader
		if override, ok := input["signatureHeader"].(string); ok && override != "" {
			headerName = strings.ToLower(override)
		}
		signature := SignWebhookPayload(secret, string(serialized), now().Unix())
		merged := map[string]string{"content-type": "application/json"}
		for key, value := range extraHeaders {
			if key == "content-type" || key == "authorization" || key == headerName {
				continue
			}
			merged[key] = value
		}
		merged[headerName] = signature
		statusCode, responseBody, postError := deps.Post(ctx, rawURL, merged, serialized)
		if postError != "" {
			record(credential, false, statusCode, postError)
			return envelopeError(postError, latency())
		}
		ok := statusCode >= 200 && statusCode < 300
		if !ok {
			message := fmt.Sprintf("webhook responded %d: %s", statusCode, truncateBody(responseBody))
			record(credential, false, statusCode, message)
			return map[string]any{"ok": false, "statusCode": statusCode, "error": message, "latencyMs": latency()}
		}
		record(credential, true, statusCode, "")
		return map[string]any{"ok": true, "statusCode": statusCode, "latencyMs": latency()}
	default:
		return envelopeError("Unknown integration tool: "+name, latency())
	}
}

func truncateBody(body string) string {
	if len(body) > 200 {
		return body[:200] + "…"
	}
	return body
}
