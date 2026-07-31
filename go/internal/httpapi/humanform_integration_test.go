//go:build integration

package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/go/internal/resumetoken"
)

// The human_form loop end to end: the node pauses with a signed token in
// its waiting metadata, /resume enforces the token matrix + the schema,
// the validated input becomes the node output, downstream runs ONCE, and
// a concurrent token replay loses the CAS.
func TestHumanFormResumeLoop(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()

	startBody := map[string]any{"workflow": map[string]any{
		"id": "wf-form", "name": "Formulario", "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "form", "type": "human_form", "config": map[string]any{
				"title": "Datos",
				"schema": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"monto":  map[string]any{"type": "number"},
						"motivo": map[string]any{"type": "string"},
					},
					"required": []any{"monto"},
				},
			}},
			map[string]any{"id": "eco", "type": "transform", "config": map[string]any{
				"mapping": map[string]any{"monto": "{{context.form.output.monto}}"},
			}},
		},
		"edges": []any{map[string]any{"from": "form", "to": "eco"}},
	}}
	res := h.call("POST", "/v1/start", startBody, "")
	if res.status != 200 && res.status != 201 {
		t.Fatalf("start: %d %+v", res.status, res.body)
	}
	runID := extractRunID(t, res)

	// Wait for the pause + read the signed token from waiting metadata.
	token := waitFormToken(t, pool, ctx, runID, "form")

	// 1. Missing token → 400 with the reference code.
	res = h.call("POST", "/resume", map[string]any{
		"runId": runID, "nodeId": "form", "input": map[string]any{"monto": 5},
	}, "")
	if res.status != 400 || res.body["code"] != "runs_resume_token_required" {
		t.Fatalf("token required: %d %+v", res.status, res.body)
	}

	// 2. Cross-run token → uniform 403.
	foreign, _ := resumetoken.Sign(resumetoken.Binding{
		OrgID: h.org, RunID: "run-ajeno", NodeID: "form", Purpose: "human_form",
	}, 3600)
	res = h.call("POST", "/resume", map[string]any{
		"runId": runID, "nodeId": "form", "resumeToken": foreign,
		"input": map[string]any{"monto": 5},
	}, "")
	if res.status != 403 || res.body["code"] != "runs_invalid_resume_token" {
		t.Fatalf("foreign token: %d %+v", res.status, res.body)
	}

	// 3. Invalid input (missing required, wrong type) → 400 Node shape.
	for name, input := range map[string]map[string]any{
		"missing required": {"motivo": "x"},
		"wrong type":       {"monto": "mucho"},
	} {
		res = h.call("POST", "/resume", map[string]any{
			"runId": runID, "nodeId": "form", "resumeToken": token, "input": input,
		}, "")
		if res.status != 400 || res.body["code"] != "runs_input_validation_failed" {
			t.Fatalf("%s: %d %+v", name, res.status, res.body)
		}
	}

	// 4. Valid input completes the node with the input AS the output —
	// raced against a concurrent replay of the SAME token: exactly one
	// succeeds, the loser gets the CAS 409.
	input := map[string]any{"monto": float64(42), "motivo": "aprobado"}
	var wg sync.WaitGroup
	statuses := make([]int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := h.call("POST", "/resume", map[string]any{
				"runId": runID, "nodeId": "form", "resumeToken": token, "input": input,
			}, "")
			statuses[i] = r.status
		}()
	}
	wg.Wait()
	if !(statuses[0] == 200 && statuses[1] == 409) && !(statuses[0] == 409 && statuses[1] == 200) {
		t.Fatalf("race must yield exactly one winner: %v", statuses)
	}

	// A later replay of the token stays a 409 — no double-write.
	res = h.call("POST", "/resume", map[string]any{
		"runId": runID, "nodeId": "form", "resumeToken": token, "input": input,
	}, "")
	if res.status != 409 || res.body["code"] != "runs_resume_conflict" {
		t.Fatalf("replay must conflict: %d %+v", res.status, res.body)
	}

	// The run finishes; the form output is the validated input and the
	// downstream transform consumed it exactly once.
	h.waitRun(runID, "succeeded")
	var raw []byte
	_ = pool.QueryRow(ctx, `SELECT state_json FROM run_nodes WHERE run_id = $1 AND node_id = 'form'`, runID).Scan(&raw)
	var formState struct {
		Output map[string]any `json:"output"`
	}
	_ = json.Unmarshal(raw, &formState)
	if formState.Output["monto"] != float64(42) || formState.Output["motivo"] != "aprobado" {
		t.Fatalf("form output must be the validated input: %s", raw)
	}
	var downstream int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM run_nodes WHERE run_id = $1 AND node_id = 'eco' AND status = 'succeeded'`, runID).Scan(&downstream)
	if downstream != 1 {
		t.Fatalf("downstream must run exactly once: %d", downstream)
	}
	var ecoRaw []byte
	_ = pool.QueryRow(ctx, `SELECT state_json FROM run_nodes WHERE run_id = $1 AND node_id = 'eco'`, runID).Scan(&ecoRaw)
	var ecoState struct {
		Output map[string]any `json:"output"`
	}
	_ = json.Unmarshal(ecoRaw, &ecoState)
	if ecoState.Output["monto"] != float64(42) {
		t.Fatalf("downstream must read the form output: %s", ecoRaw)
	}
}

func extractRunID(t *testing.T, res apiResponse) string {
	t.Helper()
	if data, ok := res.body["data"].(map[string]any); ok {
		if id, ok := data["runId"].(string); ok {
			return id
		}
	}
	if id, ok := res.body["runId"].(string); ok {
		return id
	}
	t.Fatalf("no runId in response: %+v", res.body)
	return ""
}

func waitFormToken(t *testing.T, pool *pgxpool.Pool, ctx context.Context, runID, nodeID string) string {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		var raw []byte
		_ = pool.QueryRow(ctx, `SELECT state_json FROM run_nodes WHERE run_id = $1 AND node_id = $2 AND status = 'waiting'`, runID, nodeID).Scan(&raw)
		if len(raw) > 0 {
			var state struct {
				Waiting struct {
					ResumeToken string `json:"resumeToken"`
					Kind        string `json:"kind"`
				} `json:"waiting"`
			}
			_ = json.Unmarshal(raw, &state)
			if state.Waiting.ResumeToken != "" {
				if state.Waiting.Kind != "human_form" {
					t.Fatalf("waiting kind: %s", state.Waiting.Kind)
				}
				return state.Waiting.ResumeToken
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal(fmt.Sprintf("form node never paused with a token (run %s)", runID))
	return ""
}
