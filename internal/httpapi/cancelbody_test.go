//go:build integration

package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"
)

func TestCancelAcceptsItsDeclaredBodyShapes(t *testing.T) {
	pool := testPool(t)
	fixture := newAPIHarness(t)
	newRun := func() string {
		t.Helper()
		id := fmt.Sprintf("run-cancel-%d", time.Now().UnixNano())
		if _, err := pool.Exec(context.Background(), `INSERT INTO runs
			(id, org_id, status, input_json, workflow_version_id)
			VALUES ($1, $2, 'running', '{}', 'wv-cancel')`, id, fixture.org); err != nil {
			t.Fatalf("seed run: %v", err)
		}
		return id
	}

	if res := fixture.call("POST", "/run/cancel", map[string]any{"runId": newRun()}, ""); res.status != http.StatusOK {
		t.Fatalf("cancel without reason: %d %+v", res.status, res.body)
	}
	if res := fixture.call("POST", "/run/cancel", map[string]any{
		"runId": newRun(), "reason": "superseded by a newer run",
	}, ""); res.status != http.StatusOK {
		t.Fatalf("cancel with text reason: %d %+v", res.status, res.body)
	}
	if res := fixture.call("POST", "/run/cancel", map[string]any{
		"runId": newRun(), "reason": map[string]any{"source": "ui"},
	}, ""); res.status != http.StatusBadRequest {
		t.Fatalf("cancel with object reason must fail: %d %+v", res.status, res.body)
	}
}
