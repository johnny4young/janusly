package domain

import "testing"

// The three fork/join gate rules with their reference severities.

func readinessDoc(t *testing.T, doc string) *Workflow {
	t.Helper()
	wf, issues := Parse([]byte(doc))
	if wf == nil {
		t.Fatalf("fixture must parse: %+v", issues)
	}
	return wf
}

func findReadiness(issues []ReadinessIssue, code string) *ReadinessIssue {
	for i := range issues {
		if issues[i].Code == code {
			return &issues[i]
		}
	}
	return nil
}

func TestForkWithoutJoinIsAWarn(t *testing.T) {
	wf := readinessDoc(t, `{"nodes":[
		{"id":"fork","type":"parallel_fork","config":{"branches":[{"label":"a"},{"label":"b"}]}},
		{"id":"a1","type":"noop","config":{}},
		{"id":"b1","type":"noop","config":{}}
	],"edges":[{"from":"fork","to":"a1"},{"from":"fork","to":"b1"}]}`)
	issue := findReadiness(CheckForkJoinReadiness(wf), "fork_without_join_pair")
	if issue == nil || issue.Severity != "warn" || issue.NodeID != "fork" {
		t.Fatalf("warn-level rule broken: %+v", issue)
	}
}

func TestJoinSourceOutsideAncestryFails(t *testing.T) {
	wf := readinessDoc(t, `{"nodes":[
		{"id":"fork","type":"parallel_fork","config":{"branches":[{"label":"a"},{"label":"b"}]}},
		{"id":"a1","type":"noop","config":{}},
		{"id":"b1","type":"noop","config":{}},
		{"id":"stranger","type":"noop","config":{}},
		{"id":"merge","type":"join","config":{"sources":{"a":"a1","b":"stranger"}}}
	],"edges":[
		{"from":"fork","to":"a1"},{"from":"fork","to":"b1"},
		{"from":"a1","to":"merge"},{"from":"b1","to":"merge"}
	]}`)
	issues := CheckForkJoinReadiness(wf)
	unreachable := findReadiness(issues, "join_sources_unreachable")
	if unreachable == nil || unreachable.Severity != "fail" {
		t.Fatalf("unreachable source must fail: %+v", issues)
	}
}

func TestForkLabelsUncoveredByAnyJoinFails(t *testing.T) {
	wf := readinessDoc(t, `{"nodes":[
		{"id":"fork","type":"parallel_fork","config":{"branches":[{"label":"a"},{"label":"b"}]}},
		{"id":"a1","type":"noop","config":{}},
		{"id":"b1","type":"noop","config":{}},
		{"id":"merge","type":"join","config":{"sources":{"a":"a1","other":"b1"}}}
	],"edges":[
		{"from":"fork","to":"a1"},{"from":"fork","to":"b1"},
		{"from":"a1","to":"merge"},{"from":"b1","to":"merge"}
	]}`)
	issue := findReadiness(CheckForkJoinReadiness(wf), "fork_join_missing_branch_sources")
	if issue == nil || issue.Severity != "fail" {
		t.Fatalf("uncovered labels must fail: %+v", issue)
	}
}

func TestWellPairedForkJoinIsClean(t *testing.T) {
	wf := readinessDoc(t, `{"nodes":[
		{"id":"fork","type":"parallel_fork","config":{"branches":[{"label":"a"},{"label":"b"}]}},
		{"id":"a1","type":"noop","config":{}},
		{"id":"b1","type":"noop","config":{}},
		{"id":"merge","type":"join","config":{"sources":{"a":"a1","b":"b1"}}}
	],"edges":[
		{"from":"fork","to":"a1"},{"from":"fork","to":"b1"},
		{"from":"a1","to":"merge"},{"from":"b1","to":"merge"}
	]}`)
	if issues := CheckForkJoinReadiness(wf); len(issues) != 0 {
		t.Fatalf("well-paired fork/join must be clean: %+v", issues)
	}
}
