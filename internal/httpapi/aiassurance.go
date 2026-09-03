package httpapi

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/johnny4young/janusly/internal/domain"
)

// assuranceCompilation records deterministic, provider-independent additions
// made after generation. The compiler never invents semantic success criteria:
// a V2 Qualification Contract remains entirely operator/model-authored and is
// accepted only after the real domain validator replays its fixtures.
type assuranceCompilation struct {
	AddedOutputs          bool
	AddedRecoveryContract bool
}

// compileWorkflowAssurance deep-copies and completes a parsed workflow with
// the minimum executable assurance contracts Janusly can infer truthfully.
// The resulting document must pass the exact save-time domain validator.
func compileWorkflowAssurance(prompt string, raw []byte) ([]byte, assuranceCompilation, error) {
	return compileWorkflowAssuranceWithValidator(prompt, raw, validateGeneratedWorkflow)
}

// compileWorkflowAssuranceCandidate completes an untrusted provider draft
// while deferring only unknown capability identities to the exact tenant
// catalog finalizer. Saved workflows and all non-provider compilation retain
// the strict validator above.
func compileWorkflowAssuranceCandidate(prompt string, raw []byte) ([]byte, assuranceCompilation, error) {
	return compileWorkflowAssuranceWithValidator(prompt, raw, validateGeneratedWorkflowCandidate)
}

func compileWorkflowAssuranceWithValidator(
	prompt string,
	raw []byte,
	validate func([]byte) []domain.Issue,
) ([]byte, assuranceCompilation, error) {
	var document map[string]any
	if err := json.Unmarshal(raw, &document); err != nil || document == nil {
		if err == nil {
			err = fmt.Errorf("workflow must be a JSON object")
		}
		return nil, assuranceCompilation{}, err
	}

	compiled, meta, err := compileWorkflowAssuranceDocument(prompt, document)
	if err != nil {
		return nil, meta, err
	}
	encoded, err := json.Marshal(compiled)
	if err != nil {
		return nil, meta, fmt.Errorf("encode assurance workflow: %w", err)
	}
	if issues := validate(encoded); len(issues) > 0 {
		return nil, meta, fmt.Errorf("compiled workflow failed validation: %s", issueSummary(issues))
	}
	return encoded, meta, nil
}

// compileWorkflowAssuranceDocument returns a deep copy so the process-global
// fallback templates can never be mutated by a request-specific compilation.
func compileWorkflowAssuranceDocument(prompt string, document map[string]any) (map[string]any, assuranceCompilation, error) {
	encoded, err := json.Marshal(document)
	if err != nil {
		return nil, assuranceCompilation{}, fmt.Errorf("copy assurance workflow: %w", err)
	}
	var compiled map[string]any
	if err := json.Unmarshal(encoded, &compiled); err != nil || compiled == nil {
		return nil, assuranceCompilation{}, fmt.Errorf("copy assurance workflow: %w", err)
	}

	meta := assuranceCompilation{}
	if outputsMissing(compiled) {
		if outputs := terminalOutputProjections(compiled); len(outputs) > 0 {
			compiled["outputs"] = outputs
			meta.AddedOutputs = true
		}
	}

	if recoveryRequested(prompt) {
		recovery, exists := compiled["recovery"]
		if !exists {
			recovery = map[string]any{}
			compiled["recovery"] = recovery
		}
		if recoveryMap, ok := recovery.(map[string]any); ok {
			if _, exists := recoveryMap["circuitBreaker"]; !exists {
				recoveryMap["circuitBreaker"] = 3
			}
			if contract, exists := recoveryMap["contract"]; !exists || contract == nil {
				recoveryMap["contract"] = conservativeRecoveryContract(compiled)
				meta.AddedRecoveryContract = true
			}
		}
	}
	return compiled, meta, nil
}

func outputsMissing(document map[string]any) bool {
	value, exists := document["outputs"]
	if !exists || value == nil {
		return true
	}
	outputs, ok := value.(map[string]any)
	return ok && len(outputs) == 0
}

// terminalOutputProjections derives stable result projections from DAG sinks.
// Document order wins, which makes compilation repeatable and keeps a single
// terminal workflow ergonomic (`outputs.result`).
func terminalOutputProjections(document map[string]any) map[string]any {
	nodes, ok := document["nodes"].([]any)
	if !ok || len(nodes) == 0 {
		return nil
	}
	outgoing := map[string]bool{}
	if edges, ok := document["edges"].([]any); ok {
		for _, item := range edges {
			edge, ok := item.(map[string]any)
			if !ok {
				continue
			}
			from, _ := edge["from"].(string)
			if from != "" {
				outgoing[from] = true
			}
		}
	}

	var terminals []string
	for _, item := range nodes {
		node, ok := item.(map[string]any)
		if !ok {
			continue
		}
		id, _ := node["id"].(string)
		if id != "" && !outgoing[id] {
			terminals = append(terminals, id)
		}
	}
	if len(terminals) == 0 {
		return nil
	}
	outputs := make(map[string]any, len(terminals))
	if len(terminals) == 1 {
		outputs["result"] = "{{context." + terminals[0] + ".output}}"
		return outputs
	}
	for index, terminal := range terminals {
		outputs[fmt.Sprintf("result_%d", index+1)] = "{{context." + terminal + ".output}}"
	}
	return outputs
}

func recoveryRequested(prompt string) bool {
	text := strings.ToLower(prompt)
	return containsAny(text,
		"recoverable", "recovery-ready", "resilient", "resilience",
		"fault-tolerant", "fault tolerant", "safe-to-retry", "safe to retry",
		"survive a failing", "survive a misconfigured",
		"recuperable", "recuperación", "recuperacion", "resiliente", "resiliencia",
		"tolerante a fallos", "reintento seguro", "sobreviva a un fallo", "sobrevivir a un fallo",
	)
}

func conservativeRecoveryContract(document map[string]any) map[string]any {
	return map[string]any{
		"version": "1",
		"failure": map[string]any{
			"technical": map[string]any{"terminalNodeFailure": true, "stalledNode": true},
			"semantic":  map[string]any{"mode": "disabled"},
		},
		"evidence": map[string]any{
			"required": []any{"failure_snapshot", "audit_trail", "terminal_outcome"},
		},
		"effects": derivedRecoveryEffects(document),
		"repairs": map[string]any{
			"allowed": []any{"retry", "config_patch", "rollback", "upstream_wait"},
		},
		"validation":    map[string]any{"minimumEvidenceLevel": "static"},
		"approval":      map[string]any{"productionMutation": "required", "permission": "recovery.write"},
		"autonomyLevel": 1,
		"verification":  map[string]any{"kind": "generation_bound_terminal_success"},
		"recurrence":    map[string]any{"windowDays": 7},
	}
}

// derivedRecoveryEffects declares only effects visible in the generated DAG.
// Ambiguous writes are classified conservatively with unavailable
// idempotency; the compiler never upgrades them to autonomous recovery.
func derivedRecoveryEffects(document map[string]any) []any {
	nodes, _ := document["nodes"].([]any)
	effects := make([]any, 0)
	for _, item := range nodes {
		node, ok := item.(map[string]any)
		if !ok {
			continue
		}
		id, _ := node["id"].(string)
		typeName, _ := node["type"].(string)
		config, _ := node["config"].(map[string]any)
		kind, receipt, effect := recoveryEffectForNode(typeName, config)
		if id == "" || !effect {
			continue
		}
		effects = append(effects, map[string]any{
			"nodeId": id, "kind": kind, "idempotency": "unavailable", "receipt": receipt,
		})
	}
	return effects
}

func recoveryEffectForNode(typeName string, config map[string]any) (kind, receipt string, effect bool) {
	switch typeName {
	case "approval", "human_form":
		return "human_action", "manual", true
	case "http":
		method, _ := config["method"].(string)
		switch strings.ToUpper(strings.TrimSpace(method)) {
		case "POST", "PUT", "PATCH", "DELETE":
			return "external_write", "runtime", true
		}
	case "tool":
		toolName, _ := config["tool"].(string)
		if toolName == "email.send" || toolName == "slack.post" || toolName == "webhook.send" {
			return "notification", "runtime", true
		}
		if toolName == "db.query.write" || toolName == "db.query.transaction" ||
			toolName == "vector.upsert" || toolName == "github.create_issue" ||
			toolName == "pagerduty.incident.acknowledge" || toolName == "pagerduty.incident.snooze" ||
			strings.HasSuffix(toolName, ".write") || strings.HasSuffix(toolName, ".create") ||
			strings.HasSuffix(toolName, ".delete") || strings.HasSuffix(toolName, ".update") {
			return "external_write", "runtime", true
		}
	}
	return "", "", false
}
