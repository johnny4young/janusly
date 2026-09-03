package httpapi

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestExperimentFinalizeContextSurvivesRequestCancellation(t *testing.T) {
	requestCtx, cancelRequest := context.WithCancel(context.Background())
	cancelRequest()

	finalizeCtx, cancelFinalize := experimentFinalizeContext(requestCtx)
	defer cancelFinalize()
	if err := finalizeCtx.Err(); err != nil {
		t.Fatalf("finalization inherited request cancellation: %v", err)
	}
	deadline, ok := finalizeCtx.Deadline()
	if !ok || time.Until(deadline) <= 0 || time.Until(deadline) > experimentFinalizeTimeout {
		t.Fatalf("finalization context is not positively bounded: deadline=%v ok=%t", deadline, ok)
	}
}

func TestNormalizeExperimentModelRef(t *testing.T) {
	for input, want := range map[string]string{
		" claude-sonnet-5 ":                   "claude-sonnet-5",
		"anthropic/claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
	} {
		if got, ok := normalizeExperimentModelRef(input); !ok || got != want {
			t.Fatalf("normalize %q: got=%q ok=%t", input, got, ok)
		}
	}
	for _, input := range []string{
		"", "openai/gpt-5", "anthropic/CLAUDE-SONNET-5",
		"anthropic/claude/sonnet", "claude sonnet",
	} {
		if got, ok := normalizeExperimentModelRef(input); ok {
			t.Fatalf("invalid model ref %q normalized to %q", input, got)
		}
	}
}

func TestEvalExportFilenameTreatsDatasetNameAsData(t *testing.T) {
	got := evalExportFilename("  Weekly \"gold\"\r\nX-Evil: yes/../../日本語  ", 12, "jsonl")
	if got != "evals-weekly-gold-x-evil-yes-examples-12.jsonl" {
		t.Fatalf("safe export filename = %q", got)
	}
	for _, forbidden := range []string{"\r", "\n", `"`, "/", "..", "日本語"} {
		if strings.Contains(got, forbidden) {
			t.Fatalf("unsafe filename %q contains %q", got, forbidden)
		}
	}
}

func TestEvalExportFilenameIsBoundedAndHasFallback(t *testing.T) {
	if got := evalExportFilename("日本語", 0, "json"); got != "evals-dataset-examples-0.json" {
		t.Fatalf("fallback filename = %q", got)
	}
	got := evalExportFilename(strings.Repeat("Ab_", 100), 1, "json")
	const fixedBytes = len("evals--examples-1.json")
	if len(got) > fixedBytes+48 {
		t.Fatalf("filename exceeded slug bound: %d bytes (%q)", len(got), got)
	}
}
