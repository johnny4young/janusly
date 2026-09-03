//go:build integration

package httpapi

import (
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/prompts"
)

// The PromptOps loop: create → version → resolve latest → pin an older
// version and the ACTIVE prompt changes with no redeploy — plus the
// resolver's include/variable semantics and the fallback contract when
// the registry lacks the name.
func TestPromptOpsHotSwapAndResolver(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()

	// Create + two versions through the wire.
	if res := h.call("POST", "/prompts", map[string]any{"name": "triage"}, ""); res.status != 201 {
		t.Fatalf("create: %d %+v", res.status, res.body)
	}
	if res := h.call("POST", "/prompts", map[string]any{"name": "triage"}, ""); res.status != 409 {
		t.Fatalf("duplicate name must 409: %d", res.status)
	}
	v1 := h.call("POST", "/prompts/triage/versions", map[string]any{
		"templateText": "v1: resume {{var.topic}}",
		"variables":    []any{map[string]any{"name": "topic", "required": true}},
	}, "")
	if v1.status != 201 {
		t.Fatalf("v1: %d %+v", v1.status, v1.body)
	}
	v2 := h.call("POST", "/prompts/triage/versions", map[string]any{
		"templateText": "v2: analiza {{var.topic}} con {{include.tono}} y {{include.tono}}",
	}, "")
	if v2.status != 201 {
		t.Fatalf("v2: %d %+v", v2.status, v2.body)
	}
	// The include target.
	if res := h.call("POST", "/prompts", map[string]any{"name": "tono"}, ""); res.status != 201 {
		t.Fatalf("tono: %d", res.status)
	}
	if res := h.call("POST", "/prompts/tono/versions", map[string]any{
		"templateText": "tono profesional",
	}, ""); res.status != 201 {
		t.Fatalf("tono v1: %d", res.status)
	}

	// Latest wins by default; includes and variables resolve.
	resolved, err := prompts.ResolveTemplate(ctx, pool, h.org, "triage", 0, map[string]string{"topic": "errores"})
	if err != nil {
		t.Fatalf("resolve latest: %v", err)
	}
	if resolved != "v2: analiza errores con tono profesional y tono profesional" {
		t.Fatalf("latest resolution: %q", resolved)
	}

	// HOT-SWAP: pin v1 — the active prompt changes without any redeploy.
	if res := h.call("POST", "/prompts/triage/versions/1/pin", nil, ""); res.status != 200 {
		t.Fatalf("pin: %d %+v", res.status, res.body)
	}
	resolved, err = prompts.ResolveTemplate(ctx, pool, h.org, "triage", 0, map[string]string{"topic": "errores"})
	if err != nil || resolved != "v1: resume errores" {
		t.Fatalf("pinned resolution must swap hot: %q (%v)", resolved, err)
	}

	// A missing required variable fails BEFORE any LLM spend.
	if _, err := prompts.ResolveTemplate(ctx, pool, h.org, "triage", 0, nil); err == nil ||
		!strings.Contains(err.Error(), `"topic"`) {
		t.Fatalf("missing required variable must fail fast: %v", err)
	}

	// Registry miss: ErrPromptNotFound — the consumer's cue to fall back
	// to its embedded literal.
	if _, err := prompts.ResolveTemplate(ctx, pool, h.org, "ghost", 0, nil); err != prompts.ErrPromptNotFound {
		t.Fatalf("missing prompt must signal fallback: %v", err)
	}

	// Include cycle rejection.
	if res := h.call("POST", "/prompts/tono/versions", map[string]any{
		"templateText": "ciclo {{include.triage}}",
	}, ""); res.status != 201 {
		t.Fatalf("cycle version: %d", res.status)
	}
	if _, err := prompts.ResolveTemplate(ctx, pool, h.org, "triage", 2, map[string]string{"topic": "x"}); err == nil ||
		!strings.Contains(err.Error(), "cycle") {
		t.Fatalf("cycles must reject: %v", err)
	}

	// The three audit rows landed.
	for _, action := range []string{"prompt.created", "prompt.version_created", "prompt.version_pinned"} {
		if got := countAudit(t, pool, h.org, action); got == 0 {
			t.Fatalf("%s must audit", action)
		}
	}
}

func TestPromptOpsWriteContractRejectsUnaddressableNamesAndVariables(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)

	for _, name := range []string{" triage", ".hidden", "triage/es", "triagé", strings.Repeat("x", 129)} {
		res := h.call("POST", "/prompts", map[string]any{"name": name}, "")
		if res.status != 400 || res.body["code"] != "prompts_name_invalid" {
			t.Fatalf("invalid prompt name %q: %d %+v", name, res.status, res.body)
		}
	}

	if res := h.call("POST", "/prompts", map[string]any{
		"name": "unicode-description", "description": strings.Repeat("á", promptDescriptionMax),
	}, ""); res.status != 201 {
		t.Fatalf("description at character limit: %d %+v", res.status, res.body)
	}
	if res := h.call("POST", "/prompts", map[string]any{
		"name": "long-description", "description": strings.Repeat("á", promptDescriptionMax+1),
	}, ""); res.status != 400 || res.body["code"] != "prompts_description_too_long" {
		t.Fatalf("description over character limit: %d %+v", res.status, res.body)
	}

	if res := h.call("POST", "/prompts", map[string]any{"name": "strict-vars"}, ""); res.status != 201 {
		t.Fatalf("create strict-vars: %d %+v", res.status, res.body)
	}
	invalidVariables := []any{
		nil,
		map[string]any{"name": "topic"},
		[]any{map[string]any{"name": "topic", "unknown": true}},
		[]any{map[string]any{"name": "topic"}, map[string]any{"name": "topic"}},
		[]any{map[string]any{"name": "topic/id"}},
		[]any{map[string]any{"name": "topic", "default": strings.Repeat("x", prompts.MaxVariableDefaultBytes+1)}},
	}
	for i, variables := range invalidVariables {
		res := h.call("POST", "/prompts/strict-vars/versions", map[string]any{
			"templateText": "Analyze {{var.topic}}", "variables": variables,
		}, "")
		if res.status != 400 || res.body["code"] != "prompts_variables_invalid" {
			t.Fatalf("invalid variables case %d: %d %+v", i, res.status, res.body)
		}
	}

	if res := h.call("POST", "/prompts/.hidden/versions", map[string]any{
		"templateText": "never persisted",
	}, ""); res.status != 400 || res.body["code"] != "prompts_name_invalid" {
		t.Fatalf("invalid path name: %d %+v", res.status, res.body)
	}
}

func TestPromptOpsResolutionBoundsIncludeWorkAndOutput(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	pool := testPool(t)
	ctx := t.Context()

	create := func(name, template string) {
		t.Helper()
		if res := h.call("POST", "/prompts", map[string]any{"name": name}, ""); res.status != 201 {
			t.Fatalf("create %s: %d %+v", name, res.status, res.body)
		}
		if res := h.call("POST", "/prompts/"+name+"/versions", map[string]any{
			"templateText": template,
		}, ""); res.status != 201 {
			t.Fatalf("version %s: %d %+v", name, res.status, res.body)
		}
	}

	create("large-piece", strings.Repeat("x", promptTemplateMax))
	create("large-parent", strings.Repeat("{{include.large-piece}}", 5))
	if _, err := prompts.ResolveTemplate(ctx, pool, h.org, "large-parent", 0, nil); err == nil ||
		!strings.Contains(err.Error(), "resolved prompt exceeds") {
		t.Fatalf("include amplification must reject: %v", err)
	}

	create("small-piece", "x")
	create("many-parent", strings.Repeat("{{include.small-piece}}", prompts.MaxIncludeReferences+1))
	if _, err := prompts.ResolveTemplate(ctx, pool, h.org, "many-parent", 0, nil); err == nil ||
		!strings.Contains(err.Error(), "includes exceed") {
		t.Fatalf("include work cap must reject: %v", err)
	}
}
