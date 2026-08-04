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
	"os"
	"strings"
	"time"
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
)

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
		WriteSide:    true,
		Execute:      unavailable,
	}}
}

// simulatorEndpoint mirrors the contract's explicit local-stack gate.
func simulatorEndpoint(path string) string {
	if os.Getenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR") != "true" {
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
