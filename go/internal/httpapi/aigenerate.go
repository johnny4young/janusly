// POST /ai/generate-workflow — the pilot's generation surface, ported
// from the reference route in its default free_json mode: prompt cap →
// "ai" rate bucket → budget gate → free-JSON generation against the
// verbatim system prompt → validation through the REAL domain validator →
// a bounded repair pass fed the actual issue codes → the wire shape
// {mode, ...workflow}. Every failure path degrades to the deterministic
// template fallback: with a classified aiError when an LLM call was
// attempted, WITHOUT aiError when no provider is configured — that
// distinction is what lets `pnpm evals` skip ai-mode cases at $0.
//
// Deferred to their own tickets: Best-of-N (T-106), few-shot exemplars +
// operator guidance (T-107), PromptOps registry (T-108), pass-2 noop
// promotion and the PagerDuty deterministic recipe (§9 divergence: a
// budget-blocked PagerDuty prompt answers 402 here, not the recipe).
package httpapi

import (
	"context"
	_ "embed"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/johnny4young/janusly/go/internal/ai"
	"github.com/johnny4young/janusly/go/internal/aibudget"
	"github.com/johnny4young/janusly/go/internal/aiconfig"
	"github.com/johnny4young/janusly/go/internal/audit"
	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/grammar"
	"github.com/johnny4young/janusly/go/internal/ratelimit"
)

//go:embed ai_generate_prompt.txt
var generateSystemPrompt string

// Reference constants.
const (
	freeJsonMaxAttempts = 2
	maxRepairAttempts   = 2
	retryNudge          = "\n\nYour previous reply was not a valid workflow. Return ONLY the JSON workflow object — no prose, no markdown fences."
)

var templateReferencePattern = regexp.MustCompile(`\{\{(?:secret|env|context|input|inputs)\.[A-Za-z0-9_.-]{1,220}\}\}`)

const maxPromptTemplateReferences = 32

// promptTemplateReferences: operator-written machine references that must
// survive generation byte-for-byte.
func promptTemplateReferences(prompt string) []string {
	seen := map[string]bool{}
	var out []string
	for _, match := range templateReferencePattern.FindAllString(prompt, -1) {
		if !seen[match] {
			seen[match] = true
			out = append(out, match)
			if len(out) >= maxPromptTemplateReferences {
				break
			}
		}
	}
	return out
}

func missingPromptTemplateReferences(prompt string, workflowJSON []byte) []string {
	serialized := string(workflowJSON)
	var missing []string
	for _, reference := range promptTemplateReferences(prompt) {
		if !strings.Contains(serialized, reference) {
			missing = append(missing, reference)
		}
	}
	return missing
}

func referenceRetryNudge(references []string) string {
	if len(references) == 0 {
		return ""
	}
	return "\n\nYour previous workflow omitted operator-supplied machine references.\n" +
		"Preserve these exact references byte-for-byte in the relevant config values: " +
		strings.Join(references, ", ") + ".\n" +
		"They are safe Janusly references, not literal secret values. Return ONLY the corrected JSON workflow object."
}

func (s *V1Server) generateWorkflowCore(r *http.Request, rc v1Request) opResult {
	var body struct {
		Prompt string `json:"prompt"`
		Model  string `json:"model"`
	}
	_ = decodeBody(r, &body)
	ctx := r.Context()
	client, settings := aiconfig.Resolve(ctx, s.pool, rc.orgID)

	if settings.PromptMaxChars > 0 && len(body.Prompt) > settings.PromptMaxChars {
		return opError(http.StatusRequestEntityTooLarge, "ai_prompt_too_long",
			"prompt exceeds {{maxChars}} characters",
			map[string]any{"maxChars": settings.PromptMaxChars})
	}
	if limitErr := s.limiter.Enforce(ctx, rc.orgID, ratelimit.Options{
		Name: "ai", Max: settings.RateLimitPerMin, Window: time.Minute,
	}); limitErr != nil {
		return opError(http.StatusTooManyRequests, "rate_limited", limitErr.Error(), nil)
	}

	gate := aibudget.Gate(ctx, s.pool, rc.orgID, rc.userID, "ai.workflow.generated")
	if !gate.Allowed {
		raw, _ := json.Marshal(gate)
		var envelope map[string]any
		_ = json.Unmarshal(raw, &envelope)
		return opResult{status: http.StatusPaymentRequired, data: map[string]any{
			"error": "budget_exceeded", "code": "budget_exceeded",
			"params": map[string]any{
				"monthlyUsdSpent": gate.MonthlyUsdSpent, "monthlyUsdLimit": gate.MonthlyUsdLimit,
				"policy": gate.Policy, "warningPercent": gate.WarningPercent,
			},
			"budget": envelope,
		}}
	}

	// $0 path: no provider configured. The response carries NO aiError —
	// the evals harness reads that as "no key reachable" and skips ai-mode
	// cases, keeping a keyless run green at zero cost.
	if !client.Configured() {
		fallback := fallbackTemplateForPrompt(body.Prompt)
		audit.Write(ctx, s.pool, rc.authContext, "ai.workflow.generated", audit.Options{
			TargetType: "ai", TargetID: templateID(fallback),
			Metadata: map[string]any{"mode": "fallback", "error": "AI provider not configured", "generationMode": "free_json"},
		})
		return opOK(withMode(fallback, "fallback", ""))
	}

	workflowJSON, meta, aiErr := s.generateFreeJson(ctx, client, body.Prompt, body.Model, rc)
	if aiErr != nil {
		fallback := fallbackTemplateForPrompt(body.Prompt)
		audit.Write(ctx, s.pool, rc.authContext, "ai.workflow.generated", audit.Options{
			TargetType: "ai", TargetID: templateID(fallback),
			Metadata: map[string]any{"mode": "fallback", "error": aiErr.Error(), "generationMode": "free_json"},
		})
		return opOK(withMode(fallback, "fallback", aiErr.Error()))
	}

	var workflowDoc map[string]any
	_ = json.Unmarshal(workflowJSON, &workflowDoc)
	audit.Write(ctx, s.pool, rc.authContext, "ai.workflow.generated", audit.Options{
		TargetType: "ai", TargetID: stringField(workflowDoc, "id"),
		Metadata: map[string]any{
			"mode": "ai", "generationMode": "free_json",
			"model": meta.model, "provider": meta.provider,
			"attempts": meta.attempts, "repairAttempts": meta.repairAttempts,
		},
	})
	return opOK(withMode(workflowDoc, "ai", ""))
}

type generationMeta struct {
	model          string
	provider       string
	attempts       int
	repairAttempts int
}

// generateFreeJson runs the reference's free-JSON ladder: up to two
// generation attempts (a parse failure or dropped operator references
// nudge the retry), then up to two REPAIR attempts fed the domain
// validator's actual issues. Returns the raw workflow JSON that passed.
func (s *V1Server) generateFreeJson(ctx context.Context, client ai.Client, prompt, modelHint string, rc v1Request) ([]byte, generationMeta, *ai.AIError) {
	meta := generationMeta{}
	callContext := ai.CallContext{OrgID: rc.orgID, UserID: rc.userID}
	userPrompt := prompt

	generate := func(currentPrompt string) (string, *ai.AIError) {
		result, aiErr := client.GenerateText(ctx, ai.GenerateTextInput{
			System: generateSystemPrompt, Prompt: currentPrompt,
			ResponseFormat: "json", ModelHint: modelHint,
			CacheSystemPrompt: true, Context: callContext,
		})
		if aiErr != nil {
			return "", aiErr
		}
		meta.model, meta.provider = result.Model, result.Provider
		return result.Text, nil
	}

	// Generation attempts: parse + reference preservation.
	var workflowJSON []byte
	for attempt := 1; attempt <= freeJsonMaxAttempts; attempt++ {
		meta.attempts = attempt
		text, aiErr := generate(userPrompt)
		if aiErr != nil {
			return nil, meta, aiErr
		}
		value, ok := ai.ParseJSONValue(text)
		if !ok {
			userPrompt = prompt + retryNudge
			continue
		}
		raw, err := json.Marshal(value)
		if err != nil {
			userPrompt = prompt + retryNudge
			continue
		}
		if missing := missingPromptTemplateReferences(prompt, raw); len(missing) > 0 && attempt < freeJsonMaxAttempts {
			userPrompt = prompt + referenceRetryNudge(missing)
			continue
		}
		workflowJSON = raw
		break
	}
	if workflowJSON == nil {
		return nil, meta, &ai.AIError{Class: "invalid_output", Message: "model output was not a valid workflow JSON object"}
	}

	// Repair ladder: feed the REAL validator issues back, bounded.
	issues := validateGeneratedWorkflow(workflowJSON)
	for repair := 1; len(issues) > 0 && repair <= maxRepairAttempts; repair++ {
		meta.repairAttempts = repair
		text, aiErr := generate(composeRepairPrompt(prompt, workflowJSON, issues))
		if aiErr != nil {
			return nil, meta, aiErr
		}
		value, ok := ai.ParseJSONValue(text)
		if !ok {
			continue
		}
		raw, err := json.Marshal(value)
		if err != nil {
			continue
		}
		if repairedIssues := validateGeneratedWorkflow(raw); len(repairedIssues) == 0 {
			workflowJSON, issues = raw, nil
			break
		} else {
			workflowJSON, issues = raw, repairedIssues
		}
	}
	if len(issues) > 0 {
		return nil, meta, &ai.AIError{Class: "invalid_output",
			Message: "generated workflow failed validation: " + issueSummary(issues)}
	}
	return workflowJSON, meta, nil
}

// composeRepairPrompt mirrors the reference's directed-repair framing:
// the draft plus the exact issues, asking for a corrected object only.
func composeRepairPrompt(prompt string, draft []byte, issues []domain.Issue) string {
	var lines []string
	for _, issue := range issues {
		lines = append(lines, "- "+string(issue.Code)+": "+issue.Message)
	}
	return prompt +
		"\n\nYour previous workflow draft failed validation. Fix EXACTLY these issues and return ONLY the corrected JSON workflow object:\n" +
		strings.Join(lines, "\n") +
		"\n\nPrevious draft:\n" + string(draft)
}

func issueSummary(issues []domain.Issue) string {
	var parts []string
	for i, issue := range issues {
		if i >= 5 {
			parts = append(parts, "…")
			break
		}
		parts = append(parts, string(issue.Code))
	}
	return strings.Join(parts, ", ")
}

// withMode merges the mode (+ optional aiError) onto a workflow document.
func withMode(workflow map[string]any, mode, aiError string) map[string]any {
	out := make(map[string]any, len(workflow)+2)
	for key, value := range workflow {
		out[key] = value
	}
	out["mode"] = mode
	if aiError != "" {
		out["aiError"] = aiError
	}
	return out
}

func stringField(doc map[string]any, key string) string {
	value, _ := doc[key].(string)
	return value
}

func templateID(workflow map[string]any) string { return stringField(workflow, "id") }

// validateGeneratedWorkflow runs the parsed doc through the REAL domain
// gate with the save posture (pilot-unsupported runtime types are a
// start-time concern, not a generation one). Returns the blocking issues.
func validateGeneratedWorkflow(raw []byte) []domain.Issue {
	wf, parseIssues := domain.Parse(raw)
	if wf == nil {
		return parseIssues
	}
	result := domain.Validate(wf, grammar.DomainValidator)
	var blocking []domain.Issue
	for _, issue := range result.Issues {
		if issue.Code != domain.CodeNodeTypeUnsupportedPilot {
			blocking = append(blocking, issue)
		}
	}
	return blocking
}

func (s *V1Server) mountAiGenerateRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /ai/generate-workflow", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.generateWorkflowCore(r, rc))
	}))
}
