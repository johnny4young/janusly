//go:build integration

package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/secretstore"
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
	for _, required := range []string{credentialName, childID, "contacts.update", "text.uppercase", "time.now", "http.request", "csv.fetch", "wait_until", "mcp_event", "pagerduty"} {
		if !strings.Contains(serialized, required) {
			t.Fatalf("capability catalog missing %q: %s", required, serialized)
		}
	}
}

func TestAuthoringContractFirstVersionedAliases(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	h := newAPIHarnessWithoutWorkers(t)
	prompt := "Call an HTTP API, transform the JSON, and uppercase one field with a backend tool"

	compiled := h.call("POST", "/v1/ai/workflow-briefs/compile", map[string]any{"prompt": prompt}, "")
	requireEnvelope(t, compiled)
	if compiled.status != http.StatusOK {
		t.Fatalf("versioned compile: %d %+v", compiled.status, compiled.body)
	}
	compiledData, _ := compiled.body["data"].(map[string]any)
	if compiledData["mode"] != "deterministic" || compiledData["complete"] != true {
		t.Fatalf("versioned compile payload: %+v", compiledData)
	}

	catalog := h.call("GET", "/v1/authoring/capabilities", nil, "")
	catalogData, _ := catalog.body["data"].(map[string]any)
	proposal := h.call("POST", "/v1/ai/workflow-proposals", map[string]any{
		"prompt": prompt, "brief": compiledData["brief"],
		"catalogVersion": catalogData["version"],
	}, "")
	requireEnvelope(t, proposal)
	if proposal.status != http.StatusOK {
		t.Fatalf("versioned proposal: %d %+v", proposal.status, proposal.body)
	}
	proposalData, _ := proposal.body["data"].(map[string]any)
	bindings, _ := proposalData["bindings"].(map[string]any)
	proposed, _ := proposalData["proposal"].(map[string]any)
	if proposalData["mode"] != "fallback" || bindings["complete"] != true || proposed["applicable"] != true {
		t.Fatalf("versioned proposal payload: %+v", proposalData)
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

func TestWorkflowProposalSkipsProviderForStaleCatalog(t *testing.T) {
	var calls atomic.Int64
	simulator := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, anthropicReply(`{"dslVersion":"1.0","id":"must-not-run","nodes":[],"edges":[]}`))
	}))
	t.Cleanup(simulator.Close)
	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LLM_SIMULATED_PROVIDERS", "anthropic")
	t.Setenv("JANUSLY_LLM_SIMULATOR_BASE_URL", simulator.URL)
	h := newAPIHarnessWithoutWorkers(t)

	res := h.call("POST", "/ai/workflow-proposals", map[string]any{
		"prompt":         "Call an HTTP API, transform the JSON, and uppercase one field with a backend tool",
		"catalogVersion": "stale-catalog",
	}, "")
	if res.status != http.StatusOK || res.body["mode"] != "fallback" || calls.Load() != 0 {
		t.Fatalf("stale catalog reached provider: status=%d calls=%d body=%+v", res.status, calls.Load(), res.body)
	}
	bindings := res.body["bindings"].(map[string]any)
	proposal := res.body["proposal"].(map[string]any)
	if bindings["complete"] != false || proposal["applicable"] != false ||
		!strings.Contains(fmt.Sprint(bindings["missing"]), "capability_catalog_changed") {
		t.Fatalf("stale catalog must remain explicit and unappliable: %+v", res.body)
	}
	workflow := proposal["workflow"].(map[string]any)
	if workflow["id"] != "capability-binding-required" {
		t.Fatalf("stale catalog must not return executable provider output: %+v", workflow)
	}
}

func TestWorkflowProposalProviderFreeBuildsExactPagerDutyFlagship(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	secretstore.ResetForTests()
	t.Cleanup(secretstore.ResetForTests)
	t.Setenv("JANUSLY_CREDENTIAL_MASTER_KEY",
		base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
	h := newAPIHarnessWithoutWorkers(t)
	suffix := fmt.Sprint(time.Now().UnixNano())
	apiCredential := "pagerduty-api-" + suffix
	webhookCredential := "pagerduty-webhook-" + suffix
	prompt := strings.Repeat("Bounded operator context without executable authority. ", 30) +
		fmt.Sprintf("Starting now for one week, when PagerDuty alerts user PLOCALUSER outside working hours 09:00 to 17:00 in America/Bogota, acknowledge it and snooze it for 12 hours. Use API credential %s and webhook credential %s for operator@example.com.", apiCredential, webhookCredential)
	for _, credential := range []map[string]any{
		{"name": apiCredential, "kind": "pagerduty_api_token", "secretValue": "test-api-token-" + suffix},
		{"name": webhookCredential, "kind": "pagerduty_webhook_secret", "secretValue": "test-webhook-secret-" + suffix},
	} {
		if res := h.call("POST", "/credentials", credential, ""); res.status != http.StatusOK {
			t.Fatalf("seed credential: %d %+v", res.status, res.body)
		}
	}
	compiled := h.call("POST", "/ai/workflow-briefs/compile", map[string]any{"prompt": prompt}, "")
	if compiled.status != http.StatusOK {
		t.Fatalf("compile: %d %+v", compiled.status, compiled.body)
	}
	brief := compiled.body["brief"].(map[string]any)
	if brief["trigger"] != "pagerduty" || !strings.Contains(fmt.Sprint(brief["externalEffects"]), "pagerduty_snooze") {
		t.Fatalf("PagerDuty intent lost at brief boundary: %+v", brief)
	}
	catalog := h.call("GET", "/v1/authoring/capabilities", nil, "")
	catalogData := catalog.body["data"].(map[string]any)
	if !strings.Contains(fmt.Sprint(catalogData["triggers"]), "pagerduty") {
		t.Fatalf("catalog omitted PagerDuty trigger: %+v", catalogData["triggers"])
	}
	res := h.call("POST", "/ai/workflow-proposals", map[string]any{
		"prompt": prompt, "brief": brief, "catalogVersion": catalogData["version"],
	}, "")
	if res.status != http.StatusOK || res.body["mode"] != "fallback" {
		t.Fatalf("proposal: %d %+v", res.status, res.body)
	}
	if _, present := res.body["aiError"]; present {
		t.Fatal("canonical local PagerDuty proposal must not report a provider error")
	}
	bindings := res.body["bindings"].(map[string]any)
	proposal := res.body["proposal"].(map[string]any)
	if bindings["complete"] != true || proposal["applicable"] != true {
		t.Fatalf("exact seeded bindings should allow Apply: bindings=%+v proposal=%+v", bindings, proposal)
	}
	workflow := proposal["workflow"].(map[string]any)
	if !regexp.MustCompile(`^pagerduty_off_hours_[a-f0-9]{32}$`).MatchString(fmt.Sprint(workflow["id"])) {
		t.Fatalf("workflow id=%v", workflow["id"])
	}
	if nodes, ok := workflow["nodes"].([]any); !ok || len(nodes) != 11 {
		t.Fatalf("canonical nodes=%+v", workflow["nodes"])
	}
	if outputs, ok := workflow["outputs"].(map[string]any); !ok || outputs["result"] != "{{context.outcome_projection.output}}" {
		t.Fatalf("flagship intent projection=%+v", workflow["outputs"])
	}
	qualification := proposal["qualification"].(map[string]any)
	if qualification["intent"] != true || qualification["recovery"] != true || qualification["semantic"] != true {
		t.Fatalf("flagship assurance qualification=%+v", qualification)
	}
	var audits int
	if err := testPool(t).QueryRow(t.Context(), `SELECT count(*) FROM audit_logs
		WHERE org_id=$1 AND target_id=$2 AND action='ai.workflow.generated'
		  AND metadata @> '{"mode":"fallback","generationMode":"deterministic_recipe","recipe":"pagerduty_on_call"}'::jsonb`,
		h.org, workflow["id"]).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if audits != 1 {
		t.Fatalf("canonical recipe audit rows=%d", audits)
	}
}

func TestWorkflowProposalRejectsIncompleteBriefBeforeProvider(t *testing.T) {
	var calls atomic.Int64
	simulator := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, anthropicReply(`{"dslVersion":"1.0","id":"must-not-run","nodes":[],"edges":[]}`))
	}))
	t.Cleanup(simulator.Close)
	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LLM_SIMULATED_PROVIDERS", "anthropic")
	t.Setenv("JANUSLY_LLM_SIMULATOR_BASE_URL", simulator.URL)
	h := newAPIHarnessWithoutWorkers(t)

	res := h.call("POST", "/ai/workflow-proposals", map[string]any{"prompt": "Draft a flow"}, "")
	params, _ := res.body["params"].(map[string]any)
	questions, _ := params["clarifyingQuestions"].([]any)
	if res.status != http.StatusUnprocessableEntity || res.body["code"] != "authoring_brief_incomplete" ||
		len(questions) == 0 || len(questions) > 3 || calls.Load() != 0 {
		t.Fatalf("incomplete brief reached provider: status=%d calls=%d body=%+v", res.status, calls.Load(), res.body)
	}

	pagerDutyIntent := "Starting now for one week, when PagerDuty alerts user PUSER1 outside working hours 09:00 to 17:00 in America/Bogota, acknowledge it and snooze it for 12 hours as operator@example.com."
	res = h.call("POST", "/ai/workflow-proposals", map[string]any{"brief": map[string]any{
		"objective": pagerDutyIntent, "trigger": "pagerduty", "expectedOutcome": pagerDutyIntent,
		"externalEffects": []any{}, "language": "en",
	}}, "")
	params, _ = res.body["params"].(map[string]any)
	questions, _ = params["clarifyingQuestions"].([]any)
	if res.status != http.StatusUnprocessableEntity || res.body["code"] != "authoring_brief_incomplete" ||
		len(questions) != 1 || !strings.Contains(fmt.Sprint(questions), "Declare both external effects") || calls.Load() != 0 {
		t.Fatalf("undeclared PagerDuty effects reached provider: status=%d calls=%d body=%+v", res.status, calls.Load(), res.body)
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
		"prompt": "Use tool crm.super_power to prepare a report; if it is unavailable, leave an explicit missing binding",
	}, "")
	if res.status != http.StatusOK || res.body["mode"] != "fallback" || res.body["providerGuarded"] != true || calls.Load() != 1 {
		t.Fatalf("provider proposal: status=%d calls=%d body=%+v", res.status, calls.Load(), res.body)
	}
	bindings := res.body["bindings"].(map[string]any)
	proposal := res.body["proposal"].(map[string]any)
	if bindings["complete"] != false || proposal["applicable"] != false {
		t.Fatalf("invented capability must be visible and unappliable: %+v", res.body)
	}
	workflowText := fmt.Sprintf("%v", proposal["workflow"])
	if strings.Contains(workflowText, "crm.super_power") || !strings.Contains(workflowText, "capability-binding-required") {
		t.Fatalf("unsafe provider graph must be discarded, got %s", workflowText)
	}
	missing := fmt.Sprintf("%v", bindings["missing"])
	if !strings.Contains(missing, "crm.super_power") || !strings.Contains(missing, "requested_tool_not_in_catalog") ||
		!strings.Contains(missing, "unsafe_provider_capability_reference") || strings.Contains(missing, "exact_tool_not_found") {
		t.Fatalf("missing binding must come from intent plus the provider guard, without retaining the unsafe graph: %s", missing)
	}

	compatibility := h.call("POST", "/ai/generate-workflow", map[string]any{
		"prompt": "Use tool crm.super_power to prepare a report; if it is unavailable, leave an explicit missing binding",
	}, "")
	if compatibility.status != http.StatusOK || compatibility.body["mode"] != "fallback" ||
		compatibility.body["providerGuarded"] != true || calls.Load() != 2 {
		t.Fatalf("compatibility guard: status=%d calls=%d body=%+v", compatibility.status, calls.Load(), compatibility.body)
	}
	compatibilityNodes, _ := json.Marshal(compatibility.body["nodes"])
	if strings.Contains(string(compatibilityNodes), "crm.super_power") ||
		!strings.Contains(fmt.Sprintf("%v", compatibility.body["bindings"]), "unsafe_provider_capability_reference") {
		t.Fatalf("compatibility endpoint leaked an executable invented identity: nodes=%s body=%+v", compatibilityNodes, compatibility.body)
	}
	var guardedAudits int
	if err := testPool(t).QueryRow(t.Context(), `SELECT count(*) FROM audit_logs
		WHERE org_id=$1 AND action='ai.workflow.proposal_guarded'
		  AND metadata->>'reason'='unsafe_provider_capability_reference'`, h.org).Scan(&guardedAudits); err != nil {
		t.Fatal(err)
	}
	if guardedAudits != 2 {
		t.Fatalf("both product surfaces must audit the deterministic guard without the rejected ID: %d", guardedAudits)
	}
	var leakedAuditMetadata int
	if err := testPool(t).QueryRow(t.Context(), `SELECT count(*) FROM audit_logs
		WHERE org_id=$1 AND action='ai.workflow.proposal_guarded'
		  AND metadata::text LIKE '%crm.super_power%'`, h.org).Scan(&leakedAuditMetadata); err != nil {
		t.Fatal(err)
	}
	if leakedAuditMetadata != 0 {
		t.Fatalf("guard audit must record only bounded reason metadata, leaked rows=%d", leakedAuditMetadata)
	}
}

func TestWorkflowProposalPreservesConfigurationOnlyIncompleteAIGraph(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	incomplete := `{"dslVersion":"1.0","id":"known-tool-incomplete","name":"Known tool","outputs":{"result":"{{context.call.output}}"},"nodes":[{"id":"call","type":"tool","config":{"tool":"text.uppercase","input":{}}}],"edges":[]}`
	var calls atomic.Int64
	simulator := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, anthropicReply(incomplete))
	}))
	t.Cleanup(simulator.Close)
	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LLM_SIMULATED_PROVIDERS", "anthropic")
	t.Setenv("JANUSLY_LLM_SIMULATOR_BASE_URL", simulator.URL)

	res := h.call("POST", "/ai/workflow-proposals", map[string]any{
		"prompt": "Use tool text.uppercase to prepare the result",
		"brief":  map[string]any{"externalEffects": []any{}},
	}, "")
	if res.status != http.StatusOK || res.body["mode"] != "ai" || calls.Load() != 1 {
		t.Fatalf("configuration-only proposal: status=%d calls=%d body=%+v", res.status, calls.Load(), res.body)
	}
	if res.body["providerGuarded"] != nil {
		t.Fatalf("configuration-only gaps must not discard the AI graph: %+v", res.body)
	}
	bindings := res.body["bindings"].(map[string]any)
	proposal := res.body["proposal"].(map[string]any)
	workflow := proposal["workflow"].(map[string]any)
	if bindings["complete"] != false || proposal["applicable"] != false || workflow["id"] != "known-tool-incomplete" ||
		!strings.Contains(fmt.Sprintf("%v", bindings["missing"]), "tool_input_required") {
		t.Fatalf("known incomplete graph should remain reviewable and blocked: %+v", res.body)
	}
}
