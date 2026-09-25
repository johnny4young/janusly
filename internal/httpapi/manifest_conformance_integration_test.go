//go:build integration

package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

// conformanceRecorder keeps every live data payload by manifest key so each
// integration-marked row is validated against the wire the router served.
type conformanceRecorder struct {
	t        *testing.T
	observed map[string][]any
}

func (c *conformanceRecorder) record(key string, res apiResponse, wantStatus int) map[string]any {
	c.t.Helper()
	if res.status != wantStatus {
		c.t.Fatalf("%s: status %d, want %d: %+v", key, res.status, wantStatus, res.body)
	}
	requireEnvelope(c.t, res)
	data, present := res.body["data"]
	if !present {
		c.t.Fatalf("%s: envelope has no data: %+v", key, res.body)
	}
	c.observed[key] = append(c.observed[key], data)
	object, _ := data.(map[string]any)
	return object
}

func conformanceDeadLetter(t *testing.T, h *apiHarness, runID string) string {
	t.Helper()
	var id string
	if err := testPool(t).QueryRow(t.Context(), `SELECT id FROM dead_letters WHERE org_id = $1 AND run_id = $2`,
		h.org, runID).Scan(&id); err != nil {
		t.Fatalf("dead letter for %s: %v", runID, err)
	}
	return id
}

func conformanceFormRun(t *testing.T, h *apiHarness, id string) (string, string) {
	t.Helper()
	res := h.call("POST", "/v1/start", map[string]any{"workflow": map[string]any{
		"id": id, "name": "Form", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "form", "type": "human_form", "config": map[string]any{
			"title": "Amount",
			"schema": map[string]any{
				"type": "object", "properties": map[string]any{"amount": map[string]any{"type": "number"}},
				"required": []any{"amount"},
			},
		}}},
		"edges": []any{},
	}}, "")
	runID := extractRunID(t, res)
	return runID, waitFormToken(t, testPool(t), t.Context(), runID, "form")
}

func TestManifestConformanceAgainstLiveRoutes(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	t.Setenv("JANUSLY_OBJECT_STORE_PROVIDER", "local")
	t.Setenv("JANUSLY_OBJECT_STORE_LOCAL_DIR", t.TempDir())
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	rec := &conformanceRecorder{t: t, observed: map[string][]any{}}
	suffix := h.org

	// Workflow lifecycle.
	workflowID := "conformance-" + suffix
	first := makeLinearWorkflow(workflowID)
	saved := rec.record("POST /v1/workflows/save", h.call("POST", "/v1/workflows/save", first, ""), http.StatusOK)
	firstVersion := saved["versionId"].(string)
	second := makeLinearWorkflow(workflowID)
	second["name"] = "Conformance second"
	rec.record("POST /v1/workflows/save", h.call("POST", "/v1/workflows/save", second, ""), http.StatusOK)
	rec.record("POST /v1/workflows/rollback", h.call("POST", "/v1/workflows/rollback", map[string]any{
		"workflowId": workflowID, "sourceVersionId": firstVersion,
	}, ""), http.StatusOK)
	rec.record("GET /v1/workflows/versions/{versionId}", h.call("GET",
		"/v1/workflows/versions/"+firstVersion+"?workflowId="+workflowID, nil, ""), http.StatusOK)
	rec.record("GET /v1/workflows", h.call("GET", "/v1/workflows?q="+workflowID, nil, ""), http.StatusOK)
	rec.record("GET /v1/workflows/versions", h.call("GET", "/v1/workflows/versions?workflowId="+workflowID, nil, ""), http.StatusOK)
	rec.record("GET /v1/workflows/latest", h.call("GET", "/v1/workflows/latest?workflowId="+workflowID, nil, ""), http.StatusOK)
	rec.record("POST /v1/workflows/readiness", h.call("POST", "/v1/workflows/readiness", map[string]any{"workflow": first}, ""), http.StatusOK)
	rec.record("POST /v1/validate", h.call("POST", "/v1/validate", map[string]any{"workflow": first}, ""), http.StatusOK)
	rec.record("GET /v1/workflows/health", h.call("GET", "/v1/workflows/health?workflowId="+workflowID, nil, ""), http.StatusOK)
	rec.record("GET /v1/workflows/health/delta", h.call("GET",
		"/v1/workflows/health/delta?workflowId="+workflowID+"&afterVersion=2&priorFailureSignature=sig", nil, ""), http.StatusOK)
	for _, cron := range []string{"*/5 * * * *", "not a cron"} {
		rec.record("GET /v1/workflows/schedule-preview", h.call("GET",
			"/v1/workflows/schedule-preview?cron="+url.QueryEscape(cron), nil, ""), http.StatusOK)
	}
	rec.record("GET /v1/templates", h.call("GET", "/v1/templates", nil, ""), http.StatusOK)
	rec.record("GET /v1/tools", h.call("GET", "/v1/tools", nil, ""), http.StatusOK)

	// Runs.
	started := rec.record("POST /v1/start", h.call("POST", "/v1/start", map[string]any{"workflow": first}, ""), http.StatusOK)
	runID := started["runId"].(string)
	h.waitRun(runID, "succeeded")
	rec.record("GET /v1/run", h.call("GET", "/v1/run?runId="+runID, nil, ""), http.StatusOK)
	rec.record("GET /v1/status", h.call("GET", "/v1/status?runId="+runID, nil, ""), http.StatusOK)
	rec.record("GET /v1/runs", h.call("GET", "/v1/runs?workflowId="+workflowID, nil, ""), http.StatusOK)
	rec.record("GET /v1/run/usage", h.call("GET", "/v1/run/usage?runId="+runID, nil, ""), http.StatusOK)
	formRun, token := conformanceFormRun(t, h, "conformance-form-"+suffix)
	rec.record("POST /v1/resume", h.call("POST", "/v1/resume", map[string]any{
		"runId": formRun, "nodeId": "form", "input": map[string]any{"amount": 5}, "resumeToken": token,
	}, ""), http.StatusOK)
	cancelRun, _ := conformanceFormRun(t, h, "conformance-cancel-"+suffix)
	rec.record("POST /v1/run/cancel", h.call("POST", "/v1/run/cancel", map[string]any{"runId": cancelRun}, ""), http.StatusOK)

	// Dead letters and recovery reads.
	failed := map[string]string{}
	for _, name := range []string{"redrive", "runs-redrive", "resolve", "patch"} {
		failedRun := failRun(t, h, "conformance-fail-"+name+"-"+suffix)
		failed[name] = conformanceDeadLetter(t, h, failedRun)
		if name == "runs-redrive" {
			failed["runs-redrive-run"] = failedRun
		}
	}
	rec.record("GET /v1/dlq", h.call("GET", "/v1/dlq", nil, ""), http.StatusOK)
	rec.record("GET /v1/dlq/entries/{deadLetterId}", h.call("GET", "/v1/dlq/entries/"+failed["patch"], nil, ""), http.StatusOK)
	rec.record("GET /v1/dlq/clusters", h.call("GET", "/v1/dlq/clusters", nil, ""), http.StatusOK)
	rec.record("POST /v1/ai/patch-workflow", h.call("POST", "/v1/ai/patch-workflow",
		map[string]any{"deadLetterId": failed["patch"]}, ""), http.StatusOK)
	rec.record("POST /v1/dlq/redrive", h.call("POST", "/v1/dlq/redrive",
		map[string]any{"deadLetterId": failed["redrive"]}, ""), http.StatusOK)
	rec.record("POST /v1/runs/redrive", h.call("POST", "/v1/runs/redrive",
		map[string]any{"runId": failed["runs-redrive-run"], "nodeId": "call"}, ""), http.StatusOK)
	rec.record("POST /v1/dlq/resolve", h.call("POST", "/v1/dlq/resolve", map[string]any{"id": failed["resolve"]}, ""), http.StatusOK)
	rec.record("GET /v1/recovery/metrics", h.call("GET", "/v1/recovery/metrics", nil, ""), http.StatusOK)
	rec.record("GET /v1/recovery/home", h.call("GET", "/v1/recovery/home?scope=impact", nil, ""), http.StatusOK)
	rec.record("GET /v1/memory/consent-status", h.call("GET", "/v1/memory/consent-status", nil, ""), http.StatusOK)
	rec.record("GET /v1/runs/semantic-search", h.call("GET", "/v1/runs/semantic-search?q=timeout", nil, ""), http.StatusOK)
	rec.record("GET /v1/operations/brief", h.call("GET", "/v1/operations/brief", nil, ""), http.StatusOK)

	// Governed semantic recovery case.
	caseID := "conformance-case-" + suffix
	seedRecoveryCase(t, h.org, caseID, "conformance-case-run", "detected")
	rec.record("GET /v1/recovery/cases/{caseId}", h.call("GET", "/v1/recovery/cases/"+caseID, nil, ""), http.StatusOK)
	rec.record("POST /v1/recovery/cases/{caseId}/diagnose", h.call("POST", "/v1/recovery/cases/"+caseID+"/diagnose",
		map[string]any{"expectedRevision": 1}, ""), http.StatusOK)
	rec.record("GET /v1/recovery/cases/{caseId}", h.call("GET", "/v1/recovery/cases/"+caseID, nil, ""), http.StatusOK)
	rec.record("GET /v1/recovery/cases", h.call("GET", "/v1/recovery/cases?openOnly=false", nil, ""), http.StatusOK)

	// A quarantined semantic violation driven through the governed lifecycle.
	semanticRecovery := v2ContractDoc("calc")
	semanticContract := semanticRecovery["contract"].(map[string]any)
	semanticContract["autonomyLevel"] = 3
	semanticFailure := semanticContract["failure"].(map[string]any)["semantic"].(map[string]any)
	semanticFailure["detectors"].([]any)[0].(map[string]any)["action"] = "quarantine"
	semanticRun := extractRunID(t, h.call("POST", "/v1/start", map[string]any{
		"workflow": qualificationWorkflowDoc("conformance-semantic-"+suffix, semanticRecovery),
		"input":    map[string]any{"total": "900"},
	}, ""))
	h.waitRun(semanticRun, "waiting")
	var semanticCase string
	if err := pool.QueryRow(ctx, `SELECT id FROM recovery_cases WHERE org_id = $1 AND run_id = $2
		AND source = 'semantic_violation'`, h.org, semanticRun).Scan(&semanticCase); err != nil {
		t.Fatalf("semantic case: %v", err)
	}
	casePath := "/v1/recovery/cases/" + semanticCase
	revision := func(data map[string]any) any { return data["case"].(map[string]any)["revision"] }
	diagnosed := rec.record("POST /v1/recovery/cases/{caseId}/diagnose", h.call("POST", casePath+"/diagnose",
		map[string]any{"expectedRevision": 1}, ""), http.StatusOK)
	candidates := rec.record("POST /v1/recovery/cases/{caseId}/candidates", h.call("POST", casePath+"/candidates", map[string]any{
		"expectedRevision":  revision(diagnosed),
		"manualReplacement": map[string]any{"output": map[string]any{"total": "10"}, "reason": "restore the contract total"},
	}, ""), http.StatusOK)
	var candidateID string
	for _, raw := range candidates["candidates"].([]any) {
		artifact := raw.(map[string]any)
		if payload, _ := artifact["payload"].(map[string]any); payload["kind"] == "replace_output" {
			candidateID = artifact["id"].(string)
		}
	}
	if candidateID == "" {
		t.Fatalf("no replacement candidate: %+v", candidates)
	}
	validated := rec.record("POST /v1/recovery/cases/{caseId}/validate", h.call("POST", casePath+"/validate", map[string]any{
		"expectedRevision": revision(candidates), "candidateArtifactId": candidateID,
	}, ""), http.StatusOK)
	binding := map[string]any{
		"expectedRevision": revision(validated), "candidateArtifactId": candidateID,
		"validationArtifactId": validated["validation"].(map[string]any)["id"],
	}
	rec.record("POST /v1/recovery/cases/{caseId}/approve", h.call("POST", casePath+"/approve", binding, ""), http.StatusOK)
	if detail := rec.record("GET /v1/recovery/cases/{caseId}", h.call("GET", casePath, nil, ""), http.StatusOK); detail["activeApproval"] == nil {
		t.Fatalf("approved case must expose its active approval: %+v", detail)
	}
	rec.record("POST /v1/recovery/cases/{caseId}/apply", h.call("POST", casePath+"/apply", binding, ""), http.StatusOK)

	// A qualification record exists once a candidate adds a semantic contract.
	qualificationID := "conformance-qualification-" + suffix
	qualBaseline := rec.record("POST /v1/workflows/save", h.call("POST", "/v1/workflows/save",
		qualificationWorkflowDoc(qualificationID, nil), ""), http.StatusOK)
	qualCandidate := rec.record("POST /v1/workflows/save", h.call("POST", "/v1/workflows/save",
		qualificationWorkflowDoc(qualificationID, v2ContractDoc("calc")), ""), http.StatusOK)
	qualified := rec.record("POST /v1/workflows/{workflowId}/rollout/qualification", h.call("POST",
		"/v1/workflows/"+qualificationID+"/rollout/qualification", map[string]any{
			"baselineVersionId": qualBaseline["versionId"], "candidateVersionId": qualCandidate["versionId"],
		}, ""), http.StatusOK)
	if qualified["required"] != true || qualified["qualification"] == nil {
		t.Fatalf("semantic candidate must record a qualification: %+v", qualified)
	}
	rec.record("GET /v1/workflows/{workflowId}/rollout/qualification", h.call("GET",
		"/v1/workflows/"+qualificationID+"/rollout/qualification?baselineVersionId="+qualBaseline["versionId"].(string)+
			"&candidateVersionId="+qualCandidate["versionId"].(string), nil, ""), http.StatusOK)

	// A validated fix becomes an active Recovery Playbook, then is offered for
	// a second occurrence of the same failure.
	var healed atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if !healed.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()
	playbookWorkflowID := "conformance-playbook-" + suffix
	playbookWorkflow := func(timeoutMs int) map[string]any {
		return map[string]any{
			"id": playbookWorkflowID, "name": "Playbook", "dslVersion": "1.0",
			"nodes": []any{map[string]any{"id": "call", "type": "http", "config": map[string]any{
				"url": upstream.URL, "timeoutMs": timeoutMs,
			}}},
			"edges": []any{},
		}
	}
	failing, fixed := playbookWorkflow(200), playbookWorkflow(500)
	rec.record("POST /v1/workflows/save", h.call("POST", "/v1/workflows/save", failing, ""), http.StatusOK)
	playbookRun := extractRunID(t, h.call("POST", "/v1/start", map[string]any{"workflow": failing}, ""))
	h.waitRun(playbookRun, "failed")
	playbookLetter := conformanceDeadLetter(t, h, playbookRun)
	healed.Store(true)
	validation := rec.record("POST /v1/dlq/validate-fix", h.call("POST", "/v1/dlq/validate-fix", map[string]any{
		"deadLetterId": playbookLetter, "suggestedWorkflow": fixed,
	}, ""), http.StatusOK)
	validationRunID := validation["runId"].(string)
	h.waitRun(validationRunID, "succeeded")
	fixedVersion := rec.record("POST /v1/workflows/save", h.call("POST", "/v1/workflows/save", fixed, ""), http.StatusOK)
	rec.record("POST /v1/dlq/replay", h.call("POST", "/v1/dlq/replay", map[string]any{
		"deadLetterId": playbookLetter, "suggestedWorkflow": fixed,
	}, ""), http.StatusOK)
	h.waitRun(playbookRun, "succeeded")
	if res := h.call("POST", "/recovery/feedback", map[string]any{
		"deadLetterId": playbookLetter, "suggestionMode": "ai", "approachLabel": "raise_timeout", "accepted": true,
	}, ""); res.status != http.StatusOK {
		t.Fatalf("feedback: %d %+v", res.status, res.body)
	}
	draft := h.call("POST", "/recovery/playbooks", map[string]any{
		"deadLetterId": playbookLetter, "title": "Raise the timeout",
		"instructionsMarkdown":    "1. Check the upstream. 2. Replay.",
		"sourceWorkflowVersionId": fixedVersion["versionId"], "validationRunId": validationRunID,
	}, "")
	if draft.status != http.StatusCreated {
		t.Fatalf("draft playbook: %d %+v", draft.status, draft.body)
	}
	playbookID := draft.body["playbook"].(map[string]any)["id"].(string)
	if res := h.call("POST", "/recovery/playbooks/"+playbookID+"/activate", map[string]any{}, ""); res.status != http.StatusOK {
		t.Fatalf("activate playbook: %d %+v", res.status, res.body)
	}
	healed.Store(false)
	secondRun := extractRunID(t, h.call("POST", "/v1/start", map[string]any{"workflow": failing}, ""))
	h.waitRun(secondRun, "failed")
	rec.record("POST /v1/recovery/playbooks/{id}/use", h.call("POST", "/v1/recovery/playbooks/"+playbookID+"/use",
		map[string]any{"deadLetterId": conformanceDeadLetter(t, h, secondRun)}, ""), http.StatusOK)

	// Trigger ingestion: started, deduplicated, and buffered while paused.
	webhookWorkflowID := "conformance-webhook-" + suffix
	rec.record("POST /v1/workflows/save", h.call("POST", "/v1/workflows/save", webhookWorkflow(webhookWorkflowID, "conf-hook"), ""), http.StatusOK)
	webhookEvent := map[string]any{"endpointKey": "conf-hook", "eventId": "evt-1", "payload": map[string]any{"total": 3}}
	rec.record("POST /v1/webhooks/{workflowId}", h.call("POST", "/v1/webhooks/"+webhookWorkflowID, webhookEvent, ""), http.StatusOK)
	rec.record("POST /v1/webhooks/{workflowId}", h.call("POST", "/v1/webhooks/"+webhookWorkflowID, webhookEvent, ""), http.StatusOK)
	if _, err := pool.Exec(ctx, `UPDATE workflows SET status = 'paused_circuit_breaker', paused_reason = 'conformance'
		WHERE org_id = $1 AND id = $2`, h.org, webhookWorkflowID); err != nil {
		t.Fatalf("pause workflow: %v", err)
	}
	rec.record("POST /v1/webhooks/{workflowId}", h.call("POST", "/v1/webhooks/"+webhookWorkflowID, map[string]any{
		"endpointKey": "conf-hook", "eventId": "evt-2",
	}, ""), http.StatusAccepted)
	rec.record("POST /v1/workflows/{id}/resume", h.call("POST", "/v1/workflows/"+webhookWorkflowID+"/resume", nil, ""), http.StatusOK)

	alias := "conf-mail-" + suffix
	rec.record("POST /v1/workflows/save", h.call("POST", "/v1/workflows/save", emailWorkflow("conformance-email-"+suffix, alias, nil), ""), http.StatusOK)
	email := map[string]any{
		"aliasKey": alias, "from": "billing@partner.example", "subject": "Invoice", "body": "total: 1",
		"dkimPass": true, "messageId": "conformance-" + suffix,
		"attachments": []any{map[string]any{"filename": "invoice.txt", "contentType": "text/plain", "sizeBytes": 3}},
	}
	rec.record("POST /v1/triggers/email/ingest", h.call("POST", "/v1/triggers/email/ingest", email, ""), http.StatusOK)
	rec.record("POST /v1/triggers/email/ingest", h.call("POST", "/v1/triggers/email/ingest", email, ""), http.StatusOK)

	bucket := "conformance-" + suffix
	rec.record("POST /v1/workflows/save", h.call("POST", "/v1/workflows/save", map[string]any{
		"id": "conformance-file-" + suffix, "name": "Drops", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "drop", "type": "file_dropped", "config": map[string]any{"bucket": bucket}}},
		"edges": []any{},
	}, ""), http.StatusOK)
	rec.record("POST /v1/triggers/file/ingest", h.call("POST", "/v1/triggers/file/ingest", map[string]any{
		"bucket": bucket, "key": "incoming/a.csv", "etag": "v1",
	}, ""), http.StatusOK)

	connection, resource := "conf-crm-"+suffix, "mcp://crm/accounts"
	rec.record("POST /v1/workflows/save", h.call("POST", "/v1/workflows/save", map[string]any{
		"id": "conformance-mcp-" + suffix, "name": "CRM", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "sub", "type": "mcp_server_event", "config": map[string]any{
			"connectionAlias": connection, "resourceUri": resource,
		}}},
		"edges": []any{},
	}, ""), http.StatusOK)
	rec.record("POST /v1/triggers/mcp/ingest", h.call("POST", "/v1/triggers/mcp/ingest", map[string]any{
		"connectionAlias": connection, "resourceUri": resource, "eventType": "notifications/resources/updated",
		"payload": map[string]any{"accountId": "a-1"},
	}, ""), http.StatusOK)

	// Rollouts and recovery qualification over two eligible versions.
	rolloutWorkflowID := "conformance-rollout-" + suffix
	baseline := rec.record("POST /v1/workflows/save", h.call("POST", "/v1/workflows/save", rolloutWorkflowDoc(rolloutWorkflowID, "one"), ""), http.StatusOK)
	canary := rec.record("POST /v1/workflows/save", h.call("POST", "/v1/workflows/save", rolloutWorkflowDoc(rolloutWorkflowID, "two"), ""), http.StatusOK)
	pair := "baselineVersionId=" + baseline["versionId"].(string) + "&candidateVersionId=" + canary["versionId"].(string)
	rec.record("GET /v1/workflows/{workflowId}/rollout/qualification", h.call("GET",
		"/v1/workflows/"+rolloutWorkflowID+"/rollout/qualification?"+pair, nil, ""), http.StatusOK)
	rec.record("POST /v1/workflows/{workflowId}/rollout/qualification", h.call("POST",
		"/v1/workflows/"+rolloutWorkflowID+"/rollout/qualification", map[string]any{
			"baselineVersionId": baseline["versionId"], "candidateVersionId": canary["versionId"],
		}, ""), http.StatusOK)
	created := rec.record("POST /v1/workflows/{workflowId}/rollout", h.call("POST", "/v1/workflows/"+rolloutWorkflowID+"/rollout", map[string]any{
		"baselineVersionId": baseline["versionId"], "canaryVersionId": canary["versionId"],
		"trafficPercent": 10, "minimumSampleSize": 5, "minimumSuccessRatePercent": 90,
	}, ""), http.StatusOK)
	rolloutID := created["rollout"].(map[string]any)["id"].(string)
	rec.record("POST /v1/workflows/{workflowId}/rollout/{rolloutId}/{decision}", h.call("POST",
		fmt.Sprintf("/v1/workflows/%s/rollout/%s/rollback", rolloutWorkflowID, rolloutID),
		map[string]any{"reason": "conformance"}, ""), http.StatusOK)

	// Contract-first authoring without a provider.
	prompt := "Call an HTTP API, transform the JSON, and uppercase one field with a backend tool"
	compiled := rec.record("POST /v1/ai/workflow-briefs/compile", h.call("POST", "/v1/ai/workflow-briefs/compile",
		map[string]any{"prompt": prompt}, ""), http.StatusOK)
	catalog := rec.record("GET /v1/authoring/capabilities", h.call("GET", "/v1/authoring/capabilities", nil, ""), http.StatusOK)
	rec.record("POST /v1/ai/workflow-proposals", h.call("POST", "/v1/ai/workflow-proposals", map[string]any{
		"prompt": prompt, "brief": compiled["brief"], "catalogVersion": catalog["version"],
		"currentWorkflow": map[string]any{"nodes": first["nodes"], "edges": []any{}},
	}, ""), http.StatusOK)
	rec.record("POST /v1/ai/workflow-proposals", h.call("POST", "/v1/ai/workflow-proposals", map[string]any{
		"prompt": prompt, "brief": compiled["brief"], "catalogVersion": "stale",
	}, ""), http.StatusOK)

	// Provider-backed patch suggestions through the local simulator.
	patchReply := `{"suggestions":[{"patchedConfig":{"url":"https://api.example.com/v2","timeoutMs":300},
		"rationale":"fix the port","approachLabel":"fix_url","confidence":0.9,
		"consideredAlternatives":[{"approach":"retry harder","rejectedBecause":"the target is gone"},
		{"approach":"use sk-ant-abcdefghijklmnopqrstuvwx","rejectedBecause":"leaks sk-ant-abcdefghijklmnopqrstuvwx"},
		{"approach":"third","rejectedBecause":"over the cap"}]}]}`
	configureDiagnosisSimulator(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, anthropicReply(patchReply))
	}))
	patched := rec.record("POST /v1/ai/patch-workflow", h.call("POST", "/v1/ai/patch-workflow",
		map[string]any{"deadLetterId": failed["patch"]}, ""), http.StatusOK)
	if patched["mode"] != "ai" || patched["model"] == nil || patched["provider"] == nil {
		t.Fatalf("simulated provider patch: %+v", patched)
	}
	alternatives := patched["suggestions"].([]any)[0].(map[string]any)["consideredAlternatives"].([]any)
	if len(alternatives) != 2 || strings.Contains(fmt.Sprint(alternatives), "sk-ant-") {
		t.Fatalf("alternatives must be capped and scrubbed: %+v", alternatives)
	}

	// Populated recovery reads: verified recoveries above, seeded LLM cost,
	// and a measured MTTR baseline.
	if _, err := pool.Exec(ctx, `INSERT INTO usage_events (id, org_id, metric, quantity, metadata)
		VALUES ($1, $2, 'llm.completion', 120, '{"provider":"anthropic","model":"claude-haiku-4-5","costUsd":0.25,
		"inputTokens":100,"cachedInputTokens":40,"cacheCreationInputTokens":10}'::jsonb)`,
		"conformance-usage-"+suffix, h.org); err != nil {
		t.Fatalf("seed usage: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
		VALUES ($1, $2, 'value.baselineMttrSeconds', '600', 'value', 'conformance', 'number')`,
		h.org+"-baseline", h.org); err != nil {
		t.Fatalf("seed baseline: %v", err)
	}
	metrics := rec.record("GET /v1/recovery/metrics", h.call("GET", "/v1/recovery/metrics", nil, ""), http.StatusOK)
	verified := metrics["verifiedRecovery"].(map[string]any)
	value := metrics["valueEstimate"].(map[string]any)
	if verified["sampleSize"] == float64(0) || len(metrics["mttrTrend"].([]any)) == 0 ||
		len(metrics["costByProvider"].([]any)) == 0 ||
		len(metrics["costThisWindow"].(map[string]any)["providers"].([]any)) == 0 || value["mttrDeltaSeconds"] == nil {
		t.Fatalf("recovery metrics must be populated: %+v", metrics)
	}
	home := rec.record("GET /v1/recovery/home", h.call("GET", "/v1/recovery/home", nil, ""), http.StatusOK)
	if section := home["sections"].(map[string]any)["metrics"].(map[string]any); section["status"] != "ok" {
		t.Fatalf("home metrics section: %+v", section)
	}
	rec.record("GET /v1/recovery/ledger", h.call("GET", "/v1/recovery/ledger", nil, ""), http.StatusOK)
	rec.record("GET /v1/recovery/my-wins", h.call("GET", "/v1/recovery/my-wins", nil, ""), http.StatusOK)

	rows := manifestConformanceRows()
	for key, row := range rows {
		if !row.integration {
			continue
		}
		samples := rec.observed[key]
		if len(samples) == 0 {
			t.Errorf("%s is marked integration but no live response was recorded", key)
			continue
		}
		method, path, _ := strings.Cut(key, " ")
		for _, data := range samples {
			requireManifestDataFor(t, method, path, data)
			requireUnknownWireKeyRejected(t, method, path, data)
		}
	}
	for key := range rec.observed {
		if row, ok := rows[key]; !ok || !row.integration {
			t.Errorf("%s was exercised live but its conformance row is not marked integration", key)
		}
	}
}
