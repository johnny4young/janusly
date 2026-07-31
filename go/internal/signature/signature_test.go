package signature

import (
	"strings"
	"testing"
	"time"
)

// Table ports representative cases per rule from error-signature.ts,
// in the reference's priority order.
func TestNormalizeRules(t *testing.T) {
	cases := []struct {
		name string
		err  any
		ctx  Context
		want Result
	}{
		{"secret by code", map[string]any{"code": "E_SECRET_MISSING", "secret": "GITHUB_TOKEN"}, Context{},
			Result{"Missing secret: GITHUB_TOKEN", "secret_missing", "ops"}},
		{"secret by message", "secret 'STRIPE_KEY' not found", Context{},
			Result{"Missing secret: STRIPE_KEY", "secret_missing", "ops"}},
		// The message pattern can't capture past `;` (same as the JS regex —
		// that input falls to the fallback rule there too); the sanitizer
		// guards the arbitrary `secret` FIELD on coded errors.
		{"identifier sanitized on coded field",
			map[string]any{"code": "E_SECRET_MISSING", "secret": "GITHUB_TOKEN; DROP TABLE"}, Context{},
			Result{"Missing secret: GITHUB_TOKENDROPTABLE", "secret_missing", "ops"}},
		{"http by statusCode field", map[string]any{"message": "boom", "statusCode": float64(503)}, Context{NodeType: "http"},
			Result{"HTTP 503 on http node", "http_error", "workflow_author"}},
		{"http by message", "request failed: HTTP 401 from upstream", Context{NodeType: "http"},
			Result{"HTTP 401 on http node", "http_error", "workflow_author"}},
		{"network timeout", "connect ETIMEDOUT 10.0.0.1:443", Context{NodeType: "http"},
			Result{"Network timeout on http node", "network_timeout", "workflow_author"}},
		{"generic rate limit without ai context", "Rate limit exceeded for llm. Retry in 30s.", Context{NodeType: "tool"},
			Result{"Rate limited on tool node", "http_error", "workflow_author"}},
		{"rate limit WITH ai context goes to provider rule", map[string]any{"message": "rate limit exceeded", "provider": "anthropic"}, Context{NodeType: "ai"},
			Result{"Anthropic rate limit", "ai_provider", "platform"}},
		{"http guard", "HTTP response exceeds maxResponseBytes after 2048 bytes (cap 1024)", Context{NodeType: "http"},
			Result{"HTTP guard failed on http node", "http_error", "workflow_author"}},
		{"parse error", "Unexpected token < in JSON at position 0", Context{NodeType: "transform"},
			Result{"Parse error in transform node", "parse_error", "workflow_author"}},
		{"tool not found", "Tool 'json.fetch' not found", Context{},
			Result{"Tool not found: json.fetch", "tool_input", "workflow_author"}},
		{"invalid tool input", "Invalid tool input: github.create_issue", Context{},
			Result{"Invalid tool input: github.create_issue", "tool_input", "workflow_author"}},
		// Reference quirk faithfully reproduced: a tool NAMED json.parse trips
		// the parse-error rule (priority 5, case-insensitive `JSON\.parse`)
		// before the tool-input rule ever runs — same outcome in Node.
		{"json.parse tool errors cluster as parse_error", "Invalid tool input for json.parse: value: Required", Context{ToolName: "json.parse"},
			Result{"Parse error in node node", "parse_error", "workflow_author"}},
		{"fallback truncates", strings.Repeat("x", 120), Context{},
			Result{strings.Repeat("x", 79) + "…", "unknown", "workflow_author"}},
		{"nil error", nil, Context{}, Result{"Unknown error", "unknown", "workflow_author"}},
	}
	for _, tc := range cases {
		if got := Normalize(tc.err, tc.ctx); got != tc.want {
			t.Fatalf("%s:\n got %+v\nwant %+v", tc.name, got, tc.want)
		}
	}
}

// The RE2 port of the boundary lookaheads must behave like the reference:
// open-ended bodies redact greedily; fixed-length shapes need a real
// boundary; the fine-grained GitHub PAT spans its internal underscore.
func TestScrubSecretShapes(t *testing.T) {
	cases := []struct{ in, want string }{
		{"key sk-" + strings.Repeat("a", 24) + " leaked", "key [redacted] leaked"},
		{"pat github_pat_" + strings.Repeat("a", 22) + "_" + strings.Repeat("b", 59) + " done", "pat [redacted] done"},
		{"aws AKIAIOSFODNN7EXAMPLE!", "aws [redacted]!"},
		// 17 uppercase chars after AKIA: NOT a key id (boundary must hold).
		{"id AKIAIOSFODNN7EXAMPLEX", "id AKIAIOSFODNN7EXAMPLEX"},
		{"auth Bearer abcdefghijklmnop.qrstuvwxyz done", "auth [redacted] done"},
		{"jwt eyJ" + strings.Repeat("a", 12) + "." + strings.Repeat("b", 12) + "." + strings.Repeat("c", 12), "jwt [redacted]"},
		{"slack xoxb-1234567890-abc", "slack [redacted]"},
		{"clean message, no tokens", "clean message, no tokens"},
	}
	for _, tc := range cases {
		if got := ScrubSecretShapes(tc.in); got != tc.want {
			t.Fatalf("scrub(%q):\n got %q\nwant %q", tc.in, got, tc.want)
		}
	}
}

func TestClusterFailureSamples(t *testing.T) {
	at := func(min int) time.Time { return time.Date(2026, 7, 30, 10, min, 0, 0, time.UTC) }
	httpErr := []byte(`{"message":"boom","statusCode":500}`)
	samples := []FailureSample{
		// Same (run, node) from both surfaces → ONE event, DLQ preferred.
		{Source: "failed_run_node", ID: "r1:call", RunID: "r1", NodeID: "call",
			WorkflowID: "wf-a", WorkflowName: "Flow A", NodeType: "http", ErrorJSON: httpErr, CreatedAt: at(1)},
		{Source: "dead_letter", ID: "dl-1", RunID: "r1", NodeID: "call",
			WorkflowID: "wf-a", WorkflowName: "Flow A", NodeType: "http", ErrorJSON: httpErr, CreatedAt: at(2)},
		// Second workflow, same signature.
		{Source: "dead_letter", ID: "dl-2", RunID: "r2", NodeID: "call",
			WorkflowID: "wf-b", WorkflowName: "Flow B", NodeType: "http", ErrorJSON: httpErr, CreatedAt: at(3)},
		{Source: "dead_letter", ID: "dl-3", RunID: "r3", NodeID: "call",
			WorkflowID: "wf-b", WorkflowName: "Flow B", NodeType: "http", ErrorJSON: httpErr, CreatedAt: at(4)},
		// Different signature clusters separately.
		{Source: "dead_letter", ID: "dl-4", RunID: "r4", NodeID: "wait",
			WorkflowID: "wf-a", WorkflowName: "Flow A", NodeType: "http",
			ErrorJSON: []byte(`{"message":"connect ETIMEDOUT"}`), CreatedAt: at(5)},
	}
	clusters := ClusterFailureSamples(samples)
	if len(clusters) != 2 {
		t.Fatalf("want 2 clusters, got %+v", clusters)
	}
	top := clusters[0]
	if top.Signature != "HTTP 500 on http node" || top.Frequency != 3 {
		t.Fatalf("dedup must collapse dual-surface samples: %+v", top)
	}
	if top.Samples[0].Source != "dead_letter" || top.Samples[0].ID != "dl-1" {
		t.Fatalf("DLQ source must win the dedup: %+v", top.Samples)
	}
	if top.AffectedWorkflows[0].WorkflowID != "wf-b" || top.AffectedWorkflows[0].Count != 2 {
		t.Fatalf("workflows must sort by count desc: %+v", top.AffectedWorkflows)
	}
	if top.FirstSeen != "2026-07-30T10:02:00.000Z" || top.LastSeen != "2026-07-30T10:04:00.000Z" {
		t.Fatalf("seen range: %+v", top)
	}
	if clusters[1].Signature != "Network timeout on http node" || clusters[1].Frequency != 1 {
		t.Fatalf("second cluster: %+v", clusters[1])
	}
}
