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
		"templateText": "v2: analiza {{var.topic}} con {{include.tono}}",
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
	if resolved != "v2: analiza errores con tono profesional" {
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
