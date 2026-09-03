// email.send — the transactional mailer tool implements the contract's
// tools/email.ts + mailer.ts. Four providers resolved AT CALL TIME:
// resend / sendgrid (real, both egressing through the guarded Post seam
// — no vendor SDK), simulator (explicit local-stack gate, never
// implicit), and noop (the safe default: {ok:false, "Mailer not
// configured"} — the write-side AI-fallback contract holds without a
// throw). Per-org rate gate (family "email", default 100/min) and
// best-effort usage telemetry ride the shared integration deps.
package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"net/mail"
	"os"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// EmailSettings are the tenant-resolved posture knobs (org config
// email.provider / email.from with env fallbacks — resolved by the
// engine deps builder).
type EmailSettings struct {
	Provider string
	From     string
}

const (
	emailSubjectMax  = 998
	emailTextMax     = 200_000
	emailHTMLMax     = 500_000
	emailMetadataMax = 20
	emailAddressMax  = 320
)

var emailMetadataKey = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func validEmailMailbox(value string) bool {
	if value == "" || value != strings.TrimSpace(value) || len(value) > emailAddressMax || crlfPattern.MatchString(value) {
		return false
	}
	address, err := mail.ParseAddress(value)
	return err == nil && address.Name == "" && address.Address == value
}

func validateEmailInput(input map[string]any, options InputValidationOptions) error {
	for _, field := range []string{"to", "from"} {
		raw, present := input[field]
		if !present || isDeferredWholeTemplate(raw, options) {
			continue
		}
		if !validEmailMailbox(raw.(string)) {
			return fmt.Errorf("%s must be one valid email address of at most %d bytes", field, emailAddressMax)
		}
	}
	if raw, present := input["subject"]; present && !isDeferredWholeTemplate(raw, options) {
		subject := raw.(string)
		if strings.TrimSpace(subject) == "" || len(subject) > emailSubjectMax || crlfPattern.MatchString(subject) {
			return fmt.Errorf("subject must be non-empty, single-line, and at most %d bytes", emailSubjectMax)
		}
	}

	textRaw, textPresent := input["text"]
	htmlRaw, htmlPresent := input["html"]
	textPotential := textPresent && isDeferredWholeTemplate(textRaw, options)
	htmlPotential := htmlPresent && isDeferredWholeTemplate(htmlRaw, options)
	if textPresent && !textPotential {
		text := textRaw.(string)
		if len(text) > emailTextMax {
			return fmt.Errorf("text exceeds %d bytes", emailTextMax)
		}
		textPotential = strings.TrimSpace(text) != ""
	}
	if htmlPresent && !htmlPotential {
		html := htmlRaw.(string)
		if len(html) > emailHTMLMax {
			return fmt.Errorf("html exceeds %d bytes", emailHTMLMax)
		}
		htmlPotential = strings.TrimSpace(html) != ""
	}
	if !textPotential && !htmlPotential && (options.RequireAll || textPresent || htmlPresent) {
		return fmt.Errorf("text or html is required")
	}

	if raw, present := input["metadata"]; present && !isDeferredWholeTemplate(raw, options) {
		metadata := raw.(map[string]any)
		if len(metadata) > emailMetadataMax {
			return fmt.Errorf("metadata supports at most %d entries", emailMetadataMax)
		}
		for key, rawValue := range metadata {
			value, ok := rawValue.(string)
			if !ok || !emailMetadataKey.MatchString(key) || value == "" || value != strings.TrimSpace(value) ||
				utf8.RuneCountInString(value) > 256 || crlfPattern.MatchString(value) {
				return fmt.Errorf("metadata must use safe 1..64 byte keys and trimmed single-line string values of at most 256 characters")
			}
		}
	}
	return nil
}

func emailTools() []Definition {
	unavailable := func(_ context.Context, _ map[string]any) (map[string]any, error) {
		return map[string]any{"ok": false, "provider": "noop", "error": "integration tools require run context"}, nil
	}
	return []Definition{{
		Name:        "email.send",
		Description: "Send a transactional email via the configured mailer (Resend or SendGrid).",
		Required:    []string{"to", "subject"},
		Optional:    []string{"from", "text", "html", "metadata"},
		Fields: []Field{
			{Name: "to", Type: "string", Required: true},
			{Name: "subject", Type: "string", Required: true},
			{Name: "from", Type: "string"},
			{Name: "text", Type: "string"},
			{Name: "html", Type: "string"},
			{Name: "metadata", Type: "object"},
		},
		InputExample: map[string]any{"to": "user@example.com", "subject": "Hello", "text": "Body of the email."},
		Validate:     validateEmailInput,
		WriteSide:    true,
		Execute:      unavailable,
	}}
}

// simulatorEndpoint mirrors the contract's explicit local-stack gate.
func simulatorEndpoint(path string) string {
	if !localIntegrationSimulatorEnabled() {
		return ""
	}
	base := strings.TrimSuffix(os.Getenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL"), "/")
	if base == "" {
		return ""
	}
	return base + path
}

// resolveMailerProvider ports getMailer's resolution ladder.
func resolveMailerProvider(override string) string {
	requested := strings.ToLower(override)
	if requested == "" {
		requested = strings.ToLower(os.Getenv("JANUSLY_MAILER_PROVIDER"))
	}
	switch {
	case requested == "noop":
		return "noop"
	case requested == "resend" && os.Getenv("RESEND_API_KEY") != "":
		return "resend"
	case requested == "sendgrid" && os.Getenv("SENDGRID_API_KEY") != "":
		return "sendgrid"
	case requested == "simulator" && simulatorEndpoint("/email/send") != "":
		return "simulator"
	default:
		return "noop"
	}
}

func emailEnvelope(ok bool, provider, messageID, errMessage string) map[string]any {
	envelope := map[string]any{"ok": ok, "provider": provider}
	if messageID != "" {
		envelope["providerMessageId"] = messageID
	}
	if errMessage != "" {
		envelope["error"] = errMessage
	}
	return envelope
}

// executeEmailSend runs the email.send tool through the chokepoint deps.
// NEVER throws — every failure mode answers {ok:false, provider, error}.
func executeEmailSend(ctx context.Context, input map[string]any, deps *IntegrationDeps) map[string]any {
	start := time.Now()
	to, _ := input["to"].(string)
	subject, _ := input["subject"].(string)
	text, _ := input["text"].(string)
	html, _ := input["html"].(string)
	if to == "" || subject == "" || len(subject) > emailSubjectMax {
		return emailEnvelope(false, "noop", "", "email.send requires to and subject (subject ≤998 chars)")
	}
	if text == "" && html == "" {
		return emailEnvelope(false, "noop", "", "email.send requires `text` or `html` (or both).")
	}
	if len(text) > emailTextMax || len(html) > emailHTMLMax {
		return emailEnvelope(false, "noop", "", "email.send body exceeds the size cap")
	}
	metadata := map[string]string{}
	if rawMetadata, ok := input["metadata"].(map[string]any); ok {
		if len(rawMetadata) > emailMetadataMax {
			return emailEnvelope(false, "noop", "", "email.send metadata supports at most 20 entries")
		}
		for key, value := range rawMetadata {
			text, ok := value.(string)
			if !ok || key == "" || len(key) > 64 || len(text) > 256 {
				return emailEnvelope(false, "noop", "", "email.send metadata entries must be short strings")
			}
			metadata[key] = text
		}
	}

	settings := EmailSettings{}
	if deps != nil && deps.Email != nil {
		settings = deps.Email()
	}
	from, _ := input["from"].(string)
	if from == "" {
		from = settings.From
	}
	if from == "" {
		from = os.Getenv("JANUSLY_MAILER_FROM")
	}
	if from == "" {
		from = "onboarding@resend.dev"
	}
	if !validEmailMailbox(from) {
		return emailEnvelope(false, "noop", "", "configured mailer from address is invalid")
	}
	latency := func() int { return int(time.Since(start).Milliseconds()) }
	record := func(provider string, ok bool, errMessage string) {
		if deps != nil && deps.Record != nil {
			deps.Record("email.send", provider, ok, 0, errMessage, latency())
		}
	}

	// Per-org rate gate: over-limit converts to a clean envelope.
	if deps != nil && deps.RateLimit != nil {
		rateLimit := 100
		if deps.RateLimitPerMin != nil {
			rateLimit = deps.RateLimitPerMin("email", 100)
		}
		if errMessage := deps.RateLimit(ctx, "email.send", rateLimit); errMessage != "" {
			record("noop", false, errMessage)
			return emailEnvelope(false, "noop", "", errMessage)
		}
	}

	provider := resolveMailerProvider(settings.Provider)
	if deps == nil || deps.Post == nil {
		return emailEnvelope(false, "noop", "", "integration tools require run context")
	}
	post := func(url string, headers map[string]string, body any) (int, string, string) {
		serialized, err := json.Marshal(body)
		if err != nil {
			return 0, "", "payload serialization failed"
		}
		return deps.Post(ctx, url, headers, serialized)
	}

	switch provider {
	case "resend":
		payload := map[string]any{"from": from, "to": []string{to}, "subject": subject}
		if text != "" {
			payload["text"] = text
		}
		if html != "" {
			payload["html"] = html
		}
		if len(metadata) > 0 {
			tags := make([]map[string]string, 0, len(metadata))
			for name, value := range metadata {
				tags = append(tags, map[string]string{"name": name, "value": value})
			}
			payload["tags"] = tags
		}
		statusCode, body, errMessage := post("https://api.resend.com/emails", map[string]string{
			"Authorization": "Bearer " + os.Getenv("RESEND_API_KEY"),
			"Content-Type":  "application/json",
		}, payload)
		if errMessage != "" {
			record("resend", false, errMessage)
			return emailEnvelope(false, "resend", "", errMessage)
		}
		if statusCode < 200 || statusCode >= 300 {
			message := fmt.Sprintf("Resend returned HTTP %d: %s", statusCode, truncateBody(body))
			record("resend", false, message)
			return emailEnvelope(false, "resend", "", message)
		}
		var parsed struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal([]byte(body), &parsed)
		if parsed.ID == "" {
			record("resend", false, "Resend response missing message id")
			return emailEnvelope(false, "resend", "", "Resend response missing message id")
		}
		record("resend", true, "")
		return emailEnvelope(true, "resend", parsed.ID, "")
	case "sendgrid":
		content := []map[string]string{}
		if text != "" {
			content = append(content, map[string]string{"type": "text/plain", "value": text})
		}
		if html != "" {
			content = append(content, map[string]string{"type": "text/html", "value": html})
		}
		payload := map[string]any{
			"personalizations": []map[string]any{{"to": []map[string]string{{"email": to}}}},
			"from":             map[string]string{"email": from},
			"subject":          subject,
			"content":          content,
		}
		if len(metadata) > 0 {
			payload["custom_args"] = metadata
		}
		statusCode, body, errMessage := post("https://api.sendgrid.com/v3/mail/send", map[string]string{
			"Authorization": "Bearer " + os.Getenv("SENDGRID_API_KEY"),
			"Content-Type":  "application/json",
		}, payload)
		if errMessage != "" {
			record("sendgrid", false, errMessage)
			return emailEnvelope(false, "sendgrid", "", errMessage)
		}
		if statusCode < 200 || statusCode >= 300 {
			message := fmt.Sprintf("SendGrid returned HTTP %d: %s", statusCode, truncateBody(body))
			record("sendgrid", false, message)
			return emailEnvelope(false, "sendgrid", "", message)
		}
		// SendGrid answers 202 + empty body; the id rides a response
		// header FetchHTTPTarget doesn't expose — synthesize best-effort.
		record("sendgrid", true, "")
		return emailEnvelope(true, "sendgrid", fmt.Sprintf("sendgrid-%d", time.Now().UnixMilli()), "")
	case "simulator":
		endpoint := simulatorEndpoint("/email/send")
		payload := map[string]any{"to": to, "from": from, "subject": subject}
		if text != "" {
			payload["text"] = text
		}
		if html != "" {
			payload["html"] = html
		}
		statusCode, body, errMessage := post(endpoint, map[string]string{"content-type": "application/json"}, payload)
		if errMessage != "" {
			record("simulator", false, errMessage)
			return emailEnvelope(false, "simulator", "", errMessage)
		}
		if statusCode < 200 || statusCode >= 300 {
			message := fmt.Sprintf("Simulator returned HTTP %d: %s", statusCode, truncateBody(body))
			record("simulator", false, message)
			return emailEnvelope(false, "simulator", "", message)
		}
		var parsed struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal([]byte(body), &parsed)
		if parsed.ID == "" {
			record("simulator", false, "Simulator response missing message id")
			return emailEnvelope(false, "simulator", "", "Simulator response missing message id")
		}
		record("simulator", true, "")
		return emailEnvelope(true, "simulator", parsed.ID, "")
	default:
		message := "Mailer not configured. Set JANUSLY_MAILER_PROVIDER=resend|sendgrid and the matching API key."
		record("noop", false, message)
		return emailEnvelope(false, "noop", "", message)
	}
}
