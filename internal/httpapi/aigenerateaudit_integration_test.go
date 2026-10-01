//go:build integration

package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestGenerateWorkflowAuditDiagnostics(t *testing.T) {
	const valid = `{"dslVersion":"1.0","id":"audit-draft","name":"PRIVATE_MODEL_DRAFT","nodes":[{"id":"done","type":"noop","config":{}}],"edges":[]}`
	const broken = `{"dslVersion":"1.0","id":"audit-draft","name":"PRIVATE_MODEL_DRAFT","nodes":[{"id":"done","type":"noop","config":{}}],"edges":[{"from":"done","to":"ghost"}]}`
	for _, tc := range []struct {
		name            string
		replies         []string
		providerFailure bool
		wantMode        string
		wantRepair      bool
	}{
		{name: "clean", replies: []string{valid}, wantMode: "ai"},
		{name: "repaired", replies: []string{broken, valid}, wantMode: "ai", wantRepair: true},
		{name: "repair exhausted", replies: []string{broken}, wantMode: "fallback", wantRepair: true},
		{name: "provider failure", providerFailure: true, wantMode: "fallback"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				index := int(calls.Add(1)) - 1
				w.Header().Set("Content-Type", "application/json")
				if tc.providerFailure {
					w.WriteHeader(http.StatusInternalServerError)
					_, _ = fmt.Fprint(w, `{"error":{"type":"api_error","message":"simulated provider failure"}}`)
					return
				}
				_, _ = fmt.Fprint(w, anthropicReply(tc.replies[min(index, len(tc.replies)-1)]))
			}))
			t.Cleanup(provider.Close)
			t.Setenv("ANTHROPIC_API_KEY", "test-key")
			t.Setenv("JANUSLY_LOCAL_STACK", "true")
			t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
			t.Setenv("JANUSLY_LLM_SIMULATED_PROVIDERS", "anthropic")
			t.Setenv("JANUSLY_LLM_SIMULATOR_BASE_URL", provider.URL)
			h := newAPIHarnessWithoutWorkers(t)
			pool := testPool(t)
			response := h.call("POST", "/ai/generate-workflow", map[string]any{"prompt": "PRIVATE_OPERATOR_PROMPT: create a single noop workflow"}, "")
			if response.status != http.StatusOK || response.body["mode"] != tc.wantMode {
				t.Fatalf("generation: %d %#v", response.status, response.body)
			}
			var raw []byte
			if err := pool.QueryRow(t.Context(), `SELECT metadata FROM audit_logs WHERE org_id=$1 AND action='ai.workflow.generated'`, h.org).Scan(&raw); err != nil {
				t.Fatal(err)
			}
			var metadata map[string]any
			if err := json.Unmarshal(raw, &metadata); err != nil {
				t.Fatal(err)
			}
			codes, hasCodes := metadata["repairIssueCodes"].([]any)
			if hasCodes != tc.wantRepair || (hasCodes && (len(codes) == 0 || len(codes) > auditIssueCodeLimit)) {
				t.Fatalf("first-draft diagnostics missing or unbounded: %#v", metadata)
			}
			logicalCalls := calls.Load()
			// SDK transport retries are not additional generation calls.
			if tc.providerFailure {
				logicalCalls = 1
			}
			if calls.Load() == 0 || metadata["mode"] != tc.wantMode || metadata["modelCallCount"] != float64(logicalCalls) {
				t.Fatalf("audit counters mismatch: calls=%d metadata=%#v", calls.Load(), metadata)
			}
			for _, forbidden := range []string{"PRIVATE_OPERATOR_PROMPT", "PRIVATE_MODEL_DRAFT", "test-key"} {
				if strings.Contains(string(raw), forbidden) {
					t.Fatalf("private request/draft leaked into audit: %s", forbidden)
				}
			}
			if tc.wantMode == "ai" {
				if _, present := metadata["validationIssueCodes"]; present {
					t.Fatal("success must not acquire fallback's final diagnostics")
				}
			}
			own := h.call("GET", "/audit?action=ai.workflow.generated", nil, "")
			other := h.call("GET", "/audit?action=ai.workflow.generated", nil, h.org+"-other")
			if own.status != 200 || other.status != 200 {
				t.Fatalf("audit read failed: own=%d other=%d", own.status, other.status)
			}
			ownRows, _ := own.body["rows"].([]any)
			otherRows, _ := other.body["rows"].([]any)
			if len(ownRows) != 1 || len(otherRows) != 0 {
				t.Fatalf("tenant audit isolation: own=%#v other=%#v", own.body, other.body)
			}
		})
	}
}
