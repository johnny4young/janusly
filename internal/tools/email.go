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

// emailMessage is a validated email.send input: bounded subject and bodies,
// at most 20 short metadata entries, and the resolved sender.
type emailMessage struct {
	to, from, subject, text, html string
	metadata                      map[string]string
}

// parseEmailMessage validates the tool input; a non-empty second value is
// the noop-envelope error message.
func parseEmailMessage(input map[string]any) (emailMessage, string) {
	msg := emailMessage{metadata: map[string]string{}}
	msg.to, _ = input["to"].(string)
	msg.subject, _ = input["subject"].(string)
	msg.text, _ = input["text"].(string)
	msg.html, _ = input["html"].(string)
	msg.from, _ = input["from"].(string)
	if msg.to == "" || msg.subject == "" || len(msg.subject) > emailSubjectMax {
		return msg, "email.send requires to and subject (subject ≤998 chars)"
	}
	if msg.text == "" && msg.html == "" {
		return msg, "email.send requires `text` or `html` (or both)."
	}
	if len(msg.text) > emailTextMax || len(msg.html) > emailHTMLMax {
		return msg, "email.send body exceeds the size cap"
	}
	if rawMetadata, ok := input["metadata"].(map[string]any); ok {
		if len(rawMetadata) > emailMetadataMax {
			return msg, "email.send metadata supports at most 20 entries"
		}
		for key, value := range rawMetadata {
			text, ok := value.(string)
			if !ok || key == "" || len(key) > 64 || len(text) > 256 {
				return msg, "email.send metadata entries must be short strings"
			}
			msg.metadata[key] = text
		}
	}
	return msg, ""
}

// emailRequest is one provider's wire shape for a message plus how it
// reports the message id (nil: the provider answers no id and one is
// synthesized).
type emailRequest struct {
	label     string
	url       string
	headers   map[string]string
	payload   map[string]any
	messageID func(body string) string
}

func jsonMessageID(body string) string {
	var parsed struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal([]byte(body), &parsed)
	return parsed.ID
}

func bearerJSONHeaders(envKey string) map[string]string {
	return map[string]string{
		"Authorization": "Bearer " + os.Getenv(envKey),
		"Content-Type":  "application/json",
	}
}

// emailProviderRequests builds the provider request for a validated message.
var emailProviderRequests = map[string]func(msg emailMessage) emailRequest{
	"resend": func(msg emailMessage) emailRequest {
		payload := map[string]any{"from": msg.from, "to": []string{msg.to}, "subject": msg.subject}
		if msg.text != "" {
			payload["text"] = msg.text
		}
		if msg.html != "" {
			payload["html"] = msg.html
		}
		if len(msg.metadata) > 0 {
			tags := make([]map[string]string, 0, len(msg.metadata))
			for name, value := range msg.metadata {
				tags = append(tags, map[string]string{"name": name, "value": value})
			}
			payload["tags"] = tags
		}
		return emailRequest{label: "Resend", url: "https://api.resend.com/emails",
			headers: bearerJSONHeaders("RESEND_API_KEY"), payload: payload, messageID: jsonMessageID}
	},
	"sendgrid": func(msg emailMessage) emailRequest {
		content := []map[string]string{}
		if msg.text != "" {
			content = append(content, map[string]string{"type": "text/plain", "value": msg.text})
		}
		if msg.html != "" {
			content = append(content, map[string]string{"type": "text/html", "value": msg.html})
		}
		payload := map[string]any{
			"personalizations": []map[string]any{{"to": []map[string]string{{"email": msg.to}}}},
			"from":             map[string]string{"email": msg.from},
			"subject":          msg.subject,
			"content":          content,
		}
		if len(msg.metadata) > 0 {
			payload["custom_args"] = msg.metadata
		}
		// SendGrid answers 202 + empty body; the id rides a response
		// header FetchHTTPTarget doesn't expose — synthesize best-effort.
		return emailRequest{label: "SendGrid", url: "https://api.sendgrid.com/v3/mail/send",
			headers: bearerJSONHeaders("SENDGRID_API_KEY"), payload: payload}
	},
	"simulator": func(msg emailMessage) emailRequest {
		payload := map[string]any{"to": msg.to, "from": msg.from, "subject": msg.subject}
		if msg.text != "" {
			payload["text"] = msg.text
		}
		if msg.html != "" {
			payload["html"] = msg.html
		}
		return emailRequest{label: "Simulator", url: simulatorEndpoint("/email/send"),
			headers: map[string]string{"content-type": "application/json"}, payload: payload, messageID: jsonMessageID}
	},
}

// executeEmailSend runs the email.send tool through the chokepoint deps.
// NEVER throws — every failure mode answers {ok:false, provider, error}.
func executeEmailSend(ctx context.Context, input map[string]any, deps *IntegrationDeps) map[string]any {
	start := time.Now()
	msg, errMessage := parseEmailMessage(input)
	if errMessage != "" {
		return emailEnvelope(false, "noop", "", errMessage)
	}

	settings := EmailSettings{}
	if deps != nil && deps.Email != nil {
		settings = deps.Email()
	}
	if msg.from == "" {
		msg.from = settings.From
	}
	if msg.from == "" {
		msg.from = os.Getenv("JANUSLY_MAILER_FROM")
	}
	if msg.from == "" {
		msg.from = "onboarding@resend.dev"
	}
	if !validEmailMailbox(msg.from) {
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
	buildRequest := emailProviderRequests[provider]
	if buildRequest == nil {
		message := "Mailer not configured. Set JANUSLY_MAILER_PROVIDER=resend|sendgrid and the matching API key."
		record("noop", false, message)
		return emailEnvelope(false, "noop", "", message)
	}
	request := buildRequest(msg)
	serialized, err := json.Marshal(request.payload)
	if err != nil {
		record(provider, false, "payload serialization failed")
		return emailEnvelope(false, provider, "", "payload serialization failed")
	}
	statusCode, body, errMessage := deps.Post(ctx, request.url, request.headers, serialized)
	if errMessage != "" {
		record(provider, false, errMessage)
		return emailEnvelope(false, provider, "", errMessage)
	}
	if statusCode < 200 || statusCode >= 300 {
		message := fmt.Sprintf("%s returned HTTP %d: %s", request.label, statusCode, truncateBody(body))
		record(provider, false, message)
		return emailEnvelope(false, provider, "", message)
	}
	messageID := fmt.Sprintf("%s-%d", provider, time.Now().UnixMilli())
	if request.messageID != nil {
		if messageID = request.messageID(body); messageID == "" {
			message := request.label + " response missing message id"
			record(provider, false, message)
			return emailEnvelope(false, provider, "", message)
		}
	}
	record(provider, true, "")
	return emailEnvelope(true, provider, messageID, "")
}
