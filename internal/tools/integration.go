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
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/net/http/httpguts"
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
	// tools need GET/PUT); same FetchHTTPTarget chokepoint as Post. Callers
	// supply their provider-specific response cap instead of inheriting the
	// generic HTTP tool's larger default.
	Fetch func(ctx context.Context, method, url string, headers map[string]string, body []byte, maxResponseBytes int) (statusCode int, responseBody string, errMessage string)
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
	// OrgID exposes the tenant for pool keying (db.* tools); nil-safe.
	OrgID func() string
	// Lock serializes a tenant resource across every process sharing the
	// durable PostgreSQL control plane. Callers must defer the returned
	// release function. sheet.append uses it around object read+write.
	Lock func(ctx context.Context, resource string) (release func(), errMessage string)
}

const webhookSignatureHeader = "x-janusly-signature"

const (
	integrationCredentialMaxRunes = 200
	integrationPayloadMaxBytes    = 256 << 10
	slackTextMaxBytes             = 40_000
	githubOwnerRepoMaxRunes       = 100
	githubTitleMaxRunes           = 256
	githubBodyMaxBytes            = 256 << 10
	githubListEntryMaxRunes       = 100
	webhookURLMaxBytes            = 4_096
)

var crlfPattern = regexp.MustCompile(`[\r\n]`)

var githubPathSegment = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

var forbiddenWebhookHeaders = map[string]bool{
	"authorization": true, "connection": true, "content-length": true,
	"content-type": true, "host": true, "proxy-authorization": true,
	"te": true, "trailer": true, "transfer-encoding": true, "upgrade": true,
}

func validateTrimmedIdentifier(input map[string]any, field string, maxRunes int, options InputValidationOptions) error {
	raw, present := input[field]
	if !present || isDeferredWholeTemplate(raw, options) {
		return nil
	}
	value, _ := raw.(string)
	if value == "" || value != strings.TrimSpace(value) || utf8.RuneCountInString(value) > maxRunes {
		return fmt.Errorf("%s must be a trimmed 1..%d character string", field, maxRunes)
	}
	return nil
}

func validateStringList(input map[string]any, field string, maximum, maxRunes int, options InputValidationOptions) error {
	raw, present := input[field]
	if !present || isDeferredWholeTemplate(raw, options) {
		return nil
	}
	items, ok := arrayItems(raw)
	if !ok || len(items) > maximum {
		return fmt.Errorf("%s must contain at most %d strings", field, maximum)
	}
	seen := make(map[string]bool, len(items))
	for _, item := range items {
		value, ok := item.(string)
		if !ok || value == "" || value != strings.TrimSpace(value) || utf8.RuneCountInString(value) > maxRunes {
			return fmt.Errorf("%s entries must be trimmed 1..%d character strings", field, maxRunes)
		}
		canonical := strings.ToLower(value)
		if seen[canonical] {
			return fmt.Errorf("%s entries must be unique case-insensitively", field)
		}
		seen[canonical] = true
	}
	return nil
}

func validateSlackInput(input map[string]any, options InputValidationOptions) error {
	if err := validateTrimmedIdentifier(input, "credential", integrationCredentialMaxRunes, options); err != nil {
		return err
	}
	textRaw, textPresent := input["text"]
	blocksRaw, blocksPresent := input["blocks"]
	textPotential := textPresent && isDeferredWholeTemplate(textRaw, options)
	blocksPotential := blocksPresent && isDeferredWholeTemplate(blocksRaw, options)
	if textPresent && !textPotential {
		text, _ := textRaw.(string)
		if len(text) > slackTextMaxBytes {
			return fmt.Errorf("text exceeds %d bytes", slackTextMaxBytes)
		}
		textPotential = strings.TrimSpace(text) != ""
	}
	if blocksPresent && !blocksPotential {
		blocks, ok := arrayItems(blocksRaw)
		if !ok || len(blocks) > 50 {
			return fmt.Errorf("blocks must contain at most 50 objects")
		}
		for _, rawBlock := range blocks {
			if block, ok := rawBlock.(map[string]any); !ok || block == nil {
				return fmt.Errorf("blocks must contain only objects")
			}
		}
		serialized, err := json.Marshal(blocksRaw)
		if err != nil || len(serialized) > integrationPayloadMaxBytes {
			return fmt.Errorf("blocks exceed %d bytes", integrationPayloadMaxBytes)
		}
		blocksPotential = len(blocks) > 0
	}
	// Partial authoring may omit both optional content fields, but once an
	// author supplies either field it must already describe a deliverable
	// message. This prevents an explicitly empty value from surviving draft
	// validation only to fail at the egress boundary.
	if !textPotential && !blocksPotential && (options.RequireAll || textPresent || blocksPresent) {
		return fmt.Errorf("text or non-empty blocks is required")
	}
	if !isDeferredWholeTemplate(textRaw, options) && !isDeferredWholeTemplate(blocksRaw, options) {
		payload := map[string]any{}
		if textPresent {
			payload["text"] = textRaw
		}
		if blocksPresent {
			payload["blocks"] = blocksRaw
		}
		serialized, err := json.Marshal(payload)
		if err != nil || len(serialized) > integrationPayloadMaxBytes {
			return fmt.Errorf("message payload exceeds %d bytes", integrationPayloadMaxBytes)
		}
	}
	return nil
}

func validateGitHubIssueInput(input map[string]any, options InputValidationOptions) error {
	if err := validateTrimmedIdentifier(input, "credential", integrationCredentialMaxRunes, options); err != nil {
		return err
	}
	for _, field := range []string{"owner", "repo"} {
		if err := validateTrimmedIdentifier(input, field, githubOwnerRepoMaxRunes, options); err != nil {
			return err
		}
		if raw, present := input[field]; present && !isDeferredWholeTemplate(raw, options) {
			value, _ := raw.(string)
			if !githubPathSegment.MatchString(value) || value == "." || value == ".." {
				return fmt.Errorf("%s must be a URL-safe GitHub path segment", field)
			}
		}
	}
	if err := validateTrimmedIdentifier(input, "title", githubTitleMaxRunes, options); err != nil {
		return err
	}
	if raw, present := input["title"]; present && !isDeferredWholeTemplate(raw, options) {
		if crlfPattern.MatchString(raw.(string)) {
			return fmt.Errorf("title must be single-line")
		}
	}
	if raw, present := input["body"]; present && !isDeferredWholeTemplate(raw, options) {
		if len(raw.(string)) > githubBodyMaxBytes {
			return fmt.Errorf("body exceeds %d bytes", githubBodyMaxBytes)
		}
	}
	if err := validateStringList(input, "labels", 50, githubListEntryMaxRunes, options); err != nil {
		return err
	}
	return validateStringList(input, "assignees", 10, githubListEntryMaxRunes, options)
}

func validateWebhookInput(input map[string]any, options InputValidationOptions) error {
	if err := validateTrimmedIdentifier(input, "credential", integrationCredentialMaxRunes, options); err != nil {
		return err
	}
	if raw, present := input["url"]; present && !isDeferredWholeTemplate(raw, options) {
		value, _ := raw.(string)
		parsed, err := url.ParseRequestURI(value)
		if value == "" || value != strings.TrimSpace(value) || len(value) > webhookURLMaxBytes || err != nil ||
			parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return fmt.Errorf("url must be an absolute HTTP(S) URL of at most %d bytes", webhookURLMaxBytes)
		}
	}
	if raw, present := input["payload"]; present && !isDeferredWholeTemplate(raw, options) {
		serialized, err := json.Marshal(raw)
		if err != nil || len(serialized) > integrationPayloadMaxBytes {
			return fmt.Errorf("payload exceeds %d bytes", integrationPayloadMaxBytes)
		}
	}
	signatureName := webhookSignatureHeader
	if raw, present := input["signatureHeader"]; present && !isDeferredWholeTemplate(raw, options) {
		value, _ := raw.(string)
		if value == "" || value != strings.TrimSpace(value) || len(value) > 60 || !httpguts.ValidHeaderFieldName(value) {
			return fmt.Errorf("signatureHeader must be a valid 1..60 byte HTTP header name")
		}
		signatureName = strings.ToLower(value)
		if forbiddenWebhookHeaders[signatureName] {
			return fmt.Errorf("signatureHeader uses a reserved HTTP header")
		}
	}
	if raw, present := input["headers"]; present && !isDeferredWholeTemplate(raw, options) {
		headers, _ := raw.(map[string]any)
		if len(headers) > 10 {
			return fmt.Errorf("headers supports at most 10 entries")
		}
		seen := make(map[string]bool, len(headers))
		for key, rawValue := range headers {
			value, ok := rawValue.(string)
			lower := strings.ToLower(key)
			if !ok || key == "" || value == "" || len(key) > 60 || len(value) > 200 ||
				!httpguts.ValidHeaderFieldName(key) || !httpguts.ValidHeaderFieldValue(value) {
				return fmt.Errorf("headers must use valid names and values bounded to 60/200 bytes")
			}
			if forbiddenWebhookHeaders[lower] || lower == signatureName {
				return fmt.Errorf("headers cannot override reserved or signature headers")
			}
			if seen[lower] {
				return fmt.Errorf("headers must be unique case-insensitively")
			}
			seen[lower] = true
		}
	}
	return nil
}

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
	"github.create_issue":            true,
	"slack.post":                     true,
	"email.send":                     true,
	"pdf.generate":                   true,
	"sheet.append":                   true,
	"pagerduty.incident.get":         true,
	"pagerduty.incident.acknowledge": true,
	"pagerduty.incident.snooze":      true,
	"db.schema.describe":             true,
	"db.query.read":                  true,
	"db.query.write":                 true,
	"db.query.transaction":           true,
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
	return []Definition{
		{
			Name:        "slack.post",
			Description: "Send a message to a Slack channel via a stored Incoming Webhook URL.",
			Required:    []string{"credential"},
			Optional:    []string{"text", "blocks"},
			Fields: []Field{
				{Name: "credential", Type: "string", Required: true},
				{Name: "text", Type: "string"},
				{Name: "blocks", Type: "json", AcceptedTypes: []string{"array"}},
			},
			InputExample: map[string]any{"credential": "incidents-slack", "text": "Incident detected."},
			Validate:     validateSlackInput,
			WriteSide:    true,
			Execute:      unavailable,
		},
		{
			Name:        "github.create_issue",
			Description: "Create a GitHub issue using a stored PAT credential.",
			Required:    []string{"credential", "owner", "repo", "title"},
			Optional:    []string{"body", "labels", "assignees"},
			Fields: []Field{
				{Name: "credential", Type: "string", Required: true},
				{Name: "owner", Type: "string", Required: true},
				{Name: "repo", Type: "string", Required: true},
				{Name: "title", Type: "string", Required: true},
				{Name: "body", Type: "string"},
				{Name: "labels", Type: "json", AcceptedTypes: []string{"array"}},
				{Name: "assignees", Type: "json", AcceptedTypes: []string{"array"}},
			},
			InputExample: map[string]any{
				"credential": "bot-github", "owner": "janusly", "repo": "demo",
				"title": "Incident triage", "body": "Details…",
			},
			Validate:  validateGitHubIssueInput,
			WriteSide: true,
			Execute:   unavailable,
		},
		{
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
			Validate:  validateWebhookInput,
			WriteSide: true,
			Execute:   unavailable,
		},
	}
}

func envelopeError(message string, latencyMs int) map[string]any {
	return map[string]any{"ok": false, "error": message, "latencyMs": latencyMs}
}

// API-level deliveries can call ExecuteIntegrationTool without passing through
// the workflow executor. Keep one immutable built-in registry so those paths
// receive the same input contract without rebuilding the catalog per call.
var integrationInputRegistry = NewRegistry()

// ExecuteIntegrationTool dispatches one integration call through the
// chokepoint. NEVER returns an error — the envelope carries every
// failure mode.
func ExecuteIntegrationTool(ctx context.Context, name string, input map[string]any, deps *IntegrationDeps) map[string]any {
	start := time.Now()
	if deps == nil || deps.Gate == nil || (deps.Post == nil && deps.Fetch == nil) {
		return envelopeError("integration tools require run context", 0)
	}
	if err := integrationInputRegistry.ValidateResolvedInput(name, input); err != nil {
		latencyMs := int(time.Since(start).Milliseconds())
		credential, _ := input["credential"].(string)
		if credential != strings.TrimSpace(credential) || utf8.RuneCountInString(credential) > integrationCredentialMaxRunes {
			credential = ""
		}
		if deps.Record != nil {
			deps.Record(name, credential, false, 0, err.Error(), latencyMs)
		}
		return envelopeError(err.Error(), latencyMs)
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
	case "sheet.append":
		return executeSheetAppend(ctx, input, deps)
	case "pagerduty.incident.get", "pagerduty.incident.acknowledge", "pagerduty.incident.snooze":
		return executePagerDutyAPICall(ctx, name, input, deps)
	case "db.schema.describe", "db.query.read", "db.query.write", "db.query.transaction":
		return executeDbTool(ctx, name, input, deps)
	case "github.create_issue":
		return executeGitHubCreateIssue(ctx, input, deps, latency, record)
	case "slack.post":
		return executeSlackPost(ctx, input, deps, latency, record)
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

func isSlackHookURL(raw string) bool {
	candidate, err := url.Parse(raw)
	if err != nil || candidate.User != nil {
		return false
	}
	if candidate.Scheme == "https" && strings.EqualFold(candidate.Hostname(), "hooks.slack.com") {
		return true
	}
	if !localIntegrationSimulatorEnabled() {
		return false
	}
	base, err := url.Parse(strings.TrimSpace(os.Getenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL")))
	if err != nil || base.Scheme == "" || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return false
	}
	prefix := strings.TrimRight(base.Path, "/") + "/slack/"
	return candidate.Scheme == base.Scheme && candidate.Host == base.Host && strings.HasPrefix(candidate.Path, prefix)
}

func slackBlocksInput(input map[string]any) ([]map[string]any, bool, bool) {
	raw, present := input["blocks"]
	if !present {
		return nil, false, true
	}
	values, ok := arrayItems(raw)
	if !ok || len(values) > 50 {
		return nil, true, false
	}
	blocks := make([]map[string]any, 0, len(values))
	for _, rawBlock := range values {
		block, ok := rawBlock.(map[string]any)
		if !ok {
			return nil, true, false
		}
		blocks = append(blocks, block)
	}
	return blocks, true, true
}

func executeSlackPost(
	ctx context.Context,
	input map[string]any,
	deps *IntegrationDeps,
	latency func() int,
	record func(string, bool, int, string),
) map[string]any {
	credential, _ := input["credential"].(string)
	textRaw, textProvided := input["text"]
	text, textValid := textRaw.(string)
	blocks, blocksProvided, blocksValid := slackBlocksInput(input)
	if strings.TrimSpace(credential) == "" || (textProvided && !textValid) || !blocksValid ||
		(strings.TrimSpace(text) == "" && (!blocksProvided || len(blocks) == 0)) {
		return envelopeError("slack.post requires `text` or non-empty `blocks`.", latency())
	}
	rateLimit := 60
	if deps.RateLimitPerMin != nil {
		rateLimit = deps.RateLimitPerMin("slack", 60)
	}
	hookURL, gateError := deps.Gate(ctx, "slack.post", "slack_webhook", credential, rateLimit)
	if gateError != "" {
		record(credential, false, 0, gateError)
		return envelopeError(gateError, latency())
	}
	if !isSlackHookURL(hookURL) {
		message := "slack webhook URL must point at hooks.slack.com or the enabled local simulator"
		record(credential, false, 0, message)
		return envelopeError(message, latency())
	}
	payload := map[string]any{}
	if strings.TrimSpace(text) != "" {
		payload["text"] = text
	}
	if blocksProvided {
		payload["blocks"] = blocks
	}
	serialized, err := json.Marshal(payload)
	if err != nil {
		record(credential, false, 0, "payload serialization failed")
		return envelopeError("payload serialization failed", latency())
	}
	statusCode, responseBody, postError := deps.Post(ctx, hookURL,
		map[string]string{"content-type": "application/json"}, serialized)
	if postError != "" {
		// Slack webhook tokens live in the URL path. The guarded transport's
		// diagnostic can contain that URL, so never surface it downstream.
		message := "network error calling slack webhook"
		record(credential, false, 0, message)
		return envelopeError(message, latency())
	}
	if statusCode < 200 || statusCode >= 300 {
		message := fmt.Sprintf("slack responded %d: %s", statusCode, truncateBody(responseBody))
		record(credential, false, statusCode, message)
		return map[string]any{"ok": false, "statusCode": statusCode, "error": message, "latencyMs": latency()}
	}
	record(credential, true, statusCode, "")
	return map[string]any{"ok": true, "statusCode": statusCode, "latencyMs": latency()}
}

func githubAPIBase() string {
	if localIntegrationSimulatorEnabled() {
		if base := strings.TrimSpace(os.Getenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL")); base != "" {
			return strings.TrimRight(base, "/") + "/github"
		}
	}
	return "https://api.github.com"
}

// localIntegrationSimulatorEnabled is intentionally a double opt-in. The
// generic integration flag alone is not enough to redirect any outbound
// provider traffic; the whole process must also declare itself a local stack.
// Keep this aligned with aiconfig.simulatorBaseURL.
func localIntegrationSimulatorEnabled() bool {
	return os.Getenv("JANUSLY_LOCAL_STACK") == "true" &&
		os.Getenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR") == "true"
}

func stringSliceInput(input map[string]any, key string, max int) ([]string, bool) {
	raw, present := input[key]
	if !present {
		return nil, true
	}
	var values []any
	switch typed := raw.(type) {
	case []any:
		values = typed
	case []string:
		values = make([]any, len(typed))
		for i, value := range typed {
			values[i] = value
		}
	default:
		return nil, false
	}
	if len(values) > max {
		return nil, false
	}
	result := make([]string, 0, len(values))
	for _, rawValue := range values {
		value, ok := rawValue.(string)
		if !ok || strings.TrimSpace(value) == "" {
			return nil, false
		}
		result = append(result, value)
	}
	return result, true
}

func executeGitHubCreateIssue(
	ctx context.Context,
	input map[string]any,
	deps *IntegrationDeps,
	latency func() int,
	record func(string, bool, int, string),
) map[string]any {
	credential, _ := input["credential"].(string)
	owner, _ := input["owner"].(string)
	repo, _ := input["repo"].(string)
	title, _ := input["title"].(string)
	bodyRaw, bodyProvided := input["body"]
	body, bodyValid := bodyRaw.(string)
	labels, labelsValid := stringSliceInput(input, "labels", 50)
	assignees, assigneesValid := stringSliceInput(input, "assignees", 10)
	if strings.TrimSpace(credential) == "" || strings.TrimSpace(owner) == "" ||
		strings.TrimSpace(repo) == "" || strings.TrimSpace(title) == "" ||
		(bodyProvided && !bodyValid) || !labelsValid || !assigneesValid {
		return envelopeError("github.create_issue requires valid credential, owner, repo, title, body, labels, and assignees", latency())
	}
	rateLimit := 60
	if deps.RateLimitPerMin != nil {
		rateLimit = deps.RateLimitPerMin("github", 60)
	}
	secret, gateError := deps.Gate(ctx, "github.create_issue", "github_token", credential, rateLimit)
	if gateError != "" {
		record(credential, false, 0, gateError)
		return envelopeError(gateError, latency())
	}
	payload := map[string]any{"title": title}
	if bodyProvided && body != "" {
		payload["body"] = body
	}
	if _, present := input["labels"]; present {
		payload["labels"] = labels
	}
	if _, present := input["assignees"]; present {
		payload["assignees"] = assignees
	}
	serialized, err := json.Marshal(payload)
	if err != nil {
		record(credential, false, 0, "payload serialization failed")
		return envelopeError("payload serialization failed", latency())
	}
	target := githubAPIBase() + "/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(repo) + "/issues"
	statusCode, responseBody, postError := deps.Post(ctx, target, map[string]string{
		"content-type":         "application/json",
		"accept":               "application/vnd.github+json",
		"authorization":        "Bearer " + secret,
		"user-agent":           "janusly-mcp-integration",
		"x-github-api-version": "2022-11-28",
	}, serialized)
	if postError != "" {
		record(credential, false, statusCode, postError)
		return envelopeError(postError, latency())
	}
	var parsed map[string]any
	_ = json.Unmarshal([]byte(responseBody), &parsed)
	if statusCode == 201 {
		result := map[string]any{"ok": true, "statusCode": statusCode, "latencyMs": latency()}
		if issueNumber, ok := parsed["number"].(float64); ok {
			result["issueNumber"] = issueNumber
		}
		if issueURL, ok := parsed["html_url"].(string); ok {
			result["url"] = issueURL
		}
		record(credential, true, statusCode, "")
		return result
	}
	message, _ := parsed["message"].(string)
	if message == "" {
		message = fmt.Sprintf("github responded %d", statusCode)
	}
	record(credential, false, statusCode, message)
	return map[string]any{"ok": false, "statusCode": statusCode, "error": message, "latencyMs": latency()}
}

func truncateBody(body string) string {
	if len(body) > 200 {
		return body[:200] + "…"
	}
	return body
}
