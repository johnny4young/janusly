package httpapi

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestExperienceProposalFieldsRejectNonCanonicalReceipts(t *testing.T) {
	base := `{"provider":"rules","mode":"REUSE","reason":"exact_match","policyVersion":"authoring-experience-v1","contextRevision":"revision","catalogVersion":"catalog","source":{"candidateId":"experience","workflowId":"source","versionId":"version","version":1},"truncated":false,"outcomeEvidence":"unknown","draftId":"draft"}`
	for _, test := range []struct{ name, raw string }{
		{"null", "null"},
		{"unknown authority", strings.Replace(base, `"rules"`, `"fixture"`, 1)},
		{"duplicate mode", strings.Replace(base, `"mode":"REUSE"`, `"mode":"REUSE","mode":"REUSE"`, 1)},
		{"case alias", strings.Replace(base, `"mode"`, `"Mode"`, 1)},
		{"duplicate source", strings.Replace(base, `"version":1`, `"version":1,"version":1`, 1)},
		{"unknown source", strings.Replace(base, `"version":1`, `"version":1,"organizationId":"foreign"`, 1)},
		{"claimed outcome", strings.Replace(base, `"unknown"`, `"verified"`, 1)},
		{"no draft", strings.Replace(base, `,"draftId":"draft"`, "", 1)},
		{"unbounded", strings.Replace(base, `"draft"`, `"`+strings.Repeat("x", 129)+`"`, 1)},
		{"null source", strings.Replace(base, `{"candidateId":"experience","workflowId":"source","versionId":"version","version":1}`, "null", 1)},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, _, err := decodeExperienceProposalFields(nil, json.RawMessage(test.raw)); err == nil {
				t.Fatal("unsafe receipt accepted")
			}
		})
	}
	_, receipt, err := decodeExperienceProposalFields(nil, json.RawMessage(base))
	if err != nil || receipt.Source.VersionID != "version" || receipt.DraftID != "draft" {
		t.Fatalf("canonical receipt lost: %+v %v", receipt, err)
	}
}

func TestExperienceProposalEditsAreBoundedAndNotPatches(t *testing.T) {
	for _, test := range []struct{ name, raw string }{
		{"null", "null"}, {"object", `{}`}, {"null entry", `[null]`},
		{"two edits", `[{"field":"workflow_name","value":"A"},{"field":"workflow_name","value":"B"}]`},
		{"patch", `[{"op":"replace","path":"/credential","value":"new"}]`},
		{"duplicate", `[{"field":"workflow_name","value":"A","value":"B"}]`},
		{"overflow unicode", `[{"field":"workflow_name","value":"` + strings.Repeat("é", 101) + `"}]`},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, _, err := decodeExperienceProposalFields(json.RawMessage(test.raw), nil); err == nil {
				t.Fatal("unbounded or patch-shaped edit accepted")
			}
		})
	}
	edits, _, err := decodeExperienceProposalFields(json.RawMessage(`[{"field":"workflow_name","value":"`+strings.Repeat("é", 100)+`"}]`), nil)
	if err != nil || len(edits) != 1 || len(edits[0].Value) != 200 {
		t.Fatalf("exact byte boundary: %+v %v", edits, err)
	}
}

func TestExperienceProposalExtensionRejectsTopLevelAliasesAndDuplicates(t *testing.T) {
	for _, test := range []struct{ name, raw string }{
		{"alias", `{"ExperienceEdits":[]}`},
		{"duplicate", `{"experienceEdits":[],"experienceEdits":[]}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest("POST", "/ai/workflow-proposals", strings.NewReader(test.raw))
			if _, err := decodeWorkflowProposalRequest(request); err == nil {
				t.Fatal("noncanonical experience extension accepted")
			}
		})
	}
}
