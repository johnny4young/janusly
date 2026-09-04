package domain

import (
	"strings"
	"testing"
)

// Parse decodes nodes and edges a second time only to tell an explicit null
// from an absent field. That pass is now skipped when the document cannot
// contain a null; these cases pin that the null diagnostics still fire and
// that a "null" inside a string is not mistaken for one.
func TestParseStillReportsExplicitNullFields(t *testing.T) {
	cases := map[string]string{
		"nodes.0.label":     `{"nodes":[{"id":"a","type":"noop","label":null,"config":{}}],"edges":[]}`,
		"nodes.0.config":    `{"nodes":[{"id":"a","type":"noop","config":null}],"edges":[]}`,
		"edges.0.condition": `{"nodes":[{"id":"a","type":"noop","config":{}},{"id":"b","type":"noop","config":{}}],"edges":[{"from":"a","to":"b","condition":null}]}`,
		"edges.0.onError":   `{"nodes":[{"id":"a","type":"noop","config":{}},{"id":"b","type":"noop","config":{}}],"edges":[{"from":"a","to":"b","onError":null}]}`,
	}
	for path, doc := range cases {
		wf, issues := Parse([]byte(doc))
		if wf != nil {
			t.Fatalf("%s: a null field must reject the document", path)
		}
		found := false
		for _, issue := range issues {
			if issue.Code == CodeInvalidContract && strings.HasPrefix(issue.Message, path+": ") {
				found = true
			}
		}
		if !found {
			t.Fatalf("%s: expected an invalid_contract issue at that path, got %+v", path, issues)
		}
	}
}

func TestParseAcceptsTheWordNullInsideStrings(t *testing.T) {
	doc := `{"nodes":[{"id":"nullable","type":"noop","label":"null handling","config":{"note":"null"}}],"edges":[]}`
	wf, issues := Parse([]byte(doc))
	if wf == nil {
		t.Fatalf("a string containing the word null is not a null: %+v", issues)
	}
	if wf.Nodes[0].Label != "null handling" || wf.Nodes[0].Config["note"] != "null" {
		t.Fatalf("string values must round-trip: %+v", wf.Nodes[0])
	}
}
