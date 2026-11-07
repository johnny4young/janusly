//go:build integration

package httpapi

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

// A run whose document reuses another organization's workflow id must not
// show that organization's workflow name in the runs list.
func TestRunListNeverShowsAnotherOrganizationsWorkflowName(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	suffix := fmt.Sprint(time.Now().UnixNano())
	foreignOrg := "foreign-" + suffix
	sharedID := "shared-wf-" + suffix
	foreign := map[string]any{"id": sharedID, "name": "Foreign Payroll " + suffix, "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "n", "type": "noop", "config": map[string]any{}}}, "edges": []any{}}
	if res := h.call("POST", "/workflows/save", foreign, foreignOrg); res.status != 200 {
		t.Fatalf("foreign save: %d %v", res.status, res.body)
	}
	mine := map[string]any{"id": sharedID, "name": "Mine " + suffix, "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "n", "type": "noop", "config": map[string]any{}}}, "edges": []any{}}
	started := h.call("POST", "/v1/start", map[string]any{"workflow": mine}, "")
	if started.status != 200 && started.status != 202 {
		t.Fatalf("ad-hoc start: %d %v", started.status, started.body)
	}
	runID := started.body["data"].(map[string]any)["runId"].(string)

	for _, path := range []string{"/v1/runs?limit=100", "/runs?limit=100"} {
		res, raw := h.rawGet(t, path)
		if res.StatusCode != 200 {
			t.Fatalf("%s: %d %s", path, res.StatusCode, raw)
		}
		var rows []map[string]any
		var envelope struct {
			Data []map[string]any `json:"data"`
		}
		if err := json.Unmarshal(raw, &envelope); err == nil && envelope.Data != nil {
			rows = envelope.Data
		} else if err := json.Unmarshal(raw, &rows); err != nil {
			t.Fatalf("%s: unexpected body %s", path, raw)
		}
		var name *string
		for _, row := range rows {
			if row["id"] == runID {
				value := fmt.Sprint(row["workflowName"])
				name = &value
			}
		}
		switch {
		case name == nil:
			t.Fatalf("%s lost the run: %s", path, raw)
		case strings.Contains(*name, "Foreign Payroll"):
			t.Fatalf("%s leaked another organization's workflow name: %q", path, *name)
		case *name != "Mine "+suffix:
			t.Fatalf("%s: workflowName = %q, want the run's own document name", path, *name)
		}
	}
}
