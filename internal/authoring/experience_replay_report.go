package authoring

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
)

// ExperienceReplayCorpus is a locked synthetic history and catalog. A source
// artifact is private fixture data, never a memory record or a provider result.
type ExperienceReplayCorpus struct {
	Version string                 `json:"version"`
	Catalog Catalog                `json:"catalog"`
	Cases   []ExperienceReplayCase `json:"cases"`
}

type ExperienceReplayCase struct {
	ID                     string                      `json:"id"`
	Request                DecisionRequest             `json:"request"`
	History                []ExperienceHistoryEntry    `json:"history"`
	Consent                []ExperienceConsentSnapshot `json:"consent"`
	Artifacts              []ExperienceArtifact        `json:"artifacts"`
	Cancelled              bool                        `json:"cancelled"`
	Expected               DecisionProposal            `json:"expected"`
	ExpectedArtifactStatus string                      `json:"expectedArtifactStatus"`
}

type ExperienceReplayOutcome struct {
	ID                 string            `json:"id"`
	Language           string            `json:"language"`
	Predicted          *DecisionProposal `json:"predicted,omitempty"`
	Expected           DecisionProposal  `json:"expected"`
	ArtifactStatus     string            `json:"artifactStatus"`
	Correct            bool              `json:"correct"`
	SelectedCandidates int               `json:"selectedCandidates"`
	Truncated          bool              `json:"truncated"`
}

type ExperienceReplayReport struct {
	PolicyVersion    string                    `json:"policyVersion"`
	CorpusSHA256     string                    `json:"corpusSha256"`
	Evidence         string                    `json:"evidence"`
	Cases            int                       `json:"cases"`
	Correct          int                       `json:"correct"`
	ArtifactCopies   int                       `json:"artifactCopies"`
	ReuseInvalidated int                       `json:"reuseInvalidated"`
	Cancellations    int                       `json:"cancellations"`
	Decisions        OfflineDecisionCounts     `json:"decisions"`
	Languages        map[string]int            `json:"languages"`
	Outcomes         []ExperienceReplayOutcome `json:"outcomes"`
}

// ReplayExperienceCorpus runs bounded, historical snapshots and copies exact
// fixture graphs through the same binder/validator as registration. It does not
// infer past consent from a live DB, contact providers or save/run a workflow.
func ReplayExperienceCorpus(ctx context.Context, raw []byte) (ExperienceReplayReport, error) {
	report := ExperienceReplayReport{PolicyVersion: AuthoringExperiencePolicyVersion, CorpusSHA256: corpusHash(raw), Evidence: "synthetic_chronology_and_copy_mechanics_only", Decisions: offlineCounts(), Languages: map[string]int{}, Outcomes: []ExperienceReplayOutcome{}}
	if len(raw) > 8*1024*1024 {
		return report, fmt.Errorf("replay corpus exceeds limit")
	}
	var corpus ExperienceReplayCorpus
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&corpus) != nil || decoder.Decode(new(any)) != io.EOF || corpus.Version != "1" || len(corpus.Cases) == 0 || len(corpus.Cases) > 240 {
		return report, fmt.Errorf("invalid replay corpus")
	}
	catalogRaw, err := json.Marshal(corpus.Catalog)
	if err != nil || len(catalogRaw) > 256*1024 || corpus.Catalog.SchemaVersion != CatalogSchemaVersion || !validDecisionID(corpus.Catalog.Version) || len(corpus.Catalog.Credentials) > maxDynamicCatalogEntries || len(corpus.Catalog.Subworkflows) > maxDynamicCatalogEntries {
		return report, fmt.Errorf("invalid replay catalog")
	}
	seen := map[string]bool{}
	for _, c := range corpus.Cases {
		if err := ctx.Err(); err != nil {
			return report, err
		}
		if !validDecisionID(c.ID) || seen[c.ID] || len(c.Artifacts) > MaxExperienceCandidates || c.Request.CatalogVersion != corpus.Catalog.Version {
			return report, fmt.Errorf("invalid replay case")
		}
		seen[c.ID] = true
		for _, artifact := range c.Artifacts {
			if len(artifact.Document) > maxExperienceSourceBytes {
				return report, fmt.Errorf("replay artifact exceeds limit")
			}
		}
		switch c.ExpectedArtifactStatus {
		case "copied", "invalidated", "not_requested", "cancelled":
		default:
			return report, fmt.Errorf("invalid replay artifact expectation")
		}
		caseCtx, cancel := context.WithCancel(ctx)
		if c.Cancelled {
			cancel()
		}
		projected, err := ProjectExperienceReplay(caseCtx, c.Request, c.History, c.Consent)
		cancel()
		outcome := ExperienceReplayOutcome{ID: c.ID, Language: c.Request.Brief.Language, Expected: c.Expected, ArtifactStatus: "not_requested"}
		if c.Cancelled && errors.Is(err, context.Canceled) {
			outcome.ArtifactStatus = "cancelled"
			outcome.Correct = reflect.DeepEqual(c.Expected, DecisionProposal{}) && c.ExpectedArtifactStatus == "cancelled"
			report.Cancellations++
		} else {
			if err != nil {
				return report, fmt.Errorf("replay case %s projection rejected", c.ID)
			}
			predicted, err := (RulesProvider{}).Propose(ctx, projected)
			if err != nil {
				return report, fmt.Errorf("replay case %s rules rejected", c.ID)
			}
			receipt, err := ProposeDecision(ctx, RulesProvider{}, projected)
			if err != nil {
				return report, fmt.Errorf("replay case %s policy rejected", c.ID)
			}
			outcome.Predicted = &predicted
			outcome.SelectedCandidates = len(projected.Candidates)
			outcome.Truncated = projected.Truncated
			report.Decisions.record(predicted.Mode, predicted.Reason)
			if receipt.Source != nil {
				outcome.ArtifactStatus = "invalidated"
				var selected *ExperienceArtifact
				for i := range c.Artifacts {
					if c.Artifacts[i].Candidate.ID == receipt.Source.CandidateID {
						if selected != nil {
							return report, fmt.Errorf("replay case %s duplicate source", c.ID)
						}
						selected = &c.Artifacts[i]
					}
				}
				if selected != nil {
					_, err := CopyExperienceProposal(ctx, projected, receipt, *selected, "replay-draft-"+corpusHash([]byte(c.ID))[:32], corpus.Catalog)
					if ctx.Err() != nil {
						return report, ctx.Err()
					}
					if err == nil {
						outcome.ArtifactStatus = "copied"
					}
				}
				if outcome.ArtifactStatus == "copied" {
					report.ArtifactCopies++
				} else {
					report.ReuseInvalidated++
				}
			}
			outcome.Correct = reflect.DeepEqual(predicted, c.Expected) && outcome.ArtifactStatus == c.ExpectedArtifactStatus
		}
		report.Cases++
		report.Languages[c.Request.Brief.Language]++
		if outcome.Correct {
			report.Correct++
		}
		report.Outcomes = append(report.Outcomes, outcome)
	}
	if err := ctx.Err(); err != nil {
		return report, err
	}
	return report, nil
}
