//go:build integration

package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func configureDiagnosisSimulator(t *testing.T, handler http.Handler) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LLM_SIMULATED_PROVIDERS", "anthropic")
	t.Setenv("JANUSLY_LLM_SIMULATOR_BASE_URL", server.URL)
	return server
}

func TestRecoveryDiagnosisUsesBoundedAIOnlyWithPermission(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	pool := testPool(t)
	suffix := fmt.Sprint(time.Now().UnixNano())
	caseID := "diagnosis-ai-" + suffix
	seedRecoveryCase(t, h.org, caseID, "retained-run", "detected")

	var calls atomic.Int64
	var requestText atomic.Value
	configureDiagnosisSimulator(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		raw := make(map[string]any)
		_ = json.NewDecoder(r.Body).Decode(&raw)
		serialized, _ := json.Marshal(raw)
		requestText.Store(string(serialized))
		w.Header().Set("content-type", "application/json")
		_, _ = fmt.Fprint(w, anthropicReply(`{"summary":"El contrato y el detector señalan una discrepancia acotada.","hypotheses":[{"id":"contract_mismatch","cause":"El resultado observado no coincide con el contrato retenido.","confidence":0.78,"evidence":["El detector determinista registró una violación."],"counterEvidence":["El snapshot del flujo ya no está disponible para confirmar el contexto exacto."]}]}`))
	}))

	res := h.callWithHeaders("POST", "/recovery/cases/"+caseID+"/diagnose", map[string]any{
		"expectedRevision": 1,
	}, h.org, map[string]string{"Accept-Language": "es-CO"})
	if res.status != http.StatusOK || res.body["mode"] != "ai_enriched" || calls.Load() != 1 {
		t.Fatalf("AI diagnosis: status=%d calls=%d body=%+v", res.status, calls.Load(), res.body)
	}
	artifact := res.body["diagnosis"].(map[string]any)
	payload := artifact["payload"].(map[string]any)
	if payload["mode"] != "ai_enriched" || !strings.Contains(fmt.Sprint(payload["summary"]), "discrepancia") {
		t.Fatalf("persisted enrichment: %+v", payload)
	}
	providerWire, _ := requestText.Load().(string)
	for _, forbidden := range []string{caseID, "det-" + caseID, "retained-run"} {
		if strings.Contains(providerWire, forbidden) {
			t.Fatalf("provider input leaked stable identifier %q: %s", forbidden, providerWire)
		}
	}
	if !strings.Contains(providerWire, `\"language\":\"es\"`) {
		t.Fatalf("provider input did not retain locale: %s", providerWire)
	}

	// An editor-ranked custom role can diagnose with recovery.write but its
	// explicit permission set omits ai.write. The same configured provider
	// must not be touched, while the deterministic Spanish path still works.
	customID := "recovery-only-" + suffix
	grants := `["recovery.read","recovery.write"]`
	if _, err := pool.Exec(t.Context(), `INSERT INTO org_roles
		(id,org_id,name,inherits_from,description,is_builtin,granted_permissions)
		VALUES ($1,$2,'recovery-only','editor','Recovery without AI',false,$3::jsonb)`,
		h.org+"-recovery-only", h.org, grants); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO org_members
		(id,org_id,user_id,email,role) VALUES ($1,$2,$3,$4,'recovery-only')`,
		h.org+"-"+customID, h.org, customID, customID+"@local.test"); err != nil {
		t.Fatal(err)
	}
	secondID := "diagnosis-no-ai-permission-" + suffix
	seedRecoveryCase(t, h.org, secondID, "retained-run-2", "detected")
	before := calls.Load()
	blocked := h.callWithHeaders("POST", "/recovery/cases/"+secondID+"/diagnose", map[string]any{
		"expectedRevision": 1,
	}, h.org, map[string]string{"x-user-id": customID, "Accept-Language": "es"})
	if blocked.status != http.StatusOK || blocked.body["mode"] != "deterministic_fallback" || calls.Load() != before {
		t.Fatalf("permission-free fallback: status=%d calls=%d body=%+v", blocked.status, calls.Load()-before, blocked.body)
	}
	blockedPayload := blocked.body["diagnosis"].(map[string]any)["payload"].(map[string]any)
	if !strings.Contains(fmt.Sprint(blockedPayload["hypotheses"]), "salida del nodo") {
		t.Fatalf("deterministic diagnosis should honor locale: %+v", blockedPayload)
	}
}

func TestRecoveryDiagnosisInvalidProviderOutputFallsBackAfterTwoCalls(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	suffix := fmt.Sprint(time.Now().UnixNano())
	caseID := "diagnosis-invalid-provider-" + suffix
	seedRecoveryCase(t, h.org, caseID, "missing-run", "detected")
	var calls atomic.Int64
	configureDiagnosisSimulator(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.Header().Set("content-type", "application/json")
		_, _ = fmt.Fprint(w, anthropicReply(`{"summary":"unsafe","actions":["approve"]}`))
	}))

	res := h.call("POST", "/recovery/cases/"+caseID+"/diagnose", map[string]any{"expectedRevision": 1}, "")
	if res.status != http.StatusOK || res.body["mode"] != "deterministic_fallback" || calls.Load() != 2 {
		t.Fatalf("invalid provider fallback: status=%d calls=%d body=%+v", res.status, calls.Load(), res.body)
	}
	payload := res.body["diagnosis"].(map[string]any)["payload"].(map[string]any)
	serialized, _ := json.Marshal(payload)
	if strings.Contains(string(serialized), "actions") || !strings.Contains(string(serialized), "counterEvidence") {
		t.Fatalf("unsafe provider envelope reached artifact: %s", serialized)
	}
}

func TestRecoveryDiagnosisReadmitsRepairAgainstRecordedBudget(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	pool := testPool(t)
	suffix := fmt.Sprint(time.Now().UnixNano())
	caseID := "diagnosis-repair-budget-" + suffix
	seedRecoveryCase(t, h.org, caseID, "missing-run", "detected")
	if _, err := pool.Exec(t.Context(), `INSERT INTO org_configs
		(id, org_id, key, value_json, category, description, value_type) VALUES
		($1, $2, 'ai.budgetMonthlyUsd', '0.5', 'ai', 'test', 'number'),
		($3, $2, 'ai.budgetExceededPolicy', '"block"', 'ai', 'test', 'string')`,
		h.org+"-diagnosis-budget", h.org, h.org+"-diagnosis-policy"); err != nil {
		t.Fatalf("seed diagnosis budget: %v", err)
	}

	var calls atomic.Int64
	configureDiagnosisSimulator(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if call := calls.Add(1); call != 1 {
			t.Errorf("provider repair call %d escaped per-call admission", call)
		}
		if _, err := pool.Exec(r.Context(), `INSERT INTO usage_events
			(id, org_id, metric, quantity, metadata)
			VALUES ($1, $2, 'llm.completion', 1, '{"costUsd":1}')`,
			"usage-diagnosis-budget-"+suffix, h.org); err != nil {
			t.Errorf("record crossed diagnosis budget: %v", err)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = fmt.Fprint(w, anthropicReply(`{"summary":"unsafe","actions":["approve"]}`))
	}))

	res := h.call("POST", "/recovery/cases/"+caseID+"/diagnose", map[string]any{"expectedRevision": 1}, "")
	if res.status != http.StatusOK || res.body["mode"] != "deterministic_fallback" || calls.Load() != 1 {
		t.Fatalf("late diagnosis budget block: status=%d calls=%d body=%+v", res.status, calls.Load(), res.body)
	}
	var blocked int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_logs
		WHERE org_id=$1 AND action='billing.budget.exceeded'`, h.org).Scan(&blocked); err != nil || blocked != 1 {
		t.Fatalf("repair budget denial must be audited once: count=%d err=%v", blocked, err)
	}
}
