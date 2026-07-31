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
	"sync"
	"time"

	"github.com/johnny4young/janusly/go/internal/ai"
	"github.com/johnny4young/janusly/go/internal/aibudget"
	"github.com/johnny4young/janusly/go/internal/aiconfig"
	"github.com/johnny4young/janusly/go/internal/aiguidance"
	"github.com/johnny4young/janusly/go/internal/audit"
	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/grammar"
	"github.com/johnny4young/janusly/go/internal/orgconfig"
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

	// Best-of-N: the configured candidate count (clamped 1..5) collapses
	// to single-shot once monthly spend crossed the warning threshold —
	// cost-aware backoff on the tenant's own "start being careful" line.
	configuredN := clampCandidateCount(int(orgconfig.LoadNumber(ctx, s.pool, rc.orgID, "ai.generationCandidates")))
	candidateTarget := configuredN
	if configuredN > 1 && gate.MonthlyUsdLimit != nil && gate.WarningThresholdCrossed {
		candidateTarget = 1
		audit.Write(ctx, s.pool, rc.authContext, "ai.generation.candidates_backoff", audit.Options{
			TargetType: "ai",
			Metadata:   map[string]any{"from": configuredN, "to": 1, "reason": "budget_warning_threshold"},
		})
	}
	workflowJSON, meta, aiErr := s.generateFreeJson(ctx, client, body.Prompt, body.Model, rc, candidateTarget)
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
			"candidateCount": meta.candidateCount, "validCandidates": meta.validCandidates,
		},
	})
	return opOK(withMode(workflowDoc, "ai", ""))
}

type generationMeta struct {
	model           string
	provider        string
	attempts        int
	repairAttempts  int
	candidateCount  int
	validCandidates int
}

// generateFreeJson runs the reference's free-JSON ladder: up to two
// generation attempts (a parse failure or dropped operator references
// nudge the retry), then up to two REPAIR attempts fed the domain
// validator's actual issues. Returns the raw workflow JSON that passed.
func (s *V1Server) generateFreeJson(ctx context.Context, client ai.Client, prompt, modelHint string, rc v1Request, candidateTarget int) ([]byte, generationMeta, *ai.AIError) {
	meta := generationMeta{}
	callContext := ai.CallContext{OrgID: rc.orgID, UserID: rc.userID}
	userPrompt := prompt

	// Operator guidance (janusly.md) appends as a fenced DATA section —
	// empty guidance leaves the base prompt byte-for-byte unchanged.
	systemPrompt := generateSystemPrompt
	if guidance := aiguidance.Load(ctx, s.pool, rc.orgID, ""); guidance != "" {
		systemPrompt = generateSystemPrompt + "\n\n" + guidance
	}

	generate := func(currentPrompt string) (string, *ai.AIError) {
		result, aiErr := client.GenerateText(ctx, ai.GenerateTextInput{
			System: systemPrompt, Prompt: currentPrompt,
			ResponseFormat: "json", ModelHint: modelHint,
			CacheSystemPrompt: true, Context: callContext,
		})
		if aiErr != nil {
			return "", aiErr
		}
		meta.model, meta.provider = result.Model, result.Provider
		return result.Text, nil
	}

	// Best-of-N (target > 1): N parallel samples, the best by readiness
	// score wins and flows through the SAME repair tail. Zero parsed
	// candidates falls to the single-shot retry ladder below — N=1 never
	// touches this branch, so the simple path stays byte-identical.
	var workflowJSON []byte
	if candidateTarget > 1 {
		if winner, valid := s.selectBestOfN(ctx, client, prompt, modelHint, callContext, candidateTarget, &meta); winner != nil {
			workflowJSON = winner
			meta.validCandidates = valid
		}
	}

	// Generation attempts: parse + reference preservation.
	for attempt := 1; workflowJSON == nil && attempt <= freeJsonMaxAttempts; attempt++ {
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

// clampCandidateCount bounds ai.generationCandidates to the [1,5] range.
func clampCandidateCount(n int) int {
	if n < 1 {
		return 1
	}
	if n > 5 {
		return 5
	}
	return n
}

// selectBestOfN fires n independent samples in parallel and keeps the
// best by the reference's deterministic readiness score (fails*10 +
// warns, lower wins, first-wins ties). A candidate that fails the
// validity gate still counts as a last-resort winner so the repair tail
// gets a chance; zero PARSED candidates returns nil and the caller falls
// to the single-shot ladder.
func (s *V1Server) selectBestOfN(ctx context.Context, client ai.Client, prompt, modelHint string,
	callContext ai.CallContext, n int, meta *generationMeta) ([]byte, int) {
	systemPrompt := generateSystemPrompt
	if guidance := aiguidance.Load(ctx, s.pool, callContext.OrgID, ""); guidance != "" {
		systemPrompt = generateSystemPrompt + "\n\n" + guidance
	}
	type candidate struct {
		raw      []byte
		model    string
		provider string
	}
	results := make([]*candidate, n)
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, aiErr := client.GenerateText(ctx, ai.GenerateTextInput{
				System: systemPrompt, Prompt: prompt,
				ResponseFormat: "json", ModelHint: modelHint,
				CacheSystemPrompt: true, Context: callContext,
			})
			if aiErr != nil {
				return // a rejected sample is dropped, never fatal
			}
			value, ok := ai.ParseJSONValue(result.Text)
			if !ok {
				return
			}
			raw, err := json.Marshal(value)
			if err != nil {
				return
			}
			results[i] = &candidate{raw: raw, model: result.Model, provider: result.Provider}
		}()
	}
	wg.Wait()

	var parsed []*candidate
	for _, entry := range results {
		if entry != nil {
			parsed = append(parsed, entry)
		}
	}
	meta.candidateCount = n
	if len(parsed) == 0 {
		return nil, 0
	}

	bestScore, bestIndex, validCount := -1, -1, 0
	for index, entry := range parsed {
		if issues := validateGeneratedWorkflow(entry.raw); len(issues) > 0 {
			continue // not a structurally valid graph — skip for scoring
		}
		validCount++
		wf, _ := domain.Parse(entry.raw)
		readiness := domain.CheckWorkflowReadiness(wf, domain.ReadinessOptions{})
		fails, warns := 0, 0
		for _, issue := range readiness.Issues {
			if issue.Severity == "fail" {
				fails++
			} else {
				warns++
			}
		}
		score := fails*10 + warns
		if bestIndex < 0 || score < bestScore {
			bestScore, bestIndex = score, index
		}
	}
	winner := parsed[0] // best effort: hand the first parsed draft to repair
	if bestIndex >= 0 {
		winner = parsed[bestIndex]
	}
	meta.model, meta.provider = winner.model, winner.provider
	return winner.raw, validCount
}
