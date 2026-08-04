// Code-resident solution-pack catalog (reference
// the source contract). The three pack.json files are the CANONICAL
// files embedded verbatim — a pack is never a database row; only the
// workflow version produced by installing one is persisted. Every pack is
// validated at init (parseable JSON, unique ids, workflowJson accepted by
// the domain parser); a malformed pack panics at boot, never at request
// time.
package packs

import (
	"embed"
	"encoding/json"
	"fmt"

	"github.com/johnny4young/janusly/internal/domain"
)

//go:embed packs/*/pack.json
var packFiles embed.FS

// RequiredCredential names a Secret Store dependency the operator wires.
type RequiredCredential struct {
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Purpose string `json:"purpose"`
}

// RequiredOrgConfig names an org-config dependency.
type RequiredOrgConfig struct {
	Key     string `json:"key"`
	Purpose string `json:"purpose"`
}

// SamplePayload is a bundled trigger payload for the one-click sample run.
type SamplePayload struct {
	ID    string         `json:"id"`
	Label string         `json:"label"`
	Input map[string]any `json:"input"`
}

// FailureFixture describes one curated failure scenario bundled with the
// pack (the recovery walkthrough's raw material). Public projection =
// id/label/description/failureMode/recoveryPath, the contract's
// FailureFixturePublic; failedNodeId stays internal.
type FailureFixture struct {
	ID           string `json:"id"`
	Label        string `json:"label"`
	Description  string `json:"description"`
	FailureMode  string `json:"failureMode"`
	RecoveryPath string `json:"recoveryPath"`
	FailedNodeID string `json:"failedNodeId"`
}

// SolutionPack is one validated catalog entry.
type SolutionPack struct {
	ID                  string               `json:"id"`
	Name                string               `json:"name"`
	Description         string               `json:"description"`
	Category            string               `json:"category"`
	Version             string               `json:"version"`
	RequiredCredentials []RequiredCredential `json:"requiredCredentials"`
	RequiredOrgConfigs  []RequiredOrgConfig  `json:"requiredOrgConfigs"`
	WorkflowJSON        json.RawMessage      `json:"workflowJson"`
	SamplePayloads      []SamplePayload      `json:"samplePayloads"`
	FailureFixtures     []FailureFixture     `json:"failureFixtures"`

	// NodeCount is computed at init from the parsed workflow (the public
	// catalog projection needs it without re-parsing per request).
	NodeCount int `json:"-"`
}

var (
	catalog []SolutionPack
	byID    = map[string]int{}
)

func init() {
	entries, err := packFiles.ReadDir("packs")
	if err != nil {
		panic(fmt.Sprintf("solution-packs: %v", err))
	}
	for _, entry := range entries {
		raw, err := packFiles.ReadFile("packs/" + entry.Name() + "/pack.json")
		if err != nil {
			panic(fmt.Sprintf("solution-packs: %s: %v", entry.Name(), err))
		}
		var pack SolutionPack
		if err := json.Unmarshal(raw, &pack); err != nil {
			panic(fmt.Sprintf("solution-packs: %s: %v", entry.Name(), err))
		}
		if pack.ID == "" || len(pack.SamplePayloads) == 0 {
			panic(fmt.Sprintf("solution-packs: %s: missing id or samplePayloads", entry.Name()))
		}
		wf, _ := domain.Parse(pack.WorkflowJSON)
		if wf == nil {
			panic(fmt.Sprintf("solution-packs: %s: workflowJson failed the domain parser", entry.Name()))
		}
		pack.NodeCount = len(wf.Nodes)
		if _, duplicate := byID[pack.ID]; duplicate {
			panic(fmt.Sprintf("solution-packs: duplicate id %s", pack.ID))
		}
		byID[pack.ID] = len(catalog)
		catalog = append(catalog, pack)
	}
}

// List returns the catalog in display order.
func List() []SolutionPack { return catalog }

// Get fetches one pack by id; nil when no pack matches.
func Get(id string) *SolutionPack {
	index, present := byID[id]
	if !present {
		return nil
	}
	return &catalog[index]
}
