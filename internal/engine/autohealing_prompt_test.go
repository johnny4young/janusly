package engine

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/store"
)

func TestAutoHealingEvidenceIsRedactedAndBounded(t *testing.T) {
	secret := "sk-ant-abcdefghijklmnopqrstuvwxyz123456"
	raw, err := json.Marshal(map[string]any{
		"authorization": "Bearer " + secret,
		"note":          secret + strings.Repeat(`\\\"`, healingNodePromptMaxBytes),
	})
	if err != nil {
		t.Fatal(err)
	}
	bounded := boundedHealingEvidence(raw, healingNodePromptMaxBytes)
	if strings.Contains(bounded, secret) || !strings.Contains(bounded, "[redacted]") {
		t.Fatalf("healing evidence leaked a secret: %s", bounded)
	}
	if len(bounded) > healingNodePromptMaxBytes {
		t.Fatalf("healing evidence exceeded cap: %d", len(bounded))
	}
	if !strings.Contains(bounded, `"__truncated":true`) {
		t.Fatalf("oversize evidence did not expose truncation: %s", bounded)
	}
}

func TestAutoHealingMalformedEvidenceUsesNonPreviewSentinel(t *testing.T) {
	opaque := `not-json private-token-that-does-not-match-a-known-secret-shape`
	bounded := boundedHealingEvidence(json.RawMessage(opaque), healingErrorPromptMaxBytes)
	if strings.Contains(bounded, opaque) || bounded != `{"unparseableEvidence":true}` {
		t.Fatalf("malformed evidence must not be forwarded opaquely: %s", bounded)
	}
}

func TestAutoHealingFreeTextUsesRuneBound(t *testing.T) {
	value := strings.Repeat("á", healingSignatureMaxRunes+10)
	bounded := boundedHealingText(value, healingSignatureMaxRunes)
	if !utf8.ValidString(bounded) || utf8.RuneCountInString(bounded) != healingSignatureMaxRunes {
		t.Fatalf("signature bound is not rune safe: bytes=%d runes=%d", len(bounded), utf8.RuneCountInString(bounded))
	}
}

func autoHealingTestRow(t *testing.T, node domain.Node) store.ListOpenDeadLettersForHealingRow {
	t.Helper()
	workflow, err := json.Marshal(map[string]any{
		"dslVersion": "1.0",
		"id":         "wf-healing-test",
		"name":       "Healing test",
		"nodes":      []any{node},
		"edges":      []any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	nodeJSON, err := json.Marshal(node)
	if err != nil {
		t.Fatal(err)
	}
	return store.ListOpenDeadLettersForHealingRow{
		NodeID: node.ID, WorkflowJson: workflow, NodeJson: nodeJSON,
	}
}

func TestAutoHealingCandidateIsKnownExternalReadSideOnly(t *testing.T) {
	cases := []struct {
		name string
		node domain.Node
		want bool
	}{
		{
			name: "read side http",
			node: domain.Node{ID: "call", Type: "http", Config: map[string]any{
				"url": "https://example.test/status", "method": "GET",
			}},
			want: true,
		},
		{
			name: "unknown http method is effect capable",
			node: domain.Node{ID: "call", Type: "http", Config: map[string]any{
				"url": "https://example.test/status", "method": "PROPFIND",
			}},
		},
		{
			name: "mutating http",
			node: domain.Node{ID: "call", Type: "http", Config: map[string]any{
				"url": "https://example.test/incidents", "method": "POST",
			}},
		},
		{
			name: "known external read tool",
			node: domain.Node{ID: "call", Type: "tool", Config: map[string]any{
				"tool": "pagerduty.incident.get", "input": map[string]any{
					"credential": "pagerduty-api", "requesterEmail": "operator@example.test", "incidentId": "P123",
				},
			}},
			want: true,
		},
		{
			name: "known write tool",
			node: domain.Node{ID: "call", Type: "tool", Config: map[string]any{
				"tool": "pagerduty.incident.acknowledge", "input": map[string]any{"incidentId": "P123"},
			}},
		},
		{
			name: "local tool",
			node: domain.Node{ID: "call", Type: "tool", Config: map[string]any{
				"tool": "json.pick", "input": map[string]any{},
			}},
		},
		{
			name: "unknown tool",
			node: domain.Node{ID: "call", Type: "tool", Config: map[string]any{
				"tool": "vendor.lookup", "input": map[string]any{},
			}},
		},
		{
			name: "mcp calls stay governed",
			node: domain.Node{ID: "call", Type: "mcp_tool", Config: map[string]any{
				"server": "ops", "tool": "inspect",
			}},
		},
		{
			name: "local transform",
			node: domain.Node{ID: "call", Type: "transform", Config: map[string]any{
				"expression": "context.input",
			}},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			row := autoHealingTestRow(t, tc.node)
			candidate, ok := autoHealingCandidateNode(row)
			if ok != tc.want {
				t.Fatalf("candidate eligibility = %v, want %v", ok, tc.want)
			}
			patch, _ := deterministicHealingPatch(tc.node)
			if (patch != nil) != tc.want {
				t.Fatalf("deterministic patch = %#v, want eligible %v", patch, tc.want)
			}
			if ok && candidate.ID != tc.node.ID {
				t.Fatalf("candidate node = %#v", candidate)
			}
		})
	}
}

func TestAutoHealingCandidateUsesWorkflowSnapshotAsAuthority(t *testing.T) {
	node := domain.Node{ID: "call", Type: "http", Config: map[string]any{
		"url": "https://example.test/status", "method": "GET",
	}}
	row := autoHealingTestRow(t, node)
	row.NodeJson = json.RawMessage(`{"id":"call","type":"http","config":{"url":"https://attacker.test","method":"POST"}}`)
	candidate, ok := autoHealingCandidateNode(row)
	if !ok || candidate.Config["url"] != "https://example.test/status" || candidate.Config["method"] != "GET" {
		t.Fatalf("separate node snapshot became authority: ok=%v node=%#v", ok, candidate)
	}
}

func TestProjectHealingPatchAcceptsOnlyBoundedRetryAndHTTPTimeout(t *testing.T) {
	httpNode := domain.Node{ID: "call", Type: "http", Config: map[string]any{
		"url": "https://example.test/status", "method": "GET",
	}}
	input := map[string]any{
		"retry": map[string]any{
			"maxAttempts": float64(4), "delayMs": float64(500), "maxDelayMs": float64(5000),
			"backoff": "exponential", "jitter": true,
			"retryOn": []any{"timeout", "5xx"}, "ignoreOn": []any{"404"},
		},
		"timeoutMs": float64(8000),
	}
	projected := projectHealingPatch(httpNode, input)
	if !reflect.DeepEqual(projected, input) {
		t.Fatalf("safe patch changed: got %#v want %#v", projected, input)
	}

	unsafe := []map[string]any{
		{"url": "https://attacker.test", "retry": map[string]any{"maxAttempts": float64(3)}},
		{"retry": map[string]any{"maxAttempts": float64(3), "credential": "ops"}},
		{"retry": map[string]any{"maxAttempts": float64(1)}},
		{"retry": map[string]any{"maxAttempts": float64(3.5)}},
		{"retry": map[string]any{"maxAttempts": float64(3), "delayMs": float64(0)}},
		{"retry": map[string]any{"maxAttempts": float64(3), "delayMs": float64(2000), "maxDelayMs": float64(1000)}},
		{"retry": map[string]any{"maxAttempts": float64(3), "backoff": "quadratic"}},
		{"retry": map[string]any{"maxAttempts": float64(3), "retryOn": []any{strings.Repeat("x", 65)}}},
		{"retry": map[string]any{"maxAttempts": float64(3), "retryOn": []any{"sk-ant-abcdefghijklmnopqrstuvwxyz123456"}}},
		{"timeoutMs": float64(600001)},
	}
	for index, patch := range unsafe {
		if got := projectHealingPatch(httpNode, patch); got != nil {
			t.Fatalf("unsafe patch %d accepted: %#v", index, got)
		}
	}

	toolNode := domain.Node{ID: "lookup", Type: "tool", Config: map[string]any{
		"tool": "pagerduty.incident.get", "input": map[string]any{"incidentId": "P123"},
	}}
	if got := projectHealingPatch(toolNode, map[string]any{"timeoutMs": float64(5000)}); got != nil {
		t.Fatalf("meaningless tool timeout accepted: %#v", got)
	}
}

func TestDeterministicHealingPatchPreservesValidRetryIntent(t *testing.T) {
	node := domain.Node{ID: "call", Type: "http", Config: map[string]any{
		"url": "https://example.test/status", "method": "GET", "timeoutMs": float64(4000),
		"retry": map[string]any{
			"maxAttempts": float64(5), "delayMs": float64(250), "maxDelayMs": float64(3000),
			"backoff": "fixed", "jitter": true, "retryOn": []any{"timeout"},
		},
	}}
	patch, label := deterministicHealingPatch(node)
	if label != "harden_retries" || patch["timeoutMs"] != float64(8000) {
		t.Fatalf("deterministic patch header: label=%q patch=%#v", label, patch)
	}
	retry := patch["retry"].(map[string]any)
	if retry["maxAttempts"] != float64(5) || retry["delayMs"] != float64(250) ||
		retry["maxDelayMs"] != float64(3000) || retry["backoff"] != "fixed" ||
		retry["jitter"] != true || !reflect.DeepEqual(retry["retryOn"], []any{"timeout"}) {
		t.Fatalf("valid retry intent was not preserved: %#v", retry)
	}
}

func TestApplyHealingPatchCannotMutateDestinationOrEffect(t *testing.T) {
	node := domain.Node{ID: "call", Type: "http", Config: map[string]any{
		"url": "https://example.test/status", "method": "GET",
	}}
	row := autoHealingTestRow(t, node)
	if fixed := applyHealingPatch(row.WorkflowJson, row.NodeID, map[string]any{
		"url": "https://attacker.test", "method": "POST",
		"retry": map[string]any{"maxAttempts": float64(3)},
	}); fixed != nil {
		t.Fatalf("authority-changing patch applied: %s", fixed)
	}

	fixed := applyHealingPatch(row.WorkflowJson, row.NodeID, map[string]any{
		"retry":     map[string]any{"maxAttempts": float64(3), "delayMs": float64(1000)},
		"timeoutMs": float64(5000),
	})
	if fixed == nil {
		t.Fatal("safe patch was rejected")
	}
	wf, _ := domain.Parse(fixed)
	if wf == nil || wf.Nodes[0].Config["url"] != "https://example.test/status" || wf.Nodes[0].Config["method"] != "GET" {
		t.Fatalf("safe patch changed destination/effect: %s", fixed)
	}
}
