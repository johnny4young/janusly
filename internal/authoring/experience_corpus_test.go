package authoring

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

func TestExperienceMechanicsCorpusIsFrozenAndBalanced(t *testing.T) {
	raw, err := os.ReadFile("testdata/experience-mechanics.json")
	if err != nil {
		t.Fatal(err)
	}
	manifestRaw, err := os.ReadFile("testdata/experience-mechanics-manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Files map[string]string `json:"files"`
	}
	if err := json.Unmarshal(manifestRaw, &manifest); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(raw)
	if hex.EncodeToString(sum[:]) != manifest.Files["experience-mechanics.json"] {
		t.Fatal("frozen corpus hash drift")
	}
	report, err := CheckDecisionMechanicsCorpus(t.Context(), raw)
	if err != nil || report.Cases != 240 {
		t.Fatalf("corpus rejected: %+v %v", report, err)
	}
	var cases []DecisionMechanicsCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	splits := map[string]int{}
	families := map[string]string{}
	counts := map[DecisionMode]map[string]int{}
	for _, c := range cases {
		splits[c.Split]++
		if previous := families[c.Family]; previous != "" && previous != c.Split {
			t.Fatalf("family leakage: %s", c.Family)
		}
		families[c.Family] = c.Split
		if counts[c.Expected.Mode] == nil {
			counts[c.Expected.Mode] = map[string]int{}
		}
		counts[c.Expected.Mode][c.Request.Brief.Language]++
	}
	if splits["development"] != 144 || splits["qualification"] != 96 || len(families) != 5 {
		t.Fatalf("split drift: %+v %+v", splits, families)
	}
	for mode, languages := range counts {
		if languages["en"] != 30 || languages["es"] != 30 {
			t.Fatalf("mode imbalance: %s %+v", mode, languages)
		}
	}
	// Deliberately poison one expected reference: the fixture labels are not
	// trusted authority even inside the offline checker.
	cases[0].Expected.VersionID = "invented"
	poisoned, _ := json.Marshal(cases)
	if _, err := CheckDecisionMechanicsCorpus(t.Context(), poisoned); err == nil {
		t.Fatal("poisoned label accepted")
	}
}
