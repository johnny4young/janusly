package authoring

import "encoding/json"

// Deterministic fallback templates are the $0 proposal path shared by HTTP
// and MCP. Every call returns a deep copy so request-specific assurance or
// binding work can never mutate the process-global catalog.
var deterministicTemplateJSON = map[string]string{
	"http-ai-summary":     `{"dslVersion":"1.0","id":"http-ai-summary","name":"HTTP → AI Summary","nodes":[{"id":"api","type":"http","config":{"url":"https://api.github.com"}},{"id":"summary","type":"ai","config":{"prompt":"Summarize the API response for an operator and suggest the next action: {{context.api.output.body}}"}}],"edges":[{"from":"api","to":"summary"}]}`,
	"api-transform-tool":  `{"dslVersion":"1.0","id":"api-transform-tool","name":"API → Transform → Tool","nodes":[{"id":"api","type":"http","config":{"url":"https://api.github.com"}},{"id":"transform","type":"transform","config":{"mapping":{"statusCode":"{{context.api.output.statusCode}}","ok":"{{context.api.output.ok}}"}}},{"id":"tool","type":"tool","config":{"tool":"text.uppercase","input":{"value":"status {{context.transform.output.statusCode}}"}}}],"edges":[{"from":"api","to":"transform"},{"from":"transform","to":"tool"}]}`,
	"approval-gate":       `{"dslVersion":"1.0","id":"approval-gate","name":"Human Approval Gate","nodes":[{"id":"start","type":"noop","config":{}},{"id":"approval","type":"approval","config":{"message":"Approve to continue."}},{"id":"done","type":"noop","config":{}}],"edges":[{"from":"start","to":"approval"},{"from":"approval","to":"done"}]}`,
	"incident-triage":     `{"dslVersion":"1.0","id":"incident-triage","name":"Incident triage → GitHub + Slack","nodes":[{"id":"trigger","type":"webhook","config":{}},{"id":"summarize","type":"ai","config":{"prompt":"You are an SRE assistant. Given this incident payload, write a 2-3 sentence summary suitable for a GitHub issue body. Payload: {{context.trigger.output}}"}},{"id":"github_issue","type":"tool","config":{"tool":"github.create_issue","input":{"credential":"bot-github","owner":"janusly","repo":"incidents","title":"Incident: {{context.trigger.output.alertName}}","body":"{{context.summarize.output.response}}","labels":["incident","auto-triaged"]}}},{"id":"slack_notify","type":"tool","config":{"tool":"slack.post","input":{"credential":"incidents-slack","text":"New incident: {{context.trigger.output.alertName}} — tracked at {{context.github_issue.output.result.url}}"}}}],"edges":[{"from":"trigger","to":"summarize"},{"from":"summarize","to":"github_issue"},{"from":"github_issue","to":"slack_notify"}]}`,
	"email-reply":         `{"dslVersion":"1.0","id":"email-reply","name":"Email auto-reply","nodes":[{"id":"fetch_inbound","type":"noop","config":{}},{"id":"match_sender","type":"condition","config":{"expression":"true"}},{"id":"reply","type":"tool","config":{"tool":"email.send","input":{"to":"{{context.match_sender.output.sender}}","subject":"Auto-reply","text":"Thanks for your message — I'll get back to you shortly."}}}],"edges":[{"from":"fetch_inbound","to":"match_sender"},{"from":"match_sender","to":"reply"}]}`,
	"scheduled-operation": `{"dslVersion":"1.0","id":"scheduled-operation","name":"Scheduled operation","nodes":[{"id":"schedule_daily","type":"schedule","config":{"cronExpression":"0 9 * * *","enabled":true}},{"id":"prepare_result","type":"noop","config":{}}],"edges":[{"from":"schedule_daily","to":"prepare_result"}]}`,
	"bounded-wait":        `{"dslVersion":"1.0","id":"bounded-wait","name":"Bounded wait","nodes":[{"id":"start","type":"noop","config":{}},{"id":"wait_five_minutes","type":"wait_until","config":{"duration":"PT5M"}},{"id":"continue","type":"noop","config":{}}],"edges":[{"from":"start","to":"wait_five_minutes"},{"from":"wait_five_minutes","to":"continue"}]}`,
	"multi-agent-review":  `{"dslVersion":"1.0","id":"multi-agent-review","name":"Multi-agent review","nodes":[{"id":"crew_review","type":"multi_agent","config":{"mode":"sequential","aggregation":"all","maxSteps":1,"agents":[{"name":"evidence_reviewer","goal":"Inspect the bounded workflow evidence and summarize the strongest signal."},{"name":"risk_reviewer","goal":"Review the prior result and identify one operational risk."}]}}],"edges":[]}`,
	"bounded-router":      `{"dslVersion":"1.0","id":"bounded-router","name":"Bounded AI router","nodes":[{"id":"route","type":"router_llm","config":{"strategy":"balanced","candidates":[{"nodeId":"fast_path"},{"nodeId":"safe_path"}]}},{"id":"fast_path","type":"noop","config":{}},{"id":"safe_path","type":"noop","config":{}}],"edges":[{"from":"route","to":"fast_path"},{"from":"route","to":"safe_path"}]}`,
}

var deterministicTemplates = func() map[string]map[string]any {
	decoded := make(map[string]map[string]any, len(deterministicTemplateJSON))
	for id, raw := range deterministicTemplateJSON {
		var document map[string]any
		if err := json.Unmarshal([]byte(raw), &document); err != nil {
			panic("deterministic authoring template " + id + ": " + err.Error())
		}
		decoded[id] = document
	}
	return decoded
}()

func DeterministicWorkflow(prompt string) map[string]any {
	templateID := "http-ai-summary"
	switch {
	case containsAnyFold(prompt, "router_llm", "smart router", "bounded router", "enrutador", "ruta rápida", "ruta segura"):
		templateID = "bounded-router"
	case containsAnyFold(prompt, "multi_agent", "multi-agent", "multi agent", "team of agents", "agent team", "equipo de agentes", "varios agentes"):
		templateID = "multi-agent-review"
	case containsAnyFold(prompt, "wait_until", "wait five minutes", "wait 5 minutes", "espera cinco minutos", "esperar 5 minutos", "pausa pt5m", "duration: pt5m"):
		templateID = "bounded-wait"
	case containsAnyFold(prompt, "cron", "schedule", "scheduled", "cada día", "diario", "semanal", "every day", "every week"):
		templateID = "scheduled-operation"
	case containsAnyFold(prompt, "email", "correo", "gmail", "mail"):
		templateID = "email-reply"
	case containsAnyFold(prompt, "incident", "incidente", "on-call", "slack", "github issue", "create issue", "crear issue"):
		templateID = "incident-triage"
	case containsAnyFold(prompt, "approval", "approve", "aprob", "human", "risk"):
		templateID = "approval-gate"
	case containsAnyFold(prompt, "transform", "map", "tool", "herramient", "backend"):
		templateID = "api-transform-tool"
	}
	raw, _ := json.Marshal(deterministicTemplates[templateID])
	copy := map[string]any{}
	_ = json.Unmarshal(raw, &copy)
	return copy
}
