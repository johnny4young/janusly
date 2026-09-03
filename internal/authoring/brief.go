package authoring

import (
	"fmt"
	"regexp"
	"strings"
	"time"
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
	structuredTriggerProvided := strings.TrimSpace(request.Brief.Trigger) != ""
	structuredEffectsProvided := request.Brief.ExternalEffects != nil
	promptDeclaresNoExternalEffects := explicitlyDeclaresNoExternalEffects(prompt)
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
	if len(brief.ExternalEffects) == 0 && !structuredEffectsProvided {
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
	requirementText := pagerDutyRequirementText(prompt, &brief)
	if brief.Objective == "" {
		questions = append(questions, choose(spanish, "¿Qué resultado de negocio debe conseguir el flujo?", "What business outcome should the workflow achieve?"))
	}
	if brief.Trigger == "manual" && !structuredTriggerProvided &&
		!containsAnyFold(prompt, "manual", "manualmente") && len([]rune(prompt)) < 40 {
		questions = append(questions, choose(spanish, "¿Qué evento debe iniciar el flujo?", "What event should start the workflow?"))
	}
	if len(brief.ExternalEffects) == 0 && !structuredEffectsProvided && !promptDeclaresNoExternalEffects && len([]rune(prompt)) < 80 {
		questions = append(questions, choose(spanish, "¿El flujo modifica algún sistema externo o sólo prepara información?", "Does the workflow modify an external system or only prepare information?"))
	}
	if brief.Trigger == "pagerduty" {
		if !validPagerDutyWorkingHours(requirementText) {
			questions = append(questions, choose(spanish,
				"¿Cuál es el rango horario exacto en el que Janusly puede actuar?",
				"What exact time range may Janusly act within?"))
		}
		dateRangePresent := pagerDutyDateRangePattern.MatchString(requirementText)
		relativeWeekAnchored := containsAnyFold(requirementText,
			"starting now", "from now", "beginning now", "desde ahora", "a partir de ahora")
		finiteCampaignValid := dateRangePresent && validPagerDutyDateRange(requirementText)
		finiteCampaignValid = finiteCampaignValid ||
			(!dateRangePresent && pagerDutyWeekPattern.MatchString(requirementText) && relativeWeekAnchored)
		if !finiteCampaignValid {
			questions = append(questions, choose(spanish,
				"¿Qué vigencia finita debe usar la disponibilidad? Indica ‘desde ahora durante una semana’ o fechas inclusivas válidas de máximo 31 días (AAAA-MM-DD a AAAA-MM-DD).",
				"What finite activation period should the availability use? Say ‘starting now for one week’ or provide valid inclusive dates covering at most 31 days (YYYY-MM-DD to YYYY-MM-DD)."))
		}
		if !validPagerDutyTimeZone(requirementText) {
			questions = append(questions, choose(spanish,
				"¿Qué zona horaria IANA debe usar la política?",
				"Which IANA timezone should the policy use?"))
		}
		if !validPagerDutyDuration(requirementText) {
			questions = append(questions, choose(spanish,
				"¿Cuántas horas debe durar el aplazamiento? Usa un valor entre 1 y 168.",
				"How many hours should the snooze last? Use a value from 1 to 168."))
		}
		if _, count := uniquePagerDutyMatch(requirementText, strings.ToLower, pagerDutyEmailPattern); count != 1 {
			questions = append(questions, choose(spanish,
				"¿Cuál es el único correo de solicitante autorizado que debe enviar Janusly a PagerDuty?",
				"Which single authorized requester email should Janusly send to PagerDuty?"))
		}
		if _, count := uniquePagerDutyMatch(requirementText, strings.ToUpper, pagerDutyUserPatterns...); count != 1 {
			questions = append(questions, choose(spanish,
				"¿Cuál es el único ID exacto del usuario de PagerDuty cuya asignación autoriza la acción?",
				"What is the single exact PagerDuty user ID whose assignment authorizes the action?"))
		}
		if !containsAll(brief.ExternalEffects, "pagerduty_acknowledge", "pagerduty_snooze") {
			questions = append(questions, choose(spanish,
				"¿Confirmas que Janusly puede reconocer el incidente y aplazarlo de forma acotada en PagerDuty? Declara ambos efectos externos.",
				"May Janusly acknowledge the incident and apply a bounded snooze in PagerDuty? Declare both external effects."))
		}
	}
	if len(questions) > 3 {
		questions = questions[:3]
	}
	complete := brief.Objective != "" && brief.Trigger != "" && brief.ExpectedOutcome != "" && len(questions) == 0
	return BriefCompilation{
		Brief: brief, ClarifyingQuestions: questions,
		Complete: complete,
		Mode:     "deterministic",
	}, nil
}

// explicitlyDeclaresNoExternalEffects distinguishes an intentional read-only
// contract from a prompt that simply omitted its side effects. This keeps the
// deterministic compiler conversational without silently treating ambiguous
// short prompts as safe. Known effect phrases still win because their inferred
// effects are captured before this declaration is used by downstream binding.
func explicitlyDeclaresNoExternalEffects(prompt string) bool {
	return containsAnyFold(prompt,
		"no external effects", "without external effects",
		"does not modify external systems", "doesn't modify external systems",
		"without modifying external systems", "read-only", "read only",
		"only prepares information", "prepare information only",
		"sin efectos externos", "no modifica sistemas externos",
		"no modificar sistemas externos", "sin modificar sistemas externos",
		"solo prepara información", "sólo prepara información", "solo lectura")
}

func containsAll(values []string, required ...string) bool {
	present := make(map[string]bool, len(values))
	for _, value := range values {
		present[value] = true
	}
	for _, value := range required {
		if !present[value] {
			return false
		}
	}
	return true
}

func validPagerDutyWorkingHours(prompt string) bool {
	start, end, count := uniquePagerDutyWorkingHours(prompt)
	return count == 1 && start != "" && end != ""
}

func validPagerDutyDateRange(prompt string) bool {
	fromRaw, untilRaw, count := uniquePagerDutyDateRange(prompt)
	if count != 1 {
		return false
	}
	from, fromErr := time.Parse(time.DateOnly, fromRaw)
	until, untilErr := time.Parse(time.DateOnly, untilRaw)
	return fromErr == nil && untilErr == nil && !until.Before(from) &&
		!until.AddDate(0, 0, 1).After(from.AddDate(0, 0, maxPagerDutyActiveDays))
}

func validPagerDutyTimeZone(prompt string) bool {
	value, count := uniquePagerDutyMatch(prompt, nil, pagerDutyTimeZonePattern)
	if count != 1 {
		return false
	}
	_, err := time.LoadLocation(value)
	return err == nil
}

func validPagerDutyDuration(prompt string) bool {
	hours, count := uniquePagerDutyDurationHours(prompt)
	if count != 1 {
		return false
	}
	return hours >= 1 && hours*60*60 <= maxPagerDutySnoozeSeconds
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
	case IsPagerDutyWorkflowPrompt(prompt) || containsAnyFold(prompt,
		"when pagerduty", "pagerduty incident fires", "on pagerduty incident",
		"cuando pagerduty", "si pagerduty", "evento de pagerduty", "incidente de pagerduty se dispare"):
		return "pagerduty"
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
	if containsAnyFold(prompt, "pagerduty", "pager duty") && containsAnyFold(prompt,
		"acknowledge", "acknowledged", "reviewing", "revisando", "reconoc") {
		effects = append(effects, "pagerduty_acknowledge")
	}
	if containsAnyFold(prompt, "pagerduty", "pager duty") && (containsAnyFold(prompt,
		"snooze", "postpone", "silence", "pospon", "aplaz", "apláz", "dilat") || pagerDutyDurationPattern.MatchString(prompt)) {
		effects = append(effects, "pagerduty_snooze")
	}
	if containsAnyFold(prompt, "slack") {
		effects = append(effects, "slack_message")
	}
	if containsAnyFold(prompt, "github issue", "issue in github", "incidencia en github") {
		effects = append(effects, "github_issue")
	}
	if infersOutboundWebhook(prompt) && inferTrigger(prompt) != "webhook" {
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
	if containsAnyFold(prompt, "sheet.append") ||
		(containsAnyFold(prompt, "sheet", "spreadsheet", "hoja") && containsAnyFold(prompt,
			"append", "add rows", "agregar filas", "añadir filas", "anexar filas")) {
		effects = append(effects, "sheet_append")
	}
	if containsAnyFold(prompt, "vector.upsert") ||
		(containsAnyFold(prompt, "vector memory", "memoria vectorial") && containsAnyFold(prompt,
			"store", "write", "upsert", "guardar", "escribir")) {
		effects = append(effects, "vector_memory_write")
	}
	if containsAnyFold(prompt, "pdf.generate") ||
		(containsAnyFold(prompt, "pdf") && containsAnyFold(prompt,
			"generate", "create", "render", "generar", "crear", "renderizar")) {
		effects = append(effects, "pdf_generation")
	}
	if containsAnyFold(prompt, "mcp") && containsAnyFold(prompt,
		"update", "delete", "write", "send", "append", "mutate",
		"actualizar", "eliminar", "escribir", "enviar", "agregar", "añadir", "modificar",
		"mcp tool to create", "mcp tool for creating", "herramienta mcp para crear") {
		effects = append(effects, "mcp_write")
	}
	return effects
}

// infersOutboundWebhook deliberately requires an action phrase. A webhook can
// also appear as an inbound trigger or as the kind/name of a credential; those
// mentions describe a binding, not an additional external effect.
func infersOutboundWebhook(prompt string) bool {
	return containsAnyFold(prompt,
		"call the webhook", "call a webhook", "call webhook", "call the partner webhook",
		"send a webhook", "send webhook", "post to the webhook", "post to a webhook",
		"invoke the webhook", "invoke a webhook", "invoke webhook", "outbound webhook", "webhook.send",
		"llamar al webhook", "llamar un webhook", "llamar webhook", "enviar un webhook", "enviar webhook",
		"publicar en el webhook", "publicar a un webhook", "invocar el webhook", "invocar un webhook",
		"invocar webhook", "webhook saliente")
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

// ProposalGenerationPrompt keeps the source wording only for a recognized
// high-impact deterministic recipe. Intent Brief fields are deliberately
// bounded, so a valid machine identity or safety bound near the end of a
// 4000-character source prompt could otherwise be truncated before the recipe
// compiler sees it. Generic/provider generation continues to consume the
// normalized contract prompt rather than bypassing the staged brief.
func ProposalGenerationPrompt(compiled BriefCompilation, sourcePrompt string) string {
	sourcePrompt = strings.TrimSpace(sourcePrompt)
	if compiled.Brief.Trigger == "pagerduty" && IsPagerDutyWorkflowPrompt(sourcePrompt) {
		return sourcePrompt
	}
	return ProposalPrompt(compiled.Brief)
}
