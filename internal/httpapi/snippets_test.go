package httpapi

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/workflowvalidation"
)

// Built-ins are inserted directly into an operator's draft. Keep them on the
// exact executable grammar rather than validating only their loose wire shape.
func TestBuiltinSnippetsUseExecutableWorkflowContracts(t *testing.T) {
	if len(builtinSnippets) != 9 {
		t.Fatalf("built-in snippet count = %d, want 9", len(builtinSnippets))
	}
	for _, snippet := range builtinSnippets {
		t.Run(strings.TrimPrefix(snippet.ID, builtinSnippetPrefix), func(t *testing.T) {
			if !snippetCategories[snippet.Category] {
				t.Fatalf("unsupported category %q", snippet.Category)
			}
			localIDs := make(map[string]bool, len(snippet.Nodes))
			for _, node := range snippet.Nodes {
				id, _ := node["id"].(string)
				localIDs[id] = true
			}
			if !localIDs[snippet.EntryNodeID] {
				t.Fatalf("entry node %q is not local", snippet.EntryNodeID)
			}

			raw, err := json.Marshal(map[string]any{"nodes": snippet.Nodes, "edges": snippet.Edges})
			if err != nil {
				t.Fatal(err)
			}
			workflow, parseIssues := domain.Parse(raw)
			if workflow == nil || len(parseIssues) > 0 {
				t.Fatalf("snippet does not parse as a workflow fragment: %+v", parseIssues)
			}
			if result := workflowvalidation.Validate(workflow); !result.Valid {
				t.Fatalf("snippet is not executable: %+v", result.Issues)
			}

			encoded := string(raw)
			for _, legacy := range []string{`"retryPolicy"`, `"initialDelayMs"`, `"credentialName"`, `"kv.set"`} {
				if strings.Contains(encoded, legacy) {
					t.Fatalf("snippet retains non-executable legacy field %s: %s", legacy, encoded)
				}
			}
		})
	}
}

func TestCustomSnippetValidationUsesDraftSemanticsWithoutPersistingSecrets(t *testing.T) {
	valid := snippetBody{
		Name: "  Mi fragmento  ", Category: "custom", Tags: []string{" ops ", "safe"},
		Nodes: []map[string]any{{
			"id": "notify", "type": "tool", "config": map[string]any{
				"tool": "slack.post", "input": map[string]any{"text": "Complete the credential after insertion"},
			},
		}},
		Edges: []map[string]any{}, EntryNodeID: " notify ",
	}
	if message := validateSnippetBody(&valid); message != "" {
		t.Fatalf("incomplete but structurally valid draft rejected: %s", message)
	}
	if valid.Name != "Mi fragmento" || valid.EntryNodeID != "notify" || valid.Tags[0] != "ops" {
		t.Fatalf("operator labels were not normalized: %+v", valid)
	}

	tests := []struct {
		name string
		body snippetBody
		want string
	}{
		{
			name: "unknown tool",
			body: snippetBody{Name: "bad", Category: "custom", Nodes: []map[string]any{{
				"id": "call", "type": "tool", "config": map[string]any{"tool": "invented.call", "input": map[string]any{}},
			}}},
			want: "tool_invalid_input",
		},
		{
			name: "invented input field",
			body: snippetBody{Name: "bad", Category: "custom", Nodes: []map[string]any{{
				"id": "call", "type": "tool", "config": map[string]any{
					"tool": "slack.post", "input": map[string]any{"credentialName": "legacy"},
				},
			}}},
			want: "Unsupported field",
		},
		{
			name: "raw secret",
			body: snippetBody{Name: "bad", Category: "custom", Nodes: []map[string]any{{
				"id": "call", "type": "http", "config": map[string]any{
					"url": "https://example.com", "headers": map[string]any{"authorization": "Bearer literal-secret"},
				},
			}}},
			want: "raw_secret_in_config",
		},
		{
			name: "invalid entry",
			body: snippetBody{Name: "bad", Category: "custom", EntryNodeID: "missing", Nodes: []map[string]any{{
				"id": "present", "type": "noop", "config": map[string]any{},
			}}},
			want: "entryNodeId",
		},
		{
			name: "cycle",
			body: snippetBody{Name: "bad", Category: "custom", Nodes: []map[string]any{
				{"id": "a", "type": "noop", "config": map[string]any{}},
				{"id": "b", "type": "noop", "config": map[string]any{}},
			}, Edges: []map[string]any{{"from": "a", "to": "b"}, {"from": "b", "to": "a"}}},
			want: "cycle_detected",
		},
		{
			name: "duplicate tags",
			body: snippetBody{Name: "bad", Category: "custom", Tags: []string{"ops", "ops"}, Nodes: []map[string]any{{
				"id": "a", "type": "noop", "config": map[string]any{},
			}}},
			want: "tags must be unique",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if message := validateSnippetBody(&test.body); !strings.Contains(message, test.want) {
				t.Fatalf("validation message = %q, want %q", message, test.want)
			}
		})
	}

	templatedSecret := snippetBody{Name: "safe-template", Category: "custom", Nodes: []map[string]any{{
		"id": "call", "type": "http", "config": map[string]any{
			"url": "https://example.com", "headers": map[string]any{"authorization": "Bearer {{secret.API_TOKEN}}"},
		},
	}}}
	if message := validateSnippetBody(&templatedSecret); message != "" {
		t.Fatalf("managed secret reference rejected: %s", message)
	}
}
