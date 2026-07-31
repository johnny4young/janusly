// The `ai` node executor, ported from the reference's node registry: the
// prompt comes from the rendered config (or a PromptOps promptRef, which
// resolves BEFORE any token spend), the call goes through the chokepoint,
// and the output shape is stable — {mode:"ai", response, model, usage,
// costUsd, latencyMs} on success, {mode:"fallback", aiError, response:
// <deterministic text>} on EVERY failure. The sacred rule: a provider
// failure NEVER fails the node — the workflow continues with the
// fallback envelope. A validation (dry-run) execution never touches the
// SDK.
package executors

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/johnny4young/janusly/go/internal/ai"
)

// AIDeps carries the tenant-resolved seams the dispatcher builds for ai
// nodes: the chokepoint client, budget check, PromptOps resolver, and
// the dry-run flag. Nil AIDeps behaves as "no provider configured".
type AIDeps struct {
	Client        ai.Client
	OrgID         string
	WorkflowID    string
	DryRun        bool
	BudgetAllowed func() (bool, map[string]any)
	ResolvePrompt func(name string, version int, variables map[string]string) (string, error)
}

func executeAiNode(ctx context.Context, in Input) (any, error) {
	deps := in.AI
	config := in.Config

	// PromptOps seam: promptRef wins over an inline prompt (ambiguity is
	// an event, not an error); resolver failures degrade to fallback
	// BEFORE any token spend.
	promptRefRaw, _ := config["promptRef"].(map[string]any)
	refName, _ := promptRefRaw["name"].(string)
	inlinePrompt, _ := config["prompt"].(string)
	if refName != "" && inlinePrompt != "" && in.Emit != nil {
		in.Emit("ai.prompt_config_ambiguous", map[string]any{
			"message": "both prompt and promptRef are set; promptRef wins. Set only one.",
		})
	}
	prompt := inlinePrompt
	var resolvedPromptMeta map[string]any
	if refName != "" && deps != nil && deps.ResolvePrompt != nil {
		version := 0
		if v, ok := promptRefRaw["version"].(float64); ok {
			version = int(v)
		}
		variables := map[string]string{}
		if raw, ok := config["variables"].(map[string]any); ok {
			for key, value := range raw {
				if text, ok := value.(string); ok {
					variables[key] = text
				}
			}
		}
		resolved, err := deps.ResolvePrompt(refName, version, variables)
		if err != nil {
			if in.Emit != nil {
				in.Emit("ai.prompt_resolver_failed", map[string]any{"code": "prompt_resolver_failure", "message": err.Error()})
			}
			return map[string]any{
				"mode": "fallback", "aiError": "prompt_resolver_failure",
				"promptRef": map[string]any{"name": refName}, "error": err.Error(),
				"response":    fallbackAiResponse(refName, in.Context),
				"contextKeys": contextKeys(in.Context),
			}, nil
		}
		prompt = resolved
		resolvedPromptMeta = map[string]any{"name": refName, "version": version}
		if in.Emit != nil {
			in.Emit("ai.prompt_resolved", resolvedPromptMeta)
		}
	}
	if prompt == "" {
		prompt = "Summarize workflow"
	}

	if in.Emit != nil {
		in.Emit("ai.prompt", map[string]any{
			"prompt": previewText(prompt), "contextKeys": contextKeys(in.Context),
		})
	}
	modelHint, _ := config["model"].(string)
	_, hasOutputSchema := config["outputSchema"]

	fallbackOutput := func(aiError string, extra map[string]any) map[string]any {
		out := map[string]any{
			"mode":        "fallback",
			"prompt":      previewText(prompt),
			"response":    fallbackAiResponse(prompt, in.Context),
			"contextKeys": contextKeys(in.Context),
		}
		if aiError != "" {
			out["aiError"] = aiError
		}
		if modelHint != "" {
			out["modelHint"] = modelHint
		}
		if hasOutputSchema {
			out["valid"] = false
		}
		for key, value := range extra {
			out[key] = value
		}
		return out
	}

	// No provider configured (or no deps at all): the $0 fallback.
	if deps == nil || deps.Client == nil || !deps.Client.Configured() {
		return fallbackOutput("", nil), nil
	}
	// A validation (dry-run) execution NEVER touches the SDK.
	if deps.DryRun {
		return fallbackOutput("", map[string]any{"dryRun": true}), nil
	}
	// Budget chokepoint: the block path degrades, the run continues.
	if deps.BudgetAllowed != nil {
		if allowed, budget := deps.BudgetAllowed(); !allowed {
			if in.Emit != nil {
				in.Emit("ai.budget_exceeded", budget)
			}
			return fallbackOutput("budget_exceeded", map[string]any{"budget": budget}), nil
		}
	}

	responseFormat, _ := config["responseFormat"].(string)
	if hasOutputSchema {
		responseFormat = "json"
	}
	promptEnvelope, _ := json.Marshal(map[string]any{"prompt": prompt, "context": in.Context})
	result, aiErr := deps.Client.GenerateText(ctx, ai.GenerateTextInput{
		System:         "You are Janusly, an AI operator for business workflows. Answer clearly for an operator, and keep the response concise.",
		Prompt:         string(promptEnvelope),
		ResponseFormat: responseFormat,
		ModelHint:      modelHint,
		Context: ai.CallContext{
			OrgID: deps.OrgID, RunID: in.RunID, NodeID: in.NodeID, WorkflowID: deps.WorkflowID,
		},
	})
	if aiErr != nil {
		if in.Emit != nil {
			in.Emit("ai.fallback", map[string]any{"error": aiErr.Error(), "modelHint": modelHint})
		}
		return fallbackOutput(aiErr.Error(), nil), nil
	}

	output := map[string]any{
		"mode":     "ai",
		"model":    result.Model,
		"provider": result.Provider,
		"prompt":   previewText(prompt),
		"response": result.Text,
		"usage": map[string]any{
			"inputTokens": result.Usage.InputTokens, "outputTokens": result.Usage.OutputTokens,
			"totalTokens": result.Usage.TotalTokens,
		},
		"costUsd":   costOrNull(result.CostUsd),
		"latencyMs": result.LatencyMs,
	}
	if result.ProviderSimulated {
		output["providerSimulated"] = true
	}
	if hasOutputSchema {
		// Output contract: the text must parse as JSON. (The reference's
		// full schema-subset validation lands with its surface; parse-level
		// checking preserves the valid/data wire.)
		if data, ok := ai.ParseJSONValue(result.Text); ok {
			output["valid"], output["data"] = true, data
		} else {
			if in.Emit != nil {
				in.Emit("ai.output_invalid", map[string]any{
					"error": "output did not parse as JSON", "model": result.Model, "provider": result.Provider,
				})
			}
			return fallbackOutput("output_invalid", map[string]any{
				"error": "output did not parse as JSON",
				"model": result.Model, "provider": result.Provider,
				"usage": output["usage"], "costUsd": output["costUsd"], "latencyMs": output["latencyMs"],
			}), nil
		}
	}
	return output, nil
}

// fallbackAiResponse ports the reference's deterministic fallback text.
func fallbackAiResponse(prompt string, context map[string]any) string {
	keys := contextKeys(context)
	contextLine := "No prior node context was available."
	if len(keys) > 0 {
		contextLine = "Available context: " + strings.Join(keys, ", ") + "."
	}
	return strings.Join([]string{
		"AI fallback response.",
		"Prompt: " + previewText(prompt),
		contextLine,
		"Configure an LLM API key (OPENAI_API_KEY or ANTHROPIC_API_KEY) to generate a model-written answer.",
	}, "\n")
}

func contextKeys(context map[string]any) []string {
	keys := make([]string, 0, len(context))
	for key := range context {
		if key == "orgId" || key == "userId" || key == "createdBy" {
			continue
		}
		keys = append(keys, key)
	}
	return keys
}

func previewText(value string) string {
	const maxLength = 700
	runes := []rune(value)
	if len(runes) <= maxLength {
		return value
	}
	return string(runes[:maxLength]) + "…"
}

func costOrNull(cost *float64) any {
	if cost == nil {
		return nil
	}
	return *cost
}
