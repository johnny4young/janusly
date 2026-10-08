package httpapi

import (
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/authoring"
)

func FuzzExperienceProposalWire(f *testing.F) {
	for _, seed := range []string{
		`{}`,
		`{"experienceEdits":[]}`,
		`{"experienceEdits":[{"field":"workflow_name","value":"Informe revisado 日本語"}]}`,
		`{"experienceEdits":null}`,
		`{"ExperienceEdits":[]}`,
		`{"experienceEdits":[],"experienceEdits":[]}`,
		`{"experienceEdits":[{"field":"workflow_name","value":"truncated`,
		`{"experienceReceipt":{"provider":"rules","mode":"REUSE","reason":"exact_match","policyVersion":"authoring-experience-v1","contextRevision":"revision","catalogVersion":"catalog","source":{"candidateId":"experience","workflowId":"source","versionId":"version","version":1},"truncated":false,"outcomeEvidence":"unknown","draftId":"draft"}}`,
	} {
		f.Add(seed)
	}
	// Raw HTML may fit the wire bound but expand beyond it on canonical echo.
	htmlID := strings.Repeat("<", 128)
	f.Add(`{"experienceReceipt":{"provider":"rules","mode":"REUSE","reason":"exact_match","policyVersion":"authoring-experience-v1","contextRevision":"` + htmlID + `","catalogVersion":"` + htmlID + `","source":{"candidateId":"` + htmlID + `","workflowId":"` + htmlID + `","versionId":"` + htmlID + `","version":1},"truncated":false,"outcomeEvidence":"unknown","draftId":"d` + htmlID[:127] + `"}}`)
	f.Fuzz(func(t *testing.T, raw string) {
		// Exercise the bounded experience extension, not multi-megabyte canvas
		// throughput. Directed HTTP tests cover the independent body limit.
		if len(raw) > 4*authoring.MaxDecisionRequestBytes {
			t.Skip()
		}
		r := httptest.NewRequest("POST", "/ai/workflow-proposals", strings.NewReader(raw))
		request, err := decodeWorkflowProposalRequest(r)
		if err != nil {
			return
		}
		if len(request.ExperienceEdits) > 1 {
			t.Fatal("unbounded edits accepted")
		}
		if request.ExperienceReceipt == nil {
			return
		}
		encoded, err := json.Marshal(request.ExperienceReceipt)
		if err != nil || len(encoded) > authoring.MaxDecisionResultBytes {
			t.Fatalf("accepted receipt cannot remain bounded: %v", err)
		}
		_, roundTrip, err := decodeExperienceProposalFields(nil, encoded)
		if err != nil || !reflect.DeepEqual(roundTrip, request.ExperienceReceipt) {
			t.Fatalf("accepted receipt changed identity or policy on canonical round trip: %v", err)
		}
	})
}
