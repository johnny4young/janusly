package httpapi

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWorkflowSaveUpstreamCarrierValidation(t *testing.T) {
	tags, problem := validateUpstreamTags([]string{"  pagerduty-api  ", "status-page"})
	if problem != "" || string(tags) != `["pagerduty-api","status-page"]` {
		t.Fatalf("upstream tag normalization mismatch: %s problem=%q", tags, problem)
	}
	if _, problem := validateUpstreamTags([]string{"   "}); problem == "" {
		t.Fatal("blank upstream tag accepted")
	}
	if _, problem := validateUpstreamTags([]string{strings.Repeat("x", 81)}); problem == "" {
		t.Fatal("overlong upstream tag accepted")
	}
}

func TestWorkflowSaveTopLevelContractIsStrict(t *testing.T) {
	valid := map[string]json.RawMessage{
		"nodes": json.RawMessage(`[]`), "edges": json.RawMessage(`[]`),
		"upstreamHealthSources": json.RawMessage(`[]`),
	}
	if field := unknownWorkflowSaveField(valid); field != "" {
		t.Fatalf("valid save field rejected: %s", field)
	}
	valid["slo"] = json.RawMessage(`null`)
	valid["zzz"] = json.RawMessage(`true`)
	if field := unknownWorkflowSaveField(valid); field != "slo" {
		t.Fatalf("unknown fields must be deterministic: %q", field)
	}
}

func TestWorkflowSloMutationRequiresExplicitReplacement(t *testing.T) {
	decode := func(body string) (*workflowSloBody, error) {
		request := httptest.NewRequest("POST", "/workflows/workflow-1/slo", strings.NewReader(body))
		return decodeWorkflowSloMutation(request)
	}

	if slo, err := decode(`{"slo":null}`); err != nil || slo != nil {
		t.Fatalf("explicit null must clear: slo=%#v err=%v", slo, err)
	}
	if slo, err := decode(`{"slo":{"successRatePercent":99.9,"mttrSeconds":null,"p95DurationMs":null,"budgetBlocksPerWindow":null,"stuckWaitingNodesMax":null,"windowDays":7}}`); err != nil || slo == nil || slo.WindowDays != 7 {
		t.Fatalf("valid replacement rejected: slo=%#v err=%v", slo, err)
	}
	for _, body := range []string{
		`{}`,
		`{"slo":{"successRatePercent":99.9,"windowDays":7}}`,
		`{"slo":{"windowDays":7,"unknown":true}}`,
		`{"slo":[],"extra":true}`,
		`{"slo":null}{"slo":null}`,
	} {
		if slo, err := decode(body); err == nil {
			t.Fatalf("invalid replacement accepted: body=%s slo=%#v", body, slo)
		}
	}
}
