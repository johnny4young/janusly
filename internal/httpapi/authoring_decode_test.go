package httpapi

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeCompileWorkflowBriefRequestPreservesOmissionAndRejectsNull(t *testing.T) {
	t.Parallel()

	valid := []struct {
		name string
		body string
	}{
		{name: "empty intent", body: `{}`},
		{name: "prompt only", body: `{"prompt":"Prepare a report"}`},
		{name: "structured brief", body: `{"brief":{"objective":"Prepare a report","inputs":[],"externalEffects":[]}}`},
	}
	for _, testCase := range valid {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest("POST", "/ai/workflow-briefs/compile", strings.NewReader(testCase.body))
			if _, err := decodeCompileWorkflowBriefRequest(request); err != nil {
				t.Fatalf("valid authoring request rejected: %v", err)
			}
		})
	}

	invalid := []struct {
		name string
		body string
	}{
		{name: "null body", body: `null`},
		{name: "array body", body: `[]`},
		{name: "null prompt", body: `{"prompt":null}`},
		{name: "numeric prompt", body: `{"prompt":42}`},
		{name: "null brief", body: `{"brief":null}`},
		{name: "array brief", body: `{"brief":[]}`},
		{name: "null brief scalar", body: `{"brief":{"objective":null}}`},
		{name: "null brief list", body: `{"brief":{"inputs":null}}`},
		{name: "unknown outer field", body: `{"unknown":true}`},
		{name: "unknown brief field", body: `{"brief":{"unknown":true}}`},
		{name: "second document", body: `{} {}`},
	}
	for _, testCase := range invalid {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest("POST", "/ai/workflow-briefs/compile", strings.NewReader(testCase.body))
			if _, err := decodeCompileWorkflowBriefRequest(request); err == nil {
				t.Fatal("invalid authoring request was accepted")
			}
		})
	}
}

func TestDecodeWorkflowProposalRequestPreservesOmissionAndRejectsNull(t *testing.T) {
	t.Parallel()

	request := httptest.NewRequest("POST", "/ai/workflow-proposals", strings.NewReader(`{
		"prompt":"Prepare a report",
		"brief":{"objective":"Prepare a report","externalEffects":[]},
		"currentWorkflow":{"nodes":[],"edges":[]},
		"catalogVersion":"catalog-v1",
		"model":"model-v1"
	}`))
	decoded, err := decodeWorkflowProposalRequest(request)
	if err != nil {
		t.Fatalf("valid proposal request rejected: %v", err)
	}
	if decoded.Prompt != "Prepare a report" || decoded.Brief.Objective != "Prepare a report" ||
		decoded.CatalogVersion != "catalog-v1" || decoded.Model != "model-v1" || decoded.CurrentWorkflow == nil {
		t.Fatalf("proposal request lost supplied values: %+v", decoded)
	}

	for _, testCase := range []struct {
		name string
		body string
	}{
		{name: "null body", body: `null`},
		{name: "null prompt", body: `{"prompt":null}`},
		{name: "null brief", body: `{"brief":null}`},
		{name: "null current workflow", body: `{"currentWorkflow":null}`},
		{name: "non-object current workflow", body: `{"currentWorkflow":[]}`},
		{name: "current workflow missing nodes", body: `{"currentWorkflow":{"edges":[]}}`},
		{name: "current workflow missing edges", body: `{"currentWorkflow":{"nodes":[]}}`},
		{name: "current workflow null nodes", body: `{"currentWorkflow":{"nodes":null,"edges":[]}}`},
		{name: "current workflow scalar edges", body: `{"currentWorkflow":{"nodes":[],"edges":1}}`},
		{name: "current workflow scalar node", body: `{"currentWorkflow":{"nodes":["node"],"edges":[]}}`},
		{name: "current workflow scalar edge", body: `{"currentWorkflow":{"nodes":[],"edges":["edge"]}}`},
		{name: "null catalog version", body: `{"catalogVersion":null}`},
		{name: "null model", body: `{"model":null}`},
		{name: "null nested list", body: `{"brief":{"externalEffects":null}}`},
		{name: "wrong nested list type", body: `{"brief":{"externalEffects":"none"}}`},
		{name: "unknown outer field", body: `{"provider":"invented"}`},
		{name: "unknown brief field", body: `{"brief":{"provider":"invented"}}`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest("POST", "/ai/workflow-proposals", strings.NewReader(testCase.body))
			if _, err := decodeWorkflowProposalRequest(request); err == nil {
				t.Fatal("invalid proposal request was accepted")
			}
		})
	}
}
