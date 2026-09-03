package domain

import (
	"encoding/json"
	"fmt"
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

func TestParseRejectsInvalidAndExcessiveInputSchemas(t *testing.T) {
	invalid := `{"nodes":[{"id":"n","type":"noop","config":{}}],"edges":[],"inputs":{"type":"secret"}}`
	wf, issues := Parse([]byte(invalid))
	if wf != nil || len(issues) != 1 || !strings.HasPrefix(issues[0].Message, "inputs:") {
		t.Fatalf("unsupported input type must fail at the contract boundary: wf=%v issues=%+v", wf, issues)
	}

	properties := make(map[string]any, InputSchemaNodeMax)
	for index := range InputSchemaNodeMax {
		properties[fmt.Sprintf("field-%03d", index)] = map[string]any{"type": "string"}
	}
	document, err := json.Marshal(map[string]any{
		"nodes":  []any{map[string]any{"id": "n", "type": "noop", "config": map[string]any{}}},
		"edges":  []any{},
		"inputs": map[string]any{"type": "object", "properties": properties},
	})
	if err != nil {
		t.Fatal(err)
	}
	wf, issues = Parse(document)
	if wf != nil || len(issues) != 1 || !strings.Contains(issues[0].Message, "at most 512 nodes") {
		t.Fatalf("over-limit input schema must fail closed: wf=%v issues=%+v", wf, issues)
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

func TestHTTPConfigRejectsAmbiguousShapesAndUnboundedResources(t *testing.T) {
	for _, config := range []string{
		`{"url":"https://example.com","method":7}`,
		`{"url":"https://example.com","method":"GET bad"}`,
		`{"url":"https://example.com","headers":{"x-attempt":2}}`,
		`{"url":"https://example.com","timeoutMs":600001}`,
		`{"url":"https://example.com","maxResponseBytes":67108865}`,
		`{"url":"https://example.com","maxRedirects":21}`,
		`{"url":"https://example.com","maxRedirects":1.5}`,
		`{"url":"https://example.com","bodyMode":"unbounded"}`,
		`{"url":"https://example.com","streamPreviewBytes":1023}`,
	} {
		result := Validate(parseOK(t, `{"nodes":[{"id":"a","type":"http","config":`+config+`}],"edges":[]}`), nil)
		requireIssue(t, result, CodeHTTPInvalidConfig, "http.")
	}

	valid := Validate(parseOK(t, `{"nodes":[{"id":"a","type":"http","config":{
		"url":"{{context.input.url}}","method":"{{context.input.method}}",
		"headers":"{{context.input.headers}}","timeoutMs":"{{context.input.timeoutMs}}",
		"maxResponseBytes":67108864,"maxRedirects":0,"bodyMode":"stream","streamPreviewBytes":1048576
	}}],"edges":[]}`), nil)
	if !valid.Valid {
		t.Fatalf("valid bounded/dynamic HTTP config rejected: %+v", valid.Issues)
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

func TestAIOutputSchemaMustUseSupportedContractSubset(t *testing.T) {
	invalid := Validate(parseOK(t, `{"nodes":[{"id":"draft","type":"ai","config":{
		"prompt":"Return JSON","outputSchema":{"type":"secret"}}}],"edges":[]}`), nil)
	issue := requireIssue(t, invalid, CodeAIInvalidOutputSchema, "supported JSON Schema subset")
	if issue.NodeID != "draft" {
		t.Fatalf("wrong AI node attribution: %+v", issue)
	}

	valid := Validate(parseOK(t, `{"nodes":[{"id":"draft","type":"ai","config":{
		"prompt":"Return JSON","outputSchema":{"type":"object","required":["message"],
		"properties":{"message":{"type":"string"}}}}}],"edges":[]}`), nil)
	if !valid.Valid {
		t.Fatalf("valid AI output schema rejected: %+v", valid.Issues)
	}
}

func TestAIAgentAndMultiAgentRequiredAuthoringFields(t *testing.T) {
	result := Validate(parseOK(t, `{"nodes":[
		{"id":"ai","type":"ai","config":{}},
		{"id":"agent","type":"agent","config":{"goal":"   "}},
		{"id":"crew","type":"multi_agent","config":{"agents":[]}}
	],"edges":[]}`), nil)
	requireIssue(t, result, CodeAIMissingPrompt, "config.prompt")
	requireIssue(t, result, CodeAgentMissingGoal, "config.goal")
	requireIssue(t, result, CodeMultiAgentMissingAgents, "at least one agent")

	valid := Validate(parseOK(t, `{"nodes":[
		{"id":"ai","type":"ai","config":{"promptRef":{"name":"summarize"}}},
		{"id":"agent","type":"agent","config":{"goal":"Inspect the record"}},
		{"id":"crew","type":"multi_agent","config":{"agents":[{"goal":"Review it"}]}}
	],"edges":[]}`), nil)
	if !valid.Valid {
		t.Fatalf("complete AI/agent authoring fields rejected: %+v", valid.Issues)
	}
}

func TestAIPromptOpsReferencesFailClosedAtSave(t *testing.T) {
	result := Validate(parseOK(t, `{"nodes":[
		{"id":"shape","type":"ai","config":{"promptRef":"triage"}},
		{"id":"version","type":"ai","config":{"promptRef":{"name":"triage","version":1.5}}},
		{"id":"variables","type":"ai","config":{"promptRef":{"name":"triage"},"variables":{"priority":7}}}
	],"edges":[]}`), nil)
	requireIssue(t, result, CodeAIInvalidPromptRef, "promptRef must be an object")
	requireIssue(t, result, CodeAIInvalidPromptVariables, `variables["priority"] must be a string`)
}

func TestAgentAndMultiAgentRuntimeConfigFailsAtSave(t *testing.T) {
	result := Validate(parseOK(t, `{"nodes":[
		{"id":"planner","type":"agent","config":{"goal":"Inspect","planner":"other"}},
		{"id":"steps","type":"agent","config":{"goal":"Inspect","maxSteps":51}},
		{"id":"timeout","type":"agent","config":{"goal":"Inspect","timeoutMs":0}},
		{"id":"switch","type":"agent","config":{"goal":"Inspect","reflection":"yes"}},
		{"id":"member","type":"multi_agent","config":{"agents":[{"goal":"Inspect","maxSteps":51}]}},
		{"id":"mode","type":"multi_agent","config":{"mode":"race","agents":[{}]}},
		{"id":"aggregate","type":"multi_agent","config":{"aggregation":"random","agents":[{}]}},
		{"id":"continue","type":"multi_agent","config":{"continueOnError":"yes","agents":[{}]}}
	],"edges":[]}`), nil)
	for _, code := range []string{
		CodeAgentInvalidPlanner,
		CodeAgentInvalidMaxSteps,
		CodeAgentInvalidTimeout,
		CodeAgentInvalidBoolean,
		CodeMultiAgentInvalidAgents,
		CodeMultiAgentInvalidMode,
		CodeMultiAgentInvalidAgg,
		CodeMultiAgentInvalidBoolean,
	} {
		if requireIssue(t, result, code, "").NodeID == "" {
			t.Fatalf("issue %s lost node attribution", code)
		}
	}
}

func TestMultiAgentRequiresEveryMemberGoal(t *testing.T) {
	result := Validate(parseOK(t, `{"nodes":[
		{"id":"missing","type":"multi_agent","config":{"agents":[{}]}},
		{"id":"empty","type":"multi_agent","config":{"agents":[{"goal":"  "}]}},
		{"id":"wrong_type","type":"multi_agent","config":{"agents":[{"goal":{"task":"inspect"}}]}}
	],"edges":[]}`), nil)
	seen := map[string]bool{}
	for _, issue := range result.Issues {
		if issue.Code == CodeMultiAgentInvalidAgents && strings.Contains(issue.Message, "requires a non-empty goal") {
			seen[issue.NodeID] = true
		}
	}
	for _, nodeID := range []string{"missing", "empty", "wrong_type"} {
		if !seen[nodeID] {
			t.Fatalf("multi-agent goal issue missing for %s: %+v", nodeID, result.Issues)
		}
	}
}

func TestForkJoinAndTriggerConfigFailAtValidationInsteadOfRuntime(t *testing.T) {
	result := Validate(parseOK(t, `{"nodes":[
		{"id":"fork","type":"parallel_fork","config":{"branches":[{"label":"only"}]}},
		{"id":"join","type":"join","config":{"sources":{"one":"a"}}},
		{"id":"trigger","type":"pagerduty_incident","config":{}}
	],"edges":[]}`), nil)
	requireIssue(t, result, CodeParallelForkInvalidBranches, "at least 2 branches")
	requireIssue(t, result, CodeJoinInvalidSources, "at least 2 branches")
	requireIssue(t, result, CodeTriggerInvalidConfig, "webhookCredential is required")

	valid := Validate(parseOK(t, `{"nodes":[
		{"id":"fork","type":"parallel_fork","config":{"branches":[{"label":"a"},{"label":"b"}]}},
		{"id":"a","type":"noop","config":{}},
		{"id":"b","type":"noop","config":{}},
		{"id":"join","type":"join","config":{"sources":{"a":"a","b":"b"}}},
		{"id":"trigger","type":"pagerduty_incident","config":{"webhookCredential":"pagerduty-hook"}}
	],"edges":[]}`), nil)
	if !valid.Valid {
		t.Fatalf("valid fork/join/trigger config rejected: %+v", valid.Issues)
	}
}

func TestToolAndLoopStructuralConfigValidation(t *testing.T) {
	result := Validate(parseOK(t, `{"nodes":[
		{"id":"tool","type":"tool","config":{}},
		{"id":"loop","type":"loop","config":{"mode":"for_each","concurrency":21,
		 "toleratedFailureCount":1001,"toleratedFailurePercentage":101}}
	],"edges":[]}`), nil)
	requireIssue(t, result, CodeToolMissingName, "config.tool")
	requireIssue(t, result, CodeLoopMissingItems, "config.items")
	requireIssue(t, result, CodeLoopForEachMissingTool, "config.tool")
	requireIssue(t, result, CodeLoopInvalidConcurrency, "1 to 20")
	requireIssue(t, result, CodeLoopInvalidFailureCount, "0 to 1000")
	requireIssue(t, result, CodeLoopInvalidFailurePercent, "0 to 100")
	requireIssue(t, result, CodeLoopConflictingFailureLimit, "either count or percentage")
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
