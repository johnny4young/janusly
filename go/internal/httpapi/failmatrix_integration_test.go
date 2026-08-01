//go:build integration

package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/johnny4young/janusly/go/internal/recovery/failmatrix"
)

// The recovery failure matrix: one shared catalog drives every hostile
// case across the replay / cluster-apply / validate-fix / items / queue
// surfaces — a new failure mode lands everywhere by adding one entry.
func TestRecoveryFailureMatrix(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	suffix := fmt.Sprint(time.Now().UnixNano())

	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer broken.Close()
	workflowDoc := map[string]any{
		"id": "wf-matrix-" + suffix, "name": "Matrix", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "call", "type": "http", "config": map[string]any{
			"url": broken.URL, "timeoutMs": 500,
		}}},
		"edges": []any{},
	}
	runFailing := func() (string, string) {
		res := h.call("POST", "/v1/start", map[string]any{"workflow": workflowDoc}, "")
		runID := extractRunID(t, res)
		h.waitRun(runID, "failed")
		var dlqID string
		_ = pool.QueryRow(ctx, `SELECT id FROM dead_letters WHERE run_id = $1 ORDER BY created_at DESC LIMIT 1`,
			runID).Scan(&dlqID)
		return runID, dlqID
	}

	// Seed the environment the catalog cases reference.
	_, openDLQ := runFailing()
	claimedRun, claimedDLQ := runFailing()
	if res := h.call("POST", "/dlq/replay", map[string]any{"deadLetterId": claimedDLQ}, ""); res.status != 200 {
		t.Fatalf("seed replay: %d", res.status)
	}
	h.waitRun(claimedRun, "failed")
	var itemID string
	_ = pool.QueryRow(ctx, `SELECT id FROM recovery_items WHERE org_id = $1 AND dead_letter_id = $2`,
		h.org, claimedDLQ).Scan(&itemID)
	if res := h.call("POST", "/recovery/items/"+itemID+"/acknowledge", map[string]any{"owner": "op"}, ""); res.status != 200 {
		t.Fatalf("seed acknowledge: %d", res.status)
	}
	res := h.call("GET", "/dlq/clusters", nil, "")
	signature := res.body["clusters"].([]any)[0].(map[string]any)["signature"].(string)

	env := failmatrix.Env{
		OpenDeadLetterID:    openDLQ,
		ClaimedDeadLetterID: claimedDLQ,
		AcknowledgedItemID:  itemID,
		ClusterSignature:    signature,
		WorkflowDoc:         workflowDoc,
	}
	for _, matrixCase := range failmatrix.Catalog() {
		t.Run(matrixCase.Surface+"/"+matrixCase.Name, func(t *testing.T) {
			var body any
			if matrixCase.Body != nil {
				body = matrixCase.Body(env)
			}
			res := h.call(matrixCase.Method, matrixCase.Path(env), body, "")
			if res.status != matrixCase.WantStatus {
				t.Fatalf("status: want %d got %d (%+v)", matrixCase.WantStatus, res.status, res.body)
			}
			if matrixCase.WantCode != "" && res.body["code"] != matrixCase.WantCode {
				t.Fatalf("code: want %s got %+v", matrixCase.WantCode, res.body)
			}
			if matrixCase.WantStatus == 200 && matrixCase.WantFailed > 0 {
				if res.body["failed"] != float64(matrixCase.WantFailed) {
					t.Fatalf("partial envelope: want failed=%d got %+v", matrixCase.WantFailed, res.body)
				}
			}
		})
	}
}
