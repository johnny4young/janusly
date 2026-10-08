package authoring

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/johnny4young/janusly/internal/domain"
)

func experienceCopyFixture(t *testing.T) (DecisionRequest, DecisionReceipt, ExperienceArtifact, Catalog) {
	t.Helper()
	r, _ := decisionFixture(t)
	r.Brief = registryBrief()
	key, err := CanonicalExperienceKey(r.Brief)
	if err != nil {
		t.Fatal(err)
	}
	r.Candidates[0].BriefKey = key
	catalog := NewBuilder(nil, nil).Build(t.Context(), r.OrganizationID)
	r.CatalogVersion = catalog.Version
	raw := json.RawMessage(`{"dslVersion":"1.0","id":"wf-a","name":"Source report","metadata":{"description":"Saved description","tags":["local"]},"nodes":[{"id":"done","type":"noop","config":{"retained":{"nested":[1,"literal"]}}}],"edges":[],"outputs":{"report":"{{context.done.output}}"},"ui":{"positions":{"done":{"x":10,"y":20}}}}`)
	receipt, err := ProposeDecision(t.Context(), RulesProvider{}, r)
	if err != nil {
		t.Fatal(err)
	}
	return r, receipt, ExperienceArtifact{Candidate: r.Candidates[0], Document: raw}, catalog
}

func TestCopyExperienceProposalChangesOnlyIdentityAndExplicitName(t *testing.T) {
	for _, adapt := range []bool{false, true} {
		t.Run(map[bool]string{false: "reuse", true: "adapt"}[adapt], func(t *testing.T) {
			r, receipt, source, catalog := experienceCopyFixture(t)
			if adapt {
				r.Edits = []DescriptiveEdit{{Field: "workflow_name", Value: "Informe local"}}
				var err error
				receipt, err = ProposeDecision(t.Context(), RulesProvider{}, r)
				if err != nil {
					t.Fatal(err)
				}
			}
			original := string(source.Document)
			draft, err := CopyExperienceProposal(t.Context(), r, receipt, source, "draft-new", catalog)
			if err != nil {
				t.Fatal(err)
			}
			got, issues := domain.Parse(draft)
			before, oldIssues := domain.Parse(source.Document)
			if len(issues) > 0 || len(oldIssues) > 0 {
				t.Fatalf("parse: %v %v", issues, oldIssues)
			}
			wantName := before.Name
			if adapt {
				wantName = "Informe local"
			}
			if got.ID != "draft-new" || got.Name != wantName {
				t.Fatalf("identity/name: %+v", got)
			}
			got.ID = before.ID
			got.Name = before.Name
			if !reflect.DeepEqual(got, before) {
				t.Fatalf("authority or presentation changed: got %+v want %+v", got, before)
			}
			got.Nodes[0].Config["retained"] = "poisoned"
			if string(source.Document) != original {
				t.Fatal("source graph mutated")
			}
		})
	}
}

func TestCopyExperienceProposalRejectsInventedStaleOrIncompatibleSource(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*DecisionRequest, *DecisionReceipt, *ExperienceArtifact, *Catalog)
	}{
		{"source version", func(r *DecisionRequest, p *DecisionReceipt, s *ExperienceArtifact, c *Catalog) {
			s.Candidate.VersionID = "latest"
		}},
		{"source tenant", func(r *DecisionRequest, p *DecisionReceipt, s *ExperienceArtifact, c *Catalog) {
			s.Candidate.OrganizationID = "other"
		}},
		{"revocation", func(r *DecisionRequest, p *DecisionReceipt, s *ExperienceArtifact, c *Catalog) {
			s.Candidate.RevokedAt = &r.AsOf
		}},
		{"expired", func(r *DecisionRequest, p *DecisionReceipt, s *ExperienceArtifact, c *Catalog) {
			s.Candidate.RetainUntil = r.AsOf
		}},
		{"deleted", func(r *DecisionRequest, p *DecisionReceipt, s *ExperienceArtifact, c *Catalog) {
			s.Candidate.Deleted = true
		}},
		{"unreadable", func(r *DecisionRequest, p *DecisionReceipt, s *ExperienceArtifact, c *Catalog) {
			s.Candidate.Readable = false
		}},
		{"stale catalog", func(r *DecisionRequest, p *DecisionReceipt, s *ExperienceArtifact, c *Catalog) { c.Version = "other" }},
		{"forged receipt", func(r *DecisionRequest, p *DecisionReceipt, s *ExperienceArtifact, c *Catalog) { p.Source.Version = 99 }},
		{"forged truncation", func(r *DecisionRequest, p *DecisionReceipt, s *ExperienceArtifact, c *Catalog) { p.Truncated = true }},
		{"wrong DAG identity", func(r *DecisionRequest, p *DecisionReceipt, s *ExperienceArtifact, c *Catalog) {
			s.Document = json.RawMessage(`{"dslVersion":"1.0","id":"other","nodes":[{"id":"a","type":"noop","config":{}}],"edges":[]}`)
		}},
		{"added effect", func(r *DecisionRequest, p *DecisionReceipt, s *ExperienceArtifact, c *Catalog) {
			s.Document = json.RawMessage(`{"dslVersion":"1.0","id":"wf-a","nodes":[{"id":"a","type":"tool","config":{"tool":"email.send","input":{"to":"a@example.com","subject":"x","text":"x"}}}],"edges":[]}`)
		}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			r, p, s, c := experienceCopyFixture(t)
			test.mutate(&r, &p, &s, &c)
			if _, err := CopyExperienceProposal(t.Context(), r, p, s, "draft-new", c); err == nil {
				t.Fatal("unsafe artifact accepted")
			}
		})
	}
	r, p, s, c := experienceCopyFixture(t)
	if _, err := CopyExperienceProposal(t.Context(), r, p, s, s.Candidate.WorkflowID, c); err == nil {
		t.Fatal("source identity reused")
	}
}

func TestCopyExperiencePreservesWriteApprovalTimingAndOlderChildPin(t *testing.T) {
	r, _, source, catalog := experienceCopyFixture(t)
	catalog.Credentials = []CredentialCapability{{ID: "cred-slack", Name: "incidents", Kind: "slack_webhook", Configured: true, UpdatedAt: r.AsOf}}
	catalog.Subworkflows = []SubworkflowCapability{{WorkflowID: "wf-child", Name: "Reviewed child", Status: "active", LatestVersion: 3}}
	catalog.Version = catalogDigest(catalog)
	r.CatalogVersion = catalog.Version
	r.Brief.Trigger = "schedule"
	r.Brief.ExternalEffects = []string{"slack_message", "subworkflow:wf-child"}
	r.Brief.Approvals = []string{"human_approval_before_external_effect"}
	key, err := CanonicalExperienceKey(r.Brief)
	if err != nil {
		t.Fatal(err)
	}
	r.Candidates[0].BriefKey = key
	source.Candidate = r.Candidates[0]
	source.Document = json.RawMessage(`{"dslVersion":"1.0","id":"wf-a","name":"Reviewed writes","nodes":[{"id":"clock","type":"schedule","config":{"cronExpression":"0 9 * * *","timeZone":"America/Bogota","enabled":true}},{"id":"approve","type":"approval","config":{"message":"Review effects","timeoutMs":900000}},{"id":"pause","type":"wait_until","config":{"duration":"PT5M"}},{"id":"notify","type":"tool","config":{"tool":"slack.post","input":{"credential":"incidents","text":"Reviewed report"}}},{"id":"delegate","type":"subworkflow","config":{"workflowId":"wf-child","version":1}}],"edges":[{"from":"clock","to":"approve"},{"from":"approve","to":"pause"},{"from":"pause","to":"notify"},{"from":"notify","to":"delegate"}],"outputs":{"delegation":"{{context.delegate.output}}"}}`)
	r.Edits = []DescriptiveEdit{{Field: "workflow_name", Value: "Renamed reviewed writes"}}
	receipt, err := ProposeDecision(t.Context(), RulesProvider{}, r)
	if err != nil {
		t.Fatal(err)
	}
	draft, err := CopyExperienceProposal(t.Context(), r, receipt, source, "draft-new", catalog)
	if err != nil {
		t.Fatal(err)
	}
	got, issues := domain.Parse(draft)
	original, oldIssues := domain.Parse(source.Document)
	if len(issues) > 0 || len(oldIssues) > 0 {
		t.Fatalf("parse: %v %v", issues, oldIssues)
	}
	got.ID = original.ID
	got.Name = original.Name
	if !reflect.DeepEqual(got, original) {
		t.Fatal("write/approval/timing/child pin changed during descriptive adaptation")
	}
	if got.Nodes[4].Config["version"] != float64(1) {
		t.Fatal("older immutable child pin silently upgraded to latest")
	}
	catalog.Subworkflows[0].LatestVersion = 0
	catalog.Version = catalogDigest(catalog)
	r.CatalogVersion = catalog.Version
	receipt, err = ProposeDecision(t.Context(), RulesProvider{}, r)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := CopyExperienceProposal(t.Context(), r, receipt, source, "draft-new", catalog); err == nil {
		t.Fatal("missing child version repaired instead of rejected")
	}
}

func TestCopyExperienceProposalAcceptsJSONRoundTrippedReceipt(t *testing.T) {
	r, _, source, catalog := experienceCopyFixture(t)
	for _, edits := range [][]DescriptiveEdit{nil, {}} {
		r.Edits = edits
		receipt, err := ProposeDecision(t.Context(), RulesProvider{}, r)
		if err != nil {
			t.Fatal(err)
		}
		for _, wire := range []string{"", `"edits":[],`} {
			raw, err := json.Marshal(receipt)
			if err != nil {
				t.Fatal(err)
			}
			if wire != "" {
				raw = append([]byte(`{`+wire), raw[1:]...)
			}
			var decoded DecisionReceipt
			if err := json.Unmarshal(raw, &decoded); err != nil {
				t.Fatal(err)
			}
			if _, err := CopyExperienceProposal(t.Context(), r, decoded, source, "draft-new", catalog); err != nil {
				t.Fatalf("round-tripped receipt %s rejected: %v", raw, err)
			}
		}
	}
}
