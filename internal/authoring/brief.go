package authoring

import (
	"fmt"
	"regexp"
	"strings"
)

const (
	MaxBriefPromptChars = 4000
	maxBriefFieldChars  = 1200
	maxBriefListEntries = 12
)

// IntentBrief is the stable contract between conversational intake and the
// proposal engine. Empty optional fields remain visible rather than being
// hallucinated into existence.
type IntentBrief struct {
	Version         string   `json:"version"`
	Objective       string   `json:"objective"`
	Trigger         string   `json:"trigger"`
	Inputs          []string `json:"inputs"`
	ExpectedOutcome string   `json:"expectedOutcome"`
	ExternalEffects []string `json:"externalEffects"`
	Approvals       []string `json:"approvals"`
	FailurePolicy   string   `json:"failurePolicy"`
	Examples        []string `json:"examples"`
	Language        string   `json:"language"`
}

type CompileBriefRequest struct {
	Prompt string      `json:"prompt"`
	Brief  IntentBrief `json:"brief"`
}

type BriefCompilation struct {
	Brief               IntentBrief `json:"brief"`
	ClarifyingQuestions []string    `json:"clarifyingQuestions"`
	Complete            bool        `json:"complete"`
	Mode                string      `json:"mode"`
}

var spanishWordPattern = regexp.MustCompile(`(?i)(\bpara\b|\bcuando\b|\bflujo\b|\bcrear\b|\benviar\b|\baprobar\b|\bespera\b|\bantes\b|\bresultado\b|[áéíóúñ¿¡])`)

// CompileBrief deterministically merges structured fields with a natural
// language prompt. It asks at most three bounded questions and never calls a
// provider, so authoring remains available at $0.
func CompileBrief(request CompileBriefRequest) (BriefCompilation, error) {
	prompt := strings.TrimSpace(request.Prompt)
	if len([]rune(prompt)) > MaxBriefPromptChars {
		return BriefCompilation{}, fmt.Errorf("prompt exceeds %d characters", MaxBriefPromptChars)
	}
	brief := normalizeBrief(request.Brief)
	if brief.Version == "" {
		brief.Version = "1"
	}
	if brief.Language == "" {
		if spanishWordPattern.MatchString(prompt) {
			brief.Language = "es"
		} else {
			brief.Language = "en"
		}
	}
	if brief.Objective == "" {
		brief.Objective = truncateRunes(prompt, maxBriefFieldChars)
	}
	if brief.Trigger == "" {
		brief.Trigger = inferTrigger(prompt)
	}
	if brief.ExpectedOutcome == "" && prompt != "" {
		brief.ExpectedOutcome = truncateRunes(prompt, maxBriefFieldChars)
	}
	if len(brief.ExternalEffects) == 0 {
		brief.ExternalEffects = inferEffects(prompt)
	}
	if len(brief.Approvals) == 0 && containsAnyFold(prompt, "approve", "approval", "aprob", "human review", "revisión humana") {
		brief.Approvals = []string{"human_approval_before_external_effect"}
	}
	if brief.FailurePolicy == "" {
		brief.FailurePolicy = "stop_and_open_recovery_case"
	}
	// Inference helpers may legitimately find no values and return a nil
	// slice. Re-normalize after inference so the JSON contract always emits
	// arrays rather than null; the browser treats these fields as iterable
	// collections throughout the four-stage authoring experience.
	brief = normalizeBrief(brief)

	questions := make([]string, 0, 3)
	spanish := brief.Language == "es"
	if brief.Objective == "" {
		questions = append(questions, choose(spanish, "¿Qué resultado de negocio debe conseguir el flujo?", "What business outcome should the workflow achieve?"))
	}
	if brief.Trigger == "manual" && !containsAnyFold(prompt, "manual", "manualmente") && len([]rune(prompt)) < 40 {
		questions = append(questions, choose(spanish, "¿Qué evento debe iniciar el flujo?", "What event should start the workflow?"))
	}
	if len(brief.ExternalEffects) == 0 && len([]rune(prompt)) < 80 {
		questions = append(questions, choose(spanish, "¿El flujo modifica algún sistema externo o sólo prepara información?", "Does the workflow modify an external system or only prepare information?"))
	}
	if len(questions) > 3 {
		questions = questions[:3]
	}
	return BriefCompilation{
		Brief: brief, ClarifyingQuestions: questions,
		Complete: brief.Objective != "" && brief.Trigger != "" && brief.ExpectedOutcome != "",
		Mode:     "deterministic",
	}, nil
}

func normalizeBrief(brief IntentBrief) IntentBrief {
	brief.Version = strings.TrimSpace(brief.Version)
	brief.Objective = truncateRunes(strings.TrimSpace(brief.Objective), maxBriefFieldChars)
	brief.Trigger = truncateRunes(strings.TrimSpace(brief.Trigger), 200)
	brief.ExpectedOutcome = truncateRunes(strings.TrimSpace(brief.ExpectedOutcome), maxBriefFieldChars)
	brief.FailurePolicy = truncateRunes(strings.TrimSpace(brief.FailurePolicy), 500)
	brief.Language = strings.ToLower(strings.TrimSpace(brief.Language))
	if brief.Language != "en" && brief.Language != "es" {
		brief.Language = ""
	}
	brief.Inputs = normalizeList(brief.Inputs)
	brief.ExternalEffects = normalizeList(brief.ExternalEffects)
	brief.Approvals = normalizeList(brief.Approvals)
	brief.Examples = normalizeList(brief.Examples)
	return brief
}

func normalizeList(values []string) []string {
	out := make([]string, 0, min(len(values), maxBriefListEntries))
	seen := map[string]bool{}
	for _, value := range values {
		value = truncateRunes(strings.TrimSpace(value), maxBriefFieldChars)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
		if len(out) >= maxBriefListEntries {
			break
		}
	}
	return out
}

func inferTrigger(prompt string) string {
	switch {
	case containsAnyFold(prompt, "cron", "schedule", "scheduled", "cada día", "diario", "semanal", "every day", "every week"):
		return "schedule"
	case containsAnyFold(prompt,
		"when an email", "when email", "email arrives", "email is received", "on email received",
		"cuando llega un correo", "cuando llegue un correo", "al recibir un correo", "correo recibido"):
		return "email"
	case containsAnyFold(prompt,
		"when a file", "when the file", "file arrives", "file is uploaded", "file dropped",
		"cuando llega un archivo", "al recibir un archivo", "archivo cargado"):
		return "file"
	case containsAnyFold(prompt, "mcp event", "mcp resource", "evento mcp"):
		return "mcp_event"
	case containsAnyFold(prompt,
		"when a webhook", "webhook arrives", "webhook is received", "webhook event", "on webhook",
		"cuando llega un webhook", "al recibir un webhook", "evento webhook"):
		return "webhook"
	default:
		return "manual"
	}
}

func inferEffects(prompt string) []string {
	var effects []string
	if containsAnyFold(prompt, "slack") {
		effects = append(effects, "slack_message")
	}
	if containsAnyFold(prompt, "github issue", "issue in github", "incidencia en github") {
		effects = append(effects, "github_issue")
	}
	if containsAnyFold(prompt, "webhook") && inferTrigger(prompt) != "webhook" {
		effects = append(effects, "outbound_webhook")
	}
	if containsAnyFold(prompt,
		"send email", "send an email", "email delivery", "email reply", "reply by email",
		"enviar correo", "envía un correo", "enviar un correo", "responder correo") {
		effects = append(effects, "email_delivery")
	}
	if containsAnyFold(prompt,
		"write database", "write to database", "update database", "insert into database",
		"escribir base de datos", "actualizar base de datos", "insertar en base de datos") {
		effects = append(effects, "database_write")
	}
	return effects
}

func containsAnyFold(value string, candidates ...string) bool {
	value = strings.ToLower(value)
	for _, candidate := range candidates {
		if strings.Contains(value, strings.ToLower(candidate)) {
			return true
		}
	}
	return false
}

func truncateRunes(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max])
}

func choose(spanish bool, es, en string) string {
	if spanish {
		return es
	}
	return en
}

// ProposalPrompt turns a brief into bounded plain text for the existing
// generation ladder. Capability identifiers are supplied separately as a
// system DATA block; this text contains intent only.
func ProposalPrompt(brief IntentBrief) string {
	parts := []string{
		"Business objective: " + brief.Objective,
		"Trigger: " + brief.Trigger,
		"Expected outcome: " + brief.ExpectedOutcome,
		"Failure policy: " + brief.FailurePolicy,
	}
	if len(brief.Inputs) > 0 {
		parts = append(parts, "Inputs: "+strings.Join(brief.Inputs, "; "))
	}
	if len(brief.ExternalEffects) > 0 {
		parts = append(parts, "External effects: "+strings.Join(brief.ExternalEffects, "; "))
	}
	if len(brief.Approvals) > 0 {
		parts = append(parts, "Required approvals: "+strings.Join(brief.Approvals, "; "))
	}
	if len(brief.Examples) > 0 {
		parts = append(parts, "Examples: "+strings.Join(brief.Examples, "; "))
	}
	parts = append(parts, "Return a Janusly workflow proposal. Use only exact capabilities provided by the capability catalog; leave unresolved bindings incomplete instead of inventing identifiers.")
	return strings.Join(parts, "\n")
}
