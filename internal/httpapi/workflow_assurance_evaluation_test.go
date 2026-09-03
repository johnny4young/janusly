package httpapi

import (
	_ "embed"
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/johnny4young/janusly/internal/aidiagnosis"
	"github.com/johnny4young/janusly/internal/authoring"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/mcpclient"
)

//go:embed testdata/workflow-assurance-evaluation.json
var workflowAssuranceEvaluationJSON []byte

type workflowAssuranceEvaluation struct {
	SchemaVersion string                    `json:"schemaVersion"`
	Authoring     []evaluationAuthoringCase `json:"authoring"`
	Diagnosis     []evaluationDiagnosisCase `json:"diagnosis"`
}

type evaluationAuthoringCase struct {
	ID       string `json:"id"`
	Language string `json:"language"`
	Prompt   string `json:"prompt"`
	Expected struct {
		Trigger             string    `json:"trigger"`
		FallbackTemplateID  string    `json:"fallbackTemplateId"`
		RequiredNodeTypes   []string  `json:"requiredNodeTypes"`
		BindingComplete     bool      `json:"bindingComplete"`
		MissingReasons      []string  `json:"missingReasons"`
		RealRequiredTypes   *[]string `json:"realRequiredNodeTypes"`
		RealBindingComplete *bool     `json:"realBindingComplete"`
	} `json:"expected"`
}

type evaluationDiagnosisCase struct {
	ID                        string                   `json:"id"`
	Language                  string                   `json:"language"`
	Message                   string                   `json:"message"`
	Details                   []string                 `json:"details"`
	DetectorKind              string                   `json:"detectorKind"`
	Action                    string                   `json:"action"`
	WorkflowSnapshotAvailable bool                     `json:"workflowSnapshotAvailable"`
	RecoveryContractAvailable bool                     `json:"recoveryContractAvailable"`
	AutonomyLevel             *int                     `json:"autonomyLevel"`
	HasWorkflow               bool                     `json:"hasWorkflow"`
	SimilarCases              aidiagnosis.SimilarCases `json:"similarCases"`
	ExpectedCandidateKinds    []string                 `json:"expectedCandidateKinds"`
}

func loadWorkflowAssuranceEvaluation(t *testing.T) workflowAssuranceEvaluation {
	t.Helper()
	var dataset workflowAssuranceEvaluation
	if err := json.Unmarshal(workflowAssuranceEvaluationJSON, &dataset); err != nil {
		t.Fatalf("decode workflow assurance evaluation: %v", err)
	}
	if dataset.SchemaVersion != "1" || len(dataset.Authoring) != 10 || len(dataset.Diagnosis) != 10 {
		t.Fatalf("evaluation identity: version=%q authoring=%d diagnosis=%d",
			dataset.SchemaVersion, len(dataset.Authoring), len(dataset.Diagnosis))
	}
	seen := map[string]bool{}
	languageCounts := map[string]int{}
	for _, identity := range append(evaluationIdentities(dataset.Authoring), diagnosisEvaluationIdentities(dataset.Diagnosis)...) {
		if identity.id == "" || seen[identity.id] || (identity.language != "en" && identity.language != "es") {
			t.Fatalf("invalid or duplicate evaluation identity: %+v", identity)
		}
		seen[identity.id] = true
		languageCounts[identity.language]++
	}
	if languageCounts["en"] != 10 || languageCounts["es"] != 10 {
		t.Fatalf("evaluation must be balanced EN/ES: %+v", languageCounts)
	}
	return dataset
}

type evaluationIdentity struct{ id, language string }

func evaluationIdentities(cases []evaluationAuthoringCase) []evaluationIdentity {
	out := make([]evaluationIdentity, 0, len(cases))
	for _, testCase := range cases {
		out = append(out, evaluationIdentity{id: testCase.ID, language: testCase.Language})
	}
	return out
}

func diagnosisEvaluationIdentities(cases []evaluationDiagnosisCase) []evaluationIdentity {
	out := make([]evaluationIdentity, 0, len(cases))
	for _, testCase := range cases {
		out = append(out, evaluationIdentity{id: testCase.ID, language: testCase.Language})
	}
	return out
}

// evaluationCapabilityCatalog is deterministic, secret-free and deliberately
// includes only safe names. It is shared by the $0 corpus and the explicitly
// tagged real-provider qualification so both evaluate the same binding graph.
func evaluationCapabilityCatalog(t *testing.T) authoring.Catalog {
	t.Helper()
	catalog := authoring.NewBuilder(nil, nil).Build(t.Context(), "evaluation-org")
	catalog.Version = "workflow-assurance-evaluation-v1"
	catalog.Credentials = []authoring.CredentialCapability{
		{ID: "cred-bot-github", Name: "bot-github", Kind: "github_token", Configured: true, UpdatedAt: time.Unix(0, 0).UTC()},
		{ID: "cred-incidents-slack", Name: "incidents-slack", Kind: "slack_webhook", Configured: true, UpdatedAt: time.Unix(0, 0).UTC()},
	}
	catalog.McpTools = []mcpclient.ExposedMcpTool{{
		ConnectionAlias: "crm-evaluation", ToolName: "contacts.lookup",
		Description: "Read one contact by exact id.", WriteSide: false,
		InputFields: []mcpclient.ExposedMcpInputField{{Name: "contactId", Type: "string", Required: true}},
	}}
	catalog.Subworkflows = []authoring.SubworkflowCapability{{
		WorkflowID: "wf-child-evaluation", Name: "Evaluation child", Status: "active", LatestVersion: 1,
	}}
	return catalog
}

func TestWorkflowAssuranceEvaluationProviderFree(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	dataset := loadWorkflowAssuranceEvaluation(t)
	catalog := evaluationCapabilityCatalog(t)

	for _, testCase := range dataset.Authoring {
		t.Run(testCase.ID, func(t *testing.T) {
			compiledBrief, err := authoring.CompileBrief(authoring.CompileBriefRequest{Prompt: testCase.Prompt})
			if err != nil {
				t.Fatalf("compile brief: %v", err)
			}
			if compiledBrief.Mode != "deterministic" || compiledBrief.Brief.Language != testCase.Language ||
				compiledBrief.Brief.Trigger != testCase.Expected.Trigger || len(compiledBrief.ClarifyingQuestions) > 3 {
				t.Fatalf("brief envelope: %+v", compiledBrief)
			}
			document := authoring.DeterministicWorkflow(authoring.ProposalPrompt(compiledBrief.Brief))
			if document["id"] != testCase.Expected.FallbackTemplateID {
				t.Fatalf("fallback template=%v want %s", document["id"], testCase.Expected.FallbackTemplateID)
			}
			raw, err := json.Marshal(document)
			if err != nil {
				t.Fatal(err)
			}
			compiledWorkflow, _, err := compileWorkflowAssurance(testCase.Prompt, raw)
			if err != nil {
				t.Fatalf("compile assurance: %v", err)
			}
			workflow, parseIssues := domain.Parse(compiledWorkflow)
			if workflow == nil || len(parseIssues) > 0 {
				t.Fatalf("parse compiled fallback: %+v", parseIssues)
			}
			if blocking := validateGeneratedWorkflow(compiledWorkflow); len(blocking) > 0 {
				t.Fatalf("fallback validation: %+v", blocking)
			}
			if len(workflow.Outputs) == 0 {
				t.Fatal("provider-free proposal omitted its Intent Contract")
			}
			assertRequiredNodeTypes(t, workflow, testCase.Expected.RequiredNodeTypes)
			bindings := authoring.BindProposal(catalog, compiledBrief.Brief, workflow)
			if bindings.Complete != testCase.Expected.BindingComplete {
				t.Fatalf("binding complete=%v want %v: %+v", bindings.Complete, testCase.Expected.BindingComplete, bindings)
			}
			for _, reason := range testCase.Expected.MissingReasons {
				if !bindingReasonPresent(bindings, reason) {
					t.Fatalf("missing expected reason %q: %+v", reason, bindings.Missing)
				}
			}
			for _, missing := range bindings.Missing {
				if missing.Reason == "exact_tool_not_found" || missing.Reason == "exact_mcp_tool_not_found" || missing.Reason == "exact_subworkflow_not_eligible" {
					t.Fatalf("provider-free graph invented a capability: %+v", missing)
				}
			}
		})
	}

	for _, testCase := range dataset.Diagnosis {
		t.Run(testCase.ID, func(t *testing.T) {
			facts := diagnosisFactsFromEvaluation(testCase)
			diagnosis := engine.BuildRecoveryDiagnosis(facts, nil)
			if diagnosis.Mode != "deterministic_fallback" || len(diagnosis.Hypotheses) != 1 ||
				!slices.Equal(diagnosis.RecommendedCandidateKinds, testCase.ExpectedCandidateKinds) {
				t.Fatalf("provider-free diagnosis envelope: %+v", diagnosis)
			}
			assertBoundedDiagnosis(t, diagnosis)
			raw, err := json.Marshal(diagnosis)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(raw), "sk-aaaaaaaaaaaaaaaaaaaaaaaa") || strings.Contains(string(raw), "detail six must be omitted") {
				t.Fatalf("diagnosis leaked scrubbed or over-limit evidence: %s", raw)
			}
			if testCase.Language == "es" && !strings.Contains(diagnosis.Hypotheses[0].Cause, "salida del nodo") {
				t.Fatalf("Spanish deterministic diagnosis was not localized: %+v", diagnosis.Hypotheses[0])
			}
		})
	}
}

func diagnosisFactsFromEvaluation(testCase evaluationDiagnosisCase) engine.RecoveryDiagnosisFacts {
	return engine.RecoveryDiagnosisFacts{
		Language: testCase.Language, Message: testCase.Message, Details: testCase.Details,
		RunID: "run-" + testCase.ID, SourceNodeID: "source", DetectorID: "detector-" + testCase.ID,
		DetectorKind: testCase.DetectorKind, Action: testCase.Action, HasWorkflow: testCase.HasWorkflow,
		WorkflowSnapshotAvailable: testCase.WorkflowSnapshotAvailable,
		RecoveryContractAvailable: testCase.RecoveryContractAvailable,
		AutonomyLevel:             testCase.AutonomyLevel, SimilarCases: testCase.SimilarCases,
	}
}

func assertRequiredNodeTypes(t *testing.T, workflow *domain.Workflow, required []string) {
	t.Helper()
	types := map[string]bool{}
	for _, node := range workflow.Nodes {
		types[node.Type] = true
	}
	for _, nodeType := range required {
		if !types[nodeType] {
			t.Fatalf("required node type %q absent: %+v", nodeType, workflow.Nodes)
		}
	}
}

func bindingReasonPresent(report authoring.BindingReport, reason string) bool {
	for _, binding := range report.Missing {
		if binding.Reason == reason {
			return true
		}
	}
	return false
}

func assertBoundedDiagnosis(t *testing.T, diagnosis engine.RecoveryDiagnosisPayload) {
	t.Helper()
	if strings.TrimSpace(diagnosis.Summary) == "" || utf8.RuneCountInString(diagnosis.Summary) > aidiagnosis.MaxSummaryRunes ||
		len(diagnosis.Hypotheses) < 1 || len(diagnosis.Hypotheses) > aidiagnosis.MaxHypotheses {
		t.Fatalf("unbounded diagnosis summary/hypotheses: %+v", diagnosis)
	}
	for _, hypothesis := range diagnosis.Hypotheses {
		if strings.TrimSpace(hypothesis.Cause) == "" || utf8.RuneCountInString(hypothesis.Cause) > aidiagnosis.MaxCauseRunes ||
			hypothesis.Confidence < 0 || hypothesis.Confidence > 1 || len(hypothesis.Evidence) < 1 ||
			len(hypothesis.Evidence) > aidiagnosis.MaxStatements || len(hypothesis.CounterEvidence) > aidiagnosis.MaxStatements ||
			len(hypothesis.EvidenceRefs) != 3 {
			t.Fatalf("unbounded diagnosis hypothesis: %+v", hypothesis)
		}
	}
}
