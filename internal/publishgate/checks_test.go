package publishgate

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/authoring"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/store"
)

func testCatalog() authoring.Catalog {
	catalog := authoring.NewBuilder(nil, nil).Build(context.Background(), "org")
	catalog.Credentials = append(catalog.Credentials, authoring.CredentialCapability{ID: "c1", Name: "SLACK_HOOK", Kind: "slack_webhook", Configured: true})
	return catalog
}

func readFixture() []Fixture {
	return []Fixture{{Name: "uppercases", Input: map[string]any{"text": "hi"}, Expect: Expectation{Status: "succeeded", Output: map[string]any{"text": "HI"}}}}
}

func readWorkflow(id string) *domain.Workflow {
	return &domain.Workflow{
		ID: id, Name: "Read " + id, DSLVersion: "1.0",
		Outputs: map[string]string{"text": "{{context.upper.output.result.value}}"},
		Nodes: []domain.Node{{ID: "upper", Type: "tool", Config: map[string]any{
			"tool": "text.uppercase", "input": map[string]any{"value": "{{context.input.text}}"},
		}}},
		Edges: []domain.Edge{},
	}
}

func recoveryContract() *domain.RecoveryContract {
	contract := &domain.RecoveryContract{Version: "2"}
	contract.Failure.Technical.TerminalNodeFailure = true
	contract.Failure.Semantic.Mode = "deterministic"
	contract.Failure.Semantic.Detectors = []domain.RecoverySemanticDetector{{
		ID: "det-text", SourceNodeID: "compose", Kind: "expression",
		PassWhen: "context.compose.output.text !== ''", Action: "quarantine", Message: "empty message",
	}}
	contract.Failure.Semantic.EvaluationFixtures = []domain.RecoverySemanticFixture{
		{ID: "fx-pass", SourceNodeID: "compose", Output: map[string]any{"text": "hi"}, Expected: "pass"},
		{ID: "fx-violation", SourceNodeID: "compose", Output: map[string]any{"text": ""}, Expected: "violation"},
	}
	contract.Evidence.Required = []string{"failure_snapshot", "audit_trail", "terminal_outcome"}
	contract.Effects = []domain.RecoveryEffect{{NodeID: "post", Kind: "notification", Idempotency: "required", Receipt: "runtime"}}
	contract.Repairs.Allowed = []string{"retry"}
	contract.Validation.MinimumEvidenceLevel = "static"
	contract.Approval.ProductionMutation = "required"
	contract.Approval.Permission = "recovery.write"
	contract.AutonomyLevel = 3
	contract.Verification.Kind = "generation_bound_terminal_success"
	contract.Recurrence.WindowDays = 7
	return contract
}

func writeWorkflow(id string) *domain.Workflow {
	return &domain.Workflow{
		ID: id, Name: "Write " + id, DSLVersion: "1.0",
		Outputs:  map[string]string{"sent": "{{context.post.output.ok}}"},
		Recovery: &domain.WorkflowRecovery{Contract: recoveryContract()},
		Nodes: []domain.Node{
			{ID: "compose", Type: "transform", Config: map[string]any{"mapping": map[string]any{"text": "{{context.input.text}}"}}},
			{ID: "post", Type: "tool", Config: map[string]any{
				"tool": "slack.post", "input": map[string]any{"credential": "SLACK_HOOK", "text": "{{context.compose.output.text}}"},
			}},
		},
		Edges: []domain.Edge{{From: "compose", To: "post"}},
	}
}

type gateCase struct {
	name     string
	wf       *domain.Workflow
	fixtures []Fixture
	raw      json.RawMessage
}

func runGate(t *testing.T, tc gateCase) []Check {
	t.Helper()
	document, err := domain.CanonicalWorkflowDocument(tc.wf)
	if err != nil {
		t.Fatalf("%s: canonical: %v", tc.name, err)
	}
	var doc map[string]any
	if err := json.Unmarshal(document, &doc); err != nil {
		t.Fatal(err)
	}
	fixtures := tc.fixtures
	if tc.raw != nil {
		parsed, problems := ParseFixtures(tc.raw, tc.wf)
		if len(problems) > 0 {
			return problems
		}
		fixtures = parsed
	}
	return StaticChecks(tc.wf, doc, fixtures, testCatalog())
}

func mutate(wf *domain.Workflow, change func(*domain.Workflow)) *domain.Workflow {
	change(wf)
	return wf
}

func toolConfig(wf *domain.Workflow, key string, value any) {
	wf.Nodes[0].Config[key] = value
}

func defectiveCorpus() []gateCase {
	stub := func(raw string) json.RawMessage { return json.RawMessage(raw) }
	return []gateCase{
		{"no declared outputs", mutate(readWorkflow("d1"), func(w *domain.Workflow) { w.Outputs = nil }), readFixture(), nil},
		{"no fixtures", readWorkflow("d2"), nil, nil},
		{"invented step type", mutate(readWorkflow("d3"), func(w *domain.Workflow) { w.Nodes[0].Type = "teleport" }), readFixture(), nil},
		{"invented tool", mutate(readWorkflow("d4"), func(w *domain.Workflow) { toolConfig(w, "tool", "text.reverse") }), readFixture(), nil},
		{"missing credential", mutate(writeWorkflow("d5"), func(w *domain.Workflow) {
			w.Nodes[1].Config["input"] = map[string]any{"credential": "NOPE", "text": "x"}
		}), readFixture(), nil},
		{"secret literal in a header", mutate(readWorkflow("d6"), func(w *domain.Workflow) {
			w.Nodes = append(w.Nodes, domain.Node{ID: "fetch", Type: "http", Config: map[string]any{
				"url": "https://api.example.com/x", "method": "GET",
				"headers": map[string]any{"Authorization": "Bearer sk-live-abcdefghijklmnopqrstuvwx"},
			}})
		}), readFixture(), nil},
		{"write without a recovery contract", mutate(writeWorkflow("d7"), func(w *domain.Workflow) { w.Recovery = nil }), readFixture(), nil},
		{"write that ignores its result", mutate(writeWorkflow("d8"), func(w *domain.Workflow) { w.Nodes[1].Config["resultPolicy"] = "envelope" }), readFixture(), nil},
		{"recovery fixture that fails", mutate(writeWorkflow("d9"), func(w *domain.Workflow) {
			w.Recovery.Contract.Failure.Semantic.EvaluationFixtures[0].Output = map[string]any{"text": ""}
		}), readFixture(), nil},
		{"edge to a missing step", mutate(readWorkflow("d10"), func(w *domain.Workflow) {
			w.Edges = []domain.Edge{{From: "upper", To: "ghost"}}
		}), readFixture(), nil},
		{"duplicate step ids", mutate(readWorkflow("d11"), func(w *domain.Workflow) { w.Nodes = append(w.Nodes, w.Nodes[0]) }), readFixture(), nil},
		{"http step without a url", mutate(readWorkflow("d12"), func(w *domain.Workflow) {
			w.Nodes = append(w.Nodes, domain.Node{ID: "fetch", Type: "http", Config: map[string]any{"method": "GET"}})
		}), readFixture(), nil},
		{"stub of an unknown step", readWorkflow("d13"), nil, stub(`[{"name":"a","stubs":{"ghost":{}},"expect":{"status":"succeeded"}}]`)},
		{"stub of an approval", mutate(readWorkflow("d14"), func(w *domain.Workflow) {
			w.Nodes = append(w.Nodes, domain.Node{ID: "ask", Type: "approval", Config: map[string]any{}})
		}), nil, stub(`[{"name":"a","stubs":{"ask":{"approved":true}},"expect":{"status":"succeeded"}}]`)},
		{"fixture without an end state", readWorkflow("d15"), nil, stub(`[{"name":"a","expect":{"status":"fine"}}]`)},
		{"api key in a transform", mutate(readWorkflow("d16"), func(w *domain.Workflow) {
			w.Nodes = append(w.Nodes, domain.Node{ID: "keys", Type: "transform", Config: map[string]any{
				"mapping": map[string]any{"key": "AKIAIOSFODNN7EXAMPLE"},
			}})
		}), readFixture(), nil},
		{"invented subworkflow", mutate(readWorkflow("d17"), func(w *domain.Workflow) {
			w.Nodes = append(w.Nodes, domain.Node{ID: "child", Type: "subworkflow", Config: map[string]any{"workflowId": "wf-ghost"}})
		}), readFixture(), nil},
		{"cycle", mutate(readWorkflow("d18"), func(w *domain.Workflow) {
			w.Nodes = append(w.Nodes, domain.Node{ID: "again", Type: "noop", Config: map[string]any{}})
			w.Edges = []domain.Edge{{From: "upper", To: "again"}, {From: "again", To: "upper"}}
		}), readFixture(), nil},
		{"unchecked write http", mutate(readWorkflow("d19"), func(w *domain.Workflow) {
			w.Nodes = append(w.Nodes, domain.Node{ID: "send", Type: "http", Config: map[string]any{
				"url": "https://hooks.example.com/x", "method": "POST",
			}})
		}), readFixture(), nil},
		{"duplicate fixture names", readWorkflow("d20"), nil, stub(`[{"name":"a","expect":{"status":"succeeded"}},{"name":"a","expect":{"status":"failed"}}]`)},
	}
}

func soundCorpus() []gateCase {
	cases := []gateCase{}
	for i := range 12 {
		wf := readWorkflow(fmt.Sprintf("s%d", i))
		if i%3 == 1 {
			wf.Nodes = append(wf.Nodes, domain.Node{ID: "pick", Type: "tool", Config: map[string]any{
				"tool": "json.pick", "input": map[string]any{"path": "input.text"},
			}})
			wf.Edges = []domain.Edge{{From: "upper", To: "pick"}}
		}
		if i%3 == 2 {
			wf.Nodes = append(wf.Nodes, domain.Node{ID: "fetch", Type: "http", Config: map[string]any{
				"url": "https://api.example.com/items/{{context.input.text}}", "method": "GET",
			}})
		}
		cases = append(cases, gateCase{fmt.Sprintf("read %d", i), wf, readFixture(), nil})
	}
	for i := range 8 {
		wf := writeWorkflow(fmt.Sprintf("w%d", i))
		if i%2 == 1 {
			wf.Nodes = append(wf.Nodes, domain.Node{ID: "upper", Type: "tool", Config: map[string]any{
				"tool": "text.uppercase", "input": map[string]any{"value": "{{context.input.text}}"},
			}})
			wf.Edges = append(wf.Edges, domain.Edge{From: "upper", To: "compose"})
		}
		cases = append(cases, gateCase{fmt.Sprintf("write %d", i), wf, readFixture(), nil})
	}
	return cases
}

// TestGateBlocksDefectsAndPassesSoundWorkflows is the gate's measure: at least
// 90% of defective drafts blocked and at most 10% of sound ones.
func TestGateBlocksDefectsAndPassesSoundWorkflows(t *testing.T) {
	// Each defect must be caught for its own reason, not by accident.
	reasons := map[string]string{
		"no declared outputs": "intent_missing", "no fixtures": "fixtures_missing", "invented step type": "invalid_",
		"invented tool": "capability_missing", "missing credential": "credential_missing",
		"secret literal in a header": "secret_literal", "write without a recovery contract": "recovery_contract_missing",
		"write that ignores its result": "result_unchecked", "recovery fixture that fails": "recovery_fixture_failed",
		"edge to a missing step": "invalid_", "duplicate step ids": "invalid_", "http step without a url": "invalid_",
		"stub of an unknown step": "fixture_stub_unknown_step", "stub of an approval": "fixture_stub_not_allowed",
		"fixture without an end state": "fixture_expectation_invalid", "api key in a transform": "secret_literal",
		"invented subworkflow": "capability_missing", "cycle": "invalid_",
		"unchecked write http": "recovery_contract_missing", "duplicate fixture names": "fixture_name_invalid",
	}
	blocked, missed := 0, []string{}
	for _, tc := range defectiveCorpus() {
		checks := runGate(t, tc)
		if Passed(checks) {
			missed = append(missed, tc.name)
			continue
		}
		blocked++
		if !slices.ContainsFunc(checks, func(check Check) bool { return strings.HasPrefix(check.Code, reasons[tc.name]) }) {
			t.Errorf("%s was blocked, but not by %s: %+v", tc.name, reasons[tc.name], checks)
		}
		for _, check := range checks {
			if check.Status == "failed" && (check.Code == "" || check.Message == "") {
				t.Fatalf("%s: a failed check without code or message: %+v", tc.name, check)
			}
		}
	}
	falseBlocks := []string{}
	sound := soundCorpus()
	for _, tc := range sound {
		if checks := runGate(t, tc); !Passed(checks) {
			falseBlocks = append(falseBlocks, fmt.Sprintf("%s: %+v", tc.name, checks))
		}
	}
	defective := len(defectiveCorpus())
	t.Logf("blocked %d/%d defective, falsely blocked %d/%d sound", blocked, defective, len(falseBlocks), len(sound))
	if blocked*10 < defective*9 {
		t.Fatalf("blocked %d of %d defective drafts; missed %v", blocked, defective, missed)
	}
	if len(falseBlocks)*10 > len(sound) {
		t.Fatalf("falsely blocked %d of %d sound drafts:\n%s", len(falseBlocks), len(sound), strings.Join(falseBlocks, "\n"))
	}
	if len(missed) > 0 {
		t.Logf("not blocked: %v", missed)
	}
}

func TestFixtureVerdicts(t *testing.T) {
	expect := Expectation{Status: "succeeded", Output: map[string]any{"total": 10, "nested": map[string]any{"ok": true}}}
	cases := []struct {
		name   string
		status string
		output string
		wait   bool
		want   string
		done   bool
	}{
		{"matching subset", "succeeded", `{"total":10,"nested":{"ok":true,"extra":1},"more":"x"}`, false, "passed", true},
		{"different value", "succeeded", `{"total":11,"nested":{"ok":true}}`, false, "failed", true},
		{"different status", "failed", `{}`, false, "failed", true},
		{"still running", "running", `{}`, false, "", false},
	}
	for _, tc := range cases {
		verdict, _, done := judge(expect, runOutcome(tc.status, tc.output, tc.wait), true)
		if verdict != tc.want || done != tc.done {
			t.Fatalf("%s: verdict %q done %v", tc.name, verdict, done)
		}
	}
	verdict, _, done := judge(Expectation{Status: "waiting"}, runOutcome("running", `{}`, true), true)
	if verdict != "passed" || !done {
		t.Fatalf("a run waiting on a person should satisfy expect waiting: %q %v", verdict, done)
	}
}

func TestDigestBindsDocumentAndFixtures(t *testing.T) {
	a, _ := Digest([]byte(`{"id":"x"}`), readFixture())
	b, _ := Digest([]byte(`{"id":"x"}`), readFixture())
	c, _ := Digest([]byte(`{"id":"x"}`), nil)
	if a != b || a == c || len(a) != 64 {
		t.Fatalf("digests %q %q %q", a, b, c)
	}
}

func TestEffectsDecideWhoPublishes(t *testing.T) {
	if !slices.Equal(EffectNodes(writeWorkflow("w")), []string{"post"}) || len(EffectNodes(readWorkflow("r"))) != 0 {
		t.Fatal("effect classification drifted")
	}
}

func runOutcome(status, output string, waiting bool) store.ListRunOutcomesForOrgRow {
	return store.ListRunOutcomesForOrgRow{ID: "r", Status: status, OutputJson: json.RawMessage(output), Waiting: waiting}
}
