package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestWorkflowDocumentCanonicalizesKnownContractFields(t *testing.T) {
	wf, issues := Parse([]byte(`{
		"mystery":"strip-me",
		"upstreamHealthSources":["pagerduty"],
		"slo":{"successRatePercent":99},
		"metadata":{"description":"  On-call assurance  ","tags":["  pagerduty  "],"owner":"strip-me"},
		"inputs":{"type":"object","properties":{},"unknown":"strip-me"},
		"ui":{"positions":{"trigger":{"x":12.5,"y":-3,"z":9}},"theme":"strip-me"},
		"nodes":[{"id":" trigger ","type":"noop","config":{"kept":true},"unknown":"strip-me"}],
		"edges":[]
	}`))
	if wf == nil || len(issues) != 0 {
		t.Fatalf("valid document rejected: wf=%v issues=%+v", wf, issues)
	}
	if wf.Metadata == nil || wf.Metadata.Description != "On-call assurance" ||
		len(wf.Metadata.Tags) != 1 || wf.Metadata.Tags[0] != "pagerduty" {
		t.Fatalf("metadata was not normalized: %+v", wf.Metadata)
	}
	if wf.UI == nil || wf.UI.Positions["trigger"] != (WorkflowPosition{X: 12.5, Y: -3}) {
		t.Fatalf("editor positions were not normalized: %+v", wf.UI)
	}

	// Save owns generated identity. Canonical persistence must include it and
	// only the typed workflow contract, never sibling reliability carriers.
	wf.ID = "wf-generated"
	wf.Name = "Generated name"
	encoded, err := CanonicalWorkflowDocument(wf)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(encoded, &document); err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"mystery", "upstreamHealthSources", "slo"} {
		if _, present := document[forbidden]; present {
			t.Fatalf("canonical DAG retained save-only/unknown field %q: %s", forbidden, encoded)
		}
	}
	if document["dslVersion"] != "1.0" || document["id"] != "wf-generated" || document["name"] != "Generated name" {
		t.Fatalf("canonical defaults/identity missing: %s", encoded)
	}
	metadata := document["metadata"].(map[string]any)
	if _, present := metadata["owner"]; present {
		t.Fatalf("metadata unknown key survived: %s", encoded)
	}
	ui := document["ui"].(map[string]any)
	if _, present := ui["theme"]; present {
		t.Fatalf("UI unknown key survived: %s", encoded)
	}
	position := ui["positions"].(map[string]any)["trigger"].(map[string]any)
	if _, present := position["z"]; present {
		t.Fatalf("position unknown key survived: %s", encoded)
	}
	node := document["nodes"].([]any)[0].(map[string]any)
	if _, present := node["unknown"]; present || node["config"].(map[string]any)["kept"] != true {
		t.Fatalf("node contract/config projection mismatch: %s", encoded)
	}
}

func TestWorkflowDocumentDefaultsMetadataAndRejectsExplicitNull(t *testing.T) {
	wf, issues := Parse([]byte(`{"nodes":[],"edges":[]}`))
	if wf == nil || len(issues) != 0 || wf.Metadata == nil || wf.Metadata.Tags == nil || len(wf.Metadata.Tags) != 0 {
		t.Fatalf("metadata default mismatch: wf=%+v issues=%+v", wf, issues)
	}
	encoded, err := CanonicalWorkflowDocument(wf)
	if err != nil || !strings.Contains(string(encoded), `"metadata":{"tags":[]}`) {
		t.Fatalf("canonical metadata default missing: %s err=%v", encoded, err)
	}

	for _, field := range []string{
		"dslVersion", "id", "name", "metadata", "inputs", "outputs", "templatePolicy", "recovery", "ui",
	} {
		document := `{"nodes":[],"edges":[],"` + field + `":null}`
		parsed, problems := Parse([]byte(document))
		if parsed != nil || len(problems) == 0 || !strings.HasPrefix(problems[0].Message, field+":") {
			t.Fatalf("explicit null %s must fail at its path: wf=%v issues=%+v", field, parsed, problems)
		}
	}
}

func TestWorkflowDocumentRejectsNestedNullsAndMalformedUI(t *testing.T) {
	cases := []struct {
		name string
		doc  string
		path string
	}{
		{"node label", `{"nodes":[{"id":"n","type":"noop","label":null,"config":{}}],"edges":[]}`, "nodes.0.label:"},
		{"node config", `{"nodes":[{"id":"n","type":"noop","config":null}],"edges":[]}`, "nodes.0.config:"},
		{"edge id", `{"nodes":[{"id":"a","type":"noop","config":{}},{"id":"b","type":"noop","config":{}}],"edges":[{"id":null,"from":"a","to":"b"}]}`, "edges.0.id:"},
		{"edge condition", `{"nodes":[{"id":"a","type":"noop","config":{}},{"id":"b","type":"noop","config":{}}],"edges":[{"condition":null,"from":"a","to":"b"}]}`, "edges.0.condition:"},
		{"edge onError", `{"nodes":[{"id":"a","type":"noop","config":{}},{"id":"b","type":"noop","config":{}}],"edges":[{"onError":null,"from":"a","to":"b"}]}`, "edges.0.onError:"},
		{"metadata description", `{"metadata":{"description":null},"nodes":[],"edges":[]}`, "metadata.description:"},
		{"metadata tags", `{"metadata":{"tags":null},"nodes":[],"edges":[]}`, "metadata.tags:"},
		{"position missing node", `{"ui":{"positions":{"ghost":{"x":0,"y":0}}},"nodes":[],"edges":[]}`, "ui.positions.ghost:"},
		{"position missing axis", `{"ui":{"positions":{"n":{"x":0}}},"nodes":[{"id":"n","type":"noop","config":{}}],"edges":[]}`, "ui.positions.n.y:"},
		{"position nonfinite", `{"ui":{"positions":{"n":{"x":1e1000,"y":0}}},"nodes":[{"id":"n","type":"noop","config":{}}],"edges":[]}`, "ui.positions.n.x:"},
		{"input description", `{"inputs":{"type":"string","description":null},"nodes":[],"edges":[]}`, "inputs:"},
		{"input properties", `{"inputs":{"type":"object","properties":null},"nodes":[],"edges":[]}`, "inputs:"},
		{"input items", `{"inputs":{"type":"array","items":null},"nodes":[],"edges":[]}`, "inputs:"},
		{"input enum", `{"inputs":{"type":"string","enum":null},"nodes":[],"edges":[]}`, "inputs:"},
		{"output template", `{"outputs":{"result":null},"nodes":[],"edges":[]}`, "outputs:"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			wf, issues := Parse([]byte(testCase.doc))
			if wf != nil || len(issues) == 0 {
				t.Fatalf("malformed document accepted: wf=%v issues=%+v", wf, issues)
			}
			matched := false
			for _, issue := range issues {
				matched = matched || strings.HasPrefix(issue.Message, testCase.path)
			}
			if !matched {
				t.Fatalf("expected path %q among %+v", testCase.path, issues)
			}
		})
	}
}

func TestWorkflowDocumentUIProblemOrderIsDeterministic(t *testing.T) {
	document := []byte(`{"ui":{"positions":{"z":{"x":0},"a":{"x":0}}},"nodes":[{"id":"z","type":"noop","config":{}},{"id":"a","type":"noop","config":{}}],"edges":[]}`)
	var want string
	for attempt := range 100 {
		workflow, issues := Parse(document)
		if workflow != nil || len(issues) != 2 {
			t.Fatalf("attempt %d: malformed positions were not rejected exactly: workflow=%v issues=%+v", attempt, workflow, issues)
		}
		got := issues[0].Message + "\n" + issues[1].Message
		if attempt == 0 {
			want = got
			if !strings.HasPrefix(issues[0].Message, "ui.positions.a.y:") ||
				!strings.HasPrefix(issues[1].Message, "ui.positions.z.y:") {
				t.Fatalf("UI position problems are not sorted: %+v", issues)
			}
			continue
		}
		if got != want {
			t.Fatalf("UI problem order changed:\nfirst: %s\nnext:  %s", want, got)
		}
	}
}
