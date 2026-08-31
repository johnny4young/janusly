//go:build integration

package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestAuthoringCapabilityCatalogIsExactAndSecretFree(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	h := newAPIHarnessWithoutWorkers(t)
	// Resolve dev identity/org before seeding tenant-owned rows.
	if res := h.call("POST", "/ai/workflow-briefs/compile", map[string]any{"prompt": "Create a manual transform"}, ""); res.status != http.StatusOK {
		t.Fatalf("bootstrap: %d %+v", res.status, res.body)
	}
	pool := testPool(t)
	suffix := fmt.Sprint(time.Now().UnixNano())
	credentialName := "safe-slack-" + suffix
	secretRef := "DO_NOT_EXPOSE_SECRET_REF_" + suffix
	if _, err := pool.Exec(t.Context(), `INSERT INTO credentials
		(id, org_id, name, kind, secret_ref, metadata, created_by)
		VALUES ($1,$2,$3,'slack_webhook',$4,$5,'api-tester')`,
		"cred-"+suffix, h.org, credentialName, secretRef, `{"token":"DO_NOT_EXPOSE_METADATA"}`); err != nil {
		t.Fatal(err)
	}
	childID := "wf-child-" + suffix
	child := map[string]any{
		"dslVersion": "1.0", "id": childID, "name": "Exact child",
		"nodes": []any{map[string]any{"id": "done", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}
	if res := h.call("POST", "/v1/workflows/save", child, ""); res.status != http.StatusOK {
		t.Fatalf("save child: %d %+v", res.status, res.body)
	}
	connectionID := "mcp-authoring-" + suffix
	if _, err := pool.Exec(t.Context(), `INSERT INTO mcp_connections
		(id,org_id,alias,transport,args,env_refs,enabled,status,expose_to_ai,created_by)
		VALUES ($1,$2,'crm','http','[]','{}',true,'active',true,'api-tester')`, connectionID, h.org); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO mcp_tool_descriptors
		(id,connection_id,name,description,input_schema,write_side,enabled,expose_to_ai)
		VALUES ($1,$2,'contacts.update','Update contact','{"type":"object"}',true,true,true)`, connectionID+"-tool", connectionID); err != nil {
		t.Fatal(err)
	}

	res := h.call("GET", "/v1/authoring/capabilities", nil, "")
	if res.status != http.StatusOK {
		t.Fatalf("catalog: %d %+v", res.status, res.body)
	}
	data, _ := res.body["data"].(map[string]any)
	if len(fmt.Sprint(data["version"])) != 64 {
		t.Fatalf("catalog digest: %+v", data["version"])
	}
	serialized := fmt.Sprintf("%v", data)
	for _, forbidden := range []string{secretRef, "DO_NOT_EXPOSE_METADATA", "secretRef"} {
		if strings.Contains(serialized, forbidden) {
			t.Fatalf("capability catalog leaked %q: %s", forbidden, serialized)
		}
	}
	for _, required := range []string{credentialName, childID, "contacts.update", "text.uppercase", "wait_until", "mcp_event"} {
		if !strings.Contains(serialized, required) {
			t.Fatalf("capability catalog missing %q: %s", required, serialized)
		}
	}
}

func TestWorkflowProposalProviderFreeDoesNotMutateCanvasOrPersistence(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	h := newAPIHarnessWithoutWorkers(t)
	compile := h.call("POST", "/ai/workflow-briefs/compile", map[string]any{
		"prompt": "Call an HTTP API, transform the JSON, and uppercase one field with a backend tool",
	}, "")
	if compile.status != http.StatusOK || compile.body["mode"] != "deterministic" {
		t.Fatalf("compile: %d %+v", compile.status, compile.body)
	}
	brief := compile.body["brief"]
	catalog := h.call("GET", "/v1/authoring/capabilities", nil, "")
	catalogData := catalog.body["data"].(map[string]any)
	res := h.call("POST", "/ai/workflow-proposals", map[string]any{
		"brief": brief, "catalogVersion": catalogData["version"],
	}, "")
	if res.status != http.StatusOK || res.body["mode"] != "fallback" {
		t.Fatalf("provider-free proposal: %d %+v", res.status, res.body)
	}
	if _, present := res.body["aiError"]; present {
		t.Fatal("no-provider proposal must not pretend a provider failed")
	}
	bindings := res.body["bindings"].(map[string]any)
	proposal := res.body["proposal"].(map[string]any)
	if bindings["complete"] != true || proposal["applicable"] != true {
		t.Fatalf("safe fallback should be applicable: bindings=%+v proposal=%+v", bindings, proposal)
	}
	workflow := proposal["workflow"].(map[string]any)
	if workflow["id"] != "api-transform-tool" {
		t.Fatalf("compatibility template: %+v", workflow["id"])
	}
	var persisted int
	_ = testPool(t).QueryRow(t.Context(), `SELECT count(*) FROM workflows WHERE org_id=$1 AND id=$2`, h.org, workflow["id"]).Scan(&persisted)
	if persisted != 0 {
		t.Fatalf("proposal endpoint must not save or mutate business state: %d", persisted)
	}

	stale := h.call("POST", "/ai/workflow-proposals", map[string]any{
		"brief": brief, "catalogVersion": "stale-catalog",
	}, "")
	staleProposal := stale.body["proposal"].(map[string]any)
	if staleProposal["applicable"] != false {
		t.Fatalf("stale catalog proposal must require regeneration: %+v", stale.body)
	}
}

func TestWorkflowProposalRejectsProviderInventedCapability(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	invented := `{"dslVersion":"1.0","id":"invented","name":"Invented","outputs":{"result":"{{context.call.output}}"},"nodes":[{"id":"call","type":"tool","config":{"tool":"crm.super_power","input":{}}}],"edges":[]}`
	var calls atomic.Int64
	simulator := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, anthropicReply(invented))
	}))
	t.Cleanup(simulator.Close)
	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LLM_SIMULATED_PROVIDERS", "anthropic")
	t.Setenv("JANUSLY_LLM_SIMULATOR_BASE_URL", simulator.URL)

	res := h.call("POST", "/ai/workflow-proposals", map[string]any{
		"prompt": "Use the CRM super power to prepare a report",
	}, "")
	if res.status != http.StatusOK || res.body["mode"] != "ai" || calls.Load() != 1 {
		t.Fatalf("provider proposal: status=%d calls=%d body=%+v", res.status, calls.Load(), res.body)
	}
	bindings := res.body["bindings"].(map[string]any)
	proposal := res.body["proposal"].(map[string]any)
	if bindings["complete"] != false || proposal["applicable"] != false {
		t.Fatalf("invented capability must be visible and unappliable: %+v", res.body)
	}
	missing := fmt.Sprintf("%v", bindings["missing"])
	if !strings.Contains(missing, "crm.super_power") || !strings.Contains(missing, "exact_tool_not_found") {
		t.Fatalf("missing binding must preserve the rejected ID: %s", missing)
	}
}
