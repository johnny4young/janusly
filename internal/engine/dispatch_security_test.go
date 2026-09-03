package engine

import "testing"

func TestAuthoredAgentWritesOptInRejectsRuntimeBindings(t *testing.T) {
	if !authoredAgentWritesOptIn(map[string]any{"allowWriteTools": true}) {
		t.Fatal("literal authored boolean must opt in")
	}
	for name, config := range map[string]map[string]any{
		"missing":  {},
		"false":    {"allowWriteTools": false},
		"template": {"allowWriteTools": "{{context.input.allowWrites}}"},
		"string":   {"allowWriteTools": "true"},
		"number":   {"allowWriteTools": float64(1)},
	} {
		t.Run(name, func(t *testing.T) {
			if authoredAgentWritesOptIn(config) {
				t.Fatal("only a literal authored boolean may opt in")
			}
		})
	}
}

func TestLiteralAgentHTTPRequestsRejectsDataBoundTargets(t *testing.T) {
	raw := map[string]any{
		"url": " https://status.example.com/v1 ",
		"input": map[string]any{
			"url": "{{context.input.callbackUrl}}",
		},
	}
	rendered := map[string]any{
		"url": " https://status.example.com/v1 ",
		"input": map[string]any{
			"url": "https://attacker.example/exfiltrate",
		},
	}

	allowed := literalAgentHTTPRequests(raw, rendered)
	request, ok := allowed["https://status.example.com/v1"]
	if len(allowed) != 1 || !ok || request["url"] != "https://status.example.com/v1" {
		t.Fatalf("literal targets: %+v", allowed)
	}
	for _, forbidden := range []string{
		"https://attacker.example/exfiltrate", "https://attacker.example/unsafe",
	} {
		if _, ok := allowed[forbidden]; ok {
			t.Fatalf("data-bound target gained planner authority: %s", forbidden)
		}
	}

	explicit := literalAgentHTTPRequests(
		map[string]any{"tool": "http.request", "input": map[string]any{
			"url": "https://audit.example.com/check", "method": "HEAD",
		}},
		map[string]any{"tool": "http.request", "input": map[string]any{
			"url": "https://audit.example.com/check", "method": "HEAD",
		}},
	)
	if explicit["https://audit.example.com/check"]["method"] != "HEAD" {
		t.Fatalf("explicit authored request: %+v", explicit)
	}
}

func TestLiteralMultiAgentHTTPRequestsStayPerChild(t *testing.T) {
	raw := map[string]any{"agents": []any{
		map[string]any{"tool": "http.request", "input": map[string]any{"url": "https://one.example/api", "method": "GET"}},
		map[string]any{"tool": "http.request", "input": map[string]any{"url": "{{context.input.callback}}", "method": "POST"}},
	}}
	rendered := map[string]any{"agents": []any{
		map[string]any{"tool": "http.request", "input": map[string]any{"url": "https://one.example/api", "method": "GET"}},
		map[string]any{"tool": "http.request", "input": map[string]any{"url": "https://one.example/api", "method": "POST"}},
	}}

	grants := literalMultiAgentHTTPRequests(raw, rendered)
	if len(grants) != 2 || grants[0]["https://one.example/api"]["method"] != "GET" {
		t.Fatalf("first child grant: %+v", grants)
	}
	if len(grants[1]) != 0 {
		t.Fatalf("templated second-child target borrowed sibling authority: %+v", grants[1])
	}
}
