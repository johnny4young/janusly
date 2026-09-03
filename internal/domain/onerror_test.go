package domain

import "testing"

// on-error edges: mutually exclusive with conditions, kept through
// Parse, and counted by the cycle check like any other edge.
func TestOnErrorEdgeValidation(t *testing.T) {
	both := Validate(parseOK(t, `{"nodes":[
		{"id":"a","type":"noop","config":{}},{"id":"b","type":"noop","config":{}}
	],"edges":[{"from":"a","to":"b","onError":true,"condition":"context.a.output.x"}]}`), nil)
	requireIssue(t, both, CodeEdgeOnErrorCondition, "cannot also carry a condition")

	clean := Validate(parseOK(t, `{"nodes":[
		{"id":"a","type":"noop","config":{}},{"id":"b","type":"noop","config":{}}
	],"edges":[{"from":"a","to":"b","onError":true}]}`), nil)
	if !clean.Valid {
		t.Fatalf("a bare on-error edge is valid: %+v", clean.Issues)
	}

	wf := parseOK(t, `{"nodes":[
		{"id":"a","type":"noop","config":{}},{"id":"b","type":"noop","config":{}}
	],"edges":[{"from":"a","to":"b","onError":true}]}`)
	if len(wf.Edges) != 1 || !wf.Edges[0].OnError {
		t.Fatalf("Parse must keep onError: %+v", wf.Edges)
	}

	cycle := Validate(parseOK(t, `{"nodes":[
		{"id":"a","type":"noop","config":{}},{"id":"b","type":"noop","config":{}}
	],"edges":[{"from":"a","to":"b"},{"from":"b","to":"a","onError":true}]}`), nil)
	requireIssue(t, cycle, CodeCycleDetected, "contains a cycle")
}
