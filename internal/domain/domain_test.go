package domain

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// Every case cites the contract it ports: the source contract
// workflow-validation.ts (wv) or the source contract (iv)
// at the consistency pin recorded in the plan.

func parseOK(t *testing.T, doc string) *Workflow {
	t.Helper()
	wf, issues := Parse([]byte(doc))
	if len(issues) > 0 {
		t.Fatalf("unexpected contract issues: %+v", issues)
	}
	return wf
}

func codesOf(result ValidationResult) []string {
	out := make([]string, 0, len(result.Issues))
	for _, issue := range result.Issues {
		out = append(out, issue.Code)
	}
	return out
}

func requireIssue(t *testing.T, result ValidationResult, code, messageFragment string) Issue {
	t.Helper()
	sameCode := 0
	for _, issue := range result.Issues {
		if issue.Code != code {
			continue
		}
		sameCode++
		if messageFragment == "" || strings.Contains(issue.Message, messageFragment) {
			return issue
		}
	}
	if sameCode > 0 {
		t.Fatalf("no %s issue contains %q among %+v", code, messageFragment, result.Issues)
	}
	t.Fatalf("expected issue %s, got %v", code, codesOf(result))
	return Issue{}
}

func TestParseRejectsMissingArraysWithPaths(t *testing.T) {
	// wv:83-90 — schema-parse failure yields only invalid_contract issues
	// carrying the field path, and no workflow.
	wf, issues := Parse([]byte(`{"name":"x"}`))
	if wf != nil || len(issues) != 2 {
		t.Fatalf("expected two contract issues, got wf=%v issues=%+v", wf, issues)
	}
	for _, issue := range issues {
		if issue.Code != CodeInvalidContract {
			t.Fatalf("expected invalid_contract, got %+v", issue)
		}
	}
	if !strings.HasPrefix(issues[0].Message, "nodes:") || !strings.HasPrefix(issues[1].Message, "edges:") {
		t.Fatalf("messages must carry field paths: %+v", issues)
	}
}

func TestEmptyWorkflow(t *testing.T) {
	// wv:98-100 — empty node list; the missing-start check stays silent for
	// zero nodes (wv:539-540 guards on nodes.length > 0).
	result := Validate(parseOK(t, `{"nodes":[],"edges":[]}`), nil)
	if got := codesOf(result); len(got) != 1 || got[0] != CodeEmptyWorkflow {
		t.Fatalf("expected exactly empty_workflow, got %v", got)
	}
}

func TestDuplicateAndReservedNodeIDs(t *testing.T) {
	// wv:103 (duplicate) + wv:107-112 (the literal id "input" collides with
	// the run-input slot in the template scope).
	result := Validate(parseOK(t, `{"nodes":[
		{"id":"a","type":"noop","config":{}},
		{"id":"a","type":"noop","config":{}},
		{"id":"input","type":"noop","config":{}}
	],"edges":[]}`), nil)
	requireIssue(t, result, CodeDuplicateNodeID, "Duplicate node id: a")
	requireIssue(t, result, CodeNodeIDReserved, `reserved for the run input`)
}

func TestUnsupportedVersusRuntimeUnsupported(t *testing.T) {
	// wv:114 — a type outside the platform's closed set is invalid
	// everywhere. A type valid on the platform but outside this backend's
	// executable subset gets the runtime-only code instead, never Node's.
	result := Validate(parseOK(t, `{"nodes":[
		{"id":"a","type":"banana","config":{}},
		{"id":"b","type":"agent_reflection","config":{}}
	],"edges":[]}`), nil)
	unsupported := requireIssue(t, result, CodeUnsupportedNodeType, "Unsupported node type: banana")
	if unsupported.NodeID != "a" {
		t.Fatalf("wrong node attribution: %+v", unsupported)
	}
	runtime := requireIssue(t, result, CodeNodeTypeNotExecutable, `"agent_reflection"`)
	if runtime.NodeID != "b" {
		t.Fatalf("wrong node attribution: %+v", runtime)
	}
}

func TestHTTPMissingURLTreatsJSFalsyAsMissing(t *testing.T) {
	// wv:115 — `!node.config.url`: absent, empty string, null, false and 0
	// all read as missing under the contract's truthiness.
	for _, config := range []string{`{}`, `{"url":""}`, `{"url":null}`, `{"url":false}`, `{"url":0}`} {
		result := Validate(parseOK(t, `{"nodes":[{"id":"a","type":"http","config":`+config+`}],"edges":[]}`), nil)
		requireIssue(t, result, CodeHTTPMissingURL, "HTTP node requires config.url")
	}
	clean := Validate(parseOK(t, `{"nodes":[{"id":"a","type":"http","config":{"url":"https://example.com"}}],"edges":[]}`), nil)
	if !clean.Valid {
		t.Fatalf("expected valid, got %v", codesOf(clean))
	}
}

func TestConditionExpressionChecks(t *testing.T) {
	// wv:146-153 — missing expression and invalid expression are distinct
	// codes; the grammar plugs in through the validator seam.
	missing := Validate(parseOK(t, `{"nodes":[{"id":"c","type":"condition","config":{}}],"edges":[]}`), nil)
	requireIssue(t, missing, CodeConditionMissingExpr, "requires config.expression")

	reject := func(string) (bool, string) { return false, "grammar says no" }
	invalid := Validate(parseOK(t, `{"nodes":[{"id":"c","type":"condition","config":{"expression":"true"}}],"edges":[]}`), reject)
	requireIssue(t, invalid, CodeConditionInvalidExpr, "grammar says no")
}

func TestTransformMissingMapping(t *testing.T) {
	// wv:253-258 — mapping must be a non-empty plain object; arrays and
	// empty objects both fail.
	for _, config := range []string{`{}`, `{"mapping":{}}`, `{"mapping":[1]}`, `{"mapping":"x"}`} {
		result := Validate(parseOK(t, `{"nodes":[{"id":"tx","type":"transform","config":`+config+`}],"edges":[]}`), nil)
		requireIssue(t, result, CodeTransformMissingMapping, "non-empty config.mapping")
	}
}

func TestHumanFormSchemaAndInitialValues(t *testing.T) {
	invalid := Validate(parseOK(t, `{"nodes":[
		{"id":"missing","type":"human_form","config":{}},
		{"id":"empty","type":"human_form","config":{"schema":{"type":"object","properties":{}}}},
		{"id":"prefill","type":"human_form","config":{"schema":{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]},"initialValues":{"summary":42}}}
	],"edges":[]}`), nil)
	requireIssue(t, invalid, CodeHumanFormInvalidSchema, "valid config.schema")
	requireIssue(t, invalid, CodeHumanFormEmptySchema, "at least one field")
	requireIssue(t, invalid, CodeHumanFormInvalidInitial, "$.summary must be string, got number")

	valid := Validate(parseOK(t, `{"nodes":[{"id":"review","type":"human_form","config":{
		"schema":{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]},
		"initialValues":{"summary":"draft"}}}],"edges":[]}`), nil)
	if !valid.Valid {
		t.Fatalf("valid initial values rejected: %+v", valid.Issues)
	}
}

func TestEdgeEndpointsMustExist(t *testing.T) {
	// wv:356-359 — missing endpoints report per edge with the synthetic
	// edge_<index> id when the edge declares none.
	result := Validate(parseOK(t, `{"nodes":[{"id":"a","type":"noop","config":{}}],"edges":[
		{"from":"ghost","to":"a"},
		{"from":"a","to":"nowhere"}
	]}`), nil)
	from := requireIssue(t, result, CodeEdgeInvalidFrom, "Edge source does not exist: ghost")
	if from.EdgeID != "edge_0" {
		t.Fatalf("expected synthetic edge id, got %+v", from)
	}
	to := requireIssue(t, result, CodeEdgeInvalidTo, "Edge target does not exist: nowhere")
	if to.EdgeID != "edge_1" {
		t.Fatalf("expected synthetic edge id, got %+v", to)
	}
}

func TestEdgeConditionInputsScopeGuard(t *testing.T) {
	// wv:363-376 — inputs.* on an edge never resolves at run time, so it is
	// rejected at validation; quoted literals must not false-positive.
	flagged := Validate(parseOK(t, `{"nodes":[
		{"id":"a","type":"noop","config":{}},{"id":"b","type":"noop","config":{}}
	],"edges":[{"from":"a","to":"b","condition":"inputs.total > 5"}]}`), nil)
	requireIssue(t, flagged, CodeEdgeConditionInputsScope, "context.input.*")

	quoted := Validate(parseOK(t, `{"nodes":[
		{"id":"a","type":"noop","config":{}},{"id":"b","type":"noop","config":{}}
	],"edges":[{"from":"a","to":"b","condition":"context.a.output.x === \"inputs.name\""}]}`), nil)
	for _, issue := range quoted.Issues {
		if issue.Code == CodeEdgeConditionInputsScope {
			t.Fatalf("quoted literal must not trip the guard: %+v", issue)
		}
	}
}

func TestCycleAlsoStarvesStartNodes(t *testing.T) {
	// wv:536-540 — a two-node loop trips both the cycle check and the
	// missing-start check, exactly as the contract reports them.
	result := Validate(parseOK(t, `{"nodes":[
		{"id":"a","type":"noop","config":{}},{"id":"b","type":"noop","config":{}}
	],"edges":[{"from":"a","to":"b"},{"from":"b","to":"a"}]}`), nil)
	requireIssue(t, result, CodeCycleDetected, "contains a cycle")
	requireIssue(t, result, CodeMissingStartNode, "at least one start node")
}

func TestInputDefaultTypeMismatchMessageConsistency(t *testing.T) {
	// wv:528-533 + iv walk messages — verified live against the Node API:
	// a string field with default 42 reports exactly this composed message.
	result := Validate(parseOK(t, `{"nodes":[{"id":"a","type":"noop","config":{}}],"edges":[],
		"inputs":{"type":"object","properties":{"start":{"type":"string","default":42}}}}`), nil)
	issue := requireIssue(t, result, CodeInputDefaultTypeMismatch, "")
	want := "Declared default for $.start is invalid: $.start must be string, got number"
	if issue.Message != want {
		t.Fatalf("message contract mismatch:\n got: %s\nwant: %s", issue.Message, want)
	}
}

func TestValidDefaultAndExplicitNullDistinction(t *testing.T) {
	// iv — an absent default and a declared null default are different: the
	// declared null must be validated (and fail a string field).
	valid := Validate(parseOK(t, `{"nodes":[{"id":"a","type":"noop","config":{}}],"edges":[],
		"inputs":{"type":"object","properties":{"tz":{"type":"string","default":"UTC"}}}}`), nil)
	if !valid.Valid {
		t.Fatalf("expected valid, got %v", codesOf(valid))
	}
	nullDefault := Validate(parseOK(t, `{"nodes":[{"id":"a","type":"noop","config":{}}],"edges":[],
		"inputs":{"type":"object","properties":{"tz":{"type":"string","default":null}}}}`), nil)
	requireIssue(t, nullDefault, CodeInputDefaultTypeMismatch, "must be string, got null")
}

func TestEnumAndNestedDefaultPaths(t *testing.T) {
	// iv enum + nested walk — the enum message embeds both sides as JSON and
	// nested defaults report at their own dotted path.
	result := Validate(parseOK(t, `{"nodes":[{"id":"a","type":"noop","config":{}}],"edges":[],
		"inputs":{"type":"object","properties":{
			"mode":{"type":"string","enum":["fast","safe"],"default":"slow"},
			"window":{"type":"object","properties":{"start":{"type":"string","default":9}}}
		}}}`), nil)
	requireIssue(t, result, CodeInputDefaultTypeMismatch, `$.mode must be one of ["fast","safe"], got "slow"`)
	requireIssue(t, result, CodeInputDefaultTypeMismatch, "$.window.start must be string, got number")
}

func TestDocumentationFixturesValidateClean(t *testing.T) {
	// Acceptance fixtures from docs/workflows.md sections 2 and 6 at the
	// consistency pin: both use only subset node types and must pass untouched.
	for _, name := range []string{"testdata/conditional-branch.json", "testdata/approval-gate.json"} {
		raw, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		wf := parseOK(t, string(raw))
		result := Validate(wf, nil)
		if !result.Valid {
			t.Fatalf("%s must validate clean, got %v", name, codesOf(result))
		}
	}
}

func TestIssueWireShape(t *testing.T) {
	// The wire shape { code, message, nodeId?, edgeId? } feeds the web's
	// localized issue rendering; empty attributions must be omitted.
	payload, _ := json.Marshal(Issue{Code: CodeCycleDetected, Message: "m"})
	if string(payload) != `{"code":"cycle_detected","message":"m"}` {
		t.Fatalf("unexpected wire shape: %s", payload)
	}
}
