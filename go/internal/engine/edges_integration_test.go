//go:build integration

package engine

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/go/internal/grammar"
)

// End-to-end conditional-edge semantics through the real dispatcher: the
// grammar renders configs and evaluates edge conditions, the queue routes,
// and Postgres holds the resulting truth.

func runDispatcherToTerminal(t *testing.T, eng *Engine, pool *pgxpool.Pool, runID string, want string) {
	t.Helper()
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	workerCtx, stop := context.WithCancel(context.Background())
	defer stop()
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = eng.RunWorkers(workerCtx, 4, 50*time.Millisecond, dispatcher.Execute, quietLogger())
	}()
	deadline := time.Now().Add(20 * time.Second)
	for {
		var status string
		_ = pool.QueryRow(context.Background(), "select status from runs where id=$1", runID).Scan(&status)
		if status == want {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("run stuck at %q, want %s", status, want)
		}
		time.Sleep(25 * time.Millisecond)
	}
	stop()
	<-done
}

const branchDoc = `{"nodes":[
	{"id":"gate","type":"condition","config":{"expression":"context.input.approve === true"}},
	{"id":"yes","type":"transform","config":{"mapping":{"path":"approved via {{context.gate.output.result}}"}}},
	{"id":"no","type":"transform","config":{"mapping":{"path":"rejected"}}}
],"edges":[
	{"from":"gate","to":"yes","condition":"context.gate.output.result === true"},
	{"from":"gate","to":"no","condition":"context.gate.output.result === false"}
]}`

func TestConditionalBranchExecutesOnlyTheTrueSide(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID, err := eng.StartRun(ctx, StartInput{
		OrgID: org, Workflow: mustParse(t, branchDoc),
		Input: map[string]any{"approve": true},
	})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	runDispatcherToTerminal(t, eng, pool, runID, "succeeded")

	var yesStatus, noStatus string
	var yesState, noState []byte
	_ = pool.QueryRow(ctx, "select status, state_json from run_nodes where run_id=$1 and node_id='yes'", runID).Scan(&yesStatus, &yesState)
	_ = pool.QueryRow(ctx, "select status, state_json from run_nodes where run_id=$1 and node_id='no'", runID).Scan(&noStatus, &noState)

	if yesStatus != "succeeded" || !strings.Contains(string(yesState), "approved via true") {
		t.Fatalf("true branch must run with templated output: %s %s", yesStatus, yesState)
	}
	if noStatus != "skipped" {
		t.Fatalf("false branch must be skipped, got %s", noStatus)
	}
	// The skipped node's state carries the reference's exact reason shape.
	var skipped map[string]map[string]string
	_ = json.Unmarshal(noState, &skipped)
	if skipped["skipped"]["reason"] != "Condition not met" {
		t.Fatalf("skip state parity broken: %s", noState)
	}
	var skipEvents int
	_ = pool.QueryRow(ctx, "select count(*) from run_events where run_id=$1 and type='node.skipped' and node_id='no'", runID).Scan(&skipEvents)
	if skipEvents != 1 {
		t.Fatalf("expected exactly one node.skipped event, got %d", skipEvents)
	}
}

func TestSuccessorOfSkippedNodeStillRuns(t *testing.T) {
	// Reference semantics read from enqueueReadyNodes: a skipped predecessor
	// SATISFIES its outgoing unconditional edges — skip does not cascade.
	// The downstream node runs against the skipped node's empty output.
	ctx, pool, eng, org := newHarness(t)
	doc := `{"nodes":[
		{"id":"gate","type":"condition","config":{"expression":"false"}},
		{"id":"branch","type":"noop","config":{}},
		{"id":"after","type":"transform","config":{"mapping":{"sawOutput":"{{context.branch.output}}"}}}
	],"edges":[
		{"from":"gate","to":"branch","condition":"context.gate.output.result === true"},
		{"from":"branch","to":"after"}
	]}`
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, doc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	runDispatcherToTerminal(t, eng, pool, runID, "succeeded")

	var branchStatus, afterStatus string
	_ = pool.QueryRow(ctx, "select status from run_nodes where run_id=$1 and node_id='branch'", runID).Scan(&branchStatus)
	_ = pool.QueryRow(ctx, "select status from run_nodes where run_id=$1 and node_id='after'", runID).Scan(&afterStatus)
	if branchStatus != "skipped" || afterStatus != "succeeded" {
		t.Fatalf("skip must not cascade through unconditional edges: branch=%s after=%s", branchStatus, afterStatus)
	}
}

func TestDeclaredOutputsProjectOnRunSuccess(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	doc := `{"nodes":[
		{"id":"final","type":"transform","config":{"mapping":{"verdict":"ok","count":3}}}
	],"edges":[],
	"inputs":{"type":"object","properties":{"name":{"type":"string","default":"Ada"}}},
	"outputs":{
		"verdict":"{{context.final.output.verdict}}",
		"greeting":"hi {{inputs.name}}",
		"leak":"{{secret.SHOULD_NOT_RESOLVE}}"
	}}`
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, doc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	runDispatcherToTerminal(t, eng, pool, runID, "succeeded")

	var outputJSON []byte
	if err := pool.QueryRow(ctx, "select output_json from runs where id=$1", runID).Scan(&outputJSON); err != nil {
		t.Fatalf("read outputs: %v", err)
	}
	var projected map[string]any
	_ = json.Unmarshal(outputJSON, &projected)
	if projected["verdict"] != "ok" || projected["greeting"] != "hi Ada" {
		t.Fatalf("projection broken: %s", outputJSON)
	}
	// Secret/env refs are masked BEFORE rendering — user-visible outputs
	// must never resolve them.
	if projected["leak"] != "[redacted]" {
		t.Fatalf("secret ref must be masked in outputs: %s", outputJSON)
	}
}

func TestUnresolvedTemplatePathEmitsEvidenceEvent(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	doc := `{"nodes":[
		{"id":"tx","type":"transform","config":{"mapping":{"v":"{{context.ghost.output.value}}"}}}
	],"edges":[]}`
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, doc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	runDispatcherToTerminal(t, eng, pool, runID, "succeeded")

	var payload []byte
	if err := pool.QueryRow(ctx,
		"select payload from run_events where run_id=$1 and type='template.unresolved_path'", runID,
	).Scan(&payload); err != nil {
		t.Fatalf("evidence event expected: %v", err)
	}
	var parsed struct {
		Count     int      `json:"count"`
		Paths     []string `json:"paths"`
		Truncated bool     `json:"truncated"`
		Policy    string   `json:"policy"`
	}
	_ = json.Unmarshal(payload, &parsed)
	if parsed.Count != 1 || parsed.Policy != "lenient" || parsed.Truncated ||
		len(parsed.Paths) != 1 || parsed.Paths[0] != "context.ghost.output.value" {
		t.Fatalf("evidence payload parity broken: %s", payload)
	}
	// Lenient policy: the node still succeeds with the empty-string render.
	var state []byte
	_ = pool.QueryRow(ctx, "select state_json from run_nodes where run_id=$1 and node_id='tx'", runID).Scan(&state)
	if !strings.Contains(string(state), `"v": ""`) && !strings.Contains(string(state), `"v":""`) {
		t.Fatalf("lenient render must keep the empty value: %s", state)
	}
}

func TestStrictTemplatePolicyFailsBeforeConsumingMissingValue(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	doc := `{"templatePolicy":"strict","nodes":[
		{"id":"tx","type":"transform","config":{"mapping":{"v":"{{context.ghost.output.value}}"}}}
	],"edges":[]}`
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, doc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	runDispatcherToTerminal(t, eng, pool, runID, "failed")

	var errorJSON []byte
	_ = pool.QueryRow(ctx, "select error_json from run_nodes where run_id=$1 and node_id='tx'", runID).Scan(&errorJSON)
	if !strings.Contains(string(errorJSON), "Node config contains 1 unresolved template path") {
		t.Fatalf("strict policy must fail with the envelope message: %s", errorJSON)
	}
}

func TestToolNodeRunsThroughTheRegistry(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	doc := `{"nodes":[
		{"id":"parse","type":"tool","config":{
			"tool":"json.parse",
			"input":{"value":"{\"customer\":{\"id\":42}}"}
		}},
		{"id":"read","type":"transform","config":{"mapping":{
			"id":"{{context.parse.output.result.value.customer.id}}"
		}}}
	],"edges":[{"from":"parse","to":"read"}]}`
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, doc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	runDispatcherToTerminal(t, eng, pool, runID, "succeeded")

	var state []byte
	_ = pool.QueryRow(ctx, "select state_json->'output' from run_nodes where run_id=$1 and node_id='parse'", runID).Scan(&state)
	var output map[string]any
	_ = json.Unmarshal(state, &output)
	// Envelope parity: {tool, result} with the tool's own fields under result.
	if output["tool"] != "json.parse" {
		t.Fatalf("tool envelope: %s", state)
	}
	result := output["result"].(map[string]any)
	if result["ok"] != true {
		t.Fatalf("result envelope: %s", state)
	}

	// Downstream templating reads THROUGH the envelope.
	var downstream []byte
	_ = pool.QueryRow(ctx, "select state_json->'output' from run_nodes where run_id=$1 and node_id='read'", runID).Scan(&downstream)
	if !strings.Contains(string(downstream), `"id": 42`) && !strings.Contains(string(downstream), `"id":42`) {
		t.Fatalf("templated tool output: %s", downstream)
	}
}

func TestToolFailureFollowsResultPolicy(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	// Default policy: the failed envelope flows downstream, node succeeds.
	lenient := `{"nodes":[{"id":"t","type":"tool","config":{
		"tool":"json.parse","input":{"value":"{broken"}
	}}],"edges":[]}`
	runID, _ := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, lenient)})
	runDispatcherToTerminal(t, eng, pool, runID, "succeeded")
	var state []byte
	_ = pool.QueryRow(ctx, "select state_json->'output'->'result' from run_nodes where run_id=$1", runID).Scan(&state)
	if !strings.Contains(string(state), `"ok": false`) || !strings.Contains(string(state), "invalid JSON") {
		t.Fatalf("lenient policy must carry the failure envelope: %s", state)
	}

	// require_ok: the node fails.
	strict := `{"nodes":[{"id":"t","type":"tool","config":{
		"tool":"json.parse","input":{"value":"{broken"},"resultPolicy":"require_ok"
	}}],"edges":[]}`
	strictRun, _ := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, strict)})
	runDispatcherToTerminal(t, eng, pool, strictRun, "failed")
}
