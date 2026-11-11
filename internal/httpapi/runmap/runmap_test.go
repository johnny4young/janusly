package runmap

import (
	"reflect"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/store"
)

func TestIsStuck(t *testing.T) {
	cases := []struct {
		name       string
		elapsed    time.Duration
		medianMs   float64
		hasHistory bool
		want       bool
	}{
		{"no history waits ten minutes", 9 * time.Minute, 0, false, false},
		{"no history past ten minutes", 11 * time.Minute, 0, false, true},
		{"instant history uses the floor", 31 * time.Second, 0, true, true},
		{"under the floor", 20 * time.Second, 1000, true, false},
		{"three times the median", 31 * time.Minute, 10 * 60 * 1000, true, true},
		{"under three times the median", 29 * time.Minute, 10 * 60 * 1000, true, false},
	}
	for _, tc := range cases {
		if got := isStuck(tc.elapsed, tc.medianMs, tc.hasHistory); got != tc.want {
			t.Errorf("%s: isStuck = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestCanDecide(t *testing.T) {
	starter := map[string]bool{"runs.start": true}
	cases := []struct {
		name        string
		kind        string
		permissions map[string]bool
		requesters  []string
		want        bool
	}{
		{"person step", "approval", starter, nil, true},
		{"form step", "human_form", starter, nil, true},
		{"without runs.start", "approval", map[string]bool{}, nil, false},
		{"tool approval by another person", "tool_approval", starter, []string{"someone"}, true},
		{"tool approval the viewer caused", "tool_approval", starter, []string{"viewer"}, false},
		{"tool approval without a live request", "tool_approval", starter, nil, false},
		{"unknown wait", "timer", starter, nil, false},
	}
	for _, tc := range cases {
		if got := canDecide(tc.kind, tc.permissions, tc.requesters, "viewer"); got != tc.want {
			t.Errorf("%s: canDecide = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestFormResumable(t *testing.T) {
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	live := map[string]any{"resumeTokenExpiresAt": "2026-01-01T12:05:00Z"}
	expired := map[string]any{"resumeTokenExpiresAt": "2026-01-01T11:55:00Z"}
	if !formResumable("human_form", live, now) || formResumable("human_form", expired, now) || formResumable("human_form", map[string]any{}, now) {
		t.Fatal("a form is resumable only while its resume token is live")
	}
	if !formResumable("approval", expired, now) {
		t.Fatal("an approval step has no resume token")
	}
}

func TestLaneStepKeepsOnlyTypedFields(t *testing.T) {
	got := laneStep(store.ListRunAgentEventsRow{Type: "multi_agent.agent.started",
		Payload: []byte(`{"name":"planner","index":1,"iteration":-1,"tool":7,"agent":"","goal":"secret","status":"ok"}`)})
	want := map[string]any{"type": "multi_agent.agent.started", "at": nil, "name": "planner", "index": int64(1), "status": "ok"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("laneStep = %#v, want %#v", got, want)
	}
	planned := laneStep(store.ListRunAgentEventsRow{Type: "agent.step.planned",
		Payload: []byte(`{"agent":"a","iteration":0,"plan":{"tool":"crm.lookup","input":{"secret":"x"}}}`)})
	if planned["tool"] != "crm.lookup" || planned["plan"] != nil || planned["input"] != nil {
		t.Fatalf("planned step must name only its tool: %#v", planned)
	}
}

func TestNodeViewIgnoresAPreviousAttemptsFinish(t *testing.T) {
	now := time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	started, finished := now.Add(-40*time.Minute), now.Add(-time.Hour)
	view := (&service{}).nodeView(store.ListRunMapNodesRow{NodeID: "n", Status: "running", StartedAt: &started, FinishedAt: &finished},
		"http", store.ListRunNodeCostsRow{}, nil, nil, nil, "viewer", now)
	if view["finishedAt"] != nil || view["elapsedMs"] != (40*time.Minute).Milliseconds() || view["stuck"] != true {
		t.Fatalf("redriven running step: %v", view)
	}
}
