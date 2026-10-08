//go:build integration

package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/johnny4young/janusly/internal/authoring"
	"github.com/johnny4young/janusly/internal/config"
	"github.com/johnny4young/janusly/internal/domain"
)

func TestAuthoringExperienceReviewCopiesExactSourceWithoutConfiguredProviderCalls(t *testing.T) {
	var transports atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		transports.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, anthropicReply(`{"dslVersion":"1.0","id":"simulator-draft","nodes":[{"id":"done","type":"noop","config":{}}],"edges":[]}`))
	}))
	t.Cleanup(provider.Close)
	t.Setenv("JANUSLY_MEMORY_ENABLED", "true")
	t.Setenv("ANTHROPIC_API_KEY", "fixture-key")
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LLM_SIMULATED_PROVIDERS", "anthropic")
	t.Setenv("JANUSLY_LLM_SIMULATOR_BASE_URL", provider.URL)
	options := defaultV1ServerOptionsForTest()
	options.AuthoringExperienceEnabled = true
	options.AuthoringExperienceMode = config.AuthoringExperienceReview
	options.Logger = quietTestLogger()
	h := newAPIHarnessWithOptions(t, false, options)
	source := authoringExperienceSource(t, h)
	authoringExperienceGrant(t, h)
	registered := h.call("POST", "/v1/authoring/experiences/register", source, "")
	if registered.status != http.StatusOK {
		t.Fatalf("register: %d %+v", registered.status, registered.body)
	}
	catalog := h.call("GET", "/v1/authoring/capabilities", nil, "")
	if catalog.status != http.StatusOK {
		t.Fatalf("catalog: %d %+v", catalog.status, catalog.body)
	}
	response := h.call("POST", "/v1/ai/workflow-proposals", map[string]any{
		"brief": source["brief"], "catalogVersion": catalog.body["data"].(map[string]any)["version"],
		"currentWorkflow": map[string]any{"nodes": []any{}, "edges": []any{}},
	}, "")
	if response.status != http.StatusOK {
		t.Fatalf("review: %d %+v", response.status, response.body)
	}
	data := response.body["data"].(map[string]any)
	receipt, ok := data["experienceDecision"].(map[string]any)
	if !ok || receipt["mode"] != "REUSE" || receipt["outcomeEvidence"] != "unknown" {
		t.Fatalf("exact experience not selected: %+v", data)
	}
	if transports.Load() != 0 || data["mode"] != "fallback" {
		t.Fatalf("source copy consumed provider calls or altered legacy mode: calls=%d data=%+v", transports.Load(), data)
	}
	ref, ok := receipt["source"].(map[string]any)
	if !ok || ref["versionId"] != source["versionId"] || ref["workflowId"] != source["workflowId"] {
		t.Fatalf("exact version/source lost: %+v", receipt)
	}
	proposal := data["proposal"].(map[string]any)
	if proposal["applicable"] != true || data["bindings"].(map[string]any)["complete"] != true {
		t.Fatalf("exact copy lost apply eligibility: %+v", data)
	}
	var raw []byte
	if err := testPool(t).QueryRow(t.Context(), `SELECT dag_json FROM workflow_versions WHERE org_id=$1 AND id=$2`, h.org, source["versionId"]).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	original, originalIssues := domain.Parse(raw)
	copiedJSON, err := json.Marshal(proposal["workflow"])
	if err != nil {
		t.Fatal(err)
	}
	copied, copiedIssues := domain.Parse(copiedJSON)
	if len(originalIssues) != 0 || len(copiedIssues) != 0 || copied.ID == original.ID {
		t.Fatalf("noncanonical or nonfresh copy: original=%v copied=%v", originalIssues, copiedIssues)
	}
	copied.ID = original.ID
	if !reflect.DeepEqual(copied, original) {
		t.Fatalf("reuse mutated source authority, outputs or presentation: got=%+v want=%+v", copied, original)
	}
	requireManifestDataFor(t, "POST", "/v1/ai/workflow-proposals", data)
}

func experienceProposalIntegrationFixture(t *testing.T, mode config.AuthoringExperienceMode, configure ...func(*V1ServerOptions)) (*apiHarness, map[string]any, map[string]any, *atomic.Int32) {
	t.Helper()
	calls := &atomic.Int32{}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, anthropicReply(`{"dslVersion":"1.0","id":"simulator-draft","nodes":[{"id":"done","type":"noop","config":{}}],"edges":[]}`))
	}))
	t.Cleanup(provider.Close)
	for key, value := range map[string]string{"JANUSLY_MEMORY_ENABLED": "true", "ANTHROPIC_API_KEY": "fixture-key", "JANUSLY_LOCAL_STACK": "true", "JANUSLY_LOCAL_INTEGRATION_SIMULATOR": "true", "JANUSLY_LLM_SIMULATED_PROVIDERS": "anthropic", "JANUSLY_LLM_SIMULATOR_BASE_URL": provider.URL} {
		t.Setenv(key, value)
	}
	options := defaultV1ServerOptionsForTest()
	options.AuthoringExperienceEnabled = true
	options.AuthoringExperienceMode = mode
	options.Logger = quietTestLogger()
	for _, apply := range configure {
		apply(&options)
	}
	h := newAPIHarnessWithOptions(t, false, options)
	source := authoringExperienceSource(t, h)
	authoringExperienceGrant(t, h)
	registered := h.call("POST", "/v1/authoring/experiences/register", source, "")
	if registered.status != http.StatusOK {
		t.Fatalf("register: %d %+v", registered.status, registered.body)
	}
	catalog := h.call("GET", "/v1/authoring/capabilities", nil, "")
	if catalog.status != http.StatusOK {
		t.Fatal(catalog.body)
	}
	request := map[string]any{"brief": source["brief"], "catalogVersion": catalog.body["data"].(map[string]any)["version"], "currentWorkflow": map[string]any{"nodes": []any{}, "edges": []any{}}}
	return h, request, registered.body["data"].(map[string]any), calls
}

func TestAuthoringExperienceProfilesPreserveProviderAdmissionAndWire(t *testing.T) {
	for _, test := range []struct {
		name         string
		mode         config.AuthoringExperienceMode
		unmatched    bool
		wantCalls    int32
		wantDecision string
	}{
		{"off", config.AuthoringExperienceOff, false, 1, ""},
		{"shadow", config.AuthoringExperienceShadow, false, 1, ""},
		{"review reuse", config.AuthoringExperienceReview, false, 0, "REUSE"},
		{"review no match", config.AuthoringExperienceReview, true, 1, "GENERATE"},
	} {
		t.Run(test.name, func(t *testing.T) {
			h, request, _, calls := experienceProposalIntegrationFixture(t, test.mode)
			if test.unmatched {
				brief := request["brief"].(authoring.IntentBrief)
				brief.ExpectedOutcome = "A different local result"
				request["brief"] = brief
			}
			response := h.call("POST", "/ai/workflow-proposals", request, "")
			if response.status != http.StatusOK || calls.Load() != test.wantCalls {
				t.Fatalf("admission: status=%d calls=%d data=%+v", response.status, calls.Load(), response.body)
			}
			decision, present := response.body["experienceDecision"].(map[string]any)
			if test.wantDecision == "" {
				if present {
					t.Fatal("off/shadow altered legacy wire")
				}
			} else if !present || decision["mode"] != test.wantDecision {
				t.Fatalf("classification: %+v", decision)
			}
			requireManifestDataFor(t, "POST", "/v1/ai/workflow-proposals", response.body)
			var logical int64
			if err := testPool(t).QueryRow(t.Context(), `SELECT coalesce(sum((metadata->>'modelCallCount')::bigint),0) FROM audit_logs WHERE org_id=$1 AND action='ai.workflow.generated'`, h.org).Scan(&logical); err != nil || logical != int64(test.wantCalls) {
				t.Fatalf("logical generation accounting changed: logical=%d transports=%d err=%v", logical, calls.Load(), err)
			}
			var raw []byte
			err := testPool(t).QueryRow(t.Context(), `SELECT metadata FROM audit_logs WHERE org_id=$1 AND action='authoring.experience.decision' ORDER BY created_at DESC LIMIT 1`, h.org).Scan(&raw)
			if test.mode == config.AuthoringExperienceOff {
				if err == nil {
					t.Fatal("off ran experience telemetry")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var metadata map[string]any
			if json.Unmarshal(raw, &metadata) != nil || metadata["decisionModelCallCount"] != float64(0) || metadata["stage"] != string(test.mode) {
				t.Fatalf("decision accounting is not truthful: %s", raw)
			}
			for _, forbidden := range []string{"PRIVATE_", "brief", "contextRevision", "catalogVersion", "nodes", "edges", "fixture-key", "workflowId", "versionId"} {
				if strings.Contains(string(raw), forbidden) {
					t.Fatalf("content leaked to decision audit: %s", forbidden)
				}
			}
		})
	}
}

func TestAuthoringExperienceAdaptAndRevalidationKeepReviewedIdentity(t *testing.T) {
	h, request, entry, calls := experienceProposalIntegrationFixture(t, config.AuthoringExperienceReview)
	request["experienceEdits"] = []any{map[string]any{"field": "workflow_name", "value": "Informe revisado"}}
	first := h.call("POST", "/v1/ai/workflow-proposals", request, "")
	if first.status != http.StatusOK {
		t.Fatal(first.body)
	}
	data := first.body["data"].(map[string]any)
	receipt, ok := data["experienceDecision"].(map[string]any)
	if !ok || receipt["mode"] != "ADAPT" {
		t.Fatalf("adaptation: %+v", data)
	}
	workflow := data["proposal"].(map[string]any)["workflow"].(map[string]any)
	if workflow["name"] != "Informe revisado" || workflow["id"] != receipt["draftId"] {
		t.Fatalf("draft identity/name: %+v", workflow)
	}
	request["experienceReceipt"] = receipt
	rechecked := h.call("POST", "/v1/ai/workflow-proposals", request, "")
	if rechecked.status != http.StatusOK {
		t.Fatal(rechecked.body)
	}
	next := rechecked.body["data"].(map[string]any)
	if next["proposal"].(map[string]any)["workflow"].(map[string]any)["id"] != workflow["id"] {
		t.Fatal("revalidation replaced reviewed draft identity")
	}
	request["currentWorkflow"] = map[string]any{"nodes": []any{map[string]any{"id": "edited"}}, "edges": []any{}}
	changed := h.call("POST", "/v1/ai/workflow-proposals", request, "")
	if changed.status != http.StatusOK || changed.body["data"].(map[string]any)["proposal"].(map[string]any)["applicable"] != false {
		t.Fatalf("changed context admitted old receipt: %+v", changed.body)
	}
	request["currentWorkflow"] = map[string]any{"nodes": []any{}, "edges": []any{}}
	if revoked := h.call("POST", "/v1/authoring/experiences/revoke", map[string]any{"id": entry["id"]}, ""); revoked.status != http.StatusOK {
		t.Fatal(revoked.body)
	}
	stale := h.call("POST", "/v1/ai/workflow-proposals", request, "")
	if stale.status != http.StatusOK || stale.body["data"].(map[string]any)["proposal"].(map[string]any)["applicable"] != false || calls.Load() != 0 {
		t.Fatalf("stale reuse launched generation or remained applicable: calls=%d data=%+v", calls.Load(), stale.body)
	}
}

// Test adapters remain request-scoped and delegate actual source selection to
// the persistent registry unless an individual failure boundary is exercised.
type experienceReaderProbe struct {
	registry *authoring.ExperienceRegistry
	decide   func(context.Context, authoring.DecisionRequest, authoring.Catalog) (authoring.ExperienceSelection, error)
	resolve  func(context.Context, authoring.DecisionRequest, authoring.DecisionReceipt, authoring.Catalog, string) ([]byte, error)
}

func (p *experienceReaderProbe) Decide(ctx context.Context, input authoring.DecisionRequest, catalog authoring.Catalog) (authoring.ExperienceSelection, error) {
	if p.decide != nil {
		return p.decide(ctx, input, catalog)
	}
	return p.registry.Decide(ctx, input, catalog)
}

func (p *experienceReaderProbe) Resolve(ctx context.Context, input authoring.DecisionRequest, receipt authoring.DecisionReceipt, catalog authoring.Catalog, draftID string) ([]byte, error) {
	if p.resolve != nil {
		return p.resolve(ctx, input, receipt, catalog, draftID)
	}
	return p.registry.Resolve(ctx, input, receipt, catalog, draftID)
}

func TestAuthoringExperienceInitialOptionalFailuresPreserveSingleGenerationPath(t *testing.T) {
	for _, mode := range []config.AuthoringExperienceMode{config.AuthoringExperienceShadow, config.AuthoringExperienceReview} {
		t.Run(string(mode), func(t *testing.T) {
			for _, failure := range []string{"deadline", "unavailable"} {
				t.Run(failure, func(t *testing.T) {
					probe := &experienceReaderProbe{decide: func(ctx context.Context, _ authoring.DecisionRequest, _ authoring.Catalog) (authoring.ExperienceSelection, error) {
						if failure == "deadline" {
							<-ctx.Done()
							return authoring.ExperienceSelection{}, ctx.Err()
						}
						return authoring.ExperienceSelection{}, errors.New("PRIVATE_DATABASE_FAILURE")
					}}
					h, request, _, calls := experienceProposalIntegrationFixture(t, mode, func(options *V1ServerOptions) { options.ExperienceReader = probe })
					response := h.call("POST", "/v1/ai/workflow-proposals", request, "")
					data, _ := response.body["data"].(map[string]any)
					if response.status != http.StatusOK || calls.Load() != 1 || data["mode"] != "ai" || data["experienceDecision"] != nil {
						t.Fatalf("optional failure replaced the existing generation ladder: status=%d calls=%d data=%+v", response.status, calls.Load(), response.body)
					}
					raw, _ := json.Marshal(response.body)
					if bytes.Contains(raw, []byte("PRIVATE_DATABASE_FAILURE")) {
						t.Fatal("optional reader error leaked")
					}
				})
			}
		})
	}
}

func TestAuthoringExperienceRevalidationFailuresNeverRequestGeneration(t *testing.T) {
	for _, failure := range []string{"deadline", "unavailable"} {
		t.Run(failure, func(t *testing.T) {
			probe := &experienceReaderProbe{}
			h, request, _, calls := experienceProposalIntegrationFixture(t, config.AuthoringExperienceReview, func(options *V1ServerOptions) { options.ExperienceReader = probe })
			probe.registry = &authoring.ExperienceRegistry{Pool: testPool(t), Enabled: true}
			first := h.call("POST", "/v1/ai/workflow-proposals", request, "")
			if first.status != http.StatusOK {
				t.Fatal(first.body)
			}
			request["experienceReceipt"] = first.body["data"].(map[string]any)["experienceDecision"]
			probe.decide = func(ctx context.Context, _ authoring.DecisionRequest, _ authoring.Catalog) (authoring.ExperienceSelection, error) {
				if failure == "deadline" {
					<-ctx.Done()
					return authoring.ExperienceSelection{}, ctx.Err()
				}
				return authoring.ExperienceSelection{}, errors.New("PRIVATE_REVALIDATION_FAILURE")
			}
			response := h.call("POST", "/v1/ai/workflow-proposals", request, "")
			if response.status != http.StatusOK || response.body["data"].(map[string]any)["proposal"].(map[string]any)["applicable"] != false || calls.Load() != 0 {
				t.Fatalf("failed revalidation admitted another path: status=%d calls=%d data=%+v", response.status, calls.Load(), response.body)
			}
		})
	}
}

func TestAuthoringExperienceCancelledRequestNeverStartsAnotherPath(t *testing.T) {
	for _, stage := range []string{"before decision", "during decision", "during resolution"} {
		t.Run(stage, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			probe := &experienceReaderProbe{}
			h, request, _, calls := experienceProposalIntegrationFixture(t, config.AuthoringExperienceReview, func(options *V1ServerOptions) { options.ExperienceReader = probe })
			probe.registry = &authoring.ExperienceRegistry{Pool: testPool(t), Enabled: true}
			var decisions, resolutions atomic.Int32
			probe.decide = func(ctx context.Context, input authoring.DecisionRequest, catalog authoring.Catalog) (authoring.ExperienceSelection, error) {
				decisions.Add(1)
				if stage == "during decision" {
					cancel()
					return authoring.ExperienceSelection{}, ctx.Err()
				}
				return probe.registry.Decide(ctx, input, catalog)
			}
			probe.resolve = func(ctx context.Context, _ authoring.DecisionRequest, _ authoring.DecisionReceipt, _ authoring.Catalog, _ string) ([]byte, error) {
				resolutions.Add(1)
				cancel()
				return nil, ctx.Err()
			}
			raw, _ := json.Marshal(request)
			r := httptest.NewRequest("POST", "/v1/ai/workflow-proposals", bytes.NewReader(raw)).WithContext(ctx)
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("x-org-id", h.org)
			r.Header.Set("x-user-id", "api-tester")
			if stage == "before decision" {
				cancel()
			}
			recorder := httptest.NewRecorder()
			h.server.Config.Handler.ServeHTTP(recorder, r)
			// A cancelled authorization/catalog read can fail before the decision
			// stage. Neither that rejection nor a 408 permits a generation call.
			if recorder.Code < http.StatusBadRequest || calls.Load() != 0 || (stage == "before decision" && decisions.Load() != 0) || (stage != "during resolution" && resolutions.Load() != 0) {
				t.Fatalf("cancelled request continued: status=%d decisions=%d resolutions=%d transports=%d", recorder.Code, decisions.Load(), resolutions.Load(), calls.Load())
			}
			if stage != "before decision" && (recorder.Code != http.StatusRequestTimeout || decisions.Load() != 1) {
				t.Fatalf("active cancellation was not terminal: status=%d decisions=%d", recorder.Code, decisions.Load())
			}
		})
	}
}

func TestAuthoringExperienceReviewSourceAndConsentFences(t *testing.T) {
	for _, change := range []string{"source deletion", "expired", "ambiguous registration", "tenant consent", "memory consent", "allowed kind", "global consent", "identity", "foreign receipt"} {
		t.Run(change, func(t *testing.T) {
			h, request, entry, calls := experienceProposalIntegrationFixture(t, config.AuthoringExperienceReview)
			pool := testPool(t)
			var alternative map[string]any
			if change == "ambiguous registration" {
				workflowID := "alternative-" + h.org
				saved := h.call("POST", "/v1/workflows/save", map[string]any{"dslVersion": "1.0", "id": workflowID, "name": "Other source", "nodes": []any{map[string]any{"id": "done", "type": "noop", "config": map[string]any{}}}, "edges": []any{}}, "")
				if saved.status != http.StatusOK {
					t.Fatal(saved.body)
				}
				alternative = map[string]any{"workflowId": workflowID, "versionId": saved.body["data"].(map[string]any)["versionId"], "brief": request["brief"]}
				catalog := h.call("GET", "/v1/authoring/capabilities", nil, "")
				request["catalogVersion"] = catalog.body["data"].(map[string]any)["version"]
			}
			first := h.call("POST", "/v1/ai/workflow-proposals", request, "")
			if first.status != http.StatusOK {
				t.Fatal(first.body)
			}
			request["experienceReceipt"] = first.body["data"].(map[string]any)["experienceDecision"]
			headers := map[string]string{}
			var err error
			switch change {
			case "source deletion":
				_, err = pool.Exec(t.Context(), `UPDATE workflows SET deleted_at=now() WHERE org_id=$1 AND id=$2`, h.org, entry["workflowId"])
			case "expired":
				_, err = pool.Exec(t.Context(), `UPDATE authoring_experiences SET registered_at=now()-interval '2 days', retain_until=now()-interval '1 day' WHERE org_id=$1 AND id=$2`, h.org, entry["id"])
			case "ambiguous registration":
				if res := h.call("POST", "/v1/authoring/experiences/register", alternative, ""); res.status != http.StatusOK {
					t.Fatal(res.body)
				}
			case "tenant consent", "memory consent", "allowed kind":
				key, value := "ai.authoringExperienceEnabled", "false"
				if change == "memory consent" {
					key = "memory.enabled"
				}
				if change == "allowed kind" {
					key, value = "memory.allowedKinds", `"decision_vector"`
				}
				_, err = pool.Exec(t.Context(), `UPDATE org_configs SET value_json=$3::jsonb WHERE org_id=$1 AND key=$2`, h.org, key, value)
			case "global consent":
				t.Setenv("JANUSLY_MEMORY_ENABLED", "false")
			case "identity":
				headers["x-user-id"] = "another-operator"
			case "foreign receipt":
				request["experienceReceipt"].(map[string]any)["source"].(map[string]any)["candidateId"] = "foreign-registration"
			}
			if err != nil {
				t.Fatal(err)
			}
			stale := h.callWithHeaders("POST", "/v1/ai/workflow-proposals", request, "", headers)
			if stale.status == http.StatusOK {
				if stale.body["data"].(map[string]any)["proposal"].(map[string]any)["applicable"] != false {
					t.Fatalf("stale source or consent applied: %+v", stale.body)
				}
			} else if stale.status != http.StatusForbidden {
				t.Fatalf("unexpected closed response: %d %+v", stale.status, stale.body)
			}
			if calls.Load() != 0 {
				t.Fatalf("stale receipt requested generation: %d", calls.Load())
			}
		})
	}
}

func TestAuthoringExperienceUntrustedSelectionCannotResolveOrGenerate(t *testing.T) {
	for _, change := range []string{"organization", "context", "catalog", "consent", "brief", "edits", "provider", "source"} {
		t.Run(change, func(t *testing.T) {
			probe := &experienceReaderProbe{}
			h, request, _, calls := experienceProposalIntegrationFixture(t, config.AuthoringExperienceReview, func(options *V1ServerOptions) { options.ExperienceReader = probe })
			probe.registry = &authoring.ExperienceRegistry{Pool: testPool(t), Enabled: true}
			probe.decide = func(ctx context.Context, input authoring.DecisionRequest, catalog authoring.Catalog) (authoring.ExperienceSelection, error) {
				selected, err := probe.registry.Decide(ctx, input, catalog)
				if err != nil {
					return selected, err
				}
				switch change {
				case "organization":
					selected.Request.OrganizationID = "foreign-organization"
				case "context":
					selected.Request.ContextRevision = "different-context"
				case "catalog":
					selected.Request.CatalogVersion = "different-catalog"
				case "consent":
					selected.Request.Consent = false
				case "brief":
					selected.Request.Brief.ExpectedOutcome = "Different authority"
				case "edits":
					selected.Request.Edits = []authoring.DescriptiveEdit{{Field: "workflow_name", Value: "Invented edit"}}
				case "provider":
					selected.Receipt.Provider = "fixture"
				case "source":
					selected.Receipt.Source.VersionID = "foreign-version"
				}
				return selected, nil
			}
			var resolves atomic.Int32
			probe.resolve = func(context.Context, authoring.DecisionRequest, authoring.DecisionReceipt, authoring.Catalog, string) ([]byte, error) {
				resolves.Add(1)
				return nil, errors.New("untrusted selection reached resolution")
			}
			response := h.call("POST", "/v1/ai/workflow-proposals", request, "")
			if response.status != http.StatusOK || response.body["data"].(map[string]any)["proposal"].(map[string]any)["applicable"] != false || resolves.Load() != 0 || calls.Load() != 0 {
				t.Fatalf("untrusted reader projection reached another authority boundary: resolves=%d calls=%d response=%+v", resolves.Load(), calls.Load(), response.body)
			}
		})
	}
}

func TestAuthoringExperienceUnsupportedEditsNeverBecomeSemanticPatches(t *testing.T) {
	for _, field := range []string{"credential", "node_config", "topology", "approvals", "trigger_timing"} {
		t.Run(field, func(t *testing.T) {
			h, request, _, calls := experienceProposalIntegrationFixture(t, config.AuthoringExperienceReview)
			request["experienceEdits"] = []any{map[string]any{"field": field, "value": "Do not infer this authority"}}
			response := h.call("POST", "/v1/ai/workflow-proposals", request, "")
			if response.status != http.StatusOK {
				t.Fatal(response.body)
			}
			data := response.body["data"].(map[string]any)
			decision := data["experienceDecision"].(map[string]any)
			if decision["mode"] != "ESCALATE" || decision["reason"] != "unsupported_adaptation" || data["proposal"].(map[string]any)["applicable"] != false || calls.Load() != 0 {
				t.Fatalf("unsupported request patched/generated authority: calls=%d data=%+v", calls.Load(), data)
			}
			requireManifestDataFor(t, "POST", "/v1/ai/workflow-proposals", data)
		})
	}
}
