// POST /ai/patch-workflow — the Recovery dialog's AI patch, ported in the
// runtime's cut of the contract route: budget gate → "ai" rate bucket →
// tenant-scoped DLQ + run + bounded recent events as context → per-type
// envelope (config patch) with the STRUCTURAL envelope dispatched when the
// failing node is a write-side http/mcp_tool with no approval ancestor →
// free-JSON suggestions → each one APPLIED and validated through the real
// domain gate (an invalid patch never reaches the wire) → the contract
// response shape with 0-2 scrubbed consideredAlternatives kept INSIDE the
// suggestion, never in the deterministic evidence block. Every failure
// degrades to the full-shape deterministic fallback (the original
// workflow, confidence 0). Deferred with their subsystems: confidence
// calibration (calibrated mirrors raw — the disabled behavior), memory
// hints, past-feedback enrichment, locale.
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/johnny4young/janusly/internal/ai"
	"github.com/johnny4young/janusly/internal/aibudget"
	"github.com/johnny4young/janusly/internal/aiconfig"
	"github.com/johnny4young/janusly/internal/aievidence"
	"github.com/johnny4young/janusly/internal/aiguidance"
	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/ratelimit"
	"github.com/johnny4young/janusly/internal/signature"
	"github.com/johnny4young/janusly/internal/store"
)

const patchSystemPrompt = `You suggest minimal fixes for a failed workflow node. Output ONLY a JSON object:
{"suggestions":[{"patchedConfig":{...},"rationale":"...","approachLabel":"config_fix|retry_tuning|url_fix|auth_fix|other","confidence":0.0-1.0,"consideredAlternatives":[{"approach":"...","rejectedBecause":"..."}]}]}
1-3 suggestions, each a COMPLETE replacement config for the failing node only.
RETRY/TIMEOUT SCHEMA (the runtime honors ONLY these keys — anything else is ignored):
"retry":{"maxAttempts":int,"delayMs":number,"maxDelayMs":number,"backoff":"fixed"|"exponential","jitter":bool,"retryOn":[codes],"ignoreOn":[codes]} and top-level "timeoutMs":number.
Never emit timeout, retries, maxRetries, initialDelayMs, or backoffMultiplier.
Do not invent secrets — reference them as {{secret.NAME}}. consideredAlternatives is optional, at most 2.`

const structuralPatchSystemPrompt = `You suggest a STRUCTURAL guard for a write-side workflow node that lacks human approval. Output ONLY a JSON object:
{"suggestions":[{"action":"insert_approval_upstream","approvalNodeId":"...","approvalMessage":"...","insertBeforeNodeId":"<the failing node id>","rationale":"...","approachLabel":"insert_approval","confidence":0.0-1.0}]}
Exactly one suggestion. approvalNodeId must be a NEW unique snake_case id.`

func (s *V1Server) patchWorkflowCore(r *http.Request, rc v1Request) opResult {
	var body struct {
		DeadLetterID string `json:"deadLetterId"`
		Model        string `json:"model"`
	}
	_ = decodeBody(r, &body)
	if body.DeadLetterID == "" {
		return opError(http.StatusBadRequest, "ai_dead_letter_id_required", "deadLetterId is required", nil)
	}
	ctx := r.Context()
	gate := aibudget.Gate(ctx, s.pool, rc.orgID, rc.userID, "ai.workflow.patch_suggested")
	if !gate.Allowed {
		return opResult{status: http.StatusPaymentRequired, data: map[string]any{
			"error": "budget_exceeded", "code": "budget_exceeded",
		}}
	}
	client, settings := aiconfig.Resolve(ctx, s.pool, rc.orgID)
	if limitErr := s.limiter.Enforce(ctx, rc.orgID, ratelimit.Options{
		Name: "ai", Max: settings.RateLimitPerMin, Window: time.Minute,
	}); limitErr != nil {
		return opError(http.StatusTooManyRequests, "rate_limited", limitErr.Error(), nil)
	}

	q := store.New(s.pool)
	dlq, err := q.GetDeadLetter(ctx, store.GetDeadLetterParams{ID: body.DeadLetterID, OrgID: rc.orgID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusNotFound, "dlq_not_found", "DLQ entry not found", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}

	// Failure identity for the recovery passport.
	failureSignature := signature.NormalizeJSON(dlq.ErrorJson, signature.Context{
		NodeID: dlq.NodeID, NodeType: nodeTypeOf(dlq.NodeJson),
	}).Signature

	// Original workflow + failing node; an unparseable snapshot degrades
	// straight to the deterministic fallback.
	var workflowDoc map[string]any
	_ = json.Unmarshal(dlq.WorkflowJson, &workflowDoc)
	original, _ := domain.Parse(dlq.WorkflowJson)

	// Evidence side-channel: a deterministic projection of what the prompt
	// composer sees — attached on BOTH the ai and fallback paths, audited
	// only as a count.
	evidence := aievidence.ScrubRows([]aievidence.Row{
		aievidence.RecentErrorRow(dlq.RunID, dlq.ErrorJson),
		aievidence.SignatureRuleRow(signature.NormalizeJSON(dlq.ErrorJson, signature.Context{
			NodeID: dlq.NodeID, NodeType: nodeTypeOf(dlq.NodeJson),
		}).Signature),
	})
	fallback := func(aiError string, model, provider string) opResult {
		suggestion := map[string]any{
			"workflow": workflowDoc, "rationale": patchFallbackRationale(aiError),
			"approachLabel": "other", "confidence": 0, "calibratedConfidence": 0,
			"safety":                 domain.ComputeSuggestionSafety(original, dlq.NodeID),
			"consideredAlternatives": []any{},
		}
		response := map[string]any{
			"mode": "fallback", "suggestedWorkflow": workflowDoc,
			"rationale":   patchFallbackRationale(aiError),
			"suggestions": []any{suggestion}, "evidence": evidence,
			"recoveryPassport": map[string]any{
				"failureSignature": failureSignature, "priorSameSignatureOutcome": nil,
			},
		}
		if model != "" {
			response["model"], response["provider"] = model, provider
		}
		if aiError != "" {
			response["aiError"] = aiError
		}
		audit.Write(ctx, s.pool, rc.authContext, "ai.workflow.patch_suggested", audit.Options{
			TargetType: "dlq", TargetID: body.DeadLetterID,
			Metadata: map[string]any{"mode": "fallback", "evidenceCount": len(evidence)},
		})
		return opOK(response)
	}
	if !client.Configured() {
		return fallback("", "", "")
	}
	if original == nil {
		return fallback("original workflow failed strict schema", "", "")
	}

	// Structural dispatch: write-side http/mcp_tool with no approval gate.
	failingNode := findNode(original, dlq.NodeID)
	useStructural := failingNode != nil &&
		(failingNode.Type == "http" || failingNode.Type == "mcp_tool") &&
		domain.IsSensitiveActionNode(*failingNode) &&
		!domain.HasApprovalAncestorIn(original, dlq.NodeID)
	systemPrompt := patchSystemPrompt
	if useStructural {
		systemPrompt = structuralPatchSystemPrompt
	}

	prompt := composePatchPrompt(dlq, workflowDoc)

	result, aiErr := client.GenerateText(ctx, ai.GenerateTextInput{
		// The locale rider goes AFTER the cached system prompt body so the
		// prompt cache still hits for the shared prefix.
		System: withLocale(systemPrompt, r), Prompt: prompt, ResponseFormat: "json",
		ModelHint: body.Model, CacheSystemPrompt: true,
		Context: ai.CallContext{OrgID: rc.orgID, UserID: rc.userID},
	})
	if aiErr != nil {
		return fallback(aiErr.Error(), "", "")
	}
	parsed, ok := ai.ParseJSONValue(result.Text)
	if !ok {
		return fallback("model output was not a valid patch envelope", result.Model, result.Provider)
	}
	envelope, _ := parsed.(map[string]any)
	rawSuggestions, _ := envelope["suggestions"].([]any)

	validated := make([]map[string]any, 0, len(rawSuggestions))
	for _, rawItem := range rawSuggestions {
		item, ok := rawItem.(map[string]any)
		if !ok {
			continue
		}
		merged := applyPatchSuggestion(original, dlq.NodeID, item, useStructural)
		if merged == nil {
			continue // an invalid patch NEVER reaches the wire
		}
		mergedJSON, err := json.Marshal(merged)
		if err != nil {
			continue
		}
		if issues := validateGeneratedWorkflow(mergedJSON); len(issues) > 0 {
			continue
		}
		var mergedDoc map[string]any
		_ = json.Unmarshal(mergedJSON, &mergedDoc)
		confidence := numberField(item, "confidence")
		validated = append(validated, map[string]any{
			"workflow": mergedDoc, "rationale": stringField(item, "rationale"),
			"approachLabel": stringField(item, "approachLabel"),
			"confidence":    confidence,
			// Calibration disabled in the runtime: calibrated mirrors raw.
			"calibratedConfidence":   confidence,
			"safety":                 domain.ComputeSuggestionSafety(merged, dlq.NodeID),
			"consideredAlternatives": sanitizeConsideredAlternatives(item["consideredAlternatives"]),
		})
	}
	if len(validated) == 0 {
		return fallback("no_valid_suggestions", result.Model, result.Provider)
	}
	// Rank: highest confidence first (stable).
	for i := 1; i < len(validated); i++ {
		for j := i; j > 0 && validated[j]["confidence"].(float64) > validated[j-1]["confidence"].(float64); j-- {
			validated[j], validated[j-1] = validated[j-1], validated[j]
		}
	}
	top := validated[0]
	audit.Write(ctx, s.pool, rc.authContext, "ai.workflow.patch_suggested", audit.Options{
		TargetType: "dlq", TargetID: body.DeadLetterID,
		Metadata: map[string]any{"mode": "ai", "suggestions": len(validated), "evidenceCount": len(evidence)},
	})
	return opOK(map[string]any{
		"mode": "ai", "suggestedWorkflow": top["workflow"], "rationale": top["rationale"],
		"suggestions": validated, "evidence": evidence,
		"recoveryPassport": map[string]any{
			"failureSignature": failureSignature, "priorSameSignatureOutcome": nil,
		},
		"model": result.Model, "provider": result.Provider,
	})
}

func patchFallbackRationale(aiError string) string {
	if aiError == "" {
		return "AI provider not configured. The original workflow is unchanged."
	}
	return "AI returned suggestions that could not be applied safely. The original workflow is unchanged. Reason: " + aiError
}

// applyPatchSuggestion merges one suggestion into a COPY of the workflow:
// the config envelope replaces the failing node's config; the structural
// envelope inserts a new approval node upstream of the failing node.
// Returns nil when the suggestion's fields are unusable.
func applyPatchSuggestion(original *domain.Workflow, nodeID string, item map[string]any, structural bool) *domain.Workflow {
	copied := cloneWorkflow(original)
	if copied == nil {
		return nil
	}
	if !structural {
		patched, ok := item["patchedConfig"].(map[string]any)
		if !ok {
			return nil
		}
		normalizePatchedConfig(patched)
		for i := range copied.Nodes {
			if copied.Nodes[i].ID == nodeID {
				copied.Nodes[i].Config = patched
				return copied
			}
		}
		return nil
	}
	action, _ := item["action"].(string)
	approvalID := stringField(item, "approvalNodeId")
	message := stringField(item, "approvalMessage")
	insertBefore := stringField(item, "insertBeforeNodeId")
	if action != "insert_approval_upstream" || approvalID == "" || insertBefore != nodeID {
		return nil
	}
	for _, node := range copied.Nodes {
		if node.ID == approvalID {
			return nil // the new id must be unique
		}
	}
	if message == "" {
		message = "Approve to continue."
	}
	copied.Nodes = append(copied.Nodes, domain.Node{
		ID: approvalID, Type: "approval", Config: map[string]any{"message": message},
	})
	// Rewire: every edge INTO the failing node now targets the approval,
	// and one new edge approval → failing node.
	for i := range copied.Edges {
		if copied.Edges[i].To == nodeID {
			copied.Edges[i].To = approvalID
		}
	}
	copied.Edges = append(copied.Edges, domain.Edge{From: approvalID, To: nodeID})
	return copied
}

// normalizePatchedConfig maps the retry/timeout aliases models keep
// inventing onto the ONLY keys the engine reads. Without this, a patch
// whose whole point was "add backoff and a longer timeout" validates and
// applies while silently dropping both — the suggestion's intent and its
// effect diverge (observed live with claude-haiku: backoffMultiplier,
// initialDelayMs and timeout were all ignored). Canonical keys always
// win; aliases are consumed, never left behind.
func normalizePatchedConfig(config map[string]any) {
	if value, ok := config["timeout"].(float64); ok {
		if _, present := config["timeoutMs"]; !present {
			config["timeoutMs"] = value
		}
		delete(config, "timeout")
	}
	retry, ok := config["retry"].(map[string]any)
	if !ok {
		return
	}
	moveNumber := func(alias, canonical string) {
		value, ok := retry[alias].(float64)
		if !ok {
			delete(retry, alias)
			return
		}
		if _, present := retry[canonical]; !present {
			retry[canonical] = value
		}
		delete(retry, alias)
	}
	moveNumber("retries", "maxAttempts")
	moveNumber("maxRetries", "maxAttempts")
	moveNumber("initialDelayMs", "delayMs")
	moveNumber("delay", "delayMs")
	moveNumber("maxDelay", "maxDelayMs")
	if multiplier, ok := retry["backoffMultiplier"].(float64); ok {
		if _, present := retry["backoff"]; !present {
			if multiplier > 1 {
				retry["backoff"] = "exponential"
			} else {
				retry["backoff"] = "fixed"
			}
		}
	}
	delete(retry, "backoffMultiplier")
}

func cloneWorkflow(wf *domain.Workflow) *domain.Workflow {
	raw, err := json.Marshal(wf)
	if err != nil {
		return nil
	}
	cloned, _ := domain.Parse(raw)
	return cloned
}

// sanitizeConsideredAlternatives: at most 2, one-line, scrubbed — and by
// construction they live INSIDE the suggestion, never in evidence.
func sanitizeConsideredAlternatives(value any) []map[string]any {
	items, ok := value.([]any)
	if !ok {
		return []map[string]any{}
	}
	out := make([]map[string]any, 0, 2)
	for _, raw := range items {
		if len(out) >= 2 {
			break
		}
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		approach := oneLine(stringField(item, "approach"), 120)
		rejected := oneLine(stringField(item, "rejectedBecause"), 280)
		if approach == "" || rejected == "" {
			continue
		}
		out = append(out, map[string]any{"approach": approach, "rejectedBecause": rejected})
	}
	return out
}

func oneLine(value string, max int) string {
	value = strings.Join(strings.Fields(aiguidance.ScrubGuidanceSecrets(value)), " ")
	if len(value) > max {
		value = value[:max]
	}
	return strings.TrimSpace(value)
}

func composePatchPrompt(dlq store.GetDeadLetterRow, workflowDoc map[string]any) string {
	workflowJSON, _ := json.Marshal(workflowDoc)
	return "Failing node id: " + dlq.NodeID +
		"\n\nError (data):\n" + string(dlq.ErrorJson) +
		"\n\nWorkflow (data):\n" + string(workflowJSON) +
		"\n\nSuggest fixes per the required envelope."
}

func findNode(wf *domain.Workflow, nodeID string) *domain.Node {
	for i := range wf.Nodes {
		if wf.Nodes[i].ID == nodeID {
			return &wf.Nodes[i]
		}
	}
	return nil
}

func numberField(doc map[string]any, key string) float64 {
	value, _ := doc[key].(float64)
	if value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}

func nodeTypeOf(nodeJSON []byte) string {
	var node struct {
		Type string `json:"type"`
	}
	_ = json.Unmarshal(nodeJSON, &node)
	return node.Type
}

func (s *V1Server) mountAiPatchRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /ai/patch-workflow", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.patchWorkflowCore(r, rc))
	}))
}
