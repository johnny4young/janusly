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
		"unknown step": {map[string]string{"start": "succeeded"}, "ghost", "fork_node_not_found"},
		"skipped step": {map[string]string{"start": "succeeded", "side": "succeeded", "write": "skipped"}, "write", "predecessor_not_succeeded"},
		"pending step, whose edge condition was never evaluated": {map[string]string{"start": "succeeded", "side": "succeeded", "write": "pending"}, "write", "predecessor_not_succeeded"},
		"waiting step":                {map[string]string{"start": "succeeded", "side": "succeeded", "write": "waiting"}, "write", "predecessor_not_succeeded"},
		"failed earlier step":         {map[string]string{"start": "succeeded", "write": "failed", "read": "cancelled"}, "read", "predecessor_not_succeeded"},
		"unreached earlier step":      {map[string]string{"start": "succeeded", "read": "cancelled"}, "read", "predecessor_not_succeeded"},
		"selected step still running": {map[string]string{"start": "succeeded", "write": "running"}, "write", "rerun_source_open"},
		"another step still running":  {map[string]string{"start": "succeeded", "write": "succeeded", "side": "running"}, "write", "rerun_source_open"},
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
		{NodeID: "b", Status: "failed", StateJson: json.RawMessage(`{}`)},
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

// A gate beside the selected step guards the write through the join, even though
// it is neither upstream of the selected step nor in its closure.
func TestPlanRerunRefusesAWriteBehindASiblingApproval(t *testing.T) {
	wf := rerunDoc(t, `{"dslVersion":"1.0","nodes":[
		{"id":"fork","type":"noop"},{"id":"enrich","type":"noop"},{"id":"gate","type":"approval"},
		{"id":"charge","type":"http","config":{"url":"https://a.example","method":"POST"}}
	],"edges":[{"from":"fork","to":"enrich"},{"from":"fork","to":"gate"},{"from":"enrich","to":"charge"},{"from":"gate","to":"charge"}]}`)
	for _, status := range []string{"succeeded", "cancelled", "failed", "waiting", "pending"} {
		t.Run(status, func(t *testing.T) {
			_, rejected := PlanRerun("src", wf, rerunRows(map[string]string{
				"fork": "succeeded", "enrich": "succeeded", "gate": status, "charge": "failed",
			}), "enrich")
			if rejected == nil || rejected.NodeID != "gate" {
				t.Fatalf("the write must not fire without its gate: %+v", rejected)
			}
		})
	}
	if plan, rejected := PlanRerun("src", wf, rerunRows(map[string]string{
		"fork": "succeeded", "enrich": "succeeded", "gate": "succeeded", "charge": "failed",
	}), "gate"); rejected != nil || !slices.Contains(plan.Rerun, "charge") {
		t.Fatalf("rerunning the gate itself asks a human again: %+v %+v", plan, rejected)
	}
}

// Readiness accepts a skipped predecessor, so a failed one must not be skipped
// into place: the join would run on an output that does not exist.
func TestPlanRerunRefusesAJoinWithoutItsPredecessor(t *testing.T) {
	wf := rerunDoc(t, `{"dslVersion":"1.0","nodes":[
		{"id":"a","type":"noop"},{"id":"b","type":"noop"},{"id":"c","type":"noop"},{"id":"far","type":"noop"},
		{"id":"d","type":"http","config":{"url":"https://a.example","method":"POST"}}
	],"edges":[{"from":"a","to":"b"},{"from":"a","to":"c"},{"from":"b","to":"d"},{"from":"c","to":"d"},{"from":"a","to":"far"}]}`)
	for _, status := range []string{"failed", "pending", "cancelled", "waiting"} {
		_, rejected := PlanRerun("src", wf, rerunRows(map[string]string{"a": "succeeded", "b": status, "c": "failed", "d": "pending", "far": "succeeded"}), "c")
		if rejected == nil || rejected.Code != "predecessor_not_succeeded" || rejected.NodeID != "b" {
			t.Fatalf("%s predecessor: %+v", status, rejected)
		}
	}

	// A step with no way into the closure can stay behind.
	plan, rejected := PlanRerun("src", wf, rerunRows(map[string]string{"a": "succeeded", "b": "succeeded", "c": "failed", "d": "pending", "far": "failed"}), "c")
	if rejected != nil || !slices.Equal(plan.NotRun, []string{"far"}) || plan.Seed.Nodes["far"].Status != "skipped" {
		t.Fatalf("unrelated failure: %+v %+v", plan, rejected)
	}

	// A branch the source did not take stays not taken, so a merge can rerun.
	plan, rejected = PlanRerun("src", wf, rerunRows(map[string]string{"a": "succeeded", "b": "skipped", "c": "failed", "d": "pending", "far": "succeeded"}), "c")
	if rejected != nil || !slices.Contains(plan.NotRun, "b") || plan.Seed.Nodes["b"].Status != "skipped" {
		t.Fatalf("branch not taken: %+v %+v", plan, rejected)
	}

	// A skip left by an earlier rerun says nothing about that branch.
	rows := rerunRows(map[string]string{"a": "succeeded", "c": "failed", "d": "pending", "far": "succeeded"})
	rows = append(rows, store.ListRunNodesByRunForOrgRow{NodeID: "b", Status: "skipped", StateJson: json.RawMessage(`{"skipped":{"reason":"outside_rerun"}}`)})
	if _, rejected := PlanRerun("src", wf, rows, "c"); rejected == nil || rejected.NodeID != "b" {
		t.Fatalf("a rerun's own skip must not count as taken: %+v", rejected)
	}
}

func TestPlanRerunRefusesASubworkflowStillWaitingOnItsChild(t *testing.T) {
	wf := rerunDoc(t, `{"dslVersion":"1.0","nodes":[{"id":"a","type":"noop"},{"id":"child","type":"noop"}],"edges":[]}`)
	rows := []store.ListRunNodesByRunForOrgRow{
		{NodeID: "a", Status: "failed", StateJson: json.RawMessage(`{}`)},
		{NodeID: "child", Status: "waiting", StateJson: json.RawMessage(`{"waiting":{"kind":"subworkflow","childRunId":"c1"}}`)},
	}
	if _, rejected := PlanRerun("src", wf, rows, "a"); rejected == nil || rejected.Code != "rerun_source_open" {
		t.Fatalf("a live child can still write: %+v", rejected)
	}
	rows[1].StateJson = json.RawMessage(`{"waiting":{"kind":"approval"}}`)
	if _, rejected := PlanRerun("src", wf, rows, "a"); rejected != nil {
		t.Fatalf("a parked approval executes nothing: %+v", rejected)
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

	for name, value := range map[string]any{
		"reference":        "{{secret.KEY}}",
		"scheme":           "Bearer {{secret.KEY}}",
		"lowercase scheme": "bearer {{env.KEY}}",
		"blank":            "",
		"null":             nil,
		"not text":         float64(500),
	} {
		if _, rejected := ApplyRerunOverride(wf, "call", map[string]any{"url": "https://x", "token": value}); rejected != nil {
			t.Errorf("%s must be accepted: %+v", name, rejected)
		}
	}
	for name, value := range map[string]any{
		"literal beside a reference": "sk-live-abc123 {{secret.KEY}}",
		"scheme with no reference":   "Bearer",
		"scheme and a literal":       "Bearer sk-live-abc123",
		"literal in a list":          []any{"pasted"},
	} {
		if _, rejected := ApplyRerunOverride(wf, "call", map[string]any{"url": "https://x", "token": value}); rejected == nil || rejected.Code != "rerun_raw_secret" {
			t.Errorf("%s must be refused: %+v", name, rejected)
		}
	}
	if patched, rejected := ApplyRerunOverride(wf, "call", map[string]any{"url": "https://x", "tokenLimit": float64(500)}); rejected != nil || patched.Nodes[0].Config["tokenLimit"] != float64(500) {
		t.Errorf("a number under a token-shaped key is not a credential: %+v", rejected)
	}

	agent := rerunDoc(t, `{"dslVersion":"1.0","nodes":[{"id":"a","type":"agent","config":{"goal":"x"}}],"edges":[]}`)
	if _, rejected := ApplyRerunOverride(agent, "a", map[string]any{"goal": "x", "allowWriteTools": true}); rejected == nil {
		t.Fatal("an override must not opt an agent into writes")
	}
	if _, rejected := ApplyRerunOverride(wf, "ghost", map[string]any{}); rejected == nil {
		t.Fatal("an unknown step must be refused")
	}
}

// A mask restores by position, so it must not survive a change to where it sits.
func TestApplyRerunOverrideRefusesAMovedMask(t *testing.T) {
	wf := rerunDoc(t, `{"dslVersion":"1.0","nodes":[{"id":"call","type":"tool","config":{"tool":"x","targets":[
		{"url":"https://a.example","apiKey":"credential-a"},
		{"url":"https://b.example","apiKey":"credential-b"}
	]}}],"edges":[]}`)
	target := func(url string) map[string]any { return map[string]any{"url": url, "apiKey": "[redacted]"} }
	override := func(items ...any) map[string]any { return map[string]any{"tool": "x", "targets": items} }

	if same, rejected := ApplyRerunOverride(wf, "call", override(target("https://a.example"), target("https://b.example"))); rejected != nil || same != wf {
		t.Fatalf("an unchanged list must round trip: %+v", rejected)
	}
	for name, items := range map[string][]any{
		"reordered":  {target("https://b.example"), target("https://a.example")},
		"removed":    {target("https://b.example")},
		"appended":   {target("https://a.example"), target("https://b.example"), target("https://c.example")},
		"retargeted": {target("https://evil.example"), target("https://b.example")},
	} {
		if _, rejected := ApplyRerunOverride(wf, "call", override(items...)); rejected == nil || rejected.Code != "rerun_raw_secret" {
			t.Errorf("%s: %+v", name, rejected)
		}
	}
	// An edit that drops the mask for a named secret has nothing to misdirect.
	edited := override(map[string]any{"url": "https://evil.example", "apiKey": "{{secret.NEW}}"}, target("https://b.example"))
	if _, rejected := ApplyRerunOverride(wf, "call", edited); rejected != nil {
		t.Errorf("a reference needs no restore: %+v", rejected)
	}
}
