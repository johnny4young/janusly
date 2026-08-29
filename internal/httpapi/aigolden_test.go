package httpapi

import (
	_ "embed"
	"encoding/json"
	"maps"
	"testing"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/packs"
)

//go:embed testdata/workflow-assurance-golden.json
var workflowAssuranceGoldenJSON []byte

type workflowAssuranceGolden struct {
	SchemaVersion string                        `json:"schemaVersion"`
	Cases         []workflowAssuranceGoldenCase `json:"cases"`
}

type workflowAssuranceGoldenCase struct {
	ID     string          `json:"id"`
	Prompt string          `json:"prompt"`
	Draft  json.RawMessage `json:"draft"`
	PackID string          `json:"packId"`
	Want   struct {
		Outputs               map[string]string `json:"outputs"`
		AddedOutputs          bool              `json:"addedOutputs"`
		RecoveryVersion       string            `json:"recoveryVersion"`
		AddedRecovery         bool              `json:"addedRecovery"`
		QualificationFixtures int               `json:"qualificationFixtures"`
		EffectKinds           map[string]string `json:"effectKinds"`
	} `json:"want"`
}

func loadWorkflowAssuranceGolden(t *testing.T) workflowAssuranceGolden {
	t.Helper()
	var dataset workflowAssuranceGolden
	if err := json.Unmarshal(workflowAssuranceGoldenJSON, &dataset); err != nil {
		t.Fatalf("decode golden set: %v", err)
	}
	if dataset.SchemaVersion != "1" || len(dataset.Cases) < 5 {
		t.Fatalf("golden set identity: version=%q cases=%d", dataset.SchemaVersion, len(dataset.Cases))
	}
	return dataset
}

func TestWorkflowAssuranceGoldenSet(t *testing.T) {
	dataset := loadWorkflowAssuranceGolden(t)
	for _, testCase := range dataset.Cases {
		t.Run(testCase.ID, func(t *testing.T) {
			draft := testCase.Draft
			if testCase.PackID != "" {
				pack := packs.Get(testCase.PackID)
				if pack == nil {
					t.Fatalf("unknown golden pack %q", testCase.PackID)
				}
				draft = pack.WorkflowJSON
			}
			compiled, meta, err := compileWorkflowAssurance(testCase.Prompt, draft)
			if err != nil {
				t.Fatalf("compile: %v", err)
			}
			if meta.AddedOutputs != testCase.Want.AddedOutputs ||
				meta.AddedRecoveryContract != testCase.Want.AddedRecovery {
				t.Fatalf("compilation metadata: got %+v want outputs=%v recovery=%v",
					meta, testCase.Want.AddedOutputs, testCase.Want.AddedRecovery)
			}
			wf, issues := domain.Parse(compiled)
			if wf == nil || len(issues) > 0 {
				t.Fatalf("compiled workflow parse: %+v", issues)
			}
			if !maps.Equal(wf.Outputs, testCase.Want.Outputs) {
				t.Fatalf("outputs: got %#v want %#v", wf.Outputs, testCase.Want.Outputs)
			}

			version := ""
			qualificationFixtures := 0
			effectKinds := map[string]string{}
			if wf.Recovery != nil && wf.Recovery.Contract != nil {
				contract := wf.Recovery.Contract
				version = contract.Version
				if version == "2" {
					qualificationFixtures = len(contract.Failure.Semantic.EvaluationFixtures)
				}
				for _, effect := range contract.Effects {
					effectKinds[effect.NodeID] = effect.Kind
				}
			}
			if version != testCase.Want.RecoveryVersion ||
				qualificationFixtures != testCase.Want.QualificationFixtures ||
				!maps.Equal(effectKinds, testCase.Want.EffectKinds) {
				t.Fatalf("assurance: version=%q fixtures=%d effects=%#v",
					version, qualificationFixtures, effectKinds)
			}
			if blocking := validateGeneratedWorkflow(compiled); len(blocking) > 0 {
				t.Fatalf("golden result failed real validator: %+v", blocking)
			}
		})
	}
}
