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
