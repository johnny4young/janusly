package authoring

import (
	"encoding/json"
	"os"
	"testing"
)

func TestChronologicalReplayCorpusIsFrozenAndSourceValidated(t *testing.T) {
	raw, err := os.ReadFile("testdata/experience-replay.json")
	if err != nil {
		t.Fatal(err)
	}
	manifestRaw, err := os.ReadFile("testdata/experience-replay-manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Files map[string]string `json:"files"`
	}
	if err := json.Unmarshal(manifestRaw, &manifest); err != nil {
		t.Fatal(err)
	}
	if corpusHash(raw) != manifest.Files["experience-replay.json"] {
		t.Fatal("frozen replay corpus hash drift")
	}
	report, err := ReplayExperienceCorpus(t.Context(), raw)
	if err != nil || report.Cases != 42 || report.Correct != 42 || len(report.Outcomes) != 42 {
		t.Fatalf("replay: cases=%d correct=%d err=%v", report.Cases, report.Correct, err)
	}
	if report.ArtifactCopies != 10 || report.ReuseInvalidated != 4 || report.Cancellations != 2 || report.Decisions.GenerationRequested != 14 || report.Decisions.CanonicalRecipeRequested != 2 || report.Decisions.ActualLogicalCalls != 0 || report.Decisions.SDKTransportRequests != 0 {
		t.Fatalf("accounting: copies=%d invalidated=%d cancelled=%d counts=%+v", report.ArtifactCopies, report.ReuseInvalidated, report.Cancellations, report.Decisions)
	}
	if report.Languages["en"] != 21 || report.Languages["es"] != 21 {
		t.Fatalf("locale denominators: %v", report.Languages)
	}
	var corpus ExperienceReplayCorpus
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatal(err)
	}
	corpus.Cases[0].Artifacts[0].Candidate.OrganizationID = "other"
	poisoned, _ := json.Marshal(corpus)
	report, err = ReplayExperienceCorpus(t.Context(), poisoned)
	if err != nil || report.Correct != 41 || report.ReuseInvalidated != 5 {
		t.Fatalf("source poison hidden: correct=%d invalidated=%d err=%v", report.Correct, report.ReuseInvalidated, err)
	}
}

func TestReplayCorpusRejectsFramingIdentityAndCatalogDrift(t *testing.T) {
	raw, err := os.ReadFile("testdata/experience-replay.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, input := range [][]byte{append(raw, []byte(`{}`)...), []byte(`null`), []byte(`{"version":"1","cases":[]}`)} {
		if _, err := ReplayExperienceCorpus(t.Context(), input); err == nil {
			t.Fatal("invalid corpus accepted")
		}
	}
	var corpus ExperienceReplayCorpus
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatal(err)
	}
	corpus.Cases[1].ID = corpus.Cases[0].ID
	bad, _ := json.Marshal(corpus)
	if _, err := ReplayExperienceCorpus(t.Context(), bad); err == nil {
		t.Fatal("duplicate case accepted")
	}
	corpus.Cases = corpus.Cases[:1]
	corpus.Catalog.Version = "other"
	bad, _ = json.Marshal(corpus)
	if _, err := ReplayExperienceCorpus(t.Context(), bad); err == nil {
		t.Fatal("stale catalog accepted")
	}
}
