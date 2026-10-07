package authoring

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
)

// MaxMechanicsCorpusBytes bounds the offline corpus accepted by the checker.
const MaxMechanicsCorpusBytes = 4 * 1024 * 1024

// DecisionMechanicsCase is synthetic offline evidence only. Labels follow a
// published deterministic rubric, not a model judge or a human acceptance test.
type DecisionMechanicsCase struct {
	ID       string           `json:"id"`
	Family   string           `json:"family"`
	Split    string           `json:"split"`
	Scenario string           `json:"scenario"`
	Request  DecisionRequest  `json:"request"`
	Expected DecisionProposal `json:"expected"`
}

type DecisionMechanicsReport struct {
	Cases         int                  `json:"cases"`
	Modes         map[DecisionMode]int `json:"modes"`
	Languages     map[string]int       `json:"languages"`
	PolicyVersion string               `json:"policyVersion"`
	Evidence      string               `json:"evidence"`
}

type mechanicsFixtureProvider struct{ raw []byte }

func (p mechanicsFixtureProvider) Kind() DecisionProviderKind { return DecisionFixtureProvider }

func (p mechanicsFixtureProvider) Propose(ctx context.Context, _ DecisionRequest) (DecisionProposal, error) {
	if err := ctx.Err(); err != nil {
		return DecisionProposal{}, err
	}
	return DecodeDecisionProposal(p.raw)
}

// CheckDecisionMechanicsCorpus validates fixture proposals with independent
// policy. It is intentionally not a generation/retrieval/real-model benchmark.
func CheckDecisionMechanicsCorpus(ctx context.Context, raw []byte) (DecisionMechanicsReport, error) {
	report := DecisionMechanicsReport{Modes: make(map[DecisionMode]int), Languages: make(map[string]int), PolicyVersion: AuthoringExperiencePolicyVersion, Evidence: "synthetic_contract_mechanics_only"}
	if len(raw) > MaxMechanicsCorpusBytes {
		return report, fmt.Errorf("mechanics corpus exceeds limit")
	}
	var cases []DecisionMechanicsCase
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cases); err != nil {
		return report, fmt.Errorf("invalid mechanics corpus")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return report, fmt.Errorf("invalid mechanics corpus")
	}
	if len(cases) != 240 {
		return report, fmt.Errorf("mechanics corpus must contain exactly 240 cases")
	}
	ids := map[string]bool{}
	families := map[string]string{}
	splits := map[string]int{}
	for _, c := range cases {
		if !validDecisionID(c.ID) || ids[c.ID] || c.Family == "" || c.Scenario == "" || (c.Split != "development" && c.Split != "qualification") {
			return report, fmt.Errorf("invalid mechanics case identity")
		}
		// Whole families are held out: a family never spans both splits.
		if previous, seen := families[c.Family]; seen && previous != c.Split {
			return report, fmt.Errorf("mechanics family %s leaks across splits", c.Family)
		}
		families[c.Family] = c.Split
		splits[c.Split]++
		ids[c.ID] = true
		proposalRaw, err := json.Marshal(c.Expected)
		if err != nil {
			return report, fmt.Errorf("invalid mechanics proposal")
		}
		receipt, err := ProposeDecision(ctx, mechanicsFixtureProvider{proposalRaw}, c.Request)
		if err != nil {
			return report, fmt.Errorf("mechanics case %s rejected: %w", c.ID, err)
		}
		report.Cases++
		report.Modes[receipt.Mode]++
		report.Languages[c.Request.Brief.Language]++
	}
	for _, mode := range []DecisionMode{DecisionReuse, DecisionAdapt, DecisionGenerate, DecisionEscalate} {
		if report.Modes[mode] != 60 {
			return report, fmt.Errorf("unbalanced mechanics modes")
		}
	}
	if report.Languages["en"] != 120 || report.Languages["es"] != 120 {
		return report, fmt.Errorf("unbalanced mechanics languages")
	}
	if splits["development"] != 144 || splits["qualification"] != 96 || len(families) != 5 {
		return report, fmt.Errorf("unbalanced mechanics splits")
	}
	return report, nil
}
