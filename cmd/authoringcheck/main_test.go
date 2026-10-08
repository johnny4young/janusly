package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestRunCheckIncludesPredictionsChronologyAndHonestTrafficCounts(t *testing.T) {
	args := []string{"../../internal/authoring/testdata/experience-mechanics.json", "../../internal/authoring/testdata/experience-replay.json"}
	var out bytes.Buffer
	if err := runCheck(t.Context(), args, &out); err != nil {
		t.Fatal(err)
	}
	var report checkReport
	if err := json.Unmarshal(out.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if report.Mechanics.Cases != 240 || report.Rules.Correct != 240 || report.Replay == nil || report.Replay.Correct != 42 || report.Replay.Decisions.ActualLogicalCalls != 0 {
		t.Fatalf("incomplete report: mechanics=%d rules=%d replay=%v", report.Mechanics.Cases, report.Rules.Correct, report.Replay != nil)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	out.Reset()
	if err := runCheck(ctx, args, &out); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled check: %v", err)
	}
	if out.Len() != 0 {
		t.Fatal("cancelled check emitted success")
	}
}

func TestRunCheckRejectsMissingOrOversizedInput(t *testing.T) {
	var out bytes.Buffer
	for _, args := range [][]string{nil, {"missing"}, {"one", "two", "three"}} {
		if err := runCheck(t.Context(), args, &out); err == nil {
			t.Fatal("invalid arguments accepted")
		}
	}
	path := filepath.Join(t.TempDir(), "bounded.json")
	if err := os.WriteFile(path, []byte("12345"), 0o600); err != nil {
		t.Fatal(err)
	}
	if raw, err := readCorpus(path, 5); err != nil || string(raw) != "12345" {
		t.Fatalf("exact limit: %s %v", raw, err)
	}
	if _, err := readCorpus(path, 4); err == nil {
		t.Fatal("oversized input accepted")
	}
}
