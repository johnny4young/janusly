// Deterministic fallback templates for /ai/generate-workflow, verbatim
// from the reference's template library — the $0 answer when no provider
// is configured or a generation attempt degraded. The keyword matcher is
// the reference's exact ladder (email first: a "respond to incidents by
// email" prompt lands on the email skeleton, not the incident one).
package httpapi

import (
	"encoding/json"
	"strings"
)

var fallbackTemplateJSON = map[string]string{
	"http-ai-summary": `{
		"dslVersion": "1.0", "id": "http-ai-summary", "name": "HTTP → AI Summary",
		"nodes": [
			{"id": "api", "type": "http", "config": {"url": "https://api.github.com"}},
			{"id": "summary", "type": "ai", "config": {"prompt": "Summarize the API response for an operator and suggest the next action: {{context.api.output.body}}"}}
		],
		"edges": [{"from": "api", "to": "summary"}]
	}`,
	"api-transform-tool": `{
		"dslVersion": "1.0", "id": "api-transform-tool", "name": "API → Transform → Tool",
		"nodes": [
			{"id": "api", "type": "http", "config": {"url": "https://api.github.com"}},
			{"id": "transform", "type": "transform", "config": {"mapping": {"statusCode": "{{context.api.output.statusCode}}", "ok": "{{context.api.output.ok}}"}}},
			{"id": "tool", "type": "tool", "config": {"tool": "text.uppercase", "input": {"value": "status {{context.transform.output.statusCode}}"}}}
		],
		"edges": [{"from": "api", "to": "transform"}, {"from": "transform", "to": "tool"}]
	}`,
	"approval-gate": `{
		"dslVersion": "1.0", "id": "approval-gate", "name": "Human Approval Gate",
		"nodes": [
			{"id": "start", "type": "noop", "config": {}},
			{"id": "approval", "type": "approval", "config": {"message": "Approve to continue."}},
			{"id": "done", "type": "noop", "config": {}}
		],
		"edges": [{"from": "start", "to": "approval"}, {"from": "approval", "to": "done"}]
	}`,
	"incident-triage": `{
		"dslVersion": "1.0", "id": "incident-triage", "name": "Incident triage → GitHub + Slack",
		"nodes": [
			{"id": "trigger", "type": "webhook", "config": {}},
			{"id": "summarize", "type": "ai", "config": {"prompt": "You are an SRE assistant. Given this incident payload, write a 2-3 sentence summary suitable for a GitHub issue body. Payload: {{context.trigger.output}}"}},
			{"id": "github_issue", "type": "tool", "config": {"tool": "github.create_issue", "input": {"credential": "bot-github", "owner": "janusly", "repo": "incidents", "title": "Incident: {{context.trigger.output.alertName}}", "body": "{{context.summarize.output.response}}", "labels": ["incident", "auto-triaged"]}}},
			{"id": "slack_notify", "type": "tool", "config": {"tool": "slack.post", "input": {"credential": "incidents-slack", "text": "New incident: {{context.trigger.output.alertName}} — tracked at {{context.github_issue.output.result.url}}"}}}
		],
		"edges": [{"from": "trigger", "to": "summarize"}, {"from": "summarize", "to": "github_issue"}, {"from": "github_issue", "to": "slack_notify"}]
	}`,
	"email-reply": `{
		"dslVersion": "1.0", "id": "email-reply", "name": "Email auto-reply",
		"nodes": [
			{"id": "fetch_inbound", "type": "noop", "config": {}},
			{"id": "match_sender", "type": "condition", "config": {"expression": "true"}},
			{"id": "reply", "type": "tool", "config": {"tool": "email.send", "input": {"to": "{{context.match_sender.output.sender}}", "subject": "Auto-reply", "text": "Thanks for your message — I'll get back to you shortly."}}}
		],
		"edges": [{"from": "fetch_inbound", "to": "match_sender"}, {"from": "match_sender", "to": "reply"}]
	}`,
}

// fallbackTemplates holds the decoded documents, keyed by template id.
var fallbackTemplates = func() map[string]map[string]any {
	decoded := make(map[string]map[string]any, len(fallbackTemplateJSON))
	for id, raw := range fallbackTemplateJSON {
		var doc map[string]any
		if err := json.Unmarshal([]byte(raw), &doc); err != nil {
			panic("fallback template " + id + ": " + err.Error())
		}
		decoded[id] = doc
	}
	return decoded
}()

// fallbackTemplateForPrompt is the reference's keyword ladder, verbatim
// order: email → incident → approval → transform → http-ai-summary.
func fallbackTemplateForPrompt(prompt string) map[string]any {
	text := strings.ToLower(prompt)
	templateID := "http-ai-summary"
	switch {
	case containsAny(text, "email", "correo", "gmail", "mail"):
		templateID = "email-reply"
	case containsAny(text, "incident", "on-call", "slack", "github"):
		templateID = "incident-triage"
	case containsAny(text, "approval", "approve", "aprob", "human", "risk"):
		templateID = "approval-gate"
	case containsAny(text, "transform", "map", "tool", "herramient", "backend"):
		templateID = "api-transform-tool"
	}
	return fallbackTemplates[templateID]
}

func containsAny(text string, needles ...string) bool {
	for _, needle := range needles {
		if strings.Contains(text, needle) {
			return true
		}
	}
	return false
}
