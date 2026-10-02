//go:build integration

package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/authoring"
	"github.com/johnny4young/janusly/internal/config"
)

func TestAuthoringExperienceProposalRetainsIndependentPermissions(t *testing.T) {
	h, request, _, calls := experienceProposalIntegrationFixture(t, config.AuthoringExperienceReview)
	first := h.call("POST", "/v1/ai/workflow-proposals", request, "")
	if first.status != http.StatusOK {
		t.Fatal(first.body)
	}
	receipt := first.body["data"].(map[string]any)["experienceDecision"]
	pool := testPool(t)
	for _, permissions := range []struct {
		name          string
		grants        []string
		initialStatus int
		initialCalls  int32
	}{
		{"no workflow read", []string{"ai.write"}, http.StatusOK, 1},
		{"no authoring write", []string{"workflows.read"}, http.StatusForbidden, 0},
	} {
		t.Run(permissions.name, func(t *testing.T) {
			role := "experience-propose-" + permissions.name
			user := "operator-" + permissions.name
			raw, _ := json.Marshal(permissions.grants)
			if _, err := pool.Exec(t.Context(), `INSERT INTO org_roles(id,org_id,name,inherits_from,granted_permissions) VALUES($1,$2,$3,'editor',$4::jsonb)`, h.org+role, h.org, role, raw); err != nil {
				t.Fatal(err)
			}
			seedMemberRow(t, pool, h.org, user, "operator@example.test", role)
			headers := map[string]string{"x-user-id": user}
			request["experienceReceipt"] = receipt
			before := calls.Load()
			denied := h.callWithHeaders("POST", "/v1/ai/workflow-proposals", request, "", headers)
			if denied.status != http.StatusForbidden || calls.Load() != before {
				t.Fatalf("source revalidation bypassed read/AI authority: %d %+v", denied.status, denied.body)
			}
			delete(request, "experienceReceipt")
			ordinary := h.callWithHeaders("POST", "/v1/ai/workflow-proposals", request, "", headers)
			if ordinary.status != permissions.initialStatus || calls.Load()-before != permissions.initialCalls {
				t.Fatalf("legacy authoring authority changed: status=%d addedCalls=%d", ordinary.status, calls.Load()-before)
			}
		})
	}
}

func TestAuthoringExperienceGenerateKeepsBudgetAndRateAdmission(t *testing.T) {
	for _, gate := range []string{"budget", "rate"} {
		t.Run(gate, func(t *testing.T) {
			for _, mode := range []config.AuthoringExperienceMode{config.AuthoringExperienceOff, config.AuthoringExperienceShadow, config.AuthoringExperienceReview} {
				t.Run(string(mode), func(t *testing.T) {
					h, request, _, calls := experienceProposalIntegrationFixture(t, mode)
					pool := testPool(t)
					if gate == "budget" {
						if _, err := pool.Exec(t.Context(), `INSERT INTO org_configs(id,org_id,key,value_json,category,description,value_type) VALUES ($1,$2,'ai.budgetMonthlyUsd','0.5','ai','test','number'),($3,$2,'ai.budgetExceededPolicy','"block"','ai','test','string')`, h.org+"-budget", h.org, h.org+"-policy"); err != nil {
							t.Fatal(err)
						}
						if _, err := pool.Exec(t.Context(), `INSERT INTO usage_events(id,org_id,metric,quantity,metadata) VALUES($1,$2,'llm.completion',1,'{"costUsd":1}')`, h.org+"-spent", h.org); err != nil {
							t.Fatal(err)
						}
					} else {
						if _, err := pool.Exec(t.Context(), `INSERT INTO org_configs(id,org_id,key,value_json,category,description,value_type) VALUES($1,$2,'ai.rateLimitPerMin','1','ai','test','number')`, h.org+"-rate", h.org); err != nil {
							t.Fatal(err)
						}
					}
					if mode == config.AuthoringExperienceReview {
						for range 2 {
							reused := h.call("POST", "/v1/ai/workflow-proposals", request, "")
							if reused.status != http.StatusOK || reused.body["data"].(map[string]any)["experienceDecision"].(map[string]any)["mode"] != "REUSE" || calls.Load() != 0 {
								t.Fatalf("zero-provider reuse consumed egress budget/rate: %+v", reused.body)
							}
						}
					}
					brief := request["brief"].(authoring.IntentBrief)
					brief.ExpectedOutcome = "Different exact intent without registered source"
					request["brief"] = brief
					if gate == "rate" {
						admitted := h.call("POST", "/v1/ai/workflow-proposals", request, "")
						if admitted.status != http.StatusOK || calls.Load() != 1 {
							t.Fatalf("first generation was not admitted: %+v", admitted.body)
						}
					}
					denied := h.call("POST", "/v1/ai/workflow-proposals", request, "")
					wantStatus, wantCalls := http.StatusPaymentRequired, int32(0)
					if gate == "rate" {
						wantStatus, wantCalls = http.StatusTooManyRequests, 1
					}
					if denied.status != wantStatus || calls.Load() != wantCalls {
						t.Fatalf("classification bypassed egress gate: status=%d calls=%d %+v", denied.status, calls.Load(), denied.body)
					}
				})
			}
		})
	}
}

func TestAuthoringExperienceCanonicalRecipePrecedesSourceAndPaidGeneration(t *testing.T) {
	h, request, _, calls := experienceProposalIntegrationFixture(t, config.AuthoringExperienceReview)
	prompt := "Starting now for one week, when PagerDuty alerts user PLOCALUSER outside working hours 09:00 to 17:00 in America/Bogota, acknowledge it and snooze it for 12 hours as operator@example.com. Use API credential fixture-pd-api and webhook credential fixture-pd-webhook."
	compiled := h.call("POST", "/ai/workflow-briefs/compile", map[string]any{"prompt": prompt}, "")
	if compiled.status != http.StatusOK || compiled.body["complete"] != true {
		t.Fatalf("recipe brief: %+v", compiled.body)
	}
	request["prompt"], request["brief"] = prompt, compiled.body["brief"]
	response := h.call("POST", "/v1/ai/workflow-proposals", request, "")
	if response.status != http.StatusOK {
		briefRaw, _ := json.Marshal(compiled.body["brief"])
		var brief authoring.IntentBrief
		_ = json.Unmarshal(briefRaw, &brief)
		recipe, _, recipeErr := authoring.CompilePagerDutyWorkflow(prompt, authoring.DeterministicWorkflowOptions{Brief: &brief})
		recipeRaw, _ := json.Marshal(recipe)
		_, _, assuranceErr := compileWorkflowAssurance(prompt, recipeRaw)
		t.Fatalf("recipe admission: response=%+v recipe=%v assurance=%v", response.body, recipeErr, assuranceErr)
	}
	data := response.body["data"].(map[string]any)
	receipt := data["experienceDecision"].(map[string]any)
	if receipt["mode"] != "GENERATE" || receipt["reason"] != "canonical_recipe" || data["mode"] != "fallback" || calls.Load() != 0 {
		t.Fatalf("registered experience/provider displaced canonical recipe: calls=%d data=%+v", calls.Load(), data)
	}
	if receipt["source"] != nil || receipt["draftId"] != nil {
		t.Fatal("classification claimed source authority")
	}
	requireManifestDataFor(t, "POST", "/v1/ai/workflow-proposals", data)
}

func TestAuthoringExperienceAuditFailureDoesNotBreakSourceCopy(t *testing.T) {
	h, request, _, calls := experienceProposalIntegrationFixture(t, config.AuthoringExperienceReview)
	pool := testPool(t)
	// This fault applies to one test tenant/action in its isolated database;
	// other request writes and the source registry retain normal behavior.
	ddl := fmt.Sprintf(`CREATE FUNCTION reject_experience_decision_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.org_id='%s' AND NEW.action='authoring.experience.decision' THEN RAISE EXCEPTION 'fixture audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_experience_decision_fixture BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_experience_decision_fixture()`, h.org)
	if _, err := pool.Exec(t.Context(), ddl); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(t.Context()), 5*time.Second)
		defer cancel()
		if _, err := pool.Exec(cleanup, `DROP TRIGGER reject_experience_decision_fixture ON audit_logs; DROP FUNCTION reject_experience_decision_fixture()`); err != nil {
			t.Errorf("remove audit fixture: %v", err)
		}
	})
	response := h.call("POST", "/v1/ai/workflow-proposals", request, "")
	if response.status != http.StatusOK || response.body["data"].(map[string]any)["proposal"].(map[string]any)["applicable"] != true || calls.Load() != 0 {
		t.Fatalf("best-effort telemetry broke a source copy: %+v", response.body)
	}
}

func TestAuthoringExperienceProcessDisableStopsPendingReceiptAdmission(t *testing.T) {
	h, request, _, calls := experienceProposalIntegrationFixture(t, config.AuthoringExperienceReview)
	first := h.call("POST", "/v1/ai/workflow-proposals", request, "")
	if first.status != http.StatusOK {
		t.Fatal(first.body)
	}
	receipt := first.body["data"].(map[string]any)["experienceDecision"]
	options := defaultV1ServerOptionsForTest()
	options.AuthoringExperienceMode = config.AuthoringExperienceReview
	options.Logger = quietTestLogger()
	disabled := newAPIHarnessWithOptions(t, false, options)
	disabled.org = h.org
	ordinary := disabled.call("POST", "/v1/ai/workflow-proposals", request, "")
	if ordinary.status != http.StatusOK || ordinary.body["data"].(map[string]any)["experienceDecision"] != nil || calls.Load() != 1 {
		t.Fatalf("review mode enabled the process gate: calls=%d response=%+v", calls.Load(), ordinary.body)
	}
	request["experienceReceipt"] = receipt
	stale := disabled.call("POST", "/v1/ai/workflow-proposals", request, "")
	if stale.status != http.StatusForbidden || calls.Load() != 1 {
		t.Fatalf("disabled process admitted an old review: calls=%d response=%+v", calls.Load(), stale.body)
	}
}

func TestAuthoringExperienceNoKeyNoMatchKeepsLocalFallback(t *testing.T) {
	h, request, _, calls := experienceProposalIntegrationFixture(t, config.AuthoringExperienceReview)
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "false")
	t.Setenv("JANUSLY_LLM_SIMULATED_PROVIDERS", "")
	t.Setenv("JANUSLY_LLM_SIMULATOR_BASE_URL", "")
	brief := request["brief"].(authoring.IntentBrief)
	brief.ExpectedOutcome = "Unregistered different local outcome"
	request["brief"] = brief
	response := h.call("POST", "/v1/ai/workflow-proposals", request, "")
	if response.status != http.StatusOK {
		t.Fatal(response.body)
	}
	data := response.body["data"].(map[string]any)
	if data["mode"] != "fallback" || data["aiError"] != nil || data["experienceDecision"].(map[string]any)["mode"] != "GENERATE" || calls.Load() != 0 {
		t.Fatalf("classification enabled a keyless provider: %+v", data)
	}
}
