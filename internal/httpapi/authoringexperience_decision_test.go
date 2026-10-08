package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/authoring"
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

func TestExperienceReceiptCanonicalByteLimit(t *testing.T) {
	for _, test := range []struct {
		name           string
		escaped        int
		version        int
		extra          int
		canonicalBytes int
		wantError      bool
	}{
		{"bounded HTML escaping", 10, 1, 0, 0, false},
		{"exact canonical boundary", 106, 100, 2, 4096, false},
		{"one-byte canonical overflow", 106, 1000, 2, 4097, true},
		{"canonical HTML escaping overflow", 128, 1, 0, 4874, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			value := strings.Repeat("<", test.escaped)
			input := map[string]any{
				"provider": "rules", "mode": "REUSE", "reason": "exact_match",
				"policyVersion": "authoring-experience-v1", "contextRevision": value + strings.Repeat("<", test.extra),
				"catalogVersion": value, "draftId": "d" + value[:len(value)-1],
				"source":    map[string]any{"candidateId": value, "workflowId": value, "versionId": value, "version": test.version},
				"truncated": false, "outcomeEvidence": "unknown",
			}
			fixtureCanonical, err := json.Marshal(input)
			if err != nil {
				t.Fatal(err)
			}
			if test.canonicalBytes != 0 && len(fixtureCanonical) != test.canonicalBytes {
				t.Fatalf("fixture canonical size: got %d want %d", len(fixtureCanonical), test.canonicalBytes)
			}
			var raw bytes.Buffer
			encoder := json.NewEncoder(&raw)
			encoder.SetEscapeHTML(false)
			if err := encoder.Encode(input); err != nil {
				t.Fatal(err)
			}
			if raw.Len() > 4096 {
				t.Fatalf("fixture exceeds raw boundary: %d", raw.Len())
			}
			_, receipt, err := decodeExperienceProposalFields(nil, raw.Bytes())
			if test.wantError {
				if err == nil {
					canonical, _ := json.Marshal(receipt)
					t.Fatalf("accepted receipt expands from %d to %d bytes beyond canonical limit", raw.Len(), len(canonical))
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			canonical, err := json.Marshal(receipt)
			if err != nil || len(canonical) > 4096 {
				t.Fatalf("canonical receipt: bytes=%d error=%v", len(canonical), err)
			}
			_, again, err := decodeExperienceProposalFields(nil, canonical)
			if err != nil || again.DraftID != receipt.DraftID {
				t.Fatalf("round trip changed receipt: %+v %v", again, err)
			}
		})
	}
}

func TestExperienceContextRevisionIgnoresLayoutOnly(t *testing.T) {
	rc := v1Request{orgID: "org", userID: "user"}
	canvas := func(ui map[string]any, label string) workflowProposalRequest {
		workflow := map[string]any{"nodes": []any{map[string]any{"id": "a", "label": label}}, "edges": []any{}}
		if ui != nil {
			workflow["ui"] = ui
		}
		return workflowProposalRequest{CurrentWorkflow: workflow}
	}
	base := experienceContextRevision(rc, canvas(nil, "A"), authoring.IntentBrief{}, "catalog")
	moved := canvas(map[string]any{"positions": map[string]any{"a": map[string]any{"x": 10, "y": 20}}}, "A")
	if got := experienceContextRevision(rc, moved, authoring.IntentBrief{}, "catalog"); got != base {
		t.Fatal("a layout-only drag invalidated the reviewed context")
	}
	if _, present := moved.CurrentWorkflow["ui"]; !present {
		t.Fatal("context revision mutated the caller's comparison snapshot")
	}
	if experienceContextRevision(rc, canvas(nil, "B"), authoring.IntentBrief{}, "catalog") == base {
		t.Fatal("a semantic canvas edit kept the reviewed context")
	}
}
