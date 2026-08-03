package executors

import (
	"context"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/tools"
)

// The stable agent.reasoning contract: reference caps (120/160/160/500
// runes), control/invisible characters flattened, secrets scrubbed,
// replacesEventId pointing at the exact step.planned event, and tool nil
// on a finish decision.
func TestAgentReasoningContract(t *testing.T) {
	registry := tools.NewRegistry()
	exec := NewAgentExecutor(registry, nil)

	type event struct {
		ID      string
		Type    string
		Payload map[string]any
	}
	var events []event
	nextID := 0
	emit := func(eventType string, payload map[string]any) string {
		nextID++
		id := "evt-" + strings.Repeat("x", nextID)
		events = append(events, event{ID: id, Type: eventType, Payload: payload})
		return id
	}

	longName := strings.Repeat("n", 300)
	_, err := exec(context.Background(), Input{
		Config: map[string]any{
			"name": longName, "goal": "uppercase the value",
			"value": "hola", "maxSteps": float64(1),
		},
		Context: map[string]any{},
		Emit:    emit,
	})
	if err != nil {
		t.Fatalf("agent run: %v", err)
	}

	var reasoning []event
	plannedIDs := map[string]bool{}
	for _, entry := range events {
		if entry.Type == "agent.reasoning" {
			reasoning = append(reasoning, entry)
		}
		if entry.Type == "agent.step.planned" {
			plannedIDs[entry.ID] = true
		}
	}
	if len(reasoning) == 0 {
		t.Fatal("agent.reasoning must emit")
	}
	payload := reasoning[0].Payload

	agentField := payload["agent"].(string)
	if len([]rune(agentField)) != 120 {
		t.Fatalf("agent cap must be 120 runes: %d", len([]rune(agentField)))
	}
	if payload["scope"] != "agent" {
		t.Fatalf("scope: %v", payload["scope"])
	}
	replaces, _ := payload["replacesEventId"].(string)
	if !plannedIDs[replaces] {
		t.Fatalf("replacesEventId must carry the exact step.planned id: %q", replaces)
	}
	if payload["decision"] == "use_tool" && payload["tool"] == nil {
		t.Fatal("use_tool must carry a tool name")
	}

	// A pick-goal agent finishes on step one: tool must be JSON null.
	events = nil
	_, err = exec(context.Background(), Input{
		Config: map[string]any{
			"goal": "pick the answer", "value": "42", "maxSteps": float64(1),
		},
		Context: map[string]any{},
		Emit:    emit,
	})
	if err != nil {
		t.Fatalf("finish run: %v", err)
	}
	for _, entry := range events {
		if entry.Type != "agent.reasoning" {
			continue
		}
		if entry.Payload["decision"] == "finish" && entry.Payload["tool"] != nil {
			t.Fatalf("tool must be nil on finish: %v", entry.Payload["tool"])
		}
	}
}

// sanitizeReasoningText directly: scrub + flatten + collapse + rune cap.
func TestSanitizeReasoningText(t *testing.T) {
	secret := "key sk-ant-api03-" + strings.Repeat("B", 40) + " done"
	scrubbed := sanitizeReasoningText(secret, 500)
	if strings.Contains(scrubbed, "sk-ant-") {
		t.Fatalf("secret must scrub: %q", scrubbed)
	}
	// RLO override, word joiner, ZWSP, tabs — all flatten to single spaces.
	noisy := "a\u202eb\u2060c\u200bd \t e"
	if got := sanitizeReasoningText(noisy, 500); got != "a b c d e" {
		t.Fatalf("flatten/collapse: %q", got)
	}
	if got := sanitizeReasoningText(strings.Repeat("é", 200), 120); len([]rune(got)) != 120 {
		t.Fatalf("rune cap: %d", len([]rune(got)))
	}
	if fallbackReasoningText(sanitizeReasoningText(" \u200b ", 10), "unknown") != "unknown" {
		t.Fatal("empty after sanitize must fall back")
	}
	if got := sanitizeReasoningText(strings.Repeat("r", 600), 500); len([]rune(got)) != 500 {
		t.Fatalf("reason cap: %d", len([]rune(got)))
	}
}
