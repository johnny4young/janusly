package authoring

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"reflect"
	"time"

	"github.com/johnny4young/janusly/internal/domain"
)

// OfflineDecisionCounts separates requested generation from real traffic.
// The offline runner has no provider admission or completion client.
type OfflineDecisionCounts struct {
	Modes                map[DecisionMode]int `json:"modes"`
	GenerationRequested  int                  `json:"generationRequested"`
	ActualLogicalCalls   int                  `json:"actualLogicalCalls"`
	SDKTransportRequests int                  `json:"sdkTransportRequests"`
}

type OfflineTemplateCounts struct {
	Templates            map[string]int `json:"templates"`
	CanonicalRecipes     int            `json:"canonicalRecipes"`
	CompleteBindings     int            `json:"completeBindings"`
	GenerationRequested  int            `json:"generationRequested"`
	ActualLogicalCalls   int            `json:"actualLogicalCalls"`
	SDKTransportRequests int            `json:"sdkTransportRequests"`
}

type RulesMechanicsOutcome struct {
	ID                    string           `json:"id"`
	Family                string           `json:"family"`
	Split                 string           `json:"split"`
	Language              string           `json:"language"`
	Expected              DecisionProposal `json:"expected"`
	Predicted             DecisionProposal `json:"predicted"`
	Correct               bool             `json:"correct"`
	WithoutExperienceMode DecisionMode     `json:"withoutExperienceMode"`
	LegacyTemplateID      string           `json:"legacyTemplateId"`
	LegacyBindingComplete bool             `json:"legacyBindingComplete"`
}

type RulesMechanicsReport struct {
	PolicyVersion                      string                                `json:"policyVersion"`
	CorpusSHA256                       string                                `json:"corpusSha256"`
	Evidence                           string                                `json:"evidence"`
	Cases                              int                                   `json:"cases"`
	Correct                            int                                   `json:"correct"`
	Selected                           int                                   `json:"selected"`
	SelectedCorrect                    int                                   `json:"selectedCorrect"`
	Languages                          map[string]int                        `json:"languages"`
	Splits                             map[string]int                        `json:"splits"`
	Confusion                          map[DecisionMode]map[DecisionMode]int `json:"confusion"`
	LegacyTemplates                    OfflineTemplateCounts                 `json:"legacyTemplates"`
	ExactRulesWithoutExperience        OfflineDecisionCounts                 `json:"exactRulesWithoutExperience"`
	ExperienceRules                    OfflineDecisionCounts                 `json:"experienceRules"`
	GenerationRequestsAvoided          int                                   `json:"generationRequestsAvoided"`
	GenerationRequestDelta             int                                   `json:"generationRequestDelta"`
	GenerationRequestsDeferredToReview int                                   `json:"generationRequestsDeferredToReview"`
	CallsAvoidedEvidence               string                                `json:"callsAvoidedEvidence"`
	Outcomes                           []RulesMechanicsOutcome               `json:"outcomes"`
}

func offlineCounts() OfflineDecisionCounts {
	return OfflineDecisionCounts{Modes: map[DecisionMode]int{}}
}
func (c *OfflineDecisionCounts) record(mode DecisionMode) {
	c.Modes[mode]++
	if mode == DecisionGenerate {
		c.GenerationRequested++
	}
}
func corpusHash(raw []byte) string { sum := sha256.Sum256(raw); return hex.EncodeToString(sum[:]) }

// CheckRulesMechanicsCorpus predicts without exposing labels to RulesProvider.
// The same frozen cases compare actual legacy recipe/template binding and a
// no-experience policy ablation. These controls are not real-model baselines or
// a claim that a template fulfils a human objective. No graph is executed.
func CheckRulesMechanicsCorpus(ctx context.Context, raw []byte) (RulesMechanicsReport, error) {
	report := RulesMechanicsReport{PolicyVersion: AuthoringExperiencePolicyVersion, CorpusSHA256: corpusHash(raw), Evidence: "synthetic_rules_mechanics_only", Languages: map[string]int{}, Splits: map[string]int{}, Confusion: map[DecisionMode]map[DecisionMode]int{}, LegacyTemplates: OfflineTemplateCounts{Templates: map[string]int{}}, ExactRulesWithoutExperience: offlineCounts(), ExperienceRules: offlineCounts(), CallsAvoidedEvidence: "generation_requests_only_no_model_calls_measured", Outcomes: []RulesMechanicsOutcome{}}
	if _, err := CheckDecisionMechanicsCorpus(ctx, raw); err != nil {
		return report, err
	}
	var cases []DecisionMechanicsCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		return report, fmt.Errorf("invalid mechanics corpus")
	}
	catalog := NewBuilder(nil, nil).Build(ctx, "offline")
	for _, c := range cases {
		if err := ctx.Err(); err != nil {
			return report, err
		}
		predicted, err := (RulesProvider{}).Propose(ctx, c.Request)
		if err != nil {
			return report, fmt.Errorf("rules case %s rejected", c.ID)
		}
		receipt, err := ProposeDecision(ctx, RulesProvider{}, c.Request)
		if err != nil {
			return report, fmt.Errorf("rules case %s policy rejected", c.ID)
		}
		without := cloneDecisionRequest(c.Request)
		without.Candidates = nil
		without.Truncated = false
		control, err := ProposeDecision(ctx, RulesProvider{}, without)
		if err != nil {
			return report, fmt.Errorf("rules case %s control rejected", c.ID)
		}
		prompt := ProposalPrompt(c.Request.Brief)
		options := DeterministicWorkflowOptions{NewID: func() string { return "offline-recipe" }, Now: func() time.Time { return c.Request.AsOf }, Catalog: &catalog, Brief: &c.Request.Brief}
		_, recognized, _ := CompilePagerDutyWorkflow(prompt, options)
		template := DeterministicWorkflowWithOptions(prompt, options)
		templateRaw, err := json.Marshal(template)
		if err != nil {
			return report, fmt.Errorf("template case %s rejected", c.ID)
		}
		workflow, issues := domain.Parse(templateRaw)
		bound := workflow != nil && len(issues) == 0 && BindProposal(catalog, c.Request.Brief, workflow).Complete
		templateID, _ := template["id"].(string)
		report.LegacyTemplates.Templates[templateID]++
		if recognized {
			report.LegacyTemplates.CanonicalRecipes++
		} else if c.Request.Complete {
			report.LegacyTemplates.GenerationRequested++
		}
		if bound {
			report.LegacyTemplates.CompleteBindings++
		}
		correct := reflect.DeepEqual(predicted, c.Expected)
		report.Cases++
		report.Languages[c.Request.Brief.Language]++
		report.Splits[c.Split]++
		if correct {
			report.Correct++
		}
		if receipt.Source != nil {
			report.Selected++
			if correct {
				report.SelectedCorrect++
			}
		}
		if report.Confusion[c.Expected.Mode] == nil {
			report.Confusion[c.Expected.Mode] = map[DecisionMode]int{}
		}
		report.Confusion[c.Expected.Mode][predicted.Mode]++
		if control.Mode == DecisionGenerate {
			if predicted.Mode == DecisionReuse || predicted.Mode == DecisionAdapt {
				report.GenerationRequestsAvoided++
			}
			if predicted.Mode == DecisionEscalate {
				report.GenerationRequestsDeferredToReview++
			}
		}
		report.ExperienceRules.record(predicted.Mode)
		report.ExactRulesWithoutExperience.record(control.Mode)
		report.Outcomes = append(report.Outcomes, RulesMechanicsOutcome{ID: c.ID, Family: c.Family, Split: c.Split, Language: c.Request.Brief.Language, Expected: c.Expected, Predicted: predicted, Correct: correct, WithoutExperienceMode: control.Mode, LegacyTemplateID: templateID, LegacyBindingComplete: bound})
	}
	report.GenerationRequestDelta = report.ExactRulesWithoutExperience.GenerationRequested - report.ExperienceRules.GenerationRequested
	return report, nil
}
