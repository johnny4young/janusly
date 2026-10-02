package authoring

import (
	"encoding/json"
	"errors"
	"maps"
	"strings"
	"testing"
)

func registryBrief() IntentBrief {
	return IntentBrief{Version: "1", Objective: "Prepare local text", Trigger: "manual", Inputs: []string{}, ExpectedOutcome: "Local text", ExternalEffects: []string{}, Approvals: []string{}, FailurePolicy: "stop_and_open_recovery_case", Examples: []string{}, Language: "en"}
}

func TestExperienceRegistrationRejectsLossyOrSecretBrief(t *testing.T) {
	valid := ExperienceRegistration{ID: "entry", OrganizationID: "org", ActorID: "operator", WorkflowID: "workflow", VersionID: "version", Brief: registryBrief()}
	if _, _, err := validateExperienceRegistration(valid); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name   string
		change func(*ExperienceRegistration)
	}{
		{"empty source", func(r *ExperienceRegistration) { r.VersionID = "" }},
		{"invalid identity", func(r *ExperienceRegistration) { r.WorkflowID = "wf\nother" }},
		{"oversized identity", func(r *ExperienceRegistration) { r.ActorID = strings.Repeat("界", 44) }},
		{"invalid utf8", func(r *ExperienceRegistration) { r.Brief.Objective = string([]byte{255}) }},
		{"future schema", func(r *ExperienceRegistration) { r.Brief.Version = "2" }},
		{"trim", func(r *ExperienceRegistration) { r.Brief.Objective = " Prepare local text " }},
		{"inferred default", func(r *ExperienceRegistration) { r.Brief.FailurePolicy = "" }},
		{"truncation", func(r *ExperienceRegistration) { r.Brief.Objective = strings.Repeat("a", 1201) }},
		{"duplicate constraints", func(r *ExperienceRegistration) { r.Brief.Inputs = []string{"literal", "literal"} }},
		{"nil constraints", func(r *ExperienceRegistration) { r.Brief.Approvals = nil }},
		{"empty objective", func(r *ExperienceRegistration) { r.Brief.Objective = "" }},
		{"credential shape", func(r *ExperienceRegistration) {
			r.Brief.Examples = []string{"postgres://operator:password@db/private"}
		}},
		{"provider key", func(r *ExperienceRegistration) { r.Brief.Inputs = []string{"sk-ant-" + strings.Repeat("a", 32)} }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := valid
			r.Brief = registryBrief()
			c.change(&r)
			if _, _, err := validateExperienceRegistration(r); !errors.Is(err, ErrExperienceBriefInvalid) {
				t.Fatalf("invalid registration not rejected: %v", err)
			}
		})
	}
	if _, _, err := validateExperienceRegistration(valid); err != nil {
		t.Fatal("input mutated", err)
	}
}

func TestExperienceRegistryConsentRequiresExactClosedTenantGates(t *testing.T) {
	vals := map[string]json.RawMessage{"ai.authoringExperienceEnabled": json.RawMessage("true"), "memory.enabled": json.RawMessage("true"), "memory.allowedKinds": json.RawMessage(`"workflow_vector"`)}
	days, err := experienceConsentDays(vals)
	if err != nil || days != 180 {
		t.Fatalf("default policy: %d %v", days, err)
	}
	for _, key := range []string{"ai.authoringExperienceEnabled", "memory.enabled", "memory.allowedKinds"} {
		t.Run(key, func(t *testing.T) {
			clone := maps.Clone(vals)
			delete(clone, key)
			if _, err := experienceConsentDays(clone); !errors.Is(err, ErrExperienceDisabled) {
				t.Fatalf("missing consent accepted: %v", err)
			}
		})
	}
	for _, raw := range []string{`"true"`, `null`, `1`, `false`} {
		vals["memory.enabled"] = json.RawMessage(raw)
		if _, err := experienceConsentDays(vals); err == nil {
			t.Fatalf("invalid boolean accepted: %s", raw)
		}
	}
	vals["memory.enabled"] = json.RawMessage("true")
	for _, raw := range []string{`"not_workflow_vector"`, `"workflow_vector_extra"`, `[]`, `null`, `""`} {
		vals["memory.allowedKinds"] = json.RawMessage(raw)
		if _, err := experienceConsentDays(vals); err == nil {
			t.Fatalf("invalid kind consent accepted: %s", raw)
		}
	}
	vals["memory.allowedKinds"] = json.RawMessage(`"run_summary, workflow_vector"`)
	vals["memory.retentionDaysByKind"] = json.RawMessage(`"{\"workflow_vector\":7}"`)
	if days, err := experienceConsentDays(vals); err != nil || days != 7 {
		t.Fatalf("retention override: %d %v", days, err)
	}
	for _, raw := range []string{`"{\"workflow_vector\":0}"`, `"{\"workflow_vector\":731}"`, `"{\"workflow_vector\":1.5}"`, `"{} junk"`, `{}`} {
		vals["memory.retentionDaysByKind"] = json.RawMessage(raw)
		if _, err := experienceConsentDays(vals); err == nil {
			t.Fatalf("invalid retention accepted: %s", raw)
		}
	}
}
