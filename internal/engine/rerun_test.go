package engine

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/store"
)

func rerunDoc(t *testing.T, doc string) *domain.Workflow {
	t.Helper()
	wf, issues := domain.Parse([]byte(doc))
	if wf == nil {
		t.Fatalf("parse: %+v", issues)
	}
	return wf
}

func rerunRows(statuses map[string]string) []store.ListRunNodesByRunForOrgRow {
	rows := make([]store.ListRunNodesByRunForOrgRow, 0, len(statuses))
	for nodeID, status := range statuses {
		rows = append(rows, store.ListRunNodesByRunForOrgRow{
			NodeID: nodeID, Status: status, StateJson: json.RawMessage(`{"output":{"from":"` + nodeID + `"}}`),
		})
	}
	return rows
}

const rerunDiamond = `{"dslVersion":"1.0","nodes":[
	{"id":"start","type":"noop"},
	{"id":"write","type":"http","config":{"url":"https://a.example","method":"POST"}},
	{"id":"read","type":"http","config":{"url":"https://a.example","method":"GET"}},
	{"id":"side","type":"noop"},
	{"id":"lost","type":"noop"},
	{"id":"notify","type":"tool","config":{"tool":"slack.post"}}
],"edges":[
	{"from":"start","to":"write"},{"from":"write","to":"read"},
	{"from":"start","to":"side"},{"from":"start","to":"lost"},
	{"from":"read","to":"notify"},{"from":"side","to":"notify"}
]}`

func TestPlanRerunNeverQueuesAnEarlierWrite(t *testing.T) {
	wf := rerunDoc(t, rerunDiamond)
	plan, rejected := PlanRerun("src", wf, rerunRows(map[string]string{
		"start": "succeeded", "write": "succeeded", "read": "failed",
		"side": "succeeded", "lost": "pending", "notify": "pending",
	}), "read")
	if rejected != nil {
		t.Fatalf("rejected: %+v", rejected)
	}
	if !slices.Equal(plan.Reused, []string{"start", "write", "side"}) ||
		!slices.Equal(plan.Rerun, []string{"read", "notify"}) || !slices.Equal(plan.NotRun, []string{"lost"}) {
		t.Fatalf("plan: %+v", plan)
	}
	for _, nodeID := range []string{"start", "write", "side"} {
		seed := plan.Seed.Nodes[nodeID]
		if seed.Status != "succeeded" || !strings.Contains(string(seed.State), nodeID) {
			t.Fatalf("%s must be cloned with its output: %+v", nodeID, seed)
		}
	}
	if seed := plan.Seed.Nodes["lost"]; seed.Status != "skipped" {
		t.Fatalf("a branch outside the rerun must not run: %+v", seed)
	}
	if _, seeded := plan.Seed.Nodes["read"]; seeded || plan.Seed.NodeID != "read" {
		t.Fatalf("only the selected step is queued: %+v", plan.Seed)
	}
	if len(plan.SideEffects) != 1 || plan.SideEffects[0].NodeID != "notify" {
		t.Fatalf("earlier writes are not listed, later ones are: %+v", plan.SideEffects)
	}
}

func TestPlanRerunRefusals(t *testing.T) {
	wf := rerunDoc(t, rerunDiamond)
	cases := map[string]struct {
		statuses map[string]string
		nodeID   string
		code     string
	}{
		"unknown step":           {map[string]string{"start": "succeeded"}, "ghost", "fork_node_not_found"},
		"skipped step":           {map[string]string{"start": "succeeded", "write": "skipped"}, "write", "predecessor_not_succeeded"},
		"failed earlier step":    {map[string]string{"start": "succeeded", "write": "failed"}, "read", "predecessor_not_succeeded"},
		"unreached earlier step": {map[string]string{"start": "succeeded"}, "read", "predecessor_not_succeeded"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, rejected := PlanRerun("src", wf, rerunRows(tc.statuses), tc.nodeID)
			if rejected == nil || rejected.Code != tc.code {
				t.Fatalf("got %+v, want %s", rejected, tc.code)
			}
		})
	}
}

// The size bound replaces a state that does not fit, leaving no output to reuse.
func TestPlanRerunRefusesATruncatedOutput(t *testing.T) {
	wf := rerunDoc(t, `{"dslVersion":"1.0","nodes":[{"id":"a","type":"noop"},{"id":"b","type":"noop"}],"edges":[{"from":"a","to":"b"}]}`)
	_, rejected := PlanRerun("src", wf, []store.ListRunNodesByRunForOrgRow{
		{NodeID: "a", Status: "succeeded", StateJson: json.RawMessage(`{"__truncated":true}`)},
	}, "b")
	if rejected == nil || rejected.NodeID != "a" {
		t.Fatalf("truncated output must not be reused: %+v", rejected)
	}
}

func TestPlanRerunDoesNotReuseAnApprovalForWrites(t *testing.T) {
	wf := rerunDoc(t, `{"dslVersion":"1.0","nodes":[
		{"id":"gate","type":"approval"},
		{"id":"send","type":"http","config":{"url":"https://a.example","method":"POST"}},
		{"id":"read","type":"http","config":{"url":"https://a.example","method":"GET"}}
	],"edges":[{"from":"gate","to":"send"},{"from":"gate","to":"read"}]}`)
	statuses := map[string]string{"gate": "succeeded", "send": "succeeded", "read": "failed"}
	if _, rejected := PlanRerun("src", wf, rerunRows(statuses), "send"); rejected == nil || rejected.Code != "rerun_needs_approval" || rejected.NodeID != "gate" {
		t.Fatalf("a write behind a reused approval must be refused: %+v", rejected)
	}
	if _, rejected := PlanRerun("src", wf, rerunRows(statuses), "read"); rejected != nil {
		t.Fatalf("a read behind an approval can reuse it: %+v", rejected)
	}
	plan, rejected := PlanRerun("src", wf, rerunRows(statuses), "gate")
	if rejected != nil || plan.Seed.NodeID != "gate" {
		t.Fatalf("rerunning the approval itself asks a human again: %+v %+v", plan, rejected)
	}
}

func TestRerunSideEffectClassification(t *testing.T) {
	cases := map[string]struct {
		node domain.Node
		want bool
	}{
		"read http":        {domain.Node{Type: "http", Config: map[string]any{"method": "GET"}}, false},
		"write http":       {domain.Node{Type: "http", Config: map[string]any{"method": "POST"}}, true},
		"templated method": {domain.Node{Type: "http", Config: map[string]any{"method": "{{context.input.m}}"}}, true},
		"write tool":       {domain.Node{Type: "tool", Config: map[string]any{"tool": "slack.post"}}, true},
		"read tool":        {domain.Node{Type: "tool", Config: map[string]any{"tool": "db.schema.describe"}}, false},
		"unknown tool":     {domain.Node{Type: "tool", Config: map[string]any{"tool": "{{context.input.t}}"}}, true},
		"mcp":              {domain.Node{Type: "mcp_tool"}, true},
		"subworkflow":      {domain.Node{Type: "subworkflow"}, true},
		"agent":            {domain.Node{Type: "agent"}, false},
		"write agent":      {domain.Node{Type: "agent", Config: map[string]any{"allowWriteTools": true}}, true},
		"transform":        {domain.Node{Type: "transform"}, false},
	}
	for name, tc := range cases {
		if got := rerunHasEffect(tc.node); got != tc.want {
			t.Errorf("%s: got %v", name, got)
		}
	}
}

func TestApplyRerunOverride(t *testing.T) {
	wf := rerunDoc(t, `{"dslVersion":"1.0","nodes":[{"id":"call","type":"http","config":{
		"url":"https://old.example","method":"GET",
		"headers":{"Authorization":"Bearer authored-literal","X-Api-Key":"{{secret.KEY}}"}
	}}],"edges":[]}`)

	masked := func(url string) map[string]any {
		return map[string]any{"url": url, "method": "GET", "headers": map[string]any{"Authorization": "[redacted]", "X-Api-Key": "{{secret.KEY}}"}}
	}
	patched, rejected := ApplyRerunOverride(wf, "call", masked("https://new.example"))
	if rejected != nil {
		t.Fatalf("rejected: %+v", rejected)
	}
	if patched.Nodes[0].Config["url"] != "https://new.example" {
		t.Fatalf("patch: %+v", patched.Nodes[0].Config)
	}
	headers := patched.Nodes[0].Config["headers"].(map[string]any)
	if headers["Authorization"] != "Bearer authored-literal" {
		t.Fatalf("a masked value must keep the authored one: %+v", headers)
	}
	if wf.Nodes[0].Config["url"] != "https://old.example" {
		t.Fatal("the source document must not change")
	}

	same, rejected := ApplyRerunOverride(wf, "call", masked("https://old.example"))
	if rejected != nil || same != wf {
		t.Fatalf("an unchanged override keeps the document: %+v", rejected)
	}

	for name, override := range map[string]map[string]any{
		"literal":        {"url": "https://x", "headers": map[string]any{"Authorization": "Bearer pasted"}},
		"nested literal": {"url": "https://x", "body": []any{map[string]any{"password": "pasted"}}},
		"object":         {"url": "https://x", "token": map[string]any{"value": "pasted"}},
		"new masked key": {"url": "https://x", "apiKey": "[redacted]"},
	} {
		if _, rejected := ApplyRerunOverride(wf, "call", override); rejected == nil || rejected.Code != "rerun_raw_secret" || strings.Contains(rejected.Message, "pasted") {
			t.Errorf("%s: %+v", name, rejected)
		}
	}

	agent := rerunDoc(t, `{"dslVersion":"1.0","nodes":[{"id":"a","type":"agent","config":{"goal":"x"}}],"edges":[]}`)
	if _, rejected := ApplyRerunOverride(agent, "a", map[string]any{"goal": "x", "allowWriteTools": true}); rejected == nil {
		t.Fatal("an override must not opt an agent into writes")
	}
	if _, rejected := ApplyRerunOverride(wf, "ghost", map[string]any{}); rejected == nil {
		t.Fatal("an unknown step must be refused")
	}
}
