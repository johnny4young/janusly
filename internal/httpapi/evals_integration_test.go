//go:build integration

package httpapi

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// The regression-bed loop: only accepted + opted-in feedback becomes an
// example (consent gate), the snapshot is immutable, exports re-scrub,
// and an experiment runs recommendation-only over the dataset even with
// no LLM configured ($0 deterministic completion).
func TestEvalDatasetsAndExperiments(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	suffix := fmt.Sprint(time.Now().UnixNano())

	seedFeedback := func(id string, accepted, consent bool, comment string) {
		if _, err := pool.Exec(ctx,
			`INSERT INTO recovery_feedback (id, org_id, user_id, dead_letter_id, workflow_id,
			   suggestion_mode, approach_label, accepted, eval_consent, comment)
			 VALUES ($1, $2, 'u1', 'dl-'||$1, 'wf-evals-`+suffix+`', 'ai', 'harden_retries', $3, $4, $5)`,
			id, h.org, accepted, consent, comment); err != nil {
			t.Fatalf("seed feedback: %v", err)
		}
	}
	seedFeedback("fb-1-"+suffix, true, true, "timeout con la pasarela; token sk-abcdefghijklmnopqrstuvwxyz0123456789")
	seedFeedback("fb-2-"+suffix, true, false, "aceptado pero SIN consent")
	seedFeedback("fb-3-"+suffix, false, true, "consent pero rechazado")

	// Create: only the consented + accepted row lands.
	res := h.call("POST", "/eval/datasets", map[string]any{"name": "bed-" + suffix}, "")
	if res.status != 201 {
		t.Fatalf("create dataset: %d %+v", res.status, res.body)
	}
	dataset := res.body["dataset"].(map[string]any)
	datasetID := dataset["id"].(string)
	if dataset["exampleCount"] != float64(1) {
		t.Fatalf("consent gate: %+v", dataset)
	}
	// Duplicate name → 409.
	if res = h.call("POST", "/eval/datasets", map[string]any{"name": "bed-" + suffix}, ""); res.status != 409 {
		t.Fatalf("duplicate name must 409: %d", res.status)
	}

	// The example's input context is scrubbed at write AND read.
	res = h.call("GET", "/eval/datasets/"+datasetID, nil, "")
	examples := res.body["examples"].([]any)
	if len(examples) != 1 {
		t.Fatalf("examples: %+v", res.body)
	}
	inputContext := examples[0].(map[string]any)["inputContext"].(string)
	if strings.Contains(inputContext, "sk-abcdefghijklmnop") || !strings.Contains(inputContext, "[redacted]") {
		t.Fatalf("input context must be scrubbed: %s", inputContext)
	}

	// Export in both formats.
	if res = h.call("GET", "/eval/datasets/"+datasetID+"/export?format=jsonl", nil, ""); res.status != 200 {
		t.Fatalf("jsonl export: %d", res.status)
	}
	if res = h.call("GET", "/eval/datasets/"+datasetID+"/export?format=yaml", nil, ""); res.status != 400 {
		t.Fatalf("unknown format must 400: %d", res.status)
	}

	// Experiment over the dataset: no LLM configured → deterministic $0
	// completion, recommendation-only, summary persisted.
	res = h.call("POST", "/experiments/run", map[string]any{
		"name": "exp-" + suffix, "kind": "model",
		"controlRef": "claude-haiku-4-5", "candidateRef": "claude-sonnet-5",
		"evalDatasetId": datasetID, "scorerKind": "string_equality",
	}, "")
	if res.status != 200 {
		t.Fatalf("run experiment: %d %+v", res.status, res.body)
	}
	if _, ok := res.body["experiment"].(map[string]any); !ok {
		t.Fatalf("run response must return the completed experiment: %+v", res.body)
	}
	plan, _ := res.body["plan"].(map[string]any)
	if plan["providerCallEstimate"] != float64(2) || plan["maxProviderCalls"] != float64(20) {
		t.Fatalf("run response must expose its admitted call plan: %+v", plan)
	}
	summary := res.body["summary"].(map[string]any)
	if summary["exampleCount"] != float64(1) || summary["recommendation"] != "keep_control" {
		t.Fatalf("no-client experiment: %+v", summary)
	}
	experimentID := res.body["experimentId"].(string)
	res = h.call("GET", "/experiments/"+experimentID, nil, "")
	if res.status != 200 || res.body["experiment"].(map[string]any)["status"] != "completed" {
		t.Fatalf("experiment persisted: %d %+v", res.status, res.body)
	}
	var audits int
	_ = pool.QueryRow(ctx,
		`SELECT count(*) FROM audit_logs WHERE org_id = $1 AND action IN ('experiment.run.started','experiment.run.completed')`,
		h.org).Scan(&audits)
	if audits != 2 {
		t.Fatalf("experiment audits: %d", audits)
	}

	// Prompt experiments resolve real PromptOps references instead of
	// sending names such as triage@1 as literal system instructions.
	for _, name := range []string{"eval-control-" + suffix, "eval-candidate-" + suffix} {
		if created := h.call("POST", "/prompts", map[string]any{"name": name}, ""); created.status != 201 {
			t.Fatalf("create prompt %s: %d %+v", name, created.status, created.body)
		}
		if version := h.call("POST", "/prompts/"+name+"/versions", map[string]any{
			"templateText": "Classify this recovery outcome precisely.",
		}, ""); version.status != 201 {
			t.Fatalf("create prompt version %s: %d %+v", name, version.status, version.body)
		}
	}
	res = h.call("POST", "/experiments/run", map[string]any{
		"name": "prompt-exp-" + suffix, "kind": "prompt",
		"controlRef":    "eval-control-" + suffix + "@1",
		"candidateRef":  "eval-candidate-" + suffix + "@1",
		"evalDatasetId": datasetID, "scorerKind": "string_equality",
	}, "")
	if res.status != 200 {
		t.Fatalf("prompt refs must resolve: %d %+v", res.status, res.body)
	}
	res = h.call("POST", "/experiments/run", map[string]any{
		"name": "bad-prompt-exp-" + suffix, "kind": "prompt",
		"controlRef": "missing@1", "candidateRef": "also-missing@1",
		"evalDatasetId": datasetID, "scorerKind": "string_equality",
	}, "")
	if res.status != 422 || res.body["code"] != "experiment_prompt_ref_invalid" {
		t.Fatalf("unknown prompt refs must fail before provider work: %d %+v", res.status, res.body)
	}

	// Hard delete removes dataset + examples.
	if res = h.call("DELETE", "/eval/datasets/"+datasetID, nil, ""); res.status != 200 {
		t.Fatalf("delete dataset: %d", res.status)
	}
	var remaining int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM eval_examples WHERE dataset_id = $1`, datasetID).Scan(&remaining)
	if remaining != 0 {
		t.Fatalf("examples must delete with the dataset: %d", remaining)
	}
}

func TestExperimentAdmissionRejectsEmptyAndOversizedPlans(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	suffix := fmt.Sprint(time.Now().UnixNano())

	empty := h.call("POST", "/eval/datasets", map[string]any{"name": "empty-" + suffix}, "")
	if empty.status != 201 {
		t.Fatalf("create empty dataset: %d %+v", empty.status, empty.body)
	}
	emptyID := empty.body["dataset"].(map[string]any)["id"].(string)
	res := h.call("POST", "/experiments/run", map[string]any{
		"name": "empty", "kind": "model", "controlRef": "a", "candidateRef": "b",
		"evalDatasetId": emptyID, "scorerKind": "string_equality",
	}, "")
	if res.status != 422 || res.body["code"] != "experiment_dataset_empty" {
		t.Fatalf("empty dataset must be rejected: %d %+v", res.status, res.body)
	}

	workflowID := "wf-eval-limit-" + suffix
	for index := range 6 {
		id := fmt.Sprintf("fb-limit-%s-%d", suffix, index)
		if _, err := pool.Exec(ctx, `INSERT INTO recovery_feedback
			(id, org_id, user_id, dead_letter_id, workflow_id, suggestion_mode,
			 approach_label, accepted, eval_consent, comment)
			VALUES ($1, $2, 'u1', 'dl-'||$1, $3, 'fallback', 'retry', true, true, 'timeout')`,
			id, h.org, workflowID); err != nil {
			t.Fatalf("seed capped feedback: %v", err)
		}
	}
	large := h.call("POST", "/eval/datasets", map[string]any{
		"name": "large-" + suffix, "workflowId": workflowID,
	}, "")
	if large.status != 201 {
		t.Fatalf("create large dataset: %d %+v", large.status, large.body)
	}
	largeID := large.body["dataset"].(map[string]any)["id"].(string)
	res = h.call("POST", "/experiments/run", map[string]any{
		"name": "too-many-calls", "kind": "model", "controlRef": "a", "candidateRef": "b",
		"evalDatasetId": largeID, "scorerKind": "llm_judge",
	}, "")
	if res.status != 422 || res.body["code"] != "experiment_call_limit_exceeded" {
		t.Fatalf("24-call plan must be rejected: %d %+v", res.status, res.body)
	}
	params, _ := res.body["params"].(map[string]any)
	if params["providerCallEstimate"] != float64(24) || params["maxProviderCalls"] != float64(20) {
		t.Fatalf("limit envelope: %+v", res.body)
	}

	// A monthly block policy is enforced before an experiment row or provider
	// call is started.
	budgetWorkflowID := "wf-eval-budget-" + suffix
	budgetFeedbackID := "fb-budget-" + suffix
	if _, err := pool.Exec(ctx, `INSERT INTO recovery_feedback
		(id, org_id, user_id, dead_letter_id, workflow_id, suggestion_mode,
		 approach_label, accepted, eval_consent, comment)
		VALUES ($1, $2, 'u1', 'dl-'||$1, $3, 'fallback', 'retry', true, true, 'timeout')`,
		budgetFeedbackID, h.org, budgetWorkflowID); err != nil {
		t.Fatalf("seed budget feedback: %v", err)
	}
	budgetDataset := h.call("POST", "/eval/datasets", map[string]any{
		"name": "budget-" + suffix, "workflowId": budgetWorkflowID,
	}, "")
	budgetDatasetID := budgetDataset.body["dataset"].(map[string]any)["id"].(string)
	for key, value := range map[string]string{
		"ai.budgetMonthlyUsd":     "1",
		"ai.budgetExceededPolicy": `"block"`,
	} {
		if _, err := pool.Exec(ctx, `INSERT INTO org_configs
			(id, org_id, key, value_json, category, description, value_type)
			VALUES ($1, $2, $3, $4, 'ai', 'test', CASE WHEN $3 = 'ai.budgetMonthlyUsd' THEN 'number' ELSE 'string' END)
			ON CONFLICT (org_id, key) DO UPDATE SET value_json = EXCLUDED.value_json`,
			h.org+"-"+key, h.org, key, value); err != nil {
			t.Fatalf("seed budget config %s: %v", key, err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO usage_events (id, org_id, metric, quantity, metadata)
		VALUES ($1, $2, 'llm.completion', 1, '{"costUsd":1}')`, "usage-budget-"+suffix, h.org); err != nil {
		t.Fatalf("seed budget spend: %v", err)
	}
	res = h.call("POST", "/experiments/run", map[string]any{
		"name": "budget-blocked", "kind": "model", "controlRef": "a", "candidateRef": "b",
		"evalDatasetId": budgetDatasetID, "scorerKind": "string_equality",
	}, "")
	if res.status != 402 || res.body["code"] != "budget_exceeded" {
		t.Fatalf("blocked AI budget must reject the run: %d %+v", res.status, res.body)
	}
}
