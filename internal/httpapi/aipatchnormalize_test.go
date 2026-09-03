package httpapi

import (
	"reflect"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/domain"
)

// The engine reads only the canonical retry/timeout keys; a model patch
// whose intent was "add backoff and a longer timeout" must not validate
// while silently dropping both.
func TestNormalizePatchedConfigMapsModelAliases(t *testing.T) {
	config := map[string]any{
		"url":     "http://127.0.0.1:39777/feed",
		"timeout": float64(30000),
		"retry": map[string]any{
			"maxAttempts":       float64(3),
			"initialDelayMs":    float64(1000),
			"backoffMultiplier": float64(2),
		},
	}
	normalizePatchedConfig(config)

	if config["timeoutMs"] != float64(30000) {
		t.Fatalf("timeout must become timeoutMs: %+v", config)
	}
	if _, stale := config["timeout"]; stale {
		t.Fatal("the alias must be consumed, not left behind")
	}
	retry := config["retry"].(map[string]any)
	want := map[string]any{
		"maxAttempts": float64(3),
		"delayMs":     float64(1000),
		"backoff":     "exponential",
	}
	if !reflect.DeepEqual(retry, want) {
		t.Fatalf("retry aliases must map onto the engine schema:\n got %+v\nwant %+v", retry, want)
	}
}

func TestPatchSuggestionMetadataMatchesRecoveryContract(t *testing.T) {
	if got := confidencePercentField(map[string]any{"confidence": 0.874}, "confidence"); got != 87 {
		t.Fatalf("model confidence must become integer percentage points: %v", got)
	}
	if got := normalizedPatchApproachLabel(map[string]any{"approachLabel": "fix_url"}, false); got != "fix_url" {
		t.Fatalf("canonical label changed: %q", got)
	}
	if got := normalizedPatchApproachLabel(map[string]any{"approachLabel": "provider_invented"}, false); got != "other" {
		t.Fatalf("unknown label must not poison feedback dimensions: %q", got)
	}
	if got := normalizedPatchApproachLabel(map[string]any{"approachLabel": "other"}, true); got != "add_approval" {
		t.Fatalf("structural approval must have the canonical label: %q", got)
	}
}

func TestStructuralPatchBoundsAndScrubsApprovalMessage(t *testing.T) {
	secret := "sk-ant-abcdefghijklmnopqrstuvwxyz123456"
	original := &domain.Workflow{
		DSLVersion: "1.0",
		Nodes: []domain.Node{
			{ID: "start", Type: "noop", Config: map[string]any{}},
			{ID: "write", Type: "http", Config: map[string]any{"url": "https://example.test", "method": "POST"}},
		},
		Edges: []domain.Edge{{From: "start", To: "write"}},
	}
	patched := applyPatchSuggestion(original, "write", map[string]any{
		"action":             "insert_approval_upstream",
		"approvalNodeId":     "approve_write",
		"insertBeforeNodeId": "write",
		"approvalMessage":    secret + "\n" + strings.Repeat("界", 900),
	}, true)
	if patched == nil {
		t.Fatal("valid structural suggestion was rejected")
	}
	message, _ := patched.Nodes[2].Config["message"].(string)
	if strings.Contains(message, secret) || strings.Contains(message, "\n") || len([]rune(message)) > 800 {
		t.Fatalf("approval message must be scrubbed, flattened and bounded: %q", message)
	}
}

func TestStructuralPatchCoversEveryRegistryClassifiedWrite(t *testing.T) {
	writeClassifier := domain.ReadinessOptions{
		IsWriteSideTool: func(name string, _ map[string]any) bool {
			return name == "pagerduty.incident.acknowledge"
		},
	}
	workflow := &domain.Workflow{
		DSLVersion: "1.0",
		Nodes: []domain.Node{
			{ID: "start", Type: "noop", Config: map[string]any{}},
			{ID: "write", Type: "tool", Config: map[string]any{
				"tool": "pagerduty.incident.acknowledge", "input": map[string]any{},
			}},
		},
		Edges: []domain.Edge{{From: "start", To: "write"}},
	}
	if !requiresStructuralPatch(workflow, "write", writeClassifier) {
		t.Fatal("registry-classified integration write must receive an approval patch")
	}
	workflow.Nodes = append(workflow.Nodes, domain.Node{
		ID: "approve", Type: "approval", Config: map[string]any{},
	})
	workflow.Edges = []domain.Edge{{From: "approve", To: "write"}}
	if requiresStructuralPatch(workflow, "write", writeClassifier) {
		t.Fatal("dominating approval must suppress a redundant structural patch")
	}
	agent := &domain.Workflow{
		DSLVersion: "1.0",
		Nodes:      []domain.Node{{ID: "agent", Type: "agent", Config: map[string]any{"allowWriteTools": true}}},
	}
	if !requiresStructuralPatch(agent, "agent", writeClassifier) {
		t.Fatal("write-enabled agent must use the same structural approval posture")
	}
}

// Canonical keys always win over aliases, and a multiplier of one is
// fixed backoff, not exponential.
func TestNormalizePatchedConfigNeverOverridesCanonicalKeys(t *testing.T) {
	config := map[string]any{
		"timeoutMs": float64(5000),
		"timeout":   float64(99999),
		"retry": map[string]any{
			"maxAttempts":       float64(2),
			"maxRetries":        float64(9),
			"delayMs":           float64(250),
			"initialDelayMs":    float64(8888),
			"backoff":           "fixed",
			"backoffMultiplier": float64(4),
		},
	}
	normalizePatchedConfig(config)
	if config["timeoutMs"] != float64(5000) {
		t.Fatalf("canonical timeoutMs must win: %+v", config)
	}
	retry := config["retry"].(map[string]any)
	if retry["maxAttempts"] != float64(2) || retry["delayMs"] != float64(250) || retry["backoff"] != "fixed" {
		t.Fatalf("canonical retry keys must win: %+v", retry)
	}
	for _, alias := range []string{"maxRetries", "initialDelayMs", "backoffMultiplier"} {
		if _, stale := retry[alias]; stale {
			t.Fatalf("alias %s must be consumed: %+v", alias, retry)
		}
	}

	// No retry block and a fixed multiplier: nothing to do, nothing broken.
	flat := map[string]any{"url": "https://example.test"}
	normalizePatchedConfig(flat)
	if !reflect.DeepEqual(flat, map[string]any{"url": "https://example.test"}) {
		t.Fatalf("configs without aliases must pass through untouched: %+v", flat)
	}
	single := map[string]any{"retry": map[string]any{"backoffMultiplier": float64(1)}}
	normalizePatchedConfig(single)
	if single["retry"].(map[string]any)["backoff"] != "fixed" {
		t.Fatalf("multiplier of one is fixed backoff: %+v", single)
	}
}
